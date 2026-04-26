import { Router, Request, Response } from "express";
import OpenAI from "openai";
import { createEmbedding } from "../utils/embeddings";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { ChatModel } from "../models/Chat";
import { index } from "../config/pinecone";

const router = Router();

const openai = new OpenAI({
	apiKey: process.env.OPENAI_API_KEY,
});

// FIND RELEVANT DOCS

const findRelevantDocs = async (queryEmbedding: number[]) => {
	const result = await index.query({
		vector: queryEmbedding,
		topK: 3,
		includeMetadata: true,
	});

	return (result.matches || [])
		.filter((m) => m.score && m.score > 0.75)
		.map((match) => ({
			text: String(match.metadata?.text || ""),
			type: String(match.metadata?.type || "general"),
		}));
};

// BUILD CONTEXT

const buildContext = (relevantDocs: { text: string; type: string }[]) => {
	const grouped = relevantDocs.reduce(
		(acc, doc) => {
			if (!acc[doc.type]) acc[doc.type] = [];
			acc[doc.type].push(doc.text);
			return acc;
		},
		{} as Record<string, string[]>,
	);

	return Object.entries(grouped)
		.map(([type, texts]) => {
			return `### ${type.toUpperCase()}\n${texts.join("\n")}`;
		})
		.join("\n\n");
};

// CHAT (STREAM)

router.post("/", async (req: Request, res: Response) => {
	try {
		const { message, chatId } = req.body as {
			message: string;
			chatId: string;
		};

		const userId = req.headers["x-user-id"] as string;

		if (!userId) {
			return res.status(400).json({ error: "Missing userId" });
		}

		if (!message || !chatId) {
			return res.status(400).json({ error: "Missing message or chatId" });
		}

		if (typeof message !== "string") {
			return res.status(400).json({ error: "Message must be a string" });
		}

		// PROVERI CHAT + OWNERSHIP
		const chat = await ChatModel.findOne({ _id: chatId, userId });

		if (!chat) {
			return res.status(404).json({ error: "Chat not found" });
		}

		// Save USER message
		await ChatModel.findOneAndUpdate(
			{ _id: chatId, userId },
			{
				$push: {
					messages: {
						role: "user",
						content: message,
					},
				},
			},
		);

		// GENERATE TITLE
		if (!chat.title || chat.title === "New Chat") {
			try {
				const completion = await openai.chat.completions.create({
					model: "gpt-4o-mini",
					messages: [
						{
							role: "system",
							content:
								"Generate a short chat title (max 5 words).",
						},
						{
							role: "user",
							content: message,
						},
					],
				});

				const title =
					completion.choices[0].message.content?.trim() ||
					message.slice(0, 30);

				await ChatModel.findOneAndUpdate(
					{ _id: chatId, userId },
					{ title },
				);
			} catch {
				console.log("Title generation failed");
			}
		}

		const history: ChatCompletionMessageParam[] = chat.messages
			.slice(-4)
			.map((m) => ({
				role: m.role as "user" | "assistant",
				content: m.content,
			}));

		// RAG
		const queryEmbedding = await createEmbedding(message);
		const relevantDocs = await findRelevantDocs(queryEmbedding);
		const context = relevantDocs.length
			? buildContext(relevantDocs)
			: "General information about Veljko is available.";

		const stream = await openai.chat.completions.create({
			model: "gpt-4o-mini",
			stream: true,
			temperature: 0.3,
			messages: [
				{
					role: "system",
					content: `
You are an AI assistant that presents information about Veljko Naumovic.

GOAL:
- Help users learn about Veljko in a clear and professional way.

STYLE:
- Speak naturally, like a helpful assistant
- Always refer to Veljko in third person (never "I")
- Keep answers concise (3–6 bullet points max)
- Prioritize practical and real-world experience
- Highlight technologies and impact when relevant
- Use bullet points when listing
- Use **bold** for important terms

RULES:
- Prefer using the provided context
- If the exact answer is missing, provide the closest relevant information
- NEVER say "I cannot engage" or similar refusals
- NEVER mention "context" or "provided data"
- Do NOT invent facts
- Always write complete and clear sentences
- Avoid incomplete bullet points or fragments
- Always respond in the same language as the user
- You can communicate in multiple languages, including Serbian and English
- Do NOT say you cannot speak a language
- If the user switches language, follow that language automatically

BEHAVIOR:
- If user asks something outside scope → gently redirect to Veljko
- If partial info exists → still answer usefully

Context:
${context}
`,
				},
				...history,
				{
					role: "user",
					content: message,
				},
			],
		});

		res.setHeader("Content-Type", "text/plain; charset=utf-8");
		res.setHeader("Transfer-Encoding", "chunked");

		let fullText = "";

		for await (const chunk of stream) {
			const text = chunk.choices[0]?.delta?.content;
			if (!text) continue;

			fullText += text;
			res.write(text);
		}

		// Save AI response
		await ChatModel.findOneAndUpdate(
			{ _id: chatId, userId },
			{
				$push: {
					messages: {
						role: "assistant",
						content: fullText,
					},
				},
			},
		);

		res.end();
	} catch (error) {
		console.error("Stream error:", error);
		try {
			res.status(500).json({ error: "Internal server error" });
		} catch {}
	}
});

// SUGGESTIONS

router.post("/suggestions", async (req, res) => {
	try {
		const { answer } = req.body;

		// filter bad bad Phrases
		const badPhrases = [
			"cannot engage",
			"outside of the context",
			"not provided in the context",
			"i don't have information",
			"i do not have information",
			"no relevant information",
		];

		const isBadAnswer = badPhrases.some((p) =>
			answer?.toLowerCase().includes(p),
		);

		if (isBadAnswer) {
			return res.json({ suggestions: [] });
		}

		// AI suggestions
		const completion = await openai.chat.completions.create({
			model: "gpt-4o-mini",
			temperature: 0.5,
			messages: [
				{
					role: "system",
					content: `
							Generate 3 relevant follow-up questions about Veljko.

							Rules:
							- Based on useful info from the answer
							- Avoid generic questions
							- max 8 words
							- no numbering
							- plain text

							Good examples:
							- What technologies does Veljko use?
							- Which projects did he build?
							- What is his main focus?

							Bad:
							- irrelevant or vague questions
							`,
				},
				{
					role: "user",
					content: answer,
				},
			],
		});

		const raw = completion.choices[0].message.content || "";

		// parsing
		const suggestions = raw
			.split("\n")
			.map((s) => s.replace(/^\d+\.?\s*/, "").trim())
			.filter((s) => s.length > 5)
			.slice(0, 3);

		res.json({ suggestions });
	} catch (err) {
		console.error("Suggestions error:", err);
		res.status(500).json({ suggestions: [] });
	}
});

// CREATE

router.post("/create", async (req, res) => {
	const userId = req.headers["x-user-id"] as string;

	if (!userId) {
		return res.status(400).json({ error: "Missing userId" });
	}

	const chat = await ChatModel.create({
		userId,
		messages: [
			{
				role: "assistant",
				content: "Hi! I'm Veljko's AI assistant 🚀",
			},
		],
	});

	res.json(chat);
});

// GET

router.get("/", async (req, res) => {
	const userId = req.headers["x-user-id"] as string;

	if (!userId) {
		return res.status(400).json({ error: "Missing userId" });
	}

	const chats = await ChatModel.find({ userId }).sort({
		updatedAt: -1,
	});

	res.json(chats);
});

// RENAME

router.patch("/rename", async (req, res) => {
	const { chatId, title } = req.body;
	const userId = req.headers["x-user-id"] as string;

	if (!userId) {
		return res.status(400).json({ error: "Missing userId" });
	}

	if (!chatId || !title) {
		return res.status(400).json({ error: "Missing chatId or title" });
	}

	const updated = await ChatModel.findOneAndUpdate(
		{ _id: chatId, userId },
		{ title },
		{ returnDocument: "after" },
	);

	res.json(updated);
});

// DELETE

router.delete("/:id", async (req, res) => {
	const userId = req.headers["x-user-id"] as string;

	if (!userId) {
		return res.status(400).json({ error: "Missing userId" });
	}

	await ChatModel.findOneAndDelete({
		_id: req.params.id,
		userId,
	});

	res.json({ success: true });
});

// PIN

router.patch("/pin", async (req, res) => {
	const { chatId, pinned } = req.body;
	const userId = req.headers["x-user-id"] as string;

	if (!userId) {
		return res.status(400).json({ error: "Missing userId" });
	}

	if (!chatId || typeof pinned !== "boolean") {
		return res.status(400).json({ error: "Invalid data" });
	}

	const updated = await ChatModel.findOneAndUpdate(
		{ _id: chatId, userId },
		{ pinned },
		{ returnDocument: "after" },
	);

	res.json(updated);
});

export default router;

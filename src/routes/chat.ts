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
		topK: 5,
		includeMetadata: true,
	});

	return (
		(result.matches || [])
			// .filter((m) => m.score && m.score > 0.5)
			.map((match) => ({
				text: String(match.metadata?.text || ""),
				type: String(match.metadata?.type || "general"),
			}))
	);
};

//  BUILD CONTEXT (reusable)

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
			return `${type.toUpperCase()}:\n${texts.join("\n")}`;
		})
		.join("\n\n");
};

//  CHAT (STREAM)

router.post("/", async (req: Request, res: Response) => {
	try {
		const { message, chatId } = req.body as {
			message: string;
			chatId: string;
		};

		// VALIDATION
		if (!message || !chatId) {
			return res.status(400).json({
				error: "Missing message or chatId",
			});
		}

		if (typeof message !== "string") {
			return res.status(400).json({
				error: "Message must be a string",
			});
		}

		// Save USER message
		await ChatModel.findByIdAndUpdate(chatId, {
			$push: {
				messages: {
					role: "user",
					content: message,
				},
			},
		});

		// GET HISTORY
		const chat = await ChatModel.findById(chatId);

		//  GENERATE TITLE ONLY IF FIRST USER MESSAGE
		if (chat && (!chat.title || chat.title === "New Chat")) {
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

				await ChatModel.findByIdAndUpdate(chatId, {
					title,
				});
			} catch (err) {
				console.log("Title generation failed");
			}
		}

		const history: ChatCompletionMessageParam[] =
			chat?.messages?.slice(-8).map((m) => ({
				role: m.role as "user" | "assistant",
				content: m.content,
			})) || [];

		// RAG
		const queryEmbedding = await createEmbedding(message);
		const relevantDocs = await findRelevantDocs(queryEmbedding);
		const context = relevantDocs.length
			? buildContext(relevantDocs)
			: "No relevant context found.";

		const stream = await openai.chat.completions.create({
			model: "gpt-4o-mini",
			stream: true,
			messages: [
				{
					role: "system",
					content: `
You are a personal assistant for Veljko.

Use ONLY the provided context.

IMPORTANT:
- If information exists in the context, you MUST use it.
- NEVER say information is missing if it exists.
- DO NOT contradict the context.
- If SKILLS section exists, always use it for skill-related questions.
- If the requested information is not available, say that clearly,
but also provide related relevant information from the context.

RULES:
- Use bullet points
- Use **bold**
- Be concise
- Do NOT invent information

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
		await ChatModel.findByIdAndUpdate(chatId, {
			$push: {
				messages: {
					role: "assistant",
					content: fullText,
				},
			},
		});

		res.end();
	} catch (error) {
		console.error("Stream error:", error);
		try {
			res.status(500).json({
				error: "Internal server error",
			});
		} catch {
			// fallback ako response već počeo
		}
	}
});

// SUGGESTIONS

router.post("/suggestions", async (req: Request, res: Response) => {
	try {
		const { message, answer } = req.body as {
			message: string;
			answer?: string;
		};

		if (!message) {
			return res.status(400).json({
				error: "Missing message",
			});
		}

		const queryEmbedding = await createEmbedding(message);
		const relevantDocs = await findRelevantDocs(queryEmbedding);
		const context = relevantDocs.length
			? buildContext(relevantDocs)
			: "No relevant context found.";

		const messages: ChatCompletionMessageParam[] = [
			{
				role: "system",
				content: `
Generate 3 short follow-up questions BASED ONLY on the provided context.

STRICT RULES:
- Only ask about information that CLEARLY EXISTS in the context
- If something is not explicitly mentioned, DO NOT ask about it
- NEVER ask about "learning", "future plans", or anything not present

IMPORTANT:
- Questions MUST be answerable using the context
- Do NOT guess or assume

Rules:
- max 8 words
- no numbering
- plain text

Examples:

Context: "He uses React and TypeScript"
GOOD:
- What technologies does he use?
BAD:
- What is he learning?

Context:
${context}
	`,
			},
			{
				role: "user",
				content: message,
			},
		];

		if (answer) {
			messages.push({
				role: "assistant",
				content: answer,
			});
		}

		const completion = await openai.chat.completions.create({
			model: "gpt-4o-mini",
			messages,
		});

		const raw = completion.choices[0].message.content || "";

		const suggestions = raw
			.split("\n")
			.map((s) => s.trim())
			.filter(Boolean)
			.slice(0, 3);

		res.json({ suggestions });
	} catch (error) {
		console.error("❌ Suggestions error:", error);

		res.status(500).json({
			suggestions: [],
			error: "Failed to generate suggestions",
		});
	}
});

//  CREATE

router.post("/create", async (req, res) => {
	const chat = await ChatModel.create({
		messages: [
			{
				role: "assistant",
				content: "Hi! I'm Veljko's AI assistant 🚀",
			},
		],
	});
	res.json(chat);
});

//  GET

router.get("/", async (req, res) => {
	const chats = await ChatModel.find().sort({ updatedAt: -1 });
	res.json(chats);
});

// RENAME

router.patch("/rename", async (req, res) => {
	const { chatId, title } = req.body;

	// VALIDATION PRVO
	if (!chatId || !title) {
		return res.status(400).json({
			error: "Missing chatId or title",
		});
	}

	const updated = await ChatModel.findByIdAndUpdate(
		chatId,
		{ title },
		{ returnDocument: "after" },
	);

	res.json(updated);
});

// DELETE

router.delete("/:id", async (req, res) => {
	await ChatModel.findByIdAndDelete(req.params.id);
	res.json({ success: true });
});

// PIN

router.patch("/pin", async (req, res) => {
	const { chatId, pinned } = req.body;

	if (!chatId || typeof pinned !== "boolean") {
		return res.status(400).json({
			error: "Invalid data",
		});
	}

	const updated = await ChatModel.findByIdAndUpdate(
		chatId,
		{ pinned },
		{ returnDocument: "after" },
	);

	res.json(updated);
});

export default router;

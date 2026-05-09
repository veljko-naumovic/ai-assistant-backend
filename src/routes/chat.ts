import { Router, Request, Response } from "express";
import OpenAI from "openai";
import { createEmbedding } from "../utils/embeddings";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { ChatModel } from "../models/Chat";
import { index } from "../config/pinecone";
import { documents } from "../data/documents";

const router = Router();

const openai = new OpenAI({
	apiKey: process.env.OPENAI_API_KEY,
});

// FIND RELEVANT DOCS

const findRelevantDocs = async (queryEmbedding: number[]) => {
	const result = await index.query({
		vector: queryEmbedding,
		topK: 7,
		includeMetadata: true,
	});

	return (result.matches || [])
		.filter((m) => m.score && m.score > 0.2)
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

	console.log("RAW RELEVANT:", relevantDocs);

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

		// CHAT CHECK
		const chat = await ChatModel.findOne({ _id: chatId, userId });

		if (!chat) {
			return res.status(404).json({ error: "Chat not found" });
		}

		// SAVE USER MESSAGE
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

		// TITLE
		if (!chat.title || chat.title === "New Chat") {
			try {
				const completion = await openai.chat.completions.create({
					model: "gpt-4o-mini",
					messages: [
						{
							role: "system",
							content: "Generate short title (max 5 words).",
						},
						{ role: "user", content: message },
					],
				});

				const title =
					completion.choices[0].message.content?.trim() ||
					message.slice(0, 30);

				await ChatModel.findOneAndUpdate(
					{ _id: chatId, userId },
					{ title },
				);
			} catch {}
		}

		const history: ChatCompletionMessageParam[] = chat.messages
			.slice(-4)
			.map((m) => ({
				role: m.role as "user" | "assistant",
				content: m.content,
			}));

		// INTENT
		let intent = "general";

		try {
			const intentRes = await openai.chat.completions.create({
				model: "gpt-4o-mini",
				messages: [
					{
						role: "system",
						content:
							"Classify into ONE: experience | projects | skills | technologies | learning | education | about | general. Return ONLY category.",
					},
					{ role: "user", content: message },
				],
			});

			intent =
				intentRes.choices[0].message.content?.trim().toLowerCase() ||
				"general";
		} catch {}

		// RAG
		const queryEmbedding = await createEmbedding(message);
		let finalDocs = await findRelevantDocs(queryEmbedding);

		console.log(
			"RELEVANT DOC TYPES:",
			finalDocs.map((d) => d.type),
		);

		// MAP
		const intentMap: Record<string, string[]> = {
			experience: ["experience", "projects"],
			projects: ["projects", "fullstack"],
			skills: ["skills"],
			technologies: ["skills"],
			learning: ["learning"],
			education: ["education"],
			about: ["about"],
			general: ["about", "experience"],
		};

		// if (intentMap[intent]) {
		// 	const types = intentMap[intent];

		// 	finalDocs = types.flatMap((t) =>
		// 		finalDocs.filter((d) => d.type === t),
		// 	);

		// 	console.log("INTENT:", intent);
		// 	console.log("EXPECTED TYPES:", types);
		// 	console.log(
		// 		"FINAL DOC TYPES:",
		// 		finalDocs.map((d) => d.type),
		// 	);
		// }

		const types = intentMap[intent] || ["about"];

		finalDocs = types.flatMap((t) => finalDocs.filter((d) => d.type === t));

		const missingTypes = types.filter(
			(t) => !finalDocs.some((d) => d.type === t),
		);

		const fallbackDocs = missingTypes
			.map((t) => documents.find((d) => d.type === t))
			.filter(
				(
					doc,
				): doc is {
					type: string;
					text: string;
				} => Boolean(doc),
			);

		finalDocs = [...finalDocs, ...fallbackDocs];

		// FALLBACK
		if (!finalDocs.length) {
			finalDocs = [
				...documents.filter((d) => d.type === "experience"),
				...documents.filter((d) => d.type === "projects"),
			];
		}

		const context = buildContext(finalDocs);
		console.log("CONTEXT:\n", context);
		// AI
		const stream = await openai.chat.completions.create({
			model: "gpt-4o-mini",
			stream: true,
			temperature: 0.3,
			messages: [
				{
					role: "system",
					content: `
You are an AI assistant about Veljko Naumovic.

- Speak in third person
- Always start with current role (Frontend Developer at Eponuda)

- Be direct and specific
- Use ONLY provided context
- Do NOT invent facts

- Each sentence must add new, concrete information
- Remove redundant or overlapping information

- It is allowed to give shorter answers if no additional useful information exists

- Do not add summary or introductory sentences
- Do not mix formats (use a single consistent format)

- Use direct action verbs from the context (e.g. builds, works with, implements)
- Do NOT rewrite into formal CV-style phrases (e.g. "has experience", "is responsible for", "involves")

- When multiple context sections are provided, use ALL relevant sections in the answer

- Write in a natural, human tone while staying professional
`,
				},
				{
					role: "system",
					content: `Context:\n${context}`,
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

		// SAVE RESPONSE
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
	} catch (err) {
		console.error(err);
		res.status(500).json({ error: "Internal server error" });
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

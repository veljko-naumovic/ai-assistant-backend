import { Router, Request, Response } from "express";
import OpenAI from "openai";
import { createEmbedding } from "../utils/embeddings";
import { documents } from "../data/documents";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { ChatModel } from "../models/Chat";
import { index } from "../config/pinecone";

const router = Router();

const openai = new OpenAI({
	apiKey: process.env.OPENAI_API_KEY,
});

// 🔍 FIND RELEVANT DOCS

const findRelevantDocs = async (queryEmbedding: number[]) => {
	const result = await index.query({
		vector: queryEmbedding,
		topK: 5,
		includeMetadata: true,
	});

	return (result.matches || [])
		.filter((m) => m.score && m.score > 0.7)
		.map((match) => ({
			text: String(match.metadata?.text || ""),
			type: String(match.metadata?.type || "general"),
		}));
};

// 🧠 BUILD CONTEXT (reusable)

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

// 💬 CHAT (STREAM)

router.post("/", async (req: Request, res: Response) => {
	try {
		const { message, chatId } = req.body as {
			message: string;
			chatId: string;
		};

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

		const history: ChatCompletionMessageParam[] =
			chat?.messages?.slice(-8).map((m) => ({
				role: m.role as "user" | "assistant",
				content: m.content,
			})) || [];

		// 🔍 RAG
		const queryEmbedding = await createEmbedding(message);
		const relevantDocs = await findRelevantDocs(queryEmbedding);
		const context = buildContext(relevantDocs);

		const stream = await openai.chat.completions.create({
			model: "gpt-4o-mini",
			stream: true,
			messages: [
				{
					role: "system",
					content: `
You are a personal assistant for Veljko.

Use previous messages to maintain conversation context.

Use the structured context sections below:
- EXPERIENCE
- PROJECTS
- SKILLS
- FULLSTACK

Answer ONLY using the context.

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
		res.status(500).send("Something went wrong");
	}
});

// 💡 SUGGESTIONS

router.post("/suggestions", async (req: Request, res: Response) => {
	try {
		const { message, answer } = req.body as {
			message: string;
			answer?: string;
		};

		const queryEmbedding = await createEmbedding(message);
		const relevantDocs = await findRelevantDocs(queryEmbedding);
		const context = buildContext(relevantDocs);

		const messages: ChatCompletionMessageParam[] = [
			{
				role: "system",
				content: `
					Generate 3 short follow-up questions.

					Rules:
					- max 8 words
					- no numbering
					- plain text

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
		console.error("Suggestions error:", error);
		res.json({ suggestions: [] });
	}
});

// ➕ CREATE

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

// 📥 GET

router.get("/", async (req, res) => {
	const chats = await ChatModel.find().sort({ updatedAt: -1 });
	res.json(chats);
});

// ✏️ RENAME

router.patch("/rename", async (req, res) => {
	const { chatId, title } = req.body;

	const updated = await ChatModel.findByIdAndUpdate(
		chatId,
		{ title },
		{ returnDocument: "after" },
	);

	res.json(updated);
});

// ❌ DELETE

router.delete("/:id", async (req, res) => {
	await ChatModel.findByIdAndDelete(req.params.id);
	res.json({ success: true });
});

// 📌 PIN

router.patch("/pin", async (req, res) => {
	const { chatId, pinned } = req.body;

	const updated = await ChatModel.findByIdAndUpdate(
		chatId,
		{ pinned },
		{ returnDocument: "after" },
	);

	res.json(updated);
});

export default router;

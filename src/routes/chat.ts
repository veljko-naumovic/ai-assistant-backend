import { Router, Request, Response } from "express";
import OpenAI from "openai";
import { createEmbedding } from "../utils/embeddings";
import { cosineSimilarity } from "../utils/similarity";
import { documents } from "../data/documents";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

const router = Router();

const openai = new OpenAI({
	apiKey: process.env.OPENAI_API_KEY,
});

type EmbeddedDoc = {
	id: string;
	text: string;
	embedding: number[];
};

let embeddedDocs: EmbeddedDoc[] = [];
let isReady = false;

// INIT EMBEDDINGS
const initEmbeddings = async () => {
	embeddedDocs = await Promise.all(
		documents.map(async (doc) => ({
			...doc,
			embedding: await createEmbedding(doc.text),
		})),
	);
	isReady = true;
	console.log("✅ Embeddings ready");
};

initEmbeddings();

// FIND RELEVANT DOCS
const findRelevantDocs = (queryEmbedding: number[]) => {
	return embeddedDocs
		.map((doc) => ({
			...doc,
			score: cosineSimilarity(queryEmbedding, doc.embedding),
		}))
		.sort((a, b) => b.score - a.score)
		.slice(0, 5);
};

//
// 🧠 CHAT (STREAM)
//
router.post("/", async (req: Request, res: Response) => {
	try {
		const { message } = req.body as { message: string };

		if (!isReady) {
			return res.status(503).send("AI is warming up, try again...");
		}

		const queryEmbedding = await createEmbedding(message);
		const relevantDocs = findRelevantDocs(queryEmbedding);
		const context = relevantDocs.map((d) => d.text).join("\n");

		const stream = await openai.chat.completions.create({
			model: "gpt-4o-mini",
			stream: true,
			messages: [
				{
					role: "system" as const,
					content: `
						You are a personal assistant for Veljko.

						Answer ONLY using the context below.

						RULES:
						- Format answers using Markdown
						- Use bullet points
						- Use **bold**
						- Do NOT invent information
						- Keep answers short and natural

						Context:
						${context}
					`,
				},
				{
					role: "user" as const,
					content: message,
				},
			],
		});

		// HEADERS
		res.setHeader("Content-Type", "text/plain; charset=utf-8");
		res.setHeader("Transfer-Encoding", "chunked");
		res.setHeader("Cache-Control", "no-cache");
		res.setHeader("Connection", "keep-alive");

		let fullText = "";

		for await (const chunk of stream) {
			const text = chunk.choices[0]?.delta?.content;

			if (!text) continue;

			fullText += text;
			res.write(text);
			(res as any).flush?.();
		}

		res.end();
	} catch (error) {
		console.error("Stream error:", error);

		try {
			res.write("\nSomething went wrong.");
			res.end();
		} catch {
			res.status(500).send("Something went wrong");
		}
	}
});

//
// 💡 SUGGESTIONS
//
router.post("/suggestions", async (req: Request, res: Response) => {
	try {
		const { message, answer } = req.body as {
			message: string;
			answer?: string;
		};

		if (!isReady) {
			return res.status(503).json({ suggestions: [] });
		}

		const queryEmbedding = await createEmbedding(message);
		const relevantDocs = findRelevantDocs(queryEmbedding);
		const context = relevantDocs.map((d) => d.text).join("\n");

		const messages: ChatCompletionMessageParam[] = [
			{
				role: "system" as const,
				content: `
					You generate follow-up questions for a chat.

					Return ONLY 3 short questions.

					Rules:
					- max 8 words
					- no numbering
					- no explanation
					- plain text only

					If topic is:
					- frontend → suggest React, performance, UI
					- experience → suggest projects, challenges
					- general → suggest skills, tools

					Context:
					${context}
				`,
			},
			{
				role: "user" as const,
				content: message,
			},
		];

		if (answer) {
			messages.push({
				role: "assistant" as const,
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

export default router;

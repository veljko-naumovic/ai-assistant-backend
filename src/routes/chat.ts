import { Router, Request, Response } from "express";
import OpenAI from "openai";
import { createEmbedding } from "../utils/embeddings";
import { cosineSimilarity } from "../utils/similarity";
import { documents } from "../data/documents";
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

const initEmbeddings = async () => {
	embeddedDocs = await Promise.all(
		documents.map(async (doc) => ({
			...doc,
			embedding: await createEmbedding(doc.text),
		})),
	);
};

// pokreni odmah
initEmbeddings();

const findRelevantDocs = (queryEmbedding: number[]) => {
	return embeddedDocs
		.map((doc) => ({
			...doc,
			score: cosineSimilarity(queryEmbedding, doc.embedding),
		}))
		.sort((a, b) => b.score - a.score)
		.slice(0, 3);
};

router.post("/", async (req: Request, res: Response) => {
	try {
		const { message } = req.body as { message: string };

		// 1. napravi embedding pitanja
		const queryEmbedding = await createEmbedding(message);

		// 2. nađi relevantne dokumente
		const relevantDocs = findRelevantDocs(queryEmbedding);

		const context = relevantDocs.map((d) => d.text).join("\n");

		// 3. pošalji GPT-u sa contextom
		const response = await openai.chat.completions.create({
			model: "gpt-4o-mini",
			messages: [
				{
					role: "system",
					content: `
						You are a personal assistant for Veljko.

						Answer ONLY using the context below.
						If answer is not in context, say you don't know.

						If technologies are closely related (e.g., React → JavaScript), you can infer the relationship.

						Context:
						${context}`,
				},
				{
					role: "user",
					content: message,
				},
			],
		});

		res.json({
			answer: response.choices[0].message.content,
		});
	} catch (error) {
		console.error(error);
		res.status(500).json({
			answer: "Something went wrong",
		});
	}
});

export default router;

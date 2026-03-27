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

router.post("/", async (req: Request, res: Response) => {
	try {
		const { message } = req.body as { message: string };

		// is embeddings ready
		if (!isReady) {
			return res.status(503).send("AI is warming up, try again...");
		}

		// embedding question
		const queryEmbedding = await createEmbedding(message);

		// relevant docs
		const relevantDocs = findRelevantDocs(queryEmbedding);

		const context = relevantDocs.map((d) => d.text).join("\n");

		// 3. STREAM GPT
		const stream = await openai.chat.completions.create({
			model: "gpt-4o-mini",
			stream: true,
			messages: [
				{
					role: "system",
					content: `
						You are a personal assistant for Veljko.

						Answer ONLY using the context below.

						RULES:
						- If the question asks for more details (e.g. "tell me more"):
						→ expand using the context (projects, experience, technologies).

						- If the answer is NOT in the context:
						→ say you don't have that specific information,
						→ BUT mention what you DO know about Veljko (technologies, experience).

						- Do NOT guess.
						- Do NOT invent information.
						- Always include specific details (technologies, companies, projects).

						- Keep answers short and natural.

						Context:
						${context}
          			`,
				},
				{
					role: "user",
					content: message,
				},
			],
		});

		// STREAM HEADERS
		res.setHeader("Content-Type", "text/plain; charset=utf-8");
		res.setHeader("Transfer-Encoding", "chunked");
		res.setHeader("Cache-Control", "no-cache");
		res.setHeader("Connection", "keep-alive");

		// STREAM RESPONSE
		for await (const chunk of stream) {
			const text = chunk.choices[0]?.delta?.content;

			if (!text) continue;

			res.write(text);

			// optional flush (ako koristiš compression)
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

export default router;

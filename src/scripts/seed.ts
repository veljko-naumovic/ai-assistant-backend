import "dotenv/config";
import { index } from "../config/pinecone";
import { documents } from "../data/documents";
import { createEmbedding } from "../utils/embeddings";

const seed = async () => {
	console.log("🚀 Seeding Pinecone...");

	await index.deleteAll(); // first delete than feed with data

	const vectors = await Promise.all(
		documents.map(async (doc) => {
			const embedding = await createEmbedding(doc.text);

			return {
				id: doc.id,
				values: embedding,
				metadata: {
					text: doc.text,
				},
			};
		}),
	);

	await index.upsert({
		records: vectors,
	});

	console.log("✅ Done seeding");
	process.exit(0);
};

seed();

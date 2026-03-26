export const chunkText = (text: string, chunkSize = 200) => {
	const sentences = text.split(".");
	const chunks: string[] = [];

	let current = "";

	for (const sentence of sentences) {
		if ((current + sentence).length > chunkSize) {
			chunks.push(current);
			current = sentence;
		} else {
			current += sentence + ".";
		}
	}

	if (current) chunks.push(current);

	return chunks.map((chunk, i) => ({
		id: String(i),
		text: chunk.trim(),
	}));
};

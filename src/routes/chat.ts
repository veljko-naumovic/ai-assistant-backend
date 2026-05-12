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
							"Classify into ONE: experience | projects | skills | technologies | learning | education | about | story | background | career | general. Return ONLY category.",
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

		// MAP
		const intentMap: Record<string, string[]> = {
			experience: ["experience", "projects"],
			projects: ["projects", "fullstack"],
			skills: ["skills"],
			technologies: ["skills"],
			learning: ["learning"],
			education: ["education"],
			about: ["about"],
			story: ["story", "education", "about"],
			background: ["story", "education", "about"],
			career: ["story", "experience", "about"],
			general: ["about", "experience"],
		};

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

							- Always start with current role (Frontend Developer at Eponuda)

							- Be direct and specific
							- Use ONLY provided context
							- Do NOT invent facts

							- Each sentence must add new, concrete information
							- Remove redundant or overlapping information

							- It is allowed to give shorter answers if no additional useful information exists

							- Do not add summary or introductory sentences
							- Do not mix formats (use a single consistent format)

							- Do not infer specific implementation details from general terms
							- If information is not explicitly provided, say that the context does not contain that detail

							- Use bullet points for technologies and skills questions

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
		const {
			answer,
			history = [],
		}: {
			answer: string;
			history: { role: string; content: string }[];
		} = req.body;

		// ---------------------------------------------------
		// fallback suggestions
		// ---------------------------------------------------
		const fallbackSuggestions = [
			"What projects has Veljko worked on?",
			"What technologies does Veljko use?",
			"Tell me about his experience",
		];

		// ---------------------------------------------------
		// invalid / empty answers
		// ---------------------------------------------------
		const badPhrases = [
			"cannot engage",
			"outside of the context",
			"not provided in the context",
			"i don't have information",
			"i do not have information",
			"no relevant information",
			"context does not contain",
		];

		const lowerAnswer = answer?.toLowerCase() || "";

		const isBadAnswer = badPhrases.some((p) => lowerAnswer.includes(p));

		if (isBadAnswer) {
			return res.json({
				suggestions: fallbackSuggestions,
			});
		}

		// ---------------------------------------------------
		// recent user questions
		// ---------------------------------------------------
		const recentQuestions = history
			.filter((m) => m.role === "user")
			.map((m) => m.content)
			.slice(-10);

		const recentQuestionsText = recentQuestions.join("\n");

		// ---------------------------------------------------
		// semantic topic memory
		// ---------------------------------------------------
		const usedTopicGroups = new Set<string>();

		recentQuestions.forEach((q) => {
			const lower = q.toLowerCase();

			// company
			if (
				lower.includes("company") ||
				lower.includes("work") ||
				lower.includes("eponuda") ||
				lower.includes("organization")
			) {
				usedTopicGroups.add("company");
			}

			// role
			if (
				lower.includes("role") ||
				lower.includes("job") ||
				lower.includes("title") ||
				lower.includes("frontend developer")
			) {
				usedTopicGroups.add("role");
			}

			// projects / systems
			if (
				lower.includes("project") ||
				lower.includes("platform") ||
				lower.includes("application") ||
				lower.includes("system")
			) {
				usedTopicGroups.add("project");
			}

			// technologies
			if (
				lower.includes("technology") ||
				lower.includes("react") ||
				lower.includes("next") ||
				lower.includes("vue") ||
				lower.includes("typescript") ||
				lower.includes("firebase") ||
				lower.includes("node") ||
				lower.includes("redux")
			) {
				usedTopicGroups.add("technology");
			}

			// ui libraries
			if (
				lower.includes("ui") ||
				lower.includes("library") ||
				lower.includes("material ui") ||
				lower.includes("ant design") ||
				lower.includes("tailwind") ||
				lower.includes("bootstrap") ||
				lower.includes("scss")
			) {
				usedTopicGroups.add("ui");
			}

			// features
			if (
				lower.includes("feature") ||
				lower.includes("dashboard") ||
				lower.includes("table") ||
				lower.includes("form") ||
				lower.includes("chart") ||
				lower.includes("filter")
			) {
				usedTopicGroups.add("features");
			}

			// experience
			if (
				lower.includes("experience") ||
				lower.includes("career") ||
				lower.includes("background")
			) {
				usedTopicGroups.add("experience");
			}
		});

		// ---------------------------------------------------
		// question groups
		// ---------------------------------------------------
		const questionGroups = [
			{
				group: "company",
				keywords: ["company", "work", "organization", "eponuda"],
			},
			{
				group: "role",
				keywords: ["role", "job", "title", "frontend developer"],
			},
			{
				group: "project",
				keywords: ["project", "platform", "application", "system"],
			},
			{
				group: "technology",
				keywords: [
					"technology",
					"react",
					"next",
					"vue",
					"typescript",
					"firebase",
					"node",
					"redux",
				],
			},
			{
				group: "ui",
				keywords: [
					"ui",
					"library",
					"material ui",
					"ant design",
					"tailwind",
					"bootstrap",
					"scss",
				],
			},
			{
				group: "features",
				keywords: [
					"feature",
					"dashboard",
					"table",
					"form",
					"chart",
					"filter",
				],
			},
			{
				group: "experience",
				keywords: ["experience", "career", "background"],
			},
		];

		// ---------------------------------------------------
		// AI suggestions
		// ---------------------------------------------------
		const completion = await openai.chat.completions.create({
			model: "gpt-4o-mini",
			temperature: 0.15,
			messages: [
				{
					role: "system",
					content: `
Generate 3 follow-up questions about Veljko.

Previous user questions:
${recentQuestionsText}

STRICT RAG RULES:
- Questions MUST be directly answerable from the provided answer
- Answers must exist explicitly in the text
- NEVER infer knowledge
- NEVER generalize technologies into broader concepts
- NEVER invent missing details
- NEVER ask speculative questions
- NEVER ask opinion questions
- NEVER ask architecture questions
- NEVER ask implementation questions
- NEVER ask performance questions
- NEVER ask challenge questions
- NEVER ask preference questions
- NEVER ask abstract questions

IMPORTANT:
If answer mentions:
- Ant Design → ask about UI libraries
- Redux Toolkit → ask about state management tools
- React → ask about frontend technologies

DO NOT transform technologies into broader concepts.

BAD:
- What design systems is he familiar with?
- What architecture does he use?
- How does he optimize performance?
- What challenges did he face?
- How does he maintain the platform?

GOOD:
- What UI libraries does he use?
- What state management tools does he use?
- What projects has he worked on?
- What frontend technologies does he use?

IMPORTANT:
Avoid semantically similar questions.
Avoid repeating previous topics.
Prefer different topics.

FORMAT:
- max 8 words
- plain text
- no numbering
`,
				},
				{
					role: "user",
					content: answer,
				},
			],
		});

		const raw = completion.choices[0].message.content || "";

		// ---------------------------------------------------
		// parse suggestions
		// ---------------------------------------------------
		let suggestions = raw
			.split("\n")
			.map((s) =>
				s
					.replace(/^\d+\.?\s*/, "")
					.replace(/^- /, "")
					.trim(),
			)
			.filter((s) => s.length > 5)

			// remove exact duplicates
			.filter(
				(s, index, arr) =>
					arr.findIndex(
						(x) => x.toLowerCase() === s.toLowerCase(),
					) === index,
			)

			// semantic-lite duplicate removal
			.filter((s, index, arr) => {
				const normalized = s.toLowerCase();

				return !arr.some((other, otherIndex) => {
					if (index === otherIndex) return false;

					const o = other.toLowerCase();

					return (
						normalized.includes(o.slice(0, 15)) ||
						o.includes(normalized.slice(0, 15))
					);
				});
			})

			// remove already used topic groups
			.filter((s) => {
				const lower = s.toLowerCase();

				const matchedGroup =
					questionGroups.find((g) =>
						g.keywords.some((k) => lower.includes(k)),
					)?.group || "";

				if (!matchedGroup) return true;

				return !usedTopicGroups.has(matchedGroup);
			})

			.slice(0, 3);

		// ---------------------------------------------------
		// final fallback
		// ---------------------------------------------------
		if (!suggestions.length) {
			suggestions = fallbackSuggestions
				.filter((s) => {
					return !recentQuestions.some(
						(q) => q.toLowerCase() === s.toLowerCase(),
					);
				})
				.slice(0, 3);
		}

		res.json({ suggestions });
	} catch (err) {
		console.error("Suggestions error:", err);

		res.status(500).json({
			suggestions: [],
		});
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

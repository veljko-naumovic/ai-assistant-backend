import { Router, Request, Response } from "express";
import OpenAI from "openai";

const router = Router();

const openai = new OpenAI({
	apiKey: process.env.OPENAI_API_KEY,
});

router.post("/", async (req: Request, res: Response) => {
	try {
		const { message } = req.body as { message: string };

		const response = await openai.chat.completions.create({
			model: "gpt-4o-mini",
			messages: [
				{
					role: "system",
					content: `
You are a personal assistant for Veljko (frontend developer).

Answer ONLY questions about Veljko.
If question is not related, politely refuse.

Veljko info:
- Frontend developer
- React, Next.js, Vue, TypeScript
- Experience with Ant Design
- Built full-stack apps
          `,
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

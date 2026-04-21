import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import session from "express-session";
import crypto from "crypto";

import chatRouter from "./routes/chat";
import { connectDB } from "./config/db";

const app = express();
connectDB();

app.use(
	cors({
		origin: [
			"http://localhost:5173",
			"https://veljko-naumovic-portfolio.web.app",
		],
		credentials: true,
		methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
		allowedHeaders: ["Content-Type", "x-user-id"],
	}),
);

app.use(
	session({
		name: "ai-assistant-session",
		secret: process.env.SESSION_SECRET || "super-secret",
		resave: false,
		saveUninitialized: false,
		cookie: {
			httpOnly: true,
			secure: true,
			sameSite: "none",
			maxAge: 1000 * 60 * 60 * 24 * 7,
		},
	}),
);

// USER SESSION INIT
app.use((req, res, next) => {
	const session = req.session as any;

	if (!session.userId) {
		session.userId = crypto.randomUUID();
	}

	next();
});

app.use(express.json());

app.use((req, res, next) => {
	res.setHeader("Cache-Control", "no-store");
	next();
});

app.use("/api/chat", chatRouter);

const PORT = 5000;

app.listen(PORT, () => {
	console.log(`Server running on port ${PORT}`);
});

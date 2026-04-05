import dotenv from "dotenv";
dotenv.config();
import express from "express";
import cors from "cors";
import chatRouter from "./routes/chat";
import { connectDB } from "./config/db";

const app = express();
connectDB();

app.use(cors());
app.use(express.json());

app.use("/api/chat", chatRouter);

const PORT = 5000;

app.listen(PORT, () => {
	console.log(`Server running on port ${PORT}`);
});

import express, { Request, Response } from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = 5000;

app.use(cors());
app.use(express.json());

app.get("/api/test", (req: Request, res: Response) => {
	res.json({ message: "Backend works" });
});

app.listen(PORT, () => {
	console.log(`Server running on http://localhost:${PORT}`);
});

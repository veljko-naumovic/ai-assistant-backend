import mongoose from "mongoose";

const MessageSchema = new mongoose.Schema({
	role: {
		type: String,
		enum: ["user", "assistant"],
		required: true,
	},
	content: {
		type: String,
		required: true,
	},
	createdAt: {
		type: Date,
		default: Date.now,
	},
});

const ChatSchema = new mongoose.Schema(
	{
		title: {
			type: String,
			default: "New Chat",
		},
		pinned: {
			type: Boolean,
			default: false,
		},
		messages: [MessageSchema],
	},
	{
		timestamps: true, // createdAt, updatedAt
	},
);

export const ChatModel = mongoose.model("Chat", ChatSchema);

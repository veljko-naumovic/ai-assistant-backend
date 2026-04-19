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
		userId: {
			type: String,
			required: true,
		},

		title: {
			type: String,
			default: "New Chat",
		},

		pinned: {
			type: Boolean,
			default: false,
		},

		messages: [
			{
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
			},
		],
	},
	{
		timestamps: true,
	},
);

export const ChatModel = mongoose.model("Chat", ChatSchema);

import { chunkText } from "../utils/chunkText";

const structuredData = [
	{
		type: "experience",
		text: `
Veljko Naumovic is a frontend developer working at Eponuda since 2021.
He develops scalable and high-performance applications using React.
		`,
	},
	{
		type: "projects",
		text: `
He worked on a large price comparison platform used across Serbia and the Adria region.
The platform handles large datasets and complex filtering systems.
		`,
	},
	{
		type: "skills",
		text: `
His tech stack includes React, TypeScript, JavaScript, Next.js, Redux Toolkit,
Ant Design, Tailwind, Material UI, SCSS, and Bootstrap.
		`,
	},
	{
		type: "fullstack",
		text: `
He built a full-stack application using React, TypeScript, Node.js, and Firebase.
		`,
	},
	{
		type: "about",
		text: `
Veljko Naumovic is a frontend developer with a focus on building scalable and high-performance web applications.

He is motivated, detail-oriented, and enjoys solving complex problems.

He has a strong interest in modern technologies, especially AI-powered applications and clean architecture.

He values continuous learning and enjoys collaborating in team environments.
	`,
	},
];

export const documents = structuredData.flatMap((doc, index) => {
	const chunks = chunkText(doc.text);

	return chunks.map((chunk, i) => ({
		id: `${doc.type}-${index}-${i}`,
		text: chunk.text,
		type: doc.type, // 🔥 BITNO
	}));
});

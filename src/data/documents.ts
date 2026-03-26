import { chunkText } from "../utils/chunkText";
import { rawData } from "./rawData";

export const documents = chunkText(rawData);

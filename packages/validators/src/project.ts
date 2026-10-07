import { z } from "zod";
import { contentPackSchema } from "./content-pack";
import { sourceLanguageCodeSchema } from "./language";

export const generateProjectRequestSchema = z.object({
  contentPack: contentPackSchema,
  forceRegenerate: z.boolean().default(false),
  languageCode: sourceLanguageCodeSchema.default(null),
});

export type GenerateProjectInput = z.infer<typeof generateProjectRequestSchema>;

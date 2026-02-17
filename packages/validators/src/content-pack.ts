import { z } from "zod";
import { outputTypeSchema } from "./output-type";

export const contentPackSchema = z.object({
  outputTypes: z.array(outputTypeSchema).min(1),
  clipCountTarget: z.number().int().positive(),
  clipDurationSecTarget: z.number().int().positive(),
  toneConstraints: z.array(z.string()).default([]),
  captionPreset: z.string().min(1),
  platformPlaybookVersion: z.string().min(1),
});

export type ContentPack = z.infer<typeof contentPackSchema>;

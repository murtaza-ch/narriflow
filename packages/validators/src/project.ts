import { z } from "zod";
import { contentPackSchema } from "./content-pack";

export const createProjectSchema = z.object({
  title: z.string().min(1),
  sourceMediaUrl: z.string().url(),
  workspaceId: z.string().uuid().optional(),
  languageCode: z.string().min(2).max(8).nullable().optional(),
});

export const generateProjectRequestSchema = z.object({
  contentPack: contentPackSchema,
  forceRegenerate: z.boolean().default(false),
  languageCode: z.string().min(2).max(8).nullable().default(null),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type GenerateProjectInput = z.infer<typeof generateProjectRequestSchema>;

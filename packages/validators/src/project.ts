import { z } from "zod";
import { contentPackSchema } from "./content-pack";

export const createProjectSchema = z.object({
  title: z.string().min(1),
  sourceMediaUrl: z.string().url(),
  workspaceId: z.string().uuid().optional(),
});

export const generateProjectRequestSchema = z.object({
  contentPack: contentPackSchema,
  forceRegenerate: z.boolean().default(false),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type GenerateProjectInput = z.infer<typeof generateProjectRequestSchema>;

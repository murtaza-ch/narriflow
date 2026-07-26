import { z } from "zod";
import { contentPackSchema } from "./content-pack";

export const autopilotStatusSchema = z.enum([
  "active",
  "paused",
  "running",
  "failed",
]);

export const autopilotRuleInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  rssUrl: z.string().url(),
  titlePrefix: z.string().trim().min(1).max(100).nullable().optional(),
  brandTemplateId: z.string().uuid().nullable().optional(),
  languageCode: z.string().trim().min(2).max(16).nullable().optional(),
  contentPack: contentPackSchema,
  intervalMinutes: z.number().int().min(60).max(10080).default(1440),
  maxEpisodesPerRun: z.number().int().min(1).max(10).default(3),
});

export const autopilotRuleUpdateSchema = autopilotRuleInputSchema
  .partial()
  .extend({
    status: z.enum(["active", "paused"]).optional(),
  });

export const autopilotRuleSnapshotSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  name: z.string(),
  rssUrl: z.string(),
  titlePrefix: z.string().nullable(),
  brandTemplateId: z.string().uuid().nullable(),
  languageCode: z.string().nullable(),
  contentPack: contentPackSchema,
  intervalMinutes: z.number().int(),
  maxEpisodesPerRun: z.number().int(),
  status: autopilotStatusSchema,
  lastCheckedAt: z.string().datetime().nullable(),
  nextRunAt: z.string().datetime(),
  lastError: z.string().nullable(),
  importedEpisodeCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
});

export type AutopilotStatus = z.infer<typeof autopilotStatusSchema>;
export type AutopilotRuleInput = z.infer<typeof autopilotRuleInputSchema>;
export type AutopilotRuleUpdate = z.infer<typeof autopilotRuleUpdateSchema>;
export type AutopilotRuleSnapshot = z.infer<typeof autopilotRuleSnapshotSchema>;

import { z } from "zod";
import { contentPackSchema } from "./content-pack";

export const autopilotStatusSchema = z.enum([
  "active",
  "paused",
  "running",
  "failed",
]);

export const autopilotInitialImportModeSchema = z.enum([
  "future_only",
  "latest",
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
  initialImportMode: autopilotInitialImportModeSchema.default("future_only"),
  initialImportCount: z.number().int().min(1).max(10).default(3),
}).strict();

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
  feedTitle: z.string().nullable(),
  initialImportMode: autopilotInitialImportModeSchema,
  initialImportCount: z.number().int(),
  status: autopilotStatusSchema,
  lastCheckedAt: z.string().datetime().nullable(),
  lastSuccessAt: z.string().datetime().nullable(),
  nextRunAt: z.string().datetime(),
  lastError: z.string().nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
  importedEpisodeCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
});

export type AutopilotStatus = z.infer<typeof autopilotStatusSchema>;
export type AutopilotInitialImportMode = z.infer<
  typeof autopilotInitialImportModeSchema
>;
export type AutopilotRuleInput = z.input<typeof autopilotRuleInputSchema>;
export type AutopilotRuleUpdate = z.infer<typeof autopilotRuleUpdateSchema>;
export type AutopilotRuleSnapshot = z.infer<typeof autopilotRuleSnapshotSchema>;

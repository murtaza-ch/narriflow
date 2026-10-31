import { z } from "zod";
import { recipeContentPackSchema } from "./recipe";
import { finishingSettingsSchema } from "./finishing";
import { sourceLanguageCodeSchema } from "./language";
import { autopilotFinishingAuthoritySchema } from "./autopilot-finishing-authority";
const id = z.string().uuid(), revision = z.number().int().positive();
export const autopilotImportSourceSchema = z.strictObject({ ruleId: id, recipeId: id, recipeRevision: revision, recipeContentRevision: revision, sourceRuleFingerprint: z.string().regex(/^[a-f0-9]{64}$/), authority: autopilotFinishingAuthoritySchema });
export const autopilotImportPlanSchema = z.strictObject({
  source: autopilotImportSourceSchema,
  recipe: z.strictObject({ id, revision, brandProfileId: id.nullable(), languageCode: sourceLanguageCodeSchema, contentPack: recipeContentPackSchema, finishing: finishingSettingsSchema.nullable() }),
});
export const autopilotCycleInputSchema = autopilotImportPlanSchema.extend({
  rssUrl: z.string().url().max(8192), titlePrefix: z.string().max(1000).nullable(),
  intervalMinutes: z.number().int().positive().max(10080),
  selectionRule: z.strictObject({ initializedAt: z.iso.datetime().nullable(), initialImportMode: z.enum(["future_only", "latest"]), initialImportCount: z.number().int().min(1).max(10), maxEpisodesPerRun: z.number().int().min(1).max(10), lastSeenEpisodeId: z.string().max(8192).nullable(), lastSeenPublishedAt: z.iso.datetime().nullable() }),
});
export type AutopilotCycleInput = z.infer<typeof autopilotCycleInputSchema>;
export const autopilotCycleSelectionSchema = z.strictObject({ indices: z.array(z.number().int().min(0).max(499)).max(10), episodeHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(10), shouldAdvanceCursor: z.boolean(), deferred: z.boolean() }).refine(value => value.indices.length === value.episodeHashes.length, "Every selected episode has its frozen identity");
export type AutopilotCycleSelection = z.infer<typeof autopilotCycleSelectionSchema>;
export const zoomRecordingTargetSchema = z.strictObject({
  kind: z.literal("recording"), plan: autopilotImportPlanSchema,
  scope: z.strictObject({ workspaceId: id, actorUserId: id }),
  connectionId: id, connectionUserId: id, titlePrefix: z.string().max(1000).nullable(),
});
export type ZoomRecordingTarget = z.infer<typeof zoomRecordingTargetSchema>;
export const zoomExecutionTargetSchema = z.discriminatedUnion("kind", [zoomRecordingTargetSchema, z.strictObject({ kind: z.literal("deauthorize"), connectionId: id })]);

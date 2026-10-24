import { z } from "zod";

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

export const autopilotPauseKindSchema = z.enum(["acting_member", "brand_profile", "zoom_connection"]);
export const autopilotSourceKindSchema = z.enum(["rss", "zoom"]);

// Create and update share these fields. Defaults live only on the create
// schema: a partial update must not reset fields it did not send.
const autopilotRuleFields = z.object({
  name: z.string().trim().min(1).max(120),
  rssUrl: z.string().url().nullable().optional(),
  zoomConnectionId: z.string().uuid().nullable().optional(),
  // Case-insensitive topic substring. Empty means every recording by this host.
  zoomTopicFilter: z.string().trim().min(1).max(200).nullable().optional(),
  titlePrefix: z.string().trim().min(1).max(100).nullable().optional(),
  // The Brand Profile, language, Content Pack, and finishing every import uses.
  recipeId: z.string().uuid(),
  intervalMinutes: z.number().int().min(60).max(10080),
  maxEpisodesPerRun: z.number().int().min(1).max(10),
  initialImportMode: autopilotInitialImportModeSchema,
  initialImportCount: z.number().int().min(1).max(10),
});

export const autopilotRuleInputSchema = autopilotRuleFields
  .extend({
    sourceKind: autopilotSourceKindSchema.default("rss"),
    intervalMinutes: autopilotRuleFields.shape.intervalMinutes.default(1440),
    maxEpisodesPerRun: autopilotRuleFields.shape.maxEpisodesPerRun.default(3),
    initialImportMode: autopilotRuleFields.shape.initialImportMode.default("future_only"),
    initialImportCount: autopilotRuleFields.shape.initialImportCount.default(3),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.sourceKind === "rss" && (!value.rssUrl || value.zoomConnectionId || value.zoomTopicFilter))
      ctx.addIssue({ code: "custom", path: ["rssUrl"], message: "An RSS rule needs a feed URL and cannot use Zoom fields." });
    if (value.sourceKind === "zoom" && (!value.zoomConnectionId || value.rssUrl || value.initialImportMode !== "future_only"))
      ctx.addIssue({ code: "custom", path: ["zoomConnectionId"], message: "A Zoom rule needs a connection and watches future recordings only." });
  });

export const autopilotRuleUpdateSchema = autopilotRuleFields
  .partial()
  .extend({
    status: z.enum(["active", "paused"]).optional(),
  })
  .strict();

export const autopilotRuleSnapshotSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  createdByUserId: z.string().uuid().nullable(),
  name: z.string(),
  sourceKind: autopilotSourceKindSchema,
  rssUrl: z.string().nullable(),
  zoomConnectionId: z.string().uuid().nullable(),
  zoomTopicFilter: z.string().nullable(),
  titlePrefix: z.string().nullable(),
  recipeId: z.string().uuid(),
  recipeName: z.string(),
  intervalMinutes: z.number().int(),
  maxEpisodesPerRun: z.number().int(),
  feedTitle: z.string().nullable(),
  initialImportMode: autopilotInitialImportModeSchema,
  initialImportCount: z.number().int(),
  status: autopilotStatusSchema,
  // Why Autopilot itself paused the rule; null for a pause someone chose.
  pauseKind: autopilotPauseKindSchema.nullable(),
  lastCheckedAt: z.string().datetime().nullable(),
  lastSuccessAt: z.string().datetime().nullable(),
  nextRunAt: z.string().datetime(),
  lastError: z.string().nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
  importedEpisodeCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
});

export type AutopilotStatus = z.infer<typeof autopilotStatusSchema>;
export type AutopilotPauseKind = z.infer<typeof autopilotPauseKindSchema>;
export type AutopilotInitialImportMode = z.infer<
  typeof autopilotInitialImportModeSchema
>;
export type AutopilotRuleInput = z.input<typeof autopilotRuleInputSchema>;
export type AutopilotRuleUpdate = z.infer<typeof autopilotRuleUpdateSchema>;
export type AutopilotRuleSnapshot = z.infer<typeof autopilotRuleSnapshotSchema>;

export const zoomConnectionSnapshotSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  displayName: z.string(),
  revoked: z.boolean(),
  canDisconnect: z.boolean(),
});
export type ZoomConnectionSnapshot = z.infer<typeof zoomConnectionSnapshotSchema>;

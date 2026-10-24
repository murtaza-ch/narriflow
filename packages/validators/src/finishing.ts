import { z } from "zod";
import { clipAspectRatioSchema, clipRenderResolutionSchema } from "./clip";
import { socialPlatformSchema } from "./social";

/** Finishing: when a generation completes, export its best clips with the
 * Brand Profile applied and write assisted copy for chosen platforms, then
 * leave the Project ready to review. One schema serves Autopilot rules (saved
 * on the rule) and REST/MCP requests (passed inline); both are frozen at
 * generation admission. */

const unique = (values: readonly string[]) => new Set(values).size === values.length;

export const FINISHING_MAX_TOP_CLIPS = 10;
export const FINISHING_MAX_QUEUE_ACCOUNTS = 10;

export const finishingSettingsSchema = z.strictObject({
  topClips: z.number().int().min(1).max(FINISHING_MAX_TOP_CLIPS).describe("Export this many of the generation's highest-scoring clips"),
  minScore: z.number().int().min(0).max(100).default(0).describe("Skip clips whose virality score is below this"),
  aspectRatios: z.array(clipAspectRatioSchema).min(1).max(4).refine(unique, "Choose each format once").optional()
    .describe("Export formats; omitted means the generation's default aspect ratio"),
  resolution: clipRenderResolutionSchema.default("1080p").describe("The plan's own resolution limit still applies"),
  copyPlatforms: z.array(socialPlatformSchema).max(socialPlatformSchema.options.length)
    .refine(unique, "Choose each platform once").default([]).describe("Write assisted copy for each picked clip on these platforms"),
  delivery: z.enum(["ready_to_review", "propose_to_queue", "send_review_round"]).default("ready_to_review")
    .describe("What happens after finishing: stop at ready_to_review, propose each picked clip to the queue accounts for a person to accept (propose_to_queue also needs the publishing:write scope), or send the finished exports to the reviewers of a standing grant as a Review Round (send_review_round belongs to an Autopilot rule and needs an active grant)"),
  queueAccountIds: z.array(z.string().uuid()).max(FINISHING_MAX_QUEUE_ACCOUNTS).refine(unique, "Choose each account once").default([])
    .describe("With propose_to_queue: the connected accounts each picked clip is proposed to, using that platform's copy"),
}).superRefine((settings, context) => {
  if (settings.delivery === "propose_to_queue" && settings.queueAccountIds.length === 0) {
    context.addIssue({ code: "custom", path: ["queueAccountIds"], message: "Choose at least one account to propose to" });
  }
  if (settings.delivery !== "propose_to_queue" && settings.queueAccountIds.length > 0) {
    context.addIssue({ code: "custom", path: ["queueAccountIds"], message: "Accounts apply only when delivery is propose_to_queue" });
  }
});
export type FinishingSettings = z.infer<typeof finishingSettingsSchema>;
export type FinishingSettingsInput = z.input<typeof finishingSettingsSchema>;

/** What a generation freezes: the same settings with the formats resolved. */
export const frozenFinishingSettingsSchema = finishingSettingsSchema.safeExtend({
  aspectRatios: z.array(clipAspectRatioSchema).min(1).max(4),
});
export type FrozenFinishingSettings = z.infer<typeof frozenFinishingSettingsSchema>;

export function freezeFinishingSettings(settings: FinishingSettings, defaultAspectRatio: FrozenFinishingSettings["aspectRatios"][number]): FrozenFinishingSettings {
  return frozenFinishingSettingsSchema.parse({ ...settings, aspectRatios: settings.aspectRatios ?? [defaultAspectRatio] });
}

// `exporting` parks a row while its exports render; it wakes without a claim.
export const FINISHING_STATES = ["waiting", "due", "running", "exporting", "ready", "partial", "skipped"] as const;
export const finishingStateSchema = z.enum(FINISHING_STATES);
export type FinishingState = z.infer<typeof finishingStateSchema>;

/** Why finishing ended without (all of) its work. Shown on the Project page. */
const FINISHING_REASONS = {
  generation_failed: "Clip generation failed, so there was nothing to finish.",
  generation_cancelled: "Clip generation was cancelled, so there was nothing to finish.",
  plan_required: "Finishing needs the Pro plan or above. Your imports and clips are unaffected.",
  actor_unavailable: "The person this finishing ran for no longer has access to the Workspace.",
  actor_lacks_publishing: "The person this finishing ran for can't manage publishing, so no posts were proposed. The clips are ready to review.",
  no_clips: "No clip reached the minimum score, so nothing was exported.",
  exports_failed: "Not every export finished.",
  export_timeout: "An export took too long to finish.",
  copy_failed: "Copy could not be written for some clips.",
  queue_failed: "Some clips could not be proposed to the queue.",
  queue_account_unavailable: "A queue account is no longer connected, so nothing was proposed to it.",
  review_not_sent_no_grant: "No active standing grant covers this rule, so no review round was sent. The clips are ready to review in Narriflow.",
  review_not_sent_plan: "Review rooms need the Business plan, so no review round was sent. The clips are ready to review in Narriflow.",
  review_not_sent_cap: "The standing grant's cap was reached, so no review round was sent. The clips are ready to review in Narriflow.",
  review_not_sent_opted_out: "Every reviewer on the standing grant asked to stop automated review requests, so no review round was sent.",
  review_not_sent_changed: "The Autopilot rule changed after the standing grant was made, so the grant paused and no review round was sent.",
  review_not_sent_failed: "The review round could not be sent. The clips are ready to review in Narriflow.",
  review_not_sent_granter: "The person who granted the standing grant is no longer an Owner or Admin, so no review round was sent.",
  finishing_failed: "Finishing hit an unexpected error.",
} as const;
export type FinishingReason = keyof typeof FINISHING_REASONS;

/** Plain-language text for a stored reason code; unknown codes read generically. */
export function finishingReasonMessage(reason: string | null): string | null {
  if (!reason) return null;
  return reason in FINISHING_REASONS ? FINISHING_REASONS[reason as FinishingReason] : "Finishing did not complete.";
}

/** How Performance Guidance ranked one pick: the clip's own score, the bounded
 * factor it was multiplied by, and the audience groups the factor came from.
 * Present only when finishing ranked with the Workspace's audience data. */
export const finishingRankingSchema = z.object({
  score: z.number(),
  factor: z.number(),
  groups: z.array(z.object({ dimension: z.enum(["category", "duration"]), label: z.string(), lift: z.number() })),
  /** When the guidance that produced the factor was computed. */
  guidanceComputedAt: z.string(),
});
export type FinishingRanking = z.infer<typeof finishingRankingSchema>;

/** The clips a finishing chose and what each one produced, kept on its row so
 * a re-claim resumes instead of starting over. */
export const finishingPickSchema = z.object({
  clipId: z.string().uuid(),
  editorRevision: z.number().int().nonnegative(),
  ranking: finishingRankingSchema.optional(),
  exportId: z.string().uuid().optional(),
  exportError: z.string().optional(),
  copyGenerationId: z.string().uuid().optional(),
  copyError: z.string().optional(),
  /** Counts transient copy failures; part of the copy's idempotency key. */
  copyAttempt: z.number().int().nonnegative().optional(),
  /** Per queue account, `proposed` or the code the queue refused it with. An account is never tried twice. */
  queue: z.record(z.string(), z.string()).optional(),
  /** Per queue account, what a standing grant did with the proposal: `accepted`, or the reason it stayed a proposal. Absent when no grant covered it. */
  grant: z.record(z.string(), z.string()).optional(),
});
export const finishingPicksSchema = z.array(finishingPickSchema);
export type FinishingPick = z.infer<typeof finishingPickSchema>;

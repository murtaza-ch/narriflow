import { z } from "zod";
export {
  captionAnimationSchema,
  captionPresetSchema,
  type CaptionAnimation,
  type CaptionPreset,
} from "./caption-preset";
import { brollCuesArraySchema } from "./broll";
import { captionPresetSchema } from "./caption-preset";
import { contentPackSchema, clipPlatformTargetSchema } from "./content-pack";
import { studioEditsSchema } from "./studio-edits";
import { transcriptUtteranceSchema } from "./transcript";

export const clipCategorySchema = z.enum([
  "hook",
  "insight",
  "story",
  "humor",
  "controversy",
  "emotional",
  "tutorial",
  "quote",
  "debate",
  "surprise",
]);

export const clipStatusSchema = z.enum([
  "detected",
  "edited",
]);

export const clipRenderStatusSchema = z.enum([
  "pending",
  "rendering",
  "completed",
  "failed",
]);

/** Export resolution choice (vizard-parity Phase C). 1080p access and the
 *  free-tier watermark are entitlement-driven (billing.service's
 *  hasFeature), never a raw tier check — see triggerClipRendering, which
 *  clamps an unentitled 1080p request down to 720p rather than erroring. */
export const clipRenderResolutionSchema = z.enum(["720p", "1080p"]);

export const clipAspectRatioSchema = z.enum([
  "9:16",
  "1:1",
  "16:9",
  "4:5",
]);

export const clipAspectRatioDbSchema = z.enum([
  "ratio_9_16",
  "ratio_1_1",
  "ratio_16_9",
  "ratio_4_5",
]);

export const clipAspectRatioOptions = [
  {
    value: "9:16",
    label: "Vertical 9:16",
    css: "9 / 16",
    slug: "9x16",
    width: 1080,
    height: 1920,
    iconW: 9,
    iconH: 16,
  },
  {
    value: "1:1",
    label: "Square 1:1",
    css: "1 / 1",
    slug: "1x1",
    width: 1080,
    height: 1080,
    iconW: 12,
    iconH: 12,
  },
  {
    value: "16:9",
    label: "Landscape 16:9",
    css: "16 / 9",
    slug: "16x9",
    width: 1920,
    height: 1080,
    iconW: 16,
    iconH: 9,
  },
  {
    value: "4:5",
    label: "Portrait 4:5",
    css: "4 / 5",
    slug: "4x5",
    width: 1080,
    height: 1350,
    iconW: 10,
    iconH: 12,
  },
] as const satisfies ReadonlyArray<{
  value: z.infer<typeof clipAspectRatioSchema>;
  label: string;
  css: string;
  slug: string;
  width: number;
  height: number;
  iconW: number;
  iconH: number;
}>;

export const clipAspectRatioToDb = {
  "9:16": "ratio_9_16",
  "1:1": "ratio_1_1",
  "16:9": "ratio_16_9",
  "4:5": "ratio_4_5",
} as const satisfies Record<
  z.infer<typeof clipAspectRatioSchema>,
  z.infer<typeof clipAspectRatioDbSchema>
>;

export const clipAspectRatioFromDb = {
  ratio_9_16: "9:16",
  ratio_1_1: "1:1",
  ratio_16_9: "16:9",
  ratio_4_5: "4:5",
} as const satisfies Record<
  z.infer<typeof clipAspectRatioDbSchema>,
  z.infer<typeof clipAspectRatioSchema>
>;

export const updateClipCaptionPresetSchema = z.object({
  captionPreset: captionPresetSchema.nullable(),
});

/**
 * Request body for `POST /projects/:id/clips/apply-caption-preset`
 * ("apply to all"). Unlike the single-clip PATCH, a bulk apply always
 * supplies an actual preset (never null — there's no "clear every clip's
 * captions" action), so this schema doesn't reuse the nullable one.
 * `excludeClipId` mirrors `applyStudioEditsToAllSchema`: the calling studio
 * session already has the preset applied locally in its open document and
 * will persist it via the normal revision-guarded autosave, so it's skipped
 * server-side to avoid bumping its `editorRevision` out from under that
 * autosave's `baseRevision`.
 */
export const applyCaptionPresetToAllSchema = z.object({
  captionPreset: captionPresetSchema,
  excludeClipId: z.string().uuid().optional(),
});

export const updateClipBrollSchema = z.object({
  // A chosen Pexels download URL, or null to clear and fall back to auto B-roll.
  brollUrl: z.string().url().nullable(),
});

export const brollSearchQuerySchema = z.object({
  query: z.string().min(1).max(120),
  orientation: z.enum(["portrait", "landscape", "square"]).default("portrait"),
});

export const CLIP_RENDER_CAPTION_DIAGNOSTICS_LIMIT = 50;

/**
 * Caption characters a finished render could not draw. The worker records them
 * when it commits a successful render; the clip row shows them as a quiet note.
 * Code points are `U+XXXX` labels; skipped emoji are the plan emoji strings.
 */
export const clipRenderCaptionDiagnosticsSchema = z.object({
  omittedCodePoints: z.array(z.string().regex(/^U\+[0-9A-F]{4,6}$/)).max(CLIP_RENDER_CAPTION_DIAGNOSTICS_LIMIT),
  skippedEmoji: z.array(z.string().min(1).max(64)).max(CLIP_RENDER_CAPTION_DIAGNOSTICS_LIMIT),
});

export type ClipRenderCaptionDiagnostics = z.infer<typeof clipRenderCaptionDiagnosticsSchema>;

export const clipRenderVariantSchema = z.object({
  aspectRatio: clipAspectRatioSchema,
  status: clipRenderStatusSchema,
  sizeBytes: z.number().nullable(),
  durationSec: z.number().nullable(),
  errorCode: z.string().nullable(),
  completedAt: z.string().datetime().nullable(),
  hasAsset: z.boolean(),
  resolution: clipRenderResolutionSchema,
  /** Present only when characters were left out of this render's captions. */
  captionDiagnostics: clipRenderCaptionDiagnosticsSchema.nullable().optional(),
});

export const clipSnapshotSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  editorRevision: z.number().int().nonnegative(),
  index: z.number().int().nonnegative(),
  status: clipStatusSchema,
  startSec: z.number().nonnegative(),
  endSec: z.number().nonnegative(),
  durationSec: z.number().positive(),
  title: z.string().nullable(),
  hookText: z.string().min(1),
  payoffText: z.string().nullable(),
  reasoning: z.string().min(1),
  category: clipCategorySchema,
  platformFit: z.array(clipPlatformTargetSchema),
  viralityScore: z.number().int().min(1).max(100),
  hookStrengthScore: z.number().int().min(1).max(100),
  emotionalIntensityScore: z.number().int().min(1).max(100),
  storyCompletenessScore: z.number().int().min(1).max(100),
  pacingScore: z.number().int().min(1).max(100),
  durationOptimalityScore: z.number().int().min(1).max(100),
  tiktokScore: z.number().int().min(1).max(100),
  youtubeScore: z.number().int().min(1).max(100),
  instagramScore: z.number().int().min(1).max(100),
  transcriptSlice: z.array(transcriptUtteranceSchema),
  renderVariants: z.array(clipRenderVariantSchema),
  captionPreset: captionPresetSchema.nullable().optional(),
  /** The clip is the whole source, so `clipDurationBounds(true)` applies. */
  wholeSource: z.boolean().default(false),
  brollUrl: z.string().nullable().optional(),
  brollCues: brollCuesArraySchema.optional(),
  studioEdits: studioEditsSchema.optional(),
  // Whether the worker has cut this clip's lightweight 540p preview proxy
  // yet (Clip.previewStorageKey is set). The raw storage key never reaches
  // the client — this boolean is the only proxy-readiness signal exposed,
  // so the clip card's preview-fetch effect and the studio's poll effect
  // both have something that actually changes when the proxy lands (an SSE-
  // driven ClipSnapshot refresh otherwise touches no field either of them
  // depended on).
  hasPreview: z.boolean(),
  createdAt: z.string().datetime(),
});

/** The duration a clip's [startSec, endSec) window may have. Detected clips are
 *  10 to 120 seconds. A whole-source clip (a caption-only generation, such as a
 *  captioned video) is the entire source, so it may be 1 to 180 seconds.
 *
 *  This is the one boundary policy. The persistence codec checks it on encode
 *  and decode, the boundaries endpoint checks it, and the Studio's trim handles
 *  clamp to it, so they can never disagree about how short or long a clip may
 *  get. `Clip.wholeSource` selects the policy; a caller never chooses it. */
export const CLIP_MIN_DURATION_SEC = 10;
export const CLIP_MAX_DURATION_SEC = 120;
export const WHOLE_SOURCE_CLIP_MIN_DURATION_SEC = 1;
export const WHOLE_SOURCE_CLIP_MAX_DURATION_SEC = 180;

export function clipDurationBounds(wholeSource: boolean) {
  return wholeSource
    ? { minSec: WHOLE_SOURCE_CLIP_MIN_DURATION_SEC, maxSec: WHOLE_SOURCE_CLIP_MAX_DURATION_SEC }
    : { minSec: CLIP_MIN_DURATION_SEC, maxSec: CLIP_MAX_DURATION_SEC };
}

/** Sources are measured to the millisecond but billed and shown in whole
 *  seconds, so a source that rounds to the limit qualifies: a whole-source clip
 *  of 180.4 seconds is a 180 second source. */
export const WHOLE_SOURCE_CLIP_ROUNDING_SLACK_SEC = 0.5;

/** Whether a clip window of this length obeys `clipDurationBounds`, with the
 *  whole-source rounding slack at the top. `epsilonSec` absorbs float noise. */
export function clipDurationWithinBounds(durationSec: number, wholeSource: boolean, epsilonSec = 0.001) {
  const { minSec, maxSec } = clipDurationBounds(wholeSource);
  const tooLong = wholeSource
    ? durationSec >= maxSec + WHOLE_SOURCE_CLIP_ROUNDING_SLACK_SEC
    : durationSec > maxSec + epsilonSec;
  return durationSec >= minSec - epsilonSec && !tooLong;
}

/** The longest window `clipDurationWithinBounds` accepts. */
export function clipMaxWindowSec(wholeSource: boolean, epsilonSec = 0.001) {
  const { maxSec } = clipDurationBounds(wholeSource);
  return wholeSource ? maxSec + WHOLE_SOURCE_CLIP_ROUNDING_SLACK_SEC - epsilonSec : maxSec;
}

/** Where a clip's window may end: the source's exact probed duration when it
 *  is known, else `Project.sourceDurationSeconds`, which is rounded to whole
 *  seconds and so can fall up to half a second short of the media. */
export function clipSourceEdgeSec(project: { sourceDurationSeconds: number | null; sourceProbe?: unknown }): number | null {
  const probed = (project.sourceProbe as { durationSec?: unknown } | null | undefined)?.durationSec;
  return typeof probed === "number" && Number.isFinite(probed) && probed > 0 ? probed : project.sourceDurationSeconds;
}

/** The clip a caption-only generation makes: its processing window, or the
 *  whole source. The end is the source's exact duration (see
 *  `clipSourceEdgeSec`), so no tail is lost to rounding. */
export function wholeSourceWindow(
  pack: { processingStartSec: number | null; processingEndSec: number | null },
  source: { durationSec: number; probeDurationSec: number | null },
) {
  const sourceEndSec = source.probeDurationSec ?? source.durationSec;
  const startSec = pack.processingStartSec ?? 0;
  return { startSec, endSec: Math.min(pack.processingEndSec ?? sourceEndSec, sourceEndSec) };
}

/** Why a whole-source window can't become a clip, or null when it can. */
export function wholeSourceWindowFault(window: { startSec: number; endSec: number }): "whole_source_too_short" | "whole_source_too_long" | null {
  const durationSec = window.endSec - window.startSec;
  if (durationSec < WHOLE_SOURCE_CLIP_MIN_DURATION_SEC) return "whole_source_too_short";
  return clipDurationWithinBounds(durationSec, true, 0) ? null : "whole_source_too_long";
}

/** The shape of a boundaries request. Duration limits depend on the clip, so
 *  Clip Editor Document Persistence applies `clipDurationBounds`. */
export const updateClipBoundariesSchema = z
  .object({
    startSec: z.number().nonnegative(),
    endSec: z.number().nonnegative(),
  })
  .refine((data) => data.endSec > data.startSec, {
    message: "endSec must be greater than startSec",
  });

export const updateClipTranscriptSliceSchema = z.object({
  transcriptSlice: z.array(transcriptUtteranceSchema),
});

/**
 * "Create clip" from a transcript-panel.tsx selection (vizard-parity.md
 * Phase B step 14). Deliberately does NOT enforce `CLIP_MIN_DURATION_SEC`/
 * `CLIP_MAX_DURATION_SEC` the way `updateClipBoundariesSchema` does — a
 * selection shorter than the minimum is a valid request here (the service's
 * `planCreateClipFromSelection` expands it, word-snapped, rather than
 * rejecting it; Vizard creates a clip from even a short selection).
 */
export const createClipFromSelectionSchema = z
  .object({
    startSec: z.number().nonnegative(),
    endSec: z.number().nonnegative(),
  })
  .refine((data) => data.endSec > data.startSec, {
    message: "endSec must be greater than startSec",
  });

/** Max length of a user- or AI-authored clip title. Titles are display-only
 *  (row header, studio top bar, social caption seed) — this is a sanity bound
 *  on a single line of text, not a platform limit. */
export const CLIP_TITLE_MAX_LENGTH = 120;

export const updateClipTitleSchema = z.object({
  // Trimmed before length checks so " " isn't a valid title. Never nullable:
  // clearing a title back to null would drop the row header to the raw hook
  // text with no way to tell "no title" from "titled the same as the hook".
  title: z.string().trim().min(1).max(CLIP_TITLE_MAX_LENGTH),
});

/** How many alternative titles the AI rename offers. Three fits the popover
 *  without scrolling and is cheap enough for a single-shot completion. */
export const CLIP_TITLE_SUGGESTION_COUNT = 3;

export const clipTitleSuggestionsLlmResponseSchema = z.object({
  titles: z
    .array(z.string().trim().min(1).max(CLIP_TITLE_MAX_LENGTH))
    .min(1)
    .max(CLIP_TITLE_SUGGESTION_COUNT),
});

export const clipTitleSuggestionsResponseSchema = z.object({
  titles: z.array(z.string().min(1)),
});

export const triggerClipRenderSchema = z.object({
  clipIds: z.array(z.string().uuid()).min(1).max(50).optional(),
  aspectRatios: z.array(clipAspectRatioSchema).min(1).max(4).optional(),
  /** Requested export resolution. Defaults to "1080p" — the service clamps
   *  this down to "720p" when the owner's tier lacks the "export.1080p"
   *  entitlement rather than rejecting the request (freemium UX: ask for the
   *  best available, get the best you're entitled to). */
  resolution: clipRenderResolutionSchema.default("1080p"),
});

export const clipDownloadQuerySchema = z.object({
  aspectRatio: clipAspectRatioSchema.optional(),
});

// Snake_case shape matching the raw LLM/JSON-schema layer (CLIP_DETECTION_JSON_SCHEMA
// in apps/worker/src/tasks/detect-clips.ts uses at_sec/query/reason), which is
// NOT the same shape as brollCuesArraySchema (camelCase atSec) below —
// normalizeLlmClip maps at_sec -> atSec once parsed, producing the canonical
// camelCase BrollCue shape used everywhere past this LLM response boundary.
// Deliberately lenient (no upper bound on string length or array size) beyond
// what OpenAI's strict-mode JSON schema requires: brollCuesArraySchema already
// re-validates the normalized cues downstream (apps/worker/src/tasks/clip-render-attempt.ts)
// and degrades gracefully to the keyword-derived query on failure, so this layer
// should never be the reason a whole clip gets dropped over an oversized B-roll field.
const clipDetectionBrollCueSchema = z.object({
  at_sec: z.number().min(0),
  query: z.string().trim().min(1),
  reason: z.string().trim().min(1),
});

export const clipDetectionLlmResponseSchema = z.object({
  clips: z.array(
    z.object({
      title: z.string().min(1),
      start_time: z.number().nonnegative(),
      end_time: z.number().nonnegative(),
      hook_text: z.string().min(1),
      payoff_text: z.string().min(1),
      reasoning: z.string().min(1),
      category: clipCategorySchema,
      platform_fit: z.array(clipPlatformTargetSchema).min(1),
      hook_strength: z.number().int().min(1).max(100),
      emotional_intensity: z.number().int().min(1).max(100),
      story_completeness_score: z.number().int().min(1).max(100),
      // Required (not .optional()) because OpenAI `strict: true` requires every
      // property to be listed in the JSON schema's `required` array — but the
      // array itself is allowed to be empty for a pure talking-head clip.
      broll_cues: z.array(clipDetectionBrollCueSchema),
    }),
  ),
});

export type ClipCategory = z.infer<typeof clipCategorySchema>;
export type ClipStatus = z.infer<typeof clipStatusSchema>;
export type ClipRenderStatus = z.infer<typeof clipRenderStatusSchema>;
export type ClipAspectRatio = z.infer<typeof clipAspectRatioSchema>;
export type ClipAspectRatioDb = z.infer<typeof clipAspectRatioDbSchema>;
export type ClipRenderVariant = z.infer<typeof clipRenderVariantSchema>;
export type ClipRenderResolution = z.infer<typeof clipRenderResolutionSchema>;
export type ClipSnapshot = z.infer<typeof clipSnapshotSchema>;
export type UpdateClipBoundaries = z.infer<typeof updateClipBoundariesSchema>;
export type TriggerClipRender = z.infer<typeof triggerClipRenderSchema>;
export type ClipDownloadQuery = z.infer<typeof clipDownloadQuerySchema>;
export type ClipDetectionLlmResponse = z.infer<
  typeof clipDetectionLlmResponseSchema
>;
export type UpdateClipTitle = z.infer<typeof updateClipTitleSchema>;
export type ClipTitleSuggestionsResponse = z.infer<
  typeof clipTitleSuggestionsResponseSchema
>;
export type UpdateClipCaptionPreset = z.infer<typeof updateClipCaptionPresetSchema>;
export type ApplyCaptionPresetToAll = z.infer<typeof applyCaptionPresetToAllSchema>;
export type UpdateClipTranscriptSlice = z.infer<typeof updateClipTranscriptSliceSchema>;
export type UpdateClipBroll = z.infer<typeof updateClipBrollSchema>;
export type CreateClipFromSelection = z.infer<typeof createClipFromSelectionSchema>;
export type BrollSearchQuery = z.infer<typeof brollSearchQuerySchema>;


export const regenerateClipsRequestSchema = z.object({
  contentPack: contentPackSchema,
}).strict();
export type RegenerateClipsRequest = z.infer<typeof regenerateClipsRequestSchema>;

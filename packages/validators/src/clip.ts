import { z } from "zod";
export {
  captionAnimationSchema,
  captionPresetSchema,
  type CaptionAnimation,
  type CaptionPreset,
} from "./caption-preset";
import { brollCuesArraySchema } from "./broll";
import { captionPresetSchema } from "./caption-preset";
import { clipPlatformTargetSchema } from "./content-pack";
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
  // "accepted"/"rejected" are legacy-only: the accept/reject feature was
  // removed (market parity — Vizard has no curation gate), but rows written
  // before the removal may still carry these values, so parsing must
  // tolerate them. Nothing sets them anymore.
  "accepted",
  "rejected",
  "edited",
]);

export const clipRenderStatusSchema = z.enum([
  "pending",
  "rendering",
  "completed",
  "failed",
]);

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

export const clipRenderVariantSchema = z.object({
  aspectRatio: clipAspectRatioSchema,
  status: clipRenderStatusSchema,
  sizeBytes: z.number().nullable(),
  durationSec: z.number().nullable(),
  errorCode: z.string().nullable(),
  completedAt: z.string().datetime().nullable(),
  hasAsset: z.boolean(),
});

export const clipSnapshotSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
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

/** Shortest a clip's [startSec, endSec) window may ever be — enforced by the
 *  legacy boundaries endpoint (`updateClipBoundariesSchema` below) and reused
 *  by the in-studio trim path (vizard-parity.md Phase B step 13:
 *  `saveClipEditorDocument`'s boundary-change validation, plus the client's
 *  drag-guard on the trim handles) so the two paths can never disagree about
 *  how short a clip is allowed to get. */
export const CLIP_MIN_DURATION_SEC = 10;
/** Longest a clip's [startSec, endSec) window may ever be — enforced by the
 *  legacy boundaries endpoint (below) AND by in-studio trim (vizard-parity.md
 *  Phase B closing review finding 3): trim handles clamp to this ceiling
 *  client-side (timeline.tsx's `TrimHandle`) exactly the way they already
 *  clamp to `CLIP_MIN_DURATION_SEC`, since the server now rejects a
 *  boundary-changing save that exceeds it the same as this endpoint does. */
export const CLIP_MAX_DURATION_SEC = 120;

export const updateClipBoundariesSchema = z
  .object({
    startSec: z.number().nonnegative(),
    endSec: z.number().nonnegative(),
  })
  .refine((data) => data.endSec > data.startSec, {
    message: "endSec must be greater than startSec",
  })
  .refine((data) => data.endSec - data.startSec >= CLIP_MIN_DURATION_SEC, {
    message: `Clip must be at least ${CLIP_MIN_DURATION_SEC} seconds`,
  })
  .refine((data) => data.endSec - data.startSec <= CLIP_MAX_DURATION_SEC, {
    message: `Clip must be at most ${CLIP_MAX_DURATION_SEC} seconds`,
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
// re-validates the normalized cues downstream (apps/worker/src/tasks/render-clips.ts)
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

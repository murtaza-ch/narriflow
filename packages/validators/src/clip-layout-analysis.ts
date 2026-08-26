import { z } from "zod";
import { clipAutoLayoutSegmentSchema } from "./clip-auto-layout-analysis";
import { deletedRangesSchema } from "./edit-ranges";

/**
 * Identity-complete Screen composition evidence stored on
 * `Clip.layoutAnalysis`. The worker persists only conclusive analysis; an
 * unavailable analysis is represented by the separate typed failure envelope
 * so it remains distinguishable and retryable. Studio and export feed the
 * same parsed evidence into the shared composition planner. Unknown or
 * incomplete data parses as absent and is recomputed.
 */
export const clipLayoutAnalysisPipRectSchema = z.object({
  /** Normalized 0..1 against the source frame — same contract as
   *  `screen-layout.ts`'s `PipRect`. */
  x: z.number().finite().min(0).max(1),
  y: z.number().finite().min(0).max(1),
  w: z.number().finite().gt(0).max(1),
  h: z.number().finite().gt(0).max(1),
});

export type ClipLayoutAnalysisPipRect = z.infer<
  typeof clipLayoutAnalysisPipRectSchema
>;

const clipLayoutAnalysisBaseSchema = z.object({
  /** ISO timestamp of when the worker ran this analysis pass — lets a
   *  future re-analysis policy (e.g. "re-run if older than N days") compare
   *  against it without needing a separate column. */
  analyzedAtISO: z.string(),
  /** Source-time window `pip_detect.py` actually sampled — same
   *  `startSec`/`durationSec` coordinates `detectPipPath` passes it
   *  (render-clips.ts), NOT clip-relative. This is the SNAPPED render
   *  window (`resolveRenderTimingForClip`'s output), not the raw
   *  `Clip.startSec`/`endSec` row — see `clipStartSec`/`clipEndSec` below
   *  for the raw pair the studio preview actually has available to compare
   *  against. */
  sourceStartSec: z.number().finite().min(0),
  sourceDurationSec: z.number().finite().gt(0),
  /** H2 (adversarial review): the RAW `Clip.startSec`/`Clip.endSec` row
   *  values at write time — deliberately NOT the snapped
   *  `sourceStartSec`/`sourceDurationSec` pair above, since the studio
   *  preview only ever has the clip's own raw boundary window
   *  (`clipWindow`/`doc.clipStartSec`/`doc.clipEndSec` in studio-shell.tsx)
   *  to compare against, with no way to recompute
   *  `resolveRenderTimingForClip`'s snapping client-side. The preview nulls
   *  the rect when these disagree with its current clip window (past a
   *  small epsilon) — the same "envelope's own window is its invalidation"
   *  contract `layoutAnalysisMatchesWindow` already gives the render path,
   *  just checked against a DIFFERENT pair of fields because the preview
   *  and the render path have different windows available to them. */
  clipStartSec: z.number().finite().min(0),
  clipEndSec: z.number().finite(),
  /** `pip_detect.py`'s raw motion-classification signal, or `null` iff
   *  `insufficientSamples` is true — see this module's doc comment. */
  movingPxFrac: z.number().finite().min(0).max(1).nullable(),
  insufficientSamples: z.boolean(),
  /** Selected candidate before the confirmation gate; null means none. */
  pipRect: clipLayoutAnalysisPipRectSchema.nullable(),
  /** Whether the candidate passed the clip-level Screen confirmation gates. */
  pipUsable: z.boolean(),
});

/** Identity-complete Screen composition evidence shared by Studio and export. */
export const clipLayoutAnalysisV2Schema = clipLayoutAnalysisBaseSchema.extend({
  version: z.literal(2),
  engine: z.literal("screen-layout-v1"),
  sourceIdentity: z.string().min(1),
  inputFingerprint: z.string().regex(/^[0-9a-f]{16}$/),
  sourceWidth: z.number().int().positive(),
  sourceHeight: z.number().int().positive(),
  deletedRanges: deletedRangesSchema,
  faceBandSegments: z
    .array(clipAutoLayoutSegmentSchema)
    .min(1)
    .max(64)
    .nullable(),
});

export const clipLayoutAnalysisSchema = clipLayoutAnalysisV2Schema;

export const clipLayoutAnalysisFailureSchema = z.object({
  version: z.literal(2),
  engine: z.literal("screen-layout-v1"),
  state: z.literal("failed"),
  sourceIdentity: z.string().min(1),
  inputFingerprint: z.string().regex(/^[0-9a-f]{16}$/),
  analyzedAtISO: z.string().datetime(),
  reason: z.enum([
    "broll_conflict",
    "analysis_unavailable",
    "detection_unavailable",
    "no_face_detected",
    "no_trustworthy_faces",
  ]),
});

export type ClipLayoutAnalysis = z.infer<typeof clipLayoutAnalysisSchema>;
export type ClipLayoutAnalysisV2 = z.infer<typeof clipLayoutAnalysisV2Schema>;
export type ClipLayoutAnalysisFailure = z.infer<
  typeof clipLayoutAnalysisFailureSchema
>;
export type ClipLayoutAnalysisOutcome =
  | ClipLayoutAnalysis
  | ClipLayoutAnalysisFailure;

/**
 * Parse-tolerant read of a stored `Clip.layoutAnalysis` value: `null`/
 * `undefined` (never analyzed), a malformed value, or an envelope with an
 * unrecognized `version` all resolve to `null` rather than throwing —
 * callers (render path, studio preview, `getClipEditorDocument`) treat all
 * three identically as "no analysis to use," the same null-safe idiom
 * `captionPreset`/`studioEdits` already use elsewhere in this package
 * (`X.safeParse(raw).data ?? fallback`).
 */
export function parseClipLayoutAnalysis(
  value: unknown,
): ClipLayoutAnalysis | null {
  if (value === null || value === undefined) return null;
  const result = clipLayoutAnalysisSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseClipLayoutAnalysisFailure(
  value: unknown,
): ClipLayoutAnalysisFailure | null {
  if (value === null || value === undefined) return null;
  const result = clipLayoutAnalysisFailureSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseClipLayoutAnalysisOutcome(
  value: unknown,
): ClipLayoutAnalysisOutcome | null {
  return parseClipLayoutAnalysis(value) ?? parseClipLayoutAnalysisFailure(value);
}

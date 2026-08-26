import { z } from "zod";
import { clipAutoLayoutSegmentSchema } from "./clip-auto-layout-analysis";
import { deletedRangesSchema } from "./edit-ranges";

/**
 * Screen-mode layout analysis (vizard-parity.md element-segmentation spike,
 * landed fc5acb1 — `apps/worker/src/tasks/screen-layout.ts`'s
 * `classifyScreencast`/`selectPipRect` and `apps/worker/scripts/
 * pip_detect.py`). This is the versioned, PERSISTED envelope stored on
 * `Clip.layoutAnalysis` — deliberately NOT the raw `pip_detect.py` output
 * shape (`movingPxFrac`/`insufficientSamples`/`candidates: PipCandidate[]`):
 * only the SELECTED rect (`selectPipRect`'s output, after the corner/fill/
 * merge gates) is durable; the intermediate candidate list is analysis-time
 * scratch that the render path and studio preview never need.
 *
 * Written by the worker's analysis pass (packet B); consumed by the render
 * path (skip re-detection per render/output) and the studio preview (show
 * the true facecam crop instead of a face-centered band guess).
 *
 * Two DISTINCT "nothing here" states, both real and both must be
 * distinguished by callers:
 *   - `Clip.layoutAnalysis` column itself is `null`: never analyzed (the
 *     worker hasn't run the pass yet, or it errored/was unavailable —
 *     no python/opencv/numpy, same as `detectPipPath`'s own null-on-failure
 *     contract in render-clips.ts).
 *   - A non-null envelope with `pipRect: null`: `selectPipRect` itself found
 *     no qualifying candidate at all, or the clip wasn't screencast-like
 *     enough to attempt selection (`classifyScreencast` rejected it, or
 *     `insufficientSamples`) — `movingPxFrac`/`insufficientSamples` still
 *     describe what was measured. Note this is narrower than "not usable
 *     for this render": a NON-null `pipRect` does NOT by itself mean a
 *     render actually used it — see `pipUsable`'s own doc comment below.
 *
 * `movingPxFrac`/`insufficientSamples` mirror `pip_detect.py`'s own
 * "null movingPxFrac iff insufficientSamples" contract (a short/sparse
 * sample window is "couldn't tell," never a misleadingly precise 0.0), but
 * that pairing is NOT schema-enforced here — this envelope just carries
 * whatever the worker measured; the pairing invariant lives at the
 * producer (screen-layout.ts / render-clips.ts's `detectPipPath`), not at
 * the persistence boundary.
 *
 * `pipUsable` (adversarial review, C1): added alongside a persistence
 * consumer (the studio preview, video-preview.tsx) that must NEVER show a
 * measured false positive as if it were a confirmed facecam crop.
 * `selectPipRect`'s output alone is PRE-GATE — `render-clips.ts`'s
 * `decidePipUsage` still has to run `classifyScreencast`,
 * `confirmsFaceInRect`, and (per-output) `pipCropTooSmall` before a rect is
 * actually trustworthy. `pipUsable` is `true` iff the CLIP-LEVEL
 * `decidePipUsage` gate chain (every gate except the per-output-only
 * `pip_too_small`) passed for THIS analysis pass's `pipRect` at write time.
 * Consumers that must not render a false-positive crop (the preview) gate
 * on `pipUsable === true`, never on `pipRect !== null` alone — see that
 * field's own doc comment for why `pipRect` stays populated even when
 * `pipUsable` is `false`.
 *
 * `pipUsable` is REQUIRED (not optional, no default): an envelope written
 * before this field existed has no way to retroactively know its own
 * `pipUsable`, so it must fail `clipLayoutAnalysisSchema`'s parse entirely
 * rather than silently guess `true` or `false`. That failure is
 * deliberately self-healing, not a migration hazard — `parseClipLayoutAnalysis`'s
 * safeParse turns the parse failure into `null`, which the render path's
 * read-before-detect branch (render-clips.ts) treats identically to "never
 * analyzed": it just re-runs `pip_detect.py` on the clip's next render and
 * immediately re-persists a `pipUsable`-carrying envelope. No backfill
 * needed for the pre-existing rows this lands alongside.
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

/**
 * Version 1 of the persisted envelope. `version` is a literal so
 * `clipLayoutAnalysisSchema`'s parse (and therefore
 * `parseClipLayoutAnalysis`'s safeParse) FAILS outright on any other value —
 * the mechanism `parseClipLayoutAnalysis` relies on to treat an unknown
 * future version as absent rather than guessing at a shape it was never
 * validated against. Add a `clipLayoutAnalysisV2Schema` and switch this
 * export to `z.discriminatedUnion("version", [v1, v2])` if a second version
 * is ever needed — do not mutate v1's shape in place.
 */
export const clipLayoutAnalysisV1Schema = z.object({
  version: z.literal(1),
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
  /** The SELECTED rect (`selectPipRect`'s output, PRE-GATE) — `null` means
   *  `selectPipRect` itself found no qualifying candidate (or the clip
   *  wasn't screencast-like enough to attempt selection at all). A non-null
   *  `pipRect` is NOT by itself "safe to show as a confirmed facecam crop" —
   *  see `pipUsable` below, which is the field that actually answers that
   *  question. */
  pipRect: clipLayoutAnalysisPipRectSchema.nullable(),
  /** Whether `render-clips.ts`'s `decidePipUsage` clip-level gate chain
   *  (every gate except the per-output-only `pip_too_small`) passed for
   *  `pipRect` at the moment THIS analysis was written — see this module's
   *  doc comment for the full rationale (why it's required, why `pipRect`
   *  itself is never nulled just because this is `false`, and the
   *  self-healing behavior of an envelope written before this field
   *  existed). */
  pipUsable: z.boolean(),
});

/** Version 2 binds the analysis to the exact composition inputs and carries
 * the bounded face-band fallback used by both Studio and export. Version 1
 * remains readable by the worker as a PiP-detection cache, but it is not
 * identity-complete enough to be exact composition evidence. */
export const clipLayoutAnalysisV2Schema = clipLayoutAnalysisV1Schema.extend({
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

export const clipLayoutAnalysisSchema = z.discriminatedUnion("version", [
  clipLayoutAnalysisV1Schema,
  clipLayoutAnalysisV2Schema,
]);

export type ClipLayoutAnalysis = z.infer<typeof clipLayoutAnalysisSchema>;
export type ClipLayoutAnalysisV2 = z.infer<typeof clipLayoutAnalysisV2Schema>;

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

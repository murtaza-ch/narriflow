/**
 * Screen composition analysis and geometry. The worker measures PiP motion,
 * validates facecam candidates, and supplies identity-bound evidence to the
 * shared Clip Composition Plan. FFmpeg geometry is compiled only by the plan
 * adapter; this module does not expose an alternate renderer.
 */
import type { FaceSample } from "./reframe";

/** One `pip_detect.py` candidate region — a connected component of the
 *  thresholded motion map. All of `x`/`y`/`w`/`h`/`areaFrac` are normalized
 *  0..1 against the (downscaled, but aspect-preserving — see the script's
 *  own doc comment) analysis frame, which is numerically identical to
 *  normalizing against the source frame. `cornerAdjacent`/`areaFrac` are
 *  exactly the structural prior `selectPipRect` filters on; `medianDiffMean`
 *  is reported but not currently consumed by selection (available for
 *  future tie-breaking/debugging). */
export interface PipCandidate {
  x: number;
  y: number;
  w: number;
  h: number;
  areaFrac: number;
  /** M1 (adversarial review): pixel area / bbox area — how densely the
   *  thresholded motion blob fills its own bounding box. `selectPipRect`
   *  requires this alongside `cornerAdjacent`/`areaFrac`: a low-fill bbox
   *  (a sparse scatter of motion, an L-shape) is a much weaker PiP signal
   *  than a dense, mostly-filled rectangle even at the same `areaFrac`. */
  fillFrac: number;
  cornerAdjacent: boolean;
  medianDiffMean: number;
}

/** A selected PiP rectangle normalized 0..1 against the source frame.
 *  The shared composition planner fits it to each target tile. */
export interface PipRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Startup-frozen classification threshold for `classifyScreencast`.
 *  Production passes `RenderConfig.pipMotionThreshold`, parsed from
 *  `WORKER_PIP_MOTION_THRESHOLD`; direct callers fall back to the packet's
 *  PROXY-calibrated default.
 *
 *  H1 (adversarial review): the original spike/landing-note default (0.25)
 *  was calibrated against RAW source files, but production always runs
 *  `pip_detect.py` against `extractFaceDetectionSegment`'s 360p CRF-30
 *  ultrafast proxy, never the raw file, whenever the source is an HTTP(S)
 *  presigned URL (the common case). Recalibrated through that SAME proxy
 *  (`apps/worker/scripts/pip_calibrate.sh`, run over the 7 synthetic
 *  screencast fixtures + the real talking-head control `jensen-0-90.mp4` —
 *  see `docs/plans/vizard-parity.md`'s landed note for the full raw-vs-proxy
 *  table): proxy `movingPxFrac` measured 0.0000-0.0509 across all 7
 *  screencast fixtures and 0.2726-0.5514 for jensen (window-length
 *  dependent) — a clean >5x separation between the worst-case screencast
 *  fixture and the worst-case (lowest) jensen measurement, comfortably over
 *  this packet's 2x bar for keeping the feature default-ON. The default is
 *  the geometric mean of those two boundary values
 *  (sqrt(0.0509 * 0.2726) ≈ 0.118, rounded to 0.12) — equidistant (in log
 *  space) from both, rather than either boundary itself. Production callers
 *  pass the startup-frozen RenderConfig value explicitly. */
const DEFAULT_PIP_MOTION_THRESHOLD = 0.12;

/**
 * Classifies a clip as screencast-like (a facecam PiP is even plausible)
 * from `pip_detect.py`'s `movingPxFrac` signal. Below `threshold` (default:
 * the proxy-calibrated 0.12)
 * means most of the
 * frame is NOT continuously moving frame-to-frame — the signature of a
 * mostly-static screen/slide with at most a small moving facecam region, as
 * opposed to a regular talking-head video where the subject (and often the
 * background) is in motion across most of the frame most of the time. MUST
 * gate `selectPipRect` at the call site — see this module's doc comment for
 * the measured false-positive this classifier exists to prevent (a hand
 * gesture near the frame edge in a talking-head video "looks like" a
 * corner-adjacent compact motion blob on its own).
 */
export function classifyScreencast(
  movingPxFrac: number,
  threshold: number = DEFAULT_PIP_MOTION_THRESHOLD,
): boolean {
  return movingPxFrac < threshold;
}

/** Acceptance window for a PiP candidate's frame-area share — the spike's
 *  synthetic facecam fixtures measured ~2-6%; widened here to 0.5%-15% to
 *  give real-world facecam sizes (which vary more than a spike's controlled
 *  fixtures) room without accepting either noise specks or a near-half-frame
 *  blob that's clearly not an overlay. */
const PIP_MIN_AREA_FRAC = 0.005;
const PIP_MAX_AREA_FRAC = 0.15;

/** M1 (adversarial review): minimum `fillFrac` (pixel area / bbox area) a
 *  candidate must have to qualify — a low-fill bbox (a sparse scatter of
 *  motion, an L-shape formed by e.g. a face plus a separate hand blob near
 *  the same edge) is a much weaker "this bbox IS a facecam" signal than a
 *  dense, mostly-filled rectangle even at an identical `areaFrac`. */
const PIP_MIN_FILL_FRAC = 0.35;

/** M1 (adversarial review): two corner-qualifying candidates are treated as
 *  ONE physical region (and their bboxes unioned) when they overlap at all
 *  OR sit within this fraction of the frame of each other — a real facecam
 *  frequently thresholds into more than one connected component (a bright
 *  face + a dimmer shoulder/background-bezel edge, separated by a thin gap
 *  the morphological close in `pip_detect.py` didn't fully bridge), and
 *  treating those as competing candidates instead of one region both
 *  under-counts the true overlay's area/fill and risks the smaller half
 *  losing to an unrelated blob. */
const PIP_MERGE_GAP_FRAC = 0.02;

interface NormalizedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function rectIoU(a: NormalizedRect, b: NormalizedRect): number {
  const ix0 = Math.max(a.x, b.x);
  const iy0 = Math.max(a.y, b.y);
  const ix1 = Math.min(a.x + a.w, b.x + b.w);
  const iy1 = Math.min(a.y + a.h, b.y + b.h);
  const iw = Math.max(0, ix1 - ix0);
  const ih = Math.max(0, iy1 - iy0);
  const inter = iw * ih;
  if (inter <= 0) return 0;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/** Gap between two axis-aligned rects (0 when they overlap or touch) — the
 *  larger of the horizontal/vertical separation, i.e. how far apart they'd
 *  need to move on their WORST axis to stop being close, not a Euclidean
 *  distance (cheap, and the exact metric doesn't matter at these small
 *  thresholds — see `PIP_MERGE_GAP_FRAC`'s doc comment for why "close on
 *  both axes" is the intent). */
function rectGap(a: NormalizedRect, b: NormalizedRect): number {
  const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w));
  const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h));
  return Math.max(dx, dy);
}

function rectUnion(a: NormalizedRect, b: NormalizedRect): NormalizedRect {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w);
  const y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

interface MergedPipGroup {
  rect: NormalizedRect;
  /** Sum of each merged-in candidate's own pixel-area share of the frame
   *  (`areaFrac * fillFrac`) — used both as the weight for the merged
   *  group's motion-strength average and (implicitly) to prefer denser
   *  merges; NOT the same as `rect.w * rect.h` (the union bbox's own area,
   *  which can only grow on a merge and is never used as a selection
   *  signal itself — only as the tiebreak, see `selectPipRect`). */
  pixelAreaFrac: number;
  /** Sum of each merged-in candidate's `medianDiffMean * ownPixelAreaFrac`
   *  — divide by `pixelAreaFrac` for the merged group's pixel-area-weighted
   *  mean motion strength. */
  weightedDiffSum: number;
}

/** M1 (adversarial review): iteratively unions any two qualifying
 *  candidates that overlap (IoU > 0) or sit within `PIP_MERGE_GAP_FRAC` of
 *  each other, until no more pairs qualify (fixpoint — a chain of 3+
 *  candidates each close to its neighbor but not to the ends still merges
 *  into one group). O(n^2) per pass; `n` here is a handful of connected
 *  components, never a real cost concern. */
function mergeQualifyingPipCandidates(candidates: PipCandidate[]): MergedPipGroup[] {
  const groups: MergedPipGroup[] = candidates.map((c) => {
    const pixelAreaFrac = c.areaFrac * c.fillFrac;
    return {
      rect: { x: c.x, y: c.y, w: c.w, h: c.h },
      pixelAreaFrac,
      weightedDiffSum: c.medianDiffMean * pixelAreaFrac,
    };
  });

  let mergedAny = true;
  while (mergedAny) {
    mergedAny = false;
    outer: for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const a = groups[i]!;
        const b = groups[j]!;
        if (rectIoU(a.rect, b.rect) > 0 || rectGap(a.rect, b.rect) < PIP_MERGE_GAP_FRAC) {
          const merged: MergedPipGroup = {
            rect: rectUnion(a.rect, b.rect),
            pixelAreaFrac: a.pixelAreaFrac + b.pixelAreaFrac,
            weightedDiffSum: a.weightedDiffSum + b.weightedDiffSum,
          };
          // Remove the higher index first so the lower index's splice
          // doesn't shift it out from under the second splice.
          groups.splice(j, 1);
          groups.splice(i, 1);
          groups.push(merged);
          mergedAny = true;
          break outer;
        }
      }
    }
  }
  return groups;
}

/**
 * Selects the facecam PiP rectangle from `pip_detect.py`'s candidate list,
 * or `null` when none qualify.
 *
 * M1 (adversarial review): this used to pick the SMALLEST corner-adjacent,
 * in-bounds-area candidate outright, and its own doc comment claimed that
 * was "spike-validated" — it wasn't. The spike validated the corner-
 * adjacent + compact-size STRUCTURAL PRIOR (rejecting a large non-corner
 * embedded-video blob, IoU 0.000 against the real facecam); it never
 * measured "prefer the smallest of several qualifying candidates" as a
 * selection rule on its own, and smallest-wins has an obvious failure mode
 * a real facecam commonly hits: thresholding into 2+ disconnected
 * components (see `PIP_MERGE_GAP_FRAC`'s doc comment) means the smallest
 * FRAGMENT of the real overlay can beat an unrelated, fully-intact but
 * larger noise blob purely by being smaller.
 *
 * Current policy: filter to candidates that are corner-adjacent (see
 * `pip_detect.py`'s `CORNER_MARGIN`/`CORNER_EXTENT_MAX_FRAC`), within
 * `[minAreaFrac, maxAreaFrac]` of the frame area, and at least
 * `minFillFrac` dense within their own bbox (M1's `fillFrac` gate) — then
 * MERGE overlapping/adjacent qualifying candidates into single regions
 * (`mergeQualifyingPipCandidates`) before picking, so a real facecam that
 * thresholded into pieces competes as one region, not several weaker ones.
 * Among the merged groups, pick the one with the HIGHEST pixel-area-
 * weighted mean `medianDiffMean` (motion strength: a facecam is
 * continuously moving, so the group most densely lit up by the motion
 * threshold is the more likely genuine overlay), with the SMALLEST merged
 * bbox area as the tiebreak (a tighter box around the same motion strength
 * is still the more overlay-shaped candidate).
 *
 * Deliberately does NOT apply `classifyScreencast` itself — see this
 * module's doc comment for why that gate belongs at the call site (this
 * function has no way to know the clip's overall `movingPxFrac`, only the
 * candidate list).
 */
export function selectPipRect(
  candidates: PipCandidate[],
  opts?: { minAreaFrac?: number; maxAreaFrac?: number; minFillFrac?: number },
): PipRect | null {
  const minAreaFrac = opts?.minAreaFrac ?? PIP_MIN_AREA_FRAC;
  const maxAreaFrac = opts?.maxAreaFrac ?? PIP_MAX_AREA_FRAC;
  const minFillFrac = opts?.minFillFrac ?? PIP_MIN_FILL_FRAC;
  const qualifying = candidates.filter(
    (c) =>
      c.cornerAdjacent &&
      c.areaFrac >= minAreaFrac &&
      c.areaFrac <= maxAreaFrac &&
      c.fillFrac >= minFillFrac,
  );
  if (qualifying.length === 0) return null;

  const merged = mergeQualifyingPipCandidates(qualifying);
  const best = merged.reduce((best, g) => {
    const gDiff = g.pixelAreaFrac > 0 ? g.weightedDiffSum / g.pixelAreaFrac : 0;
    const bestDiff = best.pixelAreaFrac > 0 ? best.weightedDiffSum / best.pixelAreaFrac : 0;
    if (gDiff !== bestDiff) return gDiff > bestDiff ? g : best;
    const gArea = g.rect.w * g.rect.h;
    const bestArea = best.rect.w * best.rect.h;
    return gArea < bestArea ? g : best;
  });

  return { x: best.rect.x, y: best.rect.y, w: best.rect.w, h: best.rect.h };
}

/** H2 (adversarial review): minimum share of ALL samples that must actually
 *  carry a detected face before face-confirmation can even be attempted —
 *  guards against a short/sparse sample list producing a misleadingly
 *  confident "confirmed" or "rejected" verdict off of one or two lucky/
 *  unlucky detections. */
const PIP_FACE_CONFIRM_MIN_SAMPLE_SHARE = 0.25;

/** H2 (adversarial review): minimum share of FACE-BEARING samples whose
 *  detected face center must fall inside the candidate `pipRect` before the
 *  rect is trusted to actually contain a face. */
const PIP_FACE_CONFIRM_MIN_INSIDE_SHARE = 0.6;

/**
 * H2 (adversarial review): confirms a candidate `pipRect` actually contains
 * a face before `decidePipUsage` (render-clips.ts) is allowed to prefer it
 * over the existing band fallback. Motion segmentation alone has a MEASURED
 * false positive on real talking-head footage — a hand gesture near the
 * frame edge reads as a corner-adjacent, compact, dense motion blob just
 * like a genuine facecam overlay does (see this module's top doc comment).
 * Requires BOTH: (a) faces were found in at least
 * `PIP_FACE_CONFIRM_MIN_SAMPLE_SHARE` of ALL samples (not just the face-
 * bearing ones — a handful of detections out of a long, mostly-undetected
 * sample list isn't a confident signal either way), AND (b) among the
 * face-bearing samples, the detected face's horizontal center falls INSIDE
 * `pipRect`'s `[x, x+w]` span in at least `PIP_FACE_CONFIRM_MIN_INSIDE_SHARE`
 * of them. `FaceSample` (the single-face `reframe_detect.py`/`reframe.ts`
 * detection contract) carries only a normalized `cx`, no `cy` — vertical
 * containment is deliberately NOT checked here (there's nothing to check
 * it against), matching this packet's decision to accept "cx alone" when
 * that's all the shared single-face detector provides.
 */
export function confirmsFaceInRect(
  samples: FaceSample[] | null,
  pipRect: PipRect | null,
  opts?: { minSampleShare?: number; minInsideShare?: number },
): boolean {
  if (!samples || samples.length === 0 || !pipRect) return false;
  const minSampleShare = opts?.minSampleShare ?? PIP_FACE_CONFIRM_MIN_SAMPLE_SHARE;
  const minInsideShare = opts?.minInsideShare ?? PIP_FACE_CONFIRM_MIN_INSIDE_SHARE;

  const faceBearing = samples.filter(
    (s): s is FaceSample & { cx: number } => s.cx !== null,
  );
  if (faceBearing.length / samples.length < minSampleShare) return false;

  const rectX0 = pipRect.x;
  const rectX1 = pipRect.x + pipRect.w;
  const inside = faceBearing.filter((s) => s.cx >= rectX0 && s.cx <= rectX1);
  return inside.length / faceBearing.length >= minInsideShare;
}

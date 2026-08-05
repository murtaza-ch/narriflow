/**
 * Screen-share layout (vizard-parity.md Phase C-2 stage 1, "screen" framing
 * mode — screen packet B, the worker render path). Pure filtergraph-string
 * builder only — no FFmpeg execution, no Prisma, no detection; wiring lives
 * in render-clips.ts (mirrors two-up.ts's own split between pure geometry
 * here and render-clips.ts's `isScreenMode` gate).
 *
 * Composition: a static two-tile stack, TOP over BOTTOM, together exactly
 * `W x H` of the target output (see `screenTileGeometry` for the top/bottom
 * height split — NOT a plain `H/2` each; see its doc comment for why) —
 *   - TOP: the full source frame FIT (scale-to-contain + letterbox pad,
 *     never cropped) — this is the "screen" element (a shared window/slide/
 *     app) and must stay fully readable, so it can never lose any of the
 *     source frame the way a crop would.
 *   - BOTTOM: EITHER (element segmentation v1, this packet) a STATIC crop of
 *     the actual facecam picture-in-picture rectangle, when the source is
 *     screencast-like and a PiP region was located by motion segmentation
 *     (see `classifyScreencast`/`selectPipRect`/`fitPipCropToTile` below and
 *     `pip_detect.py`) — facecam overlays don't move, so this is never
 *     sendcmd-driven, just a fixed `crop` — OR (the original v1 fallback,
 *     kept byte-identical for every clip the PiP path doesn't apply to) a
 *     face-CENTERED horizontal crop of the WHOLE source frame, the exact
 *     same single-face detection `reframe.ts`'s auto-reframe path uses
 *     (`smoothFacePath` + `buildReframeSendcmdScript`), just aimed at a
 *     half-height tile instead of the full output — NOT a facecam/webcam
 *     sub-region detector, only "where in the full frame is the one
 *     detected face, horizontally." render-clips.ts's
 *     `applyScreenSpeakerLayout` sets `bottom.pipRect` when the PiP path won
 *     (wins over `reframe`/`cx` — see `ScreenSpeakerBottomSpec`'s doc
 *     comment), else builds the sendcmd script `bottom.reframe` consumes, or
 *     falls back further to a static center crop when no face is detected/
 *     detection is unavailable/the output has no lateral room to track in
 *     (see `screenBottomIsTrackable`) — never a failed render, and never a
 *     whole-clip fallback to auto-reframe the way split does — a screen
 *     clip is still valuable with a centered bottom tile, since the TOP tile
 *     is the whole point of this layout).
 *
 * H3 (adversarial review): unlike `two-up.ts`'s split layout, the two tiles
 * here are always DIFFERENT CONTENT (full-frame-fit vs. a face/PiP crop) so
 * `splitTilesAreDistinct`'s "both tiles show the identical source region"
 * failure mode can't happen here — but that is a much narrower guarantee
 * than "the bottom tile always tracks the speaker." For output aspect
 * ratios wide/square enough that the tile ratio (`tileWidth / bottomHeight`,
 * DOUBLE the output's own aspect since the tile is only part-height) demands
 * a crop at least as wide as the source has (1:1, 16:9 against a landscape
 * source), `cropXForCenter`'s `x` clamps to the same single value for every
 * possible center, so a sendcmd track driving it would be a pure no-op —
 * `screenBottomIsTrackable` is the gate `applyScreenSpeakerLayout` uses to
 * skip building that dead script and render an honest static-center bottom
 * tile instead. `screenBottomIsTrackable` is NOT consulted for the PiP path
 * (see `ScreenSpeakerBottomSpec.pipRect`'s doc comment) — `fitPipCropToTile`
 * always produces a crop that fits inside the source frame on its own.
 *
 * Element segmentation v1 (vizard-parity.md's element-segmentation spike,
 * landed 2026-08-05): `classifyScreencast`/`selectPipRect`/
 * `fitPipCropToTile` below are the pure-TS half of upgrading the BOTTOM tile
 * from "face-centered band" to "the actual facecam PiP rectangle" — the
 * Python half (`pip_detect.py`) samples ~2fps at a 320-wide grayscale
 * downscale and computes the per-pixel MEDIAN ABSOLUTE frame-to-frame
 * difference (NOT std/variance — the spike measured std getting fooled by a
 * single large-magnitude event like a slide flip inflating a pixel's
 * variance across the whole window even though it's otherwise still).
 * `movingPxFrac` (share of pixels above a small fixed noise floor)
 * classifies the WHOLE clip as screencast-like or not; a percentile-
 * thresholded connected-components pass over the same diff map produces
 * candidate regions, each flagged corner-adjacent or not. The corner-
 * adjacent + compact-size structural prior (`selectPipRect`) is NOT
 * optional polish — the spike measured naive largest-motion-blob selection
 * picking an embedded video-in-video over the real facecam (IoU 0.000) on
 * one fixture, and `classifyScreencast` gating `selectPipRect` is equally
 * load-bearing: run alone on a genuine talking-head video, the corner-blob
 * finder still "finds" something (a hand gesture near the frame edge) — a
 * measured false positive, not a hypothetical one.
 */
import type { ClipAspectRatio } from "@narriflow/validators";
import { clipAspectRatioOptions } from "@narriflow/validators";
import { cropXForCenter } from "./reframe";
import type { FaceSample } from "./reframe";
import { computeTileCrop } from "./two-up";

const aspectRatioDimensions = new Map(
  clipAspectRatioOptions.map((option) => [option.value, { width: option.width, height: option.height }]),
);

export interface ScreenTileGeometry {
  tileWidth: number;
  /** TOP tile height in px — the FIT tile. See doc comment on
   *  `screenTileGeometry` for why this isn't just `H - bottomHeight`'s twin
   *  (`Math.round(H / 2)`). */
  topHeight: number;
  /** BOTTOM (speaker) tile height in px. */
  bottomHeight: number;
  /** `tileWidth / bottomHeight` — the aspect ratio `computeTileCrop` sizes
   *  the BOTTOM tile's crop rectangle against (double the output's own
   *  aspect ratio, since the tile is only part-height). */
  tileRatio: number;
  /** BOTTOM tile crop width against `probe` — `null` when no `probe` was
   *  given (geometry-only query, e.g. just the tile heights). */
  cropW: number | null;
  /** BOTTOM tile crop height against `probe` — `null` when no `probe` was
   *  given. */
  cropH: number | null;
}

/**
 * H1 (adversarial review): the SOLE source of screen-layout tile geometry —
 * both `buildScreenSpeakerFilterChain` (below) and render-clips.ts's
 * `applyScreenSpeakerLayout` consume this instead of each re-deriving
 * tileWidth/tileHeight/tileRatio independently, which is exactly how C1's
 * odd-tile-height bug could have been half-fixed in one call site and not
 * the other with no error (ffmpeg clamps a wrong `x`, it doesn't reject it).
 *
 * C1: the two tile heights are NOT both `Math.round(H / 2)` — for 4:5
 * (1080x1350) that rounds to 675, an ODD height, and `pad`'s yuv420p output
 * floors an odd dimension to the even value below it (top tile emits
 * 1080x674 while the bottom tile, built the same way, independently emits
 * 675 since `crop`+`scale` don't have `pad`'s floor-to-even behavior) —
 * `vstack`ing 674 + 675 produces 1080x1349, which `libx264` refuses to
 * encode ("height not divisible by 2"). Instead, `bottomHeight` is forced
 * even by construction (`2 * Math.floor(H / 4)`), and `topHeight` is
 * whatever's left (`H - bottomHeight`) — since `H` itself is always even
 * (true for all four `ClipAspectRatio` output dimensions), an even number
 * minus an even number is always even too, so BOTH heights are guaranteed
 * even for every target without a per-ratio special case.
 */
export function screenTileGeometry(
  aspectRatio: ClipAspectRatio,
): { tileWidth: number; topHeight: number; bottomHeight: number; tileRatio: number; cropW: null; cropH: null };
export function screenTileGeometry(
  aspectRatio: ClipAspectRatio,
  probe: { width: number; height: number },
): { tileWidth: number; topHeight: number; bottomHeight: number; tileRatio: number; cropW: number; cropH: number };
export function screenTileGeometry(
  aspectRatio: ClipAspectRatio,
  probe?: { width: number; height: number },
): ScreenTileGeometry {
  const dims = aspectRatioDimensions.get(aspectRatio);
  if (!dims) {
    throw new Error(`screenTileGeometry: unsupported aspect ratio ${aspectRatio}`);
  }
  const { width: W, height: H } = dims;
  const tileWidth = W;
  const bottomHeight = 2 * Math.floor(H / 4);
  const topHeight = H - bottomHeight;
  if (tileWidth < 2 || topHeight < 2 || bottomHeight < 2) {
    throw new Error(
      `screenTileGeometry: degenerate tile geometry (tile ${tileWidth}x top${topHeight}/bottom${bottomHeight})`,
    );
  }
  const tileRatio = tileWidth / bottomHeight;

  if (!probe) {
    return { tileWidth, topHeight, bottomHeight, tileRatio, cropW: null, cropH: null };
  }
  if (
    !Number.isFinite(probe.width) ||
    !Number.isFinite(probe.height) ||
    probe.width < 2 ||
    probe.height < 2
  ) {
    throw new Error(
      `screenTileGeometry: degenerate source geometry (source ${probe.width}x${probe.height})`,
    );
  }
  const { cropW, cropH } = computeTileCrop(probe.width, probe.height, tileRatio);
  return { tileWidth, topHeight, bottomHeight, tileRatio, cropW, cropH };
}

/**
 * H3 (adversarial review): whether the screen-layout BOTTOM (speaker) tile
 * for this OUTPUT aspect ratio has any lateral room to track a face in at
 * all, given the source dimensions — the screen-layout analog of
 * `two-up.ts`'s `splitTilesAreDistinct`. When `computeTileCrop`'s crop width
 * equals the full source width, `cropXForCenter`'s clamp range collapses to
 * `[0, 0]`, so every possible face position maps to the identical `x`: a
 * sendcmd script driving it is a mathematically inert no-op that still
 * costs a script file and an extra filter stage, and (before this fix)
 * still logged `bottomTracking: "face"` even though nothing was actually
 * tracked. `applyScreenSpeakerLayout` calls this per output BEFORE deciding
 * whether to build a sendcmd script at all.
 */
export function screenBottomIsTrackable(
  aspectRatio: ClipAspectRatio,
  probe: { width: number; height: number },
): boolean {
  const { cropW } = screenTileGeometry(aspectRatio, probe);
  return cropW < probe.width;
}

/** FFmpeg instance name of the screen-layout bottom (speaker) crop filter,
 *  targeted by sendcmd. Deliberately its OWN name — never `REFRAME_CROP_NAME`
 *  (reframe.ts's single-speaker crop) or either of `two-up.ts`'s
 *  `TWO_UP_TOP_CROP_NAME`/`TWO_UP_BOTTOM_CROP_NAME`. `sendcmd` dispatches by
 *  filter NAME graph-wide, not per-branch (the same gotcha `two-up.ts`'s
 *  `buildTwoUpFilterChain` doc comment explains at length): reusing any of
 *  those names here would mean a command meant for THIS clip's screen-mode
 *  bottom tile could also silently retarget an unrelated crop instance (or
 *  vice versa) if both ever coexisted in one filter_complex. Per-output
 *  callers (render-clips.ts's `applyScreenSpeakerLayout`, mirroring
 *  `applyAutoReframe`) further suffix this per output index when rendering
 *  more than one aspect ratio, exactly like `REFRAME_CROP_NAME` does. */
export const SCREEN_BOTTOM_CROP_NAME = "crop@screen_speaker";

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

/** A selected/fitted PiP rectangle, normalized 0..1 against the source
 *  frame — `selectPipRect`'s output shape and `fitPipCropToTile`'s input
 *  shape (its own output is in source PIXELS, see that function's doc
 *  comment, since it's the one consumed directly by the filtergraph). */
export interface PipRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Env-configurable classification threshold for `classifyScreencast` —
 *  `WORKER_PIP_MOTION_THRESHOLD`, falling back to the packet's PROXY-
 *  calibrated default.
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
 *  this packet's 2x bar for keeping the feature default-ON. New default is
 *  the geometric mean of those two boundary values
 *  (sqrt(0.0509 * 0.2726) ≈ 0.118, rounded to 0.12) — equidistant (in log
 *  space) from both, rather than either boundary itself. Same "parse, fall
 *  back to a sane default on anything non-finite/non-positive" idiom
 *  clip-preview.ts's own env helpers (`previewPaddingSec` etc.) use. */
const DEFAULT_PIP_MOTION_THRESHOLD = 0.12;

/** L6 (adversarial review): `movingPxFrac` is always a 0..1 fraction, so a
 *  configured threshold outside `[0, 1]` can only ever be a misconfiguration
 *  — clamped here (not just parsed) so e.g. `WORKER_PIP_MOTION_THRESHOLD=2`
 *  can't silently make `classifyScreencast` accept every clip as
 *  screencast-like (any `movingPxFrac <= 1 < 2` would always pass). Values
 *  `<= 0` or non-finite still fall back to the default entirely (a
 *  clamped-to-0 threshold would have the same "accept everything" problem
 *  from the other direction). */
export function pipMotionThreshold(): number {
  const raw = Number(process.env.WORKER_PIP_MOTION_THRESHOLD?.trim());
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_PIP_MOTION_THRESHOLD;
  return Math.min(raw, 1);
}

/**
 * Classifies a clip as screencast-like (a facecam PiP is even plausible)
 * from `pip_detect.py`'s `movingPxFrac` signal. Below `threshold` (default:
 * `pipMotionThreshold()`, i.e. the env-configurable, proxy-calibrated 0.12)
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
  threshold: number = pipMotionThreshold(),
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

/** ~8% breathing-room margin applied to a selected PiP rect before fitting
 *  it to the bottom tile's aspect ratio — the motion blob traces the
 *  continuously-MOVING pixels (typically the face/upper body), which can sit
 *  slightly inside whatever border/bezel/background the facecam app itself
 *  draws around the feed; growing a little before the aspect-fit keeps that
 *  border in frame rather than cropping tight to just the moving pixels. */
const PIP_TILE_MARGIN_FRAC = 0.08;

/**
 * Expands (never crops) a selected, normalized `pipRect` into a SOURCE-PIXEL
 * crop rectangle matching `tileRatio` exactly (up to integer rounding) —
 * the bottom tile's `crop=w:h:x:y,scale=tileW:tileH` branch needs a crop
 * whose own aspect ratio already equals the tile's, since that final `scale`
 * is a plain (non-aspect-preserving) resize, exactly like every other
 * bottom-tile crop this module builds (`computeTileCrop`'s whole-frame
 * case).
 *
 * Order of operations: apply the `PIP_TILE_MARGIN_FRAC` breathing room to
 * both axes (center-preserving) FIRST, then grow only the SHORT axis around
 * the (unchanged) center to hit `tileRatio` exactly — this can only ADD area
 * relative to the detected rect, never crop any of it away. If the result
 * would exceed the source frame in either dimension, both dimensions are
 * scaled down TOGETHER (preserving `tileRatio`) until it fits — the same
 * "biggest tile-aspect rect this source can offer" contract
 * `computeTileCrop` already establishes for the whole-frame case, just
 * anchored on the PiP rect's center instead of the frame's. Finally, `x`/`y`
 * are clamped so the crop window stays fully inside the source (mirrors
 * `cropXForCenter`'s own clamp) — CONTAINMENT CONTRACT: on the non-shrink
 * path (the common case — the grown rect already fits the source), the
 * returned crop always fully CONTAINS the original detected `pipRect`
 * (never crops any of it away, by construction: growth is center-preserving
 * and only ever adds area). On the shrink-to-fit path (the source is too
 * small to hold the margin-grown, aspect-fitted rect), that containment
 * guarantee is NOT preserved — the returned crop is only guaranteed to
 * CONTAIN THE DETECTED RECT'S CENTER (`cx`/`cy` above), not its full
 * extent, since shrinking pulls every edge inward around that same center.
 *
 * L2 (adversarial review): `w`/`h` are rounded to integers FIRST, and `x`/`y`
 * are clamped against those ALREADY-ROUNDED dimensions — clamping against
 * the pre-rounding (fractional) `w`/`h` and rounding `w`/`h` separately
 * afterward (the old order) could let `x + round(w)` exceed `probe.width`
 * by up to a pixel whenever `w` rounded UP (e.g. `w` fractional 19.6,
 * `x` clamped as if the crop were only 19.6 wide, then `w` rounds to 20 —
 * `x + 20` could then land past the frame edge, which `crop` doesn't
 * reject, it just reads out of bounds).
 */
export function fitPipCropToTile(
  pipRect: PipRect,
  tileRatio: number,
  probe: { width: number; height: number },
): { x: number; y: number; w: number; h: number } {
  const cx = (pipRect.x + pipRect.w / 2) * probe.width;
  const cy = (pipRect.y + pipRect.h / 2) * probe.height;

  let w = pipRect.w * probe.width * (1 + 2 * PIP_TILE_MARGIN_FRAC);
  let h = pipRect.h * probe.height * (1 + 2 * PIP_TILE_MARGIN_FRAC);

  const currentRatio = w / h;
  if (currentRatio < tileRatio) {
    w = h * tileRatio;
  } else if (currentRatio > tileRatio) {
    h = w / tileRatio;
  }

  const shrink = Math.min(1, probe.width / w, probe.height / h);
  w *= shrink;
  h *= shrink;

  const roundedW = Math.round(w);
  const roundedH = Math.round(h);
  const x = Math.round(Math.max(0, Math.min(probe.width - roundedW, cx - roundedW / 2)));
  const y = Math.round(Math.max(0, Math.min(probe.height - roundedH, cy - roundedH / 2)));
  return { x, y, w: roundedW, h: roundedH };
}

/** M3 (adversarial review): minimum fraction of the tile's own width a
 *  `fitPipCropToTile` result must reach before it's still worth using as
 *  the bottom-tile crop. A detected PiP rect much narrower than the tile
 *  (e.g. a small facecam bubble against a wide 16:9 tile) forces
 *  `fitPipCropToTile`'s aspect-fit to grow the SHORT axis a lot relative to
 *  the ORIGINAL detected size — still geometrically valid (it never crops
 *  the detected rect away), but the final crop ends up mostly margin/
 *  background around a small subject, a worse result than the existing
 *  face-tracked/static-center band it would otherwise replace. */
const PIP_MIN_CROP_WIDTH_FRAC = 0.4;

/** Whether a `fitPipCropToTile` result is too small (relative to the output
 *  tile it would be scaled up into) to prefer over the existing band
 *  fallback — see `PIP_MIN_CROP_WIDTH_FRAC`'s doc comment. `render-clips.ts`'s
 *  `decidePipUsage` is the ordered decision matrix this feeds into (reason
 *  `pip_too_small`). */
export function pipCropTooSmall(fittedCropWidth: number, tileWidth: number): boolean {
  return fittedCropWidth < PIP_MIN_CROP_WIDTH_FRAC * tileWidth;
}

export interface ScreenSpeakerBottomSpec {
  /** Static normalized horizontal crop center (used unless `reframe`/
   *  `pipRect` is set) — the static-center fallback when no face was
   *  detected/detection is unavailable. Vertical stays centered (v1: no
   *  vertical tracking, same policy as `two-up.ts`'s tiles). */
  cx: number;
  /** Sendcmd-driven horizontal crop track (reframe.ts style) — when set (and
   *  `pipRect` is NOT set), overrides `cx` for x. `cropName` MUST be unique
   *  within the ffmpeg invocation this chain is embedded in — see
   *  `SCREEN_BOTTOM_CROP_NAME`'s doc comment. */
  reframe?: { scriptPath: string; cropName: string } | null;
  /** Element segmentation v1: a static crop of the actual facecam PiP
   *  rectangle, in SOURCE PIXELS, already fitted to this output's tile
   *  aspect ratio (`fitPipCropToTile`'s return shape) — set by
   *  render-clips.ts's `applyScreenSpeakerLayout` when the source was
   *  classified screencast-like (`classifyScreencast`) AND a PiP region was
   *  selected (`selectPipRect`). WINS OVER `reframe`/`cx` when set: a
   *  facecam overlay doesn't move within the frame, so there's no sendcmd
   *  track to build — this is a plain, static `crop`, never
   *  `screenBottomIsTrackable`-gated (that gate is about whether a
   *  *sendcmd-driven* crop has lateral room to move; `fitPipCropToTile`
   *  already guarantees its own rect fits inside the source on its own). */
  pipRect?: { x: number; y: number; w: number; h: number } | null;
}

export interface BuildScreenSpeakerFilterChainParams {
  aspectRatio: ClipAspectRatio;
  /** Source video dimensions (post any upstream probe/scale — same contract
   *  as `buildTwoUpFilterChain`'s `probe`). */
  probe: { width: number; height: number };
  bottom: ScreenSpeakerBottomSpec;
  videoInputLabel?: string;
  outputLabel?: string;
  /** Suffix appended to internal split/crop-output labels so multiple calls
   *  can coexist in one bigger filter_complex without label collisions
   *  (mirrors `buildTwoUpFilterChain`'s `labelSuffix`). */
  labelSuffix?: string;
  /** Appended after vstack, before the output label — same `[outvbase]`-
   *  style contract `buildFitAndBackgroundFilter`/`buildTwoUpFilterChain`
   *  satisfy. */
  trailingChain?: string;
}

/**
 * Builds the split=2 -> TOP fit-and-pad / BOTTOM face-crop -> vstack FFmpeg
 * filtergraph for the "screen" framing mode: one source split into two
 * branches, the top branch letterboxed (never cropped) into a `W x topHeight`
 * tile, the bottom branch cropped/scaled into a `W x bottomHeight` tile
 * around a (static or sendcmd-driven) speaker center (`screenTileGeometry`
 * decides `topHeight`/`bottomHeight` — NOT both `H/2`, see its doc comment),
 * then stacked top-over-bottom into the full `W x H` output — the same
 * `[outv]`/`[outvbase]`-style single output label contract
 * `buildFitAndBackgroundFilter`/`buildTwoUpFilterChain` satisfy.
 *
 * GOTCHA (two-up.ts spike, reapplied here): a differently-rounded crop/scale/
 * pad rectangle between the two branches emits a different SAR even for the
 * same nominal tile size (fit's `scale...decrease` rounds down to preserve
 * aspect; the bottom crop's `computeTileCrop` rounds a crop rect to the
 * source's own pixel grid) — `vstack`ing two branches with mismatched SAR is
 * exactly the class of bug `two-up.ts`'s split layout hit with `concat`.
 * BOTH branches pin `setsar=1` on their own output (not just once after
 * vstack) before the join, so this can never depend on which branch's
 * rounding happened to agree with the other's this time.
 */
export function buildScreenSpeakerFilterChain(
  params: BuildScreenSpeakerFilterChainParams,
): string[] {
  // H1 (adversarial review): geometry comes ONLY from the shared
  // `screenTileGeometry` — this used to re-derive tileHeight/tileRatio/cropW
  // independently of render-clips.ts's `applyScreenSpeakerLayout`, which is
  // exactly how C1's odd-tile-height bug could have been fixed here and not
  // there with no error (a mismatched `x` just clamps silently). It throws
  // on an unsupported aspect ratio or degenerate tile/source geometry, same
  // "throw, caller's try/catch logs ffmpeg_render_failed" contract
  // `buildSplitFilterChain`/`buildTwoUpFilterChain` already rely on.
  const { tileWidth, topHeight, bottomHeight, cropW, cropH } = screenTileGeometry(
    params.aspectRatio,
    params.probe,
  );

  const videoInputLabel = params.videoInputLabel ?? "[0:v]";
  const outputLabel = params.outputLabel ?? "[outv]";
  const suffix = params.labelSuffix ?? "";
  const topSrcLabel = `[screen_top_src${suffix}]`;
  const botSrcLabel = `[screen_bot_src${suffix}]`;
  const topOutLabel = `[screen_top${suffix}]`;
  const botOutLabel = `[screen_bot${suffix}]`;
  const trailing = params.trailingChain ? `,${params.trailingChain}` : "";

  // TOP: fit (scale-to-contain, force_divisible_by=2 for encodability) +
  // letterbox pad to the exact tile canvas, centered, black bars — the same
  // generic scale+pad idiom `buildFitAndBackgroundFilter`'s color branch
  // uses for the FULL output canvas, parameterized down to just this tile.
  // "force_original_aspect_ratio=decrease" is what makes this generic across
  // BOTH source orientations without any JS-side branching: a source wider
  // than the tile (the common landscape-screen-share case) becomes
  // width-constrained (scaled to tile width, padded top/bottom); a source
  // narrower than tall (portrait) becomes height-constrained (scaled to tile
  // height, padded left/right) — ffmpeg's `scale` filter resolves which
  // dimension is the binding constraint at run time from the actual input
  // dimensions, so this single filter chain covers both without a
  // srcRatio-vs-tileRatio branch the way `computeTileCrop` needs for a crop.
  const topFilter =
    `${topSrcLabel}scale=${tileWidth}:${topHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
    `pad=${tileWidth}:${topHeight}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1${topOutLabel}`;

  // BOTTOM: tile-aspect crop of the source (`computeTileCrop`, the same
  // geometry `two-up.ts`'s tiles use), x driven by sendcmd when a face path
  // exists, else the static center fallback. L3 (adversarial review):
  // `computeTileCrop` can never return a `cropH` greater than the source
  // height, and `cropXForCenter` already clamps its result to
  // `[0, srcHeight - cropH]` (which collapses to exactly `[0, 0]` when
  // `cropH === srcHeight`) — so the old `cropH >= height ? 0 : ...` guard
  // was dead: `cropXForCenter` returns the same `0` on its own in that case.
  const y = cropXForCenter(0.5, params.probe.height, cropH);
  let botFilter: string;
  if (params.bottom.pipRect) {
    // Element segmentation v1: a STATIC crop of the actual facecam PiP
    // rectangle — wins over `reframe`/`cx` (see `ScreenSpeakerBottomSpec.
    // pipRect`'s doc comment: a facecam overlay doesn't move, so there's no
    // sendcmd track to build, and `screenTileGeometry`'s `cropW`/`cropH`
    // (the whole-frame-centered tile crop) are irrelevant here — the rect
    // came from `fitPipCropToTile`, already fitted to THIS tile's ratio and
    // clamped inside the source frame on its own). C1-lesson discipline:
    // floor w/h to even before handing them to `crop` — belt-and-suspenders
    // alongside `screenTileGeometry`'s own even-by-construction tile dims,
    // since this rect's w/h come from a fitted/clamped computation rather
    // than the even-by-construction `computeTileCrop` path every other
    // branch here uses. Flooring can only shrink, so `x + w`/`y + h` stay
    // within the bounds `fitPipCropToTile` already clamped to.
    const { x: pipX, y: pipY, w: pipRawW, h: pipRawH } = params.bottom.pipRect;
    const pipW = Math.max(2, Math.floor(pipRawW / 2) * 2);
    const pipH = Math.max(2, Math.floor(pipRawH / 2) * 2);
    botFilter = `${botSrcLabel}crop=${pipW}:${pipH}:${pipX}:${pipY},scale=${tileWidth}:${bottomHeight},setsar=1${botOutLabel}`;
  } else if (params.bottom.reframe) {
    const escaped = params.bottom.reframe.scriptPath.replace(/'/g, "'\\''");
    const x = Math.round((params.probe.width - cropW) / 2); // sendcmd drives x at runtime; this is just the initial value
    botFilter =
      `${botSrcLabel}sendcmd=f='${escaped}',` +
      `${params.bottom.reframe.cropName}=w=${cropW}:h=${cropH}:x=${x}:y=${y},` +
      `scale=${tileWidth}:${bottomHeight},setsar=1${botOutLabel}`;
  } else {
    const x = cropXForCenter(params.bottom.cx, params.probe.width, cropW);
    botFilter = `${botSrcLabel}crop=${cropW}:${cropH}:${x}:${y},scale=${tileWidth}:${bottomHeight},setsar=1${botOutLabel}`;
  }

  return [
    `${videoInputLabel}split=2${topSrcLabel}${botSrcLabel}`,
    topFilter,
    botFilter,
    `${topOutLabel}${botOutLabel}vstack=inputs=2,format=yuv420p,setsar=1${trailing}${outputLabel}`,
  ];
}

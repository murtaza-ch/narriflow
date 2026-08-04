/**
 * Pure auto-reframe path math (no FFmpeg / no model). Given per-frame face
 * centers from the detector, produce a smooth horizontal crop track that follows
 * the speaker without jitter. Unit-tested in isolation; the detector (Python)
 * and the FFmpeg crop application live in the render task.
 */
import { sourceToEdited } from "@narriflow/validators";
import type { ClipCutPlan } from "./cut-plan";

/** One detector sample. `cx` is the face center X normalized 0..1, or null if no face was found in that frame. */
export interface FaceSample {
  t: number;
  cx: number | null;
}

export interface SmoothedSample {
  t: number;
  cx: number;
}

export interface ReframeOptions {
  /** EMA factor 0..1 — lower is smoother (more inertia). */
  smoothing?: number;
  /**
   * Dead-zone (normalized 0..1): the crop center holds still until the face
   * drifts further than this from it, preventing micro-jitter on a still head.
   */
  deadZone?: number;
}

const DEFAULTS: Required<ReframeOptions> = {
  smoothing: 0.18,
  deadZone: 0.04,
};

/**
 * Fills gaps (carries the last known center across frames with no face), then
 * applies an EMA with a dead-zone so the crop only moves when the speaker
 * meaningfully shifts. Returns one smoothed center per input sample. Returns []
 * if no sample ever had a face.
 */
export function smoothFacePath(
  samples: FaceSample[],
  options: ReframeOptions = {},
): SmoothedSample[] {
  const { smoothing, deadZone } = { ...DEFAULTS, ...options };

  // Seed from the first detected face (or fall back to center 0.5).
  const firstWithFace = samples.find((s) => s.cx !== null);
  if (!firstWithFace) return [];
  let target = firstWithFace.cx as number;
  let current = target;

  const out: SmoothedSample[] = [];
  for (const sample of samples) {
    if (sample.cx !== null) {
      // Only update the target if the face moved beyond the dead-zone.
      if (Math.abs(sample.cx - target) > deadZone) {
        target = sample.cx;
      }
    }
    // Ease the current crop center toward the target (EMA).
    current = current + (target - current) * smoothing;
    out.push({ t: sample.t, cx: clamp01(current) });
  }
  return out;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Splits raw detector samples into one `FaceSample[]` group per kept
 * cut-plan segment: drops samples whose source instant falls inside a
 * deleted range, and remaps the retained samples' `t` from
 * elapsed-uncut-source seconds (what the detector emits — see
 * `reframe_detect.py`, always 0-based from wherever detection started) onto
 * the edited (post-concat) timeline the crop filter's `sendcmd` actually
 * runs against (multi-model review fix #3). Without this, samples captured
 * after a cut are timed against the pre-cut source, so the crop follows the
 * speaker's PRE-cut position at each post-cut instant — increasingly wrong
 * the more total footage has been cut before that point.
 *
 * Returns one group per segment (in source/edited order) rather than a
 * single flat list so the caller can run `smoothFacePath` independently per
 * group: `smoothFacePath`'s EMA + dead-zone carries state sample-to-sample
 * with no notion of elapsed time, so feeding it a list with a cut-induced
 * gap would smoothly (and wrongly) drift the crop across the cut instead of
 * snapping immediately to the next kept segment's own face position. Calling
 * it once per group resets that state at each kept-segment boundary without
 * needing to change `smoothFacePath` itself.
 *
 * `clipStartSec` converts a sample's clip-relative elapsed `t` into the
 * source-absolute seconds `cutPlan.map` expects. A no-op single-group
 * passthrough (`[samples]`) when the clip is uncut.
 */
export function remapFaceSamplesForCutPlan(
  samples: FaceSample[],
  cutPlan: ClipCutPlan,
  clipStartSec: number,
): FaceSample[][] {
  if (cutPlan.isUncut) return [samples];

  const groups: FaceSample[][] = cutPlan.segments.map(() => []);
  for (const sample of samples) {
    const sourceSec = clipStartSec + sample.t;
    const segmentIndex = cutPlan.segments.findIndex(
      (segment) =>
        sourceSec >= segment.sourceStartSec &&
        sourceSec <= segment.sourceEndSec,
    );
    if (segmentIndex === -1) continue; // inside a cut (or outside the window)
    groups[segmentIndex]!.push({
      t: sourceToEdited(cutPlan.map, sourceSec),
      cx: sample.cx,
    });
  }
  return groups;
}

/**
 * Converts a normalized face center into an integer crop X (top-left of the
 * crop window) clamped so the window stays fully inside the source frame.
 */
export function cropXForCenter(
  cxNorm: number,
  srcWidth: number,
  cropWidth: number,
): number {
  const centerPx = clamp01(cxNorm) * srcWidth;
  const x = centerPx - cropWidth / 2;
  return Math.round(Math.max(0, Math.min(srcWidth - cropWidth, x)));
}

/** FFmpeg instance name of the reframe crop filter, targeted by sendcmd. */
export const REFRAME_CROP_NAME = "crop@reframe";

/**
 * Builds an FFmpeg `sendcmd` script that drives the named `crop` filter's `x`
 * over time, following the smoothed face path. Consecutive duplicate X values
 * are collapsed so the script stays small. Times are clip-relative seconds.
 */
export function buildReframeSendcmdScript(
  samples: SmoothedSample[],
  srcWidth: number,
  cropWidth: number,
  cropName: string = REFRAME_CROP_NAME,
): string {
  const lines: string[] = [];
  let lastX: number | null = null;
  for (const sample of samples) {
    const x = cropXForCenter(sample.cx, srcWidth, cropWidth);
    if (x === lastX) continue;
    lines.push(`${Math.max(0, sample.t).toFixed(3)} ${cropName} x ${x};`);
    lastX = x;
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

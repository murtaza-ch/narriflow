import type { MediaFacts } from "./source-probe";

/** The geometry every consumer plans in: display-oriented with square pixels.
 *  FFmpeg autorotation applies the display matrix exactly once when it decodes,
 *  so a consumer must never apply it again. */
export interface DisplayGeometry {
  width: number;
  height: number;
  /** The matrix rotates, reflects or swaps axes of the decoded frame. */
  oriented: boolean;
  /** Stream SAR is not 1:1, so the frame needs scaling to width x height with
   *  SAR 1:1 before any crop. */
  anamorphic: boolean;
}

const FIXED_ONE = 65536;

/** Resolve the first video stream's displayed geometry. Quarter-turn matrices
 *  and reflections are exact. A source without facts, or with an oblique
 *  matrix, keeps its coded dimensions. */
export function resolveDisplayGeometry(
  inspection: { width: number; height: number; facts?: MediaFacts },
): DisplayGeometry {
  const coded: DisplayGeometry = { width: inspection.width, height: inspection.height, oriented: false, anamorphic: false };
  const video = inspection.facts?.videos[0];
  if (!video || inspection.width <= 0 || inspection.height <= 0) return coded;
  const m = video.displayMatrix;
  let swapped = false;
  let oriented = false;
  if (m) {
    const axisAligned = Math.abs(m[0]!) === FIXED_ONE && Math.abs(m[4]!) === FIXED_ONE && m[1] === 0 && m[3] === 0;
    const quarterTurn = m[0] === 0 && m[4] === 0 && Math.abs(m[1]!) === FIXED_ONE && Math.abs(m[3]!) === FIXED_ONE;
    if (!axisAligned && !quarterTurn) return coded;
    swapped = quarterTurn;
    oriented = !(m[0] === FIXED_ONE && m[4] === FIXED_ONE);
  }
  const sar = video.sampleAspectRatio;
  const anamorphic = Boolean(sar && sar.numerator !== sar.denominator);
  const squareWidth = anamorphic ? Math.max(1, Math.round((inspection.width * sar!.numerator) / sar!.denominator)) : inspection.width;
  return {
    width: swapped ? inspection.height : squareWidth,
    height: swapped ? squareWidth : inspection.height,
    oriented,
    anamorphic,
  };
}


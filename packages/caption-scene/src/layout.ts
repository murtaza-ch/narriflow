import { captionWordVisualOrder, type CaptionDirection } from "@narriflow/caption-fonts/bidi-order";
import { captionTextDirection, languageDirection, textDirection } from "@narriflow/validators";
import type { SceneCue, SceneInput } from "./input";
import { type Box, type Frames, type Measure, type Piece, sceneBoundsOver } from "./scene";

/**
 * Layout helpers a template builds on. Templates are written in the sample's 1080 x 1920
 * coordinates; `sceneSpace` maps them onto the real canvas. Rows come from roles, words wrap
 * greedily or balanced, a right-to-left row is ordered by the shared bidi code, and a cue is
 * shifted (never scaled) into the safe area.
 */

/** Share of each canvas edge kept clear of captions. */
export const SAFE_INSET = 0.05;

export interface SceneSpace {
  /** Canvas px per sample px, size scale included. */
  readonly u: number;
  readonly canvas: { readonly width: number; readonly height: number };
  /** Canvas x of a sample x (the sample's 540 is the anchor's x). */
  readonly x: (sampleX: number) => number;
  /** Canvas y of a sample y (the template's anchor line is the anchor's y). */
  readonly y: (sampleY: number) => number;
  /** A sample length in canvas px. */
  readonly px: (sampleLength: number) => number;
  /** The safe area, canvas px. */
  readonly safe: Box;
}

/** The mapping of spec 3.1: `u = min(w, h) / 1080 * scale`, centre at `anchor.xPct`, `anchorLineY` at `anchor.yPct`. */
export function sceneSpace(input: SceneInput, anchorLineY: number): SceneSpace {
  const { canvas, anchor } = input;
  const u = (Math.min(canvas.width, canvas.height) / 1080) * input.scale;
  const cx = (anchor.xPct / 100) * canvas.width;
  const ay = (anchor.yPct / 100) * canvas.height;
  return {
    u,
    canvas,
    x: (sampleX) => cx + (sampleX - 540) * u,
    y: (sampleY) => ay + (sampleY - anchorLineY) * u,
    px: (length) => length * u,
    safe: { x1: SAFE_INSET * canvas.width, y1: SAFE_INSET * canvas.height, x2: (1 - SAFE_INSET) * canvas.width, y2: (1 - SAFE_INSET) * canvas.height },
  };
}

/** A cue's base direction: its spoken text's script balance, else the language's. */
export function cueDirection(cue: Pick<SceneCue, "words" | "language">): CaptionDirection {
  return captionTextDirection(cue.words.map((word) => word.text).join(" "), cue.language ? languageDirection(cue.language) : undefined);
}

/** Word indices of a row in the order the viewer reads them from the left edge: logical for LTR, bidi visual for RTL. */
export function rowVisualOrder(texts: readonly string[], direction: CaptionDirection): number[] {
  if (direction === "ltr" && texts.every((text) => textDirection(text, "ltr") === "ltr")) return texts.map((_, index) => index);
  return [...captionWordVisualOrder(texts.map((text) => ({ text, space: true })), direction).wordOrder];
}

/** Rows of the word indices before the hero, the hero span and the words after it, as the Reveal sample reads a cue. */
export function rowsFromRoles(roles: readonly ("hero" | "body" | "minor")[]): { lead: number[]; hero: number[]; tail: number[] } {
  const first = roles.indexOf("hero");
  if (first < 0) return { lead: roles.map((_, index) => index), hero: [], tail: [] };
  let last = first;
  while (roles[last + 1] === "hero") last++;
  return {
    lead: roles.slice(0, first).map((_, index) => index),
    hero: roles.slice(first, last + 1).map((_, index) => first + index),
    tail: roles.slice(last + 1).map((_, index) => last + 1 + index),
  };
}

const rowWidthOf = (widths: readonly number[], indices: readonly number[], gap: number) =>
  indices.reduce((sum, index) => sum + widths[index]!, 0) + gap * Math.max(0, indices.length - 1);

/** Total width of a row of words with `gap` between them. */
export const rowWidth = rowWidthOf;

/** Greedy wrap: as many words per row as fit `maxWidth`; a word wider than `maxWidth` gets a row of its own. */
export function greedyRows(widths: readonly number[], gap: number, maxWidth: number): number[][] {
  const rows: number[][] = [];
  let row: number[] = [];
  for (let index = 0; index < widths.length; index++) {
    if (row.length > 0 && rowWidthOf(widths, [...row, index], gap) > maxWidth) {
      rows.push(row);
      row = [];
    }
    row.push(index);
  }
  if (row.length > 0) rows.push(row);
  return rows;
}

/**
 * `text-wrap: balance`: as many rows as greedy wrap makes, with the words divided so the rows come out
 * as even as they can (the least sum of squared row widths, no row wider than `maxWidth` unless it is one word).
 */
export function balancedRows(widths: readonly number[], gap: number, maxWidth: number): number[][] {
  const greedy = greedyRows(widths, gap, maxWidth);
  const count = greedy.length;
  if (count < 2) return greedy;
  const n = widths.length;
  const width = (from: number, to: number) => rowWidthOf(widths, Array.from({ length: to - from }, (_, k) => from + k), gap);
  // best[k][i]: least cost of the first i words in k rows; cut[k][i]: where the last row starts.
  const best = Array.from({ length: count + 1 }, () => new Array<number>(n + 1).fill(Number.POSITIVE_INFINITY));
  const cut = Array.from({ length: count + 1 }, () => new Array<number>(n + 1).fill(0));
  best[0]![0] = 0;
  for (let k = 1; k <= count; k++) {
    for (let i = k; i <= n; i++) {
      for (let j = k - 1; j < i; j++) {
        const w = width(j, i);
        if (i - j > 1 && w > maxWidth) continue;
        const cost = best[k - 1]![j]! + w * w;
        if (cost < best[k]![i]!) {
          best[k]![i] = cost;
          cut[k]![i] = j;
        }
      }
    }
  }
  if (!Number.isFinite(best[count]![n]!)) return greedy;
  const rows: number[][] = [];
  let end = n;
  for (let k = count; k >= 1; k--) {
    const start = cut[k]![end]!;
    rows.unshift(Array.from({ length: end - start }, (_, at) => start + at));
    end = start;
  }
  return rows;
}

/** A scale that fits a row of natural width `width` into `maxWidth`, never above 1. */
export function fitScale(width: number, maxWidth: number): number {
  return width > maxWidth && width > 0 ? maxWidth / width : 1;
}

function shiftFrames(frames: Frames, by: number): Frames {
  return frames.map((frame) => (frame[2] === undefined ? [frame[0], frame[1] + by] : [frame[0], frame[1] + by, frame[2]])) as unknown as Frames;
}

/** The piece moved by `dx, dy` canvas px: its pivot track and its clip rectangle. */
export function shiftPiece<P extends Piece>(piece: P, dx: number, dy: number): P {
  const track = { ...piece.track };
  if (track.x) track.x = shiftFrames(track.x, dx);
  if (track.y) track.y = shiftFrames(track.y, dy);
  const clip = piece.clip && piece.clip.radius === undefined
    ? { ...piece.clip, x1: shiftFrames(piece.clip.x1, dx), x2: shiftFrames(piece.clip.x2, dx), y1: shiftFrames(piece.clip.y1, dy), y2: shiftFrames(piece.clip.y2, dy) }
    : piece.clip;
  return { ...piece, track, ...(clip ? { clip } : {}) };
}

/**
 * Shifts a cue's pieces together, by one fixed amount, until everything they ever draw (the union
 * of their boxes over the cue's whole window) is inside `safe`. Never scales: a group wider than the
 * safe area is centred and the template is expected to have fitted its rows first.
 */
export function clampToSafeArea<P extends Piece>(pieces: readonly P[], safe: Box, measure: Measure): P[] {
  if (pieces.length === 0) return [];
  const from = Math.min(...pieces.map((piece) => piece.fromMs));
  const to = Math.max(...pieces.map((piece) => piece.toMs));
  const times: number[] = [];
  for (let ms = from; ms < to; ms += 16) times.push(ms);
  const union = sceneBoundsOver(pieces, times, measure);
  if (!union) return [...pieces];
  const axis = (low: number, high: number, safeLow: number, safeHigh: number) => {
    if (high - low >= safeHigh - safeLow) return (safeLow + safeHigh) / 2 - (low + high) / 2;
    if (low < safeLow) return safeLow - low;
    if (high > safeHigh) return safeHigh - high;
    return 0;
  };
  const dx = axis(union.x1, union.x2, safe.x1, safe.x2);
  const dy = axis(union.y1, union.y2, safe.y1, safe.y2);
  return dx === 0 && dy === 0 ? [...pieces] : pieces.map((piece) => shiftPiece(piece, dx, dy));
}

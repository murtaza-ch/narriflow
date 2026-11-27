import { type CaptionBlockLayout, type MeasuredWord, captionBlockDirection } from "@narriflow/caption-fonts/caption-block";
import {
  CAPTION_CUE_TILTS_DEG,
  CAPTION_FIT_WIDTH_FRACTION,
  CAPTION_MOTIONS,
  type CaptionBlock,
  type CaptionPreset,
  captionClassicAnimation,
  captionDynamicStyle,
} from "@narriflow/validators";
import type { Box } from "../scene";
import { turnedBox, unionBox } from "./box";
import { captionEmojiCueDirection } from "./style";

/**
 * Where a cue's text is, as the emoji layer reads it (spec D3). The three caption paths differ only
 * in how they make these: `sceneCueBoxes` for a Scene Style, `blockCueBox` for a Dynamic Style,
 * `lineCueBox` for a classic line.
 */
export interface CaptionEmojiCueBox {
  readonly cueIndex: number;
  /** The cue's text at rest, canvas px. */
  readonly box: Box;
  /** When the cue's own pieces paint, clip ms: an emoji never outlives them. */
  readonly fromMs: number;
  readonly toMs: number;
  /** The cue's body text size, px: the emoji's size follows it. */
  readonly bodyPx: number;
  /** The cue's own tilt, degrees clockwise; 0 for most. */
  readonly tiltDeg: number;
  readonly direction: "ltr" | "rtl";
  /** The cue's last row of text: a `beside-end` emoji sits level with it at its reading end. `box` by default. */
  readonly endBox?: Box;
  /** Live boxes the emoji must miss at `atMs` (export frame times). Absent = `box` alone. */
  readonly obstacles?: (atMs: number) => readonly CaptionEmojiObstacle[];
  /**
   * The boxes of the cue's text that reads at `atMs` (export frame times) and of the plates it is written on; empty when
   * none reads. A Scene Style's stack reveals rows after the emoji pops, which `box` (one late sample) already holds: an
   * emoji is kept close to what is on screen when it pops, and a `below` slot sits under it. Absent = `box` (a classic
   * line and a Caption Block show their whole text at once).
   */
  readonly shownAt?: (atMs: number) => readonly Box[];
  /**
   * What `shownAt` reads, when it is data: a Caption Block's words, tiles and decorations, each with the time it is drawn
   * from. A one-cue layer's memo key names it, since a word's onset moves an emoji without moving the box.
   */
  readonly shownParts?: readonly { readonly box: Box; readonly fromMs: number }[];
}

/**
 * Something an emoji must not cover. A soft one (a ray, a streak, a spark: a shape with no text on
 * it) is covered rather than the emoji dropped, when no slot is clear of everything.
 */
export type CaptionEmojiObstacle = Box & { readonly soft?: boolean };

/** What a cue box helper needs besides the geometry. */
export type CaptionEmojiCueTiming = Pick<CaptionEmojiCueBox, "cueIndex" | "fromMs" | "toMs" | "bodyPx" | "direction">;

/**
 * A Dynamic Style cue's box from the layout both painters share (ADR 0020): every word's rest ink,
 * turned with the word, its tile, and the drawn details. Not the layout's `bounds`, which also
 * reserve the entrance travel and would hold the emoji off the text. Null when nothing is placed.
 * With `startsMs` (each word's spoken onset, parallel to the layout's words: both painters draw a
 * word from it), the box says which words are on screen at a time (`shownAt`).
 */
export function blockCueBox(
  layout: CaptionBlockLayout,
  measured: readonly MeasuredWord[],
  cue: CaptionEmojiCueTiming,
  startsMs?: readonly (number | undefined)[],
): CaptionEmojiCueBox | null {
  const parts: { readonly box: Box; readonly fromMs: number }[] = [];
  let tilt = 0;
  layout.words.forEach((word, index) => {
    const m = measured[index];
    if (!m) return;
    const fromMs = startsMs?.[index] ?? Number.NEGATIVE_INFINITY;
    tilt += word.rotationDeg;
    if (word.clusters) {
      // A curved row: each cluster is drawn at its own place and turn; its ink is the word's, at the cluster's size.
      for (const cluster of word.clusters) {
        const half = cluster.centerX - cluster.baselineX;
        const ink = { x1: cluster.baselineX, y1: cluster.baselineY - m.inkTopEm * cluster.px, x2: cluster.baselineX + 2 * half, y2: cluster.baselineY + m.inkBottomEm * cluster.px };
        parts.push({ box: turnedBox(ink, cluster.rotationDeg, { x: cluster.centerX, y: cluster.centerY }), fromMs });
      }
    } else {
      const ink = { x1: word.baselineX, y1: word.baselineY - m.inkTopEm * word.px, x2: word.baselineX + m.advanceEm * word.px, y2: word.baselineY + m.inkBottomEm * word.px };
      parts.push({ box: turnedBox(ink, word.rotationDeg, { x: word.centerX, y: word.centerY }), fromMs });
    }
    const tile = word.tile;
    if (tile) {
      const rect = { x1: tile.centerX - tile.width / 2, y1: tile.centerY - tile.height / 2, x2: tile.centerX + tile.width / 2 + tile.shadowOffset, y2: tile.centerY + tile.height / 2 + tile.shadowOffset };
      parts.push({ box: turnedBox(rect, word.rotationDeg, { x: word.centerX, y: word.centerY }), fromMs });
    }
  });
  for (const decoration of layout.decorations) {
    const { x, y, width, height } = decoration.bounds;
    parts.push({ box: { x1: x, y1: y, x2: x + width, y2: y + height }, fromMs: startsMs ? decoration.startSec * 1000 : Number.NEGATIVE_INFINITY });
  }
  const box = unionBox(parts.map((part) => part.box));
  if (!box) return null;
  const tiltDeg = layout.words.length > 0 ? tilt / layout.words.length : 0;
  if (!startsMs) return { ...cue, box, tiltDeg };
  return { ...cue, box, tiltDeg, shownAt: (atMs) => parts.filter((part) => part.fromMs <= atMs).map((part) => part.box), shownParts: parts };
}

/**
 * A classic line's box: centred on `centerX`, `width` wide, from `top` to `bottom` (canvas px, the
 * ink with its outline), turned by `tiltDeg` about `pivot` (the line's anchor; its centre by default).
 */
export function lineCueBox(
  line: { readonly centerX: number; readonly top: number; readonly bottom: number; readonly width: number; readonly tiltDeg?: number; readonly pivot?: { readonly x: number; readonly y: number } },
  cue: CaptionEmojiCueTiming,
): CaptionEmojiCueBox {
  const tiltDeg = line.tiltDeg ?? 0;
  const rest = { x1: line.centerX - line.width / 2, y1: line.top, x2: line.centerX + line.width / 2, y2: line.bottom };
  const pivot = line.pivot ?? { x: line.centerX, y: (line.top + line.bottom) / 2 };
  return { ...cue, box: turnedBox(rest, tiltDeg, pivot), tiltDeg };
}

/** What the cue box of a classic line or a Caption Block reads of its plan caption layer (`CompositionCaptionVisualLayer`). */
export interface CaptionEmojiPlanCue {
  readonly cueIndex: number;
  readonly activeRange: { readonly startSec: number; readonly endSec: number };
  readonly anchor: { readonly xPct: number; readonly yPct: number };
  readonly words: readonly { readonly text: string }[];
  readonly language: string | null;
  readonly preset: CaptionPreset;
  readonly block?: Pick<CaptionBlock, "style" | "texts">;
}

function planCueTiming(cue: Pick<CaptionEmojiPlanCue, "cueIndex" | "activeRange">, bodyPx: number, direction: "ltr" | "rtl"): CaptionEmojiCueTiming {
  return { cueIndex: cue.cueIndex, fromMs: cue.activeRange.startSec * 1000, toMs: cue.activeRange.endSec * 1000, bodyPx, direction };
}

/** What a renderer measured of a classic line. */
export interface ClassicLineMeasure {
  /** The line's advance width at the preset's font size, em. */
  readonly widthEm: number;
  /**
   * The line box, em: the tallest Win ascent plus the deepest Win descent among the faces that draw
   * the line (the requested face for its spaces), as the burn-in's glyph planner picks the faces.
   */
  readonly heightEm: number;
  /** Font size after fit-to-width, canvas px per em: the size the line is drawn at, and the cue's body size. */
  readonly px: number;
}

/**
 * A classic line's cue box, the one definition both renderers use: centred on the anchor (libass
 * centres the line box there vertically and its glyph bbox horizontally; the Studio centres the
 * line's layout box there), the line box high and the advance wide, grown on every side by the
 * drawn outline (outline plus outer outline, scaled by the fit like the text), turned by the cue's
 * tilt about the anchor.
 */
export function classicLineCueBox(cue: CaptionEmojiPlanCue, line: ClassicLineMeasure, canvas: { readonly width: number; readonly height: number }): CaptionEmojiCueBox {
  const { preset } = cue;
  const anchorX = (cue.anchor.xPct / 100) * canvas.width;
  const anchorY = (cue.anchor.yPct / 100) * canvas.height;
  const stroke = ((preset.outlineWidth + (preset.outerOutlineWidth ?? 0)) * line.px) / preset.fontSize;
  const halfHeight = (line.heightEm * line.px) / 2 + stroke;
  const tiltDeg = CAPTION_MOTIONS[captionClassicAnimation(preset)].tilt ? CAPTION_CUE_TILTS_DEG[cue.cueIndex % CAPTION_CUE_TILTS_DEG.length]! : 0;
  return lineCueBox(
    { centerX: anchorX, top: anchorY - halfHeight, bottom: anchorY + halfHeight, width: line.widthEm * line.px + 2 * stroke, tiltDeg, pivot: { x: anchorX, y: anchorY } },
    planCueTiming(cue, line.px, captionEmojiCueDirection(cue.words, cue.language)),
  );
}

/**
 * The most of the canvas a classic line can cover before it is laid out, as the cue box beside a held
 * emoji's own (the Studio lays out only the line on screen, so neither renderer uses the next line's
 * width): the line box `heightEm` (`ClassicLineMeasure.heightEm`) at the preset's size, since the fit
 * only shrinks a line, and as wide as the fit lets a line be.
 */
export function classicLineReachBox(cue: CaptionEmojiPlanCue, heightEm: number, canvas: { readonly width: number; readonly height: number }): CaptionEmojiCueBox {
  const { preset } = cue;
  const stroke = preset.outlineWidth + (preset.outerOutlineWidth ?? 0);
  return classicLineCueBox(cue, { widthEm: (CAPTION_FIT_WIDTH_FRACTION * canvas.width - 2 * stroke) / preset.fontSize, heightEm, px: preset.fontSize }, canvas);
}

/**
 * A Caption Block's cue box from the layout its renderer drew (`blockCueBox`): the body size is the
 * body role's drawn size (the preset's size, the block's fit scale and the role's size), the
 * direction the block's own, as the layout ordered its rows, and what is on screen from each word's
 * onset.
 */
export function captionBlockCueBox(
  cue: Pick<CaptionEmojiPlanCue, "cueIndex" | "activeRange" | "language" | "preset"> & {
    readonly block: Pick<CaptionBlock, "style" | "texts">;
    /** The words the layout was made from (`layout.words` is parallel to them): each is drawn from its `startSec`. */
    readonly words?: readonly { readonly startSec?: number }[];
  },
  layout: CaptionBlockLayout,
  measured: readonly MeasuredWord[],
): CaptionEmojiCueBox | null {
  const bodyPx = cue.preset.fontSize * layout.scale * captionDynamicStyle(cue.block.style).roles.body.sizeEm;
  const startsMs = cue.words?.map((word) => (word.startSec === undefined ? undefined : word.startSec * 1000));
  return blockCueBox(layout, measured, planCueTiming(cue, bodyPx, captionBlockDirection(cue.block.texts, cue.language)), startsMs);
}

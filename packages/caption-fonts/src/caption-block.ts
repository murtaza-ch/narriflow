import {
  CAPTION_BLOCK,
  CAPTION_CUE_TILTS_DEG,
  CAPTION_MOTIONS,
  captionBlockAnimation,
  captionEntranceKeyframes,
  captionEntranceMs,
  captionEntranceTimeScale,
  languageDirection,
  textDirection,
  type CaptionBlock,
  type CaptionDynamicStyle,
  type CaptionKeyframe,
  type CaptionMotionSpec,
  type CaptionPreset,
} from "@narriflow/validators";
import { type CaptionDirection, captionWordVisualOrder } from "./bidi-order";
import { canonicalCaptionLanguage, captionRunScript } from "./locale-precedence";

/**
 * Caption Block geometry (spec 5.6, ADR 0020): where every word of a Dynamic
 * Style cue goes, in canvas px. The worker and the Studio each measure words
 * their own way (HarfBuzz, Canvas `measureText`) and paint each word where
 * this module says; neither lays text out across words.
 *
 * Browser-safe: no `node:` import anywhere in this file's import graph
 * (`@narriflow/caption-fonts/caption-block`).
 */

/**
 * A Caption Block cue's base direction: its first strong character, else the caption
 * language's direction. Rows read in its bidi visual order; left styles mirror for "rtl".
 */
export function captionBlockDirection(texts: readonly string[], language: string | null | undefined): CaptionDirection {
  return textDirection(texts.join(" "), languageDirection(language));
}

/**
 * The direction one block word is measured and drawn in: its own first strong character, else
 * the cue's. A word without one (`50،`, `(50)`) takes the cue's direction, so in an RTL cue its
 * neutral characters order right to left in both painters. The Studio gives the word element
 * `dir`; libass picks a direction from the event's text alone, so the worker starts an RTL word's
 * events with U+200F (`CAPTION_RTL_MARK`).
 */
export function captionWordDirection(text: string, cueDirection: CaptionDirection): CaptionDirection {
  return textDirection(text, cueDirection);
}

/** RIGHT-TO-LEFT MARK: starts the worker's events of an RTL word, so libass orders it as the Studio does. */
export const CAPTION_RTL_MARK = "\u200F";

/** One word measured alone in its role's face, at 1 em. */
export interface MeasuredWord {
  /** Advance at 1 em, including letter spacing, excluding trailing spacing. */
  readonly advanceEm: number;
  /** Ink above the baseline, positive. */
  readonly inkTopEm: number;
  /** Ink below the baseline, positive. */
  readonly inkBottomEm: number;
  /**
   * Height above the baseline of the middle of the line box the painter anchors the word by:
   * the point libass scales an `\an5` event about, `(ascent − descent) / 2` of the word's faces.
   * Absent = the ink middle. Only scaling entrances read it (`PlacedWord.scaleOriginY`).
   */
  readonly boxMiddleEm?: number;
}

/** What the layout reads of each caption word (a `CompositionCaptionWord` fits). */
export interface CaptionBlockWordInput {
  /** The provider's spacing before the word; `false` joins it to the previous word with no gap. */
  readonly spaceBefore?: boolean;
  /** The word's spoken onset, seconds; the entrance duration cap reads it. */
  readonly startSec?: number;
}

export interface CaptionBlockRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PlacedWord {
  /** Font size in canvas px, after fit. */
  readonly px: number;
  /**
   * Left end of the advance box at the baseline, before the word's rotation:
   * turning this point about (`centerX`, `centerY`) by `rotationDeg` gives
   * where the drawn baseline starts.
   */
  readonly baselineX: number;
  readonly baselineY: number;
  /** Centre of the advance box, vertically at the middle of the word's ink. The pivot of every transform. */
  readonly centerX: number;
  readonly centerY: number;
  /**
   * The point a scaling entrance scales the word's glyphs about, before the word's rotation:
   * the middle of its line box (`MeasuredWord.boxMiddleEm`), where libass anchors an `\an5`
   * event. The Studio scales about the same point, so both painters grow a word alike.
   */
  readonly scaleOriginX: number;
  readonly scaleOriginY: number;
  /** Block tilt plus tile tilt, degrees clockwise. */
  readonly rotationDeg: number;
  /** Multiplies `offsetXEm` of direction-flipping motions; equals the row's stagger sign. */
  readonly motionSign: 1 | -1;
  /**
   * Duration cap (spec 5.7): multiply every entrance keyframe time by this.
   * 0 draws the word settled. Both painters read it, never their own cap.
   */
  readonly entranceTimeScale: number;
  /** The word's tile, for tile styles; null otherwise. */
  readonly tile: PlacedTile | null;
}

/**
 * A word's tile (spec 5.8 `tile`) in canvas px, before the word's rotation: a rounded rectangle
 * centred on (`centerX`, `centerY`), turned with the word about the word's centre and entering
 * with it. A scaling entrance scales the tile about its own centre (libass scales a `\p1`
 * drawing about its `\an5` anchor). The hard shadow is the same rectangle moved
 * `shadowOffset` right and down before the turn.
 */
export interface PlacedTile {
  readonly centerX: number;
  readonly centerY: number;
  readonly width: number;
  readonly height: number;
  readonly radius: number;
  readonly shadowOffset: number;
}

/** Drawn details (underline, stars); phase 2 fills these, phase 1 has none. */
export interface PlacedDecoration {
  readonly kind: "underline" | "star";
  readonly bounds: CaptionBlockRect;
}

export interface CaptionBlockLayout {
  /** The one fit scale applied to every word, so the hierarchy holds. */
  readonly scale: number;
  /** Parallel to the block's words. */
  readonly words: readonly PlacedWord[];
  /** Rest ink box of every word plus strokes, tiles, decorations and the reserved entrance travel. */
  readonly bounds: CaptionBlockRect;
  readonly decorations: readonly PlacedDecoration[];
  /** The safe-area shift (rule 9) applied to the block, canvas px. The stored position excludes it. */
  readonly shift: { readonly x: number; readonly y: number };
}

export interface CaptionBlockLayoutInput {
  readonly block: CaptionBlock;
  readonly preset: CaptionPreset;
  readonly style: CaptionDynamicStyle;
  readonly words: readonly CaptionBlockWordInput[];
  readonly measured: readonly MeasuredWord[];
  readonly canvas: { readonly width: number; readonly height: number };
  readonly anchor: { readonly xPct: number; readonly yPct: number };
  /** The cue's base direction; rows read in its bidi visual order, left styles mirror for RTL. */
  readonly direction: CaptionDirection;
  /**
   * The cue's visible end, seconds (the caption layer's `activeRange.endSec`). With the
   * words' `startSec` it sets each `entranceTimeScale`; a missing time leaves its term out.
   */
  readonly cueEndSec?: number;
  /** The cue's caption language: Urdu support words in Arabic script are drawn in Nastaliq and take `nastaliqSupportScale`. */
  readonly language?: string | null;
}

/**
 * Whether a support word is drawn in Nastaliq: Arabic-script text in an Urdu cue, which the
 * fallback chain draws in Noto Nastaliq Urdu in both painters.
 */
function drawnInNastaliq(text: string, language: string | null | undefined): boolean {
  return canonicalCaptionLanguage(language) === "ur" && captionRunScript(text) === "arabic";
}

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const emptyBox = (): Box => ({ left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity });

function include(box: Box, left: number, top: number, right: number, bottom: number) {
  box.left = Math.min(box.left, left);
  box.right = Math.max(box.right, right);
  box.top = Math.min(box.top, top);
  box.bottom = Math.max(box.bottom, bottom);
}

/** Visual order of one row: logical word indexes left to right, and whether a space precedes each. */
function rowVisualOrder(
  row: readonly number[],
  block: CaptionBlock,
  words: readonly CaptionBlockWordInput[],
  direction: CaptionDirection,
): { readonly index: number; readonly spaced: boolean }[] {
  const order = captionWordVisualOrder(
    row.map((index, at) => ({ text: block.texts[index]!, space: at > 0 && words[index]!.spaceBefore !== false })),
    direction,
  );
  const placed: { index: number; spaced: boolean }[] = [];
  let spaced = false;
  for (const item of order.items) {
    if ("space" in item) {
      spaced = true;
      continue;
    }
    placed.push({ index: row[item.word]!, spaced: placed.length > 0 && spaced });
    spaced = false;
  }
  return placed;
}

/** Extremes a keyframed property reaches, including its rest value. */
function extremes(keyframes: readonly CaptionKeyframe[], property: keyof CaptionKeyframe, rest: number): [number, number] {
  let low = rest;
  let high = rest;
  for (const frame of keyframes) {
    const value = frame[property];
    if (typeof value !== "number") continue;
    low = Math.min(low, value);
    high = Math.max(high, value);
  }
  return [low, high];
}

const radians = (degrees: number) => (degrees * Math.PI) / 180;

/**
 * Lays out one Caption Block. Rules in order (spec 5.6): role sizes, word
 * gaps, hero fill, the fit scale, stagger signs, row pitch from measured ink,
 * row x and bidi order, block tilt, anchor, and the safe-area shift over the
 * bounds including the reserved entrance travel (spec 5.7). Rotation is
 * applied about the block's rest centre before the safe-area shift, so the
 * shift covers the turned corners; anchoring is unaffected because the turn
 * keeps the centre.
 *
 * The fit measures the arranged block: every length in it is proportional to
 * the word sizes (gaps, stroke, tiles, pitch, stagger, travel and growth all
 * are), so arranging at full size, taking the scale that brings the reserved
 * bounds inside the safe area, and arranging again at that scale gives
 * bounds that fit exactly.
 */
export function layoutCaptionBlock(input: CaptionBlockLayoutInput): CaptionBlockLayout {
  const { block, preset, style, words, measured, canvas, anchor, direction } = input;
  const count = block.roles.length;
  if (measured.length !== count || words.length !== count) {
    throw new Error("layoutCaptionBlock needs one measurement and one word per block role");
  }
  if (count === 0) {
    return { scale: 1, words: [], bounds: { x: canvas.width * anchor.xPct / 100, y: canvas.height * anchor.yPct / 100, width: 0, height: 0 }, decorations: [], shift: { x: 0, y: 0 } };
  }
  const S = preset.fontSize;
  const roles = block.roles;
  const hasHero = roles.includes("hero");
  const strokePerPx = (preset.outlineWidth + (preset.outerOutlineWidth ?? 0)) / S;
  const tile = style.tile;
  const padX = (px: number) => (tile ? tile.padXEm * px : 0);
  const padY = (px: number) => (tile ? tile.padYEm * px : 0);
  const stroke = (px: number) => strokePerPx * px;

  // Rule 1, sizes. Nastaliq support words are scaled up to read at the size of the others.
  const px = roles.map((role, index) =>
    S * (hasHero || role === "minor" ? style.roles[role].sizeEm : style.noHeroSizeEm) *
    (role !== "hero" && drawnInNastaliq(block.texts[index]!, input.language) ? CAPTION_BLOCK.nastaliqSupportScale : 1));

  const order = block.rows.map((row) => rowVisualOrder(row, block, words, direction));

  // Rule 2, gaps; a row's width includes the outer stroke and tile extent at both ends.
  // Tiles are separate objects: neighbours keep the tile gap whether or not the words are spaced.
  const gapBefore = (left: number, right: number, spaced: boolean, sizes: readonly number[]) => {
    const larger = Math.max(sizes[left]!, sizes[right]!);
    const gap = tile ? tile.gapEm * larger : spaced ? CAPTION_BLOCK.wordGapEm * larger : 0;
    return gap + padX(sizes[left]!) + padX(sizes[right]!);
  };
  const rowWidth = (k: number, sizes: readonly number[]) => {
    const items = order[k]!;
    if (items.length === 0) return 0;
    const first = items[0]!.index;
    const last = items[items.length - 1]!.index;
    let width = stroke(sizes[first]!) + padX(sizes[first]!) + stroke(sizes[last]!) + padX(sizes[last]!);
    items.forEach((item, at) => {
      width += measured[item.index]!.advanceEm * sizes[item.index]!;
      if (at > 0) width += gapBefore(items[at - 1]!.index, item.index, item.spaced, sizes);
    });
    return width;
  };

  // Rule 3, hero fill: a stack hero row is scaled to the style's share of the frame width.
  const heroRow = block.rows.findIndex((row) => row.length > 0 && row.every((index) => roles[index] === "hero"));
  if (hasHero) {
    let heroPx = S * style.roles.hero.sizeEm;
    if (style.heroFill && heroRow >= 0 && style.layout === "stack") {
      const unit = px.map((size, index) => (roles[index] === "hero" ? 1 : size));
      const perEm = rowWidth(heroRow, unit);
      const target = perEm > 0 ? (style.heroFill.widthFraction * canvas.width) / perEm : S * style.heroFill.minEm;
      heroPx = Math.min(S * style.heroFill.maxEm, Math.max(S * style.heroFill.minEm, target));
    }
    heroPx *= preset.emphasisScale ?? 1;
    roles.forEach((role, index) => {
      if (role === "hero") px[index] = heroPx;
    });
  }

  // Rule 6, stagger signs: row 0 takes the seed's sign, each later non-hero row the opposite of the last one.
  const baseSign: 1 | -1 = block.seed % 2 === 0 ? 1 : -1;
  const isHeroRow = (k: number) => k === heroRow;
  let lastSign = baseSign;
  const rowSign = block.rows.map((_, k): 1 | -1 => {
    if (k === 0) return baseSign;
    if (isHeroRow(k)) return baseSign;
    lastSign = lastSign === 1 ? -1 : 1;
    return lastSign;
  });
  const mirrored = style.align === "left" && direction === "rtl";
  const rowOf = new Array<number>(count).fill(0);
  block.rows.forEach((row, k) => {
    for (const index of row) rowOf[index] = k;
  });

  const motion: CaptionMotionSpec = CAPTION_MOTIONS[captionBlockAnimation(preset, style)];
  const entrances = roles.map((role) => captionEntranceKeyframes(motion, role === "hero"));
  const blockTilt = motion.tilt ? CAPTION_CUE_TILTS_DEG[block.seed % CAPTION_CUE_TILTS_DEG.length]! : 0;
  const cos = Math.cos(radians(blockTilt));
  const sin = Math.sin(radians(blockTilt));

  /** Rules 4, 5, 6 and 10 at word sizes `sizes`, which carry the fit scale `fit`, in block-local px. */
  const arrange = (sizes: readonly number[], fit: number) => {
    // Rule 4, row pitch from measured ink plus stroke (and tile padding).
    const inkTop = (index: number) => measured[index]!.inkTopEm * sizes[index]! + stroke(sizes[index]!) + padY(sizes[index]!);
    const inkBottom = (index: number) => measured[index]!.inkBottomEm * sizes[index]! + stroke(sizes[index]!) + padY(sizes[index]!);
    const rowInkTop = block.rows.map((row) => Math.max(...row.map(inkTop)));
    const rowInkBottom = block.rows.map((row) => Math.max(...row.map(inkBottom)));
    const baselines = [0];
    for (let k = 1; k < block.rows.length; k++) {
      baselines.push(baselines[k - 1]! + rowInkBottom[k - 1]! + style.rowGapEm * S * fit + rowInkTop[k]!);
    }

    // Rule 5, row x (and rule 6's shift). Block-local coordinates: x = 0 is the centre axis, or the
    // left edge of a left style (the right edge when it mirrors for RTL); y = 0 is row 0's baseline.
    // Curved rows (spec 5.11) will replace this straight placement per glyph cluster, and row pitch
    // will then use the arc's vertical extent.
    const left = new Array<number>(count).fill(0);
    const rest = emptyBox();
    block.rows.forEach((_, k) => {
      const width = rowWidth(k, sizes);
      const shift = isHeroRow(k) ? 0 : style.staggerEm * S * fit * rowSign[k]!;
      const rowLeft = (style.align === "center" ? -width / 2 : mirrored ? -width : 0) + shift;
      const items = order[k]!;
      let cursor = rowLeft + stroke(sizes[items[0]!.index]!) + padX(sizes[items[0]!.index]!);
      items.forEach((item, at) => {
        if (at > 0) cursor += gapBefore(items[at - 1]!.index, item.index, item.spaced, sizes);
        left[item.index] = cursor;
        cursor += measured[item.index]!.advanceEm * sizes[item.index]!;
      });
      include(rest, rowLeft, baselines[k]! - rowInkTop[k]!, rowLeft + width, baselines[k]! + rowInkBottom[k]!);
    });

    // Rule 10, rotation: the block tilt turns each word's centre about the block centre.
    const pivotX = (rest.left + rest.right) / 2;
    const pivotY = (rest.top + rest.bottom) / 2;
    const words = roles.map((_, index) => {
      const advance = measured[index]!.advanceEm * sizes[index]!;
      const inkMid = ((measured[index]!.inkTopEm - measured[index]!.inkBottomEm) / 2) * sizes[index]!;
      const x = left[index]! + advance / 2 - pivotX;
      const y = baselines[rowOf[index]!]! - inkMid - pivotY;
      const tileTilt = tile && tile.tiltsDeg.length > 0 ? tile.tiltsDeg[(index + block.seed) % tile.tiltsDeg.length]! : 0;
      const size = sizes[index]!;
      const k = rowOf[index]!;
      // Offsets from the word's centre, before its rotation: the scale origin, and the tile's
      // edges (its row's ink plus padding, so a row's tiles share a height).
      const boxMiddle = measured[index]!.boxMiddleEm;
      const scaleOriginDy = boxMiddle === undefined ? 0 : inkMid - boxMiddle * size;
      const tileBox = tile
        ? {
          halfWidth: advance / 2 + stroke(size) + padX(size),
          top: inkMid - rowInkTop[k]!,
          bottom: inkMid + rowInkBottom[k]!,
          radius: tile.radiusEm * size,
          shadowOffset: tile.shadowEm * size,
        }
        : null;
      return {
        advance,
        inkMid,
        scaleOriginDy,
        tileBox,
        centerX: pivotX + x * cos - y * sin,
        centerY: pivotY + x * sin + y * cos,
        rotationDeg: blockTilt + tileTilt,
        motionSign: rowSign[rowOf[index]!]!,
      };
    });

    // Reserved space (spec 5.7): each word's box (and tile) at rest, turned, plus its entrance travel,
    // scale (about each painted element's own scale origin) and turn.
    const reserved = emptyBox();
    words.forEach((word, index) => {
      const size = sizes[index]!;
      const frames = entrances[index]!;
      const [xLow, xHigh] = extremes(frames, "offsetXEm", 0);
      const [yLow, yHigh] = extremes(frames, "offsetYEm", 0);
      const [scaleXLow, scaleXHigh] = extremes(frames, "scaleX", 1);
      const [scaleYLow, scaleYHigh] = extremes(frames, "scaleY", 1);
      const [zLow, zHigh] = extremes(frames, "rotateZDeg", 0);
      const halfW = word.advance / 2 + stroke(size);
      const halfH = ((measured[index]!.inkTopEm + measured[index]!.inkBottomEm) / 2) * size + stroke(size);
      // Rectangles relative to the word's centre, each with the y its entrance scales about.
      const rects = [{ left: -halfW, right: halfW, top: -halfH, bottom: halfH, originY: word.scaleOriginDy }];
      if (word.tileBox) {
        const { halfWidth, top, bottom, shadowOffset } = word.tileBox;
        rects.push({ left: -halfWidth, right: halfWidth + shadowOffset, top, bottom: bottom + shadowOffset, originY: (top + bottom) / 2 });
      }
      const box = emptyBox();
      for (const rect of rects) {
        for (const [sx, sy] of [[scaleXLow, scaleYLow], [scaleXHigh, scaleYHigh]] as const) {
          for (const extra of [0, zLow, zHigh]) {
            const theta = radians(word.rotationDeg + extra);
            for (const x of [rect.left, rect.right]) {
              for (const y of [rect.top, rect.bottom]) {
                const qx = x * sx;
                const qy = rect.originY + (y - rect.originY) * sy;
                const rx = qx * Math.cos(theta) - qy * Math.sin(theta);
                const ry = qx * Math.sin(theta) + qy * Math.cos(theta);
                include(box, rx, ry, rx, ry);
              }
            }
          }
        }
      }
      const travelX = [xLow * size * word.motionSign, xHigh * size * word.motionSign];
      include(
        reserved,
        word.centerX + box.left + Math.min(...travelX),
        word.centerY + box.top + yLow * size,
        word.centerX + box.right + Math.max(...travelX),
        word.centerY + box.bottom + yHigh * size,
      );
    });
    return { rest, words, reserved };
  };

  // Rule 7, fit: one scale for the whole block, so the hierarchy holds. The envelope is the
  // reserved bounds (every row at rest, grown by its words' entrance scale and travel, staggered
  // and turned), so no entrance frame leaves the safe area: its width is the fit width
  // (`CAPTION_FIT_WIDTH_FRACTION` of the frame), and its height binds on short frames.
  const safe = CAPTION_BLOCK.safeArea;
  const safeWidth = (safe.right - safe.left) * canvas.width;
  const safeHeight = (safe.bottom - safe.top) * canvas.height;
  const natural = arrange(px, 1);
  const envelopeWidth = natural.reserved.right - natural.reserved.left;
  const envelopeHeight = natural.reserved.bottom - natural.reserved.top;
  const scale = Math.min(
    1,
    envelopeWidth > 0 ? safeWidth / envelopeWidth : 1,
    envelopeHeight > 0 ? safeHeight / envelopeHeight : 1,
  );
  for (let index = 0; index < count; index++) px[index] = px[index]! * scale;
  const { rest, words: local, reserved } = scale === 1 ? natural : arrange(px, scale);

  // Duration cap (spec 5.7): an entrance ends within 45% of the cue time left and by the next spoken word.
  const entranceTimeScale = roles.map((_, index) => {
    const start = words[index]!.startSec;
    const next = words[index + 1]?.startSec;
    const remainingMs = start !== undefined && input.cueEndSec !== undefined ? (input.cueEndSec - start) * 1000 : Infinity;
    const gapMs = start !== undefined && next !== undefined ? (next - start) * 1000 : undefined;
    return captionEntranceTimeScale(remainingMs, captionEntranceMs(entrances[index]!), gapMs);
  });

  // Rule 8, anchor. Centre styles centre the rest box on the anchor; left styles put its left
  // edge (mirrored: its right edge, at the mirrored guide) on the anchor and centre it vertically.
  const anchorX = (canvas.width * anchor.xPct) / 100;
  const anchorY = (canvas.height * anchor.yPct) / 100;
  let dx = style.align === "center"
    ? anchorX - (rest.left + rest.right) / 2
    : mirrored
      ? canvas.width - anchorX - rest.right
      : anchorX - rest.left;
  let dy = anchorY - (rest.top + rest.bottom) / 2;

  // Rule 9, safe area: shift the block (never the stored position) to keep the reserved bounds inside.
  const keepInside = (low: number, high: number, min: number, max: number) => {
    if (high - low > max - min) return (min + max) / 2 - (low + high) / 2;
    if (low < min) return min - low;
    if (high > max) return max - high;
    return 0;
  };
  const shiftX = keepInside(reserved.left + dx, reserved.right + dx, safe.left * canvas.width, safe.right * canvas.width);
  const shiftY = keepInside(reserved.top + dy, reserved.bottom + dy, safe.top * canvas.height, safe.bottom * canvas.height);
  dx += shiftX;
  dy += shiftY;

  return {
    scale,
    words: local.map((word, index) => ({
      px: px[index]!,
      baselineX: word.centerX + dx - word.advance / 2,
      baselineY: word.centerY + dy + word.inkMid,
      centerX: word.centerX + dx,
      centerY: word.centerY + dy,
      scaleOriginX: word.centerX + dx,
      scaleOriginY: word.centerY + dy + word.scaleOriginDy,
      rotationDeg: word.rotationDeg,
      motionSign: word.motionSign,
      entranceTimeScale: entranceTimeScale[index]!,
      tile: word.tileBox
        ? {
          centerX: word.centerX + dx,
          centerY: word.centerY + dy + (word.tileBox.top + word.tileBox.bottom) / 2,
          width: 2 * word.tileBox.halfWidth,
          height: word.tileBox.bottom - word.tileBox.top,
          radius: word.tileBox.radius,
          shadowOffset: word.tileBox.shadowOffset,
        }
        : null,
    })),
    bounds: {
      x: reserved.left + dx,
      y: reserved.top + dy,
      width: reserved.right - reserved.left,
      height: reserved.bottom - reserved.top,
    },
    decorations: [],
    shift: { x: shiftX, y: shiftY },
  };
}

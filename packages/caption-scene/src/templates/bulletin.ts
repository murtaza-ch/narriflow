import type { DemoScript } from "../demo";
import { countUpText, parseNumberInWord } from "../detect";
import { type Ease, type Frames, EASES, prog } from "../ease";
import type { SceneCue, SceneInput, SceneProgram } from "../input";
import { balancedRows, clampToSafeArea, cueDirection, fitScale, rowVisualOrder, rowWidth, sceneSpace } from "../layout";
import type { Piece, ShapePiece, TextPiece } from "../scene";
import { rectPath } from "../shapes";

/**
 * Bulletin (`samples/templates/33-bulletin.js`): a broadcast lower third that understands numbers. A vermilion bar
 * grows down the block's left side, stacked square plates wipe in beside it, and every word rises inside its plate on
 * its spoken beat. A number hero counts up from zero while a white rule draws under it.
 *
 * Geometry is the sample's, read from its layout in Chrome (`.scratch/motion-captions/tools/probe-sample.ts`):
 * the block's left edge is x 84, the bar is 14 wide and 8 clear of the plates, a plate is its row padded 28 px at the
 * sides (hero 34) and 0.22 / 0.26 em above and below (hero 26 / 28 around a cap-tight box), words in a plate are
 * 0.26 em apart, plates touch, and the block is centred on y 1320. A word rises 140 % of its box out of the plate's
 * bottom edge (the plate clips it); a plate wipes in from its left edge and out the same way, so the plate is a
 * rectangle scaled about its left edge and the words under it are clipped by the same moving edge. A hero number is
 * one text piece per displayed value (the sample rewrites its text every frame), switching at export frame times.
 */

export const BULLETIN_DEMO: DemoScript = {
  lines: [
    "Revenue:b grew:b 312%:h@780 in:m one:b year",
    "And:m we:m didn't:b hire:b anyone",
    "The:m real:b lever:b was:m pricing:h@660",
    "It:m added:b $4.2M:h@820 in:m profit",
  ],
  options: { cueGap: 160, tail: 560, rate: 255 },
};

const ANCHOR_LINE = 1320;
const BLOCK_X = 84;
const BAR = 14;
const BAR_GAP = 8;
const SMALL = 60;
const SOLO = 66;
const HERO = 132;
const EARLY = 80;
const WIPE = 320;
const RISE = 360;
const BAR_GROW = 300;
const HERO_PAD = { top: 26, bottom: 28, side: 34 } as const;
const PLATE_SIDE = 28;
const RULE_HEIGHT = 6;
const SMALL_FACE = "Inter Tight Bold" as const;
const HERO_FACE = "Archivo Black" as const;
const SMALL_LS = -0.015;
const HERO_LS = -0.01;
const SHADOW = { dx: 0, dy: 8, blur: 9, alpha: 0.22 } as const;
const WHITE = "#FFFFFF";
/** Baseline of a `line-height: 1.12` Inter Tight line box, em from its top (Chrome floors it to a whole px: 55 at 60, 60 at 66). */
const BASELINE_EM = 0.9238;
/** The sample's exit: the bottom plate leaves first, 30 ms apart, each wipe 110 ms, inside the last 200 ms; the bar shrinks last. */
const EXIT = { from: 200, step: 30, wipe: 110, bar: 100 } as const;
/** Rows of a no-hero cue split in two once it has more characters than this (the sample's rule). */
const SOLO_SPLIT_CHARS = 16;
const FRAME_FPS = 30;

type Kind = "lead" | "hero" | "tail" | "solo";

/** What a number hero reads as it counts: `312%`, `$4.2M`, and `1,000` (the sample would count `0,000` up to `1,000`). */
export interface Counter {
  /** The text at `progress` 0..1 of the count. */
  readonly at: (progress: number) => string;
}

const GROUPED = /^([^\d]*)(\d{1,3}(?:,\d{3})+)(\.\d+)?(.*)$/;
const group = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** The count-up of a hero word, or null when it holds no number (`pricing`, `ten`). */
export function bulletinCounter(text: string): Counter | null {
  const grouped = text.match(GROUPED);
  if (grouped) {
    const [, pre, whole, fraction, post] = grouped as unknown as [string, string, string, string | undefined, string];
    const value = Number(whole.replaceAll(",", "") + (fraction ?? ""));
    const decimals = fraction ? fraction.length - 1 : 0;
    return {
      at: (progress) => {
        const [integer, decimal] = (value * progress).toFixed(decimals).split(".") as [string, string | undefined];
        return `${pre}${group(integer)}${decimal === undefined ? "" : `.${decimal}`}${post}`;
      },
    };
  }
  const number = parseNumberInWord(text);
  return number ? { at: (progress) => countUpText(number, progress) } : null;
}

/** Export frame time `n` in ms (`round(n * 1000 / 30)`): a counter changes its text only on these. */
const frameMs = (n: number) => Math.round((n * 1000) / FRAME_FPS);

/** The sample's wipe: the share of a plate that shows at `t`, a plate whose first word starts at `startMs`, in a cue ending at `endMs`. */
export function bulletinPlateVisible(t: number, startMs: number, outAtMs: number): number {
  const wipeIn = EASES.outExpo(prog(t, startMs - EARLY, WIPE));
  const wipeOut = EASES.in(prog(t, outAtMs, EXIT.wipe));
  return Math.max(0, wipeIn - wipeOut);
}

/** When plate `index` of `count` starts to leave a cue that ends at `endMs`. */
export const bulletinPlateOutAt = (endMs: number, index: number, count: number) => endMs - EXIT.from + (count - 1 - index) * EXIT.step;

/**
 * `fn` over `edges` (ms where a window starts or ends) as keyframes: an interval becomes one eased segment when `fn` follows
 * linear, out, outExpo or in between its ends within `tolerance` at five points, else it is split at its middle (down to 1 ms,
 * which is a jump).
 */
function fitFrames(fn: (t: number) => number, edges: readonly number[], tolerance: number): Frames {
  const sorted = [...new Set(edges)].sort((a, b) => a - b);
  const frames: [number, number, Ease?][] = [[sorted[0]!, fn(sorted[0]!)]];
  const CANDIDATES: readonly Ease[] = ["linear", "outExpo", "out", "in"];
  const POINTS = [0.1, 0.25, 0.5, 0.75, 0.9];
  const split = (a: number, b: number, depth: number) => {
    const va = fn(a);
    const vb = fn(b);
    const fits = (name: Ease) => POINTS.every((u) => Math.abs(fn(a + (b - a) * u) - (va + (vb - va) * EASES[name](u))) <= tolerance);
    const found = CANDIDATES.find(fits);
    if (found) {
      frames.push(found === "linear" ? [b, vb] : [b, vb, found]);
    } else if (depth < 14 && b - a > 1) {
      const mid = Math.round((a + b) / 2);
      split(a, mid, depth + 1);
      split(mid, b, depth + 1);
    } else frames.push([b, vb]);
  };
  for (let at = 1; at < sorted.length; at++) split(sorted[at - 1]!, sorted[at]!, 0);
  return frames;
}

/** The frames that decide `[from, to]`: the last at or before `from` to the first at or after `to`. */
function sliceFrames(frames: Frames, from: number, to: number): Frames {
  let first = 0;
  frames.forEach((frame, index) => {
    if (frame[0] <= from) first = index;
  });
  let last = frames.length - 1;
  for (let index = first; index < frames.length; index++) {
    if (frames[index]![0] >= to) {
      last = index;
      break;
    }
  }
  return frames.slice(first, last + 1);
}

const mapFrames = (frames: Frames, fn: (value: number) => number): Frames => frames.map(([at, value, ease]) => (ease === undefined ? [at, fn(value)] : [at, fn(value), ease])) as unknown as Frames;

interface PlateWord {
  /** Index in the cue's words. */
  readonly index: number;
  /** Advance with the trailing letter spacing, the CSS box. */
  readonly boxWidth: number;
  readonly left: number;
}

interface Plate {
  readonly kind: Kind;
  /** Sample px size of its type. */
  readonly sizeS: number;
  readonly size: number;
  readonly words: readonly PlateWord[];
  readonly left: number;
  readonly width: number;
  readonly top: number;
  readonly height: number;
  /** First spoken word of the plate, ms. */
  readonly start: number;
}

function buildCue(cue: SceneCue, input: SceneInput, cueNumber: number): Piece[] {
  const space = sceneSpace(input, ANCHOR_LINE);
  const { u } = space;
  const direction = cueDirection(cue);
  const plateLeft = space.x(BLOCK_X + BAR + BAR_GAP);
  const maxPlate = space.safe.x2 - plateLeft;
  const heroAt = cue.words.findIndex((word) => word.role === "hero");
  const texts = cue.words.map((word) => word.text);
  const measureBox = (text: string, face: typeof SMALL_FACE | typeof HERO_FACE, px: number, ls: number) => input.measure(text, face, px, ls).advance + ls * px;

  // Which words go on which plate, in the sample's rules; a row that cannot fit the safe width is wrapped evenly below.
  const lead = heroAt < 0 ? [] : texts.slice(0, heroAt).map((_, index) => index);
  const tail = heroAt < 0 ? [] : texts.slice(heroAt + 1).map((_, index) => heroAt + 1 + index);
  const all = texts.map((_, index) => index);
  const smallS = heroAt < 0 ? SOLO : SMALL;

  // Small type shrinks for a word wider than a plate.
  let sizeS = smallS;
  const widest = () => Math.max(0, ...(heroAt < 0 ? all : [...lead, ...tail]).map((index) => measureBox(texts[index]!, SMALL_FACE, sizeS * u, SMALL_LS)));
  const inner = maxPlate - 2 * PLATE_SIDE * u;
  for (let pass = 0; pass < 3; pass++) {
    const scale = fitScale(widest(), inner);
    if (scale >= 0.999) break;
    sizeS *= scale * 0.999;
  }
  const small = sizeS * u;
  const gapOf = (px: number) => px * 0.26;
  const wrap = (indices: readonly number[]): number[][] => {
    if (indices.length === 0) return [];
    const widths = indices.map((index) => measureBox(texts[index]!, SMALL_FACE, small, SMALL_LS));
    return balancedRows(widths, gapOf(small), inner).map((row) => row.map((at) => indices[at]!));
  };
  let rows: { kind: Kind; indices: number[] }[];
  if (heroAt < 0) {
    // The sample balances a no-hero cue over two rows once it is longer than 16 characters.
    const chars = texts.map((text) => text.length + 1);
    const total = chars.reduce((a, b) => a + b, 0);
    let split = texts.length;
    if (total > SOLO_SPLIT_CHARS) {
      let accumulated = 0;
      let best = Number.POSITIVE_INFINITY;
      for (let at = 1; at < texts.length; at++) {
        accumulated += chars[at - 1]!;
        const difference = Math.abs(total - 2 * accumulated);
        if (difference < best) {
          best = difference;
          split = at;
        }
      }
    }
    rows = [all.slice(0, split), all.slice(split)].filter((row) => row.length > 0).flatMap((row) => wrap(row)).map((indices) => ({ kind: "solo" as const, indices }));
  } else {
    rows = [
      ...wrap(lead).map((indices) => ({ kind: "lead" as const, indices })),
      { kind: "hero" as const, indices: [heroAt] },
      ...wrap(tail).map((indices) => ({ kind: "tail" as const, indices })),
    ];
  }

  // The hero: caps uppercased, plate fixed at the width of the final value; it shrinks for a word wider than a plate.
  const heroWord = heroAt < 0 ? null : cue.words[heroAt]!;
  const counter = heroWord ? bulletinCounter(heroWord.text) : null;
  const heroFinal = heroWord ? (counter ? counter.at(1) : heroWord.text).toUpperCase() : "";
  let heroS = HERO;
  const heroInk = () => {
    const box = measureBox(heroFinal, HERO_FACE, heroS * u, HERO_LS);
    return Math.max(Math.round(box), box);
  };
  for (let pass = 0; heroWord && pass < 3; pass++) {
    const room = maxPlate - 2 * HERO_PAD.side * u;
    if (heroInk() <= room) break;
    heroS *= (room / heroInk()) * 0.999;
  }
  const heroPx = heroS * u;
  const heroCap = heroWord ? -input.measure("H", HERO_FACE, heroPx, 0).inkTop : 0;
  const heroInkH = Math.round(heroCap);

  // Stack the plates like the sample's flex column; the block is centred on the anchor line.
  const pad = (s: number) => ({ top: Math.round(0.22 * s) * u, bottom: Math.round(0.26 * s) * u });
  const heights = rows.map((row) => (row.kind === "hero" ? HERO_PAD.top * u + heroInkH + HERO_PAD.bottom * u : pad(sizeS).top + 1.12 * small + pad(sizeS).bottom));
  const blockHeight = heights.reduce((a, b) => a + b, 0);
  const blockTop = space.y(ANCHOR_LINE) - blockHeight / 2;
  let cursor = blockTop;
  const plates: Plate[] = rows.map((row, at) => {
    const hero = row.kind === "hero";
    const px = hero ? heroPx : small;
    const ordered = hero ? row.indices : rowVisualOrder(row.indices.map((index) => texts[index]!), direction).map((position) => row.indices[position]!);
    const gap = gapOf(px);
    let x = plateLeft + (hero ? HERO_PAD.side : PLATE_SIDE) * u;
    const words = ordered.map((index): PlateWord => {
      const boxWidth = hero ? heroInk() : measureBox(texts[index]!, SMALL_FACE, px, SMALL_LS);
      const word = { index, boxWidth, left: x };
      x += boxWidth + gap;
      return word;
    });
    const width = hero ? 2 * HERO_PAD.side * u + words[0]!.boxWidth : 2 * PLATE_SIDE * u + rowWidth(words.map((word) => word.boxWidth), words.map((_, position) => position), gap);
    const plate: Plate = {
      kind: row.kind,
      sizeS: hero ? heroS : sizeS,
      size: px,
      words,
      left: plateLeft,
      width,
      top: cursor,
      height: heights[at]!,
      start: Math.min(...row.indices.map((index) => cue.words[index]!.startMs)),
    };
    cursor += heights[at]!;
    return plate;
  });

  const endMs = cue.endMs;
  const count = plates.length;
  const colours = input.colours;
  const fillOf = (kind: Kind) => (kind === "hero" ? colours.highlight : kind === "tail" ? colours.accent : colours.primary);
  const inkOf = (kind: Kind) => (kind === "hero" || kind === "tail" ? WHITE : colours.accent);
  const shadow = [{ dx: SHADOW.dx * u, dy: SHADOW.dy * u, blur: SHADOW.blur * u, colour: colours.shadow, alpha: SHADOW.alpha }];
  const zOf = (role: number) => cueNumber * 4 + role;
  const pieces: Piece[] = [];

  // Plates: a rectangle scaled about its left edge by the wipe, so its shadow follows the visible part as the sample's does.
  const platePieces = plates.map((plate, index) => {
    const outAt = bulletinPlateOutAt(endMs, index, count);
    const visible = (t: number) => bulletinPlateVisible(t, plate.start, outAt);
    const from = plate.start - EARLY + 1;
    const to = outAt + EXIT.wipe;
    const sx = fitFrames(visible, [plate.start - EARLY, plate.start - EARLY + WIPE, outAt, outAt + EXIT.wipe], 0.002);
    return { plate, index, from, to, sx };
  }).filter((entry) => entry.to > entry.from);
  for (const { plate, index, from, to, sx } of platePieces) {
    pieces.push({
      id: `bulletin:${cueNumber}:plate${index}`,
      kind: "shape",
      z: zOf(0),
      fromMs: from,
      toMs: to,
      track: { x: [[from, plate.left]], y: [[from, plate.top]], sx },
      path: rectPath(0, 0, plate.width, plate.height),
      fill: { colour: fillOf(plate.kind) },
      shadows: shadow,
    } satisfies ShapePiece);
  }

  // The bar grows down with the plates, reaching each plate's bottom as it wipes in, and shrinks back up last.
  if (platePieces.length > 0) {
    const bottoms = plates.map((plate) => plate.top + plate.height - blockTop);
    const reach = (t: number) => {
      let value = 0;
      plates.forEach((plate, index) => {
        const grown = EASES.outExpo(prog(t, plate.start - EARLY, BAR_GROW));
        if (grown > 0) {
          const origin = index === 0 ? 0 : bottoms[index - 1]!;
          value = Math.max(value, origin + (bottoms[index]! - origin) * grown);
        }
      });
      return value;
    };
    const shrink = (t: number) => EASES.in(prog(t, endMs - EXIT.bar, EXIT.bar));
    const scaleY = (t: number) => (reach(t) / blockHeight) * (1 - shrink(t));
    const barFrom = Math.min(...platePieces.map((entry) => entry.from));
    const edges = [...plates.flatMap((plate) => [plate.start - EARLY, plate.start - EARLY + BAR_GROW]), endMs - EXIT.bar, endMs].filter((edge) => edge >= barFrom - 1 && edge <= endMs);
    pieces.push({
      id: `bulletin:${cueNumber}:bar`,
      kind: "shape",
      z: zOf(0),
      fromMs: barFrom,
      toMs: endMs,
      track: { x: [[barFrom, space.x(BLOCK_X)]], y: [[barFrom, blockTop]], sy: fitFrames(scaleY, [barFrom - 1, ...edges], 0.0015) },
      path: rectPath(0, 0, BAR * u, blockHeight),
      fill: { colour: colours.highlight },
      shadows: shadow,
    } satisfies ShapePiece);
  }

  for (const { plate, from, to, sx } of platePieces) {
    const x2 = mapFrames(sx, (share) => plate.left + plate.width * share);
    const clipOf = (a: number, b: number) => ({
      x1: [[a, plate.left]] as Frames,
      x2: sliceFrames(x2, a, b),
      y1: [[a, plate.top]] as Frames,
      y2: [[a, plate.top + plate.height]] as Frames,
    });
    const hero = plate.kind === "hero";
    const inkH = hero ? heroInkH : 1.12 * plate.size;
    const baselineOf = hero
      ? plate.top + HERO_PAD.top * u + (heroInkH + heroCap) / 2
      : plate.top + pad(plate.sizeS).top + Math.floor(plate.sizeS * BASELINE_EM) * u;

    for (const word of plate.words) {
      const spoken = cue.words[word.index]!;
      const riseFrom = spoken.startMs - EARLY;
      const wordFrom = Math.max(from, riseFrom);
      if (to <= wordFrom) continue;
      const rise: Frames = [[riseFrom, baselineOf + 1.4 * inkH], [riseFrom + RISE, baselineOf, "outExpo"]];
      const base = {
        kind: "text" as const,
        z: zOf(2),
        face: hero ? HERO_FACE : SMALL_FACE,
        sizePx: plate.size,
        letterSpacingEm: hero ? HERO_LS : SMALL_LS,
        fill: inkOf(plate.kind),
        anchor: "baseline-left" as const,
        language: cue.language,
      };
      const countOf = hero ? counter : null;
      if (!countOf) {
        pieces.push({
          ...base,
          id: `bulletin:${cueNumber}:w${word.index}`,
          fromMs: wordFrom,
          toMs: to,
          track: { x: [[wordFrom, word.left]], y: sliceFrames(rise, wordFrom, to) },
          clip: clipOf(wordFrom, to),
          text: hero ? heroFinal : spoken.text,
        } satisfies TextPiece);
        continue;
      }
      // One piece per displayed value, changing at export frame times: the sample rewrites the text every frame.
      const countMs = spoken.endMs - spoken.startMs + 250;
      const textAt = (t: number) => countOf.at(EASES.out(prog(t, spoken.startMs, countMs))).toUpperCase();
      const steps: { at: number; text: string }[] = [{ at: wordFrom, text: textAt(wordFrom) }];
      for (let n = Math.floor((wordFrom * FRAME_FPS) / 1000); frameMs(n) < to; n++) {
        const at = frameMs(n);
        if (at <= wordFrom) continue;
        const text = textAt(at);
        if (text !== steps[steps.length - 1]!.text) steps.push({ at, text });
      }
      steps.forEach((step, at) => {
        const stepTo = steps[at + 1]?.at ?? to;
        pieces.push({
          ...base,
          id: `bulletin:${cueNumber}:count${at}`,
          fromMs: step.at,
          toMs: stepTo,
          track: { x: [[step.at, word.left]], y: sliceFrames(rise, step.at, stepTo) },
          clip: clipOf(step.at, stepTo),
          text: step.text,
        } satisfies TextPiece);
      });
      // A white rule draws along the plate's bottom edge over the same count.
      const ruleStart = spoken.startMs;
      const ruleFrom = Math.max(wordFrom, ruleStart + 1);
      if (to > ruleFrom) {
        pieces.push({
          id: `bulletin:${cueNumber}:rule`,
          kind: "shape",
          z: zOf(1),
          fromMs: ruleFrom,
          toMs: to,
          track: { x: [[ruleFrom, plate.left]], y: [[ruleFrom, plate.top + plate.height - RULE_HEIGHT * u]], sx: [[ruleStart, 0], [ruleStart + countMs, 1, "out"]] },
          clip: clipOf(ruleFrom, to),
          path: rectPath(0, 0, plate.width, RULE_HEIGHT * u),
          fill: { colour: WHITE },
        } satisfies ShapePiece);
      }
    }
  }
  return clampToSafeArea(pieces, space.safe, input.measure);
}

export const bulletinProgram: SceneProgram = {
  build(input) {
    return { pieces: input.cues.flatMap((cue, number) => buildCue(cue, input, number)) };
  },
};

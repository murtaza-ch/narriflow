import type { DemoScript } from "../demo";
import { type Frames, EASES, clamp, lerp, prog } from "../ease";
import type { SceneCue, SceneInput, SceneProgram } from "../input";
import { clampToSafeArea, cueDirection, rowVisualOrder, rowWidth, sceneSpace, shiftPiece } from "../layout";
import { type ColourFrames, type Measure, type Piece, type ShapePiece, type TextPiece, mixColour, sceneBoundsAt } from "../scene";
import { rectPath, roundedRectPath } from "../shapes";
import { sampleFrames } from "../frames";

/**
 * Track (`samples/templates/50-track.js`): four cyan corner brackets lock onto each word as it is
 * spoken, like an object detector, and a mono chip above the top-left corner reads out the word's
 * timestamp in the clip. Upcoming words wait as ghosts; a hero is bigger, gets a "KEY" tag on its
 * readout and a scanline that sweeps its ink once.
 *
 * Geometry is the sample's (probed with `.scratch/motion-captions/tools/probe-sample.ts`): body
 * 84 px Inter SemiBold, hero 134 px Inter ExtraBold, a 29 px gap, rows of at most 880 px and a 55 px
 * gap between the two rows a cue may take, the block centred on y 1290. A word's tracker box is its
 * ink (cap height, or x-height without ascenders, plus a descender where it has one) padded 17 px
 * across and 13 px down; each corner is an L with 30 px arms of 6 px.
 *
 * The tracker is one function of time (`trackerAt`, the sample's `update`): the box moves from one
 * word to the next in the sample's two-part linear move, grows around a hero, collapses onto the
 * last word at the end. Every corner, the chip and its wipe follow it, so each is sampled from that
 * one function into keyframes (the box is piecewise linear, so a move is a handful of frames).
 */

export const TRACK_DEMO: DemoScript = {
  lines: [
    "Here's:m the:m thing:b about:m AI",
    "it:m doesn't:b understand:b a:m single:b word",
    "it:m just:b predicts:h@600",
    "the:m next:b one",
    "scarily:h@640 well",
  ],
  options: { rate: 300, cueGap: 160, tail: 800 },
};

const ANCHOR_LINE = 1290;
const BODY = 84;
const HERO = 134;
const GHOST = 0.34;
const STROKE = 6;
const ARM = 30;
const PAD_X = 17;
const PAD_Y = 13;
const GAP = 29;
const ROW_GAP = 55;
/** The widest row the sample lets a cue take before it splits in two, share of the canvas width (880 of 1080). */
const MAX_ROW_SHARE = 880 / 1080;
/** The widest a row and its bracket padding may be, share of the canvas width (the safe area). */
const FIT_SHARE = 0.9;

const BODY_FACE = "Inter SemiBold" as const;
const HERO_FACE = "Inter" as const;
const MONO_FACE = "JetBrains Mono Bold" as const;
const LETTER_SPACING = { body: -0.01, hero: -0.02 } as const;
/** Inter at `line-height: 1`: baseline below the top of the line box, in em; cap height, x-height, descender. */
const BASE = 0.864;
const CAP = 0.727;
const XH = 0.545;
const DESC = 0.205;
const TALL = /[A-Z0-9bdfhklt'’!?ij]/;
const LOW = /[gjpqy]/;
const LATIN = /[\p{Script=Latin}\p{N}]/u;

const FLASH = "#FFFFFF";
const CHIP_BG = { colour: "#030C11", alpha: 0.86 } as const;
const CHIP_INK_ON_KEY = "#03141A";
const SHADOW_TEXT = [
  { dx: 0, dy: 3, blur: 7, alpha: 0.62 },
  { dx: 0, dy: 1, blur: 1.5, alpha: 0.7 },
] as const;
const SHADOW_CORNER = { dx: 0, dy: 2, blur: 2, alpha: 0.55 } as const;

/** The readout chip: 27 px mono text in a 37 px plate (padding 5 / 10 / 5 / 9), 8 px above the box. */
const CHIP = { size: 27, height: 37, padLeft: 9, padRight: 10, padTop: 5, ls: 0.04, baseline: 0.86, above: 8, gap: 10, radius: 3 } as const;
/** The KEY tag: padding 3 / 6 / 2 with a -3 / -4 / -2 margin, so it fills the plate from y 2 to 34 and hangs 4 px into the right padding. */
const KEY = { padX: 6, top: 2, height: 32, hang: 4, radius: 2 } as const;
const SCAN = { height: 3, side: 6, above: 4, below: 2, glowSigma: 5 } as const;
/** Timings (ms), the sample's. */
const T = {
  cueLead: 140,
  wordLead: 80,
  cueFade: 120,
  litLead: 20,
  litDur: 60,
  outLead: 200,
  outDur: 120,
  switchLead: 40,
  moveDur: 120,
  firstLead: 120,
  firstDur: 160,
  heroUpLead: 20,
  heroUpDur: 80,
  heroDownLag: 60,
  heroDownDur: 100,
  exitDur: 140,
  lockLag: 80,
  flashDur: 160,
  labelLag: 40,
  wipeDur: 90,
  scanLag: 60,
  scanDur: 180,
} as const;

/** The sample's honest stand-in for an ease-out: 75 % of the way in the first 40 % of the time. */
const mv = (p: number) => (p <= 0 ? 0 : p >= 1 ? 1 : p < 0.4 ? (0.75 * p) / 0.4 : 0.75 + (0.25 * (p - 0.4)) / 0.6);

/** The kinks of `mv` over a window, where the curves built from it stop being straight. */
const mvEdges = (start: number, dur: number): number[] => [start, start + 0.4 * dur, start + dur];

const offsetFrames = (frames: Frames, by: number): Frames => frames.map(([at, value]) => [at, value + by] as [number, number]);

interface Box {
  l: number;
  r: number;
  t: number;
  b: number;
}
const grow = (box: Box, d: number): Box => ({ l: box.l - d, r: box.r + d, t: box.t - d, b: box.b + d });
const lerpBox = (a: Box, b: Box, p: number): Box => ({ l: lerp(a.l, b.l, p), r: lerp(a.r, b.r, p), t: lerp(a.t, b.t, p), b: lerp(a.b, b.b, p) });

/** `mm:ss.cc` of a time in the clip, the sample's `fmt`. */
export function trackStamp(ms: number): string {
  const cs = Math.floor(Math.max(0, ms) / 10);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(Math.floor(cs / 6000))}:${pad(Math.floor(cs / 100) % 60)}.${pad(cs % 100)}`;
}

interface TrackWord {
  readonly index: number;
  readonly hero: boolean;
  readonly size: number;
  readonly left: number;
  readonly boxWidth: number;
  readonly baseline: number;
  readonly ink: Box;
  /** The tracker's box: the ink padded. */
  readonly box: Box;
  readonly startMs: number;
}

/** What the tracker draws at `t`: the box its corners sit on, and how visible it is. */
interface Tracker {
  readonly box: Box;
  readonly alpha: number;
  /** Lock flash, 0..1: 1 = white at the instant of the lock, back to 0 over 160 ms. */
  readonly flash: number;
}

function buildCue(cue: SceneCue, input: SceneInput, cueNumber: number): Piece[] {
  const space = sceneSpace(input, ANCHOR_LINE);
  const { u } = space;
  const direction = cueDirection(cue);
  const count = cue.words.length;
  const isHero = cue.words.map((word) => word.role === "hero");
  const heroIndex = isHero.indexOf(true);
  const measure = input.measure;

  const faceOf = (index: number) => (isHero[index] ? HERO_FACE : BODY_FACE);
  const lsOf = (index: number) => (isHero[index] ? LETTER_SPACING.hero : LETTER_SPACING.body);
  const sizeOf = (index: number, fit: number) => (isHero[index] ? HERO : BODY) * u * fit;
  /** The CSS box of a word: its advance plus the letter spacing after every character, the last included. */
  const boxWidthOf = (index: number, fit: number) => {
    const size = sizeOf(index, fit);
    return measure(cue.words[index]!.text, faceOf(index), size, lsOf(index)).advance + lsOf(index) * size;
  };

  // Rows, as the sample's: one row if it fits 880 px, else the split that makes the wider row narrowest.
  const naturalWidths = cue.words.map((_, index) => boxWidthOf(index, 1));
  const naturalGap = GAP * u;
  const maxRow = MAX_ROW_SHARE * space.canvas.width;
  let groups: number[][] = [cue.words.map((_, index) => index)];
  if (rowWidth(naturalWidths, groups[0]!, naturalGap) > maxRow) {
    let split = count;
    let best = Number.POSITIVE_INFINITY;
    for (let at = 1; at < count; at++) {
      const worst = Math.max(rowWidth(naturalWidths, indices(0, at), naturalGap), rowWidth(naturalWidths, indices(at, count), naturalGap));
      if (worst < best) {
        best = worst;
        split = at;
      }
    }
    groups = [indices(0, split), indices(split, count)].filter((group) => group.length > 0);
  }
  // A cue wider than the safe area (a long word, many short ones) shrinks to fit it, brackets' padding included.
  const widest = Math.max(...groups.map((group) => rowWidth(naturalWidths, group, naturalGap)));
  const roomForText = FIT_SHARE * space.canvas.width - 2 * PAD_X * u;
  const firstFit = widest > roomForText ? roomForText / widest : 1;

  const layout = (fit: number): { pieces: Piece[]; width: number } => {
    const gap = GAP * u * fit;
    const widths = cue.words.map((_, index) => boxWidthOf(index, fit));
    const rowHeights = groups.map((group) => Math.max(...group.map((index) => BASE * sizeOf(index, fit))) + Math.max(...group.map((index) => (1 - BASE) * sizeOf(index, fit))));
    const blockHeight = rowHeights.reduce((sum, height) => sum + height, 0) + ROW_GAP * u * fit * (groups.length - 1);
    let rowTop = space.y(ANCHOR_LINE) - blockHeight / 2;

    const words: TrackWord[] = [];
    groups.forEach((group, rowIndex) => {
      const ordered = rowVisualOrder(group.map((index) => cue.words[index]!.text), direction).map((at) => group[at]!);
      let left = space.x(540) - rowWidth(widths, ordered, gap) / 2;
      const baseline = rowTop + Math.max(...group.map((index) => BASE * sizeOf(index, fit)));
      for (const index of ordered) {
        const size = sizeOf(index, fit);
        const text = cue.words[index]!.text;
        const right = left + widths[index]!;
        let top: number;
        let bottom: number;
        if (LATIN.test(text)) {
          top = baseline - (TALL.test(text) ? CAP : XH) * size;
          bottom = baseline + (LOW.test(text) ? DESC * size : 0);
        } else {
          // The sample's cap and x-height guesses are Latin; any other script boxes its measured ink.
          const m = measure(text, faceOf(index), size, lsOf(index));
          top = baseline + m.inkTop;
          bottom = baseline + Math.max(0, m.inkBottom);
        }
        const ink = { l: left, r: right, t: top, b: bottom };
        words[index] = {
          index,
          hero: isHero[index]!,
          size,
          left,
          boxWidth: widths[index]!,
          baseline,
          ink,
          box: { l: left - PAD_X * u, r: right + PAD_X * u, t: top - PAD_Y * u, b: bottom + PAD_Y * u },
          startMs: cue.words[index]!.startMs,
        };
        left = right + gap;
      }
      rowTop += rowHeights[rowIndex]! + ROW_GAP * u * fit;
    });

    const first = words[0]!;
    const last = words[count - 1]!;
    const fromMs = cue.startMs - T.cueLead;
    const toMs = cue.endMs;
    const arm = ARM * u;
    const heroGrow = BODY * u * 0.08;

    /** The sample's `update` for the tracker, as a function of the clip time. `flare` is how far past the first word its box starts. */
    const trackerAt = (t: number, flare: number): Tracker => {
      let at = 0;
      for (let index = 1; index < count; index++) if (t >= words[index]!.startMs - T.switchLead) at = index;
      const current = words[at]!;
      let box: Box;
      let alpha = 1;
      if (at === 0) {
        const p = prog(t, first.startMs - T.firstLead, T.firstDur);
        box = grow(first.box, flare * (1 - mv(p)));
        alpha = clamp(p / 0.6);
      } else {
        box = lerpBox(words[at - 1]!.box, current.box, mv(prog(t, current.startMs - T.switchLead, T.moveDur)));
      }
      if (current.hero) {
        const over = t < current.startMs + T.heroDownLag ? mv(prog(t, current.startMs - T.heroUpLead, T.heroUpDur)) : 1 - mv(prog(t, current.startMs + T.heroDownLag, T.heroDownDur));
        box = grow(box, heroGrow * over);
      }
      const exit = prog(t, cue.endMs - T.exitDur, T.exitDur);
      if (exit > 0) {
        const cx = (last.box.l + last.box.r) / 2;
        const cy = (last.box.t + last.box.b) / 2;
        box = lerpBox(box, { l: cx - arm, r: cx + arm, t: cy - arm, b: cy + arm }, mv(exit));
        alpha *= 1 - exit;
      }
      const lock = current.startMs + T.lockLag;
      const flash = t >= lock ? 1 - EASES.out(prog(t, lock, T.flashDur)) : 0;
      return { box, alpha, flash };
    };

    // Where any tracker-derived curve bends or jumps.
    const trackerEdges = (() => {
      const edges: number[] = [fromMs, toMs];
      edges.push(...mvEdges(first.startMs - T.firstLead, T.firstDur), first.startMs - T.firstLead + 0.6 * T.firstDur);
      for (let index = 1; index < count; index++) {
        const start = words[index]!.startMs;
        edges.push(...mvEdges(start - T.switchLead, T.moveDur), start - T.switchLead - 1);
      }
      for (const word of words) {
        const lock = word.startMs + T.lockLag;
        edges.push(lock - 1, lock, lock + T.flashDur);
        if (word.hero) edges.push(...mvEdges(word.startMs - T.heroUpLead, T.heroUpDur), ...mvEdges(word.startMs + T.heroDownLag, T.heroDownDur));
      }
      edges.push(...mvEdges(cue.endMs - T.exitDur, T.exitDur));
      return edges.filter((edge) => edge >= fromMs && edge <= toMs);
    })();
    const within = (edges: readonly number[], from: number, to: number) => [from, to, ...edges.filter((edge) => edge > from && edge < to)];

    const buildPieces = (flare: number): Piece[] => {
      const pieces: Piece[] = [];
      const box = (t: number) => trackerAt(t, flare);

      // Words: ghost in, light up on their spoken start, fade inside the cue's last 200 ms. The hero settles from 1.08.
      for (const word of words) {
        const wordFrom = cue.startMs - T.wordLead;
        const opacity = (t: number) =>
          EASES.out(prog(t, cue.startMs - T.wordLead, T.cueFade)) * lerp(GHOST, 1, prog(t, word.startMs - T.litLead, T.litDur)) * (1 - prog(t, cue.endMs - T.outLead, T.outDur));
        const edges = [wordFrom, toMs, cue.startMs - T.wordLead + T.cueFade, word.startMs - T.litLead, word.startMs - T.litLead + T.litDur, cue.endMs - T.outLead, cue.endMs - T.outLead + T.outDur];
        const track: TextPiece["track"] = {
          x: [[wordFrom, word.hero ? word.left + word.boxWidth / 2 : word.left]],
          y: [[wordFrom, word.hero ? word.baseline - (CAP / 2) * word.size : word.baseline]],
          o: sampleFrames(opacity, edges.filter((edge) => edge >= wordFrom && edge <= toMs), 0.01),
        };
        if (word.hero) {
          const scaleFrames: Frames = [[wordFrom, 1.08], [word.startMs, 1.08], [word.startMs + 140, 1, "out"]];
          track.sx = scaleFrames;
          track.sy = scaleFrames;
        }
        pieces.push({
          id: `track:${cueNumber}:w${word.index}`,
          kind: "text",
          z: 1,
          fromMs: wordFrom,
          toMs,
          track,
          ...(word.hero ? { origin: { dx: word.boxWidth / 2, dy: -(CAP / 2) * word.size } } : {}),
          text: cue.words[word.index]!.text,
          face: faceOf(word.index),
          sizePx: word.size,
          letterSpacingEm: lsOf(word.index),
          fill: input.colours.primary,
          shadows: SHADOW_TEXT.map((shadow) => ({ dx: shadow.dx * u, dy: shadow.dy * u, blur: shadow.blur * u, colour: input.colours.shadow, alpha: shadow.alpha })),
          anchor: "baseline-left",
          language: cue.language,
        });
      }

      // The four corners: an L of two bars, one drop shadow for the pair, flashing white as each word locks.
      const a = arm;
      const w = STROKE * u;
      const corners = [
        { name: "tl", right: false, bottom: false, path: [["M", 0, 0], ["L", a, 0], ["L", a, w], ["L", w, w], ["L", w, a], ["L", 0, a], ["Z"]] },
        { name: "tr", right: true, bottom: false, path: [["M", 0, 0], ["L", a, 0], ["L", a, a], ["L", a - w, a], ["L", a - w, w], ["L", 0, w], ["Z"]] },
        { name: "bl", right: false, bottom: true, path: [["M", 0, 0], ["L", w, 0], ["L", w, a - w], ["L", a, a - w], ["L", a, a], ["L", 0, a], ["Z"]] },
        { name: "br", right: true, bottom: true, path: [["M", a, 0], ["L", a, a], ["L", 0, a], ["L", 0, a - w], ["L", a - w, a - w], ["L", a - w, 0], ["Z"]] },
      ] as const;
      const alphaFrames = sampleFrames((t) => box(t).alpha, trackerEdges, 0.01);
      const colourFrames: ColourFrames = sampleFrames((t) => box(t).flash, trackerEdges, 0.02).map(([at, flash]) => [at, mixColour(input.colours.highlight, FLASH, flash)] as const);
      for (const corner of corners) {
        pieces.push({
          id: `track:${cueNumber}:${corner.name}`,
          kind: "shape",
          z: 2,
          fromMs,
          toMs,
          track: {
            x: sampleFrames((t) => (corner.right ? box(t).box.r - a : box(t).box.l), trackerEdges, 0.3),
            y: sampleFrames((t) => (corner.bottom ? box(t).box.b - a : box(t).box.t), trackerEdges, 0.3),
            o: alphaFrames,
            colour: colourFrames,
          },
          path: corner.path as unknown as ShapePiece["path"],
          fill: { colour: input.colours.highlight },
          shadows: [{ dx: 0, dy: SHADOW_CORNER.dy * u, blur: SHADOW_CORNER.blur * u, colour: input.colours.shadow, alpha: SHADOW_CORNER.alpha }],
        } satisfies ShapePiece);
      }

      // The readout: rides above the top-left corner; every new label wipes in left to right.
      const chipHeight = CHIP.height * u;
      const chipSize = CHIP.size * u;
      const stampBox = (text: string) => measure(text, MONO_FACE, chipSize, CHIP.ls).advance + CHIP.ls * chipSize;
      const keyTextBox = stampBox("KEY");
      for (const word of words) {
        const labelFrom = word.startMs + T.labelLag;
        const next = words[word.index + 1];
        const labelTo = next ? Math.min(next.startMs + T.labelLag, toMs) : toMs;
        if (labelFrom >= labelTo) continue;
        const stamp = trackStamp(word.startMs);
        const textBox = stampBox(stamp);
        const keyWidth = word.hero ? keyTextBox + 2 * KEY.padX * u : 0;
        const keyLeft = (CHIP.padLeft + 0) * u + textBox + CHIP.gap * u;
        const chipWidth = word.hero ? keyLeft + keyWidth - KEY.hang * u + CHIP.padRight * u : CHIP.padLeft * u + textBox + CHIP.padRight * u;
        const edges = within([...trackerEdges, labelFrom + T.wipeDur], labelFrom, labelTo);
        const chipLeft = (t: number) => box(t).box.l;
        const chipTop = (t: number) => box(t).box.t - CHIP.above * u - chipHeight;
        const x = sampleFrames(chipLeft, edges, 0.3);
        const y = sampleFrames(chipTop, edges, 0.3);
        const o = sampleFrames((t) => box(t).alpha, edges, 0.01);
        const wipe = (t: number) => prog(t, labelFrom, T.wipeDur);
        const clip = {
          x1: x,
          x2: sampleFrames((t) => chipLeft(t) + chipWidth * wipe(t), edges, 0.3),
          y1: y,
          y2: offsetFrames(y, chipHeight),
        };
        const common = { fromMs: labelFrom, toMs: labelTo, clip };
        const shifted = (dx: number, dy: number): TextPiece["track"] => ({ x: offsetFrames(x, dx), y: offsetFrames(y, dy), o });
        const textBaseline = (CHIP.padTop + CHIP.baseline * CHIP.size) * u;
        pieces.push({
          ...common,
          id: `track:${cueNumber}:chip${word.index}`,
          kind: "shape",
          z: 3,
          track: shifted(0, 0),
          path: roundedRectPath(0, 0, chipWidth, chipHeight, CHIP.radius * u),
          fill: { colour: CHIP_BG.colour, alpha: CHIP_BG.alpha },
        } satisfies ShapePiece);
        if (word.hero) {
          pieces.push({
            ...common,
            id: `track:${cueNumber}:key${word.index}`,
            kind: "shape",
            z: 4,
            track: shifted(keyLeft, KEY.top * u),
            path: roundedRectPath(0, 0, keyWidth, KEY.height * u, KEY.radius * u),
            fill: { colour: input.colours.highlight },
          } satisfies ShapePiece);
        }
        pieces.push({
          ...common,
          id: `track:${cueNumber}:stamp${word.index}`,
          kind: "text",
          z: 5,
          track: shifted(CHIP.padLeft * u, textBaseline),
          text: stamp,
          face: MONO_FACE,
          sizePx: chipSize,
          letterSpacingEm: CHIP.ls,
          fill: input.colours.highlight,
          anchor: "baseline-left",
          language: null,
        } satisfies TextPiece);
        if (word.hero) {
          pieces.push({
            ...common,
            id: `track:${cueNumber}:keytext${word.index}`,
            kind: "text",
            z: 5,
            track: shifted(keyLeft + KEY.padX * u, textBaseline),
            text: "KEY",
            face: MONO_FACE,
            sizePx: chipSize,
            letterSpacingEm: CHIP.ls,
            fill: CHIP_INK_ON_KEY,
            anchor: "baseline-left",
            language: null,
          } satisfies TextPiece);
        }
      }

      // The hero's scanline: sweeps its ink box top to bottom once, glowing.
      if (heroIndex >= 0) {
        const hero = words[heroIndex]!;
        const scanFrom = hero.startMs + T.scanLag + 1;
        const scanTo = Math.min(hero.startMs + T.scanLag + T.scanDur, toMs);
        if (scanFrom < scanTo) {
          const top = hero.ink.t - SCAN.above * u;
          const bottom = hero.ink.b + SCAN.below * u;
          const window = (t: number) => prog(t, hero.startMs + T.scanLag, T.scanDur);
          pieces.push({
            id: `track:${cueNumber}:scan`,
            kind: "shape",
            z: 6,
            fromMs: scanFrom,
            toMs: scanTo,
            track: {
              x: [[scanFrom, hero.ink.l - SCAN.side * u]],
              y: [[scanFrom, lerp(top, bottom, window(scanFrom))], [hero.startMs + T.scanLag + T.scanDur, bottom]],
              o: sampleFrames((t) => 0.85 * Math.sin(Math.PI * window(t)) + 0.15, [scanFrom, hero.startMs + T.scanLag + T.scanDur], 0.01),
            },
            path: rectPath(0, 0, hero.ink.r - hero.ink.l + 2 * SCAN.side * u, SCAN.height * u),
            fill: { colour: input.colours.highlight },
            shadows: [{ dx: 0, dy: 0, blur: SCAN.glowSigma * u, colour: input.colours.highlight, alpha: 1 }],
          } satisfies ShapePiece);
        }
      }
      return pieces;
    };

    // Fit it into the safe area by shifting the whole cue, then let the first box's flare start no
    // further out than the safe area allows (it is invisible there: the brackets fade in as they close).
    const flareMax = BODY * u * 0.6;
    const unflared = buildPieces(0);
    const shifted = clampToSafeArea(unflared, space.safe, measure);
    const dx = (shifted[0]!.track.x?.[0]?.[1] ?? 0) - (unflared[0]!.track.x?.[0]?.[1] ?? 0);
    const dy = (shifted[0]!.track.y?.[0]?.[1] ?? 0) - (unflared[0]!.track.y?.[0]?.[1] ?? 0);
    const room = Math.min(
      first.box.l + dx - space.safe.x1,
      space.safe.x2 - (first.box.r + dx),
      first.box.t + dy - space.safe.y1,
      space.safe.y2 - (first.box.b + dy),
    ) - (first.hero ? heroGrow : 0);
    const flare = Math.max(0, Math.min(flareMax, room));
    const pieces = buildPieces(flare);
    return { pieces: dx === 0 && dy === 0 ? pieces : pieces.map((piece) => shiftPiece(piece, dx, dy)), width: widthOver(unflared, measure) };
  };

  // Everything the cue ever draws (the hero's 1.08 swell, the swelling box, the readout beyond a short
  // word) must fit the safe width too: shrink until it does, a few steps of an almost linear function.
  let fit = firstFit;
  for (let attempt = 0; ; attempt++) {
    const result = layout(fit);
    if (attempt >= 5 || result.width <= space.safe.x2 - space.safe.x1 + 0.5) return result.pieces;
    fit *= ((space.safe.x2 - space.safe.x1) / result.width) * 0.998;
  }
}

/** Width of everything the pieces ever draw, canvas px (the union of their boxes every 16 ms). */
function widthOver(pieces: readonly Piece[], measure: Measure): number {
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  const from = Math.min(...pieces.map((piece) => piece.fromMs));
  const to = Math.max(...pieces.map((piece) => piece.toMs));
  for (let ms = from; ms < to; ms += 16) {
    const box = sceneBoundsAt(pieces, ms, measure);
    if (!box) continue;
    left = Math.min(left, box.x1);
    right = Math.max(right, box.x2);
  }
  return Number.isFinite(left) ? right - left : 0;
}

function indices(from: number, to: number): number[] {
  return Array.from({ length: to - from }, (_, at) => from + at);
}

export const trackProgram: SceneProgram = {
  build(input) {
    return { pieces: input.cues.flatMap((cue, number) => buildCue(cue, input, number)) };
  },
};

/** Used by the tests: the sample's two-part linear move (progress 0..1 in, progress 0..1 out). */
export const trackMove = mv;

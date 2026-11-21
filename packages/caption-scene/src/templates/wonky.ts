import type { DemoScript } from "../demo";
import { EASES, clamp, prog } from "../ease";
import type { SceneCue, SceneInput, SceneProgram } from "../input";
import { balancedRows, clampToSafeArea, cueDirection, rowVisualOrder, rowWidth, sceneSpace } from "../layout";
import { sampleFrames } from "../frames";
import type { PathCmd, Piece, ShapePiece, TextPiece, Track } from "../scene";
import { ellipsePath, pathBounds } from "../shapes";

/**
 * Wonky (`samples/templates/m01-wonky.js`, the sample's "Candy"): chunky rounded caps, every row on its own tilt with a
 * hard purple extrusion under it. The hero row is the biggest, in mint or pink, its letters bouncing up one by one onto a
 * wobbly baseline, and a flat sticker (flower, sparkle, scalloped badge, blob, donut) pops beside it. Rows are Rubik Black
 * (the sample's `Rubik:wght@900`), centred on y 1280, each row a flex line of words 0.22 em apart, tipped about its own
 * centre; the extrusion is the text-shadow `0.55e e 0 purple` with `e = max(5, 0.05 size)` and a soft lift `0 1.6e 3.4e`.
 *
 * What differs from the sample, and why (gallery-2 brief, 2026-11-21):
 * - The sample's `LINES`, `rowsOf`, `PLAN`, `TILTS` and `SHIFTS` are tables for its five demo cues. Rows now come from the
 *   words (a hero span is its own big row, the words before and after wrap evenly into body rows, a cue with no hero and
 *   three or more words takes two rows). Tilt alternates by row and cue (the demo's pattern), its size (3 to 5 degrees)
 *   and the row's sideways shift (18 to 46 px, none for a lone row) come from a seeded hash of the cue's text; the shift
 *   never takes a row past the safe area. The stickers cycle by counter: a hero cue takes flower/sparkle, blob/donut,
 *   sparkle/badge, badge/flower, donut/blob (the demo's four plans, then a fifth) on alternating sides, a cue with no hero
 *   takes one accent sticker (sparkle, donut, flower, badge, blob) so every cue has one. Hero colour alternates mint and
 *   pink by hero-cue count, not by cue index. Sticker size and spin get a small hash jitter.
 * - Fit: a row wider than 780 px shrinks to fit; a lone long word that would drop under 0.62 of its size may use the
 *   safe width instead; a stack too tall for the frame (16:9) shrinks as a whole. A sticker is placed at the hero row (or
 *   the last row) as the sample does, then kept inside the safe area, size and spring overshoot counted.
 * - The hero's per-letter rise runs only for Latin, Greek and Cyrillic words of up to 24 letters; any other script
 *   (Arabic, Urdu, Devanagari, Thai, CJK, Hebrew) rises as one word with the same motion. Upper case applies to those
 *   cased scripts only. Right-to-left cues run right to left and their stickers swap sides.
 * - Real speech: the sample's exit (130 ms, ending 80 ms before the next cue) never starts before the last word has
 *   been fully visible for 150 ms, and is shortened (down to 70 ms) rather than cutting an entrance when the next cue is
 *   close. Rows enter on their own words (a piece only exists from its word's rise), where the sample lights the whole
 *   block 140 ms before the cue.
 * - Stickers keep the sample's slow spin for the whole hold (4.5 to 6 degrees a second), a cheap idle motion.
 */

export const WONKY_DEMO: DemoScript = {
  lines: [
    "nobody cares:h@560 at:m first",
    "so:m keep posting",
    "the:m first:b hundred:h@600 are:m practice",
    "then:b it:m clicks:h@560",
    "promise:h@620+420",
  ],
  options: { rate: 270, cueGap: 150, tail: 760 },
};

const FACE = "Rubik Black" as const;
const LETTER_SPACING = -0.01;
const GAP_EM = 0.22;
const CY = 1280;
const MAX_W = 780;
const HERO_MAX = 236;
const BODY_MAX = 128;
const PLAIN_MAX = 156;
/** A row that would shrink below this share of its size may use the safe width instead. */
const SHRINK_FLOOR = 0.62;
/** A hero cue's lead or tail row keeps one row when it fits at 0.72 of its size (the sample shrinks "are practice" to 0.80). */
const SHRINK_ONE_ROW = 0.72;
const EXTRUDE = "#7B2FF7";
const SOFT = "#140828";
const SOFT_ALPHA = 0.42;
const STICKER_YELLOW = "#FFE23D";
const STICKER_PINK = "#FF7AD9";
const STICKER_MINT = "#4CF59A";
const STICKER_PURPLE = "#7B2FF7";
const EXIT_MS = 130;
const EXIT_MIN_MS = 70;
const EXIT_END_MS = 80;
/** A word stays fully visible this long before the cue's exit may begin. */
const HOLD_MS = 150;
/** How far a cue's exit may run into the next cue's entrance. */
const OVERLAP_MS = 60;
const RISE_MS = 300;
const POP_MS = 380;
const SPRING_PEAK = 1.15;
const MAX_LETTERS = 24;

// --- helpers ---------------------------------------------------------------------------

/** Rubik's `line-height: 1` baseline in Chrome: the ascent (0.935 em) and descent (0.25 em) round to whole px. */
export function wonkyBaseline(sizePx: number): number {
  const ascent = Math.round(0.935 * sizePx);
  const descent = Math.round(0.25 * sizePx);
  return (sizePx - (ascent + descent)) / 2 + ascent;
}

/** The sample's `ease.outBack(p, s)`: the overshoot is a parameter (2 for a word, 2.4 for a hero letter). */
export const wonkyOutBack = (p: number, s: number): number => 1 + (s + 1) * (p - 1) ** 3 + s * (p - 1) ** 2;

/** FNV-1a, 32 bit: the seed of a cue's jitter, from its text and index (never `Math.random`). */
export function wonkyHash(text: string): number {
  let h = 0x811c9dc5;
  for (let at = 0; at < text.length; at++) {
    h ^= text.charCodeAt(at);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** The sample's seeded generator (mulberry32). */
export function wonkyRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CASED = /^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{N}\p{P}\p{S}\p{M}\s]+$/u;
const SPLITTABLE = /^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{N}\p{P}\p{S}]+$/u;

/** `text-transform: uppercase`, for the scripts that have case only. */
export const wonkyDisplay = (text: string): string => (CASED.test(text) ? text.toUpperCase() : text);

/** A hero word's letters, or null when it must move as one word (shaped scripts, CJK, very long words). */
export function wonkyLetters(text: string): string[] | null {
  if (!SPLITTABLE.test(text)) return null;
  const letters = typeof Intl !== "undefined" && "Segmenter" in Intl ? [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((part) => part.segment) : [...text];
  return letters.length >= 1 && letters.length <= MAX_LETTERS ? letters : null;
}

// --- stickers: flat single-colour vector shapes -------------------------------------------

/** A quadratic segment as the cubic through the same curve. */
function quad(from: readonly [number, number], control: readonly [number, number], to: readonly [number, number]): PathCmd {
  return ["C", from[0] + (2 / 3) * (control[0] - from[0]), from[1] + (2 / 3) * (control[1] - from[1]), to[0] + (2 / 3) * (control[0] - to[0]), to[1] + (2 / 3) * (control[1] - to[1]), to[0], to[1]];
}

const fixed = (value: number) => Math.round(value * 10) / 10;

function flowerPath(r: number, petals = 8): PathCmd[] {
  const n = petals * 2;
  const out: PathCmd[] = [];
  let at: [number, number] = [0, 0];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rr = i % 2 === 0 ? r : r * 0.62;
    const point: [number, number] = [fixed(Math.cos(a) * rr), fixed(Math.sin(a) * rr)];
    if (i === 0) out.push(["M", point[0], point[1]]);
    else {
      const am = ((i - 0.5) / n) * Math.PI * 2;
      const rm = i % 2 === 0 ? r * 1.02 : r * 0.98;
      out.push(quad(at, [fixed(Math.cos(am) * rm * 1.08), fixed(Math.sin(am) * rm * 1.08)], point));
    }
    at = point;
  }
  return [...out, ["Z"]];
}

function sparkleShape(r: number): PathCmd[] {
  const k = r * 0.16;
  return [
    ["M", 0, -r],
    ["C", k, -k, k, -k, r, 0],
    ["C", k, k, k, k, 0, r],
    ["C", -k, k, -k, k, -r, 0],
    ["C", -k, -k, -k, -k, 0, -r],
    ["Z"],
  ];
}

function blobPath(rx: number, ry: number): PathCmd[] {
  const n = 36;
  const out: PathCmd[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const w = 1 + 0.07 * Math.sin(3 * a + 0.6) + 0.04 * Math.sin(5 * a + 1.9);
    out.push([i === 0 ? "M" : "L", fixed(Math.cos(a) * rx * w), fixed(Math.sin(a) * ry * w)] as PathCmd);
  }
  return [...out, ["Z"]];
}

function scallopPath(r: number, bumps: number): PathCmd[] {
  const out: PathCmd[] = [];
  let at: [number, number] = [0, 0];
  for (let i = 0; i <= bumps; i++) {
    const a = (i / bumps) * Math.PI * 2;
    const point: [number, number] = [fixed(Math.cos(a) * r * 0.9), fixed(Math.sin(a) * r * 0.9)];
    if (i === 0) out.push(["M", point[0], point[1]]);
    else {
      const am = ((i - 0.5) / bumps) * Math.PI * 2;
      out.push(quad(at, [fixed(Math.cos(am) * r * 1.16), fixed(Math.sin(am) * r * 1.16)], point));
    }
    at = point;
  }
  return [...out, ["Z"]];
}

export type WonkyStickerKind = "flower" | "sparkle" | "badge" | "blob" | "donut";

interface StickerSpec {
  /** The sample's `box` (a layout box around the drawing, used to place it beside a row). */
  readonly box: number;
  readonly path: readonly PathCmd[];
  readonly colour: string;
  /** A ring (the donut): stroked, not filled. */
  readonly stroke?: number;
}

/** The sample's five stickers, in its own px, centred on (0, 0). */
export const WONKY_STICKERS: Readonly<Record<WonkyStickerKind, StickerSpec>> = {
  flower: { box: 190, path: flowerPath(88), colour: STICKER_PINK },
  sparkle: { box: 150, path: sparkleShape(70), colour: STICKER_MINT },
  badge: { box: 190, path: scallopPath(84, 14), colour: STICKER_YELLOW },
  blob: { box: 230, path: blobPath(104, 62), colour: STICKER_PURPLE },
  donut: { box: 150, path: ellipsePath(0, 0, 50), colour: STICKER_PINK, stroke: 30 },
};

/** The hero cue's stickers in turn (main beside the hero, accent on the other side): the demo's four plans, then a fifth. */
const HERO_MAIN: readonly WonkyStickerKind[] = ["flower", "blob", "sparkle", "badge", "donut"];
const HERO_ACCENT: readonly WonkyStickerKind[] = ["sparkle", "donut", "badge", "flower", "blob"];
/** A cue with no hero has one accent sticker. */
const PLAIN_ACCENT: readonly WonkyStickerKind[] = ["sparkle", "donut", "flower", "badge", "blob"];

const scalePath = (path: readonly PathCmd[], by: number, dx = 0, dy = 0): PathCmd[] =>
  path.map((command) => {
    if (command[0] === "Z") return command;
    const out: number[] = [];
    for (let at = 1; at < command.length; at += 2) out.push((command[at] as number) * by + dx, (command[at + 1] as number) * by + dy);
    return [command[0], ...out] as unknown as PathCmd;
  });

// --- layout and motion ------------------------------------------------------------------

interface RowPlan {
  /** Logical word indices of the row. */
  readonly indices: number[];
  readonly hero: boolean;
  readonly base: number;
}

interface WordBox {
  readonly index: number;
  readonly left: number;
  readonly width: number;
  readonly letters: { text: string; left: number; width: number }[] | null;
}

interface RowGeo {
  readonly plan: RowPlan;
  /** Sample px. */
  readonly size: number;
  /** Canvas px. */
  readonly sizeC: number;
  readonly width: number;
  readonly top: number;
  readonly p0x: number;
  readonly p0y: number;
  readonly tilt: number;
  readonly shift: number;
  readonly words: WordBox[];
}

/** Two rows of the cue's words at the cut that makes them most even, for a cue with no hero that would fit one row. */
function splitInTwo(widths: readonly number[], gap: number): number[][] {
  let best = 1;
  let bestCost = Number.POSITIVE_INFINITY;
  for (let cut = 1; cut < widths.length; cut++) {
    const a = rowWidth(widths, widths.slice(0, cut).map((_, at) => at), gap);
    const b = rowWidth(widths, widths.slice(cut).map((_, at) => cut + at), gap);
    const cost = a * a + b * b;
    if (cost < bestCost) {
      bestCost = cost;
      best = cut;
    }
  }
  return [widths.slice(0, best).map((_, at) => at), widths.slice(best).map((_, at) => best + at)];
}

function buildCue(cue: SceneCue, cueNumber: number, counters: { hero: number; plain: number }, input: SceneInput): Piece[] {
  const space = sceneSpace(input, CY);
  const { u } = space;
  const rtl = cueDirection(cue) === "rtl";
  const seed = wonkyHash(`${cue.index}|${cue.words.map((word) => word.text).join(" ")}`);
  const rng = wonkyRng(seed);
  const letterRng = wonkyRng(seed ^ 0x9e3779b9);
  const texts = cue.words.map((word) => wonkyDisplay(word.text));
  const hasHero = cue.words.some((word) => word.role === "hero");
  const letters = cue.words.map((word, at) => (word.role === "hero" ? wonkyLetters(texts[at]!) : null));
  const heroCounter = hasHero ? counters.hero++ : 0;
  const plainCounter = hasHero ? 0 : counters.plain++;
  const heroFill = heroCounter % 2 === 0 ? input.colours.highlight : input.colours.accent;
  const band = cueNumber * 24;
  const lp = (size: number) => size * u;

  /** A word's CSS box: its advance plus the letter spacing after every character (letters of a hero are their own boxes). */
  const wordWidth = (at: number, sizeC: number) =>
    letters[at]
      ? letters[at]!.reduce((sum, letter) => sum + input.measure(letter, FACE, sizeC, LETTER_SPACING).advance + LETTER_SPACING * sizeC, 0)
      : input.measure(texts[at]!, FACE, sizeC, LETTER_SPACING).advance + LETTER_SPACING * sizeC;

  // The widest a row may be: the sample's 780, and never more than the safe width less room for the tilt and the shift.
  const hardLimit = (space.safe.x2 - space.safe.x1) / u - 90;
  const limit = Math.min(MAX_W, hardLimit);

  // --- rows ---
  const segments: { hero: boolean; indices: number[] }[] = [];
  cue.words.forEach((word, at) => {
    const hero = word.role === "hero";
    const last = segments[segments.length - 1];
    if (last && last.hero === hero) last.indices.push(at);
    else segments.push({ hero, indices: [at] });
  });
  const plans: RowPlan[] = [];
  for (const segment of segments) {
    const base = segment.hero ? HERO_MAX : hasHero ? BODY_MAX : PLAIN_MAX;
    const widths = segment.indices.map((at) => wordWidth(at, lp(base)));
    const gap = GAP_EM * lp(base);
    let rows = balancedRows(widths, gap, lp(limit));
    // A lead or tail (the sample's "are practice") stays one row when shrinking it a little is enough.
    if (hasHero && rows.length > 1 && rowWidth(widths, widths.map((_, at) => at), gap) * SHRINK_ONE_ROW <= lp(limit)) rows = [widths.map((_, at) => at)];
    if (!hasHero && rows.length === 1 && widths.length >= 3) rows = splitInTwo(widths, gap);
    for (const row of rows) plans.push({ indices: row.map((at) => segment.indices[at]!), hero: segment.hero, base });
  }

  /** Rows at scale `k`: sizes fitted, then stacked and centred on the anchor line. */
  const layout = (k: number): { rows: RowGeo[]; height: number } => {
    const sized = plans.map((plan) => {
      let size = plan.base * k;
      const natural = (s: number) => rowWidth(plan.indices.map((at) => wordWidth(at, lp(s))), plan.indices.map((at) => wordWidth(at, lp(s))).map((_, i) => i), GAP_EM * lp(s)) / u;
      let width = natural(size);
      if (width > limit) {
        size *= limit / width;
        if (size < SHRINK_FLOOR * plan.base * k) size = Math.min(plan.base * k, plan.base * k * (hardLimit / width));
        // A second pass: widths are not exactly linear in size.
        width = natural(size);
        const bound = size < SHRINK_FLOOR * plan.base * k ? hardLimit : limit;
        if (width > bound) size *= bound / width;
      }
      return { plan, size };
    });
    const margin = (hero: boolean, size: number) => (hero ? 0.02 * size : 0);
    const height = sized.reduce((sum, row) => sum + row.size + margin(row.plan.hero, row.size), 0);
    let top = space.y(CY) - lp(height) / 2;
    const rows: RowGeo[] = sized.map(({ plan, size }, ri) => {
      const sizeC = lp(size);
      top += lp(margin(plan.hero, size));
      const gap = GAP_EM * sizeC;
      const order = rowVisualOrder(plan.indices.map((at) => texts[at]!), rtl ? "rtl" : "ltr").map((at) => plan.indices[at]!);
      const widths = order.map((at) => wordWidth(at, sizeC));
      const width = widths.reduce((sum, w) => sum + w, 0) + gap * (order.length - 1);
      // Tilt alternates by row and cue (the demo's -, +, - then +, - pattern); its size and the shift come from the hash.
      const sign = (cueNumber + ri) % 2 === 0 ? -1 : 1;
      const tilt = sign * (3 + Math.round(rng() * 4) / 2);
      const wanted = plans.length === 1 ? 0 : sign * (18 + Math.round(rng() * 28));
      const rad = (Math.abs(tilt) * Math.PI) / 180;
      const reach = (width / 2) * Math.cos(rad) + (sizeC / 2) * Math.sin(rad) + 0.12 * sizeC;
      const room = Math.max(0, (space.safe.x2 - space.safe.x1) / 2 - reach);
      const shift = Math.sign(wanted) * Math.min(Math.abs(wanted) * u, room);
      let left = space.x(540) - width / 2;
      const words: WordBox[] = order.map((at, position) => {
        const box: WordBox = {
          index: at,
          left,
          width: widths[position]!,
          letters: letters[at]
            ? (() => {
                let x = left;
                return letters[at]!.map((text) => {
                  const w = input.measure(text, FACE, sizeC, LETTER_SPACING).advance + LETTER_SPACING * sizeC;
                  const letter = { text, left: x, width: w };
                  x += w;
                  return letter;
                });
              })()
            : null,
        };
        left += widths[position]! + gap;
        return box;
      });
      const geo: RowGeo = { plan, size, sizeC, width, top, p0x: space.x(540), p0y: top + sizeC / 2, tilt, shift, words };
      top += sizeC;
      return geo;
    });
    return { rows, height };
  };

  // A stack too tall for the frame (16:9) shrinks as a whole, floor 0.5.
  const availableHeight = (space.safe.y2 - space.safe.y1) / u - 40;
  let fitted = layout(1);
  if (fitted.height * 1.12 > availableHeight) fitted = layout(Math.max(0.5, availableHeight / (fitted.height * 1.12)));
  const { rows } = fitted;

  // --- exit: the sample's 130 ms ending 80 ms before the cue's end, held until the last word has been seen for 150 ms ---
  const landOf = (at: number): number => {
    const word = cue.words[at]!;
    const n = letters[at]?.length ?? 1;
    return word.role === "hero" ? word.startMs - 110 + (n - 1) * Math.min(20, 110 / n) + 60 : word.startMs - 70 + RISE_MS / 3;
  };
  const lastLand = Math.max(...cue.words.map((_, at) => landOf(at)));
  // ... but never so late that it runs more than 60 ms into the next cue: with a word only 100 ms long the hold gives way.
  const exitStart = Math.min(Math.max(cue.endMs - EXIT_END_MS - EXIT_MS, lastLand + HOLD_MS), cue.endMs + OVERLAP_MS - EXIT_MIN_MS);
  const exitMs = clamp(cue.endMs - EXIT_END_MS - exitStart, EXIT_MIN_MS, EXIT_MS);
  const exitEnd = exitStart + exitMs;
  const out = (t: number) => EASES.in(prog(t, exitStart, exitMs));

  interface Own {
    dy: number;
    rot: number;
    s: number;
    o: number;
  }
  /** A piece's pose in the canvas: the row's transform (translate, rotate, scale about the row centre) applied to the piece's own. */
  const poseIn = (row: RowGeo, cx: number, cy: number, own: Own, t: number) => {
    const e = out(t);
    const angle = ((row.tilt * (1 + 0.6 * e)) * Math.PI) / 180;
    const k = 1 - 0.14 * e;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const rx = cx - row.p0x;
    const ry = cy - row.p0y + own.dy;
    return {
      x: row.p0x + row.shift + k * (rx * c - ry * s),
      y: row.p0y + e * lp(46) + k * (rx * s + ry * c),
      rz: row.tilt * (1 + 0.6 * e) + own.rot,
      s: k * own.s,
      o: own.o * (1 - e),
    };
  };
  const trackOf = (pose: (t: number) => ReturnType<typeof poseIn>, from: number, to: number, edges: readonly number[]): Track => {
    const channel = (pick: (p: ReturnType<typeof poseIn>) => number, tolerance: number) =>
      sampleFrames((t) => pick(pose(t)), [from, ...edges, to], tolerance, { range: [from, to], wholeMs: true, simplify: true });
    const scale = channel((p) => p.s, 0.002);
    return { x: channel((p) => p.x, 0.2), y: channel((p) => p.y, 0.2), rz: channel((p) => p.rz, 0.08), sx: scale, sy: scale, o: channel((p) => p.o, 0.008) };
  };

  // --- words ---
  const pieces: Piece[] = [];
  rows.forEach((row, ri) => {
    const sizeC = row.sizeC;
    const e = Math.max(lp(5), sizeC * 0.05);
    const shadows = [
      { dx: 0.55 * e, dy: e, blur: 0, colour: EXTRUDE, alpha: 1 },
      { dx: 0, dy: 1.6 * e, blur: 1.7 * e, colour: SOFT, alpha: SOFT_ALPHA },
    ];
    const baseline = row.top + wonkyBaseline(sizeC);
    const cy = row.top + sizeC / 2;
    const z = band + 1 + Math.min(ri, 20);
    for (const word of row.words) {
      const source = cue.words[word.index]!;
      const hero = source.role === "hero";
      const pieceBase = (id: string, text: string, left: number, width: number, own: (t: number) => Own, from: number, riseEnd: number): TextPiece => {
        const cx = left + width / 2;
        const to = Math.max(exitEnd, from + 2);
        return {
          id: `wonky:${cueNumber}:${id}`,
          kind: "text",
          z,
          fromMs: from,
          toMs: to,
          track: trackOf((t) => poseIn(row, cx, cy, own(t), t), from, to, [riseEnd, exitStart, exitEnd]),
          origin: { dx: width / 2, dy: cy - baseline },
          text,
          face: FACE,
          sizePx: sizeC,
          letterSpacingEm: LETTER_SPACING,
          fill: hero ? heroFill : input.colours.primary,
          shadows,
          anchor: "baseline-left",
          language: cue.language,
        };
      };
      if (!hero) {
        const start = source.startMs - 70;
        pieces.push(
          pieceBase(`w${word.index}`, texts[word.index]!, word.left, word.width, (t) => {
            const p = prog(t, start, RISE_MS);
            return { dy: (1 - wonkyOutBack(p, 2)) * 0.5 * sizeC, rot: (1 - EASES.out(p)) * 9, s: 1, o: clamp(p * 3) };
          }, start, start + RISE_MS),
        );
        continue;
      }
      // Hero: letters bounce up one at a time onto a wobbly baseline (one piece for a word that cannot be split).
      const parts = word.letters ?? [{ text: texts[word.index]!, left: word.left, width: word.width }];
      const n = parts.length;
      const stagger = Math.min(20, 110 / n);
      parts.forEach((part, li) => {
        const dy = (letterRng() - 0.5) * 0.11;
        const rot = (letterRng() - 0.5) * 11;
        const start = source.startMs - 110 + li * stagger;
        pieces.push(
          pieceBase(`w${word.index}${word.letters ? `l${li}` : ""}`, part.text, part.left, part.width, (t) => {
            const p = prog(t, start, RISE_MS);
            const up = wonkyOutBack(p, 2.4);
            return { dy: ((1 - up) * 0.45 + dy) * sizeC, rot: rot + (1 - EASES.out(p)) * (li % 2 ? 14 : -14), s: 0.5 + 0.5 * EASES.out(p), o: clamp(p * 5) };
          }, start, start + RISE_MS),
        );
      });
    }
  });

  // --- stickers ---
  const heroRow = rows.find((row) => row.plan.hero) ?? rows[0]!;
  const lastRow = rows[rows.length - 1]!;
  const heroWord = cue.words.find((word) => word.role === "hero") ?? null;
  const side = hasHero ? (heroCounter % 2 === 0 ? 1 : -1) : plainCounter % 2 === 0 ? -1 : 1;
  const mirror = rtl ? -1 : 1;
  const placeSticker = (kind: WonkyStickerKind, id: string, rowOf: RowGeo, towards: number, scale: number, dyRow: number, at: number, spin: number, offsetBox: number) => {
    const spec = WONKY_STICKERS[kind];
    const k = scale * u;
    const raw = scalePath(spec.path, k);
    const bounds = pathBounds(raw);
    const strokeC = (spec.stroke ?? 0) * k;
    // The sticker turns, so keep its circumscribed radius (the sample's clamp, `box * 0.42`, is about that) inside the safe area.
    const radius = Math.hypot(Math.max(Math.abs(bounds.x1), Math.abs(bounds.x2)), Math.max(Math.abs(bounds.y1), Math.abs(bounds.y2))) + strokeC / 2;
    const half = { x: radius, y: radius };
    const boxC = spec.box * k;
    const wanted = {
      x: rowOf.p0x + rowOf.shift + towards * mirror * (rowOf.width / 2 + boxC * offsetBox),
      y: dyRow,
    };
    const x = clamp(wanted.x, space.safe.x1 + half.x * SPRING_PEAK, space.safe.x2 - half.x * SPRING_PEAK);
    const y = clamp(wanted.y, space.safe.y1 + half.y * SPRING_PEAK, space.safe.y2 - half.y * SPRING_PEAK);
    const from = at + 4;
    if (exitEnd <= from + 60) return;
    const popEnd = at + POP_MS;
    const rotAt = (t: number) => {
      const p = prog(t, at, POP_MS);
      const held = Math.max(0, t - at - POP_MS) / 1000;
      return (1 - EASES.outExpo(p)) * -side * mirror * 70 + spin * 0.25 + held * spin * 0.25;
    };
    const scaleAt = (t: number) => Math.max(0, EASES.spring(prog(t, at, POP_MS)) * (1 - out(t)));
    const edges = [popEnd, exitStart, exitEnd];
    const sample = (fn: (t: number) => number, tolerance: number) => sampleFrames(fn, [from, ...edges, exitEnd], tolerance, { range: [from, exitEnd], wholeMs: true, simplify: true });
    const scaleFrames = sample(scaleAt, 0.002);
    const sticker: ShapePiece = {
      id: `wonky:${cueNumber}:${id}`,
      kind: "shape",
      z: band,
      fromMs: from,
      toMs: exitEnd,
      track: { x: [[from, x]], y: sample((t) => y + out(t) * lp(30), 0.2), rz: sample(rotAt, 0.08), sx: scaleFrames, sy: scaleFrames },
      origin: { dx: -bounds.x1, dy: -bounds.y1 },
      path: scalePath(raw, 1, -bounds.x1, -bounds.y1),
      ...(spec.stroke
        ? { stroke: { widthPx: strokeC, colour: spec.colour } }
        : { fill: { colour: spec.colour } }),
      shadows: [{ dx: 0, dy: lp(8), blur: lp(7), colour: SOFT, alpha: SOFT_ALPHA }],
    };
    pieces.push(sticker);
  };
  const jitter = () => 0.9 + 0.2 * rng();
  const spinSize = () => 16 + 10 * rng();
  if (hasHero && heroWord) {
    // Beside the hero row, near its top, on this cue's side.
    placeSticker(HERO_MAIN[heroCounter % HERO_MAIN.length]!, "st0", heroRow, side, 1.3 * jitter(), heroRow.top + heroRow.sizeC * 0.05, heroWord.startMs - 110, side * spinSize(), 0.22);
  }
  {
    // The accent: the other side, low on the last row; a lone row drops it 100 px.
    const kind = hasHero ? HERO_ACCENT[heroCounter % HERO_ACCENT.length]! : PLAIN_ACCENT[plainCounter % PLAIN_ACCENT.length]!;
    const first = Math.min(...lastRow.words.map((word) => cue.words[word.index]!.startMs));
    const y = lastRow.top + lastRow.sizeC * 0.55 + (rows.length === 1 ? lp(100) : 0);
    placeSticker(kind, "st1", lastRow, -side, 0.8 * jitter(), y, first - 60, -side * (24 + 6 * rng() - 3), 0.18);
  }

  return clampToSafeArea(pieces, space.safe, input.measure);
}

export const wonkyProgram: SceneProgram = {
  build(input) {
    const counters = { hero: 0, plain: 0 };
    return { pieces: input.cues.flatMap((cue, number) => (cue.words.length === 0 ? [] : buildCue(cue, number, counters, input))) };
  },
};

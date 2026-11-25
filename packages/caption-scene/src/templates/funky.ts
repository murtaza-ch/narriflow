import { CAPTION_SCENE_BRAND_MIN_CONTRAST, type CaptionFontName, captionColourContrast, captionFontFace, captionSceneMeta } from "@narriflow/validators";
import type { DemoScript } from "../demo";
import { clamp, type Ease, ease, type Frames, lerp, prog } from "../ease";
import { exportFrameTimes, paintedFrameCount } from "../frame-grid";
import { sampleFrames } from "../frames";
import { balancedRows, rowsFromRoles, rowVisualOrder } from "../layout";
import { type Box, type PathCmd, type Piece, SCENE_PIECE_BUDGET, type Shadow, type TextPiece } from "../scene";
import { ellipsePath, polygonPath } from "../shapes";
import { caps, galleryScene } from "./gallery-layout";
import type { SpeechCell } from "./speech-layout";

/**
 * Funky (`samples/templates/m71-funky.js`, after Motion Array "Fun Colorful Titles"): every letter is its own bright colour in
 * its own heavy display face, outlined in dark with a chunky offset colour shadow. Ordinary words pop in whole; the key word's
 * letters tumble in scattered and lock up into a slightly crooked lockup while confetti twinkles around the block.
 *
 * Changes from the sample, and why (Sol's gallery 6 review, 2026-11-25, and the owner's "fix the demos"):
 * - **Faces we bundle.** The sample's ten faces include four we do not ship (Bowlby One, Sigmar One, Climate Crisis, Rammetto One).
 *   Six clearly different silhouettes stand in: Chango (very wide and round), Luckiest Guy (narrow comic), Titan One (round),
 *   Dela Gothic One (wide gothic), Alfa Slab One (slab serif) and Caprasimo (soft serif). The sample picked a face by
 *   `seed * 3 + i * 7 + (i % 2) * 3` modulo ten, and the odd-letter adjustment added a full ten, so neighbouring letters often
 *   shared a face. A letter now never repeats either of the two letters before it (across word borders too): it takes the
 *   least used of the rest, ties broken by a hash of the cue and word.
 * - **One cap height, one baseline, ink-measured pairs.** Every letter is sized from its own face's cap height so all letters
 *   stand exactly as tall on one baseline. The gap between two letters is set from the glyphs' measured ink bearings (read from
 *   the font files with HarfBuzz into `BEARINGS`), not the advance boxes, so Chango's wide sidebearings and Luckiest Guy's
 *   overhangs both leave the same 0.09 cap of ink between letters.
 * - **No remnants under the next cue.** Every piece of a cue, the confetti included, ends at the same cutoff (the shared window)
 *   and fades with the same exit, so nothing of the last cue is left under the next words (the sample's confetti and letters
 *   set their own visibility and could outlive the parent).
 * - **Readable at onset, a smaller tumble.** The sample's letters appeared 32 ms apart and spun up to 150 degrees, so a
 *   12-letter key word finished 312 ms late and could hit the next row. Every letter now paints on the word's first spoken frame
 *   and settles from a scatter of at most 24 degrees, 0.2 cap across and 0.14 cap down, with a 45 ms total stagger and a 145 ms
 *   ease-out settle (a word too short for that settles by its last painted frame, and a word with a single painted frame is
 *   simply there). A key word of more than eight letters, and every ordinary word, pops as one: all of its letters share one
 *   scale and one turn about the word's centre (a long word broken across rows pops row by row).
 * - **Confetti in free space.** The sample's confetti (twelve pieces) landed on the F and on neighbouring words. Four (six on a
 *   key-word cue) are searched for in free space, 16 px clear of every word's ink, outline, shadow and tumble, and a piece with
 *   no spot is left out. They sit behind the faces, pop in with the key word, twinkle for the hold, and stop at their last
 *   twinkle so the exit never restarts them.
 * - **Rows and words follow speech.** The sample's rows were baked into `breaks`. Rows come from the roles (words before the key
 *   word, the key word, the words after); each row fits the 900 px column by itself, so a long key word no longer shrinks the
 *   support words; a word that would shrink below 62 % to fit is broken across rows at a readable size (the fewest rows, the
 *   measured widths balanced); the whole block is fitted to the band by height, so a tall cue (Devanagari, nine words) keeps
 *   every row clear of the next.
 * - **Every language.** A word that is not plain Latin letters, digits and common punctuation (Devanagari, Arabic, Cyrillic,
 *   accented Latin) is drawn whole in one shaped run, in the fallback face when the display face lacks it, carrying the palette
 *   in one colour per word, with the same outline, shadow and pop. Right-to-left rows are ordered by the shared bidi code.
 * - **Colours.** The face colours are the style's seven; the preset's primary, highlight and accent replace the white, yellow
 *   and pink, each kept at 3:1 against the dark outline it is drawn on or replaced by the style's own (the catalogue `readsOn`
 *   keeps the same pair off the brand picker). The violet is lighter than the sample's so it holds on dark footage.
 * - Extra recurring beats, in the sample's candy language, on every cue: a hop runs across the key word's letters (the last
 *   word's, on a cue without one), again every 1.3 s of a long hold, and a wavy squiggle is drawn on beside the block in the
 *   next palette colour (left out when no free spot is left).
 */

export const FUNKY_DEMO: DemoScript = {
  lines: [
    "this:m is:m so:b funky:h@720",
    "keep:b it:m simple:b",
    "good:b vibes:h@660",
    "do:m what:b you:m love:h@680",
    "easy:b come:b go:h@600",
  ],
  options: { rate: 255, cueGap: 150, tail: 900, lead: 400 },
};

type Face = Extract<CaptionFontName, "Chango" | "Luckiest Guy" | "Titan One" | "Dela Gothic One" | "Alfa Slab One" | "Caprasimo">;
const FACES: readonly Face[] = ["Chango", "Luckiest Guy", "Titan One", "Dela Gothic One", "Alfa Slab One", "Caprasimo"];
/** The face a word that cannot be lettered draws in (its glyph-coverage fallback takes over for scripts it lacks). */
const WHOLE_FACE: Face = "Luckiest Guy";

/** The glyphs `BEARINGS` holds, in order. */
const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'!?.,&-";
/** Left and right side bearing of each glyph's ink in thousandths of an em, measured with HarfBuzz from the bundled font files. */
const BEARING_DATA: Readonly<Record<Face, string>> = {
  Chango: "35 35,56 38,24 34,58 36,56 36,56 27,40 60,60 60,60 60,34 62,56 24,56 13,48 60,60 52,40 40,56 37,36 37,56 39,38 30,35 35,38 40,30 36,33 57,35 36,30 48,37 33,40 40,40 50,70 30,50 48,50 50,61 60,60 50,60 50,40 40,50 60,80 80,60 60,20 80,60 60,49 60,60 70,80 81",
  "Luckiest Guy": "-16 -15,26 1,7 6,21 4,21 -8,21 0,4 12,21 21,29 9,-7 19,21 -30,22 -2,24 11,20 15,8 9,26 2,4 10,21 9,13 6,3 2,16 14,-19 -9,2 2,-22 -24,6 -45,6 15,14 14,-15 22,14 17,9 17,0 18,13 10,16 8,9 13,14 14,13 16,6 -9,25 15,20 21,9 8,8 9,3 -13,32 33",
  "Titan One": "10 10,40 30,30 30,40 30,40 30,40 30,30 30,40 40,40 40,10 40,40 15,40 20,40 40,40 40,25 25,40 25,20 20,40 10,25 25,20 20,40 40,10 10,10 10,10 10,10 10,20 20,30 30,15 40,30 30,30 30,15 40,30 30,30 30,10 10,30 30,30 30,30 30,31 30,20 30,40 40,40 40,30 15,30 30",
  "Dela Gothic One": "0 13,40 40,40 40,40 40,40 40,40 40,40 40,40 40,40 40,40 40,40 40,40 40,40 40,40 40,40 40,40 40,40 40,40 40,40 40,40 40,38 40,0 13,40 40,0 13,0 13,40 40,40 40,40 13,40 40,41 40,40 40,40 40,40 40,40 13,40 40,40 40,30 30,30 30,30 30,30 30,30 30,10 10,30 30",
  "Alfa Slab One": "12 12,20 12,14 18,20 14,20 18,20 14,14 8,20 20,20 20,12 18,20 16,20 14,20 20,20 18,14 14,20 14,14 16,20 16,8 8,14 14,16 16,12 12,12 12,14 14,12 12,14 14,14 14,14 34,12 23,14 12,18 18,22 14,18 8,10 10,10 10,10 16,25 25,20 20,14 10,40 48,40 48,16 14,34 34",
  Caprasimo: "30 34,30 6,34 33,41 28,45 20,45 14,34 29,20 19,21 21,29 45,41 9,33 5,-2 -2,26 28,34 34,19 6,34 6,33 14,44 32,14 13,20 13,23 13,-4 -15,25 23,17 17,19 24,34 34,30 19,34 21,44 22,18 42,45 42,35 34,52 -13,51 43,34 34,18 17,25 24,-5 0,36 36,27 26,29 16,1 1",
};
const BEARINGS = Object.fromEntries(
  FACES.map((face) => [face, BEARING_DATA[face].split(",").map((pair) => pair.split(" ").map((value) => Number(value) / 1000) as [number, number])]),
) as Record<Face, [number, number][]>;
const bearingsOf = (face: Face, ch: string): readonly [number, number] => BEARINGS[face][GLYPHS.indexOf(ch)] ?? [0, 0];

/** What a letter-by-letter word may be made of: the glyphs every one of the six faces draws. */
const LETTERS = /^[A-Z0-9'!?.,&-]+$/;

const CAP_OF_SIZE = 0.74;
const BODY_PX = 142;
const BODY_CAP = BODY_PX * CAP_OF_SIZE;
const MINOR_CAP = BODY_CAP * 0.8;
const HERO_CAP = 250 * CAP_OF_SIZE;
const COLUMN = 900;
const PAD = 12;
/** A word that would shrink below this share of its size to fit the column is broken across rows instead. */
const MIN_FIT = 0.62;
const INK_GAP = 0.09;
const WORD_GAP = 0.3;
const ROW_GAP = 0.05;
const OUTLINE_EM = 0.04;
const SHADOW_EM = 0.075;
const ROW_TILT = 1.6;
const LETTER_TILT = 4.5;
const LETTER_DROP = 0.03;
const SCATTER_X = 0.2;
const SCATTER_Y = 0.14;
const SCATTER_DEG = 24;
const MAX_TUMBLE = 8;
/** Letters one cue may draw before every word is drawn whole (a letter is three draws with its two shadow copies). */
const MAX_LETTERS = 48;
const CLEAR = 16;
const INK = "#1B0F3B";

interface Swatch {
  readonly colour: string;
  readonly shadow: string;
}
/** Yellow, pink, violet, green, cyan, white, orange: the face colours with the hard shadow each sits on. */
const DEFAULT_SWATCHES: readonly Swatch[] = [
  { colour: "#FFE11A", shadow: "#8A2BE2" },
  { colour: "#FF3DA8", shadow: "#5B21B6" },
  { colour: "#B05CFF", shadow: "#FFE11A" },
  { colour: "#19D68A", shadow: "#7A2CFF" },
  { colour: "#33D3FF", shadow: "#FF3DA8" },
  { colour: "#FFFFFF", shadow: "#FF3DA8" },
  { colour: "#FF8A1F", shadow: "#7A2CFF" },
];
/** Which swatches the preset's colours replace. */
const BRAND = { primary: 5, highlight: 0, accent: 1 } as const;

/** [-1, 1): the sample's own cheap hash, so a cue always looks the same. */
const rand = (seed: number, i: number): number => {
  const v = Math.sin(seed * 127.1 + i * 311.7) * 43758.5453;
  return (v - Math.floor(v)) * 2 - 1;
};
const textSeed = (text: string) => [...text].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
const overlaps = (a: Box, b: Box) => a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
const inflate = (box: Box, by: number): Box => ({ x1: box.x1 - by, y1: box.y1 - by, x2: box.x2 + by, y2: box.y2 + by });
const rad = (degrees: number) => (degrees * Math.PI) / 180;

/** The next face for a letter: not either of the last two, the least used of those left, ties by the hash. */
function nextFace(history: readonly Face[], used: ReadonlyMap<Face, number>, seed: number, at: number): Face {
  const last = history.slice(-2);
  const open = FACES.filter((face) => !last.includes(face));
  const fewest = Math.min(...open.map((face) => used.get(face) ?? 0));
  const tied = open.filter((face) => (used.get(face) ?? 0) === fewest);
  return tied[Math.min(tied.length - 1, Math.floor(((rand(seed, at) + 1) / 2) * tied.length))]!;
}

/** A palette index: not either of the last two. */
function nextSwatch(history: readonly number[], size: number, seed: number, at: number): number {
  const open = Array.from({ length: size }, (_, k) => k).filter((k) => !history.slice(-2).includes(k));
  return open[Math.min(open.length - 1, Math.floor(((rand(seed, at * 3 + 1) + 1) / 2) * open.length))]!;
}

const SPARK_POINTS: readonly (readonly [number, number])[] = [[0, -50], [10, -10], [50, 0], [10, 10], [0, 50], [-10, 10], [-50, 0], [-10, -10]];
const DIAMOND_POINTS: readonly (readonly [number, number])[] = [[0, -44], [44, 0], [0, 44], [-44, 0]];

function confettiPath(kind: "spark" | "circle" | "diamond", size: number): PathCmd[] {
  const k = size / 100;
  if (kind === "circle") return ellipsePath(0, 0, 40 * k);
  return polygonPath((kind === "spark" ? SPARK_POINTS : DIAMOND_POINTS).map(([x, y]) => [x * k, y * k] as const));
}

/** A wavy line `width` long: `halves` half waves of height `amp`, alternating up and down, starting at (0, 0). */
function squigglePath(width: number, halves: number, amp: number): PathCmd[] {
  const wl = width / halves;
  const path: PathCmd[] = [["M", 0, 0]];
  for (let k = 0; k < halves; k++) {
    const dir = k % 2 === 0 ? -1 : 1;
    path.push(["C", k * wl + wl / 3, dir * amp * 1.33, k * wl + (2 * wl) / 3, dir * amp * 1.33, (k + 1) * wl, 0]);
  }
  return path;
}

interface Glyph {
  readonly text: string;
  readonly face: Face;
  /** Font size px at the cue's nominal scale (before the row and block fit). */
  readonly px: number;
  readonly adv: number;
  readonly top: number;
  readonly bottom: number;
  readonly lsb: number;
  readonly rsb: number;
  readonly swatch: number;
}

interface Word {
  readonly at: number;
  readonly glyphs: Glyph[];
  /** Left edge of each glyph's advance box from the first one's, pair gaps set from ink. */
  readonly x: number[];
  readonly cap: number;
  readonly whole: boolean;
  readonly hero: boolean;
  readonly seed: number;
  /** Own fit of a whole word to the column. */
  scale: number;
}

interface Unit {
  readonly word: Word;
  readonly part: number;
  readonly parts: number;
  readonly from: number;
  readonly to: number;
  /** Ink width and the ink's left edge from the first glyph's advance edge, at the nominal scale. */
  readonly width: number;
  readonly left: number;
}

interface Row {
  readonly units: Unit[];
  scale: number;
  baseline: number;
  above: number;
  below: number;
  tilt: number;
  /** The painted ink box (outline and shadow included) at rest. */
  box: Box;
}

interface Placed {
  readonly word: Word;
  readonly glyph: Glyph;
  readonly unit: Unit;
  /** Index of the glyph in its word (the face id's part). */
  readonly index: number;
  readonly size: number;
  readonly cap: number;
  /** The pivot: the middle of the letter's cap at rest. */
  readonly cx: number;
  readonly cy: number;
  readonly rz: number;
  readonly outline: number;
  readonly shadow: number;
}

export const funkyProgram = galleryScene("funky", 1290, (ctx) => {
  const { cue, index, from: cueFrom, to, bounds } = ctx.window;
  const { exit, exitAt, fps, side, space, input } = ctx;
  const u = space.u;
  const pieces: Piece[] = [];

  // The swatches: the preset's colours replace the white, yellow and pink. The Studio's colour controls reach the program without
  // the Brand Kit's mapping, so each is checked here against what it is really drawn on: 3:1 against the dark outline, and
  // visibly apart from the hard shadow behind it (a pink face on the pink shadow would lose its edge); below either, the style's own.
  const defaults = captionSceneMeta("funky").colours;
  const keep = (colour: string, fallback: string, shadow: string) =>
    captionColourContrast(colour, INK) >= CAPTION_SCENE_BRAND_MIN_CONTRAST && captionColourContrast(colour, shadow) >= 1.5 ? colour : fallback;
  const swatches = DEFAULT_SWATCHES.map((swatch, at) => {
    if (at === BRAND.primary) return { ...swatch, colour: keep(input.colours.primary, defaults.primary, swatch.shadow) };
    if (at === BRAND.highlight) return { ...swatch, colour: keep(input.colours.highlight, defaults.highlight, swatch.shadow) };
    if (at === BRAND.accent) return { ...swatch, colour: keep(input.colours.accent, defaults.accent, swatch.shadow) };
    return swatch;
  });

  const { lead, hero: heroAt, tail } = rowsFromRoles(cue.words.map((word) => word.role));
  const heroed = heroAt.length > 0;
  const texts = cue.words.map((word) => caps(word, cue).replace(/’/g, "'"));
  const lettered = texts.reduce((sum, text) => sum + (LETTERS.test(text) ? [...text].length : 0), 0) <= MAX_LETTERS;

  // ---- the words: a glyph per letter, faces and colours from the hash, one cap height, ink-measured gaps -----------------
  const metrics = new Map<string, ReturnType<typeof input.measure>>();
  const metric = (face: Face, text: string) => {
    const key = `${face}|${text}`;
    let known = metrics.get(key);
    if (!known) {
      known = input.measure(text, face, 100, 0);
      metrics.set(key, known);
    }
    return known;
  };
  let history: Face[] = [];
  let swatchHistory: number[] = [];
  const used = new Map<Face, number>();
  const words: Word[] = cue.words.map((word, at) => {
    const text = texts[at]!;
    const hero = word.role === "hero";
    const cap = (hero ? HERO_CAP : word.role === "minor" ? MINOR_CAP : BODY_CAP) * u;
    const seed = index * 11 + at * 5 + 3 + textSeed(text);
    const whole = !lettered || !LETTERS.test(text);
    const glyphs: Glyph[] = [];
    if (whole) {
      const swatch = nextSwatch(swatchHistory.slice(-1), swatches.length, seed, 0);
      swatchHistory = [...swatchHistory, swatch, swatch];
      const px = cap / captionFontFace(WHOLE_FACE).capHeight;
      const m = input.measure(text, WHOLE_FACE, px, 0);
      glyphs.push({ text, face: WHOLE_FACE, px, adv: m.advance, top: m.inkTop, bottom: m.inkBottom, lsb: 0, rsb: 0, swatch });
    } else {
      [...text].forEach((ch, i) => {
        const face = nextFace(history, used, seed, i);
        history = [...history, face];
        used.set(face, (used.get(face) ?? 0) + 1);
        const swatch = nextSwatch(swatchHistory, swatches.length, seed, i);
        swatchHistory = [...swatchHistory, swatch];
        const px = cap / captionFontFace(face).capHeight;
        const m = metric(face, ch);
        const [lsb, rsb] = bearingsOf(face, ch);
        glyphs.push({ text: ch, face, px, adv: (m.advance * px) / 100, top: (m.inkTop * px) / 100, bottom: (m.inkBottom * px) / 100, lsb: lsb * px, rsb: rsb * px, swatch });
      });
    }
    const x: number[] = [0];
    glyphs.slice(1).forEach((glyph, i) => {
      const before = glyphs[i]!;
      x.push(x[i]! + before.adv + INK_GAP * cap - before.rsb - glyph.lsb);
    });
    return { at, glyphs, x, cap, whole, hero, seed, scale: 1 };
  });

  // A slice of a word's glyphs as one unit: its ink width and left edge at the nominal scale.
  const unitOf = (word: Word, part: number, parts: number, from: number, to: number): Unit => {
    const first = word.glyphs[from]!;
    const last = word.glyphs[to - 1]!;
    const left = word.x[from]! + first.lsb;
    return { word, part, parts, from, to, width: word.x[to - 1]! + last.adv - last.rsb - left, left };
  };

  // ---- rows: roles give the groups; a long word is broken across rows, the fewest that keep the size floor ---------------
  const column = Math.min(COLUMN * u, bounds.x2 - bounds.x1 - 2 * PAD * u);
  const wordGap = WORD_GAP * BODY_CAP * u;
  const chunksOf = (word: Word): Unit[] => {
    const whole = unitOf(word, 0, 1, 0, word.glyphs.length);
    if (word.whole) {
      word.scale = Math.min(1, column / Math.max(1, whole.width));
      return [whole];
    }
    if (whole.width * MIN_FIT <= column) return [whole];
    const n = word.glyphs.length;
    const span = (from: number, to: number) => unitOf(word, 0, 1, from, to).width;
    // The fewest rows that really fit: for each row count, the narrowest real breakpoints (the least sum of squared widths among
    // the splits whose every row keeps the size floor), never a count estimated from the total width.
    const split = (count: number): Unit[] | null => {
      const best = Array.from({ length: count + 1 }, () => new Array<number>(n + 1).fill(Number.POSITIVE_INFINITY));
      const cut = Array.from({ length: count + 1 }, () => new Array<number>(n + 1).fill(0));
      best[0]![0] = 0;
      for (let k = 1; k <= count; k++) {
        for (let i = k; i <= n; i++) {
          for (let j = k - 1; j < i; j++) {
            const w = span(j, i);
            if (w * MIN_FIT > column && i - j > 1) continue;
            const cost = best[k - 1]![j]! + w * w;
            if (cost < best[k]![i]!) {
              best[k]![i] = cost;
              cut[k]![i] = j;
            }
          }
        }
      }
      if (!Number.isFinite(best[count]![n]!)) return null;
      const out: Unit[] = [];
      let end = n;
      for (let k = count; k >= 1; k--) {
        const start = cut[k]![end]!;
        out.unshift(unitOf(word, k - 1, count, start, end));
        end = start;
      }
      return out;
    };
    for (let count = 2; count < n; count++) {
      const fitted = split(count);
      if (fitted) return fitted;
    }
    return split(n) ?? [whole];
  };
  const unitsOf = words.map(chunksOf);
  const groups = (heroed ? [lead, heroAt, tail] : [cue.words.map((_, at) => at)]).filter((list) => list.length > 0);
  const rowUnits: Unit[][] = [];
  for (const group of groups) {
    let run: Unit[] = [];
    const flush = () => {
      if (run.length === 0) return;
      const widths = run.map((unit) => unit.width * unit.word.scale);
      for (const row of balancedRows(widths, wordGap, column)) rowUnits.push(row.map((at) => run[at]!));
      run = [];
    };
    for (const at of group) {
      const list = unitsOf[at]!;
      if (list.length > 1) {
        flush();
        for (const unit of list) rowUnits.push([unit]);
      } else run.push(list[0]!);
    }
    flush();
  }
  const rowWidth = (units: readonly Unit[]) => units.reduce((sum, unit) => sum + unit.width * unit.word.scale, 0) + wordGap * Math.max(0, units.length - 1);
  const direction = ctx.rtl ? "rtl" : "ltr";

  /** The rows at block fit `f`: every row fits the column by itself, then rows stack by ink, outline and shadow. */
  const arrange = (f: number) => {
    let cursor = 0;
    const rows: Row[] = rowUnits.map((units, r) => {
      const wide = rowWidth(units);
      const scale = f * Math.min(1, column / Math.max(1, wide));
      const glyphs = units.flatMap((unit) => unit.word.glyphs.slice(unit.from, unit.to).map((glyph) => ({ glyph, own: unit.word.scale, cap: unit.word.cap })));
      const capMax = Math.max(...glyphs.map(({ cap, own }) => cap * own)) * scale;
      const above = Math.max(...glyphs.map(({ glyph, own }) => -glyph.top * own * scale), capMax) + OUTLINE_EM * capMax + 0.04 * capMax;
      const below = Math.max(0, ...glyphs.map(({ glyph, own }) => glyph.bottom * own * scale)) + OUTLINE_EM * capMax + 1.2 * SHADOW_EM * capMax + 0.04 * capMax;
      if (r > 0) cursor += ROW_GAP * capMax;
      const baseline = cursor + above;
      cursor = baseline + below;
      const tilt = ((r + index) % 2 === 1 ? 1 : -1) * ROW_TILT;
      return { units, scale, baseline, above, below, tilt, box: { x1: 0, x2: 0, y1: 0, y2: 0 } };
    });
    return { rows, height: cursor };
  };
  const room = bounds.y2 - bounds.y1 - 2 * PAD * u;
  let fit = 1;
  let arranged = arrange(fit);
  for (let tries = 0; tries < 16 && arranged.height > room; tries++) {
    fit *= Math.min(0.94, (0.98 * room) / arranged.height);
    arranged = arrange(fit);
  }
  const { rows } = arranged;
  const targetY = space.y(1290);
  const top = Math.min(bounds.y2 - PAD * u - arranged.height, Math.max(bounds.y1 + PAD * u, targetY - arranged.height / 2));
  const cx = space.x(540);

  // ---- place every letter: the row's tilt about its middle, a small hash tilt and drop of its own ---------------------
  const placed: Placed[] = [];
  const unitPlaced = new Map<Unit, Placed[]>();
  for (const row of rows) {
    const baseline = top + row.baseline;
    const ordered = rowVisualOrder(row.units.map((unit) => texts[unit.word.at]!), direction).map((i) => row.units[i]!);
    const wide = rowWidth(row.units) * row.scale;
    const gap = wordGap * row.scale;
    const capRow = Math.max(...row.units.map((unit) => unit.word.cap * unit.word.scale)) * row.scale;
    const outline = OUTLINE_EM * capRow;
    const shadow = SHADOW_EM * capRow;
    // The painted row (outline left, outline and shadow right) is centred, not the ink.
    let pen = cx - wide / 2 - shadow / 2;
    const middle = pen + wide / 2;
    const turn = rad(row.tilt);
    const rowPivotY = baseline - capRow / 2;
    for (const unit of ordered) {
      const word = unit.word;
      const k = row.scale * word.scale;
      const list: Placed[] = [];
      for (let i = unit.from; i < unit.to; i++) {
        const glyph = word.glyphs[i]!;
        const cap = word.cap * k;
        const dx = pen + (word.x[i]! - unit.left + glyph.adv / 2) * k - middle;
        const dy = baseline - cap / 2 + (word.whole ? 0 : rand(word.seed, i * 5 + 3) * LETTER_DROP * cap) - rowPivotY;
        const item: Placed = {
          word, glyph, unit, index: i, size: glyph.px * k, cap,
          cx: middle + dx * Math.cos(turn) - dy * Math.sin(turn),
          cy: rowPivotY + dx * Math.sin(turn) + dy * Math.cos(turn),
          rz: row.tilt + (word.whole ? 0 : rand(word.seed, i * 5 + 2) * LETTER_TILT),
          outline: OUTLINE_EM * cap,
          shadow: SHADOW_EM * cap,
        };
        placed.push(item);
        list.push(item);
      }
      unitPlaced.set(unit, list);
      pen += unit.width * k + gap;
    }
    // The painted box of the row, with the tilt and the tumble's reach.
    const reach = Math.abs(Math.sin(turn)) * (wide / 2) + 0.06 * capRow;
    row.box = { x1: middle - wide / 2 - outline - 0.04 * capRow, x2: middle + wide / 2 + outline + shadow + 0.04 * capRow, y1: baseline - row.above - reach, y2: baseline + row.below + reach };
  }
  const block: Box = {
    x1: Math.min(...rows.map((row) => row.box.x1)), x2: Math.max(...rows.map((row) => row.box.x2)),
    y1: Math.min(...rows.map((row) => row.box.y1)), y2: Math.max(...rows.map((row) => row.box.y2)),
  };
  const blockMid = { x: (block.x1 + block.x2) / 2, y: (block.y1 + block.y2) / 2 };

  // ---- timing: every word paints on its onset; a hero of up to eight letters tumbles, anything else pops -----------------
  const bandHold = exit ? exitAt : to;
  const gridTimes = exportFrameTimes(cueFrom, bandHold, fps);
  const startFor = (preferred: number, need: number): number | null => {
    if (gridTimes.length < need) return null;
    return Math.max(cueFrom, Math.min(preferred, gridTimes[gridTimes.length - need]!));
  };
  interface Motion {
    readonly from: number;
    readonly settled: number;
    readonly motion: boolean;
    readonly name: Ease;
    readonly stagger: number;
    readonly scatter: boolean;
  }
  const motions = words.map((word, at): Motion => {
    const scatter = word.hero && !word.whole && word.glyphs.length >= 2 && word.glyphs.length <= MAX_TUMBLE;
    const { from, settled, motion } = ctx.enter(cue.words[at]!, scatter ? 190 : 150, 0);
    const name: Ease = settled - from >= 100 && paintedFrameCount(from, settled, fps) >= 4 ? "outBack" : "out";
    return { from, settled, motion, name, stagger: scatter ? Math.min(45, (settled - from) * 0.24) : 0, scatter };
  });

  // The hop beat: a hop across the key word's letters (the last word's on a cue without one), repeated on a long hold.
  const hopWords = heroed ? heroAt : [cue.words.length - 1];
  const hopStarts = new Map<number, { starts: number[]; duration: number; step: number }>();
  for (const at of hopWords) {
    const word = words[at]!;
    const n = word.glyphs.length;
    const first = startFor(motions[at]!.settled + 140, 4);
    if (first === null) continue;
    const duration = 130;
    const avail = bandHold - first - 40;
    if (avail < 100) continue;
    const step = n > 1 ? Math.min(28, Math.max(0, (avail - Math.min(duration, avail)) / (n - 1))) : 0;
    const span = Math.min(duration, avail) + step * (n - 1);
    const starts = [first];
    for (let next = first + 1300; next + span + 60 < bandHold && starts.length < 3; next += 1300) starts.push(next);
    hopStarts.set(at, { starts, duration: Math.min(duration, avail), step });
  }

  const faceCount = (word: Word) => word.glyphs.length;
  let drawn = 0;
  for (const item of placed) {
    const { word, glyph, unit } = item;
    const motion = motions[word.at]!;
    const hopping = hopStarts.get(word.at);
    const n = faceCount(word);
    // Pop pivots: the whole word, or each row of a broken word.
    const members = unitPlaced.get(unit)!;
    const popX = members.reduce((sum, m) => sum + m.cx, 0) / members.length;
    const popY = members.reduce((sum, m) => sum + m.cy, 0) / members.length;
    const sx = rand(word.seed + item.index, 1);
    const sy = rand(word.seed + item.index, 2);
    const sr = rand(word.seed + item.index, 3);
    const start = motion.from + (motion.scatter && n > 1 ? (motion.stagger * item.index) / (n - 1) : 0);
    const settle = motion.settled - motion.from - motion.stagger;
    const pose = (t: number) => {
      let x = item.cx;
      let y = item.cy;
      let rz = item.rz;
      let s = 1;
      if (motion.motion && t < motion.settled) {
        if (motion.scatter) {
          const q = ease(motion.name, prog(t, start, Math.max(1, settle)));
          const k = 1 - q;
          x += sx * SCATTER_X * item.cap * k;
          y += sy * SCATTER_Y * item.cap * k;
          rz += sr * SCATTER_DEG * k;
          s = lerp(0.6, 1, q);
        } else {
          const q = ease(motion.name, prog(t, motion.from, motion.settled - motion.from));
          const sw = lerp(0.62, 1, q);
          const theta = lerp(word.hero ? -12 : -8, 0, q) * side;
          const rx = (item.cx - popX) * sw;
          const ry = (item.cy - popY) * sw;
          x = popX + rx * Math.cos(rad(theta)) - ry * Math.sin(rad(theta));
          y = popY + rx * Math.sin(rad(theta)) + ry * Math.cos(rad(theta));
          rz += theta;
          s = sw;
        }
      }
      if (hopping) {
        for (const at of hopping.starts) {
          const p = prog(t, at + item.index * hopping.step, hopping.duration);
          if (p > 0 && p < 1) y -= 0.09 * item.cap * Math.sin(Math.PI * p);
        }
      }
      if (exit && t > exitAt) {
        const e = ease("in", prog(t, exitAt, to - exitAt));
        const se = 1 - 0.12 * e;
        x = blockMid.x + (x - blockMid.x) * se;
        y = blockMid.y + (y - blockMid.y) * se + 30 * u * e;
        s *= se;
      }
      return { x, y, rz, s };
    };
    const edges = [motion.from, start, motion.settled, exitAt, to];
    for (const at of hopping?.starts ?? []) edges.push(at, at + hopping!.duration + hopping!.step * (n - 1));
    const sampled = (pick: (p: ReturnType<typeof pose>) => number, tolerance: number) =>
      sampleFrames((t) => pick(pose(t)), edges, tolerance, { range: [motion.from, to], wholeMs: true, simplify: true }) as Frames;
    const scaleFrames = sampled((p) => p.s, 0.002);
    const cell: SpeechCell = { at: word.at, text: glyph.text, face: glyph.face, size: item.size, spacing: 0, x: item.cx, baseline: item.cy + item.cap / 2, width: glyph.adv, inkTop: glyph.top, inkBottom: glyph.bottom };
    const swatch = swatches[glyph.swatch]!;
    const shadows: Shadow[] = [
      { dx: 0.5 * item.shadow, dy: 0.6 * item.shadow, blur: 0, colour: swatch.shadow, alpha: 1 },
      { dx: item.shadow, dy: 1.2 * item.shadow, blur: 0, colour: swatch.shadow, alpha: 1 },
    ];
    const face: TextPiece = {
      ...ctx.face(cell, motion.from, swatch.colour, {
        x: sampled((p) => p.x, 0.25),
        y: sampled((p) => p.y, 0.25),
        rz: sampled((p) => p.rz, 0.05),
        sx: scaleFrames,
        sy: scaleFrames,
      }),
      id: n > 1 ? `${ctx.id}:w${word.at}l${item.index}` : `${ctx.id}:w${word.at}`,
      origin: { dx: 0, dy: -item.cap / 2 },
      stroke: { widthPx: item.outline, colour: INK },
      shadows,
    };
    pieces.push(face);
    drawn += 3;
  }

  // ---- decorations in free space: the squiggle, then the confetti -----------------------------------------------------
  const area: Box = { x1: bounds.x1 + 4 * u, y1: bounds.y1 + 4 * u, x2: bounds.x2 - 4 * u, y2: bounds.y2 - 4 * u };
  const clear = CLEAR * u;
  const taken: Box[] = [];
  const free = (box: Box) =>
    box.x1 >= area.x1 && box.x2 <= area.x2 && box.y1 >= area.y1 && box.y2 <= area.y2 &&
    !rows.some((row) => overlaps(box, inflate(row.box, clear))) && !taken.some((other) => overlaps(box, inflate(other, 6 * u)));
  const claim = (w: number, h: number, candidates: readonly (readonly [number, number])[]): Box | null => {
    for (const [x, y] of candidates) {
      const box = { x1: x, y1: y, x2: x + w, y2: y + h };
      if (free(box)) {
        taken.push(box);
        return box;
      }
    }
    return null;
  };
  const counter = ctx.input.cues.slice(0, index).filter((other) => other.words.length > 0).length;
  const heroOnset = heroed ? motions[heroAt[0]!]!.from : motions[cue.words.length - 1]!.from;
  const heroSettle = heroed ? motions[heroAt[0]!]!.settled : motions[cue.words.length - 1]!.settled;
  const capBlock = Math.max(...rows.map((row) => Math.max(...row.units.map((unit) => unit.word.cap * unit.word.scale)) * row.scale));
  const decorationBudget = SCENE_PIECE_BUDGET - drawn;

  // 1. The squiggle: a wavy line drawn on under the block (above it when there is no room below), in the next palette colour.
  if (decorationBudget >= 4) {
    const sw = Math.max(6 * u, 0.05 * capBlock);
    const w = clamp((block.x2 - block.x1) * 0.42, 140 * u, 340 * u);
    const amp = 1.1 * sw;
    const h = 2.6 * amp + sw;
    const at0 = startFor(heroSettle + 40, 2);
    const spot = at0 === null ? null : claim(w + sw, h + sw, [
      [blockMid.x - w / 2, block.y2 + clear], [block.x1, block.y2 + clear], [block.x2 - w, block.y2 + clear],
      [blockMid.x - w / 2, block.y1 - clear - h - sw], [block.x1, block.y1 - clear - h - sw], [block.x2 - w, block.y1 - clear - h - sw],
    ]);
    if (spot && at0 !== null) {
      const colour = swatches[(counter * 2 + 3) % swatches.length]!.colour;
      const path = squigglePath(w, 8, amp);
      const x0 = spot.x1 + sw / 2;
      const y0 = spot.y1 + sw / 2 + h / 2;
      const wipe = paintedFrameCount(at0, at0 + 170, fps) >= 4 && at0 + 200 < bandHold;
      const grown = (right: number) => (side > 0 ? { x1: [[at0, x0 - sw]] as Frames, x2: wipe ? ([[at0, x0 - sw], [at0 + 170, right, "out"]] as Frames) : ([[at0, right]] as Frames) } : { x1: wipe ? ([[at0, right + sw], [at0 + 170, x0 - sw, "out"]] as Frames) : ([[at0, x0 - sw]] as Frames), x2: [[at0, right + sw]] as Frames });
      const clip = (() => {
        const edge = grown(x0 + w + sw);
        return { ...edge, y1: [[at0, spot.y1 - sw]] as Frames, y2: [[at0, spot.y2 + sw]] as Frames };
      })();
      const build = (suffix: string, width: number, stroke: string): Piece => ({
        ...ctx.shape(suffix, at0, path, { x: [[at0, x0]], y: [[at0, y0]] }),
        z: 2,
        clip,
        stroke: { widthPx: width, colour: stroke },
      });
      pieces.push(build("squigInk", sw + 2 * OUTLINE_EM * capBlock, INK), build("squig", sw, colour));
      drawn += 4;
    }
  }

  // 2. Confetti: sparks, rings and diamonds in free space, behind the faces, popping in with the key word.
  {
    const count = heroed ? 6 : 4;
    const kinds = ["spark", "circle", "diamond"] as const;
    const sizes = { spark: 76, circle: 40, diamond: 46 };
    const around = (w: number, h: number, k: number): (readonly [number, number])[] => {
      const spread = [0.08, 0.92, 0.5, 0.26, 0.74];
      const top = spread.map((f) => [block.x1 + f * (block.x2 - block.x1 - w), block.y1 - clear - h] as const);
      const bottom = spread.map((f) => [block.x1 + f * (block.x2 - block.x1 - w), block.y2 + clear] as const);
      const ends = rows.flatMap((row) => [[row.box.x1 - clear - w, (row.box.y1 + row.box.y2 - h) / 2], [row.box.x2 + clear, (row.box.y1 + row.box.y2 - h) / 2]] as const);
      const all = [...top, ...bottom, ...ends];
      const turn = (index * 3 + k * 2) % all.length;
      return [...all.slice(turn), ...all.slice(0, turn)];
    };
    for (let k = 0; k < count && decorationBudget - 4 - 2 * k >= 2; k++) {
      const kind = kinds[(index + k) % kinds.length]!;
      const size = sizes[kind] * u * (0.92 + 0.16 * Math.abs(rand(index * 17 + 5, k)));
      // The pop overshoots to 112 %: the spot is claimed for that.
      const room = size * 1.14;
      const spot = claim(room, room, around(room, room, k));
      if (!spot) continue;
      const at = startFor(heroOnset + 60 + k * 35, 2);
      if (at === null) continue;
      const pop = paintedFrameCount(at, at + 170, fps) >= 5;
      const scale: [number, number, Ease?][] = pop ? [[at, 0.05], [at + 90, 1.12, "out"], [at + 170, 1, "inOut"]] : [[at, 1]];
      let twinkles = 0;
      for (let tt = at + 170 + ((k * 130) % 450); pop && tt + 450 < bandHold - 80 && twinkles < 8; tt += 450, twinkles++) scale.push([tt + 225, 0.72, "inOut"], [tt + 450, 1, "inOut"]);
      const spin = rand(index * 17 + 5, k * 2) * 40;
      const end = scale[scale.length - 1]![0];
      const shape = ctx.shape(`conf${k}`, at, confettiPath(kind, size), {
        x: [[at, (spot.x1 + spot.x2) / 2]],
        y: [[at, (spot.y1 + spot.y2) / 2]],
        sx: scale,
        sy: scale,
        rz: [[at, spin], [Math.max(at + 1, Math.min(end, bandHold)), spin + (Math.max(0, Math.min(end, bandHold) - at) / 1000) * 24]],
      }, swatches[(k * 3 + index) % swatches.length]!.colour);
      pieces.push({ ...shape, z: 2, stroke: { widthPx: 0.08 * size, colour: INK } });
      drawn += 2;
    }
  }
  return pieces;
}, undefined, 0);

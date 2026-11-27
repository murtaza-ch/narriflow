import { CAPTION_SCENE_BRAND_MIN_CONTRAST, type CaptionFontName, captionColourContrast, captionSceneMeta } from "@narriflow/validators";
import type { DemoScript } from "../demo";
import { clamp, EASES, kf, prog } from "../ease";
import { paintedFrameCount } from "../frame-grid";
import { sampleFrames } from "../frames";
import { type Box, mixColour, type PathCmd, type Piece, type ShapePiece, type TextPiece, type Track } from "../scene";
import { greedyRows } from "../layout";
import { ellipsePath, pathBounds } from "../shapes";
import { caps, galleryScene, letterCells, rowBounds, rowsOf } from "./gallery-layout";
import type { SpeechCell } from "./speech-layout";

/**
 * Helium (`samples/templates/m82-helium.js`): plump balloon capitals. Every letter is a heavy rounded cap (Fredoka Bold)
 * in one glossy hue per cue (cobalt, coral, mint) with a paler rim, a deeper lower-right edge, a dark base and a short
 * white shine stroke (plus a bead when it fits) along its upper-left curve. Spoken words float up from just below the
 * baseline, rise a touch past it and settle, then bob gently. The key word has its own row: its letters rise in a shallow
 * left-to-right wave, the whole word swells about 8% once and rests, and a knotted balloon string curls beneath it when
 * there is room. Cues leave like released balloons: a short float up and a fade.
 *
 * Changes from the sample, and why (wave 7 brief, 2026-11-27):
 * - **The shine comes from the font, not from canvas pixels.** The sample found each glyph's shine with a pixel search on
 *   a browser canvas, which the export cannot run. The same search ran once over the bundled Fredoka Bold and SemiBold
 *   outlines (`SHINE_BOLD`, `SHINE_SEMIBOLD`: the stroke's ends, its control point and the bead, in em from the letter's
 *   origin), so the Studio and the export draw the same shine, sitting on the letter body with the counters open. A
 *   SemiBold stem too narrow for the sample's 0.088 em stroke takes a 0.072 or 0.06 em one. Every shine of a word is one
 *   filled shape (each stroke outlined with round caps, each bead a disc) that moves with the word and stays after the
 *   motion ends. Accented capitals take their base letter's shine. Words the face cannot draw (Devanagari, Arabic,
 *   Urdu, CJK, Cyrillic, Greek) take one shine per word instead: a white copy of the word seen through a small pill in the
 *   upper left of its measured ink, so the shine is always on the ink whatever the fallback face draws.
 * - **Cue-indexed tables are gone.** The sample's `HUE[ci]` cycles cobalt, coral, mint by cue number on any clip (the three
 *   hues are the preset's primary, highlight and accent). Rows come from the words: words before the key word, the key word
 *   alone, words after it, each balanced to the 860 px row; a cue with no key word wraps its words at the larger size.
 * - **Every glyph paints at onset.** All of a key word's letters are drawn from the word's first frame; only their rise is
 *   staggered (14 ms apart, at most 40 ms in all), and the whole word is opaque by its spoken start (the sample faded each
 *   letter in on its own). Nothing paints more than 80 ms before its word.
 * - **Long words.** A key word too wide for 820 px at 150 px is drawn in Fredoka SemiBold with tighter tracking and a
 *   lighter dark stack, so P, A and B keep open counters at phone size (Sol's sample blocker); below 104 px a Latin or CJK
 *   word breaks across the fewest even rows instead of shrinking further, as does an ordinary word below 62% of its size.
 * - **Rows from measured ink.** The row pitch is the sample's (0.34 of the smaller size above the cap line) or, for taller
 *   ink (Devanagari matras, Nastaliq), the measured ink of both rows plus the dark base below and each row's largest
 *   motion (rise overshoot, the key word's swell, the bob), so stacks never touch on any frame.
 * - **Real speech.** Words enter on their own words (80 ms early, opaque by their spoken start); the exit (a 56 px float
 *   up with a fade over its last 55 ms) runs in the time the cue has after its reading hold and is dropped when it would
 *   not paint two frames. The first word of a row starts nearer the centre and eases into its slot (Sol's sample fix),
 *   compressed so it is home before the next word of the row appears.
 * - **The string fits.** It hangs under the key word only when the key word is the last row and the band has at least
 *   70 px below it; its length follows that room (at most 150 px), so it never leaves the caption band at any aspect ratio.
 * - **Colours as received.** Each hue keeps 3:1 against its own dark base (the keyline that outlines every letter; the
 *   sample's cobalt base is darkened from #0B1C6E to #061040 to reach it). A brand or Studio colour gets a rim, deep edge
 *   and base derived from it, with the base darkened until it reads at 3:1; a colour that cannot reach it keeps the
 *   style's own hue.
 * - **Cost.** The sample's soft blurred lift under each word is dropped: beside the dark base it is barely visible on the
 *   bright backdrop, and its per-frame blur was a third of the libass time (full export 1.47x Headline CPU with it,
 *   1.30-1.39x without). The band of lighter colour across the key word's upper face is a clipped copy (libass pays for its
 *   rectangle only).
 * - **Fast speech.** A word that paints on a single frame (24/25 fps, 70 ms words) is drawn as one piece with its dark
 *   keyline and base, since the shared two-frame filter drops the stack copies. A pathological token wraps to at most 12
 *   rows so a cue stays inside its piece budget; a 90-character CJK token still holds the size floor.
 * - **Words per cue: 3.** Bodies are 120-160 px with a 240 px key word: on the real English and Hindi clips 3 words keep
 *   every cue at full size (no fit shrink) in at most three rows (Hindi four), where 4 would stack the 160 px bodies higher.
 *
 * Extra recurring beats, in the balloon language, on ordinary speech: two small glossy balloons released beside the last
 * row on every cue (at the key word's swell, or as the last word of a cue with no key word lands; sides alternate by cue,
 * size and drift come from a hash of the cue), a balloon-bump that nudges a row's previous word outward when the next one
 * lands beside it, and a small inflate (5%) of the last word of a cue with no key word.
 */

export const HELIUM_DEMO: DemoScript = {
  lines: [
    "just:b let:b it:m go:b",
    "your:m ideas:b deserve:b to:m FLY:h@580",
    "UNSTOPPABLE:h@900",
    "you:m are:b lighter:b than:m you:m think:b",
    "keep:b RISING:h@640",
  ],
  options: { rate: 220, gap: 30, cueGap: 250, tail: 380, lead: 170 },
};

const FACE: CaptionFontName = "Fredoka Bold";
const FACE_LIGHT: CaptionFontName = "Fredoka SemiBold";
const LS = 0.05;
const LS_LONG = 0.015;
const CY = 1290;
const BODY_FS = 120;
const SOLO_FS = 160;
const HERO_MAX = 240;
const HERO_W = 820;
const ROW_W = 860;
const HERO_FLOOR = 104;
const BODY_FLOOR = 0.62;
/** The smallest a row of ordinary words shrinks to before it wraps past the sample's row cap, sample px. */
const ROW_FLOOR = 92;
/** The most rows one broken word may take. */
const MAX_PARTS = 12;
/** Below this size (sample px) a glyph gets the lighter dark stack, and a key word Fredoka SemiBold. */
const SMALL_FS = 150;
const WORD_GAP = 0.36;
const ROW_GAP = 0.34;
const CAP = 0.69;

const RIM = 0.025;
const RIM_SMALL = 0.008;
const KEYLINE = 0.01;
const KEYLINE_SMALL = 0.002;
const DROP = 0.042;
const DEEP = [0.018, 0.022] as const;
const DEEP_SMALL = [0.012, 0.015] as const;
const BEAD = 0.034;
const BAND_SHARE = 0.36;
const SHINE = "#FFFFFF";

const ENTER = 80;
const RISE = 400;
const STAGGER = 14;
const STAGGER_TOTAL = 40;
const SWELL_MS = 520;
const EXIT_MS = 115;
const FADE_MS = 55;
const BALLOON_MS = 1100;
/** Room below a last-row key word for its string, sample px. */
const STRING_ROOM = 110;
const STRING_MIN = 70;
const STRING_MAX = 150;

// Shine strokes of the bundled Fredoka outlines, from the sample's own search (`shineFor`) run on the TTF: stroke width
// [em], then the stroke's end, control point and start, and the bead when it fits, in em from the letter's origin.
const SHINE_BOLD: Readonly<Record<string, readonly number[]>> = {
  "0": [0.088, 0.31, -0.656, 0.186, -0.568, 0.098, -0.444], "1": [0.088, 0.278, -0.649, 0.202, -0.517, 0.175, -0.368],
  "2": [0.088, 0.302, -0.656, 0.178, -0.568, 0.09, -0.444], "3": [0.088, 0.25, -0.646, 0.161, -0.594, 0.108, -0.504],
  "4": [0.072, 0.212, -0.656, 0.162, -0.642, 0.148, -0.592], "5": [0.088, 0.307, -0.644, 0.201, -0.574, 0.131, -0.468],
  "6": [0.088, 0.349, -0.634, 0.225, -0.546, 0.137, -0.422, 0.079, -0.364],
  "7": [0.088, 0.149, -0.644, 0.089, -0.62, 0.065, -0.559], "8": [0.088, 0.294, -0.652, 0.169, -0.564, 0.082, -0.44],
  "9": [0.088, 0.269, -0.654, 0.162, -0.584, 0.092, -0.477],
  "A": [0.088, 0.396, -0.643, 0.345, -0.63, 0.332, -0.58, 0.274, -0.522],
  "B": [0.088, 0.263, -0.647, 0.156, -0.577, 0.086, -0.471], "C": [0.088, 0.309, -0.633, 0.184, -0.545, 0.097, -0.42],
  "D": [0.088, 0.274, -0.644, 0.167, -0.574, 0.097, -0.468], "E": [0.088, 0.267, -0.643, 0.16, -0.573, 0.09, -0.466],
  "F": [0.088, 0.267, -0.643, 0.16, -0.573, 0.09, -0.466], "G": [0.088, 0.33, -0.637, 0.205, -0.549, 0.118, -0.425],
  "H": [0.088, 0.15, -0.647, 0.099, -0.634, 0.086, -0.584], "I": [0.088, 0.15, -0.647, 0.099, -0.634, 0.086, -0.584],
  "J": [0.088, 0.433, -0.647, 0.383, -0.634, 0.369, -0.584], "K": [0.088, 0.162, -0.647, 0.112, -0.634, 0.099, -0.584],
  "L": [0.088, 0.171, -0.647, 0.12, -0.634, 0.107, -0.584], "M": [0.088, 0.203, -0.644, 0.128, -0.606, 0.09, -0.531],
  "N": [0.088, 0.203, -0.644, 0.128, -0.606, 0.09, -0.531], "O": [0.088, 0.298, -0.64, 0.173, -0.552, 0.086, -0.427],
  "P": [0.088, 0.263, -0.643, 0.156, -0.573, 0.086, -0.466], "Q": [0.088, 0.298, -0.64, 0.173, -0.552, 0.086, -0.427],
  "R": [0.088, 0.263, -0.643, 0.156, -0.573, 0.086, -0.466], "S": [0.088, 0.285, -0.651, 0.178, -0.581, 0.108, -0.474],
  "T": [0.088, 0.246, -0.671, 0.201, -0.624, 0.205, -0.559], "U": [0.088, 0.161, -0.644, 0.111, -0.631, 0.097, -0.581],
  "V": [0.088, 0.159, -0.63, 0.098, -0.606, 0.074, -0.545], "W": [0.088, 0.155, -0.643, 0.094, -0.619, 0.07, -0.558],
  "X": [0.088, 0.176, -0.655, 0.115, -0.631, 0.091, -0.57], "Y": [0.088, 0.137, -0.653, 0.076, -0.629, 0.052, -0.568],
  "Z": [0.088, 0.188, -0.656, 0.134, -0.619, 0.124, -0.554], "Ø": [0.088, 0.345, -0.646, 0.221, -0.559, 0.133, -0.433],
  "Æ": [0.088, 0.74, -0.647, 0.616, -0.559, 0.528, -0.435], "Œ": [0.088, 0.309, -0.633, 0.184, -0.545, 0.097, -0.42],
  "Ð": [0.088, 0.345, -0.644, 0.238, -0.574, 0.168, -0.468, 0.11, -0.41],
  "Þ": [0.088, 0.194, -0.637, 0.133, -0.613, 0.109, -0.552], "Ł": [0.088, 0.263, -0.647, 0.202, -0.623, 0.178, -0.562],
  "&": [0.088, 0.273, -0.669, 0.198, -0.631, 0.16, -0.556], "?": [0.088, 0.212, -0.654, 0.123, -0.602, 0.071, -0.513],
  "!": [0.088, 0.154, -0.652, 0.104, -0.638, 0.09, -0.588],
};
const SHINE_SEMIBOLD: Readonly<Record<string, readonly number[]>> = {
  "0": [0.088, 0.23, -0.634, 0.18, -0.62, 0.166, -0.57, 0.108, -0.512],
  "1": [0.088, 0.232, -0.609, 0.193, -0.513, 0.204, -0.411], "2": [0.088, 0.246, -0.638, 0.157, -0.585, 0.104, -0.496],
  "3": [0.088, 0.249, -0.647, 0.174, -0.609, 0.136, -0.534], "4": [0.06, 0.17, -0.641, 0.12, -0.627, 0.106, -0.577],
  "5": [0.088, 0.249, -0.648, 0.174, -0.61, 0.135, -0.535], "6": [0.088, 0.297, -0.615, 0.208, -0.563, 0.155, -0.474],
  "7": [0.088, 0.176, -0.653, 0.13, -0.628, 0.128, -0.576], "8": [0.088, 0.241, -0.647, 0.166, -0.609, 0.128, -0.534],
  "9": [0.088, 0.229, -0.647, 0.154, -0.609, 0.115, -0.534], "B": [0.088, 0.207, -0.644, 0.132, -0.606, 0.094, -0.531],
  "C": [0.088, 0.301, -0.626, 0.194, -0.556, 0.124, -0.449], "D": [0.088, 0.207, -0.644, 0.132, -0.606, 0.094, -0.531],
  "E": [0.088, 0.219, -0.644, 0.144, -0.606, 0.106, -0.531], "F": [0.088, 0.219, -0.644, 0.144, -0.606, 0.106, -0.531],
  "G": [0.088, 0.317, -0.634, 0.211, -0.564, 0.141, -0.458], "H": [0.072, 0.131, -0.641, 0.08, -0.627, 0.067, -0.577],
  "I": [0.072, 0.131, -0.641, 0.08, -0.627, 0.067, -0.577], "J": [0.072, 0.415, -0.641, 0.364, -0.627, 0.351, -0.577],
  "K": [0.072, 0.142, -0.641, 0.092, -0.627, 0.078, -0.577], "L": [0.072, 0.15, -0.641, 0.1, -0.627, 0.087, -0.577],
  "M": [0.088, 0.179, -0.64, 0.118, -0.616, 0.094, -0.555], "N": [0.088, 0.183, -0.644, 0.122, -0.62, 0.098, -0.559],
  "O": [0.088, 0.249, -0.611, 0.188, -0.587, 0.164, -0.526, 0.106, -0.468],
  "P": [0.088, 0.215, -0.644, 0.14, -0.606, 0.102, -0.531], "Q": [0.088, 0.249, -0.611, 0.188, -0.587, 0.164, -0.526, 0.106, -0.468],
  "R": [0.088, 0.211, -0.64, 0.136, -0.602, 0.098, -0.527], "S": [0.088, 0.246, -0.65, 0.157, -0.598, 0.104, -0.509],
  "T": [0.088, 0.207, -0.671, 0.168, -0.638, 0.177, -0.586], "U": [0.072, 0.141, -0.641, 0.091, -0.627, 0.077, -0.577],
  "V": [0.088, 0.146, -0.631, 0.095, -0.617, 0.082, -0.567], "W": [0.088, 0.133, -0.639, 0.083, -0.626, 0.069, -0.575],
  "X": [0.088, 0.163, -0.638, 0.102, -0.614, 0.078, -0.554], "Y": [0.088, 0.138, -0.654, 0.088, -0.641, 0.075, -0.591],
  "Z": [0.088, 0.155, -0.659, 0.109, -0.635, 0.107, -0.583],
  "Ø": [0.088, 0.262, -0.615, 0.201, -0.591, 0.177, -0.53, 0.119, -0.472],
  "Æ": [0.088, 0.706, -0.648, 0.617, -0.596, 0.565, -0.507],
  "Œ": [0.088, 0.27, -0.614, 0.195, -0.576, 0.157, -0.501, 0.099, -0.443],
  "Ð": [0.088, 0.265, -0.64, 0.19, -0.602, 0.152, -0.527], "Þ": [0.088, 0.19, -0.633, 0.129, -0.609, 0.105, -0.548],
  "Ł": [0.072, 0.243, -0.641, 0.193, -0.627, 0.179, -0.577], "&": [0.088, 0.299, -0.704, 0.267, -0.663, 0.287, -0.615],
  "?": [0.088, 0.231, -0.692, 0.199, -0.652, 0.218, -0.604], "!": [0.072, 0.135, -0.645, 0.085, -0.631, 0.072, -0.581],
};

/** The shine of a letter in a face, or null when it has none (its base letter for an accented capital). */
export function heliumShine(letter: string, face: CaptionFontName): readonly number[] | null {
  const table = face === FACE_LIGHT ? SHINE_SEMIBOLD : SHINE_BOLD;
  const base = [...letter.normalize("NFD")][0] ?? letter;
  return table[letter] ?? table[base] ?? null;
}

/** Words drawn in Fredoka (Latin): per-letter shines from the table. Anything else takes one shine per word. */
const FREDOKA = /^[\p{Script=Latin}\p{N}\p{P}\p{S}\p{M}]+$/u;
/** Words that may break across rows between graphemes when one is too wide (cased simple scripts and CJK). */
const BREAKABLE = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{N}\p{P}\p{S}\p{M}\u3000-\u30FF\uFF00-\uFFEF]+$/u;
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// --- colours ------------------------------------------------------------------------------------

interface Palette {
  readonly face: string;
  readonly deep: string;
  readonly rim: string;
  readonly shadow: string;
}

/** The sample's three hues: face, deeper lower-right edge, paler rim, dark base. */
const SAMPLE_PALETTES: Readonly<Record<string, Palette>> = {
  // Cobalt's base is darkened from the sample's #0B1C6E so the face keeps 3:1 against it.
  "#2456F5": { face: "#2456F5", deep: "#1431A8", rim: "#8CB0FF", shadow: "#061040" },
  "#FF5A48": { face: "#FF5A48", deep: "#C72D2B", rim: "#FFB09F", shadow: "#6B1117" },
  "#0FBF94": { face: "#0FBF94", deep: "#087F68", rim: "#8FF0D0", shadow: "#04403A" },
};
/** The darkest base a brand hue may get (the catalogue row's `readsOn`). */
export const HELIUM_BASE_FLOOR = "#070A1C";

/** A hue's balloon palette; a colour whose base cannot reach 3:1 keeps `fallback` (one of the sample's hues). */
export function heliumPalette(colour: string, fallback: string): Palette {
  const sample = SAMPLE_PALETTES[colour.toUpperCase()];
  if (sample) return sample;
  const reads = (base: string) => captionColourContrast(colour, base) >= CAPTION_SCENE_BRAND_MIN_CONTRAST;
  const shadow = [mixColour(colour, HELIUM_BASE_FLOOR, 0.6), mixColour(colour, HELIUM_BASE_FLOOR, 0.82), HELIUM_BASE_FLOOR].find(reads);
  if (!shadow) return heliumPalette(fallback, fallback);
  return { face: colour.toUpperCase(), deep: mixColour(colour, "#000000", 0.3), rim: mixColour(colour, "#FFFFFF", 0.55), shadow };
}

// --- shapes -----------------------------------------------------------------------------------------

/** A shine stroke as a filled outline: the quadratic from `a` through `c` to `b`, `width` wide with round caps. */
function sliverPath(ax: number, ay: number, cx: number, cy: number, bx: number, by: number, width: number): PathCmd[] {
  const steps = 8;
  const r = width / 2;
  const left: [number, number][] = [];
  const right: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = (1 - t) ** 2 * ax + 2 * (1 - t) * t * cx + t * t * bx;
    const y = (1 - t) ** 2 * ay + 2 * (1 - t) * t * cy + t * t * by;
    const dx = 2 * (1 - t) * (cx - ax) + 2 * t * (bx - cx);
    const dy = 2 * (1 - t) * (cy - ay) + 2 * t * (by - cy);
    const length = Math.hypot(dx, dy) || 1;
    left.push([x - (dy / length) * r, y + (dx / length) * r]);
    right.push([x + (dy / length) * r, y - (dx / length) * r]);
  }
  // A round cap from one side of the stroke to the other, bulging along `out` (the stroke's direction at that end).
  const cap = (x: number, y: number, from: readonly [number, number], ox: number, oy: number): [number, number][] => {
    const start = Math.atan2(from[1] - y, from[0] - x);
    const turn = Math.cos(start + Math.PI / 2) * ox + Math.sin(start + Math.PI / 2) * oy >= 0 ? 1 : -1;
    return [1, 2, 3, 4, 5].map((k) => [x + Math.cos(start + (turn * k * Math.PI) / 6) * r, y + Math.sin(start + (turn * k * Math.PI) / 6) * r]);
  };
  const back = [...right].reverse();
  const ring = [...left, ...cap(bx, by, left[steps]!, bx - cx, by - cy), ...back, ...cap(ax, ay, right[0]!, ax - cx, ay - cy)];
  return [...ring.map(([x, y], i): PathCmd => [i === 0 ? "M" : "L", round(x), round(y)]), ["Z"]];
}

const round = (value: number) => Math.round(value * 100) / 100;

/** Every shine of a run of letters, in px from the run's anchor: `lefts[i]` is letter i's origin. */
function shinePath(letters: readonly string[], lefts: readonly number[], face: CaptionFontName, size: number): PathCmd[] {
  const path: PathCmd[] = [];
  letters.forEach((letter, i) => {
    const s = heliumShine(letter, face);
    if (!s) return;
    const at = (x: number, y: number) => [lefts[i]! + x * size, y * size] as const;
    const [ax, ay] = at(s[1]!, s[2]!);
    const [cx, cy] = at(s[3]!, s[4]!);
    const [bx, by] = at(s[5]!, s[6]!);
    path.push(...sliverPath(ax, ay, cx, cy, bx, by, s[0]! * size));
    if (s.length > 7) {
      const [dx, dy] = at(s[7]!, s[8]!);
      path.push(...ellipsePath(round(dx), round(dy), round(BEAD * size)));
    }
  });
  return path;
}

/** A path moved so its bounds start at (0, 0) (libass aligns a drawing by its box), with the offset to put back in `origin`. */
function fromTopLeft(path: readonly PathCmd[]): { path: PathCmd[]; x: number; y: number } {
  const b = pathBounds(path);
  const moved = path.map((command): PathCmd => {
    if (command[0] === "Z") return command;
    const out: number[] = [];
    for (let at = 1; at < command.length; at += 2) out.push(round((command[at] as number) - b.x1), round((command[at + 1] as number) - b.y1));
    return [command[0], ...out] as unknown as PathCmd;
  });
  return { path: moved, x: b.x1, y: b.y1 };
}

/** FNV-1a of a cue's index and text: the seed of its balloons' size and drift (never `Math.random`). */
export function heliumHash(text: string): number {
  let h = 0x811c9dc5;
  for (let at = 0; at < text.length; at++) {
    h ^= text.charCodeAt(at);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// --- the program --------------------------------------------------------------------------------------

interface Pose {
  readonly x: number;
  readonly y: number;
  readonly s: number;
  readonly r: number;
  readonly o: number;
}

interface Unit {
  /** The face piece's id: `helium:<cue>:w<word>` or `...l<part>`. */
  readonly id: string;
  readonly word: number;
  readonly hero: boolean;
  readonly cell: SpeechCell;
  readonly baseline: number;
  /** Lighter dark stack (a glyph under 150 sample px). */
  readonly small: boolean;
  /** Rest pivot, canvas px. */
  readonly px: number;
  readonly py: number;
  /** The key word's pivot its letters swell and bob about (a whole piece is its own). */
  readonly gx: number;
  readonly gy: number;
  /** Position in the key word's wave, and the wave's letter count. */
  readonly letter: number;
  readonly letters: number;
  readonly from: number;
  readonly spoken: number;
  readonly row: number;
  /** Rise distance, canvas px: the sample's, or less when the caption band has no room below the row. */
  readonly rise: number;
  readonly box: Box;
  slide?: { readonly dx: number; readonly ms: number };
  nudge?: { readonly at: number; readonly dir: number };
  puff?: number;
}

export const heliumProgram = galleryScene("helium", CY, (ctx) => {
  const { cue, index, to, bounds } = ctx.window;
  const { input, space, exit, exitAt } = ctx;
  const { words } = cue;
  const frame = Math.min(input.canvas.width, input.canvas.height) / 1080;
  const heroAt = words.findIndex((word) => word.role === "hero");
  const heroed = heroAt >= 0;
  const texts = words.map((word) => caps(word, cue));

  // One hue per cue, cycling cobalt, coral, mint (the preset's primary, highlight and accent).
  const defaults = captionSceneMeta("helium").colours;
  const slot = (["primary", "highlight", "accent"] as const)[index % 3]!;
  const pal = heliumPalette(input.colours[slot], defaults[slot]);
  const band = mixColour(pal.face, "#FFFFFF", 0.27);

  // --- sizes, faces, long words ---
  const at100 = (text: string, face: CaptionFontName, ls: number) => input.measure(text, face, 100 * space.u, ls).advance / space.u;
  const graphemes = (text: string) => [...GRAPHEMES.segment(text)].map((part) => part.segment);
  const chunkAt = (text: string, face: CaptionFontName, ls: number, size: number, column: number): string[] => {
    const split = (room: number): string[] => {
      const out: string[] = [];
      let row = "";
      for (const ch of graphemes(text)) {
        if (row && at100(row + ch, face, ls) > room) {
          out.push(row);
          row = "";
        }
        row += ch;
      }
      if (row) out.push(row);
      return out;
    };
    // The fewest rows that fit at the floor, then the narrowest limit that keeps that many, so the rows come out even.
    // A pathological token (hundreds of letters) wraps to at most MAX_PARTS rows, smaller, so the cue stays in its piece budget.
    const room = (column * 0.97 * 100) / size;
    const rows = Math.min(split(room).length, MAX_PARTS);
    let lo = 0;
    let hi = Math.max(room, at100(text, face, ls) + 1);
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      if (split(mid).length <= rows) hi = mid;
      else lo = mid;
    }
    return split(hi);
  };
  const base = heroed ? BODY_FS : SOLO_FS;
  interface Item {
    readonly word: number;
    readonly text: string;
    readonly size: number;
    readonly face: CaptionFontName;
    readonly spacing: number;
  }
  const flat: Item[] = [];
  const indexes = words.map((word, w) => {
    const text = texts[w]!;
    const hero = word.role === "hero";
    let face: CaptionFontName = FACE;
    let spacing = LS;
    const column = hero ? HERO_W : ROW_W;
    let size = hero ? Math.min(HERO_MAX, (HERO_W * 100) / at100(text, face, spacing)) : Math.min(base, (ROW_W * 100) / at100(text, face, spacing));
    if (hero && size < SMALL_FS) {
      // A long key word: tighter tracking and the lighter weight keep the letters bigger and the counters open.
      face = FACE_LIGHT;
      spacing = LS_LONG;
      size = Math.min(HERO_MAX, (HERO_W * 100) / at100(text, face, spacing));
    }
    const floor = hero ? HERO_FLOOR : base * BODY_FLOOR;
    if (size >= floor || !BREAKABLE.test(text) || graphemes(text).length < 2) return [flat.push({ word: w, text, size, face, spacing }) - 1];
    const chunks = chunkAt(text, face, spacing, floor, column);
    const widest = Math.max(...chunks.map((chunk) => at100(chunk, face, spacing)));
    // The largest size at which the widest row fits: at least the floor, unless the row cap made the rows longer.
    const fitted = Math.min((column * 0.97 * 100) / widest, hero ? HERO_MAX : base);
    return chunks.map((chunk) => flat.push({ word: w, text: chunk, size: fitted, face, spacing }) - 1);
  });
  // Rows: the words before the key word, the key word alone, the words after it; each fragment of a broken word alone.
  const groups: number[][] = [];
  let run: number[] = [];
  words.forEach((word, w) => {
    const list = indexes[w]!;
    if (word.role === "hero" || list.length > 1) {
      if (run.length) groups.push(run);
      run = [];
      for (const at of list) groups.push([at]);
    } else run.push(list[0]!);
  });
  if (run.length) groups.push(run);
  // The sample's row cap: words around a key word take at most two rows, a cue without one at most four, shrinking (not
  // below 92 px) until they do.
  for (const group of groups) {
    if (group.length < 2) continue;
    const at = (size: number) => greedyRows(group.map((i) => (at100(flat[i]!.text, flat[i]!.face, flat[i]!.spacing) * Math.min(size, flat[i]!.size)) / 100), WORD_GAP * size, ROW_W).length;
    let size = base;
    while (at(size) > (heroed ? 2 : 4) && size > ROW_FLOOR) size -= 4;
    for (const i of group) flat[i] = { ...flat[i]!, size: Math.min(size, flat[i]!.size) };
  }
  const { cells, unit: lu } = ctx.layout({
    column: ROW_W, padding: 40, gap: WORD_GAP * base, groups,
    words: flat.map((item) => ({ text: item.text, size: item.size, face: item.face, spacing: item.spacing })),
  });
  const rows = rowsOf(cells).sort((a, b) => a[0]!.baseline - b[0]!.baseline);
  const rowOf = new Map<SpeechCell, number>();
  rows.forEach((row, r) => {
    for (const cell of row) rowOf.set(cell, r);
  });
  const isSmall = (cell: SpeechCell) => cell.size / frame < SMALL_FS;
  const reachBelow = (cell: SpeechCell) => (DROP + (isSmall(cell) ? RIM_SMALL + KEYLINE_SMALL : RIM + KEYLINE)) * cell.size;

  // --- row pitch from the sample's spacing or the measured ink, whichever is taller ---
  const above = rows.map((row) => Math.max(...row.map((cell) => Math.max(-cell.inkTop, CAP * cell.size) + (isSmall(cell) ? RIM_SMALL : RIM) * cell.size)));
  const below = rows.map((row) => Math.max(...row.map((cell) => Math.max(0, cell.inkBottom) + reachBelow(cell))));
  const sizeOf = (r: number) => Math.max(...rows[r]!.map((cell) => cell.size));
  // Each row's largest motion past its rest ink is reserved too: a word's rise overshoots 12 px up at 104%, a key word's
  // letters 16 px at 105% and then the word swells 8% about its middle, and everything bobs 3 px.
  const heroRow = rows.map((row) => row.some((cell) => words[flat[cell.at]!.word]!.role === "hero"));
  const height = (r: number) => above[r]! + below[r]!;
  const reachUp = (r: number) => (heroRow[r] ? 20 * lu + 0.09 * height(r) : 16 * lu + 0.03 * height(r));
  const reachDown = (r: number) => (heroRow[r] ? 4 * lu + 0.06 * height(r) : 4 * lu);
  const pitch: number[] = [0];
  for (let r = 1; r < rows.length; r++) {
    const small = Math.min(sizeOf(r - 1), sizeOf(r));
    pitch.push(pitch[r - 1]! + Math.max(ROW_GAP * small + above[r]!, below[r - 1]! + reachDown(r - 1) + reachUp(r) + 0.04 * small + above[r]!));
  }
  const top0 = pitch[0]! - above[0]!;
  const bottom0 = pitch[rows.length - 1]! + below[rows.length - 1]!;
  const heroRowLast = heroed && rows[rows.length - 1]!.some((cell) => flat[cell.at]!.word === heroAt);
  // Centre on the anchor line; a last-row key word lifts the block up to half its string's room, inside the band.
  let offset = space.y(CY) - (top0 + bottom0) / 2;
  if (heroRowLast) offset -= Math.max(0, Math.min((STRING_ROOM / 2) * lu, offset + top0 - (bounds.y1 + 6 * lu)));
  offset += Math.max(0, bounds.y1 + 3 - (offset + top0));
  offset -= Math.max(0, offset + bottom0 - (bounds.y2 - 3));
  const baselineOf = (cell: SpeechCell) => pitch[rowOf.get(cell)!]! + offset;
  const blockTop = top0 + offset;

  // --- units: one per word, per fragment of a broken word, per letter of a key word ---
  const fps = ctx.fps;
  const units: Unit[] = [];
  words.forEach((word, w) => {
    const hero = word.role === "hero";
    const own = indexes[w]!.map((at) => cells.find((cell) => cell.at === at)!);
    const from = ctx.enter(word, RISE, ENTER).from;
    const add = (cell: SpeechCell, id: string, letter: number, letters: number, gx: number, gy: number) => {
      const baseline = baselineOf(rowOf.has(cell) ? cell : own[0]!);
      const small = isSmall(cell);
      const py = baseline - (letters > 1 ? 0.4 : 0.45) * CAP * cell.size;
      const bottom = baseline + Math.max(0, cell.inkBottom) + reachBelow(cell);
      const reach = (small ? RIM_SMALL + KEYLINE_SMALL : RIM + KEYLINE) * cell.size;
      units.push({
        id, word: w, hero, cell, baseline, small, px: cell.x, py, gx, gy: Number.isNaN(gy) ? py : gy, letter, letters, from, spoken: word.startMs,
        row: rowOf.get(rowOf.has(cell) ? cell : own[0]!)!,
        rise: Math.max(0, Math.min((hero ? 64 : 62) * lu, bounds.y2 - 3 - bottom)),
        box: { x1: cell.x - cell.width / 2 - reach, x2: cell.x + cell.width / 2 + reach, y1: baseline + cell.inkTop - reach, y2: bottom },
      });
    };
    if (own.length > 1) {
      own.forEach((cell, part) => {
        add(cell, `${ctx.id}:w${w}l${part}`, 0, 1, cell.x, Number.NaN);
      });
      return;
    }
    const cell = own[0]!;
    const letters = hero ? letterCells(cell, input, 12) : [cell];
    if (letters.length > 1) {
      const gy = baselineOf(cell) - 0.45 * CAP * cell.size;
      letters.forEach((letterCell, k) => {
        add({ ...letterCell, at: cell.at }, `${ctx.id}:w${w}l${k}`, k, letters.length, cell.x, gy);
      });
    } else add(cell, `${ctx.id}:w${w}`, 0, 1, cell.x, Number.NaN);
  });

  // --- the first word of a row eases in from nearer the centre; a landing word nudges its neighbour ---
  const rowUnits = rows.map((_, r) => units.filter((unit) => unit.row === r && unit.letter === 0));
  for (const list of rowUnits) {
    const ordered = [...list].sort((a, b) => a.word - b.word);
    if (ordered.length < 2) continue;
    const box = rowBounds(rows[ordered[0]!.row]!);
    const first = ordered[0]!;
    const next = ordered[1]!;
    const ms = Math.min(320, next.from - first.from);
    const dx = (box.x1 + box.x2) / 2 - first.px;
    if (!first.hero && paintedFrameCount(first.from, first.from + ms, fps) >= 2 && Math.abs(dx) > 2) first.slide = { dx, ms };
    for (let k = 1; k < ordered.length; k++) {
      const prev = ordered[k - 1]!;
      const here = ordered[k]!;
      if (!prev.hero) prev.nudge = { at: here.from + 30, dir: Math.sign(prev.px - here.px) || -1 };
    }
  }
  if (!heroed) {
    const last = units.filter((unit) => unit.word === words.length - 1);
    for (const unit of last) unit.puff = unit.from + 380;
  }

  // --- exit: a float up and a fade in the time the cue has after its reading hold ---
  const exitFrom = Math.max(exitAt, to - EXIT_MS);
  const exitOn = exit && paintedFrameCount(exitFrom, to, fps) >= 2;
  const fadeFrom = Math.max(exitFrom, to - FADE_MS);
  const lift = Math.max(0, Math.min(56 * lu, blockTop - bounds.y1 - 3));
  const move = (t: number) => (exitOn ? EASES.in(prog(t, exitFrom, to - exitFrom)) : 0);
  const fade = (t: number) => (exitOn ? prog(t, fadeFrom, to - fadeFrom) : 0);

  const bob = (t: number, s: number, phase: number) => {
    const settle = EASES.out(prog(t, s + 320, 400));
    const a = ((t - s) / 1700) * Math.PI * 2 + phase;
    return { y: Math.sin(a) * 3.2 * lu * settle, r: Math.sin(a * 0.8 + 1) * 0.7 * settle };
  };
  const stagger = (unit: Unit) => (unit.letters > 1 ? Math.min(STAGGER, STAGGER_TOTAL / (unit.letters - 1)) : 0);
  const waveEnd = (unit: Unit) => unit.from + (unit.letters - 1) * stagger(unit) + RISE;
  const ramp = (unit: Unit, t: number) => (unit.spoken > unit.from ? clamp((t - unit.from) / (unit.spoken - unit.from)) : 1);

  /** A hero group's pose applied to a point at rest (`x`, `y` plus a rise `dy`), with the point's own scale. */
  const heroPose = (unit: Unit, t: number, x: number, y: number, dy: number, own: number): Pose => {
    const swell = kf(t - (waveEnd(unit) - 120), [[0, 1], [190, 1.08, "out"], [SWELL_MS, 1, "inOut"]]);
    const b = bob(t, unit.spoken, 0.6);
    const m = move(t);
    const gs = swell * (1 - 0.05 * m);
    const angle = (b.r * Math.PI) / 180;
    const vx = x - unit.gx;
    const vy = y + dy - unit.gy;
    return {
      x: unit.gx + gs * (vx * Math.cos(angle) - vy * Math.sin(angle)),
      y: unit.gy + b.y - lift * m + gs * (vx * Math.sin(angle) + vy * Math.cos(angle)),
      s: gs * own,
      r: b.r,
      o: ramp(unit, t) * (1 - fade(t)),
    };
  };
  const pose = (unit: Unit, t: number): Pose => {
    if (unit.hero) {
      const lt = t - (unit.from + unit.letter * stagger(unit));
      const dy = kf(lt, [[0, unit.rise], [220, -16 * lu, "out"], [RISE, 0, "inOut"]]);
      const s = kf(lt, [[0, 0.8], [220, 1.05, "out"], [RISE, 1, "inOut"]]);
      return heroPose(unit, t, unit.px, unit.py, dy, s);
    }
    const rel = t - unit.from;
    const b = bob(t, unit.spoken, unit.word * 1.7 + index);
    const m = move(t);
    const slide = unit.slide ? unit.slide.dx * (1 - EASES.inOut(prog(t, unit.from, unit.slide.ms))) : 0;
    const nudge = unit.nudge ? unit.nudge.dir * 5 * lu * Math.sin(Math.PI * prog(t, unit.nudge.at, 280)) : 0;
    const puff = unit.puff === undefined ? 1 : kf(t - unit.puff, [[0, 1], [170, 1.05, "out"], [460, 1, "inOut"]]);
    return {
      x: unit.px + slide + nudge,
      y: unit.py + kf(rel, [[0, unit.rise], [210, -12 * lu, "out"], [RISE, 0, "inOut"]]) + b.y - lift * m,
      s: kf(rel, [[0, 0.84], [210, 1.04, "out"], [RISE, 1, "inOut"]]) * puff * (1 - 0.05 * m),
      r: b.r,
      o: ramp(unit, t) * (1 - fade(t)),
    };
  };
  const trackOf = (fn: (t: number) => Pose, from: number, edges: readonly number[]): Track => {
    const end = Math.max(from + 1, to);
    const sample = (pick: (p: Pose) => number, tolerance: number) =>
      sampleFrames((t) => pick(fn(t)), [from, ...edges.filter((edge) => edge > from && edge < end), end], tolerance, { range: [from, end], wholeMs: true, simplify: true });
    const scale = sample((p) => p.s, 0.002);
    return { x: sample((p) => p.x, 0.25), y: sample((p) => p.y, 0.25), sx: scale, sy: scale, rz: sample((p) => p.r, 0.05), o: sample((p) => p.o, 0.01) };
  };
  const edgesOf = (unit: Unit) => {
    const list = [unit.spoken, unit.from + RISE, unit.spoken + 320, unit.spoken + 720, exitFrom, fadeFrom];
    if (unit.hero) list.push(unit.from + unit.letter * stagger(unit) + 220, unit.from + unit.letter * stagger(unit) + RISE, waveEnd(unit) - 120, waveEnd(unit) + 70, waveEnd(unit) + 400);
    else list.push(unit.from + 210);
    if (unit.slide) list.push(unit.from + unit.slide.ms);
    if (unit.nudge) list.push(unit.nudge.at, unit.nudge.at + 280);
    if (unit.puff !== undefined) list.push(unit.puff, unit.puff + 170, unit.puff + 460);
    return list;
  };

  // --- pieces ---
  const pieces: Piece[] = [];
  const zBase = 10;
  units.forEach((unit, k) => {
    const { cell } = unit;
    const size = cell.size;
    const z = zBase + k * 8;
    const track = trackOf((t) => pose(unit, t), unit.from, edgesOf(unit));
    const origin = { dx: unit.px - cell.x, dy: unit.py - unit.baseline };
    const rim = (unit.small ? RIM_SMALL : RIM) * size;
    const deep = unit.small ? DEEP_SMALL : DEEP;
    const keyline = rim + (unit.small ? KEYLINE_SMALL : KEYLINE) * size;
    // A word that paints on one frame only (fast speech at 24/25 fps) keeps its dark keyline and base in its own face piece,
    // since the shared filter drops every other piece that paints once.
    if (paintedFrameCount(unit.from, to, fps) < 2) {
      pieces.push({
        id: unit.id, kind: "text", z: z + 3, fromMs: unit.from, toMs: to, track, origin,
        text: cell.text, face: cell.face, sizePx: size, letterSpacingEm: cell.spacing, fill: pal.face,
        anchor: "baseline-center", language: cue.language,
        stroke: { widthPx: keyline, colour: pal.shadow }, shadows: [{ dx: 0, dy: DROP * size, blur: 0, colour: pal.shadow, alpha: 1 }],
      });
      return;
    }
    const face: TextPiece = {
      id: unit.id, kind: "text", z: z + 3, fromMs: unit.from, toMs: to, track, origin,
      text: cell.text, face: cell.face, sizePx: size, letterSpacingEm: cell.spacing, fill: pal.face,
      anchor: "baseline-center", language: cue.language,
    };
    const copy = (suffix: string, dz: number, fill: string, dx: number, dy: number, extra: Partial<TextPiece> = {}): TextPiece => ({
      ...face, id: `${unit.id}${suffix}`, z: z + dz, fill, origin: { dx: origin.dx - dx, dy: origin.dy - dy }, ...extra,
    });
    pieces.push(
      copy("s", 0, pal.shadow, 0, DROP * size, {
        stroke: { widthPx: keyline, colour: pal.shadow },
      }),
      copy("r", 1, pal.rim, 0, 0, { stroke: { widthPx: rim, colour: pal.rim } }),
      copy("d", 2, pal.deep, deep[0] * size, deep[1] * size),
      face,
    );
    if (unit.hero) {
      // One lighter hard band across the upper face, for volume: the top 36% of the cap height (of the ink for other scripts).
      const inkTop = cell.inkTop;
      const height = FREDOKA.test(cell.text) ? CAP * size : cell.inkBottom - cell.inkTop;
      const capTop = FREDOKA.test(cell.text) ? -CAP * size : inkTop;
      pieces.push(copy("b", 4, band, 0, 0, {
        clip: { x1: [[unit.from, -(cell.width / 2) - 4 * lu - origin.dx]], x2: [[unit.from, cell.width / 2 + 4 * lu - origin.dx]], y1: [[unit.from, inkTop - 6 * lu - origin.dy]], y2: [[unit.from, capTop + BAND_SHARE * height - origin.dy]], radius: 0 },
      }));
    }
    // The shine: per letter from the font for Fredoka words, else one pill of white over the upper left of the measured ink.
    if (FREDOKA.test(cell.text)) {
      const letters = graphemes(cell.text);
      const lefts: number[] = [];
      let prefix = "";
      for (const letter of letters) {
        lefts.push(-cell.width / 2 + (prefix ? input.measure(prefix, cell.face, size, cell.spacing).advance + cell.spacing * size : 0));
        prefix += letter;
      }
      const raw = shinePath(letters, lefts, cell.face, size);
      if (raw.length) {
        const placed = fromTopLeft(raw);
        const shine: ShapePiece = {
          id: `${unit.id}g`, kind: "shape", z: z + 5, fromMs: unit.from, toMs: to, track,
          origin: { dx: origin.dx - placed.x, dy: origin.dy - placed.y }, path: placed.path, fill: { colour: SHINE },
        };
        pieces.push(shine);
      }
    } else {
      const w = cell.width;
      const h = cell.inkBottom - cell.inkTop;
      const pillH = Math.max(0.09 * size, 0.16 * h);
      const x1 = -w / 2 + 0.1 * w;
      const pillW = Math.min(0.38 * w, Math.max(2.2 * pillH, 0.18 * w));
      const y1 = cell.inkTop + 0.1 * h;
      pieces.push(copy("g", 5, SHINE, 0, 0, {
        clip: { x1: [[unit.from, x1 - origin.dx]], x2: [[unit.from, x1 + pillW - origin.dx]], y1: [[unit.from, y1 - origin.dy]], y2: [[unit.from, y1 + pillH - origin.dy]], radius: pillH / 2 },
      }));
    }
  });

  // --- the balloon string, under the key word when it is the last row and the band has room ---
  const heroUnits = units.filter((unit) => unit.hero);
  if (heroRowLast && heroUnits.length && heroUnits.every((unit) => unit.row === rows.length - 1)) {
    const k = Math.floor(heroUnits.length * 0.4);
    const knotUnit = heroUnits[Math.min(k, heroUnits.length - 1)]!;
    const size = knotUnit.cell.size;
    const kx = heroUnits.length > 1 ? knotUnit.px : knotUnit.px - 0.1 * knotUnit.cell.width;
    const ky = knotUnit.baseline + DROP * size + 6 * lu;
    // Room at peak swell, inside the band.
    const room = Math.min(STRING_MAX * lu, bounds.y2 - 4 * lu - (ky + 0.08 * 0.55 * CAP * size));
    const start = waveEnd(knotUnit) - 40;
    if (room >= STRING_MIN * lu && paintedFrameCount(start, to, fps) >= 2) {
      const scaleK = room / (STRING_MAX * lu);
      const kn = 0.05 * size;
      const q = (v: number) => v * scaleK * lu;
      const curl: PathCmd[] = [
        ["M", 0, kn * 1.5],
        ["C", q(16), kn * 1.5 + q(14), q(16), kn * 1.5 + q(30), 0, kn * 1.5 + q(44)],
        ["C", q(-16), kn * 1.5 + q(58), q(-16), kn * 1.5 + q(74), q(2), kn * 1.5 + q(90)],
        ["C", q(12), kn * 1.5 + q(100), q(18), kn * 1.5 + q(110), q(8), kn * 1.5 + q(122)],
      ];
      const knot: PathCmd[] = [["M", -kn, 0], ["L", kn, 0], ["L", 0, kn * 1.5], ["Z"]];
      const reveal = Math.min(380, Math.max(70, to - start));
      const stringTrack = trackOf((t) => heroPose(knotUnit, t, kx, ky, 0, 1), start, [start + reveal, waveEnd(knotUnit) + 70, waveEnd(knotUnit) + 400, exitFrom, fadeFrom]);
      const clip = {
        x1: [[start, kx - 60 * lu]] as const, x2: [[start, kx + 60 * lu]] as const,
        y1: [[start, ky - 40 * lu]] as const, y2: [[start, ky - 2 * lu], [start + reveal, ky + room + 40 * lu, "out"]] as const,
      };
      const shape = (id: string, path: PathCmd[], extra: Partial<ShapePiece>): ShapePiece => {
        const placed = fromTopLeft(path);
        return { id: `${ctx.id}:${id}`, kind: "shape", z: 6, fromMs: start, toMs: to, track: stringTrack, origin: { dx: -placed.x, dy: -placed.y }, path: placed.path, clip: { x1: [...clip.x1], x2: [...clip.x2], y1: [...clip.y1], y2: [...clip.y2] }, ...extra };
      };
      pieces.push(
        shape("str", curl, { stroke: { widthPx: 8 * lu, colour: pal.shadow } }),
        shape("knot", knot, { fill: { colour: pal.face }, stroke: { widthPx: 5 * lu, colour: pal.shadow } }),
      );
    }
  }

  // --- two small balloons released beside the last row: at the key word's swell, or as the last word lands ---
  const seed = heliumHash(`${index}|${texts.join(" ")}`);
  const lastRow = rows.length - 1;
  const releaseUnit = heroed ? heroUnits[heroUnits.length - 1]! : units[units.length - 1]!;
  const release = heroed ? waveEnd(releaseUnit) - 100 : releaseUnit.from + 300;
  const stop = exitOn ? exitFrom : to;
  // Word boxes as wide as they get: the key word's swell (8% about its centre), a word's overshoot, nudge and puff.
  const heroSpan = (w: number) => {
    const list = units.filter((unit) => unit.word === w);
    return Math.max(...list.map((unit) => unit.box.x2)) - Math.min(...list.map((unit) => unit.box.x1));
  };
  const boxes = units.map((unit) => {
    const h = unit.box.y2 - unit.box.y1;
    const dx = unit.hero ? 0.05 * heroSpan(unit.word) : 0.04 * (unit.box.x2 - unit.box.x1) + 6 * lu;
    return { x1: unit.box.x1 - dx, x2: unit.box.x2 + dx, y1: unit.box.y1 - 0.06 * h, y2: unit.box.y2 + 0.04 * h };
  });
  const hits = (box: Box) => boxes.some((other) => box.x1 < other.x2 && other.x1 < box.x2 && box.y1 < other.y2 && other.y1 < box.y2);
  const rowBox = (r: number) => {
    const list = units.flatMap((unit, at) => (unit.row === r ? [boxes[at]!] : []));
    return { x1: Math.min(...list.map((b) => b.x1)), x2: Math.max(...list.map((b) => b.x2)), y1: Math.min(...list.map((b) => b.y1)), y2: Math.max(...list.map((b) => b.y2)) };
  };
  const wanted = (26 + (seed % 9)) * lu;
  const drift = (38 + ((seed >>> 3) % 24)) * lu;
  const firstSide = (index % 2 === 0 ? 1 : -1) * (ctx.rtl ? -1 : 1);
  const from0 = Math.max(ctx.window.from, release);
  const frames0 = paintedFrameCount(from0, Math.min(stop, from0 + BALLOON_MS), fps);
  // Beside the last row (then the key word's row), this cue's side first: the largest pair (or single balloon) that fits
  // the room beside the row, clear of every word on its way up, inside the band.
  interface Cluster { readonly x: number; readonly y: number; readonly side: number; readonly r: number; readonly count: number; readonly rise: number }
  let cluster: Cluster | null = null;
  const rowsToTry = [lastRow, ...(heroed ? [units.find((unit) => unit.hero)!.row] : [])];
  search: for (const row of [...new Set(rowsToTry)]) {
    for (const side of [firstSide, -firstSide]) {
      const rb = rowBox(row);
      const room = side > 0 ? bounds.x2 - 4 * lu - rb.x2 : rb.x1 - (bounds.x1 + 4 * lu);
      for (const count of [2, 1]) {
        const r = Math.min(wanted, room / (count === 2 ? 3.35 : 2.35));
        if (r < 15 * lu) continue;
        const x = side > 0 ? rb.x2 + 1.4 * r : rb.x1 - 1.4 * r;
        const y = (rb.y1 + rb.y2) / 2;
        for (const rise of frames0 < 4 ? [0] : [drift, drift / 2, 0]) {
          const reach = count === 2 ? 1.25 * r + 0.6 * r : 0.84 * r;
          const box = { x1: Math.min(x - 0.9 * r, x + side * (reach + 0.3 * r)), x2: Math.max(x + 0.9 * r, x + side * (reach + 0.3 * r)), y1: y - rise - 1.1 * r, y2: y + (count === 2 ? 1.6 : 1.15) * r };
          const inside = box.x1 >= bounds.x1 + 2 && box.x2 <= bounds.x2 - 2 && box.y1 >= bounds.y1 + 2 && box.y2 <= bounds.y2 - 2;
          if (inside && !hits(box)) {
            cluster = { x, y, side, r, count, rise };
            break search;
          }
        }
      }
    }
  }
  for (let j = 0; cluster && j < cluster.count; j++) {
    const { side } = cluster;
    const r = j === 0 ? cluster.r : cluster.r * 0.7;
    const from = Math.max(ctx.window.from, release + j * 130);
    const end = Math.min(stop, from + BALLOON_MS);
    const frames = paintedFrameCount(from, end, fps);
    if (frames < 2) continue;
    const still = frames < 4;
    const rise = still ? 0 : cluster.rise * (j === 0 ? 1 : 0.8);
    const spot = { x: cluster.x + (j === 0 ? 0 : side * 1.25 * cluster.r), y: cluster.y + (j === 0 ? 0 : 0.75 * cluster.r) };
    // The balloons drift away from the words, never toward them.
    const sway = side * (0.1 + 0.1 * ((seed >>> (5 + j)) % 2)) * cluster.r;
    const span = end - from;
    const pop = Math.min(180, span * 0.3);
    const bodyPath = [...ellipsePath(0, 0, 0.84 * r, r), ["M", -0.16 * r, 1.08 * r] as PathCmd, ["L", 0.16 * r, 1.08 * r] as PathCmd, ["L", 0, 0.94 * r] as PathCmd, ["Z"] as PathCmd];
    const glint = sliverPath(-0.48 * r, -0.12 * r, -0.44 * r, -0.52 * r, -0.12 * r, -0.66 * r, 0.2 * r);
    const scale: Track["sx"] = still ? [[from, 1]] : [[from, 0.8], [from + pop, 1, "outBack"]];
    const motion: Track = {
      x: still ? [[from, spot.x]] : [[from, spot.x], [from + span * 0.5, spot.x + sway, "inOut"], [end, spot.x + sway * 0.6, "inOut"]],
      y: still ? [[from, spot.y]] : [[from, spot.y], [end, spot.y - rise, "out"]],
      sx: scale, sy: scale,
      o: still ? [[from, 1]] : [[from, 1], [Math.max(from + pop, end - 160), 1], [end, 0]],
    };
    for (const [suffix, path, fill, z] of [["", bodyPath, pal.face, 4], ["g", glint, SHINE, 5]] as const) {
      const placed = fromTopLeft(path);
      pieces.push({
        id: `${ctx.id}:bal${j}${suffix}`, kind: "shape", z, fromMs: from, toMs: end, track: motion,
        origin: { dx: -placed.x, dy: -placed.y }, path: placed.path, fill: { colour: fill },
        ...(suffix === "" ? { stroke: { widthPx: 3 * lu, colour: pal.shadow } } : {}),
      });
    }
  }
  // Later cues paint over earlier ones.
  return pieces.map((piece) => ({ ...piece, z: piece.z + index * 400 }));
});

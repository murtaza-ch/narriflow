import type { DemoScript } from "../demo";
import { EASES, type Frames, clamp, kf, lerp, prog } from "../ease";
import { sampleFrames } from "../frames";
import { SCENE_DEFAULT_FPS, exportFrameAtOrAfter, exportFrameTimes, sceneSampleRate } from "../frame-grid";
import type { SceneCue, SceneInput, SceneProgram } from "../input";
import { balancedRows, clampToSafeArea, cueDirection, greedyRows, rowVisualOrder, sceneSpace, shiftPiece } from "../layout";
import { type CaptionScene, type Clip, type PathCmd, type Piece, type ShapePiece, type TextPiece, type Track, evaluatePiece, pieceBounds, pieceLocalBox } from "../scene";
import { polygonPath, polylinePath, roundedRectPath } from "../shapes";
import type { CaptionFontName } from "@narriflow/validators";

/**
 * Ransom (`samples/templates/m18-collage.js`, after Motion Array "Collage And Paper Titles"): a paper collage. Every row of the
 * caption sits on its own torn paper strip that snaps on as it is spoken, each on a slightly different tilt over a torn white
 * under-layer; the key word is a ransom note, one cut-out tile per letter in clashing faces and colours that fly in and settle.
 * Everything boils like stop-motion (a fresh jitter every 150 ms) until a paper roll sweeps the cue away.
 *
 * Geometry is the sample's (Chrome's boxes, recomputed from `measure()`): Alfa Slab One capitals 118 px on strips padded
 * 0.08/0.3/0.04 em (rows of only minor words: Anton 74 px, 0.12/0.38/0.1 em), 0.26 em between words, hero tiles 170 px with a
 * 0.86 to 1.1 scale each, rows fitted to 860 px, the block centred on y 1290.
 *
 * What changed from the sample, and why (gallery-2 and gallery-3 briefs):
 *  - Rows came from the demo's baked " / " splits (`rowsOf[ci]`). They derive from the words now: the hero is its own row (each run of
 *    hero words, wrapped evenly), and the words around it wrap evenly into strips; a run of two or more minor words gets its own
 *    small Anton strip (the sample's "is a"), a lone minor word stays on its neighbour's strip.
 *  - **A row holding the hero rendered only the hero and dropped its other words** (L111-156). Every spoken word is on screen.
 *  - `STRIPS[strip++]`, `TILES[(li*3+ci)%7]`, `FACES[(li+ci*2)%4]`, the tilt parity `ci % 2` and the strip colour start `ci` were cue
 *    indexed (and threw past the demo). Strip colours and tilt direction cycle on a running row counter, tile colours and faces on a
 *    counter of the hero words, and every jitter (tilt, shift, scrap cut, tile scale, spin, fly-in) is a seeded hash of the cue's
 *    index and words (a mulberry32 stream like the sample's); never `Math.random`.
 *  - A block of many rows or a long hero is fitted: strips shrink for a word wider than a row, the hero row fits the safe width,
 *    and a block taller than 720 px scales down. Hero tiles split per grapheme only for Latin, Cyrillic and Greek words of up to 16
 *    letters (24 per cue); any other script, an emoji or a longer word is one tile with the same fly-in. Capitals only for those
 *    scripts. Rows of a right-to-left cue run right to left and the strips grow, tear and sweep out from the right.
 *  - The roll ran x 40 to 1060 (outside the safe margin) and wiped words still being spoken, and the cue showed from `start - 140`.
 *    The roll sweeps the block's own width and its bar stays inside the safe area; the exit waits until the last word has landed and
 *    been readable for 150 ms, never starts later than 80 ms before 50 ms past the cue's end (the next cue's strip may snap on
 *    over it, as in the sample), and runs 80 to 200 ms. Each piece shows from its own entrance.
 *    The roll waits through the spoken end too; overlapping speakers stack, and every later live cue is checked for a collision.
 *    Frame counts and onset times come from the shared export grid at the render's actual frame rate.
 *  - The stepped boil is kept on strips (+-2 px, +-0.9 deg) and tiles (+-2.4 px, +-1.08 deg, after they settle) as a stepped track.
 *  - The tile's `drop-shadow` is fully cut by the tile's own `clip-path` in Chrome, so it is not drawn; the strip's soft shadow is
 *    one blurred copy of the under-layer. The tile's ragged cut is its polygon.
 *  - The scrap `outBack(p, 1.8)` is sampled from the sample's own curve (the engine's named outBack is 1.70158).
 *  - New recurring beats in the same paper language, on every cue: a translucent tape scrap pinning the start of every strip, a loose
 *    colour scrap that drops in beside the hero (beside the last strip on a cue without a hero) from alternating sides, and a hand-scribbled
 *    navy underline (wave, zigzag or double wave) drawn left to right under the hero (under the last strip when there is none).
 */

export const RANSOM_DEMO: DemoScript = {
  lines: [
    "taste is:m a:m skill:h@600",
    "nobody:b is:m born:b with:m it",
    "copy:b what:m you:m love:h@560",
    "then:m make:b it yours:h@620",
  ],
  options: { rate: 285, cueGap: 160, tail: 900 },
};

const CX = 540;
const CY = 1290;
const BIG = 118;
const SMALL = 74;
const HERO = 170;
const MAX_W = 860;
const BOIL = 150;
const MAX_BLOCK = 720;
const SHRINK_FLOOR = 0.74;
const MAX_LETTERS = 16;
const MAX_CUE_LETTERS = 24;
const BAND = 26;
const EXIT = 200;
const HOLD = 150;
const CLEAR = 50;
/** The shortest window that is sampled on two export frames (67 ms at 30 fps): a roll or entrance shorter than this is a cut. */
const twoFramesMs = (fps: number) => Math.ceil(2000 / sceneSampleRate(fps));
/** Entrances never run faster than this share of the sample's pace (the strip's 200 ms tear then still spans two frames). */
const speedMinOf = (fps: number) => Math.max(0.35, twoFramesMs(fps) / 200);
/** How early a word's first piece may show: the sample's strip leads by 70 ms, the hero's tiles by 100 ms (the rule's limit). */
const LEAD_STRIP = 70;
const LEAD_HERO = 100;
/** Where a word's ink has settled: a strip's tear is at its final width by half its run, a tile's flight by 0.8 of its run. */
const SETTLE_STRIP = 0.5;
const SETTLE_TILE = 0.8;
/** A cue that is this many ms short of its HOLD keeps the sample's entrance pace. */
const HOLD_SLACK = 12;

const BIG_FACE = "Alfa Slab One" as const;
const SMALL_FACE = "Anton" as const;
const HERO_FACES = ["Alfa Slab One", "Anton", "Abril Fatface", "Archivo Black"] as const satisfies readonly CaptionFontName[];

const MAGENTA = "#D81E78";
const TEAL = "#2E9C93";
const YELLOW = "#F6D13A";
const CREAM = "#FFF1D2";
const NAVY = "#1D2A7A";
const CURL = "#D9D2C2";
const TAPES = ["#F4E7A8", "#CDE6E2", "#F6CFDB"] as const;
const SHADOW = "#281400";

/** The sample's seeded generator (mulberry32). */
export function ransomRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a of a string: the seed that makes a cue's jitter a pure function of its index and words. */
export function ransomHash(text: string): number {
  let h = 0x811c9dc5;
  for (let at = 0; at < text.length; at++) {
    h ^= text.charCodeAt(at);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The sample's stepped boil: a fixed offset per (piece, step), in sample px and degrees. */
export function ransomBoil(id: number, step: number, amp = 1): { x: number; y: number; r: number } {
  const r = ransomRng(Math.imul(id, 7919) + Math.imul(step, 104729));
  return { x: (r() - 0.5) * 4 * amp, y: (r() - 0.5) * 4 * amp, r: (r() - 0.5) * 1.8 * amp };
}

const SIMPLE = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Common}\p{Script=Inherited}]+$/u;
const PICTO = /\p{Extended_Pictographic}/u;

/** Capitals for cased scripts only; any other script is drawn as spoken. */
export function ransomCase(text: string): string {
  return SIMPLE.test(text) && !PICTO.test(text) ? text.toUpperCase() : text;
}

function graphemes(text: string): string[] {
  const Segmenter = (Intl as { Segmenter?: new (locale?: string, options?: { granularity: "grapheme" }) => { segment(input: string): Iterable<{ segment: string }> } }).Segmenter;
  return Segmenter ? [...new Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((part) => part.segment) : [...text];
}

type Pt = [number, number];
type Fn = (t: number) => number;

/** How far a piece is drawn on its first painted frame: never a blank frame (cue handoff rule: an immediately visible pose). */
const FIRST_O = 0.55;

/** The sample's `outBack(p, 1.8)`. */
const outBack18 = (p: number) => 1 + 2.8 * (p - 1) ** 3 + 1.8 * (p - 1) ** 2;

/** The sample's torn strip: straight-ish ends, ragged long edges (points from the strip's top-left, canvas px). */
export function ransomTorn(w: number, h: number, rag: number, r: () => number, u: number): Pt[] {
  const g = rag * u;
  const n = Math.max(4, Math.round(w / (16 * u)));
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) pts.push([(w * i) / n, (r() - 0.5) * g * 2 + (i % 2 ? g * 0.5 : 0)]);
  pts.push([w + (r() - 0.3) * g * 1.5, h * 0.5]);
  for (let i = n; i >= 0; i--) pts.push([(w * i) / n, h + (r() - 0.5) * g * 2 - (i % 2 ? g * 0.5 : 0)]);
  pts.push([(r() - 0.7) * g * 1.5, h * 0.5]);
  return pts;
}

/** A path from points moved so its bounds start at (0, 0), and where that corner was: libass aligns a drawing by its own box. */
function anchored(points: readonly Pt[]): { path: PathCmd[]; minX: number; minY: number } {
  const minX = Math.min(...points.map((p) => p[0]));
  const minY = Math.min(...points.map((p) => p[1]));
  return { path: polygonPath(points.map(([x, y]) => [x - minX, y - minY] as const)), minX, minY };
}

/** Keyframes of `fn` over `[from, to]`: smooth parts sampled, a hard jump (a boil step) as a 1 ms ramp at each cut. */
function jumpFrames(fn: Fn, from: number, to: number, cuts: readonly number[], edges: readonly number[], tolerance: number): Frames {
  const marks = [...new Set(cuts.map(Math.ceil))].filter((c) => c > from + 1 && c < to).sort((a, b) => a - b);
  const out: [number, number][] = [];
  const run = (segFrom: number, segTo: number) => {
    if (segTo - segFrom < 1) {
      out.push([segFrom, fn(segFrom)]);
      return;
    }
    for (const frame of sampleFrames(fn, edges, tolerance, { range: [segFrom, segTo], wholeMs: true, simplify: true })) out.push([frame[0], frame[1]]);
    const last = out[out.length - 1]!;
    if (last[0] < segTo) out.push([segTo, last[1]]);
  };
  let a = from;
  for (const m of marks) {
    run(a, m - 1);
    a = m;
  }
  run(a, to);
  return out;
}

/** Multiples of the boil step in `(from, to)`. */
function boilCuts(from: number, to: number): number[] {
  const cuts: number[] = [];
  for (let t = Math.ceil((from + 1) / BOIL) * BOIL; t < to; t += BOIL) cuts.push(t);
  return cuts;
}

interface Counters {
  rows: number;
  strips: number;
  heroes: number;
  plains: number;
}

interface Word {
  readonly index: number;
  readonly text: string;
  readonly minor: boolean;
  readonly hero: boolean;
  readonly letters: readonly string[] | null;
}

interface TileSpec {
  readonly ch: string;
  readonly face: CaptionFontName;
  readonly fill: string;
  readonly ink: string;
  readonly sc: number;
  readonly poly: readonly Pt[];
  readonly rot: number;
  readonly dy: number;
  readonly fromX: number;
  readonly fromY: number;
  readonly fromR: number;
  readonly id: number;
}

interface StripRow {
  readonly kind: "strip";
  readonly idx: readonly number[];
  readonly small: boolean;
  readonly size: number;
  readonly face: CaptionFontName;
  readonly ls: number;
  readonly padX: number;
  readonly padT: number;
  readonly padB: number;
  readonly w: number;
  readonly h: number;
  readonly lefts: readonly number[];
  readonly advs: readonly number[];
  readonly baseline: number;
  top: number;
}

interface HeroWordLayout {
  readonly word: Word;
  readonly specs: readonly TileSpec[];
  readonly dims: readonly { w: number; h: number; f: number; padT: number; delta: number; lx: number }[];
}

interface HeroRow {
  readonly kind: "hero";
  readonly words: readonly HeroWordLayout[];
  readonly hf: number;
  readonly w: number;
  readonly h: number;
  top: number;
}

type Row = StripRow | HeroRow;

const TILE_PAD = (face: CaptionFontName) => (face === "Anton" ? { x: 0.14, t: 0.08, b: 0.06 } : { x: 0.12, t: 0.1, b: 0.08 });

/** Per word: how many letter tiles its hero is split into (0 = not split: a strip word, or one tile for any other script). */
function heroSplits(cue: SceneCue): number[] {
  let total = 0;
  return cue.words.map((word) => {
    const text = ransomCase(word.text);
    const parts = graphemes(text);
    const split = word.role === "hero" && SIMPLE.test(text) && !PICTO.test(text) && parts.length > 1 && parts.length <= MAX_LETTERS && total + parts.length <= MAX_CUE_LETTERS;
    if (split) total += parts.length;
    return split ? parts.length : 0;
  });
}

/** A word's lead before its spoken start: the sample's, shrunk toward 0 (never past its start) when the cue may not show before `notBefore`. */
const leadOf = (word: { role: string; startMs: number }, notBefore: number) => Math.min(word.role === "hero" ? LEAD_HERO : LEAD_STRIP, Math.max(0, word.startMs - notBefore));

/** The first frame a cue draws (cue handoff rule): its earliest word's lead before its start, no earlier than `notBefore`. */
export function ransomEntryMs(cue: SceneCue, notBefore = Number.NEGATIVE_INFINITY, fps = SCENE_DEFAULT_FPS): number {
  return exportFrameAtOrAfter(Math.min(...cue.words.map((word) => word.startMs - leadOf(word, notBefore))), fps);
}

/** When the cue's last word could be readable for HOLD ms at the sample's own entrance pace (and has been spoken), with no roll: what it asks of the next cue's entry. */
export function ransomNeedMs(cue: SceneCue, notBefore = Number.NEGATIVE_INFINITY): number {
  const splits = heroSplits(cue);
  const letterTotal = splits.reduce((a, b) => a + b, 0);
  const stagger0 = Math.min(26, 150 / Math.max(1, letterTotal));
  let land = cue.startMs;
  cue.words.forEach((word, at) => {
    const rise = word.startMs - leadOf(word, notBefore);
    land = Math.max(land, word.role === "hero" ? rise + (Math.max(1, splits[at]!) - 1) * stagger0 + SETTLE_TILE * 300 : rise + SETTLE_STRIP * 200);
  });
  // Never before its last word has been spoken either.
  return Math.max(land + HOLD, ...cue.words.map((word) => word.endMs));
}

function buildCue(cue: SceneCue, cueNumber: number, input: SceneInput, counters: Counters, handoff: number, notBefore: number, forceSpeed?: number, offsetY = 0): Piece[] {
  const space = sceneSpace(input, CY);
  const { u, safe } = space;
  const rtl = cueDirection(cue) === "rtl";
  const sgn = rtl ? -1 : 1;
  const BX = space.x(CX);
  const BY = space.y(CY) + offsetY;
  const safeW = safe.x2 - safe.x1;
  const limit = Math.max(0.5 * safeW, Math.min(MAX_W * u, safeW - 120 * u));
  const band = cueNumber * 10;
  const fps = input.fps ?? SCENE_DEFAULT_FPS;
  const ROLL_MIN = twoFramesMs(fps);
  const frameAt = (t: number) => exportFrameAtOrAfter(t, fps);
  const framesIn = (from: number, to: number) => exportFrameTimes(from, to, fps);
  const seed = ransomHash(`${cue.index}|${cue.words.map((word) => word.text).join(" ")}`);
  const hl = input.colours.highlight;
  const paper = input.colours.primary;
  const STRIPS: readonly (readonly [string, string])[] = [[hl, NAVY], [TEAL, CREAM], [MAGENTA, CREAM], [YELLOW, NAVY]];
  const TILES: readonly (readonly [string, string])[] = [[MAGENTA, CREAM], [YELLOW, NAVY], [CREAM, MAGENTA], [TEAL, YELLOW], [NAVY, CREAM], [hl, NAVY], [CREAM, TEAL]];

  // --- words ---
  const splits = heroSplits(cue);
  const words: Word[] = cue.words.map((word, index) => {
    const text = ransomCase(word.text);
    return { index, text, minor: word.role === "minor", hero: word.role === "hero", letters: splits[index]! > 0 ? graphemes(text) : null };
  });
  const riseAt = (index: number) => cue.words[index]!.startMs - leadOf(cue.words[index]!, notBefore);
  const adv = (text: string, face: CaptionFontName, size: number, ls: number) => input.measure(text, face, size, ls).advance + ls * size;
  const baselineOf = (face: CaptionFontName, size: number) => {
    const m = input.measure("H", face, size, 0);
    return (size - (m.ascent + m.descent)) / 2 + m.ascent;
  };

  // --- tile specs: random choices only, never sizes ---
  const heroCounter = counters.heroes;
  const specsOf = (word: Word, heroOrdinal: number): TileSpec[] => {
    const r = ransomRng(seed ^ Math.imul(word.index + 1, 0x85ebca6b));
    const chars = word.letters ?? [word.text];
    return chars.map((ch, li) => {
      const [fill, ink] = word.letters ? TILES[(li * 3 + heroOrdinal * 2 + (seed % 7)) % TILES.length]! : TILES[(heroOrdinal * 3 + (seed % 7)) % TILES.length]!;
      const face: CaptionFontName = word.letters ? HERO_FACES[(li + heroOrdinal * 2) % HERO_FACES.length]! : BIG_FACE;
      const sc = 0.86 + r() * 0.24;
      const j = () => r() * 0.07;
      const poly: Pt[] = [];
      const ys = [j(), j(), j(), j(), j(), j(), j(), j()];
      const c1 = 0.5 + (r() - 0.5) * 0.1;
      const c2 = 0.5 + (r() - 0.5) * 0.1;
      poly.push([ys[0]!, ys[1]!], [1 - ys[2]!, ys[3]!], [1, c1], [1 - ys[4]!, 1 - ys[5]!], [ys[6]!, 1 - ys[7]!], [0, c2]);
      return { ch, face, fill, ink, sc, poly, rot: (r() - 0.5) * 12, dy: (r() - 0.5) * 0.08, fromX: (r() - 0.5) * 160, fromY: (r() - 0.5) * 120 - 40, fromR: (r() - 0.5) * 90, id: ransomHash(`${seed}|t${word.index}|${li}`) };
    });
  };

  // --- layout at a global scale k (rows, then heights); repeated until the block fits ---
  const lay = (k: number) => {
    const big = BIG * u * k;
    const small = SMALL * u * k;
    const heroSize = HERO * u * k;
    const rows: Row[] = [];
    const mkStrip = (idx: readonly number[]): StripRow => {
      const isSmall = idx.every((at) => words[at]!.minor);
      let size = isSmall ? small : big;
      const face = isSmall ? SMALL_FACE : BIG_FACE;
      const ls = isSmall ? 0.04 : 0.01;
      const dims = (s: number) => {
        const padX = (isSmall ? 0.38 : 0.3) * s;
        const advs = idx.map((at) => adv(words[at]!.text, face, s, ls));
        return { padX, advs, gap: 0.26 * s, natural: 2 * padX + advs.reduce((a, b) => a + b, 0) + 0.26 * s * (idx.length - 1) };
      };
      let d = dims(size);
      if (d.natural > limit) {
        size *= limit / d.natural;
        d = dims(size);
      }
      // The paper holds the words' real ink (a fallback face's tall or deep script reaches past a Latin line box).
      const base = baselineOf(face, size);
      let up = 0;
      let down = 0;
      for (const at of idx) {
        const m = input.measure(words[at]!.text, face, size, ls);
        up = Math.max(up, -m.inkTop);
        down = Math.max(down, m.inkBottom);
      }
      const padT = Math.max((isSmall ? 0.12 : 0.08) * size, up + 0.03 * size - base);
      const padB = Math.max((isSmall ? 0.1 : 0.04) * size, down + 0.03 * size - (size - base));
      const order = rowVisualOrder(idx.map((at) => words[at]!.text), rtl ? "rtl" : "ltr");
      const lefts = new Array<number>(idx.length);
      let x = d.padX;
      for (const at of order) {
        lefts[at] = x;
        x += d.advs[at]! + d.gap;
      }
      return { kind: "strip", idx, small: isSmall, size, face, ls, padX: d.padX, padT, padB, w: d.natural, h: padT + size + padB, lefts, advs: d.advs, baseline: padT + base, top: 0 };
    };
    const stripRows = (chunk: readonly number[]) => {
      const isSmall = chunk.every((at) => words[at]!.minor);
      const size = isSmall ? small : big;
      const face = isSmall ? SMALL_FACE : BIG_FACE;
      const ls = isSmall ? 0.04 : 0.01;
      const widths = chunk.map((at) => adv(words[at]!.text, face, size, ls));
      // A row may shrink to 0.74 of its size before it wraps (the sample shrinks "born with it" to 0.81 rather than wrap it).
      const inner = (limit - 2 * (isSmall ? 0.38 : 0.3) * size) / SHRINK_FLOOR;
      const gap = 0.26 * size;
      const wrapped = isSmall ? greedyRows(widths, gap, inner) : balancedRows(widths, gap, inner);
      for (const row of wrapped) rows.push(mkStrip(row.map((at) => chunk[at]!)));
    };
    const heroRows = (span: readonly number[]) => {
      const layoutWord = (at: number, hf: number): HeroWordLayout => {
        const word = words[at]!;
        const specs = specsOf(word, heroCounter);
        let x = 0;
        const gap = 0.04 * hf;
        const raw = specs.map((spec) => {
          const f = spec.sc * hf;
          const pad = TILE_PAD(spec.face);
          const w = adv(spec.ch, spec.face, f, 0) + 2 * pad.x * f;
          const base = baselineOf(spec.face, f);
          const m = input.measure(spec.ch, spec.face, f, 0);
          const padT = Math.max(pad.t * f, -m.inkTop + 0.03 * f - base);
          const padB = Math.max(pad.b * f, m.inkBottom + 0.03 * f - (f - base));
          const h = f + padT + padB;
          const entry = { w, h, f, padT, delta: padT + base - h / 2, lx: x + w / 2 };
          x += w + gap;
          return entry;
        });
        const total = x - gap;
        return { word, specs, dims: raw.map((d) => ({ ...d, lx: d.lx - total / 2 })) };
      };
      const widthOf = (hw: HeroWordLayout) => hw.dims.reduce((s, d) => s + d.w, 0) + 0.04 * hf0 * (hw.dims.length - 1);
      const hf0 = heroSize;
      const natural = span.map((at) => widthOf(layoutWord(at, hf0)));
      const wordGap = 0.3 * hf0;
      for (const group of balancedRows(natural, wordGap, limit)) {
        const total = group.reduce((s, at) => s + natural[at]!, 0) + wordGap * (group.length - 1);
        const hf = hf0 * Math.min(1, limit / total);
        const order = rowVisualOrder(group.map((at) => words[span[at]!]!.text), rtl ? "rtl" : "ltr").map((at) => group[at]!);
        const laid = order.map((at) => layoutWord(span[at]!, hf));
        const widths = laid.map((hw) => hw.dims.reduce((s, d) => s + d.w, 0) + 0.04 * hf * (hw.dims.length - 1));
        const rowW = widths.reduce((a, b) => a + b, 0) + 0.3 * hf * (laid.length - 1);
        let x = -rowW / 2;
        const placed = laid.map((hw, i) => {
          const mid = x + widths[i]! / 2;
          x += widths[i]! + 0.3 * hf;
          return { ...hw, dims: hw.dims.map((d) => ({ ...d, lx: d.lx + mid })) };
        });
        rows.push({ kind: "hero", words: placed, hf, w: rowW, h: Math.max(...placed.flatMap((hw) => hw.dims.map((d) => d.h))), top: 0 });
      }
    };
    // Segments: runs of hero words, and the words between them.
    let at = 0;
    while (at < words.length) {
      if (words[at]!.hero) {
        const span: number[] = [];
        while (at < words.length && words[at]!.hero) span.push(at++);
        heroRows(span);
        continue;
      }
      const plain: number[] = [];
      while (at < words.length && !words[at]!.hero) plain.push(at++);
      // Runs of two or more minor words stand alone on a small strip; every other word wraps with its neighbours.
      let chunk: number[] = [];
      const flush = () => {
        if (chunk.length > 0) stripRows(chunk);
        chunk = [];
      };
      for (let i = 0; i < plain.length; ) {
        let j = i;
        while (j < plain.length && words[plain[j]!]!.minor) j++;
        if (j - i >= 2) {
          flush();
          stripRows(plain.slice(i, j));
          i = j;
        } else {
          chunk.push(plain[i]!);
          i++;
        }
      }
      flush();
    }
    // Vertical flow: margins 0.02 em of the row, a band under every row that carries a scribble.
    const lastStrip = rows.length - 1;
    const marginOf = (row: Row) => 0.02 * (row.kind === "strip" ? row.size : row.hf);
    const bandOf = (row: Row, index: number) => (row.kind === "hero" || (index === lastStrip && !rows.some((r) => r.kind === "hero")) ? BAND * u * k : 0);
    let height = 0;
    rows.forEach((row, index) => {
      height += 2 * marginOf(row) + row.h + bandOf(row, index);
    });
    let top = BY - height / 2;
    rows.forEach((row, index) => {
      top += marginOf(row);
      row.top = top;
      top += row.h + marginOf(row) + bandOf(row, index);
    });
    return { rows, height, bandOf };
  };
  // The block fits the canvas's real safe height with room for the entrance (tiles and scrap fly in from above) and the roll.
  const safeH = safe.y2 - safe.y1;
  const maxBlock = Math.max(0.4 * safeH, Math.min(MAX_BLOCK * u, safeH - 130 * u));
  let k = 1;
  let layout = lay(k);
  for (let tries = 0; tries < 10 && layout.height > maxBlock * 1.0005; tries++) {
    k *= maxBlock / layout.height;
    layout = lay(k);
  }
  const { rows } = layout;
  const hasHero = rows.some((row) => row.kind === "hero");
  const blockTop = BY - layout.height / 2;
  const blockBottom = BY + layout.height / 2;

  // --- timing ---
  // Entrances (the strip's tear, the tiles' flight) run at `speed` of the sample's pace. The cue ends no later than `cap`: the
  // incoming cue's first visible frame, so nothing is ever drawn over an outgoing word (cue handoff rule). A cue that cannot
  // give every word HOLD ms after it lands plus a roll has its entrances compressed; if that is not enough it is cut at `cap`
  // with no roll (a roll needs two frames), and the words have been readable from landing until then.
  const letterTotal = words.reduce((total, w) => total + (w.letters ? w.letters.length : 0), 0);
  const stagger0 = Math.min(26, 150 / Math.max(1, letterTotal));
  const firstFrame = ransomEntryMs(cue, notBefore, fps);
  const liveUntil = Math.max(...cue.words.map((word) => word.endMs));
  const capSoft = Math.max(cue.endMs, liveUntil);
  // Entrance length of a word at the sample's pace: a strip word's tear, or a hero's whole flight of tiles.
  const paceOf = (index: number) => {
    const row = rows.find((r) => (r.kind === "strip" ? r.idx.includes(index) : r.words.some((hw) => hw.word.index === index)))!;
    return row.kind === "strip" ? SETTLE_STRIP * 200 : (row.words.find((hw) => hw.word.index === index)!.specs.length - 1) * stagger0 + SETTLE_TILE * 300;
  };
  const landAt = (index: number, sp: number) => riseAt(index) + paceOf(index) * sp;
  const ones = words.map(() => 1);
  const lastLandAt = (sp: readonly number[]) => Math.max(cue.startMs, ...words.map((w) => landAt(w.index, sp[w.index]!)));
  // Handoff rule 3, in order: (a) shorten or drop the roll, (c, done by the caller) the incoming lead, then (d) compress each word's
  // entrance only as much as it needs. The sample's pace is kept whenever the exit levers are enough.
  // `handoff` is the incoming cue's first colliding painted frame; a cue always shows at least one painted frame. With nothing in
  // its way the cue may run on until its roll (which starts after the last word has been spoken) has swept.
  const rollFrom = Math.max(cue.endMs - EXIT, lastLandAt(ones) + HOLD, liveUntil);
  const cap = Math.max(firstFrame + Math.ceil(1000 / sceneSampleRate(fps)) + 1, Number.isFinite(handoff) ? Math.min(capSoft + CLEAR, handoff) : Math.max(capSoft, rollFrom + ROLL_MIN));
  let cut = false;
  let spd: number[] = ones;
  // A probe (the planner's reference for collisions) shows the most ink for the longest: the fastest entrance, never wiped away.
  if (forceSpeed !== undefined) {
    spd = words.map(() => forceSpeed);
    cut = true;
  } else if (Math.max(lastLandAt(ones) + HOLD, liveUntil) + ROLL_MIN <= cap) cut = false;
  else {
    cut = true;
    if (lastLandAt(ones) + HOLD > cap + HOLD_SLACK) spd = words.map((w) => clamp((cap - HOLD - riseAt(w.index)) / paceOf(w.index), speedMinOf(fps), 1));
  }
  // A cue whose last word starts less than two painted frames before the cut cannot animate: it shows its finished pose at once
  // (every letter and word, no flight, no tear, no roll, no decoration) for the frames it has.
  let lastStart = cue.startMs;
  for (const word of words) lastStart = Math.max(lastStart, riseAt(word.index) + (word.hero && word.letters ? (word.letters.length - 1) * stagger0 * spd[word.index]! : 0));
  const finished = forceSpeed === undefined && cap - frameAt(lastStart) < ROLL_MIN;
  if (finished) cut = true;
  const growOf = (index: number) => 200 * spd[index]!;
  const tileOf = (index: number) => 300 * spd[index]!;
  const tileStart = (word: Word, li: number) => riseAt(word.index) + li * stagger0 * spd[word.index]!;
  const lastLand = lastLandAt(spd);
  // The roll starts once the last word has landed and been readable, and ends by `cap`.
  const exitFrom = cut ? Math.round(cap) : Math.round(Math.min(Math.max(cue.endMs - EXIT, lastLand + HOLD, liveUntil), cap - ROLL_MIN));
  const exitTo = cut ? exitFrom : exitFrom + Math.round(Math.min(EXIT, cap - exitFrom));

  // --- the block's extent (the roll sweeps it) and the clip every piece shares ---
  // Tilt direction alternates on a running row counter across the whole clip; the hero row moves 0.4x as much.
  const rowShift = new Map<Row, { shift: number; tilt: number; id: number; ordinal: number }>();
  rows.forEach((row) => {
    const ordinal = counters.rows++;
    const r = ransomRng(seed ^ Math.imul(ordinal + 1, 0x9e3779b1));
    const tilt = (ordinal % 2 ? 1 : -1) * (1.5 + r() * 2.5);
    const shift = (r() - 0.5) * 70;
    const damp = row.kind === "hero" ? 0.4 : 1;
    rowShift.set(row, { shift: shift * damp, tilt: tilt * damp, id: ransomHash(`${seed}|row${ordinal}`), ordinal });
  });
  const xs = rows.flatMap((row) => {
    const shift = rowShift.get(row)!.shift * u;
    const half = row.w / 2 + (row.kind === "strip" ? 14 * u : 20 * u);
    return [BX + shift - half, BX + shift + half];
  });
  const L = Math.min(...xs) - 24 * u;
  const R = Math.max(...xs) + 24 * u;
  const FAR = 300 * u;
  // Block-relative, not clamped to the canvas: the safe-area shift moves clips with their pieces.
  const yBand: [number, number] = [blockTop - 140 * u, blockBottom + 140 * u];
  const still = (v: number): Frames => [[0, v]];
  const meet = (grow: Frames, edge: Frames): Frames => {
    const times = [...grow, ...edge].map((frame) => frame[0]);
    const pick = rtl ? Math.min : Math.max;
    return sampleFrames((t) => pick(kf(t, grow), kf(t, edge)), times, 0.2, { range: [Math.min(...times), Math.max(...times)], wholeMs: true, simplify: true });
  };
  const clipOf = (from: number, grow: Frames | null): Clip => {
    const edge: Frames = cut ? still(rtl ? R : L) : rtl ? [[from, R], [exitFrom, R], [exitTo, L, "inOut"]] : [[from, L], [exitFrom, L], [exitTo, R, "inOut"]];
    const open: Frames = still(rtl ? L - FAR : R + FAR);
    // A clip whose edges meet is zero wide: the roll's edge may pass a strip's tear edge before the tear has finished.
    const far = grow ? meet(grow, edge) : open;
    return rtl ? { x1: far, x2: edge, y1: still(yBand[0]), y2: still(yBand[1]) } : { x1: edge, x2: far, y1: still(yBand[0]), y2: still(yBand[1]) };
  };

  const pieces: Piece[] = [];
  const shape = (id: string, z: number, from: number, to: number, path: PathCmd[], origin: { dx: number; dy: number }, track: Track, extra: Partial<ShapePiece>): ShapePiece => ({ id, kind: "shape", z, fromMs: from, toMs: to, track, origin, path, ...extra });
  const text = (id: string, z: number, from: number, to: number, content: string, face: CaptionFontName, size: number, ls: number, fill: string, anchorOrigin: { dx: number; dy: number }, track: Track, extra: Partial<TextPiece>): TextPiece => ({
    id,
    kind: "text",
    z,
    fromMs: from,
    toMs: to,
    track,
    origin: anchorOrigin,
    text: content,
    face,
    sizePx: size,
    letterSpacingEm: ls,
    fill,
    anchor: "baseline-left",
    language: cue.language,
    ...extra,
  });

  const deferred: ((dx: number, dy: number) => Piece | null)[] = [];
  let focus: { cx: number; top: number; bottom: number; halfW: number; tilt: number; start: number; row: Row } | null = null;

  for (const row of rows) {
    const { shift, tilt, id: rowId, ordinal } = rowShift.get(row)!;
    const rowCy = row.top + row.h / 2;
    const P = { x: BX + shift * u, y: rowCy };
    if (row.kind === "strip") {
      const first = Math.min(...row.idx.map((at) => cue.words[at]!.startMs));
      const start = Math.min(...row.idx.map(riseAt));
      const from = finished ? firstFrame : frameAt(start);
      const [fill, ink] = STRIPS[counters.strips++ % STRIPS.length]!;
      const poseAt = (t: number) => {
        const p = finished ? 1 : prog(t, start, 260);
        const b = ransomBoil(rowId, Math.floor(t / BOIL));
        const twist = (1 - EASES.out(p)) * -tilt * 2.2;
        return { x: P.x + b.x * u, y: P.y + b.y * u, rz: tilt + twist + b.r, s: lerp(0.88, 1, EASES.spring(p)) };
      };
      const cuts = boilCuts(from, exitTo);
      const entry = [start, start + 260];
      const tx = jumpFrames((t) => poseAt(t).x, from, exitTo, cuts, entry, 0.3);
      const ty = jumpFrames((t) => poseAt(t).y, from, exitTo, cuts, entry, 0.3);
      const trz = jumpFrames((t) => poseAt(t).rz, from, exitTo, cuts, entry, 0.05);
      const ts = sampleFrames((t) => poseAt(t).s, entry, 0.003, { range: [from, Math.max(from + 1, Math.round(start + 260))], wholeMs: true, simplify: true });
      const o: Frames = finished ? [[from, 1]] : [[from, FIRST_O], [Math.max(from + 1, Math.round(start + 260 / 6)), 1]];
      const track: Track = { x: tx, y: ty, rz: trz, sx: ts, sy: ts, o };
      // The strip tears longer as each later word is spoken (distance from the leading edge).
      const order = [...row.idx.keys()].sort((a, b) => cue.words[row.idx[a]!]!.startMs - cue.words[row.idx[b]!]!.startMs);
      // A word's own box plus a tail that stops short of the next word (a longer tail would show its first pixels early).
      const tail = Math.min(row.padX, 0.45 * 0.26 * row.size);
      const rawD = order.map((pos) => (rtl ? row.w - row.lefts[pos]! + tail : row.lefts[pos]! + row.advs[pos]! + tail));
      // The edge only ever grows, so a row whose spoken order is not its visual order (an English phrase in Urdu) never takes paper back.
      const edgeD = rawD.map((_d, i) => Math.max(...rawD.slice(0, i + 1)));
      edgeD[edgeD.length - 1] = row.w;
      const startsOf = order.map((pos) => riseAt(row.idx[pos]!));
      const growsOf = order.map((pos) => growOf(row.idx[pos]!));
      // The tear starts from a quarter of the next word's box, so the word's first painted frame shows it.
      const growth = (t: number) => {
        let e = edgeD[0]!;
        for (let i = 1; i < order.length; i++) e = lerp(e, edgeD[i]!, t < startsOf[i]! ? 0 : 0.25 + 0.75 * EASES.outExpo(prog(t, startsOf[i]!, growsOf[i]!)));
        return e;
      };
      // A word the edge has already passed (it is spoken after a word that sits further along the row) shows at its own start.
      const gated = new Map<number, number>();
      order.forEach((pos, i) => {
        if (i > 0 && rawD[i]! < Math.max(...rawD.slice(0, i))) gated.set(pos, Math.round(startsOf[i]!));
      });
      const cosT = Math.cos((tilt * Math.PI) / 180);
      const xEdge = (t: number) => P.x + sgn * (growth(t) - row.w / 2) * cosT + sgn * 3 * u;
      const growEnd = Math.max(from + 1, Math.round(Math.max(...startsOf.map((s, i) => s + growsOf[i]!))));
      const growEdges = [...startsOf.flatMap((s, i) => [s - 0.5, s, s + growsOf[i]!]), from];
      const gFrames = sampleFrames(xEdge, growEdges, 0.3, { range: [from, growEnd], wholeMs: true, simplify: true });
      const grow: Frames = [...gFrames.map((f) => [f[0], f[1]] as [number, number]), [growEnd + 1, rtl ? L - FAR : R + FAR]];
      const clip = clipOf(from, finished ? null : grow);
      const rowR = ransomRng(seed ^ Math.imul(ordinal + 5, 0x27d4eb2f));
      const underPts = ransomTorn(row.w + 14 * u, row.h + 12 * u, 4, rowR, u).map(([x, y]) => [x - 7 * u, y - 4 * u + rowR() * 4 * u] as Pt);
      const stripPts = ransomTorn(row.w, row.h, 3, rowR, u);
      const under = anchored(underPts);
      const strip = anchored(stripPts);
      const pivot = { x: row.w / 2, y: row.h / 2 };
      const base = `ransom:${cueNumber}:r${ordinal}`;
      pieces.push(
        shape(`${base}u`, band, from, exitTo, under.path, { dx: pivot.x - under.minX, dy: pivot.y - under.minY }, track, { fill: { colour: paper }, shadows: [{ dx: 0, dy: 6 * u, blur: 4 * u, colour: SHADOW, alpha: 0.25 }], clip }),
        shape(`${base}s`, band + 1, from, exitTo, strip.path, { dx: pivot.x - strip.minX, dy: pivot.y - strip.minY }, track, { fill: { colour: fill }, clip }),
      );
      row.idx.forEach((at, pos) => {
        const gate = finished ? undefined : gated.get(pos);
        const g = gate === undefined ? 0 : Math.max(from + 2, gate);
        const wordTrack: Track = gate === undefined ? track : { ...track, o: [[from, 0], [g - 1, 0], [g, FIRST_O], [g + 43, 1]] };
        pieces.push(text(`${base}w${pos}`, band + 3, from, exitTo, words[at]!.text, row.face, row.size, row.ls, ink, { dx: pivot.x - row.lefts[pos]!, dy: pivot.y - row.baseline }, wordTrack, { clip }));
      });
      // A translucent tape scrap pins the start of the strip, a little different every row. It is built after the cue's
      // safe-area shift so that its pop (it lands 1.6x) and its boil are checked against the final frame.
      if (!finished) {
        const tr = ransomRng(seed ^ Math.imul(ordinal + 17, 0x165667b1));
        const tapeLen = clamp(0.58 * row.size, 30 * u, 78 * u);
        const tapeThick = clamp(0.22 * row.size, 14 * u, 28 * u);
        const tilted = ordinal % 2 ? 1 : -1;
        const tapeAng = tilted * sgn * (30 + tr() * 16);
        const tapePts: Pt[] = [];
        const teeth = 4;
        for (let i = 0; i <= teeth; i++) tapePts.push([tapeLen - (i % 2 ? 4 + tr() * 4 : tr() * 2) * u, (tapeThick * i) / teeth]);
        for (let i = teeth; i >= 0; i--) tapePts.push([(i % 2 ? 4 + tr() * 4 : tr() * 2) * u, (tapeThick * i) / teeth]);
        const tape = anchored(tapePts);
        const ly = -row.h / 2 + 3 * u;
        const tapeAt = Math.round(start + 90);
        const tapeFrom = frameAt(tapeAt);
        const tapeEdges = [tapeAt, tapeAt + 240, start, start + 260];
        const tapeCuts = boilCuts(tapeFrom, exitTo);
        const colour = TAPES[ordinal % TAPES.length]!;
        deferred.push((dx, dy) => {
          let last: Piece | null = null;
          for (const [inset, pop] of [[6 * u, 1.6], [6 * u, 1], [0.3 * tapeLen, 1], [0.5 * tapeLen, 1]] as const) {
            const lx = sgn * (-row.w / 2 + inset);
            const popOf = (t: number) => lerp(pop, 1, EASES.spring(prog(t, tapeAt, 240)));
            const tapePose = (t: number, axis: "x" | "y" | "rz") => {
              const pose = poseAt(t);
              const a = (pose.rz * Math.PI) / 180;
              const sx = lx * pose.s;
              const sy = ly * pose.s;
              if (axis === "x") return pose.x + sx * Math.cos(a) - sy * Math.sin(a);
              if (axis === "y") return pose.y + sx * Math.sin(a) + sy * Math.cos(a);
              return pose.rz + tapeAng;
            };
            const tapeScale = sampleFrames((t) => popOf(t) * poseAt(t).s, tapeEdges, 0.004, { range: [tapeFrom, Math.max(tapeFrom + 1, Math.round(tapeAt + 240))], wholeMs: true, simplify: true });
            const piece = shiftPiece(
              shape(`${base}t`, band + 2, tapeFrom, exitTo, tape.path, { dx: tapeLen / 2 - tape.minX, dy: tapeThick / 2 - tape.minY }, {
                x: jumpFrames((t) => tapePose(t, "x"), tapeFrom, exitTo, tapeCuts, tapeEdges, 0.3),
                y: jumpFrames((t) => tapePose(t, "y"), tapeFrom, exitTo, tapeCuts, tapeEdges, 0.3),
                rz: jumpFrames((t) => tapePose(t, "rz"), tapeFrom, exitTo, tapeCuts, tapeEdges, 0.05),
                sx: tapeScale,
                sy: tapeScale,
                o: [[tapeFrom, FIRST_O], [Math.max(tapeFrom + 1, Math.round(tapeAt + 40)), 1]],
              }, { fill: { colour, alpha: 0.72 }, clip: clipOf(tapeFrom, null) }),
              dx,
              dy,
            );
            last = piece;
            // Inside the safe area while it lands and on every boil step.
            const probes = [...framesIn(tapeFrom, Math.min(exitTo, tapeAt + 300)).flatMap((t) => [t - 1, t]), ...tapeCuts.flatMap((t) => [t - 1, t, t + 1])];
            if (probes.every((t) => {
              const box = pieceBounds(piece, t, input.measure);
              return !box || (box.x1 >= safe.x1 && box.x2 <= safe.x2 && box.y1 >= safe.y1 && box.y2 <= safe.y2);
            })) return piece;
          }
          // Still poking out (the strip itself is at the frame's edge): move the whole scrap in by what overshoots.
          if (!last) return null;
          let nx = 0;
          let ny = 0;
          const probes = [...framesIn(last.fromMs, Math.min(exitTo, tapeAt + 300)).flatMap((t) => [t - 1, t]), ...tapeCuts.flatMap((t) => [t - 1, t, t + 1])];
          for (const t of probes) {
            const box = pieceBounds(last, t, input.measure);
            if (!box) continue;
            nx = Math.max(nx, safe.x1 - box.x1);
            ny = Math.max(ny, safe.y1 - box.y1);
          }
          let mx = 0;
          let my = 0;
          for (const t of probes) {
            const box = pieceBounds(last, t, input.measure);
            if (!box) continue;
            mx = Math.max(mx, box.x2 - safe.x2);
            my = Math.max(my, box.y2 - safe.y2);
          }
          return shiftPiece(last, nx - mx, ny - my);
        });
      }
      if (!hasHero) focus = { cx: P.x, top: row.top, bottom: row.top + row.h, halfW: row.w / 2, tilt, start: first, row };
    } else {
      // The ransom note: one tile per letter, flying in tiny and spinning.
      const tiltRad = (tilt * Math.PI) / 180;
      const cosR = Math.cos(tiltRad);
      const sinR = Math.sin(tiltRad);
      for (const hw of row.words) {
        const spoken = cue.words[hw.word.index]!;
        hw.specs.forEach((spec, li) => {
          const d = hw.dims[li]!;
          const tileDur = tileOf(hw.word.index);
          const t0 = finished ? firstFrame - tileDur : tileStart(hw.word, li);
          const from = finished ? firstFrame : frameAt(t0);
          const settle = Math.round(t0 + tileDur);
          const tilePose = (t: number) => {
            const p = prog(t, t0, tileDur);
            const settled = t >= settle ? 1 : 0;
            const b = settled ? ransomBoil(spec.id, Math.floor(t / BOIL), 1.2) : { x: 0, y: 0, r: 0 };
            const tx = lerp(spec.fromX * u, 0, EASES.outExpo(p)) + b.x * u * settled;
            const ty = lerp(spec.fromY * u, 0, EASES.outExpo(p)) + b.y * u * settled + spec.dy * d.f;
            const lxp = d.lx + tx;
            return {
              x: P.x + lxp * cosR - ty * sinR,
              y: P.y + lxp * sinR + ty * cosR,
              rz: tilt + lerp(spec.fromR, spec.rot, EASES.out(p)) + b.r * settled,
              s: lerp(0.2, 1, outBack18(p)),
            };
          };
          const cuts = [settle, ...boilCuts(settle, exitTo)];
          const edges = [t0, t0 + tileDur];
          const tx = jumpFrames((t) => tilePose(t).x, from, exitTo, cuts, edges, 0.3);
          const ty = jumpFrames((t) => tilePose(t).y, from, exitTo, cuts, edges, 0.3);
          const trz = jumpFrames((t) => tilePose(t).rz, from, exitTo, cuts, edges, 0.05);
          const ts = sampleFrames((t) => tilePose(t).s, edges, 0.004, { range: [from, Math.max(from + 1, settle)], wholeMs: true, simplify: true });
          const track: Track = { x: tx, y: ty, rz: trz, sx: ts, sy: ts, o: finished ? [[from, 1]] : [[from, FIRST_O], [Math.max(from + 1, Math.round(t0 + 0.2 * tileDur)), 1]] };
          const clip = clipOf(from, null);
          const poly = anchored(spec.poly.map(([fx, fy]) => [fx * d.w, fy * d.h] as Pt));
          const id = `ransom:${cueNumber}:h${hw.word.index}l${li}`;
          pieces.push(
            shape(id, band + 2, from, exitTo, poly.path, { dx: d.w / 2 - poly.minX, dy: d.h / 2 - poly.minY }, track, { fill: { colour: spec.fill }, clip }),
            text(`${id}t`, band + 3, from, exitTo, spec.ch, spec.face, d.f, 0, spec.ink, { dx: 0, dy: -d.delta }, track, { anchor: "baseline-center", clip }),
          );
        });
        if (!focus || focus.row.kind !== "hero") {
          focus = { cx: P.x, top: row.top, bottom: row.top + row.h, halfW: row.w / 2, tilt, start: spoken.startMs, row };
        }
      }
    }
  }

  // --- recurring beats: the loose scrap and the scribble, every cue ---
  if (focus && !finished) {
    const f = focus;
    const isHero = f.row.kind === "hero";
    const counter = isHero ? counters.heroes++ : counters.plains++;
    const dr = ransomRng(seed ^ 0x51ed270b);
    // The loose scrap drops in beside the focus row from alternating sides.
    {
      const side = (counter % 2 ? 1 : -1) * sgn;
      const sw = (54 + dr() * 24) * u * Math.min(1, k + 0.3);
      const sh = (42 + dr() * 18) * u * Math.min(1, k + 0.3);
      const pts: Pt[] = [[dr() * 6 * u, dr() * 5 * u], [sw - dr() * 6 * u, dr() * 5 * u], [sw, sh / 2 + (dr() - 0.5) * 8 * u], [sw - dr() * 6 * u, sh - dr() * 5 * u], [dr() * 6 * u, sh - dr() * 5 * u], [0, sh / 2 + (dr() - 0.5) * 8 * u]];
      const scrap = anchored(pts);
      const fill = [MAGENTA, TEAL, YELLOW, hl, NAVY][(counter * 2 + 1 + (seed % 3)) % 5]!;
      // The scrap is built after the cue's safe-area shift (its rotated entrance must be inside the final frame): see `deferred`.
      const reach = (Math.hypot(sw, sh) / 2) * 1.06;
      const cx0 = f.cx + side * (f.halfW + sw * 0.28);
      const cy0 = isHero ? f.top + 0.2 * (f.bottom - f.top) : f.bottom - 0.1 * (f.bottom - f.top);
      const entry = ransomEntryMs(cue, notBefore, fps);
      const at = Math.round(Math.max(entry, cue.startMs - 60, Math.min(f.start - 40, exitFrom - 300)));
      const dur = Math.round(clamp(exitFrom - 50 - at, 120, 260));
      const from = frameAt(at);
      const rest = side * (8 + dr() * 10);
      const fall = (t: number) => outBack18(prog(t, at, dur));
      deferred.push((dx, dy) => {
        const cx = clamp(cx0 + dx, safe.x1 + reach, safe.x2 - reach) - dx;
        const cy = clamp(cy0 + dy, safe.y1 + reach, safe.y2 - reach) - dy;
        let best: ShapePiece | null = null;
        for (const [drop, spin] of [[70 * u, 70], [45 * u, 40], [25 * u, 20], [0, 0]] as const) {
          const yTrack = sampleFrames((t) => cy - drop * (1 - fall(t)), [at, at + dur], 0.3, { range: [from, at + dur], wholeMs: true, simplify: true });
          const sTrack = sampleFrames((t) => lerp(0.5, 1, fall(t)), [at, at + dur], 0.004, { range: [from, at + dur], wholeMs: true, simplify: true });
          const piece = shiftPiece(
            shape(`ransom:${cueNumber}:x`, band + 1, from, exitTo, scrap.path, { dx: sw / 2 - scrap.minX, dy: sh / 2 - scrap.minY }, {
              x: [[from, cx]],
              y: yTrack,
              rz: [[from, rest + side * spin], [at + dur, rest, "out"]],
              sx: sTrack,
              sy: sTrack,
              o: [[from, FIRST_O], [Math.max(from + 1, at + 50), 1]],
            }, { fill: { colour: fill }, clip: clipOf(from, null) }),
            dx,
            dy,
          );
          best = piece;
          // Every millisecond of the entrance (and the rest pose) is inside the safe area.
          let inside = true;
          for (let t = from; t <= Math.min(exitTo - 1, at + dur + 20) && inside; t++) {
            const box = pieceBounds(piece, t, input.measure);
            if (box && (box.x1 < safe.x1 || box.x2 > safe.x2 || box.y1 < safe.y1 || box.y2 > safe.y2)) inside = false;
          }
          if (inside) break;
        }
        return best!;
      });
    }
    // The hand-scribbled underline, drawn left to right under the focus row.
    {
      const variant = counter % 3;
      const W = Math.max(60 * u, f.halfW * 2 * 0.84);
      const A = 6 * u;
      const cyl = f.bottom + (BAND * u * k) / 2;
      const ph = dr() * Math.PI * 2;
      const jit = () => (dr() - 0.5) * 1.6 * u;
      const line = (yOff: number, cycles: number, phase: number, amp: number, steps: number): Pt[] =>
        Array.from({ length: steps + 1 }, (_, i) => {
          const x = -W / 2 + (W * i) / steps;
          return [x + jit(), yOff + amp * Math.sin((i / steps) * cycles * Math.PI * 2 + phase) + jit()] as Pt;
        });
      const zig = (yOff: number, teeth: number, amp: number): Pt[] =>
        Array.from({ length: teeth + 1 }, (_, i) => [-W / 2 + (W * i) / teeth + jit(), yOff + (i % 2 ? amp : -amp) + jit()] as Pt);
      let path: PathCmd[];
      if (variant === 0) path = polylinePath(line(0, 4 + Math.floor(dr() * 2), ph, A, Math.round(W / (9 * u))));
      else if (variant === 1) path = polylinePath(zig(0, 6 + Math.floor(dr() * 3), A * 1.1));
      else path = [...polylinePath(line(-5 * u, 3.5, ph, 4.5 * u, Math.round(W / (10 * u)))), ...polylinePath(line(5 * u, 3.5, ph + 2.2, 4.5 * u, Math.round(W / (10 * u))))];
      const at = Math.round(f.start + 150);
      const from = frameAt(at);
      const dur = Math.round(clamp(exitFrom - 40 - at, 0, 280));
      if (dur >= 110) {
        const px = f.cx;
        const py = cyl;
        const wipe: Frames = rtl ? [[at, px + W / 2 + 12 * u], [at + dur, px - W / 2 - 12 * u, "outExpo"], [at + dur + 1, L - FAR]] : [[at, px - W / 2 - 12 * u], [at + dur, px + W / 2 + 12 * u, "outExpo"], [at + dur + 1, R + FAR]];
        const mk = (id: string, z: number, width: number, colour: string): ShapePiece => {
          const clip = clipOf(from, wipe);
          return shape(id, z, from, exitTo, path, { dx: 0, dy: 0 }, { x: [[from, px]], y: [[from, py]], rz: [[from, f.tilt]], o: [[from, FIRST_O], [from + 20, 1]] }, { stroke: { widthPx: width, colour }, clip });
        };
        pieces.push(mk(`ransom:${cueNumber}:qu`, band + 5, 14 * u, paper), mk(`ransom:${cueNumber}:q`, band + 6, 7 * u, NAVY));
      }
    }
  }

  // --- the paper roll that clears the cue (a cue cut at the handoff has none) ---
  if (!cut) {
    const H = layout.height + 60 * u;
    const Wb = 58 * u;
    const Rb = Wb / 2;
    const cyb = BY;
    const edgeAt = (t: number) => lerp(rtl ? R : L, rtl ? L : R, EASES.inOut(prog(t, exitFrom, exitTo - exitFrom)));
    const reach = Wb / 2 + (H / 2) * Math.sin((2 * Math.PI) / 180) + 2;
    const bx = (t: number) => clamp(edgeAt(t) + sgn * 7 * u, safe.x1 + reach, safe.x2 - reach);
    const xTrack = sampleFrames(bx, [exitFrom, exitTo, ...[0.25, 0.5, 0.75].map((q) => exitFrom + q * (exitTo - exitFrom))], 0.3, { range: [exitFrom, exitTo], wholeMs: true, simplify: true });
    const rz: Frames = [[exitFrom, 2 * sgn]];
    const pillPath = roundedRectPath(0, 0, Wb, H, Rb);
    const slice = 16 * u;
    const arc = (n: number): Pt[] => Array.from({ length: n + 1 }, (_, i) => {
      const x = (slice * i) / n;
      return [x, Rb - Math.sqrt(Math.max(0, Rb * Rb - (Rb - x) ** 2))] as Pt;
    });
    const top = arc(8);
    const curlPts: Pt[] = [...top, ...[...top].reverse().map(([x, y]) => [x, H - y] as Pt)];
    const mirror = (p: Pt): Pt => (rtl ? [Wb - p[0], p[1]] : p);
    const curl = anchored(curlPts.map(mirror));
    const track: Track = { x: xTrack, y: [[exitFrom, cyb]], rz, o: [[exitFrom, 1]] };
    pieces.push(
      shape(`ransom:${cueNumber}:roll`, band + 8, exitFrom, exitTo, pillPath, { dx: Wb / 2, dy: H / 2 }, track, { fill: { colour: paper }, shadows: [{ dx: 0, dy: 8 * u, blur: 9 * u, colour: SHADOW, alpha: 0.32 }] }),
      shape(`ransom:${cueNumber}:rollc`, band + 9, exitFrom, exitTo, curl.path, { dx: Wb / 2 - curl.minX, dy: H / 2 - curl.minY }, track, { fill: { colour: CURL } }),
    );
  }
  // Decorations that cannot paint on two export frames are left out (a flash is not a motion); words, strips and tiles never are.
  const paintedCount = (piece: Piece) =>
    framesIn(piece.fromMs, piece.toMs).filter((t) => {
      const pose = evaluatePiece(piece, t);
      return pose.visible && pose.o > 0.05 && pieceBounds(piece, t, input.measure) !== null;
    }).length;
  const scribbleOk = (pieces.find((piece) => piece.id.endsWith(":q")) ? paintedCount(pieces.find((piece) => piece.id.endsWith(":q"))!) : 2) >= 2;
  const kept = pieces.filter((piece) => {
    if (/:(q|qu)$/.test(piece.id)) return scribbleOk;
    if (/:(roll|rollc)$/.test(piece.id)) return paintedCount(piece) >= 2;
    return true;
  });
  const shifted = clampToSafeArea(kept, safe, input.measure);
  const probe = kept[0];
  const moved = probe ? { dx: evaluatePiece(shifted[0]!, probe.fromMs).x - evaluatePiece(probe, probe.fromMs).x, dy: evaluatePiece(shifted[0]!, probe.fromMs).y - evaluatePiece(probe, probe.fromMs).y } : { dx: 0, dy: 0 };
  const late = deferred.map((build) => build(moved.dx, moved.dy)).filter((piece): piece is Piece => piece !== null && paintedCount(piece) >= 2);
  return [...shifted, ...late];
}

/**
 * The ink of a piece at `t` as an oriented box (its rest box scaled and turned about its pivot, cut to its clip when the clip cuts
 * it), or null when nothing is painted. A tilted strip is a thin slanted box, not the big axis-aligned hull around it.
 */
export function ransomInkQuad(piece: Piece, t: number, measure: SceneInput["measure"]): Pt[] | null {
  const pose = evaluatePiece(piece, t);
  if (!pose.visible || pose.o <= 0.05) return null;
  const cut = pieceBounds(piece, t, measure);
  if (!cut) return null;
  const local = pieceLocalBox(piece, measure);
  const origin = piece.origin ?? { dx: 0, dy: 0 };
  const angle = (pose.rz * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const quad = (
    [[local.x1, local.y1], [local.x2, local.y1], [local.x2, local.y2], [local.x1, local.y2]] as const
  ).map(([cx, cy]) => {
    const ux = (cx - origin.dx) * pose.sx;
    const uy = (cy - origin.dy) * pose.sy;
    return [pose.x + ux * cos - uy * sin, pose.y + ux * sin + uy * cos] as Pt;
  });
  const xs = quad.map((p) => p[0]);
  const ys = quad.map((p) => p[1]);
  const hull = { x1: Math.min(...xs), x2: Math.max(...xs), y1: Math.min(...ys), y2: Math.max(...ys) };
  if (cut.x2 - cut.x1 < hull.x2 - hull.x1 - 0.5 || cut.y2 - cut.y1 < hull.y2 - hull.y1 - 0.5) {
    return [[cut.x1, cut.y1], [cut.x2, cut.y1], [cut.x2, cut.y2], [cut.x1, cut.y2]];
  }
  return quad;
}

/** Two oriented boxes overlap by more than 1 px along every separating axis. */
export function ransomQuadsOverlap(a: readonly Pt[], b: readonly Pt[]): boolean {
  for (const quad of [a, b]) {
    for (let at = 0; at < quad.length; at++) {
      const p = quad[at]!;
      const q = quad[(at + 1) % quad.length]!;
      const nx = q[1] - p[1];
      const ny = p[0] - q[0];
      const length = Math.hypot(nx, ny) || 1;
      const project = (poly: readonly Pt[]) => {
        const values = poly.map(([x, y]) => (x * nx + y * ny) / length);
        return [Math.min(...values), Math.max(...values)] as const;
      };
      const [a0, a1] = project(a);
      const [b0, b1] = project(b);
      if (Math.min(a1, b1) - Math.max(a0, b0) <= 1) return false;
    }
  }
  return true;
}

/**
 * The first export frame where an incoming piece's ink meets an outgoing word's. `Infinity` when the two cues never touch.
 */
function ransomCollision(outgoing: readonly Piece[], incoming: readonly Piece[], measure: SceneInput["measure"], fps: number): number {
  // The outgoing words and the paper under them are ink; its tape, scrap, scribble and roll are decoration an incoming cue may cover.
  const out = outgoing.filter((piece) => INK_ID.test(piece.id));
  const inn = incoming.filter((piece) => !/:(roll|rollc)$/.test(piece.id));
  if (out.length === 0 || inn.length === 0) return Number.POSITIVE_INFINITY;
  const quads = (list: readonly Piece[], t: number) => list.flatMap((piece) => {
    const quad = ransomInkQuad(piece, t, measure);
    return quad ? [quad] : [];
  });
  for (const t of exportFrameTimes(Math.min(...inn.map((piece) => piece.fromMs)), Math.max(...out.map((piece) => piece.toMs)), fps)) {
    const a = quads(out, t);
    if (a.length === 0) continue;
    const b = quads(inn, t);
    if (a.some((x) => b.some((y) => ransomQuadsOverlap(x, y)))) return t;
  }
  return Number.POSITIVE_INFINITY;
}

const INK_ID = /:(r\d+(u|s|w\d+)|h\d+l\d+t?)$/;

/** The vertical extent of the ink of `pieces` over their lives (sampled every 100 ms), or null. */
function inkSpan(pieces: readonly Piece[], measure: SceneInput["measure"]): { top: number; bottom: number } | null {
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const piece of pieces) {
    for (let t = piece.fromMs; t < piece.toMs; t += 100) {
      const quad = ransomInkQuad(piece, t, measure);
      if (!quad) continue;
      for (const [, y] of quad) {
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
  }
  return Number.isFinite(top) ? { top, bottom } : null;
}

export const ransomProgram: SceneProgram = {
  build(input): CaptionScene {
    const live = input.cues.map((cue, number) => ({ cue, number })).filter(({ cue }) => cue.words.length > 0);
    const snapshots: Counters[] = [];
    const lead: number[] = [];
    const lift: number[] = [];
    const cutAt: number[] = live.map(() => Number.POSITIVE_INFINITY);
    const { u } = sceneSpace(input, CY);
    const fps = input.fps ?? SCENE_DEFAULT_FPS;
    const spokenEnd = (cue: SceneCue) => Math.max(...cue.words.map((word) => word.endMs));
    let counters: Counters = { rows: 0, strips: 0, heroes: 0, plains: 0 };
    let previous: Piece[] | null = null;
    // Handoff rule 3, planned cue by cue on probes (everything at its earliest, so a cut is never later than a real collision):
    // when the outgoing cue cannot be waited out (its last word is still being spoken when the next one starts) the next cue is
    // moved above or below it (a speaker overlap stacks); otherwise the incoming lead shrinks toward 0 until the outgoing cue
    // has been spoken and has had its HOLD; the cut is then the first painted frame where the ink still meets.
    live.forEach(({ cue, number }, at) => {
      snapshots[at] = { ...counters };
      const probe = (notBefore: number, offsetY = 0) => {
        const c = { ...snapshots[at]! };
        return { pieces: buildCue(cue, number, input, c, Math.max(cue.endMs, spokenEnd(cue)) + CLEAR, notBefore, speedMinOf(fps), offsetY), c };
      };
      let chosenLead = Number.NEGATIVE_INFINITY;
      let chosenLift = 0;
      let chosen = probe(chosenLead);
      if (previous) {
        const before = live[at - 1]!.cue;
        const need = ransomNeedMs(before, lead[at - 1]!);
        const first = Math.min(...cue.words.map((word) => word.startMs));
        let collides = ransomCollision(previous, chosen.pieces, input.measure, fps);
        if (collides < need && spokenEnd(before) > first) {
          const outSpan = inkSpan(previous.filter((piece) => INK_ID.test(piece.id)), input.measure);
          const inSpan = inkSpan(chosen.pieces.filter((piece) => !/:(roll|rollc)$/.test(piece.id)), input.measure);
          if (outSpan && inSpan) {
            const gap = 16 * u;
            const candidates = [(outSpan.top - gap) - inSpan.bottom, (outSpan.bottom + gap) - inSpan.top].sort((a, b) => Math.abs(a) - Math.abs(b));
            for (const dy of candidates) {
              const moved = probe(chosenLead, dy);
              if (ransomCollision(previous, moved.pieces, input.measure, fps) === Number.POSITIVE_INFINITY) {
                chosen = moved;
                chosenLift = dy;
                collides = Number.POSITIVE_INFINITY;
                break;
              }
            }
          }
        }
        if (collides < need) {
          const shrunk = probe(Math.min(need, first), chosenLift);
          const later = ransomCollision(previous, shrunk.pieces, input.measure, fps);
          if (later > collides) {
            chosen = shrunk;
            chosenLead = Math.min(need, first);
            collides = later;
          }
        }
        cutAt[at - 1] = collides;
      }
      lead[at] = chosenLead;
      lift[at] = chosenLift;
      counters = chosen.c;
      previous = chosen.pieces;
    });
    // The finals, last cue first: each is checked against every later cue that paints before it clears, using the poses actually
    // built (a finished pose or a compressed entrance can meet ink the probes did not), and cut at the first frame that collides.
    const finals: Piece[][] = [];
    for (let at = live.length - 1; at >= 0; at--) {
      const { cue, number } = live[at]!;
      let cut = cutAt[at]!;
      let pieces = buildCue(cue, number, input, { ...snapshots[at]! }, cut, lead[at]!, undefined, lift[at]!);
      for (let tries = 0; tries < 3; tries++) {
        const end = Math.max(...pieces.map((piece) => piece.toMs));
        let worst = Number.POSITIVE_INFINITY;
        for (let later = at + 1; later < live.length; later++) {
          const incoming = finals[later]!;
          if (Math.min(...incoming.map((piece) => piece.fromMs)) >= end) break;
          worst = Math.min(worst, ransomCollision(pieces, incoming, input.measure, fps));
        }
        if (worst >= end) break;
        cut = Math.min(cut, worst);
        pieces = buildCue(cue, number, input, { ...snapshots[at]! }, cut, lead[at]!, undefined, lift[at]!);
      }
      finals[at] = pieces;
    }
    return { pieces: finals.flat() };
  },
};

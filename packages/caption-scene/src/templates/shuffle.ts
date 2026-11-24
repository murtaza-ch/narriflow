import { captionTextClusters } from "@narriflow/caption-fonts/caption-block";
import type { DemoScript } from "../demo";
import { EASES, type Frames, clamp, kf, lerp, prog } from "../ease";
import { SCENE_DEFAULT_FPS, exportFrameAtOrBefore, paintedFrameCount, sceneSampleRate } from "../frame-grid";
import { sampleFrames } from "../frames";
import type { SceneCue, SceneInput, SceneProgram } from "../input";
import { type SceneSpace, balancedRows, clampToSafeArea, cueDirection, rowVisualOrder, sceneSpace } from "../layout";
import { type Piece, type ShapePiece, type TextPiece, type Track, SCENE_PERSPECTIVE_PX, sceneBoundsAt } from "../scene";
import { roundedRectPath } from "../shapes";
import { hasTwoPaintedFrames, renderWithReadingHolds, speechLaneSpace, speechWindows } from "./speech-layout";

/**
 * Shuffle (`samples/templates/m22-unscramble.js`, after Motion Array "Unscramble Word"): a word game's letter tiles. Spoken
 * words flip down onto the table as rows of small cream tiles; the key word drops in as a scrambled row of big tiles and,
 * as it is said, each tile hops up, swings sideways into its slot and settles, turning gold as it lands.
 *
 * Geometry and timing are the sample's, in its 1080 x 1920 frame: Montserrat Black caps on tiles of about 1.4 em height
 * (50 / 62 / 92 px type, 26 / 30 / 34 px of padding, 6 / 7 / 10 px between tiles), words 30 px apart, rows 22 px apart (a key
 * row gets 2 / 2.5 rows of air above / below), the lot centred on y 1290. A small word is one plate of tiles and one text run
 * spaced to sit on them, flipping down about its top edge (`perspective(700px) rotateX`, a 300 ms spring from 70 ms before
 * the word); a key tile is its own plate and letter, falling in over 150 ms (12 ms apart), then hopping (190 ms, 14 ms apart)
 * from 110 ms after landing, up or down by turns, swinging by a seeded angle, and turning gold 80 % through the hop with a pop.
 *
 * What changed from the sample, and why (gallery-3b brief, 2026-11-24):
 * - Every cue-indexed or order-dependent choice is a rule. The sample's global `rand()` made a cue's scramble and tile
 *   tilts depend on how many cues came before it; they now come from a seeded hash of the cue's index and the word (FNV-1a,
 *   mulberry32, a seeded Fisher-Yates). The scramble is still a derangement whenever the word's letters allow one.
 * - Fit. The sample split small words into two rows at most and never scaled a long single word. Rows now come from the
 *   words (balanced wraps of at most 900 px, less on a narrow canvas); a word a little too wide shrinks to fit (down to 0.8);
 *   a word much too wide wraps its tiles onto several rows (the 45-letter word of the long-word demo is five rows of tiles,
 *   not 14 px type); a single tile (a script that is never split) shrinks to fit; and the block and its chips shrink
 *   as a whole until everything they ever draw is inside the 5 % safe area (twice the size, 1:1 and 16:9 too).
 *   Every key word gets its own scramble (the sample honoured only the first), so a cue may have several, first, middle or last.
 * - Real speech. Entrances are locked to speech: a word's first painted frame is at most 70 ms before it is spoken, never
 *   later, and never delayed to protect the cue before (the animation curve stays anchored 70 ms before the word, so a
 *   shorter lead only starts it further along). The cue before gives way: it is cut at the incoming cue's first painted
 *   frame, never before its own last word has been spoken and, when the gap allows, read for 150 ms (the incoming lead
 *   shrinks toward 0 first). Its exit (tiles flip away, 6 ms apart) starts no earlier than 150 ms after the last word and ends
 *   40 ms before the cut; when it cannot fit in two painted frames it is dropped for a cut. The key word's fall, hops and gold
 *   are scaled into the word's own time when it is short (a 100 ms key word is home before it is over; a word too short for
 *   67 ms hops comes in already unscrambled). Two speakers talking over each other stack: the later cue sits below the earlier
 *   one (above when there is no room), so neither covers the other and both keep every word through its spoken end.
 * - Every language. Words of a script that shapes or joins (Arabic, Urdu, Devanagari, Thai, CJK ...) and emoji are one tile
 *   per word, never split into letters (the key word then falls in and turns gold without a scramble); capitals are for
 *   cased scripts only; rows run right to left for RTL cues (words in bidi order). A word the face cannot draw falls back
 *   as every caption word does.
 * - The sample's blurred tile shadows (an SVG `drop-shadow(0 6px 5px)` per word, a `box-shadow` of 0 8px 8px per key tile) are
 *   one small soft shadow on each plate's own layer (2 to 3 px sigma, 0.5): no copy, and the blur is of a tile.
 * - Budget: a key tile is two pieces (plate and letter) and a plate shadow; a key word with more tiles than the cue's 150
 *   pieces allow is drawn as flat plates that fall in and turn gold (no scramble).
 * - Recurring beats: GOLD CHIPS (small square scraps pop off each tile
 *   as it turns gold, up to eight a cue; two off the bonus tile of a cue without a key word) and a BONUS TILE (the last tile
 *   of a cue without a key word turns gold with a pop as it is said). Counts, sides and sizes come from the cue's seeded hash.
 *   Chips rise within the space between rows. A bonus tile ends its row, so its chips hop low and outward.
 */

export const SHUFFLE_DEMO: DemoScript = {
  lines: [
    "okay:m this:b took:b me:m years:h@600",
    "to:m figure:b out",
    "the:m secret:b is:m boring:h@620",
    "seriously",
    "just:m show:b up:b daily:h@600",
  ],
  options: { rate: 290, cueGap: 160, tail: 750 },
};

const FACE = "Montserrat" as const;
const ANCHOR_LINE = 1290;
const MAX_W = 900;
const WORD_GAP = 30;
const ROW_GAP = 18;
const HERO_ROW_GAP = 40;
/** Chrome's baseline of a `line-height: 1` Montserrat box as a share of its size: (1 - (0.968 + 0.251)) / 2 + 0.968. */
const BASELINE = 0.8585;

interface Spec {
  readonly font: number;
  readonly h: number;
  readonly pad: number;
  readonly gap: number;
  readonly radius: number;
}
const SPECS = {
  small: { font: 50, h: 70, pad: 26, gap: 6, radius: 10 },
  lone: { font: 62, h: 86, pad: 30, gap: 7, radius: 12 },
  big: { font: 92, h: 128, pad: 34, gap: 10, radius: 16 },
} as const satisfies Record<string, Spec>;
type SpecName = keyof typeof SPECS;

const HOLD = 150;
/** A word is first painted at most this long before it is spoken. */
const LEAD = 70;
const FLIP_MS = 300;
const FLIP_TILT = -95;
const EXIT_MS = 95;
const EXIT_STAGGER = 6;
const EXIT_END = 40;
const FALL_MS = 150;
const FALL_STAGGER = 12;
const SOLVE_AT = 110;
const SOLVE_STAGGER = 14;
const HOP_MS = 190;
const WAVE_MS = 120;
/** An animated window is at least two 30 fps frames or the motion is dropped. */
const MIN_MOTION = 67;
/** Below this scale of the key word's timeline its hops would be shorter than two frames: no scramble. */
const MIN_SCALE = 0.36;
const MIN_FIT = 0.8;
/** Pieces a cue's key tiles may use (three each: plate, letter and the plate's shadow layer), the rest is left for words and beats. */
const PIECE_LIMIT = 140;
const K_SMALL = SCENE_PERSPECTIVE_PX / 700;
const K_BIG = SCENE_PERSPECTIVE_PX / 800;
const CHIP_MS = 400;
const BONUS_MS = 140;
const MAX_CHIPS = 8;

const SIMPLE = /^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{N}\p{P}\p{S}\p{M}]+$/u;
const PICTO = /\p{Extended_Pictographic}/u;

/** FNV-1a of a string: the seed that makes a cue's variety a pure function of its index and words. */
export function shuffleHash(text: string): number {
  let h = 0x811c9dc5;
  for (let at = 0; at < text.length; at++) {
    h ^= text.charCodeAt(at);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32. */
export function shuffleRng(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let x = Math.imul(state ^ (state >>> 15), 1 | state);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seeded Fisher-Yates permutation of the letters that leaves none where it belongs whenever the word allows it. */
export function shuffleOrder(letters: readonly string[], rng: () => number): number[] {
  const n = letters.length;
  const identity = Array.from({ length: n }, (_, at) => at);
  if (n < 2 || letters.every((letter) => letter === letters[0])) return identity;
  let order = identity;
  for (let attempt = 0; attempt < 40; attempt++) {
    const next = [...identity];
    for (let at = n - 1; at > 0; at--) {
      const to = Math.floor(rng() * (at + 1));
      [next[at], next[to]] = [next[to]!, next[at]!];
    }
    order = next;
    if (next.every((slot, at) => letters[slot] !== letters[at])) return next;
  }
  // No full derangement found (a word of mostly one letter): a rotation moves what can move.
  return order.every((slot, at) => slot === at) ? identity.map((at) => (at + 1) % n) : order;
}

/** `text-transform: uppercase` for cased scripts only. */
export function shuffleCase(text: string): string {
  return SIMPLE.test(text) && !PICTO.test(text) ? text.toUpperCase() : text;
}

const outBack = (p: number, c: number) => 1 + (c + 1) * (p - 1) ** 3 + c * (p - 1) ** 2;

/** A turn of `a` degrees about an edge under the sample's perspective, as the renderers' shared camera shows it (flap's formula). */
function turn(a: number, k: number): { sy: number; rx: number } {
  const r = (a * Math.PI) / 180;
  const depth = k * Math.sin(r);
  return { sy: Math.hypot(Math.cos(r), depth), rx: (Math.atan2(depth, Math.cos(r)) * 180) / Math.PI };
}

interface WordInfo {
  readonly at: number;
  readonly text: string;
  readonly hero: boolean;
  readonly units: readonly string[];
  /** One tile per letter (cased and simple scripts) or one for the whole word. */
  readonly letters: boolean;
  /** Em advance of each unit alone. */
  readonly adv: readonly number[];
  /** Em pen position of each unit when the word is shaped with its tile tracking. */
  readonly pen: readonly number[];
  /** Em ink extents above (negative) and below the baseline of a whole-word tile; null for letters. */
  readonly ink: readonly [top: number, bottom: number] | null;
  readonly spec: Spec;
  /** Em tracking of the word's text run. */
  readonly ls: number;
  /** The scramble: the letter that sits in each slot of the scrambled row. */
  readonly order: readonly number[];
  /** Every tile its own plate and letter. */
  readonly loose: boolean;
}

interface Tile {
  /** Left edge, relative to the item. */
  readonly left: number;
  readonly w: number;
}

/** A row-sized piece of a word: all of it, or a run of its tiles when the word wraps. */
interface Item {
  readonly word: WordInfo;
  readonly part: number;
  readonly parts: number;
  readonly a: number;
  readonly b: number;
  readonly f: number;
  readonly pad: number;
  readonly gap: number;
  readonly h: number;
  readonly radius: number;
  readonly tiles: readonly Tile[];
  readonly width: number;
  x: number;
  y: number;
}

interface Row {
  readonly items: Item[];
  readonly hero: boolean;
  readonly h: number;
  width: number;
  y: number;
}

interface Layout {
  readonly rows: Row[];
  readonly items: Item[];
  readonly top: number;
  readonly bottom: number;
  /** Anchor for the chip marks on short cues. */
  readonly keyRow: Row;
  /** The shrink of the sample's sizes that fits this cue. */
  readonly k: number;
}

interface Plan {
  readonly index: number;
  readonly cue: SceneCue;
  readonly start: number;
  readonly spoken: number;
  readonly from: number;
  to: number;
  layout: Layout;
  place: { top?: number; bottom?: number };
}

interface Ctx {
  readonly input: SceneInput;
  readonly space: SceneSpace;
  readonly u: number;
  readonly maxW: number;
  readonly tile: string;
  readonly solved: string;
  readonly ink: string;
  readonly minMotion: number;
  readonly wordCache: Map<string, { adv: number[]; pen: number[]; ink: readonly [top: number, bottom: number] | null }>;
}

const cueSeed = (cue: SceneCue, index: number, salt: string) => shuffleHash(`${index}:${salt}:${cue.words.map((word) => word.text).join(" ")}`);

function wordInfo(ctx: Ctx, cue: SceneCue, cueNumber: number, at: number, name: SpecName, loose: boolean): WordInfo {
  const word = cue.words[at]!;
  const text = shuffleCase(word.text);
  const letters = SIMPLE.test(text) && !PICTO.test(text);
  const units = letters ? captionTextClusters(text) : [text];
  const spec = SPECS[name];
  const ls = letters ? (spec.pad + spec.gap) / spec.font : 0;
  const key = `${name}|${letters ? "l" : "w"}|${text}`;
  let metrics = ctx.wordCache.get(key);
  if (!metrics) {
    const adv = units.map((unit) => ctx.input.measure(unit, FACE, 100, 0).advance / 100);
    const pen = units.map((_, i) => (ctx.input.measure(units.slice(0, i + 1).join(""), FACE, 100, ls).advance - ctx.input.measure(units[i]!, FACE, 100, 0).advance) / 100);
    // A word that is one tile (a script the face cannot draw) is centred by its ink, not by Montserrat's caps.
    const m = letters ? null : ctx.input.measure(text, FACE, 100, 0);
    metrics = { adv, pen, ink: m ? [m.inkTop / 100, m.inkBottom / 100] : null };
    ctx.wordCache.set(key, metrics);
  }
  const hero = word.role === "hero";
  const order = letters && hero ? shuffleOrder(units, shuffleRng(shuffleHash(`${cueNumber}:${at}:${text}`))) : units.map((_, i) => i);
  return { at, text, hero, units, letters, adv: metrics.adv, pen: metrics.pen, ink: metrics.ink, spec, ls, order, loose: hero && letters && loose };
}

/** The items of a word: one when it fits (shrunk a little if it must), else runs of tiles. */
function itemsOf(ctx: Ctx, word: WordInfo, S: number, compact = false): Item[] {
  const tileW = (i: number, f: number, pad: number) => word.adv[i]! * f + pad;
  const build = (a: number, b: number, kw: number, part: number, parts: number): Item => {
    const f = word.spec.font * S * kw;
    const pad = word.spec.pad * S * kw;
    const gap = word.spec.gap * S * kw;
    const tiles: Tile[] = [];
    if (word.loose) {
      let x = 0;
      for (let i = a; i < b; i++) {
        tiles.push({ left: x, w: tileW(i, f, pad) });
        x += tileW(i, f, pad) + gap;
      }
    } else {
      for (let i = a; i < b; i++) tiles.push({ left: (word.pen[i]! - word.pen[a]!) * f, w: tileW(i, f, pad) });
    }
    const last = tiles.at(-1)!;
    const tall = word.ink ? (word.ink[1] - word.ink[0]) * f * 1.12 : 0;
    return { word, part, parts, a, b, f, pad, gap, h: Math.max(word.spec.h * S * kw, tall), radius: word.spec.radius * S * kw, tiles, width: last.left + last.w, x: 0, y: 0 };
  };
  // The widest a run is drawn: its slots, or the scrambled row of the same letters.
  const widest = (item: Item) => {
    if (!word.loose) return item.width;
    let scrambled = item.gap * (item.b - item.a - 1);
    for (let j = item.a; j < item.b; j++) scrambled += tileW(word.order[j]!, item.f, item.pad);
    return Math.max(item.width, scrambled);
  };
  const n = word.units.length;
  const whole = build(0, n, 1, 0, 1);
  const w1 = widest(whole);
  if (w1 <= ctx.maxW) return [whole];
  const shrink = ctx.maxW / w1;
  if (compact || n === 1 || shrink >= MIN_FIT) return [build(0, n, shrink * 0.995, 0, 1)];
  const widths = word.units.map((_, i) => tileW(i, word.spec.font * S, word.spec.pad * S));
  const rows = balancedRows(widths, word.spec.gap * S, ctx.maxW);
  const starts = [...rows.map((row) => row[0]!), n];
  let kw = 1;
  for (let r = 0; r < rows.length; r++) kw = Math.min(kw, ctx.maxW / widest(build(starts[r]!, starts[r + 1]!, 1, r, rows.length)));
  return rows.map((_, r) => build(starts[r]!, starts[r + 1]!, kw * 0.995, r, rows.length));
}

function layoutCue(ctx: Ctx, cue: SceneCue, cueNumber: number, S: number, place: { top?: number; bottom?: number }): Layout {
  const hasHero = cue.words.some((word) => word.role === "hero");
  const rtl = cueDirection(cue) === "rtl";
  const flat = cue.words.map((word, at) => wordInfo(ctx, cue, cueNumber, at, word.role === "hero" ? "big" : hasHero ? "small" : "lone", false));
  const flatCounts = flat.map((word) => itemsOf(ctx, word, S).length);
  const flatCost = flatCounts.reduce((sum, count) => sum + 3 * count, 0);
  const compact = flatCost > PIECE_LIMIT;
  let budget = PIECE_LIMIT - (compact ? 3 * flat.length : flatCost);
  const words = flat.map((word, at) => {
    const extra = 3 * (word.units.length - (compact ? 1 : flatCounts[at]!));
    if (!word.hero || !word.letters || word.units.length < 2 || extra > budget) return word;
    budget -= extra;
    return wordInfo(ctx, cue, cueNumber, at, "big", true);
  });
  const runs: WordInfo[][] = [];
  for (const word of words) {
    const last = runs.at(-1);
    if (last && last[0]!.hero === word.hero) last.push(word);
    else runs.push([word]);
  }
  const rows: Row[] = [];
  for (const run of runs) {
    const items = run.flatMap((word) => itemsOf(ctx, word, S, compact));
    for (const row of balancedRows(items.map((item) => item.width), WORD_GAP * S, ctx.maxW)) {
      const rowItems = row.map((at) => items[at]!);
      const ordered = rowVisualOrder(rowItems.map((item) => item.word.text), rtl ? "rtl" : "ltr").map((at) => rowItems[at]!);
      rows.push({ items: ordered, hero: run[0]!.hero, h: Math.max(...ordered.map((item) => item.h)), width: ordered.reduce((sum, item) => sum + item.width, 0) + WORD_GAP * S * (ordered.length - 1), y: 0 });
    }
  }
  const gaps = rows.map((row, i) => i === 0 ? 0 : (row.hero || rows[i - 1]!.hero ? HERO_ROW_GAP : ROW_GAP) * S);
  const height = rows.reduce((sum, row, i) => sum + row.h + gaps[i]!, 0);
  const cx = ctx.space.x(540);
  let y = place.top ?? (place.bottom === undefined ? ctx.space.y(ANCHOR_LINE) - height / 2 : place.bottom - height);
  const top = y;
  rows.forEach((row, i) => {
    y += gaps[i]!;
    row.y = y;
    let x = cx - row.width / 2;
    for (const item of row.items) {
      item.x = x;
      item.y = y + (row.h - item.h) / 2;
      x += item.width + WORD_GAP * S;
    }
    y += row.h;
  });
  const last = rows.at(-1)!;
  const firstHero = rows.findIndex((row) => row.hero);
  let keyAt = firstHero < 0 ? rows.length - 1 : firstHero;
  while (firstHero >= 0 && rows[keyAt + 1]?.hero) keyAt++;
  const keyRow = rows[keyAt]!;
  return { rows, items: rows.flatMap((row) => row.items), top, bottom: last.y + last.h + 18 * S, keyRow, k: S / ctx.u };
}

/** Baseline of a word's text inside its tile: Chrome's for caps, the ink's middle for a tile of another script. */
const baselineOf = (item: Item) => (item.word.ink ? item.h / 2 - ((item.word.ink[0] + item.word.ink[1]) / 2) * item.f : (item.h - item.f) / 2 + BASELINE * item.f);

interface Group {
  readonly item: Item;
  /** The letter of a loose item this group is; -1 for a flat item. */
  readonly letter: number;
}

interface Exit {
  readonly start: number;
  readonly dur: number;
  readonly stagger: number;
}

const windowOf = (from: number, until: number, edges: readonly number[], fn: (t: number) => number, tolerance: number): Frames =>
  sampleFrames(fn, edges, tolerance, { range: [from, Math.max(from + 1, until)] });

/** Everything one cue draws. `plan.to` is final here. */
function cuePieces(ctx: Ctx, plan: Plan): Piece[] {
  const { cue, layout } = plan;
  const { input } = ctx;
  const S = ctx.u * layout.k;
  const band = plan.index * 512;
  const to = plan.to;
  const shadow = input.colours.shadow;
  const rng = shuffleRng(cueSeed(cue, plan.index, "beats"));
  const pieces: Piece[] = [];
  const fromOf = (s: number) => (s <= plan.start ? plan.from : Math.max(plan.from, s - LEAD));

  // The exit: flat items in order, then key tiles; it never starts before 150 ms after the last word.
  const groups: Group[] = [
    ...layout.items.filter((item) => !item.word.loose).map((item): Group => ({ item, letter: -1 })),
    ...layout.items.filter((item) => item.word.loose).flatMap((item) => Array.from({ length: item.b - item.a }, (_, m): Group => ({ item, letter: item.a + m }))),
  ];
  const exitEnd = to - EXIT_END;
  const earliest = plan.spoken + HOLD;
  let exit: Exit | null = null;
  if (groups.length > 0 && exitEnd - earliest >= ctx.minMotion) {
    const total = Math.min(EXIT_MS + EXIT_STAGGER * (groups.length - 1), exitEnd - earliest);
    const dur = Math.min(EXIT_MS, total);
    const stagger = groups.length > 1 ? Math.min(EXIT_STAGGER, (total - dur) / (groups.length - 1)) : 0;
    exit = { start: exitEnd - (dur + stagger * (groups.length - 1)), dur, stagger };
  }
  const exitAt = (g: number) => (exit ? exit.start + g * exit.stagger : Number.POSITIVE_INFINITY);
  const endOf = (g: number) => (exit ? Math.min(to, Math.ceil(exitAt(g) + exit.dur)) : to);
  const groupIndex = (item: Item, letter: number) => groups.findIndex((group) => group.item === item && group.letter === letter);
  const firstExit = exit ? exit.start : to;

  const shadowOf = (s: number, blur: number) => [{ dx: 0, dy: s, blur, colour: shadow, alpha: 0.5 }];

  // Collect the chips as the words are drawn.
  interface Chip {
    readonly x: number;
    readonly y: number;
    readonly at: number;
    readonly h: number;
    /** Off a bonus tile: low hops that stay under the row above. */
    readonly low?: boolean;
  }
  const chips: Chip[] = [];

  for (const item of layout.items) {
    const wi = item.word;
    const word = cue.words[wi.at]!;
    const s = word.startMs;
    const from = fromOf(s);
    const base = `shuffle:${plan.index}:w${wi.at}`;
    const text = wi.units.slice(item.a, item.b).join("");

    if (!wi.loose) {
      const g = groupIndex(item, -1);
      const a0 = s - LEAD;
      const ex = exitAt(g);
      const exDur = exit ? exit.dur : 0;
      const baseline = baselineOf(item);
      const pivotX = item.x + item.width / 2;
      const last = word.startMs === Math.max(...cue.words.map((w) => w.startMs));
      // A cue without a key word: its last tile turns gold as it is said.
      const bonusAt = Math.max(from, s) + 110;
      const bonusEnd = Math.min(firstExit, to);
      const bonus = !plan.layout.rows.some((row) => row.hero) && last && item.part === item.parts - 1 && bonusEnd - bonusAt >= Math.max(ctx.minMotion, 1.6 * ctx.minMotion);
      const popOf = (t: number) => (bonus ? Math.sin(Math.PI * prog(t, bonusAt, BONUS_MS)) * -12 * S : 0);
      const angle = (t: number) => (1 - EASES.spring(prog(t, a0, FLIP_MS))) * FLIP_TILT + 95 * EASES.in(prog(t, ex, exDur));
      const end = endOf(g);
      const edges = [a0, a0 + FLIP_MS, ex, ex + exDur].filter((edge) => Number.isFinite(edge));
      const sy = windowOf(from, end, edges, (t) => turn(angle(t), K_SMALL).sy, 0.004);
      const rx = windowOf(from, end, edges, (t) => turn(angle(t), K_SMALL).rx, 0.25);
      const drop = (t: number) => S * (-18 * (1 - EASES.outExpo(prog(t, a0, FLIP_MS))) + 14 * EASES.in(prog(t, ex, exDur)));
      const y = windowOf(from, end, edges, (t) => item.y + drop(t), 0.15);
      const track: Track = { x: [[from, pivotX]], y, sy, rx };
      const gold = bonusAt + BONUS_MS * 0.35;
      const lastTile = item.tiles.length - 1;
      const plate: ShapePiece = {
        id: `${base}p${item.part}`, kind: "shape", z: band + 2, fromMs: from, toMs: end,
        path: item.tiles.flatMap((tile, i) => (bonus && i === lastTile ? [] : roundedRectPath(tile.left, 0, tile.w, item.h, item.radius))),
        fill: { colour: ctx.tile }, shadows: shadowOf(5.5 * S, 2 * S), origin: { dx: item.width / 2, dy: 0 }, track,
      };
      const hasPlate = paintedFrameCount(from, end, input.fps) >= 2;
      if (hasPlate) pieces.push(plate);
      if (bonus) {
        const tile = item.tiles[lastTile]!;
        const bonusEdges = [...edges, bonusAt, bonusAt + BONUS_MS, gold];
        pieces.push({
          id: `${base}b`, kind: "shape", z: band + 2, fromMs: from, toMs: end,
          path: roundedRectPath(0, 0, tile.w, item.h, item.radius),
          fill: { colour: ctx.tile }, shadows: shadowOf(5.5 * S, 2 * S), origin: { dx: item.width / 2 - tile.left, dy: 0 },
          track: { ...track, y: windowOf(from, end, bonusEdges, (t) => item.y + drop(t) + popOf(t), 0.15), colour: [[from, ctx.tile], [gold, ctx.tile], [gold + 1, ctx.solved]] },
        } satisfies ShapePiece);
        const cx = item.x + tile.left + tile.w / 2;
        const count = 2;
        for (let c = 0; c < count; c++) chips.push({ x: cx + (c - 0.5) * tile.w * 0.5, y: item.y + item.h * 0.1, at: gold, h: item.h, low: true });
      }
      if (wi.hero) {
        // A flat key word turns gold as it is said.
        const turned = Math.min(Math.max(from, s) + 60, word.endMs - 1);
        plate.track = { ...track, colour: [[from, ctx.tile], [turned, ctx.tile], [turned + 1, ctx.solved]] };
        for (const at of [0.2, 0.5, 0.8]) chips.push({ x: item.x + item.width * at, y: item.y + item.h * 0.1, at: turned + 1, h: item.h });
      }
      pieces.push({
        id: item.parts > 1 ? `${base}l${item.part}` : base, kind: "text", z: band + 4, fromMs: from, toMs: end,
        text, face: FACE, sizePx: item.f, letterSpacingEm: wi.ls, fill: hasPlate ? ctx.ink : ctx.tile, anchor: "baseline-left", language: cue.language,
        origin: { dx: item.width / 2 - item.pad / 2, dy: -baseline },
        track: !hasPlate
          ? { x: [[from, pivotX]], y: [[from, item.y]] }
          : bonus && item.tiles.length === 1
            ? { ...track, y: windowOf(from, end, [...edges, bonusAt, bonusAt + BONUS_MS], (t) => item.y + drop(t) + popOf(t), 0.15) }
            : track,
        ...(!hasPlate ? { shadows: shadowOf(3 * S, 3 * S) } : {}),
      } satisfies TextPiece);
      continue;
    }

    // Key tiles.
    const n = wi.units.length;
    const D = word.endMs - word.startMs;
    const natural = SOLVE_AT + SOLVE_STAGGER * (n - 1) + HOP_MS;
    const fit = clamp((0.92 * D + LEAD) / natural, 0, 1);
    const settled = fit < MIN_SCALE;
    const c = settled ? MIN_SCALE : fit;
    const landAt = s - LEAD;
    const fd = FALL_MS * c;
    const fst = FALL_STAGGER * c;
    const solveAt = landAt + SOLVE_AT * c;
    const ss = SOLVE_STAGGER * c;
    const hd = HOP_MS * c;
    const wd = WAVE_MS * c;
    const parts = layout.items.filter((other) => other.word === wi).sort((p, q) => p.part - q.part);
    const tr = shuffleRng(shuffleHash(`${plan.index}:${wi.at}:${wi.text}:tiles`));
    // Slots of the scrambled row: the same runs of tiles, centred on their run.
    const slotOf: { x: number; y: number }[] = [];
    for (const part of parts) {
      let width = part.gap * (part.b - part.a - 1);
      for (let j = part.a; j < part.b; j++) width += wi.adv[wi.order[j]!]! * part.f + part.pad;
      let x = part.x + part.width / 2 - width / 2;
      for (let j = part.a; j < part.b; j++) {
        slotOf[j] = { x, y: part.y };
        x += wi.adv[wi.order[j]!]! * part.f + part.pad + part.gap;
      }
    }
    const startOf = new Map<number, { x: number; y: number }>();
    wi.order.forEach((letter, j) => {
      startOf.set(letter, slotOf[j]!);
    });
    const params = wi.units.map((_, i) => ({
      tilt: (tr() - 0.5) * 7,
      hop: i % 2 === 0 ? -(0.2 + tr() * 0.12) : 0.34 + tr() * 0.2,
      spin: (tr() - 0.5) * 26,
      fallSpin: (tr() < 0.5 ? -1 : 1) * (90 + tr() * 90),
      fallX: (tr() - 0.5) * 160,
    }));
    const keep = Math.max(1, Math.ceil(n / MAX_CHIPS));
    const offset = shuffleHash(`${plan.index}:${wi.at}`) % keep;
    const hopHeight = item.h * (layout.rows.length > 1 ? 0.4 : 1);
    for (let i = item.a; i < item.b; i++) {
      const tile = item.tiles[i - item.a]!;
      const home = { x: item.x + tile.left, y: item.y };
      const begin = settled ? home : startOf.get(i)!;
      const q = params[i]!;
      const g = groupIndex(item, i);
      const ex = exitAt(g);
      const exDur = exit ? exit.dur : 0;
      const fallStart = landAt + i * fst;
      const hopStart = settled ? Number.POSITIVE_INFINITY : solveAt + i * ss;
      const waveStart = settled ? fallStart + fd : hopStart + hd * 0.8;
      const tg = Math.min(settled ? fallStart + fd : waveStart + wd * 0.35, exportFrameAtOrBefore(word.endMs - 1, input.fps) - 1);
      const tileFrom = Math.floor(Math.max(from, fallStart));
      const end = endOf(g);
      if (end - tileFrom < 2) continue;
      const fall = (t: number) => prog(t, fallStart, fd);
      const hop = (t: number) => (settled ? 1 : prog(t, hopStart, hd));
      const move = (t: number) => EASES.inOut(clamp((hop(t) - 0.08) / 0.8));
      const lift = (t: number) => (settled ? 0 : kf(hop(t), [[0, 0], [0.38, hopHeight * q.hop, "out"], [0.82, 0, "in"], [0.91, -hopHeight * 0.06, "out"], [1, 0, "in"]]));
      const swing = (t: number) => (settled ? 0 : kf(hop(t), [[0, 0], [0.4, q.spin, "out"], [0.85, 0, "inOut"]]));
      const pop = (t: number) => Math.sin(Math.PI * prog(t, waveStart, wd)) * -12 * S;
      const out = (t: number) => (exit ? EASES.in(prog(t, ex, exDur)) : 0);
      const edges = [
        tileFrom, fallStart, fallStart + fd, waveStart, waveStart + wd, ex, ex + exDur,
        ...(settled ? [] : [0, 0.08, 0.38, 0.4, 0.82, 0.85, 0.88, 0.91, 1].map((p) => hopStart + hd * p)),
      ].filter((edge) => Number.isFinite(edge));
      const fs = (t: number) => lerp(0.35, 1, outBack(fall(t), 1.4));
      const px = (t: number) => lerp(begin.x, home.x, move(t)) + (1 - EASES.outExpo(fall(t))) * q.fallX * 0.15 * S + tile.w / 2;
      const py = (t: number) => lerp(begin.y, home.y, move(t)) + ((1 - outBack(fall(t), 1.1)) * -34 * S) + lift(t) + pop(t) + out(t) * 16 * S + item.h / 2;
      const restTilt = (t: number) => q.tilt * (1 - EASES.inOut(hop(t))) + q.tilt * 0.25 * EASES.inOut(hop(t));
      const rz = (t: number) => (1 - outBack(fall(t), 1.2)) * q.fallSpin * 0.35 + restTilt(t) + swing(t);
      const tracks: Track = {
        x: windowOf(tileFrom, end, edges, px, 0.2),
        y: windowOf(tileFrom, end, edges, py, 0.2),
        rz: windowOf(tileFrom, end, edges, rz, 0.2),
        sx: windowOf(tileFrom, end, edges, fs, 0.003),
        sy: windowOf(tileFrom, end, edges, (t) => fs(t) * turn(95 * out(t), K_BIG).sy, 0.003),
      };
      if (exit) tracks.rx = windowOf(tileFrom, end, edges, (t) => turn(95 * out(t), K_BIG).rx, 0.25);
      const id = `${base}`;
      pieces.push({
        id: `${id}t${i}`, kind: "shape", z: band + 5 + i * 2, fromMs: tileFrom, toMs: end,
        path: roundedRectPath(0, 0, tile.w, item.h, item.radius), fill: { colour: ctx.tile },
        shadows: shadowOf(7 * S, 3 * S), origin: { dx: tile.w / 2, dy: item.h / 2 },
        track: { ...tracks, colour: [[tileFrom, ctx.tile], [Math.max(tileFrom + 1, tg), ctx.tile], [Math.max(tileFrom + 2, tg + 1), ctx.solved]] },
      } satisfies ShapePiece);
      pieces.push({
        id: `${id}l${i}`, kind: "text", z: band + 6 + i * 2, fromMs: tileFrom, toMs: end,
        text: wi.units[i]!, face: FACE, sizePx: item.f, letterSpacingEm: 0, fill: ctx.ink, anchor: "baseline-center", language: cue.language,
        origin: { dx: 0, dy: item.h / 2 - ((item.h - item.f) / 2 + BASELINE * item.f) }, track: tracks,
      } satisfies TextPiece);
      if (i % keep === offset) chips.push({ x: home.x + tile.w / 2, y: home.y + item.h * 0.1, at: tg + 1, h: item.h });
    }
  }

  // Beat: gold chips off the tiles as they turn gold.
  chips.slice(0, MAX_CHIPS).forEach((chip, n) => {
    const dur = Math.min(CHIP_MS * (0.85 + rng() * 0.3), firstExit - chip.at);
    if (dur < ctx.minMotion + 20) return;
    const size = chip.h * (0.13 + 0.05 * rng());
    // A bonus tile ends its row: its chips go outward, never over a neighbour.
    const side = chip.low ? (cueDirection(cue) === "rtl" ? -1 : 1) : (n + (shuffleHash(`${plan.index}`) & 1)) % 2 === 0 ? 1 : -1;
    const [r1, r2, r3] = [rng(), rng(), rng()];
    const dx = side * chip.h * (chip.low ? 0.1 + 0.3 * r1 : 0.25 + 0.5 * r1);
    const rise = chip.h * (chip.low ? 0.2 : 0.38 + 0.14 * r2);
    const fall = chip.h * (chip.low ? 0.12 : 0.25 + 0.15 * r3);
    const spin = side * (140 + 120 * rng());
    const from = Math.round(chip.at);
    const until = Math.round(chip.at + dur);
    const p = (t: number) => prog(t, from, until - from);
    const edges = [from, until];
    pieces.push({
      id: `shuffle:${plan.index}:chip${n}`, kind: "shape", z: band + 490, fromMs: from, toMs: until,
      path: roundedRectPath(0, 0, size, size, size * 0.22), fill: { colour: n % 2 === 0 ? ctx.solved : ctx.tile }, origin: { dx: size / 2, dy: size / 2 },
      track: {
        x: windowOf(from, until, edges, (t) => chip.x + dx * EASES.out(p(t)), 0.2),
        y: windowOf(from, until, edges, (t) => chip.y - rise * p(t) + fall * p(t) ** 2, 0.2),
        rz: [[from, 0], [until, spin]], sx: [[from, 1], [until, 0.55]], sy: [[from, 1], [until, 0.55]],
        o: [[from, 1], [from + 0.55 * (until - from), 1], [until, 0]],
      },
    } satisfies ShapePiece);
  });
  // Short cues keep two small gold chip marks when a hop cannot fit.
  const keyWord = cue.words.find((word) => word.role === "hero") ?? cue.words.at(-1)!;
  const chipLead = fromOf(keyWord.startMs);
  const chipStart = Math.max(chipLead, keyWord.startMs - LEAD + 60);
  const chipFrom = paintedFrameCount(chipStart, firstExit, input.fps) >= 2 ? chipStart : chipLead;
  if (!pieces.some(({ id }) => id.startsWith(`shuffle:${plan.index}:chip`)) && paintedFrameCount(chipFrom, firstExit, input.fps) >= 2) {
    const { keyRow } = layout;
    const size = Math.min(8 * S, keyRow.width / 10);
    const x = ctx.space.x(540);
    const y = keyRow.y + keyRow.h + 9 * S;
    pieces.push({
      id: `shuffle:${plan.index}:chipmarks`, kind: "shape", z: band + 2, fromMs: chipFrom, toMs: firstExit,
      path: [...roundedRectPath(0, 0, size, size, size / 4), ...roundedRectPath(2 * size, 0, size, size, size / 4)],
      fill: { colour: ctx.solved }, origin: { dx: 1.5 * size, dy: 0 },
      track: { x: [[chipFrom, x]], y: [[chipFrom, y]] },
    });
  }

  return pieces;
}

function unionSize(pieces: readonly Piece[], from: number, to: number, input: SceneInput) {
  let x1 = Number.POSITIVE_INFINITY;
  let y1 = Number.POSITIVE_INFINITY;
  let x2 = Number.NEGATIVE_INFINITY;
  let y2 = Number.NEGATIVE_INFINITY;
  for (let t = from; t < to; t += 8) {
    const box = sceneBoundsAt(pieces, t, input.measure);
    if (!box) continue;
    x1 = Math.min(x1, box.x1);
    y1 = Math.min(y1, box.y1);
    x2 = Math.max(x2, box.x2);
    y2 = Math.max(y2, box.y2);
  }
  return { w: x2 - x1, h: y2 - y1 };
}

function buildScene(input: SceneInput): Piece[] {
  const space = sceneSpace(input, ANCHOR_LINE);
  const u = space.u;
  const fps = input.fps ?? SCENE_DEFAULT_FPS;
  const safeW = space.safe.x2 - space.safe.x1;
  const tile = input.colours.primary;
  const ink = input.colours.accent;
  const ctx: Ctx = {
    input, space, u, maxW: Math.min(MAX_W * u, safeW - 56 * u), tile, solved: input.colours.highlight, ink,
    minMotion: Math.max(MIN_MOTION, Math.ceil(2000 / sceneSampleRate(fps)) + 1), wordCache: new Map(),
  };
  const windows = speechWindows(input, space.safe, LEAD, HOLD);
  return renderWithReadingHolds(windows, input, HOLD, (window) => {
    const { cue, index, start, spokenEnd, from, to, bounds } = window;
    const lane = speechLaneSpace(space, bounds, ANCHOR_LINE);
    const laneCtx = { ...ctx, space: lane };
    const room = bounds.y2 - bounds.y1 - 28 * u;
    const place = {};
    let k = 1;
    let plan: Plan = { index, cue, start, spoken: spokenEnd, from, to, layout: layoutCue(laneCtx, cue, index, u, place), place };
    let drawn = cuePieces(laneCtx, plan);
    for (let attempt = 0; attempt < 20; attempt++) {
      const size = unionSize(drawn, from, to, input);
      const shrink = Math.min(1, safeW / (size.w + 2), room / (size.h + 2));
      if (shrink >= 0.999) break;
      k *= Math.max(0.3, shrink * 0.98);
      plan = { ...plan, layout: layoutCue(laneCtx, cue, index, u * k, place) };
      drawn = cuePieces(laneCtx, plan);
    }
    return clampToSafeArea(drawn, bounds, input.measure).filter((piece) =>
      /^shuffle:\d+:w\d+(?:l\d+)?$/.test(piece.id) || hasTwoPaintedFrames(piece, input));
  });
}

export const shuffleProgram: SceneProgram = {
  build(input) {
    return { pieces: buildScene(input) };
  },
};

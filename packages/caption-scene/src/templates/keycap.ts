import { CAPTION_SCENE_BRAND_MIN_CONTRAST, captionColourContrast, captionSceneMeta } from "@narriflow/validators";
import type { DemoScript } from "../demo";
import type { SceneCue } from "../input";
import { type Ease, EASES, kf, lerp, prog } from "../ease";
import { paintedFrameCount } from "../frame-grid";
import { sampleFrames } from "../frames";
import { balancedRows, cueDirection, rowVisualOrder } from "../layout";
import { type Box, type Frames, mixColour, type PathCmd, type Piece, type ShapePiece, type TextPiece, type Track } from "../scene";
import { pathBounds, roundedRectPath } from "../shapes";
import { galleryScene } from "./gallery-layout";

/**
 * Keycap (`samples/templates/m78-keycap.js`, after Motion Array "Trendy Typography Intro"): every word is printed on its
 * own ivory keyboard key. A key drops in already holding its word, 70 ms before it is spoken, and is pressed as it is
 * spoken: the top face sinks, the grey front bevel shortens, the face rebounds. The key word goes on a wide orange Return
 * key with a bent return arrow on its own row; word and arrow sink together, deeper and a beat longer. Keys sit a small
 * gap apart in centred rows, each as wide as its word; on exit they drop away one after another in reading order.
 *
 * Changes from the sample, and why:
 * - **Face.** Space Grotesk Bold (owner decision 2026-11-27) for both the ivory keys and the Return key, instead of
 *   Inter Tight 700/800: the key word's emphasis is the orange key and its size, not a heavier weight. Space Grotesk is
 *   about 10% wider, so the legends are smaller (72 / 88 / 96 / 132 px against the sample's 78 / 96 / 104 / 150) and the
 *   key padding is tighter (0.5 em a side against 0.66, the Return key 0.42 against 0.46); the legend's baseline sits
 *   0.36 em below the face's middle, which centres Space Grotesk's caps and lower case the way the sample's flex box
 *   centred Inter Tight.
 * - **Rows from the words.** The sample's `BREAKS[ci]` table and its fixed size lists are gone. Ordinary words between
 *   key words are wrapped into balanced rows by their measured key widths; every key word has a row of its own, in
 *   reading order (a key word that opens the cue is the top row, one that closes it the bottom row, as Sol asked). The
 *   cue takes the largest of four sizes that packs its ordinary words in two rows, else in three, before it stacks more.
 *   Every key word is honoured, not only the first.
 * - **Long words and other scripts.** A word too wide for the column shrinks to a floor (50 px, the Return key 60 px);
 *   below it a Latin, Greek, Cyrillic or CJK word breaks at grapheme boundaries into the fewest keys of even width, one
 *   row each. A Devanagari or Arabic word never breaks: it shrinks. A key's face takes its height from the measured ink of
 *   its row (Devanagari matras, Nastaliq), with the legend kept inside it, so the fallback face sits on the same key at
 *   the same size and colour. Right-to-left rows run right to left; the Return key's arrow mirrors and goes on its left.
 *   Text is drawn as spoken (no case transform).
 * - **Real speech handoff.** The sample's 20 ms overlap and 90 px lift were a looping demo's way to avoid a blank frame;
 *   on real cues the incoming cue's first key paints on the frame after the outgoing cue's last (the shared windows), so
 *   nothing ever overlaps or blinks. The exit (keys drop 0.5 em, shrink 14% and fade in reading order over 130 ms) only
 *   runs after the last word has read for 150 ms and when it gets two painted frames; otherwise the cue cuts. Keys are
 *   opaque from their first frame (the sample's 22 ms fade-in was under one frame), so a key with no lead is readable at
 *   its spoken start. The press is compressed into the time the cue has, so it never runs into the exit.
 * - **Plate.** The dark socket under each key (outline and 9 px offset shadow that make ivory read on bright footage) is
 *   fixed once the key has landed, as in the sample's last round: the face travels against a fixed rim and bevel.
 * - **Press tint** is a colour track on the face (no extra overlay piece).
 * - **Colours as received.** The legend ink must keep 3:1 on the ivory key and on the Return key, and the Return key must
 *   stand apart from the ivory keys (1.5:1), else the style's own colours are used. Bevel shades are derived from the key
 *   colour (the sample's own shades for the default ivory and orange).
 *
 * Extra recurring beats on every cue: neighbouring keys in a row dip with a press (the deck flexes, 30% of their own
 * travel); the Return arrow nudges toward its head as the key goes down (a carriage return); and a three-stroke click
 * mark in orange with a dark rim flicks out of a free corner of the key word's key on its deepest press (the last key of
 * a cue without a key word), its corner and spread cycling by counter and kept clear of every other key.
 */

export const KEYCAP_DEMO: DemoScript = {
  lines: [
    "stop:b waiting:b for:m motivation:b",
    "it:m starts:b when:m you:m press:h@480",
    "small:b steps:b every:b day",
    "consistency:h@760 beats:b talent:b",
    "one:m key:b at:m a:m time",
    "now:h@520",
  ],
  options: { rate: 245, cueGap: 150, tail: 520, lead: 70 },
};

const FACE = "Space Grotesk Bold";
const SPACING = -0.01;

/** Legend sizes, sample px: ordinary keys, a cue of one or two ordinary words, a key word with words around it, a key word alone. */
const BODY = 72;
const FEW = 88;
const HERO = 96;
const HERO_ALONE = 132;
const BODY_FLOOR = 50;
const HERO_FLOOR = 60;
const SCALES = [1, 0.92, 0.84, 0.76] as const;
/** A row of keys may be this wide, sample px (the sample's x 90 to 990). */
const COLUMN = 900;

/** Key metrics as shares of the legend size (the sample's, re-tuned for Space Grotesk's width). */
const BODY_KEY = { h: 1.66, depth: 0.26, padX: 0.5, r: 0.28, press: 0.16 } as const;
const HERO_KEY = { h: 1.5, depth: 0.29, padX: 0.42, r: 0.26, press: 0.23 } as const;
const INSET = 0.12;
const MIN_WIDTH = 1.45;
const ARROW_W = 0.74;
const ARROW_GAP = 0.22;
/** The dark socket: rim around the key and the offset shadow under it, shares of the legend size (4 px and 9 px at 72). */
const OUT = 0.055;
const DROP = 0.125;
/** Between keys of a row and between rows, shares of the body legend size (12 px and 30 px at 72). */
const GAP = 0.17;
const ROW_GAP = 0.42;
/** The legend's baseline below the face's middle, and the clear margin the ink keeps inside the face, em. */
const BASELINE = 0.36;
const INK_MARGIN = 0.2;

const APPEAR = 70;
const ENTER_MS = 130;
const HERO_ENTER_MS = 220;
const EXIT_SPAN = 130;
const EXIT_LEN = 80;
const FLEX = 0.3;
/** Most keys one token may break into, and most keys one cue may draw (each key is 6 pieces; 150 per cue). */
const MAX_PARTS = 8;
const MAX_KEYS = 20;
/** Visible gap kept between an entering key and the row above it, share of its legend size. */
const ENTRANCE_GAP = 0.06;
const CLICK_MS = 240;
/** The click mark's strokes start this far out from the key's corner and run this long, shares of the legend size. */
const CLICK_D0 = 0.12;
const CLICK_LEN = 0.28;
/** The lines start this far apart along the edge, and diverge by up to this angle. */
const CLICK_STEP = 0.3;
const CLICK_SPREAD_MAX = (24 * Math.PI) / 180;

const SOCKET = "#14141A";
const PRESS_TINT = "#28200A";
const SAMPLE_BEVEL: Record<string, readonly [string, string]> = { "#F6F1E4": ["#B7B2A5", "#8F8A7E"], "#FF5A12": ["#C23F08", "#8F2D05"] };
const bevelsOf = (face: string) => SAMPLE_BEVEL[face.toUpperCase()] ?? [mixColour(face, "#000000", 0.26), mixColour(face, "#000000", 0.42)];

/** Scripts a word may be broken in (grapheme by grapheme) when it is wider than the column at the floor. */
const BREAKABLE = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{N}\p{P}\p{M}ー]+$/u;
const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemes = (text: string) => [...SEGMENTER.segment(text)].map((part) => part.segment);

/** A deterministic hash of a cue's index and text, 0..1. */
function hash(index: number, text: string): number {
  let h = 2166136261 ^ index;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return ((h >>> 0) % 10007) / 10007;
}

/** The overshooting ease of the sample's hero drop (`outBack` with 2.2). */
const outBack22 = (p: number) => 1 + 3.2 * (p - 1) ** 3 + 2.2 * (p - 1) ** 2;

interface Cap {
  readonly word: number;
  readonly part: number;
  readonly parts: number;
  readonly text: string;
  readonly hero: boolean;
  /** Legend size, sample px. */
  readonly size: number;
  /** Key width, sample px. */
  readonly w: number;
  readonly advance: number;
}

/** The outline of a rounded rectangle's lower part: the band of `[0, w]` from `top` down to `bottom`, bottom corners `r`, left side down then right side up. */
function lowerPart(w: number, top: number, bottom: number, r: number, steps = 6): [number, number][] {
  const start = Math.asin(Math.min(1, Math.max(0, (top - (bottom - r)) / r)));
  const left: [number, number][] = top < bottom - r ? [[0, top]] : [];
  for (let k = 0; k <= steps; k++) {
    const a = start + ((Math.PI / 2 - start) * k) / steps;
    left.push([r - r * Math.cos(a), bottom - r + r * Math.sin(a)]);
  }
  const right = left.map(([x, y]): [number, number] => [w - x, y]).reverse();
  return [...left, ...right];
}

const pathOf = (points: readonly (readonly [number, number])[]): PathCmd[] =>
  points.length ? [["M", points[0]![0], points[0]![1]], ...points.slice(1).map(([x, y]) => ["L", x, y] as const), ["Z"]] : [];

const translate = (path: readonly PathCmd[], dx: number, dy: number): PathCmd[] =>
  path.map((cmd): PathCmd => {
    if (cmd[0] === "Z") return cmd;
    if (cmd[0] === "C") return ["C", cmd[1] + dx, cmd[2] + dy, cmd[3] + dx, cmd[4] + dy, cmd[5] + dx, cmd[6] + dy];
    return [cmd[0], cmd[1] + dx, cmd[2] + dy];
  });

/** Key words and cues without one before each cue, counted once per cue list (the click mark's variant counters). */
const counterCache = new WeakMap<readonly SceneCue[], { heroesBefore: number; plainBefore: number }[]>();
function cueCounters(cues: readonly SceneCue[]) {
  let hit = counterCache.get(cues);
  if (!hit) {
    let heroes = 0;
    let plain = 0;
    hit = cues.map((cue) => {
      const entry = { heroesBefore: heroes, plainBefore: plain };
      const count = cue.words.filter((word) => word.role === "hero").length;
      heroes += count;
      if (!count) plain++;
      return entry;
    });
    counterCache.set(cues, hit);
  }
  return hit;
}

const overlapArea = (a: Box, b: Box) => Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1)) * Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));

export const keycapProgram = galleryScene("keycap", 1290, (ctx) => {
  const { cue, index, to, bounds } = ctx.window;
  const { space, fps, input } = ctx;
  const u = space.u;
  const c = input.colours;
  const words = cue.words;
  const rtl = cueDirection(cue) === "rtl";
  const side = rtl ? -1 : 1;

  // Colours as drawn: ink reads on the ivory key, ink reads on the Return key, and the Return key stands apart.
  const defaults = captionSceneMeta("keycap").colours;
  const reads = (a: string, b: string) => captionColourContrast(a, b) >= CAPTION_SCENE_BRAND_MIN_CONTRAST;
  const pairOk = reads(c.primary, c.accent);
  const ink = pairOk ? c.primary : defaults.primary;
  const ivory = pairOk ? c.accent : defaults.accent;
  const orange = reads(ink, c.highlight) && captionColourContrast(c.highlight, ivory) >= 1.5 ? c.highlight : defaults.highlight;
  const legendInk = reads(ink, orange) ? ink : defaults.primary;

  // Measurements per 100 sample px.
  const memo = new Map<string, { advance: number; inkTop: number; inkBottom: number }>();
  const metric = (text: string) => {
    let hit = memo.get(text);
    if (!hit) {
      const m = input.measure(text, FACE, 100 * u, SPACING);
      hit = { advance: m.advance / u, inkTop: m.inkTop / u, inkBottom: m.inkBottom / u };
      memo.set(text, hit);
    }
    return hit;
  };
  const laneWidth = (bounds.x2 - bounds.x1) / u;
  const column = Math.min(COLUMN, laneWidth - 16);
  const heroCount = words.filter((word) => word.role === "hero").length;
  const ordinaryCount = words.length - heroCount;
  const few = heroCount === 0 && ordinaryCount <= 2;
  /** Key width per legend px: legend advance, padding, and the Return key's arrow. */
  const perPx = (text: string, hero: boolean) => {
    const k = hero ? HERO_KEY : BODY_KEY;
    return metric(text).advance / 100 + 2 * k.padX + (hero ? ARROW_GAP + ARROW_W : 0);
  };
  const keyWidth = (text: string, size: number, hero: boolean) => Math.max(perPx(text, hero) * size, MIN_WIDTH * size);
  /** The whole footprint per legend px, socket rim included: what must fit the column. */
  const footPx = (text: string, hero: boolean) => perPx(text, hero) + 2 * OUT;

  /** A word broken into the fewest even pieces that fit the column at `size`, never more than `cap` (then they are only even). */
  const chunks = (text: string, size: number, hero: boolean, cap: number): string[] => {
    const parts = graphemes(text);
    const pad = footPx("", hero);
    const split = (room: number) => {
      const out: string[] = [];
      let row = "";
      for (const g of parts) {
        if (row && metric(row + g).advance > room) {
          out.push(row);
          row = "";
        }
        row += g;
      }
      if (row) out.push(row);
      return out;
    };
    const room = (column / size - pad) * 100;
    const count = Math.min(cap, split(room).length);
    let lo = 0;
    let hi = Math.max(room, metric(text).advance + 1);
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      if (split(mid).length <= count) hi = mid;
      else lo = mid;
    }
    return split(hi);
  };

  const plan = (scale: number, cap: number, heroScale = scale) => {
    const caps: Cap[] = [];
    words.forEach((word, at) => {
      const hero = word.role === "hero";
      const base = hero ? (ordinaryCount ? HERO : HERO_ALONE) * heroScale : (few ? FEW : BODY) * scale;
      const floor = hero ? HERO_FLOOR : BODY_FLOOR;
      const text = word.text;
      const natural = keyWidth(text, base, hero);
      if (natural + 2 * OUT * base <= column) {
        caps.push({ word: at, part: 0, parts: 1, text, hero, size: base, w: natural, advance: (metric(text).advance * base) / 100 });
        return;
      }
      const fitted = column / footPx(text, hero);
      if (fitted >= floor || !BREAKABLE.test(text)) {
        caps.push({ word: at, part: 0, parts: 1, text, hero, size: fitted, w: keyWidth(text, fitted, hero), advance: (metric(text).advance * fitted) / 100 });
        return;
      }
      const pieces = chunks(text, floor, hero, cap);
      // At the floor or above when the pieces fit the cap; a pathological token (hundreds of letters) keeps its text in `cap` keys.
      const size = Math.min(column / Math.max(...pieces.map((piece) => footPx(piece, hero))), Math.max(floor, base));
      for (const [part, piece] of pieces.entries()) caps.push({ word: at, part, parts: pieces.length, text: piece, hero, size, w: keyWidth(piece, size, hero), advance: (metric(piece).advance * size) / 100 });
    });
    // Rows: every key word piece and every broken-word piece alone; ordinary words in balanced runs between them.
    const rows: Cap[][] = [];
    let run: Cap[] = [];
    let ordinaryRows = 0;
    const flush = () => {
      if (!run.length) return;
      const gap = GAP * run[0]!.size;
      const split = balancedRows(run.map((cap) => cap.w), gap, column - 2 * OUT * run[0]!.size);
      for (const row of split) rows.push(row.map((at) => run[at]!));
      ordinaryRows += split.length;
      run = [];
    };
    for (const cap of caps) {
      if (cap.hero || cap.parts > 1) {
        flush();
        rows.push([cap]);
      } else run.push(cap);
    }
    flush();
    return { caps, rows, ordinaryRows };
  };
  // The per-token key cap shrinks until the cue stays within its key budget.
  let partCap = MAX_PARTS;
  while (partCap > 1 && plan(1, partCap).caps.length > MAX_KEYS) partCap--;
  const planAt = (scale: number, heroScale = scale) => plan(scale, partCap, heroScale);
  let chosen = planAt(SCALES[0]);
  let chosenScale: number = SCALES[0];
  pick: for (const limit of [2, 3]) {
    for (const scale of SCALES) {
      const candidate = planAt(scale);
      if (candidate.ordinaryRows <= limit) {
        chosen = candidate;
        chosenScale = scale;
        break pick;
      }
    }
  }
  if (chosen.ordinaryRows > 3) {
    chosenScale = SCALES[SCALES.length - 1]!;
    chosen = planAt(chosenScale);
  }
  // A key word after or before one run of ordinary words: the next smaller size when it saves that run a whole row.
  const runs = words.reduce((count, word, at) => count + (word.role !== "hero" && (at === 0 || words[at - 1]!.role === "hero") ? 1 : 0), 0);
  const smaller = SCALES[SCALES.indexOf(chosenScale as (typeof SCALES)[number]) + 1];
  if (heroCount > 0 && runs === 1 && chosen.ordinaryRows > 1 && smaller !== undefined) {
    const candidate = planAt(smaller, chosenScale);
    if (candidate.ordinaryRows < chosen.ordinaryRows) chosen = candidate;
  }
  const { caps, rows } = chosen;
  const bodySize = Math.max(...caps.map((cap) => (cap.hero ? 0 : cap.size)), 0) || caps[0]!.size;

  // Geometry, sample px, relative to the block's centre.
  interface Key {
    readonly cap: Cap;
    readonly row: number;
    readonly left: number;
    readonly top: number;
    readonly w: number;
    readonly h: number;
    readonly depth: number;
    readonly r: number;
    readonly inset: number;
    readonly press: number;
    readonly baseline: number;
    /** Clear space above the face to the row above's socket, sample px (Infinity on the top row). */
    readonly clear: number;
    /** Clear space below this row's socket to the next row's face, sample px (Infinity on the bottom row). */
    clearBelow: number;
    neighbours: Key[];
  }
  const keys: Key[] = [];
  let y = 0;
  const rowBottoms: number[] = [];
  rows.forEach((row, r) => {
    const size = Math.max(...row.map((cap) => cap.size));
    const k = row[0]!.hero ? HERO_KEY : BODY_KEY;
    const above = Math.max(0.7 * size, ...row.map((cap) => (-metric(cap.text).inkTop * cap.size) / 100));
    const below = Math.max(0, ...row.map((cap) => (metric(cap.text).inkBottom * cap.size) / 100));
    const h = Math.max(k.h * size, above + below + 2 * INK_MARGIN * size);
    const baseline = Math.min(h - INK_MARGIN * size - below, Math.max(INK_MARGIN * size + above, h / 2 + BASELINE * size));
    const depth = k.depth * size;
    if (r > 0) y += ROW_GAP * Math.max(size, bodySize);
    const clear = r > 0 ? y - rowBottoms[r - 1]! - ENTRANCE_GAP * size : Number.POSITIVE_INFINITY;
    const gap = GAP * size;
    const order = rowVisualOrder(row.map((cap) => cap.text), rtl ? "rtl" : "ltr");
    const width = row.reduce((sum, cap) => sum + cap.w, 0) + gap * (row.length - 1);
    let x = -width / 2;
    const placed: Key[] = [];
    for (const i of order) {
      const cap = row[i]!;
      const key: Key = { cap, row: r, left: x, top: y, w: cap.w, h, depth, r: k.r * size, inset: INSET * size, press: k.press * size, baseline, clear, clearBelow: Number.POSITIVE_INFINITY, neighbours: [] };
      placed.push(key);
      x += cap.w + gap;
    }
    placed.forEach((key, i) => {
      key.neighbours = [placed[i - 1], placed[i + 1]].filter((other): other is Key => Boolean(other));
    });
    keys.push(...placed.sort((a, b) => a.cap.word - b.cap.word || a.cap.part - b.cap.part));
    y += h + depth;
    rowBottoms.push(y + (OUT + DROP) * size);
  });
  for (const key of keys) {
    const next = keys.find((other) => other.row === key.row + 1);
    if (next) key.clearBelow = next.top - rowBottoms[key.row]! - ENTRANCE_GAP * key.cap.size;
  }
  const blockBottom = rowBottoms.at(-1)!;
  const cx = space.x(540);
  const cy = space.y(1290) - (blockBottom / 2) * u;
  keys.sort((a, b) => a.cap.word - b.cap.word || a.cap.part - b.cap.part);

  // Timing.
  const exitStart0 = Math.max(ctx.exitAt, to - EXIT_SPAN);
  const exitOn = ctx.exit && paintedFrameCount(exitStart0, to, fps) >= 2;
  const exitSpan = to - exitStart0;
  const exitLen = exitSpan >= 67 ? Math.min(EXIT_LEN, exitSpan) : exitSpan;
  const stagger = keys.length > 1 ? (exitSpan - exitLen) / (keys.length - 1) : 0;
  // The last key's fade ends on the shared window's end, so the cue never clears before the next one paints.
  const exitOf = (i: number) => (exitOn ? { at: keys.length > 1 ? exitStart0 + i * stagger : to - exitLen, len: exitLen } : null);
  const stop = exitOn ? exitStart0 : to;

  /** The press of a word's key, 0 (up) to 1 (down), compressed into the time before the exit. */
  const pressOf = (key: Key): { fn: (t: number) => number; edges: number[]; bottom: number } | null => {
    const word = words[key.cap.word]!;
    const s0 = word.startMs;
    const hero = key.cap.hero;
    const end = hero ? 440 : 215;
    const k = Math.min(1, (stop - s0) / end);
    if (k * end < 100) {
      // Too short to sink and rebound: a compact static pressed pose from the spoken start, when it holds for two painted frames.
      if (paintedFrameCount(Math.max(s0, ctx.window.from), stop, fps) < 2) return null;
      const at = Math.max(s0, ctx.window.from);
      const held: Frames = [[at - 0.001, 0], [at, 1]];
      return { fn: (t) => kf(t, held), edges: [at - 0.001, at], bottom: at };
    }
    const frames: Frames = hero
      ? [[s0 - 20, 0], [s0 + 100 * k, 1, "out"], [s0 + 260 * k, 1], [s0 + 440 * k, 0, "outBack"]]
      : [[s0 - 45, 0], [s0 + 25 * k, 1, "out"], [s0 + 50 * k, 1], [s0 + 215 * k, 0, "outBack"]];
    return { fn: (t) => kf(t, frames), edges: frames.map((frame) => frame[0]), bottom: frames[1]![0] };
  };
  const presses = new Map(keys.map((key) => [key, pressOf(key)] as const));

  const pieces: Piece[] = [];
  const keyBoxes = keys.map((key) => ({
    x1: key.left - OUT * key.cap.size, x2: key.left + key.w + OUT * key.cap.size,
    y1: key.top, y2: key.top + key.h + key.depth + (OUT + DROP) * key.cap.size,
  }));

  keys.forEach((key, i) => {
    const { cap } = key;
    const word = words[cap.word]!;
    const hero = cap.hero;
    const size = cap.size;
    const timing = ctx.enter(word, hero ? HERO_ENTER_MS : ENTER_MS, APPEAR);
    const { from, settled } = timing;
    const span = settled - from;
    const frames = paintedFrameCount(from, settled, fps);
    const motion = timing.motion;
    const enterEase = hero && frames >= 4 ? outBack22 : EASES.out;
    const ent = (t: number) => (motion ? enterEase(prog(t, from, span)) : 1);
    const exit = exitOf(i);
    const ex = (t: number) => (exit ? EASES.in(prog(t, exit.at, exit.len)) : 0);
    const total = key.h + key.depth;
    // Pivot: the key's middle, 60% down (the sample's transform-origin), in canvas px.
    const px = cx + (key.left + key.w / 2) * u;
    const py = cy + (key.top + 0.6 * total) * u;
    // The entrance starts higher (and the Return key larger) than it rests; both are limited so the key's top never reaches
    // the row above's socket, and the Return key's start never spills past the lane's width.
    const reachAbove = 0.6 * total;
    let lift = (hero ? -0.48 : -0.36) * size;
    let s0 = hero ? Math.min(1.14, Math.max(1, (laneWidth - 8) / (key.w + 2 * OUT * size))) : 0.93;
    const up = -lift + (s0 - 1) * reachAbove;
    if (up > key.clear) {
      if (s0 > 1) {
        const f = Math.max(0, key.clear) / up;
        lift *= f;
        s0 = 1 + (s0 - 1) * f;
      } else lift = -Math.max(0, key.clear + (1 - s0) * reachAbove);
    }
    // On exit a key drops away, but never onto the row below it, which leaves after it.
    const drop = Math.min(0.5 * bodySize, Math.max(0, key.clearBelow)) * u;
    const groupY = (t: number) => py + (1 - ent(t)) * lift * u + ex(t) * drop;
    const groupS = (t: number) => lerp(s0, 1, ent(t)) * (1 - 0.14 * ex(t));
    const own = presses.get(key) ?? null;
    const pushes = [own, ...key.neighbours.map((other) => presses.get(other) ?? null)];
    const sink = (t: number) => {
      const p = own ? own.fn(t) : 0;
      const flex = key.neighbours.reduce((sum, other) => sum + (presses.get(other)?.fn(t) ?? 0), 0) * FLEX;
      return Math.min(1, p + flex) * key.press * u * groupS(t);
    };
    const edges = [from, settled, ...(exit ? [exit.at, exit.at + exit.len] : []), ...pushes.flatMap((push) => push?.edges ?? [])];
    const sample = (fn: (t: number) => number, tolerance: number) => sampleFrames(fn, edges, tolerance, { range: [from, to], simplify: true });
    // A key that paints on a single export frame (back-to-back 70 ms words) is drawn whole and still, its backing named as parts
    // of its word (`w<word>l8x`), the one name the shared one-frame filter leaves: the legend is never bare on the footage.
    const oneFrame = paintedFrameCount(from, to, fps) < 2;
    const scaleFrames = oneFrame ? ([[from, 1]] as Frames) : sample(groupS, 0.002);
    const opacity: Frames = exit && !oneFrame ? [[from, 1], [exit.at, 1], [exit.at + exit.len, 0, "in"]] : [[from, 1]];
    const base: Track = { x: [[from, px]], sx: scaleFrames, sy: scaleFrames, o: opacity };
    const still: Track = { ...base, y: oneFrame ? [[from, py]] : sample(groupY, 0.15) };
    const moving: Track = oneFrame ? still : { ...base, y: sample((t) => groupY(t) + sink(t), 0.15) };

    const id = cap.parts > 1 ? `${ctx.id}:w${cap.word}l${cap.part}` : `${ctx.id}:w${cap.word}`;
    const backing = (suffix: string, n: number) => (oneFrame ? `:w${cap.word}l${80 + cap.part * 8 + n}` : suffix);
    // Pivot in key-local px (sample px times u); a path is drawn from its own top-left with the pivot in `origin`.
    const pivotLocal = { x: (key.w / 2) * u, y: 0.6 * total * u };
    const shape = (suffix: string, z: number, path: readonly PathCmd[], track: Track, fill?: { colour: string; alpha?: number }): ShapePiece => {
      const b = pathBounds(path);
      return {
        id: suffix.startsWith(":") ? `${ctx.id}${suffix}` : `${id}${suffix}`, kind: "shape", z, fromMs: from, toMs: to, path: translate(path, -b.x1, -b.y1),
        origin: { dx: pivotLocal.x - b.x1, dy: pivotLocal.y - b.y1 }, track, ...(fill ? { fill } : {}),
      };
    };
    const U = (v: number) => v * u;
    const face = hero ? orange : ivory;
    const [bevel, bevelDark] = bevelsOf(face);
    const w = key.w;
    const out = OUT * size;
    const plateTop = key.press - out;
    // The socket: fixed under the key (rim and offset shadow), its top a rim above the face's deepest press.
    pieces.push(shape(backing("socket", 0), 1, roundedRectPath(U(-out), U(plateTop), U(w + 2 * out), U(total + out + DROP * size - plateTop), U(key.r + out)), still, { colour: SOCKET, alpha: 0.92 }));
    // The bevel: sides flaring out from under the face down to the front, rounded at the bottom.
    const top0 = 0.42 * key.h;
    const sideY = key.h - 0.08 * size;
    const body = lowerPart(w, sideY, total, key.r);
    const bevelPath = pathOf(([[key.inset, top0], [w - key.inset, top0], ...body.slice().reverse()] as [number, number][]).map(([x, y2]) => [U(x), U(y2)]));
    pieces.push(shape(backing("bevel", 1), 2, bevelPath, still, { colour: bevel }));
    const band = Math.max((7 / 72) * size, 0.34 * key.depth);
    pieces.push(shape(backing("band", 2), 3, pathOf(lowerPart(w, total - band, total, key.r).map(([x, y2]) => [U(x), U(y2)])), still, { colour: bevelDark }));
    // The face, its top-edge highlight, the legend and the arrow travel together.
    // The pressed colour keeps the legend at 3:1 as drawn: the tint is cut back (or dropped) for a key whose ink would dim below it.
    const legend = hero ? legendInk : ink;
    let tint = 0.16;
    while (tint > 0 && !reads(legend, mixColour(face, PRESS_TINT, tint))) tint = Math.max(0, tint - 0.02);
    const pressed = mixColour(face, PRESS_TINT, tint);
    const tintFrames = own && tint > 0 && !oneFrame ? sampleFrames((t) => own.fn(t), [from, to, ...own.edges], 0.03, { range: [from, to], simplify: true }) : null;
    const colour = tintFrames && tintFrames.length > 1 ? tintFrames.map(([t, p]) => [t, mixColour(face, pressed, Math.min(1, Math.max(0, p)))] as const) : undefined;
    pieces.push(shape(backing("face", 3), 4, roundedRectPath(U(key.inset), 0, U(w - 2 * key.inset), U(key.h), U(Math.max(0, key.r - (3 / 72) * size))), { ...moving, ...(colour ? { colour } : {}) }, { colour: face }));
    const hi = hero ? { colour: "#FFFFFF", alpha: 0.35 } : { colour: mixColour(face, "#FFFFFF", 0.7) };
    pieces.push(shape(backing("hi", 4), 5, roundedRectPath(U(key.r), U(0.07 * size), U(Math.max(1, w - 2 * key.r)), U(0.055 * size), U(0.03 * size)), moving, hi));

    const contentGap = ARROW_GAP * size;
    const arrowW = ARROW_W * size;
    const content = cap.advance + (hero ? contentGap + arrowW : 0);
    const contentLeft = (w - content) / 2;
    const textCentre = hero ? (rtl ? contentLeft + arrowW + contentGap + cap.advance / 2 : contentLeft + cap.advance / 2) : w / 2;
    const textPiece: TextPiece = {
      id, kind: "text", z: 6, fromMs: from, toMs: to, text: cap.text, face: FACE, sizePx: size * u, letterSpacingEm: SPACING,
      fill: legend, anchor: "baseline-center", language: cue.language,
      origin: { dx: pivotLocal.x - U(textCentre), dy: pivotLocal.y - U(key.baseline) }, track: moving,
    };
    pieces.push(textPiece);
    if (hero && cap.part === cap.parts - 1) {
      // The bent return arrow: down from the right, along the bottom, head pointing back (mirrored for right to left).
      const a = arrowW / 40;
      const ax = rtl ? contentLeft : contentLeft + cap.advance + contentGap;
      const midY = key.baseline - 0.35 * size;
      const ay = midY - 20 * a;
      const mx = (x: number) => (rtl ? 40 - x : x);
      const pt = (x: number, y2: number) => [U(ax + mx(x) * a), U(ay + y2 * a)] as const;
      const arrow: PathCmd[] = [["M", ...pt(34, 5)], ["L", ...pt(34, 24)], ["L", ...pt(8, 24)], ["M", ...pt(18, 14)], ["L", ...pt(7, 24)], ["L", ...pt(18, 34)]];
      const nudge = own ? (t: number) => -side * 0.06 * size * u * own.fn(t) : null;
      const arrowTrack: Track = nudge ? { ...moving, x: sampleFrames((t) => px + nudge(t), [from, to, ...own!.edges], 0.15, { range: [from, to], simplify: true }) } : moving;
      pieces.push({ ...shape(backing("arrow", 5), 7, arrow, oneFrame ? still : arrowTrack), stroke: { widthPx: U(5.6 * a), colour: legendInk } });
    }
  });

  // The click mark: three short strokes flicking out of a free corner of the key word's key (the last key of a cue without one).
  const { heroesBefore, plainBefore } = cueCounters(input.cues)[index]!;
  const targets = heroCount ? keys.filter((key) => key.cap.hero && key.cap.part === key.cap.parts - 1) : [keys.at(-1)!];
  targets.forEach((key, nth) => {
    const counter = heroCount ? heroesBefore + nth : plainBefore;
    const size = Math.min(key.cap.size, HERO);
    const box = keyBoxes[keys.indexOf(key)]!;
    // Spots: level with the key's middle at its reading end or its start (alternating by counter), then its top corners.
    const mid = (box.y1 + key.top + key.h + key.depth) / 2;
    const spots = [
      { x: side > 0 ? box.x2 : box.x1, y: mid, angle: side > 0 ? 0 : Math.PI },
      { x: side > 0 ? box.x1 : box.x2, y: mid, angle: side > 0 ? Math.PI : 0 },
      { x: side > 0 ? box.x2 : box.x1, y: box.y1, angle: side > 0 ? -Math.PI / 4 : (-3 * Math.PI) / 4 },
      { x: side > 0 ? box.x1 : box.x2, y: box.y1, angle: side > 0 ? (-3 * Math.PI) / 4 : -Math.PI / 4 },
    ];
    const order = counter % 2 ? [1, 0, 3, 2] : [0, 1, 2, 3];
    const others = keyBoxes.filter((_, at) => at !== keys.indexOf(key));
    const laneBox = { x1: (bounds.x1 - cx) / u, x2: (bounds.x2 - cx) / u, y1: (bounds.y1 - cy) / u, y2: (bounds.y2 - cy) / u };
    const options = order.map((k) => {
      const option = spots[k]!;
      const n = [-Math.sin(option.angle), Math.cos(option.angle)] as const;
      const ends = [-1, 0, 1].flatMap((d) => {
        const a = option.angle + d * CLICK_SPREAD_MAX;
        const x0 = option.x + (Math.cos(option.angle) * CLICK_D0 + n[0] * d * CLICK_STEP) * size;
        const y0 = option.y + (Math.sin(option.angle) * CLICK_D0 + n[1] * d * CLICK_STEP) * size;
        const reach = (CLICK_LEN + 0.08) * size;
        return [[x0, y0], [x0 + Math.cos(a) * reach, y0 + Math.sin(a) * reach]] as const;
      });
      const area = { x1: Math.min(...ends.map((p) => p[0])), x2: Math.max(...ends.map((p) => p[0])), y1: Math.min(...ends.map((p) => p[1])), y2: Math.max(...ends.map((p) => p[1])) };
      const inside = area.x1 >= laneBox.x1 && area.x2 <= laneBox.x2 && area.y1 >= laneBox.y1 && area.y2 <= laneBox.y2;
      return { ...option, hit: others.reduce((sum, other) => sum + overlapArea(area, other), 0), inside };
    });
    const spot = options.find((option) => option.inside && option.hit === 0);
    if (!spot) return;
    const word = words[key.cap.word]!;
    const press = presses.get(key);
    const at = Math.max(ctx.window.from, word.startMs, press ? press.bottom : word.startMs);
    const end = Math.min(stop, at + CLICK_MS);
    const painted = paintedFrameCount(at, end, fps);
    if (painted < 2) return;
    const still = painted < 4;
    const spread = CLICK_SPREAD_MAX * (0.78 + 0.22 * hash(index, word.text));
    const base = spot.angle;
    const d0 = CLICK_D0 * size;
    const len = CLICK_LEN * size;
    const lines: PathCmd[] = [];
    // Three lines a little apart along the key's edge, diverging outward (emphasis lines, not a fan from one point).
    const n = [-Math.sin(base), Math.cos(base)] as const;
    for (const i of [-1, 0, 1]) {
      const a = base + i * spread;
      const sx = (Math.cos(base) * d0 + n[0] * i * CLICK_STEP * size) * u;
      const sy = (Math.sin(base) * d0 + n[1] * i * CLICK_STEP * size) * u;
      lines.push(["M", sx, sy], ["L", sx + Math.cos(a) * len * u, sy + Math.sin(a) * len * u]);
    }
    const b = pathBounds(lines);
    const ox = cx + spot.x * u;
    const oy = cy + spot.y * u;
    const t1 = at + 0.33 * (end - at);
    const t2 = at + 0.7 * (end - at);
    const grow: Frames = still ? [[at, 1]] : [[at, 0.55], [t1, 1, "out"], [t2, 1], [end, 1.12]];
    const fade: Frames = still ? [[at, 1]] : [[at, 1], [t2, 1], [end, 0, "in" as Ease]];
    const track: Track = { x: [[at, ox]], y: [[at, oy]], sx: grow, sy: grow, o: fade };
    const mark = (suffix: string, z: number, width: number, colour: string): ShapePiece => ({
      id: `${ctx.id}:w${key.cap.word}click${suffix}`, kind: "shape", z, fromMs: at, toMs: end, path: translate(lines, -b.x1, -b.y1),
      origin: { dx: -b.x1, dy: -b.y1 }, track, stroke: { widthPx: width * u, colour },
    });
    pieces.push(mark("r", 8, 0.15 * size, SOCKET), mark("", 9, 0.08 * size, orange));
  });
  return pieces;
}, undefined, APPEAR);

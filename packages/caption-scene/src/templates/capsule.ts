import { CAPTION_SCENE_BRAND_MIN_CONTRAST, captionColourContrast, captionSceneMeta } from "@narriflow/validators";
import type { DemoScript } from "../demo";
import { clamp, EASES, type Ease, lerp, prog } from "../ease";
import { exportFrameAtOrBefore, paintedFrameCount } from "../frame-grid";
import { sampleFrames } from "../frames";
import { balancedRows, rowVisualOrder } from "../layout";
import type { Box, PathCmd, Piece, ShapePiece, TextPiece, Track } from "../scene";
import { ellipsePath, polygonPath, roundedRectPath } from "../shapes";
import { galleryScene, rotatePoint } from "./gallery-layout";

/**
 * Capsule (`samples/templates/m83-capsule.js`, after Motion Array "Creative And Trendy Typography"): clean heavy navy
 * words that rise a few px and fade in as they are spoken. The key word is the signature: a solid navy (or coral) capsule
 * with a white rim carries it in white, hangs down from its near end, swings up past level like a gate, overshoots and
 * settles tilted 4-8 degrees, while a spiky starburst pops behind its far end and a smiley sticker and two small sparkles
 * arrive beside it. A cue without a key word gets one small coral sparkle. One cue on screen at a time.
 *
 * Changes from the sample, and why:
 * - **Gabarito ExtraBold, not Poppins** (owner decision, 2026-11-27), for the plain words and the capsule word. Gabarito is
 *   about 15% narrower than Poppins at the same size, so the plain lines are larger (86 px in a cue with a key word, 114 px
 *   without one, 136 px for one or two words; the sample's 78/104/124) and the key word is 106 px (the sample's 100). The
 *   capsule's length is the measured word plus 0.6 em at each end and its height is the larger of 1.66 em and the
 *   measured ink plus padding, so a Devanagari or Nastaliq word (taller ink, fallback face) gets a taller capsule.
 * - **Rows from the words, in reading order.** The sample put every other word in one row above the capsule, so a key word
 *   in the middle of a cue read out of order ("we didn't to go / WANT"). Words before the key word sit in balanced rows
 *   above the capsule, words after it in rows below, and the capsule is its own row. Rows wrap inside an 880 px column.
 * - **The sweep never crosses a word.** Rows above clear the capsule's highest pose (the far end at the overshoot) and the
 *   burst and sparkles; rows below start under the lowest point the capsule still reaches from the moment their first word
 *   paints. The hang starts at 80 degrees when there is room under the hinge and at a shallower angle (down to 30) when
 *   there is not (16:9, a long word, a lane of two speakers), so the whole swing stays inside the band without shrinking
 *   the caption. The sample capped the capsule at 420 px and shrank long words to fit it.
 * - **Long words.** A word wider than the column shrinks to a floor (62% of its size, 70% for the key word), and a Latin,
 *   Cyrillic, Greek or CJK word still too wide breaks into the fewest rows of even measured width (a key word into a
 *   two-line capsule); a Devanagari or Arabic word never breaks, it shrinks.
 * - **A guard for dark footage.** The sample is navy on a bright frame with a soft white glow. The words keep a thin white
 *   keyline (5% of the size) instead of the blurred glow: the same read on bright footage, and navy stays readable on a
 *   dark clip, at no per-frame blur cost.
 * - **No cue-indexed tables.** The capsule/burst colours cycle the sample's four looks by a hero-cue counter, the settled
 *   tilt is 4-8 degrees from a seeded hash, and the extra beats' corners cycle by cue.
 * - **RTL mirrors.** The capsule hinges on its right end and swings the other way, rows run right to left, the stickers go
 *   to the mirrored side.
 * - **Handoff.** The incoming cue's first element starts at 75% opacity on the frame the outgoing cue clears (the sample's
 *   one-frame swap); a cue with time after its reading hold fades and rises 14 px (the sample's last-cue exit).
 * - **Short words.** Fades compress into a word's own time, so a 70 ms word is opaque before it ends; stickers that would not
 *   get their full pop compress, and below four painted frames they show a compact static pose.
 *
 * Extra recurring beats on every cue: three navy speed dashes (the reference's "Creat ≡" lines) that draw out from the
 * reading end of the first row once its last word paints, and a small tilted navy blob (the reference's floating ovals) that pops
 * in at a free corner of the caption on the last word. Single-row cues drift to stay centred on the words spoken so far,
 * as the sample does, never moving a word past the row's own end.
 */

export const CAPSULE_DEMO: DemoScript = {
  lines: [
    "nobody:b is:m coming:b",
    "so:m build:b it:m now:h@480",
    "start:b before:b you:m feel:m ready:h@520",
    "today:h@560",
    "not:m someday:b",
    "the:m work:b gets:b easier:h@560",
  ],
  options: { rate: 175, gap: 20, cueGap: 540, tail: 520, lead: 260 },
};

const FACE = "Gabarito ExtraBold";
const SPACING = -0.01;
const BODY = 86;
const SOLO = 114;
const FEW = 136;
const HERO = 106;
const HERO_ALONE = 132;
const FLOOR = 0.62;
const HERO_FLOOR = 0.7;
const COLUMN = 900;
const PAD = 30;
const KEYLINE = 0.05;
const ROW_GAP = 0.07;
const WORD_GAP = 0.25;
/** Capsule centre line, sample px: rows above it, the hang below it. */
const HINGE_Y = 1240;
const HINGE_Y_ALONE = 1252;
const CAP_MAX = 640;
const START = 80;
const START_MIN = 30;
const PEAK = -12;
const SWING_MS = 240;
const WOBBLE_MS = 420;
const LEAD = 80;
const WORD_LEAD = 60;
const FADE_MS = 60;
const RISE_MS = 260;
const RISE = 16;
const EXIT_RISE = 14;
const START_ALPHA = 0.75;
const LATER_ALPHA = 0.35;

const NAVY = "#16286E";
const WHITE = "#FFFFFF";

type Key = [number, number, Ease?];

/** Words that can break between characters when one is wider than the column. */
const SPLITTABLE = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{N}\p{P}\p{M}]+$/u;
const graphemes = (text: string) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((part) => part.segment);

const hash = (n: number, text: string) => {
  let h = 2166136261 ^ n;
  for (const ch of text) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619);
  return ((h >>> 0) % 1000) / 1000;
};

const union = (boxes: readonly Box[]): Box => ({
  x1: Math.min(...boxes.map((box) => box.x1)),
  y1: Math.min(...boxes.map((box) => box.y1)),
  x2: Math.max(...boxes.map((box) => box.x2)),
  y2: Math.max(...boxes.map((box) => box.y2)),
});
const grow = (box: Box, by: number): Box => ({ x1: box.x1 - by, y1: box.y1 - by, x2: box.x2 + by, y2: box.y2 + by });
const meets = (a: Box, b: Box) => a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
const inside = (box: Box, room: Box) => box.x1 >= room.x1 && box.x2 <= room.x2 && box.y1 >= room.y1 && box.y2 <= room.y2;
const around = (x: number, y: number, rx: number, ry = rx): Box => ({ x1: x - rx, y1: y - ry, x2: x + rx, y2: y + ry });

const outBack = (p: number, c = 2.4) => 1 + (c + 1) * (p - 1) ** 3 + c * (p - 1) ** 2;

/** The sample's 16-point starburst: long, short and mid points around a deep waist. */
const burstPath = (radius: number): PathCmd[] =>
  polygonPath(Array.from({ length: 32 }, (_, i) => {
    const a = (Math.PI * i) / 16;
    const r = (i % 2 ? 0.6 : i % 4 === 0 ? 1 : 0.88) * radius;
    return [Math.cos(a) * r, Math.sin(a) * r] as const;
  }));

/** The sample's sparkle: four curved points. */
const curvedSparkle = (r: number): PathCmd[] => [
  ["M", 0, -r], ["C", 0, -0.2 * r, 0.2 * r, 0, r, 0], ["C", 0.2 * r, 0, 0, 0.2 * r, 0, r],
  ["C", 0, 0.2 * r, -0.2 * r, 0, -r, 0], ["C", -0.2 * r, 0, 0, -0.2 * r, 0, -r], ["Z"],
];

interface Cell {
  readonly word: number;
  readonly part: number;
  readonly text: string;
  readonly size: number;
  readonly width: number;
  readonly inkTop: number;
  readonly inkBottom: number;
  x: number;
  baseline: number;
}

export const capsuleProgram = galleryScene("capsule", 1290, (ctx) => {
  const { cue, index, from: windowFrom, to, bounds } = ctx.window;
  const { exit, exitAt, fps, space, side, rtl } = ctx;
  const u = space.u;
  const { words } = cue;
  const measure = (text: string, size: number) => ctx.input.measure(text, FACE, size, SPACING);

  // Colours as received: text and capsule keep 3:1 against the white keyline / white word they carry, else the style's own.
  const defaults = captionSceneMeta("capsule").colours;
  const c = ctx.input.colours;
  const keep = (colour: string, against: string, fallback: string) => (captionColourContrast(colour, against) >= CAPTION_SCENE_BRAND_MIN_CONTRAST ? colour : fallback);
  const ink = keep(c.primary, WHITE, defaults.primary);
  const coral = keep(c.highlight, WHITE, defaults.highlight);
  const yellow = keep(c.accent, ink, defaults.accent);

  const heroAt = words.findIndex((word) => word.role === "hero");
  const hasHero = heroAt >= 0;
  const heroOrdinal = ctx.input.cues.slice(0, index).filter((other) => other.words.some((word) => word.role === "hero")).length;
  const plainOrdinal = index - heroOrdinal;
  const textWords = words.flatMap((_, at) => (at === heroAt ? [] : [at]));
  const fs = (hasHero ? BODY : textWords.length <= 2 ? FEW : SOLO) * u;
  const safeW = bounds.x2 - bounds.x1;
  const column = Math.min(COLUMN * u, safeW - 2 * PAD * u);
  const cx = Math.min(bounds.x2 - PAD * u, Math.max(bounds.x1 + PAD * u, space.x(540)));

  // Break an overlong word into the fewest rows that fit, then even them out (UNBELIEVABLE never becomes UNBELI / EVABL / E).
  const chunks = (text: string, size: number, room: number): string[] => {
    const letters = graphemes(text);
    const split = (limit: number) => {
      const out: string[] = [];
      let row = "";
      for (const ch of letters) {
        if (row && measure(row + ch, size).advance > limit) {
          out.push(row);
          row = "";
        }
        row += ch;
      }
      if (row) out.push(row);
      return out;
    };
    const count = split(room).length;
    let lo = 0;
    let hi = room;
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      if (split(mid).length <= count) hi = mid;
      else lo = mid;
    }
    return split(hi);
  };
  /** A word at `base`, shrunk to fit `room` down to `floor`, broken below that when its script allows. */
  const fitWord = (text: string, base: number, floor: number, room: number): { texts: string[]; size: number } => {
    const natural = measure(text, base).advance;
    if (natural <= room) return { texts: [text], size: base };
    const fitted = (base * room) / natural;
    if (fitted >= floor || !SPLITTABLE.test(text)) return { texts: [text], size: fitted };
    const parts = chunks(text, floor, room * 0.98);
    const widest = Math.max(...parts.map((part) => measure(part, 100).advance));
    return { texts: parts, size: clamp((room * 0.98 * 100) / widest, floor, base) };
  };

  // Rows of plain words: a run of words wraps into balanced rows, a broken word takes rows of its own.
  const makeRows = (list: readonly number[]): Cell[][] => {
    const groups: Cell[][] = [];
    let run: Cell[] = [];
    for (const at of list) {
      const fitted = fitWord(words[at]!.text, fs, fs * FLOOR, column);
      const cells = fitted.texts.map((text, part): Cell => {
        const m = measure(text, fitted.size);
        return { word: at, part: fitted.texts.length > 1 ? part : -1, text, size: fitted.size, width: m.advance, inkTop: m.inkTop, inkBottom: m.inkBottom, x: 0, baseline: 0 };
      });
      if (cells.length > 1) {
        if (run.length) groups.push(run);
        run = [];
        for (const cell of cells) groups.push([cell]);
      } else run.push(cells[0]!);
    }
    if (run.length) groups.push(run);
    const gap = WORD_GAP * fs;
    return groups.flatMap((group) => balancedRows(group.map((cell) => cell.width), gap, column).map((row) => row.map((at) => group[at]!)));
  };
  const above = (row: readonly Cell[]) => Math.max(...row.map((cell) => Math.max(0.78 * cell.size, -cell.inkTop) + KEYLINE * cell.size));
  const below = (row: readonly Cell[]) => Math.max(...row.map((cell) => Math.max(0.2 * cell.size, cell.inkBottom) + KEYLINE * cell.size));
  /** Lays rows out from `top` down, centred on `cx` (in reading order for RTL); returns the bottom of their ink. */
  const placeRows = (rows: readonly Cell[][], top: number): number => {
    let y = top;
    for (const [r, row] of rows.entries()) {
      if (r > 0) y += ROW_GAP * fs;
      y += above(row);
      const gap = WORD_GAP * fs;
      const width = row.reduce((sum, cell) => sum + cell.width, 0) + gap * (row.length - 1);
      let x = Math.min(bounds.x2 - PAD * u - width / 2, Math.max(bounds.x1 + PAD * u + width / 2, cx)) - width / 2;
      for (const i of rowVisualOrder(row.map((cell) => cell.text), rtl ? "rtl" : "ltr")) {
        const cell = row[i]!;
        cell.x = x + cell.width / 2;
        cell.baseline = y;
        x += cell.width + gap;
      }
      y += below(row);
    }
    return y;
  };
  const rowsHeight = (rows: readonly Cell[][]) => rows.reduce((sum, row, r) => sum + above(row) + below(row) + (r > 0 ? ROW_GAP * fs : 0), 0);
  const leadRows = makeRows(textWords.filter((at) => !hasHero || at < heroAt));
  const tailRows = hasHero ? makeRows(textWords.filter((at) => at > heroAt)) : [];
  const cellBox = (cell: Cell): Box => ({
    x1: cell.x - cell.width / 2 - KEYLINE * cell.size, x2: cell.x + cell.width / 2 + KEYLINE * cell.size,
    y1: cell.baseline + cell.inkTop - KEYLINE * cell.size, y2: cell.baseline + cell.inkBottom + KEYLINE * cell.size,
  });

  // Timing of each word: it paints up to 60 ms early (never before the window), opaque before its spoken end.
  const timing = (at: number, lead: number) => {
    const word = words[at]!;
    const from = Math.max(windowFrom, word.startMs - lead);
    const last = Math.max(from, exportFrameAtOrBefore(word.endMs - 1, fps));
    return { from, settled: Math.min(from + FADE_MS, last) };
  };
  const firstPaint = Math.min(...words.map((_, at) => timing(at, at === heroAt ? LEAD : WORD_LEAD).from));
  const startAlpha = (from: number) => (from <= firstPaint + 1 ? START_ALPHA : LATER_ALPHA);
  const exitFrames = (frames: Key[], rest: number, end: number) => {
    if (exit) frames.push([exitAt, rest], [to, end, "in"]);
    return frames;
  };
  const fade = (from: number, settled: number, alpha = startAlpha(from)): Key[] =>
    exitFrames(paintedFrameCount(from, settled, fps) >= 2 ? [[from, alpha], [settled, 1, "out"]] : [[from, 1]], 1, 0);

  const pieces: Piece[] = [];
  const obstacles: Box[] = [];
  /** A sticker's pop: compressed into the frames left before the cue goes, a compact still pose below four painted frames. */
  const beat = (wanted: number, duration: number) => {
    const stop = exit ? exitAt : to;
    const start = Math.max(windowFrom, Math.min(wanted, stop - 3 * (1000 / fps)));
    const end = Math.min(stop, start + duration);
    const frames = paintedFrameCount(start, end, fps);
    return { start, end, span: Math.max(1, end - start), still: frames < 4, ok: frames >= 2 || paintedFrameCount(start, to, fps) >= 2 };
  };
  const shape = (suffix: string, from: number, path: readonly PathCmd[], track: Track, fill: string | null, z: number, extra: Partial<ShapePiece> = {}): ShapePiece => ({
    id: `${ctx.id}:${suffix}`, kind: "shape", z, fromMs: from, toMs: to, path, ...(fill ? { fill: { colour: fill } } : {}), track, ...extra,
  });
  /** A sticker that pops in at (x, y): scale, a turn that settles, and the cue's exit fade. */
  const popTrack = (b: ReturnType<typeof beat>, x: number, y: number, s0: number, turn: number, rest: number, overshoot: (p: number) => number): Track => {
    const frames = (fn: (t: number) => number, error: number) => sampleFrames(fn, [b.start, b.end], error, { range: [b.start, b.end], simplify: true }) as Key[];
    const scale = b.still ? [[b.start, 1]] as Key[] : frames((t) => lerp(s0, 1, overshoot(prog(t, b.start, b.span))), 0.004);
    const rz = b.still ? [[b.start, rest]] as Key[] : frames((t) => rest + turn * (1 - EASES.out(prog(t, b.start, b.span))), 0.2);
    const o: Key[] = b.still ? [[b.start, 1]] : [[b.start, 0.6], [b.start + Math.min(50, b.span / 3), 1]];
    return { x: [[b.start, x]], y: [[b.start, y]], sx: scale, sy: scale, rz: rz.map(([t, v, e]) => [t, v * side, e] as Key), o: exitFrames(o, 1, 0) };
  };

  // ---- The capsule: geometry in its own frame, hinge at (0, 0), drawn left to right and mirrored for RTL. ----
  let capsuleTop = 0;
  let capsuleGroup: Box | null = null;
  let capsuleOwn: Box | null = null;
  let hingeX = cx;
  let hingeY = space.y(HINGE_Y);
  let tailTop = 0;
  type HeroPlan = {
    lines: { text: string; width: number; inkTop: number; inkBottom: number }[];
    size: number; W: number; h: number; r: number; rim: number; k: number;
    settle: number; start: number; startDeg: number; swing: number; wobble: number; cf: number; capSettled: number;
    burst: { x: number; y: number; R: number }; smiley: { x: number; y: number; r: number }; spark1: { x: number; y: number; r: number }; spark2: { x: number; y: number; r: number };
  };
  let hero: HeroPlan | null = null;
  if (hasHero) {
    const word = words[heroAt]!;
    const alone = words.length === 1;
    const base = (alone ? HERO_ALONE : HERO) * u;
    const tail = tailRows.length > 0;
    // Room for the capsule: the safe width less what the burst and the stickers take beyond its ends.
    const room = (size: number) => {
      const h = 1.66 * size;
      const overhang = 0.62 * h + (tail ? 0.55 * h : 0);
      return Math.min(CAP_MAX * u, safeW - 2 * 6 * u - overhang) - 1.2 * size;
    };
    let size = base;
    for (let i = 0; i < 3; i++) size = Math.min(base, (base * room(size)) / Math.max(1, measure(word.text, base).advance));
    let texts = [word.text];
    if (size < base * HERO_FLOOR) {
      const fitted = fitWord(word.text, base, base * HERO_FLOOR, room(base * HERO_FLOOR));
      texts = fitted.texts;
      size = fitted.size;
    }
    const lines = texts.map((text) => {
      const m = measure(text, size);
      return { text, width: m.advance, inkTop: Math.min(m.inkTop, -0.68 * size), inkBottom: Math.max(m.inkBottom, 0) };
    });
    const lineH = 1.08 * size;
    const band = lines.reduce((sum, line, i) => sum + (i ? lineH : line.inkBottom - line.inkTop), 0);
    const h = Math.max(1.66 * size + (lines.length - 1) * lineH, band + 0.7 * size);
    const r = Math.min(h / 2, 0.83 * size);
    const W = Math.max(1.3 * h, Math.max(...lines.map((line) => line.width)) + 1.2 * size);
    const rim = Math.max(2, 0.065 * size);
    const k = clamp(h / (166 * u), 0.7, 1.2) * u;
    const settle = -(4.5 + 3 * hash(index, word.text));
    const s = word.startMs;
    const cf = Math.max(windowFrom, s - LEAD);
    const capSettled = Math.min(cf + FADE_MS, Math.max(cf, exportFrameAtOrBefore(word.endMs - 1, fps)));
    // With words after it, the swing is past level before the next word paints, so that word can sit close under the capsule.
    const tailFrom = tail ? Math.min(...tailRows.flat().map((cell) => timing(cell.word, WORD_LEAD).from)) : Infinity;
    const swing = clamp(tailFrom - (s - LEAD), 140, SWING_MS);
    const wobble = clamp(to - (s - LEAD + swing), 120, WOBBLE_MS);

    // Settled far end; the burst sits behind it, the stickers around the capsule (beside the near end when words follow).
    const [ex, ey] = rotatePoint(W - 2 * r, 0, settle);
    // With words below, the burst is a little smaller and level with the far end, so the next row can sit closer.
    const R = (tail ? 0.78 : 0.86) * h;
    const burst = { x: ex + (tail ? 0.24 : 0.2) * h, y: ey + (tail ? -0.02 : 0.16) * h, R };
    const smiley = tail ? { x: -r - 48 * k, y: 0.1 * h, r: 36 * k } : { x: 0.12 * h, y: h / 2 + 42 * k, r: 36 * k };
    const spark2 = tail ? { x: -r - 70 * k, y: -0.36 * h, r: 17 * k } : { x: 0.12 * h + 66 * k, y: h / 2 + 50 * k, r: 17 * k };
    const spark1 = { x: burst.x + R + 8 * u, y: burst.y - 0.2 * R - 0.16 * h, r: 27 * k };

    // Boxes in the hinge frame (LTR), padded for the rim, the shadow and the pops' overshoot.
    const capsuleAt = (deg: number): Box => {
      // The box of the rotated rectangle's corners: what every bounds check (renderers, emoji obstacles, reviews) sees.
      const corners = [[-r, -h / 2], [W - r, -h / 2], [-r, h / 2], [W - r, h / 2]].map(([x, y]) => rotatePoint(x!, y!, deg));
      const box = grow(union(corners.map(([x, y]) => ({ x1: x, y1: y, x2: x, y2: y }))), rim / 2);
      return { ...box, y2: box.y2 + 7 * k };
    };
    // Stickers are round: a row clears the chord a sticker reaches under its width, not the sticker's square box.
    // Radii include each pop's overshoot (the spring peaks at 1.12x, the sparkles' back-ease at 1.18x).
    const circles = [{ ...burst, r: R * 1.12 }, { ...smiley, r: smiley.r * 1.12 }, { ...spark1, r: spark1.r * 1.2 }, { ...spark2, r: spark2.r * 1.2 }];
    const stickers = circles.map((circle) => around(circle.x, circle.y, circle.r));
    // The capsule at rest, at the overshoot, and at every angle of the sweep the rows above must clear (its box is highest
    // near 45 degrees for a short capsule, at the overshoot for a long one).
    const sweep = Array.from({ length: 19 }, (_, i) => capsuleAt(PEAK + ((START - PEAK) * i) / 18));
    const parts = [capsuleAt(settle), union([capsuleAt(PEAK), ...sweep.filter((box) => box.y1 < 0)]), ...stickers];
    const settledGroup = union(parts);
    /** How far above (-1) or below (+1) its centre a sticker reaches inside the canvas x range [x1, x2]; null when it is clear. */
    const chord = (circle: { x: number; y: number; r: number }, x1: number, x2: number, dir: number) => {
      const x = hingeX + side * circle.x;
      const dx = Math.max(0, x1 - x, x - x2);
      return dx >= circle.r ? null : circle.y + dir * Math.sqrt(circle.r ** 2 - dx ** 2);
    };

    // Centre the capsule a little right of the column centre (its burst hangs off the far end), clamped with its stickers.
    const span = { x1: side > 0 ? settledGroup.x1 : -settledGroup.x2, x2: side > 0 ? settledGroup.x2 : -settledGroup.x1 };
    const centre = cx - side * (W / 2 - r) + side * 0.08 * h;
    hingeX = Math.min(bounds.x2 - 4 * u - span.x2, Math.max(bounds.x1 + 4 * u - span.x1, centre));

    // Rows above clear the highest pose (the overshoot) and the stickers that lie under their width.
    const gap = WORD_GAP * fs;
    const widest = Math.max(0, ...leadRows.map((row) => row.reduce((sum, cell) => sum + cell.width, 0) + gap * (row.length - 1)));
    const reach = { x1: cx - widest / 2 - 0.15 * fs, x2: cx + widest / 2 + 0.15 * fs };
    const reaches = circles.flatMap((circle) => chord(circle, reach.x1, reach.x2, -1) ?? []);
    capsuleTop = Math.min(parts[0]!.y1, parts[1]!.y1, ...reaches);
    const leadHeight = rowsHeight(leadRows);
    const gapAbove = 0.2 * fs;
    hingeY = Math.max(space.y(alone ? HINGE_Y_ALONE : HINGE_Y), bounds.y1 + PAD * u + (leadRows.length ? leadHeight + gapAbove : 0) - capsuleTop);

    // The hang: as steep as the room under the hinge allows (80 degrees in the sample), never shallower than 30.
    const hangRoom = bounds.y2 - 4 * u - hingeY;
    let startDeg = START;
    while (startDeg > START_MIN && capsuleAt(startDeg).y2 > hangRoom) startDeg -= 2;

    hero = { lines, size, W, h, r, rim, k, settle, start: s, startDeg, swing, wobble, cf, capSettled, burst, smiley, spark1, spark2 };
    capsuleGroup = settledGroup;
    capsuleOwn = parts[0]!;

    // Rows below start under the lowest point the capsule reaches once their first word paints.
    // Stickers count only where they lie under the rows' width.
    if (tail) {
      const tailWidest = Math.max(...tailRows.map((row) => row.reduce((sum, cell) => sum + cell.width, 0) + gap * (row.length - 1)));
      const tailReach = { x1: cx - tailWidest / 2 - 0.15 * fs, x2: cx + tailWidest / 2 + 0.15 * fs };
      let low = Math.max(parts[0]!.y2, ...circles.flatMap((circle) => chord(circle, tailReach.x1, tailReach.x2, 1) ?? []));
      for (let t = tailFrom; t < to; t += 8) low = Math.max(low, capsuleAt(swingAngle(hero, t)).y2);
      tailTop = hingeY + low + 0.22 * fs;
    }
  }

  // Place the rows.
  if (hero) {
    const leadHeight = rowsHeight(leadRows);
    placeRows(leadRows, hingeY + capsuleTop - 0.2 * fs - leadHeight);
    placeRows(tailRows, tailTop);
  } else {
    const height = rowsHeight(leadRows);
    placeRows(leadRows, Math.min(bounds.y2 - PAD * u - height, Math.max(bounds.y1 + PAD * u, space.y(1290) - height / 2)));
  }
  const textRows = [...leadRows, ...tailRows];
  const cells = textRows.flat();
  for (const cell of cells) obstacles.push(cellBox(cell));

  // A single row of several words drifts to stay centred on the words spoken so far; a word never passes the row's end.
  const single = textRows.length === 1 && cells.length > 1 && cells.every((cell) => cell.part < 0);
  const rowBox = cells.length ? union(cells.map(cellBox)) : null;
  const driftAt = (t: number) => {
    if (!single || !rowBox) return 0;
    const rowW = rowBox.x2 - rowBox.x1;
    const reach = (cell: Cell) => (rtl ? rowBox.x2 - (cell.x - cell.width / 2) : cell.x + cell.width / 2 - rowBox.x1);
    let ext = reach(cells.reduce((a, b) => (a.word < b.word ? a : b)));
    let shown = 0;
    for (const cell of [...cells].sort((a, b) => a.word - b.word)) {
      const { from } = timing(cell.word, WORD_LEAD);
      ext = lerp(ext, reach(cell), EASES.outExpo(prog(t, from, RISE_MS)));
      if (t >= from) shown = Math.max(shown, reach(cell));
    }
    return side * Math.max(0, Math.min((rowW - ext) / 2, rowW - shown));
  };

  // ---- Plain words: rise and fade in, navy with a white keyline. ----
  for (const cell of cells) {
    const { from, settled } = timing(cell.word, WORD_LEAD);
    const edges = [from, from + RISE_MS, ...cells.map((other) => timing(other.word, WORD_LEAD).from + RISE_MS)];
    const sampled = (fn: (t: number) => number) => sampleFrames(fn, edges, 0.15, { range: [from, exit ? exitAt : to], simplify: true }) as Key[];
    const x = single ? sampled((t) => cell.x + driftAt(t)) : [[from, cell.x]] as Key[];
    const y = exitFrames(sampled((t) => cell.baseline + RISE * u * (1 - EASES.outExpo(prog(t, from, RISE_MS)))), cell.baseline, cell.baseline - EXIT_RISE * u);
    if (exit) x.push([to, x.at(-1)![1]]);
    const face: TextPiece = {
      id: `${ctx.id}:w${cell.word}${cell.part >= 0 ? `l${cell.part}` : ""}`, kind: "text", z: 6, fromMs: from, toMs: to,
      text: cell.text, face: FACE, sizePx: cell.size, letterSpacingEm: SPACING, fill: ink, anchor: "baseline-center", language: cue.language,
      stroke: { widthPx: KEYLINE * cell.size, colour: WHITE },
      track: { x, y, o: fade(from, settled) },
    };
    pieces.push(face);
  }

  // ---- The capsule, its word, the burst, the smiley and the sparkles. ----
  if (hero) {
    const hp = hero;
    const { W, h, r, rim, k, size, cf } = hp;
    const looks = [
      { cap: ink, burst: coral },
      { cap: ink, burst: yellow },
      { cap: coral, burst: yellow },
      { cap: ink, burst: coral },
    ];
    const look = looks[heroOrdinal % looks.length]!;
    const angle = (t: number) => side * swingAngle(hp, t);
    const stop = exit ? exitAt : to;
    const rz = sampleFrames(angle, [cf, hp.start - LEAD + hp.swing, hp.start - LEAD + hp.swing + hp.wobble], 0.15, { range: [cf, stop], simplify: true }) as Key[];
    if (exit) rz.push([to, rz.at(-1)![1]]);
    const o = fade(cf, hp.capSettled);
    const track: Track = { x: [[cf, hingeX]], y: [[cf, hingeY]], rz, o };
    const mirror = (x: number) => side * x;
    const left = side > 0 ? -r : -(W - r);
    pieces.push(shape(`w${heroAt}cap`, cf, roundedRectPath(left, -h / 2, W, h, r), track, look.cap, 4, {
      stroke: { widthPx: rim, colour: WHITE }, shadows: [{ dx: 0, dy: 7 * k, blur: 0, colour: NAVY, alpha: 0.28 }],
    }));
    // The word rides the capsule on the same pivot: its anchor sits at the capsule's middle, lines centred on their band.
    const lineH = 1.08 * size;
    const bands = hp.lines.map((line, i) => (i === 0 ? line.inkBottom - line.inkTop : lineH));
    const total = bands.reduce((sum, b) => sum + b, 0);
    let y = -total / 2;
    for (const [i, line] of hp.lines.entries()) {
      const baseline = i === 0 ? y - line.inkTop : y + lineH;
      y = baseline;
      const label: TextPiece = {
        id: `${ctx.id}:w${heroAt}${hp.lines.length > 1 ? `l${i}` : ""}`, kind: "text", z: 7, fromMs: cf, toMs: to,
        text: line.text, face: FACE, sizePx: size, letterSpacingEm: SPACING, fill: WHITE, anchor: "baseline-center", language: cue.language,
        origin: { dx: -mirror(W / 2 - r), dy: -baseline }, track,
      };
      pieces.push(label);
    }

    // Stickers, settled positions in canvas px.
    const at = (p: { x: number; y: number }) => ({ x: hingeX + mirror(p.x), y: hingeY + p.y });
    const s = hp.start;
    const b0 = beat(s + 10, 380);
    if (b0.ok) {
      const p = at(hp.burst);
      pieces.push(shape(`w${heroAt}burst`, b0.start, burstPath(hp.burst.R), popTrack(b0, p.x, p.y, 0.15, -26, 0, EASES.spring), look.burst, 2));
      obstacles.push(around(p.x, p.y, hp.burst.R));
    }
    const b1 = beat(s + 140, 340);
    if (b1.ok) {
      const p = at(hp.smiley);
      const sr = hp.smiley.r;
      const pop = popTrack(b1, p.x, p.y, 0.2, -21, -9, EASES.spring);
      pieces.push(
        shape(`w${heroAt}smile`, b1.start, ellipsePath(0, 0, sr * (26 / 30)), pop, yellow, 8, { stroke: { widthPx: sr * (8 / 30), colour: WHITE } }),
        shape(`w${heroAt}eyes`, b1.start, [...ellipsePath(-sr * 0.3, -sr * 0.17, sr * 0.12), ...ellipsePath(sr * 0.3, -sr * 0.17, sr * 0.12)], pop, ink, 9),
        shape(`w${heroAt}mouth`, b1.start, [["M", -sr * 0.37, sr * 0.2], ["C", -sr * 0.2, sr * 0.55, sr * 0.2, sr * 0.55, sr * 0.37, sr * 0.2]], pop, null, 9,
          { stroke: { widthPx: sr * (4 / 30), colour: ink } }),
      );
      obstacles.push(around(p.x, p.y, sr));
    }
    for (const [n, spark] of [hp.spark1, hp.spark2].entries()) {
      const b = beat(s + 60 + n * 170, 360);
      if (!b.ok) continue;
      const p = at(spark);
      pieces.push(shape(`w${heroAt}spark${n}`, b.start, curvedSparkle(spark.r), popTrack(b, p.x, p.y, 0.1, -50, 0, outBack), ink, 8));
      obstacles.push(around(p.x, p.y, spark.r));
    }
    if (capsuleGroup) {
      // The capsule's settled pose and overshoot, in canvas px (mirrored for RTL).
      const g = capsuleGroup;
      obstacles.push({ x1: hingeX + Math.min(mirror(g.x1), mirror(g.x2)), x2: hingeX + Math.max(mirror(g.x1), mirror(g.x2)), y1: hingeY + g.y1, y2: hingeY + g.y2 });
    }
  } else if (rowBox) {
    // A cue without a key word: one small coral sparkle at the top reading-end corner of its first row (the sample's), else
    // the first free corner around the text; never on a word.
    const first = union(textRows[0]!.map(cellBox));
    const last = union(textRows.at(-1)!.map(cellBox));
    const sr = 0.22 * fs;
    const end = (box: Box, by: number) => (rtl ? box.x1 - by : box.x2 + by);
    const start = (box: Box, by: number) => (rtl ? box.x2 + by : box.x1 - by);
    const spots = [
      { x: end(first, 1.5 * sr), y: first.y1 + 0.1 * sr },
      { x: end(first, -1.6 * sr), y: first.y1 - 1.3 * sr },
      { x: start(first, -1.6 * sr), y: first.y1 - 1.3 * sr },
      { x: end(last, -1.6 * sr), y: last.y2 + 1.3 * sr },
    ];
    const room: Box = { x1: bounds.x1 + 4 * u, y1: bounds.y1 + 4 * u, x2: bounds.x2 - 4 * u, y2: bounds.y2 - 4 * u };
    const spot = spots.find((p) => inside(around(p.x, p.y, 1.2 * sr), room) && !obstacles.some((other) => meets(grow(around(p.x, p.y, 1.2 * sr), 4 * u), other)));
    const b = beat(words[Math.min(1, words.length - 1)]!.startMs, 380);
    if (spot && b.ok) {
      pieces.push(shape("spark", b.start, curvedSparkle(sr), popTrack(b, spot.x, spot.y, 0.1, -60, 0, outBack), coral, 8));
      obstacles.push(around(spot.x, spot.y, sr));
    }
  }

  // ---- Extra beats: speed dashes at the first row's reading end, a navy blob at a free corner. ----
  const room: Box = { x1: bounds.x1 + 4 * u, y1: bounds.y1 + 4 * u, x2: bounds.x2 - 4 * u, y2: bounds.y2 - 4 * u };
  const clear = (box: Box) => inside(box, room) && !obstacles.some((other) => meets(grow(box, 6 * u), other));
  const anchorRow = leadRows[0] ?? tailRows[0];
  {
    const ref = anchorRow ? Math.max(...anchorRow.map((cell) => cell.size)) : (hero?.size ?? fs);
    const L = 0.62 * ref;
    const t = 0.075 * ref;
    const lengths = [0.75, 1, 0.55];
    const spots: { x: number; y: number; dir: number }[] = [];
    if (anchorRow) {
      const box = union(anchorRow.map(cellBox));
      const mid = (box.y1 + box.y2) / 2;
      spots.push({ x: rtl ? box.x1 - 0.2 * ref : box.x2 + 0.2 * ref, y: mid, dir: side }, { x: rtl ? box.x2 + 0.2 * ref : box.x1 - 0.2 * ref, y: mid, dir: -side });
    } else if (hero) {
      spots.push({ x: hingeX - side * (hero.r + hero.rim + 0.25 * ref), y: hingeY - 0.2 * hero.h, dir: -side });
    }
    const spot = spots.find((p) => clear({ x1: Math.min(p.x, p.x + p.dir * L), x2: Math.max(p.x, p.x + p.dir * L), y1: p.y - 0.25 * ref, y2: p.y + 0.25 * ref }));
    // They draw out when the row is whole (its last word paints, the drift has ended), so they sit right at its end.
    const whole = anchorRow ? Math.max(...anchorRow.map((cell) => timing(cell.word, WORD_LEAD).from)) : (hero?.cf ?? windowFrom);
    const b = beat(whole, 200);
    if (spot && b.ok) {
      const path = lengths.flatMap((len, i) => {
        const w = len * L;
        const x = spot.dir > 0 ? 0 : -w;
        return roundedRectPath(x, (i - 1) * 0.19 * ref - t / 2, w, t, t / 2);
      });
      const sx = b.still ? [[b.start, 1]] as Key[] : [[b.start, 0.05], [b.end, 1, "out"]] as Key[];
      pieces.push(shape("dash", b.start, path, { x: [[b.start, spot.x]], y: [[b.start, spot.y]], sx, o: exitFrames([[b.start, 1]], 1, 0) }, ink, 2));
      obstacles.push({ x1: Math.min(spot.x, spot.x + spot.dir * L), x2: Math.max(spot.x, spot.x + spot.dir * L), y1: spot.y - 0.25 * ref, y2: spot.y + 0.25 * ref });
    }
  }
  {
    const block = union(obstacles.length ? obstacles : [{ x1: cx, x2: cx, y1: space.y(1290), y2: space.y(1290) }]);
    const ref = fs;
    const rx = 0.3 * ref;
    const ry = 0.15 * ref;
    const tilt = (index % 2 ? 1 : -1) * (24 + 10 * hash(index, "blob"));
    // Beside real ink: the first row's top corners, the last row's (or the capsule's) bottom corners, in reading order.
    const firstBox = textRows.length ? union(textRows[0]!.map(cellBox)) : block;
    const own = capsuleOwn as Box | null;
    const capsuleCanvas = own ? { x1: hingeX + Math.min(side * own.x1, side * own.x2), x2: hingeX + Math.max(side * own.x1, side * own.x2), y1: hingeY + own.y1, y2: hingeY + own.y2 } : null;
    const lastBox = tailRows.length ? union(tailRows.at(-1)!.map(cellBox)) : (capsuleCanvas ?? firstBox);
    const startX = (box: Box, by: number) => (rtl ? box.x2 + by : box.x1 - by);
    const endX = (box: Box, by: number) => (rtl ? box.x1 - by : box.x2 + by);
    // The tilted ellipse's box over its pop (it turns 40 degrees into its tilt), with the pop's overshoot.
    const turns = Array.from({ length: 9 }, (_, i) => ((tilt + (40 * i) / 8) * Math.PI) / 180);
    // (The box of the rotated bounding rectangle, as the renderers' bounds see a turned path.)
    const hw = 1.18 * Math.max(...turns.map((a) => rx * Math.abs(Math.cos(a)) + ry * Math.abs(Math.sin(a))));
    const hh = 1.18 * Math.max(...turns.map((a) => rx * Math.abs(Math.sin(a)) + ry * Math.abs(Math.cos(a))));
    const gap = 8 * u;
    const corners = [
      { x: startX(firstBox, hw + gap), y: firstBox.y1 + 0.2 * hh },
      { x: endX(lastBox, hw + gap), y: lastBox.y2 - 0.2 * hh },
      { x: endX(firstBox, hw + gap), y: firstBox.y1 + 0.2 * hh },
      { x: startX(lastBox, hw + gap), y: lastBox.y2 - 0.2 * hh },
      { x: startX(firstBox, -1.5 * hw), y: firstBox.y1 - hh - gap },
      { x: endX(lastBox, -1.5 * hw), y: lastBox.y2 + hh + gap },
    ];
    const order = [0, 1, 2, 3].map((i) => (i + (hasHero ? heroOrdinal : plainOrdinal + 2)) % 4);
    const spot = [...order, 4, 5].map((i) => corners[i]!).find((p) => clear(around(p.x, p.y, hw, hh)));
    const b = beat(words.at(-1)!.startMs, 300);
    if (spot && b.ok) {
      pieces.push(shape("blob", b.start, ellipsePath(0, 0, rx, ry), popTrack(b, spot.x, spot.y, 0.1, 40, tilt, outBack), ink, 2));
    }
  }
  return pieces;
}, undefined, LEAD);

/** The swing in the capsule's own frame (LTR degrees): hang to past level, fast off the hang, then a damped settle. */
function swingAngle(hp: { start: number; startDeg: number; settle: number; swing: number; wobble: number }, t: number): number {
  const q1 = prog(t, hp.start - LEAD, hp.swing);
  if (q1 < 1) return lerp(hp.startDeg, PEAK, q1 * (2 - q1));
  const q2 = prog(t, hp.start - LEAD + hp.swing, hp.wobble);
  return hp.settle + (PEAK - hp.settle) * Math.exp(-5 * q2) * Math.cos(8 * q2) * (1 - q2 ** 4);
}

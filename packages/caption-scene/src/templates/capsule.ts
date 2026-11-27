import { CAPTION_SCENE_BRAND_MIN_CONTRAST, captionColourContrast, captionSceneMeta } from "@narriflow/validators";
import type { DemoScript } from "../demo";
import { clamp, EASES, type Ease, lerp, prog } from "../ease";
import { exportFrameAtOrAfter, paintedFrameCount } from "../frame-grid";
import { sampleFrames } from "../frames";
import { balancedRows, rowVisualOrder } from "../layout";
import type { Box, PathCmd, Piece, ShapePiece, TextPiece, Track } from "../scene";
import { ellipsePath, polygonPath, roundedRectPath } from "../shapes";
import { galleryScene, rotatePoint } from "./gallery-layout";

/**
 * Capsule (`samples/templates/m83-capsule.js`, after Motion Array "Creative And Trendy Typography"): clean heavy navy
 * words that rise a few px and fade in as they are spoken. The key word is the signature: a solid navy (or coral) capsule
 * with a white rim carries it in white, hangs down from its near end, swings up past level like a gate, overshoots and
 * settles tilted 4-8 degrees (3 degrees of overshoot, so the row above can sit close), while a spiky starburst pops
 * behind its far end and a smiley sticker and two small sparkles arrive beside it. A cue without a key word gets one small coral sparkle. One cue on screen at a time.
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
 * - **The sweep never crosses a word, and the rows stay close.** A row above sits just over the capsule's real outline (the
 *   pill and its rim, not the box of the turned rectangle) at every angle of the sweep, and over the burst's and sparkles'
 *   tips, counting only what lies under the row's own letters, with a small gap that stays open through the whole swing.
 *   Rows below start under the lowest point the outline still reaches from the moment their first word paints. The hang
 *   starts at 80 degrees when there is room under the hinge and shallower (down to 16) when there is not, so the swing stays
 *   inside the band without shrinking the caption. The sample capped the capsule at 420 px and shrank long words to fit it.
 * - **Long words.** A word wider than the column shrinks to a floor (62% of its size), then a Latin, Cyrillic, Greek or CJK
 *   word breaks into the fewest rows of even measured width, at most eight (past that, eight even rows at whatever size
 *   fits: the text is never dropped). A key word that cannot hold 70% of its size on one line gets a two-line capsule with a
 *   shallower swing and stickers sized for one line; one that would need three or more lines has no readable capsule and
 *   is written in coral on plain rows. A Devanagari or Arabic word never breaks, it shrinks. The capsule's room is the
 *   safe width less what its burst and stickers take beyond its ends, so the fit never has to shrink a key word below
 *   its floor (CONTEMPORANEOUSNESS stays at 70% at 9:16 and 1:1).
 * - **A guard for dark footage.** The sample is navy on a bright frame with a soft white glow. The words keep a thin white
 *   keyline (5% of the size) instead of the blurred glow: the same read on bright footage, and navy stays readable on a
 *   dark clip, at no per-frame blur cost.
 * - **No cue-indexed tables.** The capsule/burst colours cycle the sample's four looks by a hero-cue counter, the settled
 *   tilt is 4-8 degrees from a seeded hash, and the extra beats' corners cycle by cue.
 * - **RTL mirrors.** The capsule hinges on its right end and swings the other way, rows run right to left, the stickers go
 *   to the mirrored side.
 * - **Handoff.** One cue on screen at a time: the outgoing cue stays whole until the frame the next cue paints (the
 *   sample's one-frame swap), so a one-word cue never leaves an empty frame. Only before a real pause (the last cue, or
 *   nothing for 250 ms) does the whole cue, capsule and stickers included, fade and rise 14 px (the sample's exit).
 * - **Opaque on the spoken frame.** A plain word rises a few px and fades in only within its 60 ms lead and is opaque and in
 *   its slot on its spoken frame; with no lead left it appears whole and still. The capsule and its word are opaque from
 *   their first frame (the swing carries the entrance; a fade put white text on a half-transparent plate below 3:1).
 *   A key word that paints on a single frame (70 ms words at 25 fps) shows its capsule settled and still on that frame.
 *   Stickers that would not get their full pop compress, and below four painted frames they show a compact static pose.
 * - **Rows never slide.** The sample's single-row drift (re-centring on the words spoken so far) is gone: each word sampled
 *   it from its own start, so two neighbours could touch for a frame ("wewill"). A word never moves sideways once it paints.
 * - **Speaker lanes.** With two people talking at once every text size is capped at 24% of the lane's height and the key
 *   word swings from 40 degrees with its stickers beside the capsule, so the plain lane never dwarfs the key-word lane.
 *
 * Extra recurring beats on every cue: three navy speed dashes (the reference's "Creat ≡" lines) that draw out from the
 * reading end of the first row once its last word paints, and a small tilted navy blob (the reference's floating ovals) that pops
 * in at a free corner of the caption on the last word.
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
/** A wrapped key word, or one in a speaker lane, swings from a shallower hang and may start as low as this when the band is short. */
const START_COMPACT = 40;
const START_FLOOR = 16;
/** Rows a token too long for any readable layout may take; past it the rows share the text evenly at whatever size fits. */
const MAX_PARTS = 8;
/** In a speaker lane every text size is capped at this share of the lane's height, so a plain lane cannot dwarf a key-word lane. */
const LANE_TEXT = 0.24;
/** The overshoot past the settled tilt, degrees (the sample's -12 against its -6). */
const OVERSHOOT = 3;
const SWING_MS = 240;
const WOBBLE_MS = 420;
const LEAD = 80;
const WORD_LEAD = 60;
const RISE = 16;
/** A cue fades out only when the next cue starts at least this long after it clears (a real pause); otherwise it swaps on a frame. */
const PAUSE_MS = 250;
const EXIT_RISE = 14;
const START_ALPHA = 0.75;
const LATER_ALPHA = 0.35;

const NAVY = "#16286E";
const WHITE = "#FFFFFF";

type Key = [number, number, Ease?];

/** Words that can break between characters when one is wider than the column. */
const SPLITTABLE = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{N}\p{P}\p{M}]+$/u;
const graphemes = (text: string) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((part) => part.segment);
/** `count` chunks of about the same number of graphemes: the bounded wrap of a token too long for any readable layout. */
const evenChunks = (text: string, count: number): string[] => {
  const letters = graphemes(text);
  const n = Math.min(count, letters.length);
  return Array.from({ length: n }, (_, i) => letters.slice(Math.round((i * letters.length) / n), Math.round(((i + 1) * letters.length) / n)).join(""));
};

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
/** The burst pops with a gentle back-ease: it peaks at about 1.06x, and the rows reserve 1.07x. */
const BURST_BACK = 1.3;
const BURST_PEAK = 1.07;

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
  // NFC and NFD spell the same layout: a decomposed accent never changes breakability, sizes or rows.
  const texts = words.map((word) => word.text.normalize("NFC"));
  const measure = (text: string, size: number) => ctx.input.measure(text, FACE, size, SPACING);

  // Colours as received: text and capsule keep 3:1 against the white keyline / white word they carry, else the style's own.
  const defaults = captionSceneMeta("capsule").colours;
  const c = ctx.input.colours;
  const keep = (colour: string, against: string, fallback: string) => (captionColourContrast(colour, against) >= CAPTION_SCENE_BRAND_MIN_CONTRAST ? colour : fallback);
  const ink = keep(c.primary, WHITE, defaults.primary);
  const coral = keep(c.highlight, WHITE, defaults.highlight);
  const yellow = keep(c.accent, ink, defaults.accent);

  const safeW = bounds.x2 - bounds.x1;
  const column = Math.min(COLUMN * u, safeW - 2 * PAD * u);
  const cx = Math.min(bounds.x2 - PAD * u, Math.max(bounds.x1 + PAD * u, space.x(540)));
  // A speaker lane (two people talking at once) caps every text size at a share of its height, and the capsule swings and
  // keeps its stickers compactly, so neither lane pays far more size than the other.
  const laneH = bounds.y2 - bounds.y1;
  const inLane = laneH < 0.88 * (space.safe.y2 - space.safe.y1) || laneH < 0.88 * ((1 - 2 * 0.05) * ctx.input.canvas.height);
  const capSize = (size: number) => (inLane ? Math.min(size, LANE_TEXT * laneH) : size);

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
    if (count > MAX_PARTS) return split(room);
    let lo = 0;
    let hi = room;
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      if (split(mid).length <= count) hi = mid;
      else lo = mid;
    }
    return split(hi);
  };
  /** A word at `base`, shrunk to fit `room` down to `floor`, broken below that when its script allows (into at most `MAX_PARTS` rows). */
  const fitWord = (text: string, base: number, floor: number, room: number): { texts: string[]; size: number } => {
    const natural = measure(text, base).advance;
    if (natural <= room) return { texts: [text], size: base };
    const fitted = (base * room) / natural;
    if (fitted >= floor || !SPLITTABLE.test(text)) return { texts: [text], size: fitted };
    const readable = chunks(text, floor, room * 0.98);
    const bounded = readable.length > MAX_PARTS;
    const parts = bounded ? evenChunks(text, MAX_PARTS) : readable;
    const widest = Math.max(...parts.map((part) => measure(part, 100).advance));
    const fits = (room * 0.98 * 100) / widest;
    return { texts: parts, size: bounded ? Math.min(base, fits) : clamp(fits, floor, base) };
  };

  // ---- The key word: one line in the capsule, two lines when one cannot hold its floor, else it is written in coral on
  // plain rows (a key word that long has no readable capsule). The capsule's room is the safe width less its stickers. ----
  const candidate = words.findIndex((word) => word.role === "hero");
  const alone = words.length === 1;
  const besideNear = inLane || (candidate >= 0 && candidate < words.length - 1);
  // Beyond the far end: the burst and the far sparkle (about 0.8 of a line's capsule height); beyond the near end, when the
  // stickers sit there: the smiley and the small sparkle (about 0.56).
  const overhang = (size: number) => (0.8 + (besideNear ? 0.56 : 0)) * 1.66 * size;
  const capsuleRoom = (size: number, capped: boolean) => (capped ? Math.min(CAP_MAX * u, safeW - 12 * u - overhang(size)) : safeW - 12 * u - overhang(size)) - 1.2 * size;
  const heroText = (): { texts: string[]; size: number; wrapped: boolean } | null => {
    const text = texts[candidate]!;
    const base = capSize((alone ? HERO_ALONE : HERO) * u);
    const floor = base * HERO_FLOOR;
    const per = (line: string) => measure(line, 100).advance / 100;
    /** The largest size up to `base` at which the widest line fits its room. */
    const largest = (widest: number, capped: boolean) => {
      let size = base;
      for (let i = 0; i < 5; i++) size = Math.min(base, (capsuleRoom(size, capped) * 0.98) / widest);
      return size;
    };
    const single = largest(per(text), true);
    if (single >= floor || !SPLITTABLE.test(text)) return { texts: [text], size: single, wrapped: false };
    const lines = chunks(text, floor, capsuleRoom(floor, false) * 0.98);
    if (lines.length > 2) return null;
    return { texts: lines, size: Math.max(floor, largest(Math.max(...lines.map(per)), false)), wrapped: true };
  };
  const heroPlan = candidate >= 0 ? heroText() : null;
  const heroAt = heroPlan ? candidate : -1;
  const demoted = candidate >= 0 && !heroPlan ? candidate : -1;
  const hasHero = heroAt >= 0;
  const heroOrdinal = ctx.input.cues.slice(0, index).filter((other) => other.words.some((word) => word.role === "hero")).length;
  const plainOrdinal = index - heroOrdinal;
  const textWords = words.flatMap((_, at) => (at === heroAt ? [] : [at]));
  const fs = capSize((hasHero ? BODY : textWords.length <= 2 ? FEW : SOLO) * u);

  // Rows of plain words: a run of words wraps into balanced rows, a broken word takes rows of its own.
  const makeRows = (list: readonly number[]): Cell[][] => {
    const groups: Cell[][] = [];
    let run: Cell[] = [];
    for (const at of list) {
      const fitted = fitWord(texts[at]!, fs, fs * FLOOR, column);
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
  const rowWidthOf = (row: readonly Cell[]) => row.reduce((sum, cell) => sum + cell.width, 0) + WORD_GAP * fs * (row.length - 1);
  /** Lays rows out from `top` down, centred on `cx` (in reading order for RTL). */
  const placeRows = (rows: readonly Cell[][], top: number) => {
    let y = top;
    for (const [r, row] of rows.entries()) {
      if (r > 0) y += ROW_GAP * fs;
      y += above(row);
      const width = rowWidthOf(row);
      let x = Math.min(bounds.x2 - PAD * u - width / 2, Math.max(bounds.x1 + PAD * u + width / 2, cx)) - width / 2;
      for (const i of rowVisualOrder(row.map((cell) => cell.text), rtl ? "rtl" : "ltr")) {
        const cell = row[i]!;
        cell.x = x + cell.width / 2;
        cell.baseline = y;
        x += cell.width + WORD_GAP * fs;
      }
      y += below(row);
    }
  };
  const rowsHeight = (rows: readonly Cell[][]) => rows.reduce((sum, row, r) => sum + above(row) + below(row) + (r > 0 ? ROW_GAP * fs : 0), 0);
  const leadRows = makeRows(textWords.filter((at) => !hasHero || at < heroAt));
  const tailRows = hasHero ? makeRows(textWords.filter((at) => at > heroAt)) : [];
  const cellBox = (cell: Cell): Box => ({
    x1: cell.x - cell.width / 2 - KEYLINE * cell.size, x2: cell.x + cell.width / 2 + KEYLINE * cell.size,
    y1: cell.baseline + cell.inkTop - KEYLINE * cell.size, y2: cell.baseline + cell.inkBottom + KEYLINE * cell.size,
  });
  /** The rows' horizontal reach, centred as `placeRows` centres them, with a little air. */
  const reachOf = (rows: readonly Cell[][]) => {
    const widest = Math.max(0, ...rows.map(rowWidthOf));
    const centre = Math.min(bounds.x2 - PAD * u - widest / 2, Math.max(bounds.x1 + PAD * u + widest / 2, cx));
    return { x1: centre - widest / 2 - 0.12 * fs, x2: centre + widest / 2 + 0.12 * fs };
  };

  // Timing: a word paints up to 60 ms early (never before its window) and is opaque and in its slot on its spoken frame; with
  // no lead left it appears whole and still.
  const timing = (at: number) => {
    const word = words[at]!;
    const from = Math.max(windowFrom, word.startMs - WORD_LEAD);
    const onset = Math.max(from, exportFrameAtOrAfter(word.startMs, fps));
    return { from, onset, moves: paintedFrameCount(from, onset, fps) >= 1 };
  };
  const capsuleFrom = hasHero ? Math.max(windowFrom, words[heroAt]!.startMs - LEAD) : Infinity;
  const firstPaint = Math.min(capsuleFrom, ...textWords.map((at) => timing(at).from));
  const startAlpha = (from: number) => (from <= firstPaint + 1 ? START_ALPHA : LATER_ALPHA);
  // One cue on screen at a time: it swaps on the frame the next cue paints, and fades (and rises) only before a real pause.
  const nextStart = Math.min(Infinity, ...ctx.input.cues.slice(index + 1).flatMap((other) => (other.words.length ? [other.words[0]!.startMs] : [])));
  const fadeOut = exit && nextStart - to >= PAUSE_MS;
  const stop = fadeOut ? exitAt : to;
  const exitFrames = (frames: Key[], rest: number, end: number) => {
    if (fadeOut) frames.push([exitAt, rest], [to, end, "in"]);
    return frames;
  };
  const exitY = (from: number, y: number): Key[] => exitFrames([[from, y]], y, y - EXIT_RISE * u);

  const pieces: Piece[] = [];
  const obstacles: Box[] = [];
  /** A sticker's pop: compressed into the frames left before the cue goes, a compact still pose below four painted frames. */
  const beat = (wanted: number, duration: number) => {
    const start = Math.max(windowFrom, Math.min(wanted, stop - 3 * (1000 / fps)));
    const end = Math.min(stop, start + duration);
    const frames = paintedFrameCount(start, end, fps);
    return { start, end, span: Math.max(1, end - start), still: frames < 4, ok: frames >= 2 || paintedFrameCount(start, to, fps) >= 2 };
  };
  const shape = (suffix: string, from: number, path: readonly PathCmd[], track: Track, fill: string | null, z: number, extra: Partial<ShapePiece> = {}): ShapePiece => ({
    id: `${ctx.id}:${suffix}`, kind: "shape", z, fromMs: from, toMs: to, path, ...(fill ? { fill: { colour: fill } } : {}), track, ...extra,
  });
  /** A sticker that pops in at (x, y): scale, a turn that settles, and the cue's exit (fade and rise with the words). */
  const popTrack = (b: ReturnType<typeof beat>, x: number, y: number, s0: number, turn: number, rest: number, overshoot: (p: number) => number): Track => {
    const frames = (fn: (t: number) => number, error: number) => sampleFrames(fn, [b.start, b.end], error, { range: [b.start, b.end], simplify: true }) as Key[];
    const scale = b.still ? [[b.start, 1]] as Key[] : frames((t) => lerp(s0, 1, overshoot(prog(t, b.start, b.span))), 0.004);
    const rz = b.still ? [[b.start, rest]] as Key[] : frames((t) => rest + turn * (1 - EASES.out(prog(t, b.start, b.span))), 0.2);
    const o: Key[] = b.still ? [[b.start, 1]] : [[b.start, 0.6], [b.start + Math.min(50, b.span / 3), 1]];
    return { x: [[b.start, x]], y: exitY(b.start, y), sx: scale, sy: scale, rz: rz.map(([t, v, e]) => [t, v * side, e] as Key), o: exitFrames(o, 1, 0) };
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
    settle: number; start: number; startDeg: number; swing: number; wobble: number; cf: number; oneFrame: boolean;
    burst: { x: number; y: number; R: number }; smiley: { x: number; y: number; r: number }; spark1: { x: number; y: number; r: number }; spark2: { x: number; y: number; r: number };
  };
  let hero: HeroPlan | null = null;
  if (hasHero && heroPlan) {
    const word = words[heroAt]!;
    const { size, wrapped } = heroPlan;
    const tail = tailRows.length > 0;
    const lines = heroPlan.texts.map((text) => {
      const m = measure(text, size);
      return { text, width: m.advance, inkTop: Math.min(m.inkTop, -0.68 * size), inkBottom: Math.max(m.inkBottom, 0) };
    });
    const lineH = 1.08 * size;
    const unitH = 1.66 * size;
    const band = lines.reduce((sum, line, i) => sum + (i ? lineH : line.inkBottom - line.inkTop), 0);
    const h = Math.max(unitH + (lines.length - 1) * lineH, band + 0.7 * size);
    const r = Math.min(h / 2, 0.83 * size);
    const W = Math.max(1.3 * Math.min(h, unitH), Math.max(...lines.map((line) => line.width)) + 1.2 * size);
    const rim = Math.max(2, 0.065 * size);
    // Stickers scale with one line of the capsule, so a two-line key word does not grow a giant burst.
    const k = clamp(unitH / (166 * u), 0.7, 1.2) * u;
    const settle = -(4.5 + 3 * hash(index, texts[heroAt]!));
    const s = word.startMs;
    const cf = capsuleFrom;
    // A key word that paints on a single frame (back-to-back 70 ms words) is drawn whole and still on its capsule.
    const oneFrame = paintedFrameCount(cf, to, fps) < 2;
    // With words after it, the swing is past level before the next word paints, so that word can sit close under the capsule.
    const tailFrom = tail ? Math.min(...tailRows.flat().map((cell) => timing(cell.word).from)) : Infinity;
    const swing = clamp(tailFrom - (s - LEAD), 140, SWING_MS);
    const wobble = clamp(to - (s - LEAD + swing), 120, WOBBLE_MS);

    // Settled far end; the burst sits behind it, the stickers around the capsule (beside the near end when words follow or in
    // a speaker lane, so the block does not grow taller).
    const [ex, ey] = rotatePoint(W - 2 * r, 0, settle);
    const level = besideNear || wrapped;
    // The burst sits low behind the far end (its tip barely above the capsule, so the row above stays close); between rows
    // above and below it is smaller and level with the far end.
    const R = (inLane ? 0.58 : besideNear ? 0.58 : 0.86) * unitH;
    const burst = { x: ex + (level ? 0.24 : 0.2) * unitH, y: ey + (level ? 0 : 0.28) * unitH, R };
    const smiley = besideNear ? { x: -r - 48 * k, y: 0.1 * unitH, r: 36 * k } : { x: 0.12 * unitH, y: h / 2 + 42 * k, r: 36 * k };
    const spark2 = besideNear ? { x: -r - 70 * k, y: -0.36 * unitH, r: 17 * k } : { x: 0.12 * unitH + 66 * k, y: h / 2 + 50 * k, r: 17 * k };
    const spark1 = { x: burst.x + R + 8 * u, y: burst.y - 0.2 * R - 0.16 * unitH, r: 27 * k };

    // Boxes in the hinge frame (LTR) for centring and the decorations' free-spot search (what bounds checks see).
    const capsuleAt = (deg: number): Box => {
      const corners = [[-r, -h / 2], [W - r, -h / 2], [-r, h / 2], [W - r, h / 2]].map(([x, y]) => rotatePoint(x!, y!, deg));
      const box = grow(union(corners.map(([x, y]) => ({ x1: x, y1: y, x2: x, y2: y }))), rim / 2);
      return { ...box, y2: box.y2 + 7 * k };
    };
    // Stickers are round; their radii include each pop's overshoot (the burst's back-ease peaks at 1.07x, the smiley's spring at
    // 1.12x, the sparkles' back-ease at 1.18x).
    const circles = [{ ...burst, r: R * BURST_PEAK }, { ...smiley, r: smiley.r * 1.12 }, { ...spark1, r: spark1.r * 1.2 }, { ...spark2, r: spark2.r * 1.2 }];
    const peak = settle - OVERSHOOT;
    const parts = [capsuleAt(settle), capsuleAt(peak), ...circles.map((circle) => around(circle.x, circle.y, circle.r))];
    const settledGroup = union(parts);

    // Centre the capsule a little right of the column centre (its burst hangs off the far end), clamped with its stickers.
    const span = { x1: side > 0 ? settledGroup.x1 : -settledGroup.x2, x2: side > 0 ? settledGroup.x2 : -settledGroup.x1 };
    const centre = cx - side * (W / 2 - r) + side * 0.08 * h;
    hingeX = Math.min(bounds.x2 - 4 * u - span.x2, Math.max(bounds.x1 + 4 * u - span.x1, centre));

    /** How far above (-1) or below (+1) the hinge a sticker reaches inside the canvas x range; null when it is clear. */
    const chord = (circle: { x: number; y: number; r: number }, x1: number, x2: number, dir: number) => {
      const x = hingeX + side * circle.x;
      const dx = Math.max(0, x1 - x, x - x2);
      return dx >= circle.r ? null : circle.y + dir * Math.sqrt(circle.r ** 2 - dx ** 2);
    };
    /** The capsule's real outline (its inner rectangle grown by the corner radius and rim) at `deg`: how far above (-1) or
     * below (+1, shadow included) the hinge it reaches inside the canvas x range; null when it is clear of that range. */
    const outline = (deg: number, x1: number, x2: number, dir: number) => {
      const e = h / 2 - r;
      const reach = r + rim / 2;
      const samples: [number, number][] = [];
      for (let i = 0; i <= 24; i++) samples.push([((W - 2 * r) * i) / 24, -e], [((W - 2 * r) * i) / 24, e]);
      for (let j = 1; j < 6; j++) samples.push([0, -e + (2 * e * j) / 6], [W - 2 * r, -e + (2 * e * j) / 6]);
      let best: number | null = null;
      for (const [px, py] of samples) {
        const [rx, ry] = rotatePoint(px, py, deg);
        const X = hingeX + side * rx;
        const dx = Math.max(0, x1 - X, X - x2);
        if (dx >= reach) continue;
        const v = ry + dir * Math.sqrt(reach ** 2 - dx ** 2) + (dir > 0 ? 7 * k : 0);
        best = best === null ? v : dir < 0 ? Math.min(best, v) : Math.max(best, v);
      }
      return best;
    };

    // Rows above clear the capsule's real outline at every angle of its sweep and the stickers, under their own width only,
    // with a small gap that stays visible through the whole swing.
    const lead = reachOf(leadRows);
    const sweep = [settle, ...Array.from({ length: 24 }, (_, i) => peak + ((START - peak) * i) / 23)];
    const tops = [...sweep.map((deg) => outline(deg, lead.x1, lead.x2, -1)), ...circles.map((circle) => chord(circle, lead.x1, lead.x2, -1))];
    capsuleTop = Math.min(-r - rim / 2, ...tops.filter((v): v is number => v !== null));
    const leadHeight = rowsHeight(leadRows);
    const gapAbove = 0.1 * fs;
    hingeY = Math.max(space.y(alone ? HINGE_Y_ALONE : HINGE_Y), bounds.y1 + PAD * u + (leadRows.length ? leadHeight + gapAbove : 0) - capsuleTop);

    // The hang: as steep as the room under the hinge allows (80 degrees in the sample, 40 for a wrapped key word or in a
    // speaker lane), as shallow as 16 when the band is short.
    const hangRoom = bounds.y2 - 4 * u - hingeY;
    let startDeg = wrapped || inLane ? START_COMPACT : START;
    while (startDeg > START_FLOOR && capsuleAt(startDeg).y2 > hangRoom) startDeg -= 2;

    hero = { lines, size, W, h, r, rim, k, settle, start: s, startDeg, swing, wobble, cf, oneFrame, burst, smiley, spark1, spark2 };
    capsuleGroup = settledGroup;
    capsuleOwn = parts[0]!;

    // Rows below start under the lowest point the capsule's outline reaches under their width once their first word paints.
    if (tail) {
      const below = reachOf(tailRows);
      let low = Math.max(r + rim / 2, ...circles.flatMap((circle) => chord(circle, below.x1, below.x2, 1) ?? []));
      for (let t = tailFrom; t < to + 8; t += 8) low = Math.max(low, outline(oneFrame ? settle : swingAngle(hero, Math.min(t, to)), below.x1, below.x2, 1) ?? low);
      tailTop = hingeY + low + 0.12 * fs;
    }
  }

  // Place the rows.
  if (hero) {
    placeRows(leadRows, hingeY + capsuleTop - 0.1 * fs - rowsHeight(leadRows));
    placeRows(tailRows, tailTop);
  } else {
    const height = rowsHeight(leadRows);
    placeRows(leadRows, Math.min(bounds.y2 - PAD * u - height, Math.max(bounds.y1 + PAD * u, space.y(1290) - height / 2)));
  }
  const textRows = [...leadRows, ...tailRows];
  const cells = textRows.flat();
  for (const cell of cells) obstacles.push(cellBox(cell));
  const rowBox = cells.length ? union(cells.map(cellBox)) : null;

  // ---- Plain words: navy with a white keyline (a key word too long for a capsule in coral), rising a few px within their
  // lead; opaque and in their slot on the spoken frame; the row never moves once a word is in it. ----
  for (const cell of cells) {
    const { from, onset, moves } = timing(cell.word);
    const y = exitFrames(moves ? [[from, cell.baseline + RISE * u], [onset, cell.baseline, "out"]] : [[from, cell.baseline]], cell.baseline, cell.baseline - EXIT_RISE * u);
    const o = exitFrames(moves ? [[from, startAlpha(from)], [onset, 1, "out"]] : [[from, 1]], 1, 0);
    const face: TextPiece = {
      id: `${ctx.id}:w${cell.word}${cell.part >= 0 ? `l${cell.part}` : ""}`, kind: "text", z: 6, fromMs: from, toMs: to,
      text: cell.text, face: FACE, sizePx: cell.size, letterSpacingEm: SPACING, fill: cell.word === demoted ? coral : ink, anchor: "baseline-center", language: cue.language,
      stroke: { widthPx: KEYLINE * cell.size, colour: WHITE },
      track: { x: [[from, cell.x]], y, o },
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
    const rz = hp.oneFrame
      ? ([[cf, side * hp.settle]] as Key[])
      : (sampleFrames(angle, [cf, hp.start - LEAD + hp.swing, hp.start - LEAD + hp.swing + hp.wobble], 0.15, { range: [cf, stop], simplify: true }) as Key[]);
    if (fadeOut && !hp.oneFrame) rz.push([to, rz.at(-1)![1]]);
    // Plate and word are opaque from their first frame: the swing carries the entrance, and a fade would put white text on a
    // half-transparent plate below 3:1.
    const track: Track = { x: [[cf, hingeX]], y: exitY(cf, hingeY), rz, o: exitFrames([[cf, 1]], 1, 0) };
    const mirror = (x: number) => side * x;
    const left = side > 0 ? -r : -(W - r);
    // A one-frame capsule is named as a part of its word, the one name the shared one-frame filter keeps with the word.
    pieces.push(shape(hp.oneFrame ? `w${heroAt}l80` : `w${heroAt}cap`, cf, roundedRectPath(left, -h / 2, W, h, r), track, look.cap, 4, {
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
      pieces.push(shape(`w${heroAt}burst`, b0.start, burstPath(hp.burst.R), popTrack(b0, p.x, p.y, 0.15, -26, 0, (q) => outBack(q, BURST_BACK)), look.burst, 2));
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
    const whole = anchorRow ? Math.max(...anchorRow.map((cell) => timing(cell.word).from)) : (hero?.cf ?? windowFrom);
    const b = beat(whole, 200);
    if (spot && b.ok) {
      const path = lengths.flatMap((len, i) => {
        const w = len * L;
        const x = spot.dir > 0 ? 0 : -w;
        return roundedRectPath(x, (i - 1) * 0.19 * ref - t / 2, w, t, t / 2);
      });
      const sx = b.still ? [[b.start, 1]] as Key[] : [[b.start, 0.05], [b.end, 1, "out"]] as Key[];
      pieces.push(shape("dash", b.start, path, { x: [[b.start, spot.x]], y: exitY(b.start, spot.y), sx, o: exitFrames([[b.start, 1]], 1, 0) }, ink, 2));
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
}, undefined, WORD_LEAD);

/** The swing in the capsule's own frame (LTR degrees): hang to past level, fast off the hang, then a damped settle. */
function swingAngle(hp: { start: number; startDeg: number; settle: number; swing: number; wobble: number }, t: number): number {
  const q1 = prog(t, hp.start - LEAD, hp.swing);
  const peak = hp.settle - OVERSHOOT;
  if (q1 < 1) return lerp(hp.startDeg, peak, q1 * (2 - q1));
  const q2 = prog(t, hp.start - LEAD + hp.swing, hp.wobble);
  return hp.settle + (peak - hp.settle) * Math.exp(-5 * q2) * Math.cos(8 * q2) * (1 - q2 ** 4);
}

import { toCaptionUpperCase } from "@narriflow/validators";
import type { DemoScript } from "../demo";
import { EASES, type Frames, clamp, kf, lerp, prog } from "../ease";
import { exportFrameAtOrAfter, paintedFrameCount, SCENE_DEFAULT_FPS } from "../frame-grid";
import { sampleFrames } from "../frames";
import type { SceneCue, SceneInput, SceneProgram } from "../input";
import { clampToSafeArea, cueDirection, rowVisualOrder, sceneSpace, type SceneSpace } from "../layout";
import { type Box, type Piece, type ShapePiece, type TextPiece, sceneBoundsAt } from "../scene";
import { ellipsePath, rectPath, roundedRectPath } from "../shapes";

/**
 * Squash (`samples/templates/m24-squash.js`, after Motion Array "Kinetic Typography Intro"): every new line rises out of the
 * floor of a black (or white) plate as a flat strip and stretches to full height in tall condensed Anton. The line it lands
 * under is shoved up and, in the same beat, squashes shut and reopens as a short wide Montserrat Black line, so the stack
 * re-justifies with the newest line always the biggest. Plates alternate black and white from cue to cue.
 *
 * Geometry is the sample's, in its 1080 x 1920 frame (the floor of the newest line is the anchor line, y 1470): Anton caps at 168
 * (250 for a line holding the key word) in a 0.9 line box, words 0.2 em apart and re-centred as each one lands; the wide state is
 * Montserrat Black at up to 78 in a 0.92 box; lines 16 px apart inside a 44 x 34 px plate. A word stretches 0.1 -> 1.07 -> 0.98 -> 1
 * over 440 ms; a pushed line's tall copy snaps shut over 110 ms and its wide copy springs open over 300 ms while height and width
 * ease across in 260 ms; the plate squashes into its floor to leave. The sample's `ease` curves and keyframes are used as written.
 *
 * What changed from the sample, and why (gallery-3b brief, 2026-11-24):
 * - `LINES[ci]` baked the rows of four cues. Rows now come from the words: at most three words a line, a key word closes its line and
 *   takes at most one companion, and a word joins only while the line's tall size stays at 70 % of its cap or more (85 % for a third
 *   word). Fit: tall and wide sizes shrink to the sample's 860 / 800 px, then everything shrinks together until the stack (two tall
 *   lines at the push, overshoot, plate padding and the tab) fits the safe area's height. `ci % 2` stays: plates alternate by cue.
 * - The sample's `scaleY` reset a line's words to full height the instant the next line started and a pushed line's re-centring
 *   offset vanished: both are continuous here (a word finishes its own stretch, the row finishes sliding). Words and plate use
 *   one set of sampled tracks.
 * - Real speech. The sample squashed the old line 70 ms before the next line was spoken (cutting its last word) and hid a cue 80 ms
 *   before its end. A word is never squashed or exited before it has been spoken and read for 150 ms: the push still moves the old
 *   line up at once (the new strip shoves it), but its tall-to-wide squash starts at the later of the next line's first word and
 *   150 ms after its own last word. A cue's first paint is at most 80 ms before its first word and never before the last word of
 *   the cue it replaces has ended (the cue before is cut on that frame, no empty frame in continuous speech); each word's stretch is
 *   compressed to fit its own spoken time (a 100 ms word is whole by its last frame, never fewer than two painted frames). The
 *   plate's exit squash waits until the last word has been spoken and read, shrinks to the time left, and is dropped when it cannot
 *   show two painted frames (a cut). It widens by at most the room the safe area has.
 * - Overlapping speakers: a cue that starts while an earlier one is still being spoken stacks above it (below when there is no room
 *   above), scaled to fit; neither covers the other.
 * - Shadow: the sample's two layered box-shadows (a 22 px / 50 px blur and a 4 / 10) are one soft shadow on the plate (10 px down, a
 *   5 px sigma, 0.24): a 50 px blur re-rasterised under a moving plate costs a full frame of libass (1.7x Headline measured at a 12 px
 *   sigma, 1.25x at 5).
 * - Every language: caps for cased scripts only (the shared caption casing, Turkish dotted I included); words are never split, so
 *   joined and Indic scripts, CJK and emoji work as they are; right-to-left cues order each row right to left and land from the
 *   right.
 * - New recurring beats in the sample's own flat, stark language, on every cue: a FOLDER TAB sits on the plate's top edge (the key
 *   word's cues get a wide tab in the highlight colour, the others a short one in the text colour; its side and width come from the
 *   cue counters and a seeded hash), pops on landing and stretches again on every push; SKID MARKS (two dashes, two slanted ticks or
 *   three dots, cycled by counter) flick outward under the plate each time a line lands. Neither carries text, both stay inside the
 *   plate's width and the safe area and finish before the exit.
 */

export const SQUASH_DEMO: DemoScript = {
  lines: [
    "most:m people never:b START:h@560",
    "they're:m waiting:b for the:m perfect:b MOMENT:h@600",
    "it:m won't:b come:b@420",
    "so:m build:b it YOURSELF:h@640",
  ],
  options: { rate: 265, cueGap: 170, tail: 720 },
};

const TALL_FACE = "Anton" as const;
const WIDE_FACE = "Montserrat" as const;
/** The sample's numbers, in its 1080 x 1920 frame. */
const BOTTOM = 1470;
const FIT = 860;
const TALL_HERO = 250;
const TALL = 168;
const WIDE_MAX = 78;
const WIDE_FIT = 800;
const GAP = 16;
const PADX = 44;
const PADY = 34;
const TALL_LH = 0.9;
const WIDE_LH = 0.92;
/** Baseline of a `line-height` box measured from its top, in em (read off the sample's probe and the fonts' hhea metrics). */
const TALL_BASE = 0.8735;
const WIDE_BASE = 0.8185;
const TALL_LS = 0.005;
const WIDE_LS = -0.01;
const COLUMN_GAP = 0.2;
const LEAD = 80;
const RISE = 230;
const SQUASH_SHUT = 110;
const SQUASH_OPEN = 300;
const MORPH = 260;
const HOLD = 150;
const EXIT = 120;
const MIN_EXIT = 84;
/** Smallest scale a squashed piece is drawn at (libass dislikes 0). */
const FLOOR_SCALE = 0.02;
const MIN_RATIO = 0.7;
const THIRD_RATIO = 0.85;
const MAX_WORDS = 3;
const TAB_H = 26;
const TAB_RESERVE = 34;
const STACK_GAP = 30;
const SKID_LIFE = 300;
/** A clip edge that is open: far past any canvas. */
const OPEN = 20000;
const MAX_SKIDS = 3;

/** FNV-1a of a string: the seed that makes a cue's variety a pure function of its index and words. */
export function squashHash(text: string): number {
  let h = 0x811c9dc5;
  for (let at = 0; at < text.length; at++) {
    h ^= text.charCodeAt(at);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Row breaks of a cue: the words of each line, by index. `ratio(words)` is the line's tall size over its cap (1 = full size). */
export function squashLines(roles: readonly ("hero" | "body" | "minor")[], ratio: (words: readonly number[]) => number): number[][] {
  const lines: number[][] = [];
  let line: number[] = [];
  for (let at = 0; at < roles.length; at++) {
    if (line.length > 0) {
      const joined = [...line, at];
      const lineHero = line.some((i) => roles[i] === "hero");
      const full = line.length >= MAX_WORDS;
      const weak = ratio(joined) < (line.length >= 2 ? THIRD_RATIO : MIN_RATIO);
      // A key word's line is closed by it; a hero run (two key words in a row) shares one line.
      const afterHero = lineHero && roles[at] !== "hero";
      // A key word takes at most one companion.
      const crowded = roles[at] === "hero" && line.length >= 2 && !lineHero;
      if (full || weak || afterHero || crowded) {
        lines.push(line);
        line = [];
      }
    }
    line.push(at);
  }
  if (line.length > 0) lines.push(line);
  return lines;
}

interface LineBox {
  words: number[];
  hero: boolean;
  text: string;
  tall: { size: number; widths: number[]; offsets: number[]; right: number[]; w: number; h: number; up: number };
  wide: { size: number; w: number; h: number; up: number };
}

interface WordTime {
  from: number;
  rise: number;
}

interface Item {
  line: number;
  floor: number;
  h: number;
  w: number;
}

interface Stack {
  items: Item[];
  top: number;
  width: number;
}

interface CueResult {
  pieces: Piece[];
  /** What the cue ever draws, canvas px: another cue speaking at the same time stacks outside it. */
  box: Box | null;
}

export interface SquashPlan {
  from: number;
  to: number;
  spokenEnd: number;
  blockers: readonly Box[];
}

/** Everything the cue handoff needs: when each cue first paints, and when it is cut. Exposed for the tests. */
export function squashPlans(cues: readonly SceneCue[], fps: number): (SquashPlan | null)[] {
  const spokenStart = cues.map((cue) => cue.words[0]?.startMs ?? 0);
  const spokenEnd = cues.map((cue) => Math.max(0, ...cue.words.map((word) => word.endMs)));
  const lead = cues.map((cue, at) => {
    if (!cue.words.length) return 0;
    // The cues this one replaces (spoken before it starts) must have ended before its first paint.
    let finished = Number.NEGATIVE_INFINITY;
    for (let j = 0; j < at; j++) if (cues[j]!.words.length && spokenEnd[j]! <= spokenStart[at]!) finished = Math.max(finished, spokenEnd[j]!);
    return Number.isFinite(finished) ? clamp(spokenStart[at]! - finished, 0, LEAD) : LEAD;
  });
  const first = cues.map((cue, at) => (cue.words.length ? exportFrameAtOrAfter(spokenStart[at]! - lead[at]!, fps) : Number.POSITIVE_INFINITY));
  return cues.map((cue, at) => {
    if (!cue.words.length) return null;
    // A later cue that starts after this one has been spoken replaces it on its first painted frame.
    const cut = Math.min(Number.POSITIVE_INFINITY, ...cues.map((_, later) => (later > at && cues[later]!.words.length && spokenStart[later]! >= spokenEnd[at]! ? first[later]! : Number.POSITIVE_INFINITY)));
    return { from: spokenStart[at]! - lead[at]!, to: Math.min(Math.max(cue.endMs, spokenEnd[at]!), cut), spokenEnd: spokenEnd[at]!, blockers: [] };
  });
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildCue(input: SceneInput, space: SceneSpace, cue: SceneCue, number: number, plan: SquashPlan, counters: { hero: number; plain: number }, fps: number): CueResult {
  const u = space.u;
  const rtl = cueDirection(cue) === "rtl";
  const cx = space.x(540);
  const baseBottom = space.y(BOTTOM) + PADY * u;
  const safeW = space.safe.x2 - space.safe.x1;
  const upper = cue.words.map((word) => toCaptionUpperCase(word.text, cue.language));
  const heroCue = cue.words.some((word) => word.role === "hero");
  const dark = number % 2 === 0;
  const fg = dark ? input.colours.primary : input.colours.accent;
  const plateColour = dark ? input.colours.accent : input.colours.primary;
  const seed = squashHash(`${number}:${cue.words.map((word) => word.text).join(" ")}`);
  const rand = mulberry32(seed);
  const variant = heroCue ? counters.hero++ : counters.plain++;

  const tallAt100 = new Map<number, number>();
  const tallWord100 = (at: number) => {
    let w = tallAt100.get(at);
    if (w === undefined) {
      w = input.measure(upper[at]!, TALL_FACE, 100, TALL_LS).advance + TALL_LS * 100;
      tallAt100.set(at, w);
    }
    return w;
  };

  /** One complete layout at size factor `f`: lines, per-word timing, and the stack's state at any time. */
  const layout = (f: number, floorBottom: number) => {
    const k = u * f;
    const fitW = Math.min(FIT * k, safeW - 2 * PADX * k - 6 * u);
    const wideFit = Math.min(WIDE_FIT * k, fitW);
    const natural = (words: readonly number[]) => words.reduce((sum, at) => sum + tallWord100(at), 0) + (words.length - 1) * COLUMN_GAP * 100;
    const capOf = (words: readonly number[]) => (words.some((at) => cue.words[at]!.role === "hero") ? TALL_HERO : TALL) * k;
    const sizeOf = (words: readonly number[]) => Math.min(capOf(words), (fitW * 100) / natural(words));
    const groups = squashLines(cue.words.map((word) => word.role), (words) => sizeOf(words) / capOf(words));
    const lines: LineBox[] = groups.map((words) => {
      const size = sizeOf(words);
      const widths = words.map((at) => (tallWord100(at) * size) / 100);
      const gap = COLUMN_GAP * size;
      // Visual order left to right, from the shared bidi code for right-to-left rows.
      const order = rowVisualOrder(words.map((at) => upper[at]!), rtl ? "rtl" : "ltr");
      const offsets: number[] = new Array(words.length).fill(0);
      let x = 0;
      for (const position of order) {
        offsets[position] = x;
        x += widths[position]! + gap;
      }
      const right = widths.map((_, i) => widths.slice(0, i + 1).reduce((s, w) => s + w, 0) + gap * i);
      const text = words.map((at) => upper[at]!).join(" ");
      const wideSize = Math.min(WIDE_MAX * k, (wideFit * 100) / (input.measure(text, WIDE_FACE, 100, WIDE_LS).advance + WIDE_LS * 100));
      const wideW = input.measure(text, WIDE_FACE, wideSize, WIDE_LS).advance + WIDE_LS * wideSize;
      // A script taller than Anton (a fallback face) needs the box to hold its real ink: the baseline rises and the box grows;
      // the measured ink bottom then rests on the floor (the plate's padding below it takes what the shaping engine adds).
      const room = 0;
      const boxFor = (text: string, face: typeof TALL_FACE | typeof WIDE_FACE, px: number, ls: number, lh: number, base: number) => {
        const m = input.measure(text, face, px, ls);
        const up0 = (lh - base) * px;
        const up = up0 + Math.max(0, m.inkBottom - up0 - room);
        return { up, h: Math.max(lh * px, up - m.inkTop) };
      };
      const tallBoxes = words.map((at) => boxFor(upper[at]!, TALL_FACE, size, TALL_LS, TALL_LH, TALL_BASE));
      const tallUp = Math.max(...tallBoxes.map((x) => x.up));
      const tallH = Math.max(...tallBoxes.map((x) => x.h));
      const wideBox = boxFor(text, WIDE_FACE, wideSize, WIDE_LS, WIDE_LH, WIDE_BASE);
      return {
        words: [...words],
        hero: words.some((at) => cue.words[at]!.role === "hero"),
        text,
        tall: { size, widths, offsets, right, w: right[right.length - 1]!, h: tallH, up: tallUp },
        wide: { size: wideSize, w: wideW, h: wideBox.h, up: wideBox.up },
      };
    });

    // Timing: every word's own stretch, compressed into its spoken time.
    const times: WordTime[] = cue.words.map((word, at) => {
      const from = at === 0 ? plan.from : Math.max(plan.from, word.startMs - LEAD);
      return { from, rise: clamp(word.endMs - 34 - from, MIN_EXIT, RISE) };
    });
    const lineFrom = lines.map((line) => times[line.words[0]!]!.from);
    // The tall-to-wide squash of a line: after the next line's first word, and 150 ms after its own last word.
    const morphAt = lines.map((line, i) => {
      const next = lines[i + 1];
      if (!next) return Number.POSITIVE_INFINITY;
      const lastEnd = Math.max(...line.words.map((at) => cue.words[at]!.endMs));
      return Math.max(cue.words[next.words[0]!]!.startMs, lastEnd + HOLD);
    });

    const stretchOf = (at: number, t: number) => {
      const { from, rise } = times[at]!;
      const s = rise / RISE;
      return kf(t, [[from, 0.1], [from + rise, 1.07, "out"], [from + (350 * s), 0.98, "inOut"], [from + 440 * s, 1, "inOut"]] as Frames);
    };
    const readWidth = (line: LineBox, t: number) => {
      let w = line.tall.right[0]!;
      line.words.forEach((at, i) => {
        if (i > 0) w += (line.tall.right[i]! - line.tall.right[i - 1]!) * EASES.outExpo(prog(t, times[at]!.from, 260 * (times[at]!.rise / RISE)));
      });
      return w;
    };
    const shiftOf = (line: LineBox, t: number) => {
      const w = readWidth(line, t);
      const lo = rtl ? line.tall.w - w : 0;
      const hi = rtl ? line.tall.w : w;
      return line.tall.w / 2 - (lo + hi) / 2;
    };
    const tallSy = (i: number, t: number) => (Number.isFinite(morphAt[i]!) ? 1 - EASES.in(prog(t, morphAt[i]!, SQUASH_SHUT)) : 1);
    const wideSy = (i: number, t: number) => (Number.isFinite(morphAt[i]!) && t >= morphAt[i]! + SQUASH_SHUT ? EASES.spring(prog(t, morphAt[i]! + SQUASH_SHUT, SQUASH_OPEN)) : 0);

    const memo = new Map<number, Stack | null>();
    const stack = (t: number): Stack | null => {
      if (memo.has(t)) return memo.get(t)!;
      const live: number[] = [];
      lines.forEach((_, i) => {
        if (t >= lineFrom[i]!) live.push(i);
      });
      let result: Stack | null = null;
      if (live.length) {
        const newest = live[live.length - 1]!;
        const heights: Item[] = live.map((i) => {
          const line = lines[i]!;
          const tallH = line.tall.h * stretchOf(line.words[0]!, t);
          if (i === newest) return { line: i, floor: 0, h: tallH, w: readWidth(line, t) };
          const morph = EASES.inOut(prog(t, morphAt[i]!, MORPH));
          return { line: i, floor: 0, h: lerp(tallH, line.wide.h, morph), w: lerp(readWidth(line, t), line.wide.w, morph) };
        });
        let floor = floorBottom - PADY * k;
        let top = floor;
        let width = 0;
        for (let at = heights.length - 1; at >= 0; at--) {
          const item = heights[at]!;
          item.floor = floor;
          top = floor - item.h;
          floor = top - GAP * k;
          width = Math.max(width, item.w);
        }
        result = { items: heights, top: top - PADY * k, width: width + 2 * PADX * k };
      }
      memo.set(t, result);
      return result;
    };
    return { k, lines, times, lineFrom, morphAt, stretchOf, readWidth, shiftOf, tallSy, wideSy, stack, floorBottom };
  };

  // The region the cue lives in: the sample's floor, or free space beside a cue still being spoken.
  const maxHeight = (lay: ReturnType<typeof layout>) => {
    let h = 0;
    const end = Math.max(plan.to, plan.from + 1);
    for (let t = plan.from; t <= end; t += 12) {
      const s = lay.stack(t);
      if (s) h = Math.max(h, lay.floorBottom - s.top);
    }
    for (const t of [...lay.times.map((w) => w.from + w.rise), ...lay.morphAt.filter(Number.isFinite)]) {
      const s = lay.stack(t);
      if (s) h = Math.max(h, lay.floorBottom - s.top);
    }
    return h;
  };
  const fitInto = (floorBottom: (h: number) => number, avail: number) => {
    let f = 1;
    let lay = layout(f, floorBottom(0));
    let h = maxHeight(lay);
    for (let round = 0; round < 4 && h + TAB_RESERVE * u * lay.k > avail; round++) {
      f *= Math.max(0.2, (avail / (h + TAB_RESERVE * u * lay.k)) * 0.985);
      lay = layout(f, floorBottom(h * f));
      h = maxHeight(lay);
    }
    return { f, lay: layout(f, floorBottom(h)), h };
  };

  let region: { f: number; lay: ReturnType<typeof layout>; h: number };
  const blockers = plan.blockers;
  const gapY = STACK_GAP * u;
  if (blockers.length === 0) {
    region = fitInto(() => baseBottom, baseBottom - space.safe.y1);
  } else {
    const top = Math.min(...blockers.map((box) => box.y1));
    const bottom = Math.max(...blockers.map((box) => box.y2));
    const above = fitInto(() => top - gapY, top - gapY - space.safe.y1);
    const below = fitInto((h) => bottom + gapY + TAB_RESERVE * u + h, space.safe.y2 - (bottom + gapY));
    region = above.f >= 0.45 || above.f >= below.f ? above : below;
  }
  const { lay } = region;
  const { k, lines, times, lineFrom, morphAt, stack, floorBottom } = lay;
  const pb = floorBottom;
  const { from, to } = plan;

  // The plate's exit: squashed into its floor after the last word has been spoken and read.
  let exitAt = to;
  if (to - plan.spokenEnd >= MIN_EXIT) {
    exitAt = Math.max(to - EXIT, plan.spokenEnd + Math.min(HOLD, to - plan.spokenEnd - MIN_EXIT));
    while (exitAt > plan.spokenEnd && paintedFrameCount(exitAt, to, fps) < 2) exitAt--;
    if (paintedFrameCount(exitAt, to, fps) < 2) exitAt = to;
  }
  let widest = 0;
  for (const t of [...times.map((w) => w.from + w.rise + 450), ...morphAt.filter(Number.isFinite).map((m) => m + 420), plan.spokenEnd]) widest = Math.max(widest, stack(Math.min(t, to))?.width ?? 0);
  for (let t = from; t <= to; t += 24) widest = Math.max(widest, stack(t)?.width ?? 0);
  const widen = widest > 0 ? clamp((safeW - 4 * u) / widest - 1, 0, 0.06) : 0;
  const exit = (t: number) => (exitAt < to ? EASES.in(prog(t, exitAt, to - exitAt)) : 0);
  const gx = (t: number) => 1 + widen * exit(t);
  const gy = (t: number) => Math.max(FLOOR_SCALE, 1 - exit(t));
  const gX = (x: (t: number) => number) => (t: number) => cx + (x(t) - cx) * gx(t);
  const gY = (y: (t: number) => number) => (t: number) => pb + (y(t) - pb) * gy(t);

  // Every place any window starts or ends: between two of them each track is smooth.
  const edgeSet = new Set<number>([from, to, exitAt, to]);
  cue.words.forEach((_, at) => {
    const { from: f, rise } = times[at]!;
    const s = rise / RISE;
    for (const e of [0, rise, 350 * s, 440 * s, 260 * s]) edgeSet.add(f + e);
  });
  morphAt.forEach((m) => {
    if (Number.isFinite(m)) for (const e of [0, SQUASH_SHUT, MORPH, SQUASH_SHUT + SQUASH_OPEN]) edgeSet.add(m + e);
  });
  const edges = [...edgeSet].filter((e) => e > from && e < to).sort((a, b) => a - b);
  const sample = (fn: (t: number) => number, a: number, b: number, tol: number): Frames => sampleFrames(fn, edges, tol, { range: [a, Math.max(b, a + 1)] });
  const posTol = 0.3 * u;
  const scaleTol = 0.004;

  const pieces: Piece[] = [];
  const shape = (id: string, path: ShapePiece["path"], origin: { dx: number; dy: number }, fill: string, z: number, a: number, b: number, track: ShapePiece["track"], shadows?: ShapePiece["shadows"]) => {
    if (b <= a || paintedFrameCount(a, b, fps) < 2) return null;
    const piece: ShapePiece = { id: `squash:${number}:${id}`, kind: "shape", z, fromMs: a, toMs: b, path, origin, fill: { colour: fill }, track, ...(shadows ? { shadows } : {}) };
    pieces.push(piece);
    return piece;
  };

  // Plate: one rectangle at the largest size the cue needs, scaled about the middle of its floor.
  const plateW = Math.max(1, widest);
  let plateH = 1;
  for (let t = from; t <= to; t += 12) {
    const s = stack(t);
    if (s) plateH = Math.max(plateH, pb - s.top);
  }
  for (const t of [...times.map((w) => w.from + w.rise), ...morphAt.filter(Number.isFinite)]) {
    const s = stack(Math.min(t, to));
    if (s) plateH = Math.max(plateH, pb - s.top);
  }
  const start = lineFrom[0]!;
  shape("plate", rectPath(0, 0, plateW, plateH), { dx: plateW / 2, dy: plateH }, plateColour, 1, start, to, {
    x: [[start, cx]],
    y: [[start, pb]],
    sx: sample((t) => gx(t) * ((stack(t)?.width ?? plateW) / plateW), start, to, scaleTol),
    sy: sample((t) => gy(t) * ((pb - (stack(t)?.top ?? pb)) / plateH), start, to, scaleTol),
  }, [{ dx: 0, dy: 10 * k, blur: 5 * k, colour: input.colours.shadow, alpha: 0.24 }]);

  // The words: each one a piece of its own, all through the cue (a squashed old line keeps its pieces until it has shut).
  lines.forEach((line, i) => {
    const shutAt = Number.isFinite(morphAt[i]!) ? Math.floor(morphAt[i]! + SQUASH_SHUT - 2) : to;
    const tallTo = Math.min(to, shutAt);
    line.words.forEach((at, position) => {
      const { from: wordFrom } = times[at]!;
      const a = Math.max(wordFrom, lineFrom[i]!);
      const tall = line.tall;
      const centre = (t: number) => cx - tall.w / 2 + lay.shiftOf(line, t) + tall.offsets[position]! + tall.widths[position]! / 2;
      const floorOf = (t: number) => stack(t)?.items.find((item) => item.line === i)?.floor ?? pb;
      const piece: TextPiece = {
        id: `squash:${number}:w${at}`, kind: "text", z: 3, fromMs: a, toMs: Math.max(tallTo, a + 1),
        text: upper[at]!, face: TALL_FACE, sizePx: tall.size, letterSpacingEm: TALL_LS, fill: fg, anchor: "baseline-center", language: cue.language,
        origin: { dx: 0, dy: tall.up },
        // The plate is the window: a word arriving at the row's end is uncovered as the plate widens to take it.
        clip: {
          x1: sample((t) => cx - ((stack(t)?.width ?? plateW) * gx(t)) / 2, a, tallTo, posTol),
          x2: sample((t) => cx + ((stack(t)?.width ?? plateW) * gx(t)) / 2, a, tallTo, posTol),
          y1: [[a, -OPEN]],
          y2: [[a, OPEN]],
        },
        track: {
          x: sample(gX(centre), a, tallTo, posTol),
          y: sample(gY(floorOf), a, tallTo, posTol),
          sx: exitAt < to ? sample(gx, a, tallTo, scaleTol) : [[a, 1]],
          sy: sample((t) => Math.max(FLOOR_SCALE, lay.stretchOf(at, t) * lay.tallSy(i, t) * gy(t)), a, tallTo, scaleTol),
        },
      };
      pieces.push(piece);
    });
    // The wide copy springs open once the tall one has shut.
    if (Number.isFinite(morphAt[i]!)) {
      const a = Math.ceil(morphAt[i]! + SQUASH_SHUT);
      const floorOf = (t: number) => stack(t)?.items.find((item) => item.line === i)?.floor ?? pb;
      if (a < to && paintedFrameCount(a, to, fps) >= 2) {
        pieces.push({
          id: `squash:${number}:wide${i}`, kind: "text", z: 2, fromMs: a, toMs: to,
          text: line.text, face: WIDE_FACE, sizePx: line.wide.size, letterSpacingEm: WIDE_LS, fill: fg, anchor: "baseline-center", language: cue.language,
          origin: { dx: 0, dy: line.wide.up },
          track: {
            x: exitAt < to ? sample(gX(() => cx), a, to, posTol) : [[a, cx]],
            y: sample(gY(floorOf), a, to, posTol),
            sx: exitAt < to ? sample(gx, a, to, scaleTol) : [[a, 1]],
            sy: sample((t) => Math.max(FLOOR_SCALE, lay.wideSy(i, t) * gy(t)), a, to, scaleTol),
          },
        });
      }
    }
  });

  // Folder tab on the plate's top edge.
  const wideTab = heroCue;
  const tabW = (wideTab ? 130 : 92) * k * [1, 0.82, 1.14][(variant + (seed & 3)) % 3]!;
  const side = ((variant + (seed >>> 3)) % 3) as 0 | 1 | 2;
  const inset = (26 + Math.floor(rand() * 5) * 8) * k;
  const tabFrom = Math.min(to - 1, from + 120);
  const tabX = (t: number) => {
    const w = stack(t)?.width ?? plateW;
    const left = cx - w / 2 + inset + tabW / 2;
    const rightX = cx + w / 2 - inset - tabW / 2;
    if (side === 2) return cx;
    return (side === 0) !== rtl ? left : rightX;
  };
  const pushTimes = lines.slice(1).map((_, i) => lineFrom[i + 1]!);
  const tabSy = (t: number) => {
    const pop = Math.max(FLOOR_SCALE, EASES.spring(prog(t, tabFrom, 280)));
    const pulse = pushTimes.reduce((sum, at) => sum + (t < at ? 0 : 0.3 * (1 - EASES.spring(prog(t, at, 260)))), 0);
    return pop * (1 + pulse);
  };
  for (const e of [tabFrom + 280, ...pushTimes, ...pushTimes.map((at) => at + 260)]) if (e > from && e < to) edgeSet.add(e);
  const edges2 = [...edgeSet].filter((e) => e > from && e < to).sort((a, b) => a - b);
  const sampleTab = (fn: (t: number) => number, tol: number): Frames => sampleFrames(fn, edges2, tol, { range: [tabFrom, Math.max(to, tabFrom + 1)] });
  shape("tab", rectPath(0, 0, tabW, TAB_H * k), { dx: tabW / 2, dy: TAB_H * k }, wideTab ? input.colours.highlight : fg, 3, tabFrom, to, {
    x: sampleTab(gX(tabX), posTol),
    y: sampleTab(gY((t) => (stack(t)?.top ?? pb) + 1 * u), posTol),
    sx: sampleTab(gx, scaleTol),
    sy: sampleTab((t) => tabSy(t) * gy(t), scaleTol),
  });

  // Skid marks under the plate each time a line lands.
  const style = (variant + (seed >>> 5)) % 3;
  let skids = 0;
  lines.forEach((line, i) => {
    if (i >= MAX_SKIDS) return;
    const first = line.words[0]!;
    const land = Math.round(times[first]!.from + 0.7 * times[first]!.rise);
    const end = Math.min(to, land + SKID_LIFE);
    if (end - land < 80) return;
    const half = Math.max(48 * k, ((stack(Math.min(to - 1, land + 160))?.width ?? plateW) / 2) * 0.62);
    const travel = 26 * k;
    const slide = (t: number) => travel * EASES.outExpo(prog(t, land, 260));
    const fade = (t: number) => 1 - EASES.in(prog(t, land + 110, 190));
    const specs: { id: string; path: ShapePiece["path"]; origin: { dx: number; dy: number }; dir: -1 | 0 | 1; rz: number; dy: number }[] = [];
    const dashW = (36 + Math.floor(rand() * 3) * 6) * k;
    const dashH = 7 * k;
    for (const dir of [-1, 1] as const) {
      if (style === 2) {
        specs.push({ id: `skid${i}${dir < 0 ? "a" : "b"}`, path: ellipsePath(0, 0, 4.5 * k), origin: { dx: 0, dy: 0 }, dir, rz: 0, dy: 15 * k });
        if (dir > 0) specs.push({ id: `skid${i}c`, path: ellipsePath(0, 0, 4.5 * k), origin: { dx: 0, dy: 0 }, dir: 0, rz: 0, dy: 27 * k });
      } else {
        specs.push({ id: `skid${i}${dir < 0 ? "a" : "b"}`, path: roundedRectPath(0, 0, dashW, dashH, dashH / 2), origin: { dx: dashW / 2, dy: dashH / 2 }, dir, rz: style === 1 ? dir * 16 : 0, dy: 14 * k });
      }
    }
    for (const spec of specs) {
      if (skids >= MAX_SKIDS * 3) break;
      const base = spec.dir === 0 ? 0 : spec.dir * half;
      const x = (t: number) => cx + base + spec.dir * slide(t) * (style === 2 ? 0.8 : 1);
      const y = () => pb + spec.dy;
      const piece = shape(spec.id, spec.path, spec.origin, input.colours.highlight, 4, land, end, {
        x: sampleFrames(gX(x), edges2, posTol, { range: [land, end] }),
        y: sampleFrames(gY(y), edges2, posTol, { range: [land, end] }),
        sx: sampleFrames(gx, edges2, scaleTol, { range: [land, end] }),
        sy: sampleFrames(gy, edges2, scaleTol, { range: [land, end] }),
        o: sampleFrames(fade, edges2, 0.02, { range: [land, end] }),
        ...(spec.rz ? { rz: [[land, spec.rz]] as Frames } : {}),
      });
      if (piece) skids++;
    }
  });

  const margin = 2 * u;
  const shifted = clampToSafeArea(pieces, { x1: space.safe.x1 + margin, y1: space.safe.y1 + margin, x2: space.safe.x2 - margin, y2: space.safe.y2 - margin }, input.measure);
  // The cue's own footprint, for a cue stacked beside it: everything it ever draws.
  let box: Box | null = null;
  for (let t = from; t < to; t += 16) {
    const at = sceneBoundsAt(shifted, t, input.measure);
    if (at) box = box ? { x1: Math.min(box.x1, at.x1), y1: Math.min(box.y1, at.y1), x2: Math.max(box.x2, at.x2), y2: Math.max(box.y2, at.y2) } : at;
  }
  return { pieces: shifted, box };
}

export const squashProgram: SceneProgram = {
  build(input) {
    const fps = input.fps ?? SCENE_DEFAULT_FPS;
    const space = sceneSpace(input, BOTTOM);
    const plans = squashPlans(input.cues, fps);
    const counters = { hero: 0, plain: 0 };
    const built: { box: Box | null; plan: SquashPlan }[] = [];
    const pieces: Piece[] = [];
    input.cues.forEach((cue, number) => {
      const base = plans[number];
      if (!base || !cue.words.length) return;
      // Cues still being spoken when this one starts keep their spot; this one stacks outside them.
      const blockers = built.filter((other) => other.plan.spokenEnd > cue.words[0]!.startMs && other.box).map((other) => other.box!);
      const plan: SquashPlan = { ...base, blockers };
      const result = buildCue(input, space, cue, number, plan, counters, fps);
      built.push({ box: result.box, plan });
      pieces.push(...result.pieces);
    });
    return { pieces };
  },
};

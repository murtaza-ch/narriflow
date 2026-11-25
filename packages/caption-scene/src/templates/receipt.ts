import { CAPTION_SCENE_BRAND_MIN_CONTRAST, captionColourContrast, toCaptionUpperCase } from "@narriflow/validators";
import type { DemoScript } from "../demo";
import { EASES, type Frames, kf, prog } from "../ease";
import { exportFrameAtOrBefore, paintedFrameCount, SCENE_DEFAULT_FPS } from "../frame-grid";
import { sampleFrames } from "../frames";
import type { SceneInput, SceneProgram } from "../input";
import { balancedRows, cueDirection, rowVisualOrder, rowWidth, type SceneSpace, sceneSpace } from "../layout";
import { type Box, evaluatePiece, mixColour, type PathCmd, type Piece, type ShapePiece, type TextPiece } from "../scene";
import { polygonPath, rectPath, starPath } from "../shapes";
import { hasTwoPaintedFrames, speechLaneSpace, type SpeechWindow, speechWindows } from "./speech-layout";

/**
 * Receipt (`samples/templates/m58-receipt.js`): a strip of thermal paper with torn zigzag ends. Each word is printed (a quick
 * top-to-bottom ink wipe) at its spoken time; the paper grows a line at a time and slides up so its bottom edge stays in the
 * band; a dotted rule is struck between cues; the key word prints big in bold caps between two red stars; a full strip is torn
 * off and flung to the side and a fresh one starts.
 *
 * Changes from the sample, and why:
 * - Cues are grouped into strips by the paper's real height (the band on this canvas), not by a fixed 720 px; a long pause
 *   (1.1 s) also starts a fresh strip so old text never lingers over a silence. Everything is derived from the words: no
 *   cue-indexed tables.
 * - The paper grows with the real words. Rows wrap by measured widths (not an 18-character cap), the paper widens (up to the
 *   safe area) for a long word, and only a word wider than the widest paper is broken into pieces across rows. Text is never
 *   shrunk to fit a slip; a lone cue taller than the band (a tall Devanagari cue, a lane of two speakers, 2x size) shrinks as
 *   the last resort, 8 % at a time.
 * - The key word is bold caps at the sample's size while it fits between its stars; a longer one gives up size down to 60 px,
 *   then its stars, then size down to the body size, then is broken. Every key word of a cue prints this way (the sample
 *   printed only the first).
 * - The sample hides nothing it has not printed: the ink wipe is cut by the paper's own edge, so no ink ever shows on bare
 *   video while the paper is still growing, and the paper's growth is shortened to finish with the first word's wipe when
 *   speech is fast (a 70 ms word is still whole by its last frame).
 * - The tear-off needs room: it runs in the gap after the last word has had its 150 ms reading hold (compressed to what the
 *   gap holds, at least two painted frames); when the next strip starts at once there is no tear and the strip is cut at the
 *   handoff, never covered. Tear pieces are separate `bleed` copies, so the selection box and the safe-area checks follow the
 *   strip, not the flight.
 * - Right-to-left cues mirror (rows in visual order, rule and bars draw from the right, the strip flies off to the left).
 * - Colours: the paper is the preset's accent slot, ink and stars the primary and highlight slots; ink that does not read
 *   (4.5:1) on the paper falls back to near-black or white, stars to the sample's red (3:1).
 * - Space Mono has no Devanagari, Arabic or CJK: those words go through the glyph-coverage fallback face, measured as drawn,
 *   and rows and paper height follow their real ink.
 * - Extra recurring beats (the sample has none): a double "total" rule that draws in under every key word; a warm thermal
 *   band that flashes behind each row as it prints; and every third rule is a barcode instead of dots. All are pure decoration
 *   or the speaker's own words, under the text, in the paper's own language.
 */

export const RECEIPT_DEMO: DemoScript = {
  lines: [
    "most:b people:b track:b their:m spending:b",
    "but:m never:b their:m time:h@560",
    "you:m get:m 24:b hours:b a:m day:m",
    "same:b as:m everyone:b",
    "spend:b it:m like:m money:h@520",
  ],
  options: { rate: 235, cueGap: 280, lead: 420, tail: 700, gap: 28 },
};

const FACE = "Space Mono Bold" as const;
/** The sample's anchor line: the middle of the strip's rest zone (top 1170, bottom 1610). */
const ANCHOR = 1390;
const BODY = 52;
const SOLO = 78;
const HERO_MAX = 86;
const HERO_MIN = 60;
const STAR = 0.62;
const STAR_GAP = 26;
const PW0 = 680;
const INNER0 = 600;
const PAD_X = (PW0 - INNER0) / 2;
const ZH = 16;
const ZT = 20;
const PT = 34;
const PB = 34;
const RULEH = 46;
const TOP_REST = 1170;
const BOTTOM_MAX = 1610;
const TOP_LIMIT = 900;
const TEAR_MS = 240;
const TEAR_DX = 980;
const TEAR_DEG = 9;
const GROW = 170;
const PRINT_LEAD = 100;
const WIPE = 150;
const WIPE_LEAD = 50;
const WINDOW_LEAD = 100;
const HOLD = 150;
const LINGER = 1400;
const BREAK_GAP = 1100;
/** How soon before its first word a strip that follows a torn-off one starts. */
const SUCCESSOR_LEAD = 60;
const PREFER_BREAK_FILL = 0.6;
const PREFER_BREAK_GAP = 300;
/** The baseline's distance below a row's top, em: Space Mono's metrics in a 1.36 line box. */
const ROW_BASE = 1.0595;
const HERO_BASE = 1.1295;
const ROW_LINE = 1.36;
const HERO_LINE = 1.5;
const HERO_PAD = 14;

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

// ─── Layout ──────────────────────────────────────────────────────────────────

interface Cell {
  readonly at: number;
  readonly part: number;
  readonly parts: number;
  readonly text: string;
  readonly size: number;
  /** Centre x from the paper's centre line. */
  readonly x: number;
  readonly width: number;
  readonly inkTop: number;
  readonly inkBottom: number;
  baseline: number;
  readonly hero: boolean;
}

interface Block {
  readonly kind: "row" | "hero";
  y: number;
  h: number;
  readonly cells: Cell[];
  /** A key word's stars: size and distance of their centres from the centre line. */
  readonly stars?: { readonly size: number; readonly reach: number };
  /** The key word's whole advance (its total rule's length). */
  readonly textWidth?: number;
  /** Where its total rule starts, from the block's top: below the measured ink, the room is part of the row. */
  readonly barRel?: number;
}

interface CueLayout {
  readonly win: SpeechWindow;
  readonly blocks: Block[];
  ruleY: number | null;
}

interface StripLayout {
  readonly cues: CueLayout[];
  readonly inner: number;
  readonly pw: number;
  readonly height: number;
  readonly uu: number;
}

interface Env {
  readonly input: SceneInput;
  readonly fps: number;
  readonly space: SceneSpace;
  readonly paper: string;
  readonly ink: string;
  readonly star: string;
  readonly rule: string;
  readonly band: string;
}

interface Lane {
  readonly space: SceneSpace;
  readonly bounds: Box;
}

const adv = (env: Env, text: string, size: number) => env.input.measure(text, FACE, size, 0).advance;
const heroText = (win: SpeechWindow, at: number) => toCaptionUpperCase(win.cue.words[at]!.text, win.cue.language);

function graphemes(text: string): string[] {
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((part) => part.segment);
}

/** A word wider than `max` as pieces that each fit it. */
function breakWord(env: Env, text: string, size: number, max: number): string[] {
  const parts: string[] = [];
  let current = "";
  for (const cluster of graphemes(text)) {
    if (current && adv(env, current + cluster, size) > max) {
      parts.push(current);
      current = cluster;
    } else current += cluster;
  }
  if (current) parts.push(current);
  return parts;
}

interface Item {
  readonly at: number;
  readonly part: number;
  readonly parts: number;
  readonly text: string;
  readonly width: number;
}

function makeBlock(env: Env, kind: "row" | "hero", cells: Omit<Cell, "baseline">[], uu: number, extra: { stars?: Block["stars"]; textWidth?: number } = {}): Block {
  const size = Math.max(...cells.map((cell) => cell.size));
  const hero = kind === "hero";
  let h = hero ? Math.round(size * HERO_LINE + HERO_PAD * uu) : Math.round(size * ROW_LINE);
  let baseline = hero ? HERO_PAD / 2 * uu + size * HERO_BASE : size * ROW_BASE;
  const margin = 0.06 * size;
  const top = Math.min(...cells.map((cell) => cell.inkTop));
  const bottom = Math.max(...cells.map((cell) => cell.inkBottom));
  const up = Math.max(0, margin - (baseline + top));
  const down = Math.max(0, baseline + bottom + margin - h);
  h += up + down;
  baseline += up;
  void env;
  let barRel: number | undefined;
  if (hero && extra.textWidth !== undefined && cells.length === 1) {
    // The double rule sits under the ink the face really draws (Devanagari vowel marks hang below the baseline), and the row grows to hold it.
    barRel = Math.max(baseline + 0.22 * size, baseline + bottom + 3 * uu);
    h = Math.max(h, barRel + 9 * uu + margin);
  }
  return { kind, y: 0, h, cells: cells.map((cell) => ({ ...cell, baseline })), ...extra, ...(barRel !== undefined ? { barRel } : {}) };
}

/** The row's cells centred on the paper's line, in the order the viewer reads them. */
function placeRow(env: Env, items: readonly Item[], size: number, gap: number, direction: "ltr" | "rtl", hero: boolean): Omit<Cell, "baseline">[] {
  const widths = items.map((item) => item.width);
  const total = rowWidth(widths, items.map((_, i) => i), gap);
  let cursor = -total / 2;
  const cells: Omit<Cell, "baseline">[] = [];
  for (const i of rowVisualOrder(items.map((item) => item.text), direction)) {
    const item = items[i]!;
    const m = env.input.measure(item.text, FACE, size, 0);
    cells.push({ at: item.at, part: item.part, parts: item.parts, text: item.text, size, x: cursor + item.width / 2, width: item.width, inkTop: m.inkTop, inkBottom: m.inkBottom, hero });
    cursor += item.width + gap;
  }
  return cells;
}

function runBlocks(env: Env, win: SpeechWindow, ats: readonly number[], size: number, inner: number, uu: number, hero: boolean): Block[] {
  const direction = cueDirection(win.cue);
  const gap = Math.max(adv(env, " ", size), 0.3 * size);
  const items: Item[] = ats.flatMap((at) => {
    const text = hero ? heroText(win, at) : win.cue.words[at]!.text;
    const width = adv(env, text, size);
    if (width <= inner) return [{ at, part: 0, parts: 1, text, width }];
    const parts = breakWord(env, text, size, inner);
    return parts.map((part, index) => ({ at, part: index, parts: parts.length, text: part, width: adv(env, part, size) }));
  });
  const rows = balancedRows(items.map((item) => item.width), gap, inner);
  return rows.map((row) => makeBlock(env, "row", placeRow(env, row.map((i) => items[i]!), size, gap, direction, hero), uu));
}

function planBlocks(env: Env, win: SpeechWindow, inner: number, uu: number): Block[] {
  const words = win.cue.words;
  const solo = words.length <= 2 && !words.some((word) => word.role === "hero");
  const bodySize = (solo ? SOLO : BODY) * uu;
  const blocks: Block[] = [];
  let run: number[] = [];
  const flush = () => {
    if (run.length) blocks.push(...runBlocks(env, win, run, bodySize, inner, uu, false));
    run = [];
  };
  words.forEach((word, at) => {
    if (word.role !== "hero") {
      run.push(at);
      return;
    }
    flush();
    const text = heroText(win, at);
    const per100 = adv(env, text, 100) / 100;
    const starred = Math.min(HERO_MAX, (inner / uu - 2 * STAR_GAP) / (per100 + 2 * STAR));
    if (starred >= HERO_MIN - 1e-6) {
      const size = Math.max(starred, HERO_MIN) * uu;
      const width = adv(env, text, size);
      const star = STAR * size;
      const m = env.input.measure(text, FACE, size, 0);
      blocks.push(makeBlock(env, "hero", [{ at, part: 0, parts: 1, text, size, x: 0, width, inkTop: m.inkTop, inkBottom: m.inkBottom, hero: true }], uu, { stars: { size: star, reach: width / 2 + STAR_GAP * uu + star / 2 }, textWidth: width }));
      return;
    }
    const plain = Math.min(HERO_MAX, inner / uu / per100);
    if (plain >= BODY) {
      const size = plain * uu;
      const width = adv(env, text, size);
      const m = env.input.measure(text, FACE, size, 0);
      blocks.push(makeBlock(env, "hero", [{ at, part: 0, parts: 1, text, size, x: 0, width, inkTop: m.inkTop, inkBottom: m.inkBottom, hero: true }], uu, { textWidth: width }));
      return;
    }
    blocks.push(...runBlocks(env, win, [at], BODY * uu, inner, uu, true));
  });
  flush();
  return blocks;
}

/** The paper's inner width a cue needs so that no word is broken: its widest word, or key word with its stars. */
function neededInner(env: Env, win: SpeechWindow, uu: number): number {
  const words = win.cue.words;
  const solo = words.length <= 2 && !words.some((word) => word.role === "hero");
  const bodySize = (solo ? SOLO : BODY) * uu;
  let need = 0;
  words.forEach((word, at) => {
    if (word.role === "hero") need = Math.max(need, adv(env, heroText(win, at), HERO_MIN * uu) + 2 * (STAR * HERO_MIN + STAR_GAP) * uu);
    else need = Math.max(need, adv(env, word.text, bodySize));
  });
  return need;
}

interface Limits {
  readonly bottomMax: number;
  readonly topRest: number;
  readonly topLimit: number;
  readonly hMax: number;
  readonly maxInner: number;
}

function limits(lane: Lane, uu: number): Limits {
  const zh = ZH * uu;
  const bottomMax = Math.min(lane.space.y(BOTTOM_MAX), lane.bounds.y2);
  const topLimit = Math.max(lane.bounds.y1 + zh, lane.space.y(TOP_LIMIT));
  const topRest = Math.max(lane.space.y(TOP_REST), topLimit);
  return { bottomMax, topRest, topLimit, hMax: bottomMax - zh - topLimit, maxInner: lane.bounds.x2 - lane.bounds.x1 - 2 * PAD_X * uu };
}

function layoutStrip(env: Env, wins: readonly SpeechWindow[], inner: number, uu: number): StripLayout {
  let y = PT * uu;
  const cues = wins.map((win, k): CueLayout => {
    const ruleY = k > 0 ? y : null;
    if (k > 0) y += RULEH * uu;
    const blocks = planBlocks(env, win, inner, uu);
    for (const block of blocks) {
      block.y = y;
      y += block.h;
    }
    return { win, blocks, ruleY };
  });
  return { cues, inner, pw: inner + 2 * PAD_X * uu, height: y + PB * uu, uu };
}

/** The strip for `wins`: base width, widened for long words, then (alone only) shrunk until it fits the band. */
function fitStrip(env: Env, lane: Lane, wins: readonly SpeechWindow[], shrink: boolean): StripLayout | null {
  let last: StripLayout | null = null;
  for (let k = 1; k > 0.3; k *= 0.92) {
    const uu = env.space.u * k;
    const lim = limits(lane, uu);
    const need = Math.max(...wins.map((win) => neededInner(env, win, uu)));
    const want = Math.min(lim.maxInner, Math.max(INNER0 * uu, need));
    for (const inner of new Set([want, lim.maxInner])) {
      last = layoutStrip(env, wins, inner, uu);
      if (last.height <= lim.hMax) return last;
    }
    if (!shrink) return null;
  }
  return last;
}

// ─── Time ────────────────────────────────────────────────────────────────────

interface Growth {
  readonly start: number;
  readonly dur: number;
  readonly h: number;
}

interface Timed {
  readonly lead0: number;
  readonly growths: Growth[];
  /** printFrom and wipeEnd per `${cue}:${block}:${cell}`. */
  readonly wipes: Map<string, { from: number; end: number }>;
  readonly blockGrowth: Map<string, Growth>;
  readonly ruleGrowth: Map<number, Growth>;
}

/** `still`: the strip paints on one frame only, so its paper is whole at once and its words print at once (a static plate under the ink). */
function timeStrip(env: Env, layout: StripLayout, lead0: number, still: boolean): Timed {
  const growths: Growth[] = [];
  const wipes = new Map<string, { from: number; end: number }>();
  const blockGrowth = new Map<string, Growth>();
  const ruleGrowth = new Map<number, Growth>();
  const { uu } = layout;
  layout.cues.forEach((cl, k) => {
    cl.blocks.forEach((block, b) => {
      let firstStart = Number.POSITIVE_INFINITY;
      block.cells.forEach((cell, c) => {
        const word = cl.win.cue.words[cell.at]!;
        const from = Math.max(lead0, word.startMs - WIPE_LEAD);
        const last = exportFrameAtOrBefore(word.endMs - 1, env.fps);
        // A word that cannot start its wipe before its onset, or has no two frames to wipe in, prints at once.
        const end = still || from >= word.startMs || paintedFrameCount(from, last, env.fps) < 2 ? from : Math.max(from, Math.min(from + WIPE, last));
        wipes.set(`${k}:${b}:${c}`, { from, end });
        firstStart = Math.min(firstStart, word.startMs);
      });
      const start = still ? lead0 : Math.max(lead0, firstStart - PRINT_LEAD);
      // The paper is in place by the block's first spoken word, so ink never prints on bare video.
      const dur = still ? 0 : Math.max(0, Math.min(GROW, firstStart - start));
      const growth = { start, dur, h: block.h };
      blockGrowth.set(`${k}:${b}`, growth);
      growths.push(growth);
      if (b === 0) {
        if (k === 0) growths.push({ start, dur, h: (PT + PB) * uu });
        else {
          const rule = { start, dur, h: RULEH * uu };
          ruleGrowth.set(k, rule);
          growths.push(rule);
        }
      }
    });
  });
  return { lead0, growths, wipes, blockGrowth, ruleGrowth };
}

const heightAt = (growths: readonly Growth[], t: number) => growths.reduce((sum, g) => sum + g.h * EASES.out(prog(t, g.start, g.dur)), 0);

/** Frames of `frames` between `from` and `to`, ends included. */
function slice(frames: Frames, from: number, to: number): Frames {
  const out: [number, number][] = [[from, kf(from, frames)]];
  for (const [at, value] of frames) if (at > from && at < to) out.push([at, value]);
  if (to > from) out.push([to, kf(to, frames)]);
  return out;
}

const offset = (frames: Frames, by: number): Frames => frames.map(([at, value]) => [at, value + by] as const);

// ─── The program ─────────────────────────────────────────────────────────────

interface StripPlan {
  readonly wins: SpeechWindow[];
  readonly lane: Lane;
  /** Set when a fresh strip follows in the lane and there is room to tear this one off first: where this strip ends, and where the next one starts. */
  endAt?: number;
  leadAt?: number;
}

const DEFAULT_STAR = "#E8452B";

/**
 * Ink is drawn on the paper, stars on the paper and on the thermal flash behind a row; the flash is the paper warmed by the sample's red
 * (not by the brand's stars, so it is a constant the brand map can list in `readsOn`). A colour the shared 3:1 rule accepts is painted as
 * given; only one that fails it (a preset colour set by hand) falls back to near-black or white.
 */
function palette(input: SceneInput) {
  const paper = input.colours.accent;
  const band = mixColour(paper, DEFAULT_STAR, 0.16);
  const onPaper = (colour: string) => captionColourContrast(colour, paper) >= CAPTION_SCENE_BRAND_MIN_CONTRAST;
  const onFlash = (colour: string) => onPaper(colour) && captionColourContrast(colour, band) >= CAPTION_SCENE_BRAND_MIN_CONTRAST;
  const dark = "#17171C";
  const ink = [input.colours.primary, dark, "#FFFFFF"].find(onPaper) ?? (captionColourContrast(dark, paper) >= captionColourContrast("#FFFFFF", paper) ? dark : "#FFFFFF");
  const star = [input.colours.highlight, DEFAULT_STAR, ink].find(onFlash) ?? ink;
  return { paper, ink, star, rule: mixColour(paper, ink, 0.45), band };
}

export const receiptProgram: SceneProgram = {
  build(input) {
    const fps = input.fps ?? SCENE_DEFAULT_FPS;
    const space = sceneSpace(input, ANCHOR);
    const env: Env = { input, fps, space, ...palette(input) };
    const windows = speechWindows(input, space.safe, WINDOW_LEAD, HOLD);
    const laneOf = (win: SpeechWindow): Lane => ({ space: speechLaneSpace(space, win.bounds, ANCHOR), bounds: win.bounds });

    // Group cues into strips: same lane, no overlapping speech, no long silence, and the paper still fits the band.
    const strips: StripPlan[] = [];
    const open = new Map<number, StripPlan>();
    let ruleCount = 0;
    for (const win of windows) {
      const lane = laneOf(win);
      const current = open.get(win.lane);
      const previous = current?.wins.at(-1);
      let join = false;
      if (current && previous && win.start >= previous.spokenEnd && win.start - previous.spokenEnd < BREAK_GAP
        && previous.bounds.y1 === win.bounds.y1 && previous.bounds.y2 === win.bounds.y2) {
        const grown = fitStrip(env, lane, [...current.wins, win], false);
        const now = fitStrip(env, lane, current.wins, true);
        const roomy = now !== null && now.height > PREFER_BREAK_FILL * limits(lane, now.uu).hMax && win.start - previous.spokenEnd >= PREFER_BREAK_GAP;
        join = grown !== null && !roomy;
      }
      if (join && current) current.wins.push(win);
      else {
        const plan = { wins: [win], lane };
        strips.push(plan);
        open.set(win.lane, plan);
      }
    }

    // A strip followed by another in its lane is torn off if the gap holds the reading hold and two painted frames of tear:
    // the fresh paper then starts later than its usual lead (never past its first word) so the two never share the band.
    const lastInLane = new Map<number, StripPlan>();
    for (const plan of strips) {
      const before = lastInLane.get(plan.wins[0]!.lane);
      lastInLane.set(plan.wins[0]!.lane, plan);
      const tail = before?.wins.at(-1);
      if (!before || !tail || tail.bounds.y1 !== plan.wins[0]!.bounds.y1 || tail.bounds.y2 !== plan.wins[0]!.bounds.y2) continue;
      const startNext = plan.wins[0]!.start;
      const natural = Math.min(Math.max(tail.cue.endMs, tail.spokenEnd), tail.spokenEnd + LINGER);
      const cut = Math.min(natural, startNext - SUCCESSOR_LEAD);
      const earliest = tail.spokenEnd + HOLD;
      if (cut < earliest || paintedFrameCount(Math.max(earliest, cut - TEAR_MS), cut, fps) < 2) continue;
      before.endAt = cut;
      plan.leadAt = Math.max(startNext - PRINT_LEAD, cut);
    }

    const pieces: Piece[] = [];
    for (const plan of strips) {
      const layout = fitStrip(env, plan.lane, plan.wins, true)!;
      pieces.push(...buildStrip(env, plan, layout, ruleCount));
      ruleCount += plan.wins.length - 1;
    }
    return { pieces };
  },
};

function buildStrip(env: Env, plan: StripPlan, layout: StripLayout, ruleBase: number): Piece[] {
  const { input, fps } = env;
  const { uu, pw, inner } = layout;
  const first = plan.wins[0]!;
  const last = plan.wins.at(-1)!;
  const owner = first.index;
  const lim = limits(plan.lane, uu);
  const cx = Math.min(plan.lane.bounds.x2 - pw / 2, Math.max(plan.lane.bounds.x1 + pw / 2, env.space.x(540)));
  const lead0 = plan.leadAt ?? Math.max(first.from, first.start - PRINT_LEAD);
  const total = layout.height;
  const rtl = cueDirection(last.cue) === "rtl";
  const side = rtl ? -1 : 1;

  const end = Math.max(lead0 + 1, plan.endAt ?? Math.min(last.to, last.spokenEnd + LINGER));
  const earliest = last.spokenEnd + HOLD;
  const tearStart = Math.max(earliest, end - TEAR_MS);
  const tears = end > earliest && paintedFrameCount(tearStart, end, fps) >= 2;
  const liveEnd = tears ? tearStart : end;
  const still = paintedFrameCount(lead0, liveEnd, fps) < 2;
  const timed = timeStrip(env, layout, lead0, still);

  const H = (t: number) => heightAt(timed.growths, t);
  const topAt = (t: number) => Math.min(lim.topRest, lim.bottomMax - ZH * uu - H(t));
  const edges = [lead0, liveEnd, ...timed.growths.flatMap((g) => [g.start, g.start + g.dur])].filter((t) => t >= lead0 && t <= liveEnd);
  // Where the paper first reaches the bottom of the band and starts to slide: a kink the sampler must see.
  const reach = lim.bottomMax - ZH * uu - lim.topRest;
  if (H(liveEnd) > reach && H(lead0) < reach) {
    let lo = lead0;
    let hi = liveEnd;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (H(mid) < reach) lo = mid;
      else hi = mid;
    }
    edges.push(lo);
  }
  const topFrames = sampleFrames(topAt, edges, 0.12, { range: [lead0, liveEnd], simplify: true });
  const bottomFrames = sampleFrames((t) => topAt(t) + H(t), edges, 0.12, { range: [lead0, liveEnd], simplify: true });
  const growFrames = sampleFrames((t) => H(t) / total, edges, 0.0015, { range: [lead0, liveEnd], simplify: true });

  const out: Piece[] = [];
  const tearable = new Set<Piece>();
  const id = (cue: number, name: string) => `receipt:${cue}:${name}`;
  const add = (piece: Piece, tear = true) => {
    out.push(piece);
    if (tear) tearable.add(piece);
  };
  const yTrack = (from: number, to: number, rel: number): Frames => offset(slice(topFrames, from, to), rel);

  // Paper: shadows underneath everything (so a join never darkens the paper), then the paper itself.
  // One soft shadow from the body only (a blurred copy is what a frame pays for, and a sliding strip re-rasterises it every frame).
  const shadows = [{ dx: 0, dy: 12 * uu, blur: 6 * uu, colour: "#462D14", alpha: 0.32 }];
  const teeth = Math.max(2, Math.round(pw / (ZT * uu)));
  const tooth = pw / teeth;
  const zig = (down: boolean): PathCmd[] => {
    const base = (down ? -0.5 : 0.5) * uu;
    const tip = down ? ZH * uu : -ZH * uu;
    const pts: [number, number][] = [[-pw / 2, base], [pw / 2, base]];
    for (let i = 0; i < teeth; i++) pts.push([pw / 2 - (i + 0.5) * tooth, tip], [pw / 2 - (i + 1) * tooth, base]);
    return polygonPath(pts);
  };
  const body = rectPath(-pw / 2, 0, pw, total);
  const paperTracks = {
    body: { x: [[lead0, cx]] as Frames, y: slice(topFrames, lead0, liveEnd), sy: growFrames },
    top: { x: [[lead0, cx]] as Frames, y: slice(topFrames, lead0, liveEnd) },
    bottom: { x: [[lead0, cx]] as Frames, y: slice(bottomFrames, lead0, liveEnd) },
  };
  const paper = (name: string, z: number, path: PathCmd[], track: ShapePiece["track"], shade: ShapePiece["shadows"] | null): ShapePiece => ({
    id: id(owner, name), kind: "shape", z, fromMs: lead0, toMs: liveEnd, path, fill: { colour: env.paper }, track, ...(shade ? { shadows: shade } : {}),
  });
  add(paper("shadow", 1, body, paperTracks.body, shadows));
  add(paper("paper", 2, body, paperTracks.body, null));
  // A strip that paints on a single frame is a static plate under its ink: no torn ends to draw.
  if (!still) {
    add(paper("zt", 2, zig(false), paperTracks.top, null));
    add(paper("zb", 2, zig(true), paperTracks.bottom, null));
  }

  const strokeW = 0.75 * uu;
  layout.cues.forEach((cl, k) => {
    const cue = cl.win.cue;
    const ci = cl.win.index;
    const key = hash(`${ci}:${cue.words.map((word) => word.text).join(" ")}`);

    // The rule struck between cues: dots, or every third a barcode.
    if (cl.ruleY !== null) {
      const at = Math.max(lead0, cue.words[0]!.startMs - 60);
      const barcode = (ruleBase + k - 1) % 3 === 2;
      const path: PathCmd[] = [];
      let length: number;
      if (barcode) {
        length = Math.min(inner, 0.6 * inner);
        let x = -length / 2;
        let n = 0;
        while (x < length / 2 - 8 * uu) {
          const w = (2 + (hash(`${key}:b${n}`) % 6)) * uu;
          path.push(...rectPath(x, -11 * uu, Math.min(w, length / 2 - x), 22 * uu));
          x += w + (2 + (hash(`${key}:g${n}`) % 4)) * uu;
          n++;
        }
      } else {
        const count = Math.max(2, Math.floor(inner / (20 * uu)));
        length = count * 20 * uu - 14 * uu;
        for (let i = 0; i < count; i++) path.push(...rectPath(-length / 2 + i * 20 * uu, -3 * uu, 6 * uu, 6 * uu));
      }
      const rel = cl.ruleY + RULEH * uu / 2;
      const wipeEnd = Math.min(at + 260, liveEnd);
      const p = (t: number) => EASES.outQuint(prog(t, at, wipeEnd - at));
      const half = 14 * uu;
      const x1 = rtl
        ? sampleFrames((t) => cx + length / 2 - p(t) * length, [at, wipeEnd], 0.3, { range: [at, wipeEnd] })
        : ([[at, cx - length / 2]] as Frames);
      const x2 = rtl ? ([[at, cx + length / 2]] as Frames) : sampleFrames((t) => cx - length / 2 + p(t) * length, [at, wipeEnd], 0.3, { range: [at, wipeEnd] });
      const yc = yTrack(at, liveEnd, rel);
      add({
        id: id(ci, "rule"), kind: "shape", z: 3, fromMs: at, toMs: liveEnd, path, fill: { colour: env.rule },
        track: { x: [[at, cx]], y: yc }, clip: { x1, x2, y1: offset(yc, -half), y2: offset(yc, half) },
      });
    }

    cl.blocks.forEach((block, b) => {
      const growth = timed.blockGrowth.get(`${k}:${b}`)!;
      const firstWord = Math.min(...block.cells.map((cell) => cue.words[cell.at]!.startMs));

      // The thermal band: a warm flash behind the row as it prints.
      const bandFrom = Math.max(lead0, firstWord - WIPE_LEAD);
      const bandTo = Math.min(liveEnd, firstWord + 420);
      if (bandTo > bandFrom) {
        const bandGrow = sampleFrames((t) => EASES.out(prog(t, growth.start, growth.dur)), [growth.start, growth.start + growth.dur], 0.01, { range: [bandFrom, bandTo] });
        add({
          id: id(ci, `band${b}`), kind: "shape", z: 3, fromMs: bandFrom, toMs: bandTo, path: rectPath(-inner / 2, 0, inner, block.h), fill: { colour: env.band },
          track: { x: [[bandFrom, cx]], y: yTrack(bandFrom, bandTo, block.y), sy: bandGrow, o: [[bandFrom, 0], [bandFrom + 90, 0.85, "out"], [bandTo, 0, "in"]] },
        }, false);
      }

      block.cells.forEach((cell, c) => {
        const wipe = timed.wipes.get(`${k}:${b}:${c}`)!;
        const rel = block.y + cell.baseline;
        const top = block.y + cell.baseline + cell.inkTop - 4 * uu;
        const bottom = block.y + cell.baseline + cell.inkBottom + 4 * uu;
        const wipeP = (t: number) => (wipe.end > wipe.from ? EASES.outQuint(prog(t, wipe.from, wipe.end - wipe.from)) : t >= wipe.from ? 1 : 0);
        const clipEdges = [...edges, wipe.from, wipe.end].filter((t) => t >= wipe.from && t <= liveEnd);
        const y1 = offset(slice(topFrames, wipe.from, liveEnd), top);
        const y2 = sampleFrames((t) => Math.min(topAt(t) + top + wipeP(t) * (bottom - top), topAt(t) + H(t)), clipEdges, 0.15, { range: [wipe.from, liveEnd], simplify: true });
        const name = cell.parts > 1 ? `w${cell.at}l${cell.part}` : `w${cell.at}`;
        const face: TextPiece = {
          id: id(ci, name), kind: "text", z: 6, fromMs: wipe.from, toMs: liveEnd, text: cell.text, face: FACE, sizePx: cell.size, letterSpacingEm: 0,
          fill: env.ink, ...(cell.hero ? { stroke: { widthPx: strokeW, colour: env.ink } } : {}), anchor: "baseline-center", language: cue.language,
          track: { x: [[wipe.from, cx + cell.x]], y: yTrack(wipe.from, liveEnd, rel) },
          clip: { x1: [[wipe.from, cx - pw / 2]], x2: [[wipe.from, cx + pw / 2]], y1, y2 },
        };
        add(face);
      });

      if (block.kind !== "hero") return;
      const cell = block.cells[0]!;
      const word = cue.words[cell.at]!;
      const centre = block.y + block.h / 2;
      if (block.stars) {
        const star = block.stars;
        for (const [name, dir, delay] of [["l", -1, -20], ["r", 1, 60]] as const) {
          const from = Math.max(lead0, word.startMs + delay);
          const to = liveEnd;
          if (to <= from) continue;
          const settle = Math.min(from + 420, to);
          add({
            id: id(ci, `star${cell.at}${name}`), kind: "shape", z: 5, fromMs: from, toMs: to, path: starPath(5, star.size * 0.96 / 2, star.size * 0.42 / 2), fill: { colour: env.star },
            track: { x: [[from, cx + dir * star.reach]], y: yTrack(from, to, centre), sx: [[from, 0], [settle, 1, "spring"]], sy: [[from, 0], [settle, 1, "spring"]], rz: [[from, dir * 120], [settle, 0, "spring"]] },
          });
        }
      }
      if (block.textWidth && cell.parts === 1) {
        const w = block.textWidth;
        const from = Math.max(lead0, word.startMs);
        const to = liveEnd;
        if (to > from) {
          const baseline = block.y + (block.barRel ?? cell.baseline + 0.22 * cell.size);
          const path = [...rectPath(rtl ? -w : 0, 0, w, 4 * uu), ...rectPath(rtl ? -w : 0, 7 * uu, w, 2 * uu)];
          const grow = Math.min(from + 260, to);
          add({
            id: id(ci, `bar${cell.at}`), kind: "shape", z: 4, fromMs: from, toMs: to, path, fill: { colour: env.ink },
            track: { x: [[from, cx + (rtl ? w / 2 : -w / 2)]], y: yTrack(from, to, baseline), sx: [[from, 0], [grow, 1, "outExpo"]] },
          });
        }
      }
    });
  });

  // The tear: every strip piece again as a flying copy, rotated about the strip's top centre and flung to the side.
  const result: Piece[] = [];
  const plate = (piece: Piece) => piece.id === id(owner, "paper") || piece.id === id(owner, "shadow");
  const kept = out.filter((piece) => piece.kind === "text" || plate(piece) || hasTwoPaintedFrames(piece, input));
  result.push(...kept);
  if (tears) {
    const px = cx;
    const py = topAt(liveEnd);
    const tear = (t: number) => EASES.in(prog(t, tearStart, end - tearStart));
    const angle = (t: number) => side * TEAR_DEG * tear(t);
    for (const piece of kept) {
      if (!tearable.has(piece)) continue;
      const pose = evaluatePiece(piece, tearStart);
      const dx = pose.x - px;
      const dy = pose.y - py;
      const at = (t: number, axis: "x" | "y") => {
        const r = (angle(t) * Math.PI) / 180;
        const turned = axis === "x" ? dx * Math.cos(r) - dy * Math.sin(r) : dx * Math.sin(r) + dy * Math.cos(r);
        return axis === "x" ? px + side * TEAR_DX * uu * tear(t) + turned : py + turned;
      };
      const range = { range: [tearStart, end] as [number, number] };
      const track = {
        x: sampleFrames((t) => at(t, "x"), [tearStart, end], 0.3, range),
        y: sampleFrames((t) => at(t, "y"), [tearStart, end], 0.3, range),
        rz: sampleFrames((t) => pose.rz + angle(t), [tearStart, end], 0.15, range),
        ...(pose.sx !== 1 ? { sx: [[tearStart, pose.sx]] as Frames } : {}),
        ...(pose.sy !== 1 ? { sy: [[tearStart, pose.sy]] as Frames } : {}),
        ...(pose.o !== 1 ? { o: [[tearStart, pose.o]] as Frames } : {}),
      };
      const { clip: _clip, ...rest } = piece;
      void _clip;
      const name = piece.id.split(":").slice(2).join(":");
      result.push({ ...rest, id: `receipt:${piece.id.split(":")[1]}:tear${name.replace(/^w/, "")}`, fromMs: tearStart, toMs: end, bleed: true, track } as Piece);
    }
  }
  return result;
}

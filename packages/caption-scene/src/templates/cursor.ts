import type { DemoScript } from "../demo";
import { EASES, type Frames, prog } from "../ease";
import { sampleFrames } from "../frames";
import type { SceneCue, SceneInput, SceneProgram } from "../input";
import { clampToSafeArea, cueDirection, fitScale, greedyRows, sceneSpace } from "../layout";
import type { Clip, PathCmd, Piece, ShapePiece, TextPiece } from "../scene";
import { arcPath, ellipsePath, pathBounds, polylinePath, rectPath, roundedRectPath } from "../shapes";

/**
 * Cursor (`samples/templates/m03-cursor.js`): every cue is a small app-style card (white, then black, then white...) that
 * grows toward the end of the line as each word is spoken and squashes away when the cue ends. Bold sans words rise out of
 * a mask as they are spoken; three traffic-light dots pop in the card's corner; the key word turns into an italic serif on a
 * yellow chip that a mouse pointer drags open; and one UI sticker (a power toggle or a pointer tile) pops on the card's
 * corner.
 *
 * Geometry is the sample's, read in Chrome (`.scratch/motion-captions/tools/probe-sample.ts`): a flex-wrap card of
 * `max-width 920` padded 58 / 50 / 40 / 50 px, words 20 px apart in rows 6 px apart, Inter Tight ExtraBold 76 px
 * (-0.035 em) in 96 px slits (baseline 66 px into the line box), the hero Instrument Serif italic 112 px (-0.015 em,
 * `line-height: .92`) on a chip that is the box 20 px wider each side and 4 px under its top, the card centred on y 1290.
 * The card's reach is the sample's growth steps (`outExpo`, 240 ms, one per word at `start - 70`, one per hero at `start - 260`).
 *
 * Changes from the sample, and why:
 * - The invented "click" label on the tile sticker is gone: the tile is the pointer arrow with three click ticks (shapes only).
 * - The card is a rounded rectangle that grows, drawn as two bands and four corner discs (`morph`), so its right end stays
 *   round at every width (a clipped full-size card would show a square end for most of the cue). It appears once it is two
 *   corner radii wide (the sample's 44 px threshold hides the card at a width its radius cannot draw) and the exit squashes
 *   it as a rounded rectangle (the sample clips a rounded one).
 * - Stickers and card colours cycle by a per-kind counter (toggle, tile, toggle... for hero cues; tile first for cues with
 *   no hero) and the rest tilt and offset of each sticker come from a hash of the cue; a cue with no hero gets a sticker too
 *   (on its middle word), so the card's signature motion recurs on every cue. Only the first hero word of a cue gets the chip.
 * - The sticker hangs off the card's growing end and is kept 95 px inside the safe area (the sample's reaches x 1038).
 * - The exit (155 ms before the cue's end, 100 ms long) waits until the last word has landed and been readable for 150 ms,
 *   so real speech (about 60 ms between cues) never hides a word that has just arrived; it never starts after the cue's end
 *   (overlapping speakers leave at the next start) and is cut short to 40 ms there, so it overlaps the next card's entrance at most a little.
 * - The card's 50 px box-shadow is one blurred rectangle (sigma 14 px, 22 px lower), cheaper than a shadow on each of the card's six parts.
 * - A right-to-left cue mirrors: the card grows from the right, rows run from the right, the dots sit top right, the chip is
 *   dragged right to left. Words are never split.
 */

export const CURSOR_DEMO: DemoScript = {
  lines: [
    "most:m people:b don't:b need:b more:b time",
    "they:m need:b fewer:h@560 tabs:b open",
    "close:b everything",
    "then:m pick:b one:h@520 thing",
    "and:m finish:h@620 it",
  ],
  options: { rate: 270 },
};

const ANCHOR_Y = 1290;
const BODY_FACE = "Inter Tight ExtraBold" as const;
const HERO_FACE = "Instrument Serif" as const;
const BODY_FS = 76;
const HERO_FS = 112;
const BODY_LS = -0.035;
const HERO_LS = -0.015;
/** Chrome's baseline offsets inside the line boxes: 66 of 76 px (Inter Tight), 89 of 112 px (Instrument Serif at `line-height: .92`). */
const BODY_BASE = 66 / 76;
const HERO_BASE = 89 / 112;
const BODY_SLIT_H = 96;
const BODY_TEXT_TOP = 6;
const BODY_SLIT_PAD = 4;
const HERO_TEXT_H = 0.92 * HERO_FS;
const HERO_ITEM_H = 4 + HERO_TEXT_H + 10;
const HERO_PAD = 20;
const HERO_MARGIN = -2;
const HERO_SLIT_PAD = 6;
const CHIP_TOP = 4;
const CHIP_R = 18;
const PAD_X = 50;
const PAD_Y = 40;
const PAD_TOP = 58;
const COL_GAP = 20;
const ROW_GAP = 6;
const CARD_MAX = 920;
const CARD_R = 34;
const DOT = { x: 52, y: 26, step: 30, r: 9 } as const;
const DOT_COLOURS = ["#FF5F57", "#FEBC2E", "#28C840"] as const;
const DRAG_LEAD = 260;
const GROW = 240;
const EXIT_AT = 155;
const EXIT = 100;
const RISE = 360;
const HERO_RISE = 420;
const POINTER_SCALE = 46 / 40;
const POINTER_PATH: readonly [number, number][] = [[2, 2], [2, 46], [13, 36], [21, 55], [29, 51], [21, 33], [36, 33]];
const CHIP_COLOUR = "#F5C518";
const TOGGLE = "#7B3FF2";
const TILE = "#FF5A1F";
const INK = "#111111";
const WHITE = "#FFFFFF";
/** A word counts as landed once its rise is 95 % done (`outExpo` at 43 % of its time). */
const LAND_SHARE = 0.432;
const READ_MS = 150;
const STICKER_POP = 440;
const STICKER_BOX = 150;
const STICKER_MARGIN = 95;

type Fn = (t: number) => number;
type Kind = "toggle" | "tile";

/** FNV-1a of a string as a number in [0, 1): the deterministic jitter every per-cue variation derives from. */
export function cursorHash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 4294967296;
}

/** The sample's card growth: each step lifts the card's width (and height) to the item's far edge over 240 ms (`outExpo`). */
export interface CursorStep {
  readonly at: number;
  readonly dw: number;
  readonly dh: number;
}

export function cursorGrowth(steps: readonly CursorStep[], h0: number, t: number): { width: number; height: number } {
  let width = 0;
  let height = h0;
  for (const step of steps) {
    const e = EASES.outExpo(prog(t, step.at, GROW));
    width += step.dw * e;
    height += step.dh * e;
  }
  return { width, height };
}

/** A path moved so its box starts at (0, 0), with the pivot (the path's own (0, 0)) as `origin`: libass places a drawing by its box. */
function anchored(path: readonly PathCmd[]): { path: PathCmd[]; origin: { dx: number; dy: number } } {
  const box = pathBounds(path);
  const moved = path.map((cmd): PathCmd => {
    if (cmd[0] === "Z") return cmd;
    if (cmd[0] === "C") return ["C", cmd[1] - box.x1, cmd[2] - box.y1, cmd[3] - box.x1, cmd[4] - box.y1, cmd[5] - box.x1, cmd[6] - box.y1];
    return [cmd[0], cmd[1] - box.x1, cmd[2] - box.y1];
  });
  return { path: moved, origin: { dx: -box.x1, dy: -box.y1 } };
}

interface Item {
  readonly index: number;
  readonly hero: boolean;
  /** The text's CSS box width (advance plus the trailing letter spacing). */
  readonly textW: number;
  /** The flex item's margin-box width and height. */
  readonly w: number;
  readonly h: number;
  /** Flow position: distance from the card's leading edge to the margin box, and from the card's top to the item's top. */
  p: number;
  top: number;
  /** How far the card has to reach to hold the item (the sample's `offsetLeft + offsetWidth + PAD_X`, `offsetTop + offsetHeight + PAD_Y`). */
  reach: number;
  bottom: number;
  at: number;
}

function buildCue(cue: SceneCue, cueNumber: number, counters: { hero: number; plain: number }, input: SceneInput): Piece[] {
  const space = sceneSpace(input, ANCHOR_Y);
  const { u, canvas } = space;
  const dir = cueDirection(cue) === "rtl" ? -1 : 1;
  const dark = cueNumber % 2 === 1;
  const cardColour = dark ? input.colours.accent : input.colours.primary;
  const inkColour = dark ? input.colours.primary : input.colours.accent;
  const band = cueNumber * 10;
  const heroAt = cue.words.findIndex((word) => word.role === "hero");

  // --- fit: the card holds rows of at most 920 sample px (padding included); a word wider than a row shrinks the whole card ---
  const cardMax = Math.min(CARD_MAX * u, 0.9 * canvas.width);
  const textWidth = (word: SceneCue["words"][number], hero: boolean, k: number) => {
    const face = hero ? HERO_FACE : BODY_FACE;
    const fs = (hero ? HERO_FS : BODY_FS) * k;
    const ls = hero ? HERO_LS : BODY_LS;
    return input.measure(word.text, face, fs, ls).advance + ls * fs;
  };
  const flowWidth = (word: SceneCue["words"][number], hero: boolean, k: number) => textWidth(word, hero, k) + (hero ? 2 * (HERO_PAD + HERO_MARGIN) * k : 0);
  const widest = Math.max(...cue.words.map((word, at) => flowWidth(word, at === heroAt, u)));
  const room = Math.max(0.2 * u * CARD_MAX, cardMax - 2 * PAD_X * u);
  const fit = fitScale(widest, room);
  const f = fit < 1 ? fit * 0.995 : 1;
  const k = u * f;

  // --- the flow: items in reading order from the leading edge, wrapped greedily like the sample's flex-wrap ---
  const items: Item[] = cue.words.map((word, index) => {
    const hero = index === heroAt;
    const textW = textWidth(word, hero, k);
    return {
      index,
      hero,
      textW,
      w: flowWidth(word, hero, k),
      h: (hero ? HERO_ITEM_H : BODY_SLIT_H) * k,
      p: 0,
      top: 0,
      reach: 0,
      bottom: 0,
      at: hero ? word.startMs - DRAG_LEAD : word.startMs - 70,
    };
  });
  const contentMax = Math.max(cardMax - 2 * PAD_X * k, 1);
  const rows = greedyRows(items.map((item) => item.w), COL_GAP * k, contentMax);
  let cursorY = PAD_TOP * k;
  let rightmost = 0;
  rows.forEach((row, rowAt) => {
    const rowH = Math.max(...row.map((at) => items[at]!.h));
    let x = PAD_X * k;
    for (const at of row) {
      const item = items[at]!;
      item.p = x;
      item.top = cursorY + (rowH - item.h) / 2;
      // The body slit reaches 4 px past its text, the hero box 38 px past it (box 40 px wider, margin -2 px).
      const nodeRight = item.hero ? x + item.textW + (2 * HERO_PAD + HERO_MARGIN) * k : x + item.textW + BODY_SLIT_PAD * k;
      item.reach = nodeRight + PAD_X * k;
      item.bottom = item.top + item.h + PAD_Y * k;
      rightmost = Math.max(rightmost, nodeRight);
      x += item.w + COL_GAP * k;
    }
    cursorY += rowH + (rowAt < rows.length - 1 ? ROW_GAP * k : 0);
  });
  const cardW = Math.ceil(rightmost + PAD_X * k);
  const cardH = Math.round(cursorY + PAD_Y * k);
  const cx = space.x(540);
  const left = cx - cardW / 2;
  const right = left + cardW;
  const top = space.y(ANCHOR_Y) - cardH / 2;
  /** Canvas x range of a span `[a, b]` measured from the card's leading edge. */
  const span = (a: number, b: number): [number, number] => (dir > 0 ? [left + a, left + b] : [right - b, right - a]);

  // --- growth steps and the cue's windows ---
  const order = [...items].sort((a, b) => a.at - b.at);
  order[0]!.at += 40;
  let prevW = 0;
  let prevH = 0;
  const steps: CursorStep[] = order.map((item) => {
    const nw = Math.max(prevW, item.reach);
    const nh = Math.max(prevH, item.bottom);
    const step = { at: item.at, dw: nw - prevW, dh: nh - prevH };
    prevW = nw;
    prevH = nh;
    return step;
  });
  (steps[0] as { dh: number }).dh = 0;
  const h0 = order[0]!.bottom;
  const firstAt = steps[0]!.at;

  const heroItem = heroAt >= 0 ? items[heroAt]! : null;
  const lastLand = Math.max(
    ...items.map((item) => (item.hero ? cue.words[item.index]!.startMs - 60 + LAND_SHARE * HERO_RISE : cue.words[item.index]!.startMs - 70 + LAND_SHARE * RISE)),
  );
  // The exit waits for the last word to be readable, but never starts after the cue's end (overlapping speakers leave at the next
  // cue's start): then it is cut short so it is over 40 ms after that.
  const exitFrom = Math.min(Math.max(cue.endMs - EXIT_AT, Math.ceil(lastLand + READ_MS)), cue.endMs);
  const exitDur = Math.min(EXIT, Math.max(40, cue.endMs + 40 - exitFrom));
  const exitTo = exitFrom + exitDur;
  const squash: Fn = (t) => EASES.out(prog(t, exitFrom, exitDur));
  const grown: Fn = (t) => cursorGrowth(steps, h0, t).width;
  const grownH: Fn = (t) => cursorGrowth(steps, h0, t).height;
  const width: Fn = (t) => grown(t) * (1 - squash(t));
  const cardX1: Fn = (t) => (dir > 0 ? left : right - width(t));
  const cardX2: Fn = (t) => (dir > 0 ? left + width(t) : right);
  const cardY1: Fn = (t) => top + (squash(t) * grownH(t)) / 2;
  const cardY2: Fn = (t) => top + grownH(t) - (squash(t) * grownH(t)) / 2;

  const r = CARD_R * k;
  let tOn = Math.ceil(firstAt - 10);
  while (tOn < exitTo && width(tOn) < 2 * r + 1) tOn++;
  let tOff = Math.max(tOn + 1, Math.floor(exitFrom));
  while (tOff < exitTo && width(tOff) >= 2 * r + 1 && cardY2(tOff) - cardY1(tOff) >= 2 * r + 1) tOff++;
  if (tOff <= tOn) return [];

  // The times where any motion changes slope: the sampler splits between them.
  const edges = new Set<number>([tOn, tOff, exitFrom, exitTo]);
  for (const step of steps) {
    edges.add(step.at);
    edges.add(step.at + GROW);
  }
  const bump = (...times: number[]) => {
    for (const t of times) edges.add(t);
  };
  const sample = (fn: Fn, from: number, to: number, tolerance: number): Frames =>
    sampleFrames(fn, [from, ...[...edges].filter((edge) => edge > from && edge < to), to], tolerance, { simplify: true });

  const pieces: Piece[] = [];

  /** The card's clip intersected with a rectangle (functions or numbers): never inverted. */
  type Edge = number | Fn;
  const at = (edge: Edge, t: number) => (typeof edge === "number" ? edge : edge(t));
  const clipRect = (rect: { x1: Edge; x2: Edge; y1: Edge; y2: Edge }) => {
    const fx1: Fn = (t) => Math.max(at(rect.x1, t), cardX1(t));
    const fx2: Fn = (t) => Math.max(fx1(t), Math.min(at(rect.x2, t), cardX2(t)));
    const fy1: Fn = (t) => Math.max(at(rect.y1, t), cardY1(t));
    const fy2: Fn = (t) => Math.max(fy1(t), Math.min(at(rect.y2, t), cardY2(t)));
    return { fx1, fx2, fy1, fy2 };
  };
  /** The window in which the clipped rectangle has at least a pixel to show, inside `[from, to]`. */
  const visibleWindow = (c: ReturnType<typeof clipRect>, from: number, to: number): [number, number] | null => {
    let a = Math.ceil(from);
    const shows = (t: number) => c.fx2(t) - c.fx1(t) >= 1 && c.fy2(t) - c.fy1(t) >= 1;
    while (a < to && !shows(a)) a++;
    if (a >= to) return null;
    let b = a + 1;
    while (b < to && shows(b)) b++;
    return [a, Math.min(b, Math.floor(to))];
  };
  const clipFrames = (c: ReturnType<typeof clipRect>, from: number, to: number): Clip => ({
    x1: sample(c.fx1, from, to, 0.3),
    x2: sample(c.fx2, from, to, 0.3),
    y1: sample(c.fy1, from, to, 0.3),
    y2: sample(c.fy2, from, to, 0.3),
  });

  /**
   * A rounded rectangle whose four edges are functions of time (the sample's clipped, growing boxes): a vertical band, a
   * horizontal band and four corner discs, each tracking the edges. Shapes are drawn from their own top-left so a scale or a move
   * keeps libass's box alignment.
   */
  const morph = (part: string, z: number, fill: string, radius: number, rect: { x1: Fn; x2: Fn; y1: Fn; y2: Fn }, maxW: number, maxH: number, from: number, to: number, clip?: Clip) => {
    const base = { kind: "shape" as const, z, fromMs: from, toMs: to, fill: { colour: fill }, ...(clip ? { clip } : {}) };
    const w = maxW - 2 * radius;
    const track = (fn: Fn, tolerance = 0.25) => sample(fn, from, to, tolerance);
    pieces.push({
      ...base,
      id: `cursor:${cueNumber}:${part}-v`,
      track: { x: track((t) => rect.x1(t) + radius), y: track(rect.y1), sx: track((t) => (rect.x2(t) - rect.x1(t) - 2 * radius) / w, 0.002), sy: track((t) => (rect.y2(t) - rect.y1(t)) / maxH, 0.002) },
      path: rectPath(0, 0, w, maxH),
    });
    const hh = maxH - 2 * radius;
    pieces.push({
      ...base,
      id: `cursor:${cueNumber}:${part}-h`,
      track: { x: track(rect.x1), y: track((t) => rect.y1(t) + radius), sx: track((t) => (rect.x2(t) - rect.x1(t)) / maxW, 0.002), sy: track((t) => (rect.y2(t) - rect.y1(t) - 2 * radius) / hh, 0.002) },
      path: rectPath(0, 0, maxW, hh),
    });
    const corners: [string, Fn, Fn][] = [
      ["nw", (t) => rect.x1(t) + radius, (t) => rect.y1(t) + radius],
      ["ne", (t) => rect.x2(t) - radius, (t) => rect.y1(t) + radius],
      ["sw", (t) => rect.x1(t) + radius, (t) => rect.y2(t) - radius],
      ["se", (t) => rect.x2(t) - radius, (t) => rect.y2(t) - radius],
    ];
    for (const [name, cxFn, cyFn] of corners) {
      pieces.push({ ...base, id: `cursor:${cueNumber}:${part}-${name}`, track: { x: track(cxFn), y: track(cyFn) }, origin: { dx: radius, dy: radius }, path: ellipsePath(radius, radius, radius) });
    }
  };

  // --- the card ---
  // The sample's 50 px soft drop shadow, as one blurred rectangle a little inside the card's edges and lower (sigma 14 px).
  const shadowW = cardW - 16 * k;
  const shadowH = cardH - 8 * k;
  pieces.push({
    id: `cursor:${cueNumber}:card-shadow`,
    kind: "shape",
    z: band,
    fromMs: tOn,
    toMs: tOff,
    track: {
      x: sample((t) => cardX1(t) + 8 * k, tOn, tOff, 0.25),
      y: sample((t) => cardY1(t) + 22 * k, tOn, tOff, 0.25),
      sx: sample((t) => (cardX2(t) - cardX1(t) - 16 * k) / shadowW, tOn, tOff, 0.002),
      sy: sample((t) => (cardY2(t) - cardY1(t) - 8 * k) / shadowH, tOn, tOff, 0.002),
      blur: [[tOn, 14 * k]],
    },
    path: rectPath(0, 0, shadowW, shadowH),
    fill: { colour: "#000000", alpha: 0.22 },
  });
  morph("card", band + 1, cardColour, r, { x1: cardX1, x2: cardX2, y1: cardY1, y2: cardY2 }, cardW, cardH, tOn, tOff);

  // --- the traffic-light dots: spring in from scale 0 just after the card opens ---
  DOT_COLOURS.forEach((colour, i) => {
    const start = firstAt + 60 + i * 50;
    const [x1, x2] = span((DOT.x + i * DOT.step) * k, (DOT.x + i * DOT.step + 2 * DOT.r) * k);
    const dotTop = top + DOT.y * k;
    const win = visibleWindow(clipRect({ x1: x1 - 1, x2: x2 + 1, y1: dotTop - 1, y2: dotTop + 2 * DOT.r * k + 1 }), Math.max(tOn, start + 4), tOff);
    if (!win) return;
    bump(start, start + 260);
    pieces.push({
      id: `cursor:${cueNumber}:dot${i}`,
      kind: "shape",
      z: band + 2,
      fromMs: win[0],
      toMs: win[1],
      track: { x: [[win[0], (x1 + x2) / 2]], y: [[win[0], dotTop + DOT.r * k]], sx: [[start, 0], [start + 260, 1, "spring"]], sy: [[start, 0], [start + 260, 1, "spring"]] },
      clip: clipFrames(clipRect({ x1: 0, x2: canvas.width, y1: 0, y2: canvas.height }), win[0], win[1]),
      origin: { dx: DOT.r * k, dy: DOT.r * k },
      path: ellipsePath(DOT.r * k, DOT.r * k, DOT.r * k),
      fill: { colour },
    });
  });

  // --- the words: each rises out of its own 96 px slit as it is spoken, behind the growing card ---
  for (const item of items) {
    if (item.hero) continue;
    const word = cue.words[item.index]!;
    const start = word.startMs - 70;
    const [textX1, textX2] = span(item.p, item.p + item.textW);
    const slitTop = top + item.top;
    const slit = { x1: textX1 - BODY_SLIT_PAD * k, x2: textX2 + BODY_SLIT_PAD * k, y1: slitTop, y2: slitTop + BODY_SLIT_H * k };
    const win = visibleWindow(clipRect(slit), Math.max(tOn, start + 4), tOff);
    if (!win) continue;
    bump(start, start + RISE);
    const baseline = slitTop + (BODY_TEXT_TOP + BODY_FS * BODY_BASE) * k;
    const lift = 1.5 * BODY_FS * k;
    const y: Frames = win[0] >= start + RISE ? [[win[0], baseline]] : [[start, baseline + lift], [start + RISE, baseline, "outExpo"]];
    pieces.push({
      id: `cursor:${cueNumber}:w${item.index}`,
      kind: "text",
      z: band + 4,
      fromMs: win[0],
      toMs: win[1],
      track: { x: [[win[0], textX1]], y },
      clip: clipFrames(clipRect(slit), win[0], win[1]),
      text: word.text,
      face: BODY_FACE,
      sizePx: BODY_FS * k,
      letterSpacingEm: BODY_LS,
      fill: inkColour,
      anchor: "baseline-left",
      language: cue.language,
    } satisfies TextPiece);
  }

  // --- the hero: a yellow chip the pointer drags open, the word rising in italic serif, the pointer clicking and leaving ---
  if (heroItem) {
    const word = cue.words[heroItem.index]!;
    const hs = word.startMs;
    const boxLead = heroItem.p + HERO_MARGIN * k;
    const boxW = heroItem.textW + 2 * HERO_PAD * k;
    const [boxX1, boxX2] = span(boxLead, boxLead + boxW);
    const boxTop = top + heroItem.top;
    const boxH = HERO_ITEM_H * k;
    const dragAt = hs - DRAG_LEAD;
    const drag: Fn = (t) => EASES.inOut(prog(t, dragAt, DRAG_LEAD - 20));
    bump(dragAt, dragAt + DRAG_LEAD - 20, hs - 60, hs - 60 + HERO_RISE);

    // The chip: the box, 4 px under its top, opened from its leading edge by the drag (`inset(0 x% 0 0 round 18px)`).
    const chipR = CHIP_R * k;
    const chipTop = boxTop + CHIP_TOP * k;
    const chipRect = {
      x1: (t: number) => (dir > 0 ? boxX1 : boxX2 - drag(t) * boxW),
      x2: (t: number) => (dir > 0 ? boxX1 + drag(t) * boxW : boxX2),
      y1: () => chipTop,
      y2: () => boxTop + boxH,
    };
    const chipClip = clipRect({ x1: boxX1, x2: boxX2, y1: chipTop, y2: boxTop + boxH });
    let chipFrom = Math.max(tOn, Math.ceil(dragAt));
    while (chipFrom < tOff && (chipClip.fx2(chipFrom) - chipClip.fx1(chipFrom) < 1 || chipRect.x2(chipFrom) - chipRect.x1(chipFrom) < 2 * chipR + 1)) chipFrom++;
    const chipWin = visibleWindow(chipClip, chipFrom, tOff);
    if (chipWin) morph("chip", band + 3, CHIP_COLOUR, chipR, chipRect, boxW, boxH - CHIP_TOP * k, chipWin[0], chipWin[1], clipFrames(chipClip, chipWin[0], chipWin[1]));

    // The word: rises over 420 ms from 60 ms before it is spoken, out of its own slit (the box's slit is 6 px wider than the text each side).
    const textLead = boxLead + HERO_PAD * k;
    const [textX1] = span(textLead, textLead + heroItem.textW);
    const slit = { x1: textX1 - HERO_SLIT_PAD * k, x2: textX1 + heroItem.textW + HERO_SLIT_PAD * k, y1: boxTop, y2: boxTop + boxH };
    const textStart = hs - 60;
    const textWin = visibleWindow(clipRect(slit), Math.max(tOn, textStart + 4), tOff);
    if (textWin) {
      const baseline = boxTop + (CHIP_TOP + HERO_FS * HERO_BASE * f) * k;
      const lift = 1.5 * HERO_TEXT_H * k;
      const y: Frames = textWin[0] >= textStart + HERO_RISE ? [[textWin[0], baseline]] : [[textStart, baseline + lift], [textStart + HERO_RISE, baseline, "outExpo"]];
      pieces.push({
        id: `cursor:${cueNumber}:hero`,
        kind: "text",
        z: band + 4,
        fromMs: textWin[0],
        toMs: textWin[1],
        track: { x: [[textWin[0], textX1]], y },
        clip: clipFrames(clipRect(slit), textWin[0], textWin[1]),
        text: word.text,
        face: HERO_FACE,
        sizePx: HERO_FS * k,
        letterSpacingEm: HERO_LS,
        fill: input.colours.accent,
        anchor: "baseline-left",
        language: cue.language,
      } satisfies TextPiece);
    }

    // The pointer: arrives, drags the chip's edge open, clicks as the word lands, then slides off down and away.
    const arrowShape = anchored(polylinePath(POINTER_PATH.map(([px, py]) => [px * POINTER_SCALE * k, py * POINTER_SCALE * k] as [number, number])).concat([["Z"]]));
    const leaveFrom = hs + 520;
    const leaveTo = leaveFrom + 380;
    const x0 = dir > 0 ? boxX1 - 14 * k : boxX2 + 12 * k;
    const x1 = dir > 0 ? boxX1 + boxW - 14 * k : boxX2 - boxW + 12 * k;
    const y0 = boxTop + boxH * 0.55;
    const pointerFrom = Math.max(tOn, Math.ceil(dragAt - 60) + 4);
    const pointerClip = clipRect({ x1: 0, x2: canvas.width, y1: 0, y2: canvas.height });
    const pointerTo = Math.min(tOff, leaveTo);
    if (pointerFrom < pointerTo) {
      pieces.push({
        id: `cursor:${cueNumber}:pointer`,
        kind: "shape",
        z: band + 5,
        fromMs: pointerFrom,
        toMs: pointerTo,
        track: {
          x: [[dragAt, x0], [dragAt + DRAG_LEAD - 20, x1, "inOut"], [leaveFrom, x1], [leaveTo, x1 + dir * 90 * k, "inOut"]],
          y: [[dragAt - 60, y0 + 40 * k], [dragAt + 40, y0, "out"], [leaveFrom, y0], [leaveTo, y0 + 70 * k, "inOut"]],
          sx: [[hs - 30, 1], [hs + 40, 0.82, "out"], [hs + 160, 1, "out"]],
          sy: [[hs - 30, 1], [hs + 40, 0.82, "out"], [hs + 160, 1, "out"]],
          o: [[dragAt - 60, 0], [dragAt + 40, 1, "out"], [leaveFrom, 1], [leaveTo, 0, "inOut"]],
        },
        clip: clipFrames(pointerClip, pointerFrom, pointerTo),
        origin: arrowShape.origin,
        path: arrowShape.path,
        fill: { colour: INK },
        stroke: { widthPx: 3.2 * POINTER_SCALE * k, colour: WHITE },
      });
    }
  }

  // --- the sticker: one per cue, hanging off the card's growing end ---
  const stickerAt = (heroItem ? cue.words[heroItem.index]!.startMs : cue.words[Math.floor((cue.words.length - 1) / 2)]!.startMs) + 140;
  const stickerFrom = stickerAt + 4;
  if (stickerFrom < tOff) {
    const counterIndex = heroItem ? counters.hero++ : counters.plain++ + 1;
    const kind: Kind = counterIndex % 2 === 0 ? "toggle" : "tile";
    const jitter = cursorHash(`${cue.index}|${cue.words[0]!.text}|${cue.words.length}`);
    const jitterY = cursorHash(`${cue.words[cue.words.length - 1]!.text}|${cueNumber}`);
    const rest = -8 + (jitter - 0.5) * 8;
    const nudgeX = (jitter - 0.5) * 20 * k;
    const nudgeY = (jitterY - 0.5) * 12 * k;
    bump(stickerAt, stickerAt + STICKER_POP, stickerAt + 300, stickerAt + 560);
    const pop: Fn = (t) => EASES.spring(prog(t, stickerAt, STICKER_POP));
    const scale: Fn = (t) => Math.max(0, pop(t)) * (1 - squash(t));
    const turn: Fn = (t) => rest + (1 - pop(t)) * -24;
    const reachX = space.safe;
    const centreX: Fn = (t) => {
      const raw = dir > 0 ? left + width(t) - (112 - 75) * k + nudgeX : right - width(t) + (112 - 75) * k + nudgeX;
      return Math.min(reachX.x2 - STICKER_MARGIN * k, Math.max(reachX.x1 + STICKER_MARGIN * k, raw));
    };
    const centreY = top + (-52 + 75) * k + nudgeY;
    const to = tOff;
    const framesFor = (fn: Fn, tolerance: number) => sample(fn, stickerFrom, to, tolerance);
    const sFrames = framesFor(scale, 0.004);
    const turnFrames = framesFor(turn, 0.05);
    const cxFrames = framesFor(centreX, 0.25);
    const half = STICKER_BOX / 2;
    /** The canvas point of a point of the sticker box (box px), through the group's scale, turn and position. */
    const point = (t: number, lx: number, ly: number): [number, number] => {
      const a = (turn(t) * Math.PI) / 180;
      const s = scale(t);
      const dx = (lx - half) * k * s;
      const dy = (ly - half) * k * s;
      return [centreX(t) + dx * Math.cos(a) - dy * Math.sin(a), centreY + dx * Math.sin(a) + dy * Math.cos(a)];
    };
    const sticker = (part: string, z: number, path: readonly PathCmd[], anchorBox: [number, number], pivotBox: [number, number], style: Pick<ShapePiece, "fill" | "stroke" | "shadows">, pivotAt?: (t: number) => [number, number], widthFn?: Fn, from = stickerFrom) => {
      const shape = path.length > 0 && pathBounds(path).x1 === 0 && pathBounds(path).y1 === 0 ? { path: [...path], origin: { dx: (pivotBox[0] - anchorBox[0]) * k, dy: (pivotBox[1] - anchorBox[1]) * k } } : null;
      if (!shape) throw new Error("sticker paths start at the box's top-left");
      const own = pivotAt !== undefined || widthFn !== undefined;
      const track: ShapePiece["track"] = own
        ? {
            x: sample((t) => (pivotAt ? point(t, ...pivotAt(t)) : point(t, ...pivotBox))[0], from, to, 0.25),
            y: sample((t) => (pivotAt ? point(t, ...pivotAt(t)) : point(t, ...pivotBox))[1], from, to, 0.25),
            sx: widthFn ? sample((t) => scale(t) * widthFn(t), from, to, 0.004) : sFrames,
            sy: sFrames,
            rz: turnFrames,
          }
        : { x: cxFrames, y: [[from, centreY]], sx: sFrames, sy: sFrames, rz: turnFrames };
      pieces.push({ id: `cursor:${cueNumber}:${part}`, kind: "shape", z: band + z, fromMs: from, toMs: to, track, origin: shape.origin, path: shape.path, ...style });
    };
    const shadow = { dx: 0, dy: 10 * k, blur: 12 * k, colour: "#000000", alpha: 0.25 } as const;

    if (kind === "toggle") {
      const on = (t: number) => EASES.outBack(prog(t, stickerAt + 300, 260));
      const on01 = (t: number) => Math.max(0.0001, Math.min(1, on(t)));
      // The pill: a purple 150 x 78 capsule with a white inside 5 px in.
      sticker("pill", 6, roundedRectPath(0, 0, 150 * k, 78 * k, 39 * k), [0, 40], [75, 75], { fill: { colour: TOGGLE }, shadows: [shadow] });
      sticker("pill-in", 7, roundedRectPath(0, 0, 140 * k, 68 * k, 34 * k), [5, 45], [75, 75], { fill: { colour: WHITE } });
      // The purple fill grows from the left as the toggle turns on.
      const fillFrom = (() => {
        let t = stickerFrom;
        while (t < to && on(t) <= 0.02) t++;
        return t;
      })();
      if (fillFrom < to) sticker("fill", 8, roundedRectPath(0, 0, 134 * k, 62 * k, 31 * k), [8, 48], [8, 79], { fill: { colour: TOGGLE } }, () => [8, 79], on01, fillFrom);
      // The knob slides 72 px along it (overshooting), carrying the power glyph.
      const knobAt = (t: number): [number, number] => [39 + on(t) * 72, 79];
      sticker("knob", 9, ellipsePath(26 * k, 26 * k, 26 * k), [13, 53], [39, 79], { fill: { colour: WHITE }, shadows: [{ dx: 0, dy: 2 * k, blur: 3 * k, colour: "#000000", alpha: 0.25 }] }, knobAt, () => 1);
      const arc = anchored(arcPath(0, 0.43 * k, 9.5 * k, 226.8, -46.8));
      const stem = anchored(polylinePath([[0, -11 * k], [0, -1 * k]]));
      for (const [part, glyph] of [["power-ring", arc], ["power-stem", stem]] as const) {
        const track: ShapePiece["track"] = {
          x: sample((t) => point(t, ...knobAt(t))[0], stickerFrom, to, 0.25),
          y: sample((t) => point(t, ...knobAt(t))[1], stickerFrom, to, 0.25),
          sx: sFrames,
          sy: sFrames,
          rz: turnFrames,
        };
        pieces.push({ id: `cursor:${cueNumber}:${part}`, kind: "shape", z: band + 10, fromMs: stickerFrom, toMs: to, track, origin: glyph.origin, path: glyph.path, stroke: { widthPx: 3.6 * k, colour: TOGGLE } });
      }
    } else {
      // The tile: an orange rounded square holding the pointer arrow, with three click ticks at its tip.
      sticker("tile", 6, roundedRectPath(0, 0, 112 * k, 112 * k, 22 * k), [22, 14], [75, 75], { fill: { colour: TILE }, shadows: [shadow] });
      const arrow = anchored(polylinePath(POINTER_PATH.map(([px, py]) => [px * k, py * k] as [number, number])).concat([["Z"]]));
      const tip: [number, number] = [61, 43.5];
      const arrowPivot = { dx: (75 - tip[0]) * k, dy: (75 - tip[1]) * k };
      pieces.push({
        id: `cursor:${cueNumber}:arrow`,
        kind: "shape",
        z: band + 7,
        fromMs: stickerFrom,
        toMs: to,
        track: { x: cxFrames, y: [[stickerFrom, centreY]], sx: sFrames, sy: sFrames, rz: turnFrames },
        origin: arrowPivot,
        path: arrow.path,
        fill: { colour: INK },
      });
      // The ticks leave the tip up and to the left: from 9 px out to 18 px out along three directions.
      for (const [n, angle] of [180, 225, 270].entries()) {
        const a = (angle * Math.PI) / 180;
        const tick = anchored(polylinePath([[Math.cos(a) * 9 * k, Math.sin(a) * 9 * k], [Math.cos(a) * 18 * k, Math.sin(a) * 18 * k]]));
        const box = pathBounds(polylinePath([[Math.cos(a) * 9 * k, Math.sin(a) * 9 * k], [Math.cos(a) * 18 * k, Math.sin(a) * 18 * k]]));
        pieces.push({
          id: `cursor:${cueNumber}:tick${n}`,
          kind: "shape",
          z: band + 7,
          fromMs: stickerFrom,
          toMs: to,
          track: { x: cxFrames, y: [[stickerFrom, centreY]], sx: sFrames, sy: sFrames, rz: turnFrames },
          // The tick's own origin is the tip of the arrow, so its box offset from the pivot is the tip's minus the group's.
          origin: { dx: (75 - tip[0]) * k - box.x1, dy: (75 - tip[1]) * k - box.y1 },
          path: tick.path,
          stroke: { widthPx: 4 * k, colour: INK },
        });
      }
    }
  }

  return clampToSafeArea(pieces, space.safe, input.measure);
}

export const cursorProgram: SceneProgram = {
  build(input) {
    const counters = { hero: 0, plain: 0 };
    return { pieces: input.cues.flatMap((cue, number) => (cue.words.length === 0 ? [] : buildCue(cue, number, counters, input))) };
  },
};

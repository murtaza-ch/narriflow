import type { DemoScript } from "../demo";
import { type Frames, EASES, clamp, lerp, prog } from "../ease";
import { sampleFrames } from "../frames";
import type { SceneCue, SceneInput, SceneProgram } from "../input";
import { clampToSafeArea, cueDirection, fitScale, greedyRows, rowVisualOrder, sceneSpace } from "../layout";
import { type ColourFrames, type Piece, type ShapePiece, type TextPiece, SCENE_PERSPECTIVE_PX } from "../scene";
import { rectPath } from "../shapes";

/**
 * Arthouse (`samples/templates/m13-cinema.js`): indie-film title cards as captions. Tight condensed caps (Big Shoulders
 * Display Black) on a tilted baseline; each cue swings in from flat in perspective with a brief cyan / magenta fringe, holds
 * with a slow drift and swings out. Words land on their spoken time in acid yellow and cool to white once said; the key word
 * is a bigger red groovy serif (Shrikhand) overlapping the line; a thin red rule wipes in under the last row.
 *
 * Geometry is the sample's, read in Chrome (`probe-sample.ts`): caps 196 / 168 / 148 px by the cue's character count (line box
 * 0.86 em, baseline 0.811 em in it), hero 1.08x (line box 0.72 em, baseline 0.6575 em, margins -0.04 size), words 0.2 size apart,
 * rows wrapped at 820 px and baseline-aligned like the flex row, the rule 1.3 size by 10 px under 0.4 / 0.26 size, the block
 * centred on y 1290. Every word and the rule are posed through the block's transform (translate, perspective 1100, rotateY,
 * rotate, scale about its centre), the way a CSS parent would pose its children.
 *
 * What changed from the sample, and why (Gallery 2 brief and spec section 7):
 * - Perspective. A piece has no parent, so each word's pivot goes through the block's projection (perspective 1100 px, in
 *   sample px) and its own linear map (the projection's local Jacobian times the word's own scale and tilt) is written as
 *   `rz`, `skx`, `sx`, `sy`; the trapezoid across one word is a small `ry` through the shared 326 px camera
 *   (`sin ry = sin a * 326 * k / 1100u`, k the projection's local scale), so a word leans as the whole card does.
 * - Size came from the character count only: the widest word (hero at 1.08x) now fits the row (no floor: a word cannot
 *   wrap), the hero's entry scale (1.5x) and a body word's (1.18x) are capped to the safe width, and the block fits the
 *   safe area with its tilt (up to 1.3x the sample's), 1.06x exit scale, 52 px of drift and the fringe's 12 px offset counted.
 * - Fringe: the two coloured text-shadows are two coloured copies under each word (a piece cannot animate a shadow), offset along
 *   the word's own baseline; they exist only while the fringe does (the swing, each word's arrival, the exit).
 * - The block's `drop-shadow(0 8px 18px)` is a blurred dark layer under each word and the rule (blur sigma 9, half the CSS radius).
 * - Recurring variants (the sample's cues are one fixed look): the swing alternates side (rotateY +38 / -38, drift and exit
 *   mirror), the tilt cycles -12 / -9 / -14 / -7 degrees with a hash jitter (hero cues and plain cues each own a counter), the
 *   hero's rest tilt cycles -3 / -5 / -2 / -4, the rule's width (1.3 / 0.9 / 1.9 size) and place (centre / leading / trailing
 *   under the last row) cycle by cue number, and the fringe's two colours swap sides by hash. A cue with no hero keeps the
 *   caps, the fringe, the rule and the drift (its lightest recurring motion is the same swing and rule).
 * - Exit: the 140 ms swing-out never starts before the last word has landed and been readable for 150 ms (it shortens, down to
 *   60 ms, and may run 60 ms into the next cue in fast speech).
 * - Cased scripts only (Latin, Cyrillic, Greek) are upper-cased and spaced; other scripts keep their letters, start 25 % smaller
 *   and rows grow to their ink. Rows of a right-to-left cue run right to left and the rule wipes from the right.
 */

export const ARTHOUSE_DEMO: DemoScript = {
  lines: [
    "Here's:b what:m nobody:b warns:b you",
    "the:m first:b year:b is:m chaos:h@600",
    "do:b it:m anyway",
    "you'll:m thank:b yourself:h@640",
  ],
  options: { rate: 290, cueGap: 160, tail: 850, lead: 350 },
};

const CENTER_Y = 1290;
const MAX_W = 820;
const BODY_FACE = "Big Shoulders Display Black" as const;
const HERO_FACE = "Shrikhand" as const;
const FRINGE_A = "#00E5FF";
const FRINGE_B = "#FF2BD6";
const SHADOW = "#000000";
const TILTS = [-12, -9, -14, -7] as const;
const HERO_REST = [-3, -5, -2, -4] as const;
const RULE_WIDTHS = [1.3, 0.9, 1.9] as const;
const RULE_PLACES = ["center", "lead", "trail"] as const;
/** Line box and baseline of Big Shoulders at `line-height: 0.86` and of Shrikhand at 0.72 (probe, em of the face's own size). */
const BODY_LINE = 0.86;
const BODY_ABOVE = 0.811;
const HERO_LINE = 0.72;
const HERO_ABOVE = 0.6575;
const HERO_SCALE = 1.08;
const HERO_MARGIN = 0.04;
const WORD_GAP = 0.2;
const RULE_H = 10;
const PIVOT_Y = 0.7;
const SAMPLE_PERSPECTIVE = 1100;
const SWING_MS = 480;
const SWING_FROM_DEG = 38;
const SWING_SCALE = 0.72;
const EXIT_MS = 140;
const EXIT_MIN_MS = 60;
const OVERLAP_MS = 60;
const READABLE_MS = 150;
const FADE_IN_MS = 70;
const NON_CASED_SCALE = 0.75;
const CASED = /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}]/u;

/** FNV-1a over a cue's index and text: the one source of jitter (never `Math.random`). */
export function arthouseHash(index: number, text: string): number {
  let h = (2166136261 ^ index) >>> 0;
  for (const ch of text) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619) >>> 0;
  return h >>> 0;
}

/** The sample's caps size in sample px from the cue's character count (a letter and a space per word). */
export function arthouseSize(chars: number): number {
  return chars <= 16 ? 196 : chars <= 24 ? 168 : 148;
}

const rad = (deg: number) => (deg * Math.PI) / 180;
const deg = (radians: number) => (radians * 180) / Math.PI;
const upper = (text: string) => (CASED.test(text) ? text.toUpperCase() : text);
const length = (text: string) => [...text].length;

interface Item {
  readonly index: number;
  /** Pivot, block-local px (the block's centre is 0, 0). */
  qx: number;
  qy: number;
  /** Baseline's offset below the block centre, and the pivot's offset below the baseline. */
  readonly fs: number;
  readonly box: number;
  originDy: number;
}

interface Row {
  readonly items: Item[];
  width: number;
  top: number;
  above: number;
  below: number;
}

function buildCue(cue: SceneCue, cueNumber: number, counters: { hero: number; plain: number }, input: SceneInput): Piece[] {
  const space = sceneSpace(input, CENTER_Y);
  const { u, safe } = space;
  const rtl = cueDirection(cue) === "rtl";
  const words = cue.words;
  const hero = words.map((word) => word.role === "hero");
  const hasHero = hero.some(Boolean);
  const heroCounter = hasHero ? counters.hero++ : 0;
  const plainCounter = hasHero ? 0 : counters.plain++;
  const seed = arthouseHash(cue.index, words.map((word) => word.text).join(" "));
  const cx = space.x(540);
  const cy = space.y(CENTER_Y);
  const safeW = safe.x2 - safe.x1;
  const safeH = safe.y2 - safe.y1;
  const maxW = Math.min(MAX_W * u, safeW * 0.97);
  const nonCased = words.some((word) => !CASED.test(word.text));
  const texts = words.map((word, at) => (hero[at] ? word.text : upper(word.text)));
  const lsOf = (at: number) => (CASED.test(words[at]!.text) ? (hero[at] ? -0.01 : 0.005) : 0);
  const faceOf = (at: number) => (hero[at] ? HERO_FACE : BODY_FACE);
  const fsOf = (at: number, size: number) => (hero[at] ? size * HERO_SCALE : size);
  const boxOf = (at: number, size: number) => {
    const fs = fsOf(at, size);
    return input.measure(texts[at]!, faceOf(at), fs, lsOf(at)).advance + lsOf(at) * fs;
  };
  const outerOf = (at: number, size: number) => boxOf(at, size) - (hero[at] ? 2 * HERO_MARGIN * size : 0);

  const tilt = TILTS[(hasHero ? heroCounter : plainCounter + 2) % TILTS.length]! + ((seed % 5) - 2) * 0.4;
  const tiltMax = Math.abs(tilt) * 1.3 + 1;
  const sign = cueNumber % 2 === 0 ? 1 : -1;
  const fringeFlip = (seed >>> 3) & 1;
  const chars = words.reduce((sum, word) => sum + length(word.text) + 1, 0);
  let size = arthouseSize(chars) * u * (nonCased ? NON_CASED_SCALE : 1);
  size *= fitScale(Math.max(...words.map((_, at) => outerOf(at, size))), maxW);

  const ruleWidth = RULE_WIDTHS[(cueNumber + 1) % RULE_WIDTHS.length]!;
  const rulePlace = RULE_PLACES[cueNumber % RULE_PLACES.length]!;

  const layout = (sz: number) => {
    const gap = WORD_GAP * sz;
    const rows: Row[] = greedyRows(words.map((_, at) => outerOf(at, sz)), gap, maxW).map((row) => {
      const order = rowVisualOrder(row.map((at) => texts[at]!), rtl ? "rtl" : "ltr").map((at) => row[at]!);
      const items: Item[] = order.map((at) => ({ index: at, qx: 0, qy: 0, fs: fsOf(at, sz), box: boxOf(at, sz), originDy: 0 }));
      let above = 0;
      let below = 0;
      for (const item of items) {
        let up = hero[item.index] ? HERO_ABOVE * item.fs : BODY_ABOVE * sz;
        let down = (hero[item.index] ? HERO_LINE * item.fs : BODY_LINE * sz) - up;
        // Text the face cannot draw (Arabic, Devanagari, CJK ...) is as tall as its ink, so rows never overlap.
        if (!CASED.test(words[item.index]!.text)) {
          const m = input.measure(texts[item.index]!, faceOf(item.index), item.fs, 0);
          up = Math.max(up, -m.inkTop);
          down = Math.max(down, m.inkBottom);
        }
        above = Math.max(above, up);
        below = Math.max(below, down);
      }
      const outer = items.map((item) => item.box - (hero[item.index] ? 2 * HERO_MARGIN * sz : 0));
      const width = outer.reduce((sum, w) => sum + w, 0) + gap * (items.length - 1);
      return { items, width, top: 0, above, below };
    });
    let y = 0;
    for (const row of rows) {
      row.top = y;
      y += row.above + row.below;
    }
    const ruleMargin = sz * (hasHero ? 0.4 : 0.26);
    const rowsBottom = y;
    const ruleTop = y + ruleMargin;
    const height = ruleTop + RULE_H * u;
    const ruleW = Math.min(ruleWidth * sz, safeW);
    const widest = Math.max(...rows.map((row) => row.width), ruleW);
    for (const row of rows) {
      let x = -row.width / 2;
      for (const item of row.items) {
        const margin = hero[item.index] ? -HERO_MARGIN * sz : 0;
        item.qx = x + margin + item.box / 2;
        x += item.box - (hero[item.index] ? 2 * HERO_MARGIN * sz : 0) + gap;
        const up = hero[item.index] ? HERO_ABOVE * item.fs : BODY_ABOVE * sz;
        const down = (hero[item.index] ? HERO_LINE * item.fs : BODY_LINE * sz) - up;
        const lineUp = CASED.test(words[item.index]!.text) ? up : row.above;
        const lineH = CASED.test(words[item.index]!.text) ? up + down : row.above + row.below;
        const wordTop = row.top + row.above - lineUp;
        item.qy = wordTop + PIVOT_Y * lineH - height / 2;
        item.originDy = item.qy - (row.top + row.above - height / 2);
      }
    }
    return { rows, height, widest, ruleTop, ruleW, rowsBottom };
  };

  let laid = layout(size);
  const extents = (l: ReturnType<typeof layout>) => {
    const t = rad(tiltMax);
    return {
      w: (l.widest * Math.cos(t) + l.height * Math.sin(t)) * 1.06 + 52 * u + 26 * u,
      h: (l.height * Math.cos(t) + l.widest * Math.sin(t)) * 1.06 + 6 * u + 12 * u,
    };
  };
  for (let pass = 0; pass < 8; pass++) {
    const e = extents(laid);
    const k = Math.min(safeW / e.w, safeH / e.h);
    if (k >= 1) break;
    size *= k * 0.99;
    laid = layout(size);
  }
  const { rows, height, ruleW, ruleTop } = laid;

  // --- the timeline: the swing in, the drift, the exit (held until the last word has been readable) ---
  const ats = words.map((word) => word.startMs - 60);
  const holdUntil = Math.max(...ats) + FADE_IN_MS + READABLE_MS;
  let exitTo = cue.endMs - 80;
  let exitFrom = exitTo - EXIT_MS;
  if (exitFrom < holdUntil) {
    const limit = cue.endMs + OVERLAP_MS;
    exitFrom = Math.min(holdUntil, limit - EXIT_MIN_MS);
    exitTo = Math.min(Math.max(exitTo, exitFrom + EXIT_MIN_MS), limit);
  }
  const exitDur = exitTo - exitFrom;
  const swingFrom = cue.startMs - 80;
  const swingEnd = swingFrom + SWING_MS;
  const band = cueNumber * 10;
  const swing = (t: number) => EASES.outExpo(prog(t, swingFrom, SWING_MS));
  const hold = (t: number) => prog(t, cue.startMs, cue.endMs - cue.startMs);
  const out = (t: number) => EASES.in(prog(t, exitFrom, exitDur));
  const persp = SAMPLE_PERSPECTIVE * u;

  interface Local {
    rot: number;
    sx: number;
    sy: number;
  }
  /** The block's transform applied to a point `(qx, qy)` (block-local px, centre 0, 0), plus the local linear map. */
  const project = (t: number, qx: number, qy: number) => {
    const ryDeg = sign * (lerp(SWING_FROM_DEG, 0, swing(t)) - 22 * out(t));
    const r = rad(tilt * swing(t) + out(t) * tilt * 0.3);
    const s = lerp(SWING_SCALE, 1, swing(t)) * (1 + 0.06 * out(t));
    const tx = sign * (hold(t) * 12 + out(t) * 40) * u;
    const ty = -hold(t) * 6 * u;
    const at = (x: number, y: number) => {
      const px = s * (x * Math.cos(r) - y * Math.sin(r));
      const py = s * (x * Math.sin(r) + y * Math.cos(r));
      const a = rad(ryDeg);
      const k = persp / (persp + px * Math.sin(a));
      return { x: cx + tx + px * Math.cos(a) * k, y: cy + ty + py * k, k };
    };
    return { at, ryDeg, centre: at(qx, qy) };
  };
  const pose = (t: number, qx: number, qy: number, local: Local) => {
    const { at, ryDeg, centre } = project(t, qx, qy);
    const h = 0.5;
    const a = at(qx + h, qy);
    const b = at(qx - h, qy);
    const c = at(qx, qy + h);
    const d = at(qx, qy - h);
    const j00 = (a.x - b.x) / (2 * h);
    const j10 = (a.y - b.y) / (2 * h);
    const j01 = (c.x - d.x) / (2 * h);
    const j11 = (c.y - d.y) / (2 * h);
    // The word's own turn and scale act inside the block: L = J * R(rot) * diag(sx, sy).
    const cw = Math.cos(rad(local.rot));
    const sw = Math.sin(rad(local.rot));
    const w00 = cw * local.sx;
    const w10 = sw * local.sx;
    const w01 = -sw * local.sy;
    const w11 = cw * local.sy;
    const l00 = j00 * w00 + j01 * w10;
    const l10 = j10 * w00 + j11 * w10;
    const l01 = j00 * w01 + j01 * w11;
    const l11 = j10 * w01 + j11 * w11;
    // The piece's own small `ry` (shared 326 px camera) takes the card's trapezoid across one word; its flat part is divided out.
    const sinP = clamp(Math.sin(rad(ryDeg)) * SCENE_PERSPECTIVE_PX * centre.k / persp, -0.95, 0.95);
    const cosP = Math.sqrt(1 - sinP * sinP);
    const c1x = l00 / cosP;
    const c1y = l10;
    const c2x = l01 / cosP;
    const c2y = l11;
    const phi = Math.atan2(c1y, c1x);
    const x2 = c2x * Math.cos(phi) + c2y * Math.sin(phi);
    const y2 = -c2x * Math.sin(phi) + c2y * Math.cos(phi);
    return {
      x: centre.x,
      y: centre.y,
      rz: deg(phi),
      sx: Math.hypot(c1x, c1y),
      sy: y2,
      skx: deg(Math.atan(x2 / y2)),
      ry: deg(Math.asin(sinP)),
      l00,
      l10,
    };
  };
  const memo = <T,>(fn: (t: number) => T) => {
    const cache = new Map<number, T>();
    return (t: number) => {
      let v = cache.get(t);
      if (v === undefined) {
        v = fn(t);
        cache.set(t, v);
      }
      return v;
    };
  };

  const edgesOf = (from: number, to: number, extra: readonly number[]) =>
    [...new Set([from, ...[swingFrom, swingEnd, cue.startMs, exitFrom, exitTo, ...extra].filter((e) => e > from && e < to), to])].sort((a, b) => a - b);
  const track = (fn: (t: number) => number, from: number, to: number, extra: readonly number[], tolerance: number): Frames =>
    sampleFrames(fn, edgesOf(from, to, extra), tolerance, { simplify: true });
  const poseTracks = (get: (t: number) => ReturnType<typeof pose>, from: number, to: number, extra: readonly number[]) => ({
    x: track((t) => get(t).x, from, to, extra, 0.25),
    y: track((t) => get(t).y, from, to, extra, 0.25),
    sx: track((t) => get(t).sx, from, to, extra, 0.004),
    sy: track((t) => get(t).sy, from, to, extra, 0.004),
    rz: track((t) => get(t).rz, from, to, extra, 0.1),
    skx: track((t) => get(t).skx, from, to, extra, 0.1),
    ry: track((t) => get(t).ry, from, to, extra, 0.1),
  });

  const pieces: Piece[] = [];
  const heroRest = HERO_REST[heroCounter % HERO_REST.length]!;
  const shadow = [{ dx: 0, dy: 8 * u, blur: 9 * u, colour: SHADOW, alpha: 0.55 }] as const;
  const fringeColours = fringeFlip ? ([FRINGE_B, FRINGE_A] as const) : ([FRINGE_A, FRINGE_B] as const);

  for (const row of rows) {
    for (const item of row.items) {
      const at = item.index;
      const word = words[at]!;
      const isHero = hero[at];
      const wordAt = ats[at]!;
      const landMs = isHero ? 420 : 200;
      const entry = Math.max(1, Math.min(isHero ? 1.5 : 1.18, (0.95 * safeW) / Math.max(1, item.box)));
      const local = (t: number): Local => {
        const land = prog(t, wordAt, landMs);
        const sc = isHero ? lerp(entry, 1, EASES.spring(land)) : lerp(entry, 1, EASES.outExpo(land));
        return { rot: isHero ? lerp(heroRest - 7, heroRest, EASES.outExpo(land)) : 0, sx: sc, sy: sc };
      };
      const get = memo((t) => pose(t, item.qx, item.qy, local(t)));
      const fade = (t: number) => prog(t, wordAt, FADE_IN_MS);
      const from = wordAt;
      const to = exitTo;
      if (to <= from + 1) continue;
      const base = {
        kind: "text" as const,
        text: texts[at]!,
        face: faceOf(at),
        sizePx: item.fs,
        letterSpacingEm: lsOf(at),
        anchor: "baseline-center" as const,
        language: cue.language,
        origin: { dx: 0, dy: item.originDy },
      };
      const landEdges = [wordAt + FADE_IN_MS, wordAt + landMs];

      // --- the fringe: two coloured copies under the word, wide while the card swings, the word arrives and the card leaves ---
      const f = (t: number) => {
        const arrive = t < wordAt ? 0 : 1 - EASES.out(prog(t, wordAt, isHero ? 360 : 240));
        return clamp(Math.max(arrive, 1 - EASES.out(prog(t, swingFrom, 420)) + out(t)));
      };
      const early = Math.max(swingFrom + 420, wordAt + (isHero ? 360 : 240));
      const windows: [number, number][] = exitFrom <= early + 40 ? [[from, to]] : [[from, early], [exitFrom, to]];
      for (const [w0, w1] of windows) {
        if (w1 <= w0 + 1) continue;
        fringeColours.forEach((colour, side) => {
          const dir = side === 0 ? -1 : 1;
          const offset = (t: number) => (3 + f(t) * (isHero ? 9 : 6)) * u * dir;
          pieces.push({
            ...base,
            id: `arthouse:${cueNumber}:f${at}${side}${w0 === from ? "a" : "b"}`,
            z: band + (isHero ? 3 : 1),
            fromMs: w0,
            toMs: w1,
            track: {
              ...poseTracks(get, w0, w1, landEdges),
              x: track((t) => get(t).x + get(t).l00 * offset(t), w0, w1, [...landEdges, early], 0.25),
              y: track((t) => get(t).y + get(t).l10 * offset(t), w0, w1, [...landEdges, early], 0.25),
              o: track((t) => fade(t) * (1 - out(t)) * 0.9 * f(t), w0, w1, [...landEdges, early], 0.01),
            },
            fill: colour,
          } satisfies TextPiece);
        });
      }

      // --- the word itself: lands on its spoken time, acid yellow while it is said, white once said ---
      const colour: ColourFrames = [[from, input.colours.accent], [word.endMs + 60, input.colours.accent], [word.endMs + 320, input.colours.primary]];
      pieces.push({
        ...base,
        id: `arthouse:${cueNumber}:w${at}`,
        z: band + (isHero ? 4 : 2),
        fromMs: from,
        toMs: to,
        track: {
          ...poseTracks(get, from, to, landEdges),
          o: track((t) => fade(t) * (1 - out(t)), from, to, landEdges, 0.01),
          ...(isHero ? {} : { colour }),
        },
        fill: isHero ? input.colours.highlight : input.colours.accent,
        shadows: shadow,
      } satisfies TextPiece);
    }
  }

  // --- the rule: wipes in under the last row with that row's first word ---
  const lastRow = rows[rows.length - 1]!;
  const ruleAt = Math.min(...lastRow.items.map((item) => ats[item.index]!)) - 60;
  const ruleFrom = ruleAt + 8;
  if (exitTo > ruleFrom + 1) {
    const lead = rtl ? lastRow.width / 2 - ruleW : -lastRow.width / 2;
    const trail = rtl ? -lastRow.width / 2 : lastRow.width / 2 - ruleW;
    const left = rulePlace === "center" ? -ruleW / 2 : rulePlace === "lead" ? lead : trail;
    const pivotX = rtl ? left + ruleW : left;
    const qy = ruleTop + (RULE_H * u) / 2 - height / 2;
    const wipe = (t: number) => EASES.outExpo(prog(t, ruleAt, 340));
    const get = memo((t) => pose(t, pivotX, qy, { rot: 0, sx: Math.max(0.0001, wipe(t)), sy: 1 }));
    const rule: ShapePiece = {
      id: `arthouse:${cueNumber}:rule`,
      kind: "shape",
      z: band + 2,
      fromMs: ruleFrom,
      toMs: exitTo,
      track: {
        ...poseTracks(get, ruleFrom, exitTo, [ruleAt + 340]),
        o: track((t) => 1 - out(t), ruleFrom, exitTo, [], 0.01),
      },
      origin: { dx: rtl ? ruleW : 0, dy: (RULE_H * u) / 2 },
      path: rectPath(0, 0, ruleW, RULE_H * u),
      fill: { colour: input.colours.highlight },
      shadows: shadow,
    };
    pieces.push(rule);
  }
  // The clamp samples every 16 ms and the key word's spring peaks between samples: keep a few px inside the safe area.
  const margin = 6 * u;
  return clampToSafeArea(pieces, { x1: safe.x1 + margin, y1: safe.y1 + margin, x2: safe.x2 - margin, y2: safe.y2 - margin }, input.measure);
}

export const arthouseProgram: SceneProgram = {
  build(input) {
    const counters = { hero: 0, plain: 0 };
    return { pieces: input.cues.flatMap((cue, number) => (cue.words.length === 0 ? [] : buildCue(cue, number, counters, input))) };
  },
};

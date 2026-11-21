import type { DemoScript } from "../demo";
import { EASES, clamp, lerp, prog } from "../ease";
import { sampleFrames } from "../frames";
import type { SceneCue, SceneInput, SceneProgram } from "../input";
import { balancedRows, clampToSafeArea, cueDirection, rowVisualOrder, sceneSpace } from "../layout";
import type { Clip, Frames, PathCmd, Piece, ShapePiece, TextPiece, Track } from "../scene";
import { pathBounds, polygonPath, rectPath, roundedRectPath } from "../shapes";

/**
 * Ledge (`samples/templates/m19-dropbar.js`, after Motion Array "Drop Bar Lower Thirds"): flat isometric label bars. A white slab
 * with a black keyline and a solid yellow depth face stretches along a tilted axis as the words are spoken, its leading edge
 * uncovering each word. A key word drops in on its own yellow slab with a white side, and a little cube sticker bounces onto its
 * corner (heart, bolt, star in turn).
 *
 * Geometry is the sample's, in its 1080 x 1920 frame: Anton caps at 80 (body) and 104 (key word) on bars 112 and 138 tall with a
 * 5 px keyline, a depth face 19 / 27 px deep that leans 15 / 21 px to the left, words 0.22 em apart inside 30 / 34 px of padding,
 * bars stacked 4 px under the previous depth face and stepped 44 px (58 next to a key word) along, the lot turned -9 degrees about
 * its own centre and centred on y 1290. The bar's body, depth and end caps are the sample's own polygons; the body and depth are
 * unstroked fills that scale along the bar (a stroked rectangle would thicken its sides while it grows), the keylines are fills too,
 * and the two caps are stroked polygons, the leading one riding the bar's end.
 *
 * What changed from the sample, and why (gallery-3 brief, 2026-11-21):
 * - The sticker's icon was picked by a counter of key-word cues already; the lockup's own variety was not: every cue turned -9 degrees
 *   and stepped right. Now a per-cue counter cycles the turn (-9, -7.2, -10.4, -8.2 degrees plus a seeded wobble), the step size and
 *   its side (right, left, right ...), and the stickers' icons by their own counters (key-word cues and plain cues count separately).
 *   Seeded hashes (FNV-1a and mulberry32, a seeded Fisher-Yates), never `Math.random` and never a cue-indexed table.
 * - Fit: `MAX_W 720` only split multi-word runs and a long single word never scaled. Rows now come from the words (balanced wraps of
 *   at most 720 px of bar), a bar whose word is still too wide shrinks (down to 0.45), and the lockup, sticker included, shrinks as
 *   a whole until its turned box fits the 5 % safe area (and the frame's height on 16:9). The sticker's keyline, the keylines and the
 *   depth face scale with their bar.
 * - Every key word gets its slab (the sample only honoured the first key word of a cue), and only the first one carries the cube.
 *   Runs of key words next to each other share one slab.
 * - Right-to-left cues mirror the lockup (the bars grow from the right, lean the other way, the cube sits on the left end, the
 *   words run right to left). Capitals only for cased scripts; words are never split into letters (the reveal is a clip), so every
 *   script works.
 * - Real speech: the sample's exit (120 ms, ending 90 ms before the cue ends) never starts before the last word has landed and
 *   been readable for 150 ms, and is shortened (down to 70 ms) when the next cue is close, rather than fading a late word mid-reveal;
 *   the cube's pop is compressed to land before it. The cube never starts before its key word is spoken.
 * - The sample's `drop-shadow(0 14px 22px)` under the whole lockup (re-rasterised every frame, a 22 px blur) is a smaller soft shadow (10 px
 *   down, a 4 px sigma, 0.28) on each bar's lowest layer (its depth face), which lands where the sample's shows below the bar (see `SHADOW`).
 * - New recurring beats, in the sample's own shapes and colours, on every cue: SPEED DASHES (two or three red slashes slanted like the
 *   depth faces pop out along the first bar's depth face as its edge passes them), POP TICKS (three short keylined ticks burst off the
 *   cube when it lands, a no-key-word cue gets a smaller cube on its last bar so it has them too) and POPCORN (two small flat cubes
 *   flip up and away from the first bar's top edge). Counts, positions, colours and sides come from the cue counter and a seeded hash,
 *   so a long clip keeps varying.
 */

export const LEDGE_DEMO: DemoScript = {
  lines: [
    "okay:b real:b talk",
    "i:m quit:b my:m job:h@520",
    "with:m zero:b savings:h@620",
    "and:m honestly",
    "best:b call:b ever:h@560",
  ],
  options: { rate: 300, cueGap: 170, tail: 750 },
};

const ANCHOR_LINE = 1290;
const FACE = "Anton" as const;
const LS = 0.012;
const OUT = 5;
const INK = "#111111";
const STICKER_RED = "#F0323C";
const TILTS = [-9, -7.2, -10.4, -8.2] as const;
const STEPS = [1, 0.8, 1.1, 0.9] as const;
const BODY = { size: 80, h: 112, dx: -15, dy: 19, pad: 30 } as const;
const HERO = { size: 104, h: 138, dx: -21, dy: 27, pad: 34 } as const;
type Spec = typeof BODY | typeof HERO;
const MAX_W = 720;
const SHRINK_FLOOR = 0.45;
const FIT = 0.975;
const GAP_EM = 0.22;
const REVEAL_LEAD = 85;
const REVEAL_MS = 230;
const HERO_DROP = 70;
const HERO_DROP_MS = 380;
const MIN_W = 14;
const EXIT = 120;
const EXIT_MIN = 70;
const EXIT_DROP = 46;
const CLEAR = 90;
const HOLD = 150;
/** How far a cue's exit may run into the next cue. */
const OVERLAP = 40;
const STICKER_SIZE = 70;
const STICKER_LEAD = 160;
const STICKER_MS = 420;
const MINI_SCALE = 0.62;
/** The lockup's own shadow: the sample's `0 14px 22px` is a 14 px offset and an 11 px sigma; this is 10 px and 4 (cost, see the header). */
const SHADOW = { dy: 10, blur: 4, alpha: 0.28 } as const;

const ICONS = {
  heart: "M0,9 C-14,-2 -16,-12 -9,-16 C-4,-19 0,-15 0,-11 C0,-15 4,-19 9,-16 C16,-12 14,-2 0,9 Z",
  star: "M0,-17 L5,-6 L17,-5 L8,3 L11,15 L0,9 L-11,15 L-8,3 L-17,-5 L-5,-6 Z",
  bolt: "M4,-18 L-10,3 L-1,3 L-5,18 L10,-4 L1,-4 Z",
} as const;
type Icon = keyof typeof ICONS;
const HERO_ICONS: readonly Icon[] = ["heart", "bolt", "star"];
const PLAIN_ICONS: readonly Icon[] = ["star", "heart", "bolt"];

/** The sample's `ease.outBack(p, 1.25)`. */
const outBack125 = (p: number) => 1 + 2.25 * (p - 1) ** 3 + 1.25 * (p - 1) ** 2;

/** FNV-1a of a string: the seed that makes a cue's variety a pure function of its index and words. */
export function ledgeHash(text: string): number {
  let h = 0x811c9dc5;
  for (let at = 0; at < text.length; at++) {
    h ^= text.charCodeAt(at);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The sample's seeded generator (mulberry32). */
export function ledgeRng(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let x = Math.imul(state ^ (state >>> 15), 1 | state);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seeded Fisher-Yates permutation of 0..n-1. */
export function ledgeShuffle(n: number, r: () => number): number[] {
  const order = Array.from({ length: n }, (_, at) => at);
  for (let at = n - 1; at > 0; at--) {
    const to = Math.floor(r() * (at + 1));
    [order[at], order[to]] = [order[to]!, order[at]!];
  }
  return order;
}

const SIMPLE = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Common}\p{Script=Inherited}]+$/u;
const PICTO = /\p{Extended_Pictographic}/u;

/** `text-transform: uppercase` for cased scripts only. */
export function ledgeCase(text: string): string {
  return SIMPLE.test(text) && !PICTO.test(text) ? text.toUpperCase() : text;
}

/** Chrome's baseline of a `line-height: 1` Anton box (ascent 1.176 em, descent 0.329 em, each rounded to whole px): 74 of 80, 96 of 104. */
export function ledgeBaseline(sizePx: number): number {
  const ascent = Math.round(1.176 * sizePx);
  const descent = Math.round(0.329 * sizePx);
  return (sizePx - (ascent + descent)) / 2 + ascent;
}

/** A bar's width at `t`, the sample's own formula: each word pulls the edge out to its reach with an outBack, the edge never retreats. */
export function ledgeBarWidth(t: number, items: readonly { readonly startMs: number; readonly reach: number }[]): number {
  let width = 0;
  let previous = MIN_W;
  for (const item of items) {
    const p = outBack125(prog(t, item.startMs - REVEAL_LEAD, REVEAL_MS));
    width = Math.max(width, lerp(previous, item.reach, p) * (p > 0 ? 1 : 0));
    previous = item.reach;
  }
  if (items.length > 0 && prog(t, items[0]!.startMs - REVEAL_LEAD, 1) > 0 && width < MIN_W) width = MIN_W;
  return width;
}

/** An SVG path of `M`, `L`, `C` and `Z` commands as scene commands, scaled by `k` about (0, 0). */
function svgPath(d: string, k: number): PathCmd[] {
  const tokens = d.match(/[MLCZ]|-?\d+(?:\.\d+)?/g) ?? [];
  const out: PathCmd[] = [];
  for (let at = 0; at < tokens.length; ) {
    const cmd = tokens[at++]!;
    if (cmd === "Z") out.push(["Z"]);
    else {
      const count = cmd === "C" ? 6 : 2;
      const nums = tokens.slice(at, at + count).map((token) => Number(token) * k);
      at += count;
      out.push([cmd, ...nums] as unknown as PathCmd);
    }
  }
  return out;
}

/** A cube as the sample draws its sticker: the two visible depth faces behind a square front, centred on (cx, cy). */
function cubePaths(cx: number, cy: number, half: number, dx: number, dy: number): { depth: PathCmd[]; front: PathCmd[] } {
  const a = (x: number, y: number): [number, number] => [cx + x, cy + y];
  return {
    depth: [
      ...polygonPath([a(-half, -half), a(-half, half), a(-half + dx, half + dy), a(-half + dx, -half + dy)]),
      ...polygonPath([a(-half, half), a(half, half), a(half + dx, half + dy), a(-half + dx, half + dy)]),
    ],
    front: rectPath(cx - half, cy - half, 2 * half, 2 * half),
  };
}

interface Counters {
  cues: number;
  heroes: number;
  plain: number;
}

interface Item {
  readonly index: number;
  readonly text: string;
  readonly box: number;
  readonly left: number;
  readonly right: number;
  readonly reach: number;
}

interface Plan {
  readonly hero: boolean;
  /** Cue word indices in reading order (the first spoken edge is the bar's leading edge). */
  readonly words: readonly number[];
}

interface Bar {
  readonly plan: Plan;
  readonly spec: Spec;
  readonly f: number;
  readonly size: number;
  readonly h: number;
  readonly dx: number;
  readonly dy: number;
  readonly pad: number;
  readonly out: number;
  readonly items: readonly Item[];
  readonly full: number;
  x: number;
  y: number;
}

interface Sticker {
  readonly bar: Bar;
  readonly cx: number;
  readonly cy: number;
  readonly size: number;
  readonly scale: number;
}

const rad = (degrees: number) => (degrees * Math.PI) / 180;

function buildCue(cue: SceneCue, cueNumber: number, input: SceneInput, counters: Counters): Piece[] {
  const space = sceneSpace(input, ANCHOR_LINE);
  const { u, safe } = space;
  const rtl = cueDirection(cue) === "rtl";
  const m = rtl ? -1 : 1;
  const texts = cue.words.map((word) => ledgeCase(word.text));
  const seed = ledgeHash(`${cue.index}|${cue.words.map((word) => word.text).join(" ")}`);
  const rng = ledgeRng(seed);
  const turn = counters.cues++;
  const tilt = TILTS[turn % TILTS.length]! + (rng() - 0.5) * 1.4;
  const stepSign = turn % 2 === 0 ? 1 : -1;
  const step = STEPS[turn % STEPS.length]! * (0.9 + 0.2 * rng());
  const heroIndexes = cue.words.map((word, index) => (word.role === "hero" ? index : -1)).filter((index) => index >= 0);
  const hasHero = heroIndexes.length > 0;
  const heroNumber = hasHero ? counters.heroes++ : 0;
  const plainNumber = hasHero ? 0 : counters.plain++;

  // --- bars: a run of key words, or of other words, wraps into balanced bars of at most 720 px ---
  const boxOf = (index: number, size: number) => input.measure(texts[index]!, FACE, size, LS).advance + LS * size;
  const segments: { hero: boolean; indices: number[] }[] = [];
  cue.words.forEach((word, index) => {
    const hero = word.role === "hero";
    const last = segments[segments.length - 1];
    if (last && last.hero === hero) last.indices.push(index);
    else segments.push({ hero, indices: [index] });
  });
  const plans: Plan[] = [];
  for (const segment of segments) {
    const spec = segment.hero ? HERO : BODY;
    const size = spec.size * u;
    const widths = segment.indices.map((index) => boxOf(index, size));
    const rows = balancedRows(widths, GAP_EM * size, MAX_W * u - 2 * spec.pad * u);
    for (const row of rows) {
      const indices = row.map((at) => segment.indices[at]!);
      // Reading order: the bidi visual order from the left, reversed for a right-to-left cue (the bar starts at the right).
      const visual = rowVisualOrder(indices.map((index) => texts[index]!), rtl ? "rtl" : "ltr").map((at) => indices[at]!);
      plans.push({ hero: segment.hero, words: rtl ? visual.reverse() : visual });
    }
  }

  const measureBar = (plan: Plan, f: number): Bar => {
    const spec = plan.hero ? HERO : BODY;
    const size = spec.size * f;
    const pad = spec.pad * f;
    const gap = GAP_EM * size;
    let left = pad;
    const boxes = plan.words.map((index) => {
      const box = boxOf(index, size);
      const item = { index, text: texts[index]!, box, left, right: left + box, reach: 0 };
      left += box + gap;
      return item;
    });
    const full = boxes[boxes.length - 1]!.right + pad;
    const items: Item[] = boxes.map((item, at) => ({ ...item, reach: at === boxes.length - 1 ? full : item.right + gap / 2 }));
    return { plan, spec, f, size, h: spec.h * f, dx: spec.dx * f, dy: spec.dy * f, pad, out: OUT * f, items, full, x: 0, y: 0 };
  };
  // A bar whose words are still too wide for 720 px shrinks on its own (down to a floor).
  const shrink = plans.map((plan) => {
    const natural = measureBar(plan, u).full;
    return natural > MAX_W * u ? clamp((MAX_W * u) / natural, SHRINK_FLOOR, 1) : 1;
  });
  const stickerBarOf = (bars: readonly Bar[]): { bar: Bar; scale: number } => {
    const heroBar = bars.find((bar) => bar.plan.hero);
    return heroBar ? { bar: heroBar, scale: 1 } : { bar: bars[bars.length - 1]!, scale: MINI_SCALE };
  };
  const layout = (g: number) => {
    const bars = plans.map((plan, at) => measureBar(plan, u * g * shrink[at]!));
    let x = 0;
    let y = 0;
    bars.forEach((bar, at) => {
      if (at > 0) {
        const previous = bars[at - 1]!;
        y += previous.h + previous.dy - 4 * previous.f;
        x += stepSign * (bar.plan.hero || previous.plan.hero ? 58 : 44) * bar.f * step;
      }
      bar.x = x;
      bar.y = y;
    });
    const { bar: host, scale } = stickerBarOf(bars);
    const size = STICKER_SIZE * host.f * scale;
    const sticker: Sticker = {
      bar: host,
      size,
      scale,
      cx: host.x + host.full + (host.plan.hero ? size * 0.5 + 22 * host.f : size * 0.5 + 16 * host.f),
      cy: host.plan.hero ? host.y + size * 0.62 : host.y + 0.42 * host.h,
    };
    // The lockup's box before turning: bars, their caps, and the cube with the room its ticks need.
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const bar of bars) {
      minX = Math.min(minX, bar.x + bar.dx - bar.out);
      maxX = Math.max(maxX, bar.x + bar.full + bar.out);
      minY = Math.min(minY, bar.y - bar.out);
      maxY = Math.max(maxY, bar.y + bar.h + bar.dy);
    }
    const reach = size / 2 + 26 * host.f;
    minX = Math.min(minX, sticker.cx - reach);
    maxX = Math.max(maxX, sticker.cx + reach);
    minY = Math.min(minY, sticker.cy - reach);
    maxY = Math.max(maxY, sticker.cy + reach);
    return { bars, sticker, box: { minX, maxX, minY, maxY } };
  };
  const turned = (geo: ReturnType<typeof layout>) => {
    const { minX, maxX, minY, maxY } = geo.box;
    const a = rad(tilt);
    const halfW = (Math.abs(Math.cos(a)) * (maxX - minX) + Math.abs(Math.sin(a)) * (maxY - minY)) / 2;
    const halfH = (Math.abs(Math.sin(a)) * (maxX - minX) + Math.abs(Math.cos(a)) * (maxY - minY)) / 2;
    return { w: 2 * halfW, h: 2 * halfH };
  };
  let g = 1;
  let geo = layout(g);
  for (let pass = 0; pass < 6; pass++) {
    const size = turned(geo);
    const ratio = Math.min((FIT * (safe.x2 - safe.x1)) / size.w, (FIT * (safe.y2 - safe.y1)) / size.h);
    if (ratio >= 1) break;
    g *= Math.max(0.3, ratio * 0.998);
    geo = layout(g);
  }
  const { bars, sticker, box } = geo;
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  const C = { x: space.x(540), y: space.y(ANCHOR_LINE) };
  const turnRad = rad(m * tilt);
  /** Canvas point of a point of the (unmirrored, unturned) lockup. */
  const P = (x: number, y: number) => {
    const vx = m * (x - cx);
    const vy = y - cy;
    return { x: C.x + vx * Math.cos(turnRad) - vy * Math.sin(turnRad), y: C.y + vx * Math.sin(turnRad) + vy * Math.cos(turnRad) };
  };

  // --- timing: the sample's reveals, an exit that waits for the last word to be readable ---
  const startOf = (index: number) => cue.words[index]!.startMs;
  const firstOf = (bar: Bar) => startOf(bar.items[0]!.index);
  const lastOf = (bar: Bar) => Math.max(...bar.items.map((item) => startOf(item.index)));
  const barLand = (bar: Bar) => (bar.plan.hero ? Math.max(lastOf(bar) - REVEAL_LEAD + REVEAL_MS, firstOf(bar) - REVEAL_LEAD + 300) : lastOf(bar) - REVEAL_LEAD + REVEAL_MS);
  const nominalExit = cue.endMs - CLEAR - EXIT;
  const hostFirst = firstOf(sticker.bar);
  const stickerAt = sticker.bar.plan.hero ? hostFirst + STICKER_LEAD : lastOf(sticker.bar) + 120;
  const stickerMs = clamp((nominalExit - 100 - stickerAt) / 0.55, 210, STICKER_MS);
  const stickerLand = stickerAt + 0.55 * stickerMs;
  const lastLand = Math.max(...bars.map(barLand), stickerLand);
  const exitFrom = Math.min(Math.max(nominalExit, lastLand + HOLD), cue.endMs + OVERLAP - EXIT_MIN);
  const exitDur = clamp(cue.endMs + OVERLAP - exitFrom, EXIT_MIN, EXIT);
  const exitTo = exitFrom + exitDur;
  const exitY = (t: number) => EXIT_DROP * u * EASES.in(prog(t, exitFrom, exitDur));
  const fadeOut = (t: number) => 1 - EASES.in(prog(t, exitFrom, exitDur));
  const fade = (from: number): Frames => (from < exitFrom ? [[from, 1], [exitFrom, 1], [exitTo, 0, "in"]] : [[from, 1], [exitTo, 0, "in"]]);
  const sampled = (fn: (t: number) => number, from: number, to: number, edges: readonly number[], tolerance: number): Frames =>
    sampleFrames(fn, [from, ...edges, exitFrom, exitTo, to], tolerance, { range: [from, to], wholeMs: true, simplify: true });

  const band = cueNumber * 220;
  const pieces: Piece[] = [];
  const tiltDeg = m * tilt;

  /** A local path moved so its pivot `q` (lockup coordinates) is the piece's pivot, mirrored for right-to-left cues. */
  const local = (path: readonly PathCmd[], q: { x: number; y: number }) => {
    const mapped = path.map((cmd): PathCmd => {
      if (cmd[0] === "Z") return cmd;
      const out: number[] = [];
      for (let at = 1; at < cmd.length; at += 2) out.push(m * ((cmd[at] as number) - q.x), (cmd[at + 1] as number) - q.y);
      return [cmd[0], ...out] as unknown as PathCmd;
    });
    const bounds = pathBounds(mapped);
    const shifted = mapped.map((cmd): PathCmd => {
      if (cmd[0] === "Z") return cmd;
      const out: number[] = [];
      for (let at = 1; at < cmd.length; at += 2) out.push((cmd[at] as number) - bounds.x1, (cmd[at + 1] as number) - bounds.y1);
      return [cmd[0], ...out] as unknown as PathCmd;
    });
    return { path: shifted, origin: { dx: -bounds.x1, dy: -bounds.y1 } };
  };
  const shape = (
    id: string,
    path: readonly PathCmd[],
    q: { x: number; y: number },
    from: number,
    to: number,
    track: Track,
    z: number,
    paint: Pick<ShapePiece, "fill" | "stroke" | "shadows" | "clip">,
  ): ShapePiece => {
    const placed = local(path, q);
    return { id: `ledge:${cueNumber}:${id}`, kind: "shape", z, fromMs: from, toMs: to, origin: placed.origin, path: placed.path, track, ...paint };
  };
  /** x, y of a pivot at lockup point `q + offset(t)`, with the lockup's exit drop. */
  const position = (q: { x: number; y: number }, from: number, to: number, offset: (t: number) => { dx: number; dy: number }, edges: readonly number[]) => ({
    x: sampled((t) => P(q.x + offset(t).dx, q.y + offset(t).dy).x, from, to, edges, 0.25),
    y: sampled((t) => P(q.x + offset(t).dx, q.y + offset(t).dy).y + exitY(t), from, to, edges, 0.25),
  });
  /** A path moved by (dx, dy). */
  const moved = (path: readonly PathCmd[], dx: number, dy: number): PathCmd[] =>
    path.map((cmd): PathCmd => {
      if (cmd[0] === "Z") return cmd;
      const out: number[] = [];
      for (let at = 1; at < cmd.length; at += 2) out.push((cmd[at] as number) + dx, (cmd[at + 1] as number) + dy);
      return [cmd[0], ...out] as unknown as PathCmd;
    });

  const toMs = Math.ceil(exitTo);
  const openClip = (x1: Frames, x2: Frames): Clip => ({ x1, x2, y1: [[0, 0]], y2: [[0, input.canvas.height]] });
  const wideOpen: Frames = [[0, 0]];

  const barInfo: { bar: Bar; width: (t: number) => number; dropOf: (t: number) => number; from: number; edges: number[] }[] = [];
  bars.forEach((bar, barAt) => {
    const first = firstOf(bar);
    const from = Math.round(first - REVEAL_LEAD);
    if (toMs <= from + 2) return;
    const z = band + barAt * 14;
    const starts = bar.items.map((item) => ({ startMs: startOf(item.index), reach: item.reach }));
    const width = (t: number) => ledgeBarWidth(t, starts);
    const dropOf = bar.plan.hero ? (t: number) => (1 - EASES.spring(prog(t, first - REVEAL_LEAD, HERO_DROP_MS))) * -HERO_DROP * bar.f : () => 0;
    const edges = [...bar.items.flatMap((item) => [startOf(item.index) - REVEAL_LEAD, startOf(item.index) - REVEAL_LEAD + REVEAL_MS]), first - REVEAL_LEAD + HERO_DROP_MS];
    const origin = { x: bar.x, y: bar.y };
    const moving = (t: number) => ({ dx: 0, dy: dropOf(t) });
    const rest = position(origin, from, toMs, moving, edges);
    const half = bar.out / 2;
    const h = bar.h;
    const depthW = bar.full + bar.dx;
    const scaleX = (denominator: number, fn: (t: number) => number) => sampled((t) => Math.max(0.01, fn(t) / denominator), from, toMs, edges, 0.002);
    const sxFace = scaleX(bar.full, width);
    const sxDepth = scaleX(depthW, (t) => width(t) + bar.dx);
    const trackOf = (sx: Frames): Track => ({ ...rest, sx, rz: [[from, tiltDeg]], o: fade(from) });
    const plain = (): Track => ({ ...rest, rz: [[from, tiltDeg]], o: fade(from) });
    const barId = `b${barAt}`;
    // Body bar: white face, yellow depth and caps. Key word's bar: yellow face, white depth and caps.
    const faceColour = bar.plan.hero ? input.colours.highlight : input.colours.primary;
    const edgeColour = bar.plan.hero ? input.colours.primary : input.colours.highlight;
    pieces.push(
      shape(`${barId}di`, moved(rectPath(0, h - half, depthW, bar.dy), bar.x, bar.y), origin, from, toMs, trackOf(sxDepth), z, {
        fill: { colour: INK },
        shadows: [{ dx: 0, dy: SHADOW.dy * bar.f, blur: SHADOW.blur * bar.f, colour: input.colours.shadow, alpha: SHADOW.alpha }],
      }),
      shape(`${barId}df`, moved(rectPath(0, h - half, depthW, bar.dy - bar.out), bar.x, bar.y), origin, from, toMs, trackOf(sxDepth), z + 2, { fill: { colour: edgeColour } }),
      shape(`${barId}fi`, moved(rectPath(0, 0, bar.full, h), bar.x, bar.y), origin, from, toMs, trackOf(sxFace), z + 4, { fill: { colour: INK } }),
      shape(`${barId}ff`, moved(rectPath(0, bar.out, bar.full, h - 2 * bar.out), bar.x, bar.y), origin, from, toMs, trackOf(sxFace), z + 6, { fill: { colour: faceColour } }),
      shape(`${barId}cl`, moved(polygonPath([[0, half], [0, h - half], [bar.dx, h + bar.dy - half], [bar.dx, bar.dy + half]]), bar.x, bar.y), origin, from, toMs, plain(), z + 8, {
        fill: { colour: edgeColour },
        stroke: { widthPx: bar.out, colour: INK },
      }),
    );
    const capPivot = (t: number) => ({ dx: width(t), dy: dropOf(t) });
    const capTrack = position(origin, from, toMs, capPivot, edges);
    pieces.push(
      shape(`${barId}cr`, moved(polygonPath([[0, half], [0, h - half], [bar.dx, h + bar.dy - half], [bar.dx, h - half]]), bar.x, bar.y), origin, from, toMs, { ...capTrack, rz: [[from, tiltDeg]], o: fade(from) }, z + 9, {
        fill: { colour: edgeColour },
        stroke: { widthPx: bar.out, colour: INK },
      }),
    );
    barInfo.push({ bar, width, dropOf, from, edges });
    // Words: laid along the face, uncovered by a clip that follows the bar's leading edge (4 px short of it, as the sample).
    const centreY = bar.y + h / 2;
    const edgeAt = (t: number) => P(bar.x + width(t) - 4 * bar.f, centreY + dropOf(t)).x;
    const edgeFrames = sampled(edgeAt, from, toMs, edges, 0.25);
    const clip = rtl ? openClip(edgeFrames, [[0, input.canvas.width]]) : openClip(wideOpen, edgeFrames);
    const baselineY = bar.y + ((h / bar.f - 1.04 * bar.spec.size) / 2 + 0.04 * bar.spec.size + ledgeBaseline(bar.spec.size)) * bar.f;
    for (const item of bar.items) {
      const start = startOf(item.index);
      const wordFrom = Math.round(start - REVEAL_LEAD);
      // The word's visual left end: the left edge of its box, or for a mirrored lockup the mirror of its right edge.
      const anchorX = bar.x + (rtl ? item.right : item.left);
      const track = position({ x: anchorX, y: baselineY }, wordFrom, toMs, moving, edges);
      pieces.push({
        id: `ledge:${cueNumber}:w${item.index}`,
        kind: "text",
        z: z + 11,
        fromMs: wordFrom,
        toMs,
        track: { ...track, rz: [[wordFrom, tiltDeg]], o: fade(wordFrom) },
        clip: { x1: clip.x1, x2: clip.x2, y1: clip.y1, y2: clip.y2 },
        text: item.text,
        face: FACE,
        sizePx: bar.size,
        letterSpacingEm: LS,
        fill: INK,
        anchor: "baseline-left",
        language: cue.language,
      } satisfies TextPiece);
    }
  });

  // --- the cube sticker: bounces onto the key word's corner (a smaller one on the last bar of a cue without a key word) ---
  const host = barInfo.find((info) => info.bar === sticker.bar);
  const zTop = band + 150;
  const k = sticker.bar.f * sticker.scale;
  const stickerFrom = Math.round(stickerAt) + 10;
  const stickerAnchor = { x: sticker.cx, y: sticker.cy };
  const stickerPop = (t: number) => EASES.spring(prog(t, stickerAt, stickerMs));
  const stickerFall = (t: number) => -(1 - EASES.outExpo(prog(t, stickerAt, (stickerMs * 260) / 420))) * 60 * sticker.bar.f;
  if (host && toMs > stickerFrom + 40) {
    const edges = [stickerAt, stickerAt + stickerMs, stickerAt + (stickerMs * 260) / 420];
    const icon = sticker.bar.plan.hero ? HERO_ICONS[heroNumber % HERO_ICONS.length]! : PLAIN_ICONS[plainNumber % PLAIN_ICONS.length]!;
    const cube = cubePaths(stickerAnchor.x, stickerAnchor.y, (STICKER_SIZE / 2) * k, -12 * k, 13 * k);
    const base = position(stickerAnchor, stickerFrom, toMs, (t) => ({ dx: 0, dy: stickerFall(t) }), edges);
    const scale = sampled(stickerPop, stickerFrom, toMs, edges, 0.002);
    const track: Track = { ...base, sx: scale, sy: scale, rz: sampled((t) => tiltDeg + m * (1 - stickerPop(t)) * -25, stickerFrom, toMs, edges, 0.05), o: fade(stickerFrom) };
    const stroke = { widthPx: (OUT - 1) * k, colour: INK };
    pieces.push(
      shape("stk0", cube.depth, stickerAnchor, stickerFrom, toMs, track, zTop, { fill: { colour: input.colours.highlight }, stroke }),
      shape("stk1", cube.front, stickerAnchor, stickerFrom, toMs, track, zTop + 1, { fill: { colour: input.colours.primary }, stroke }),
      shape("stk2", moved(svgPath(ICONS[icon], 1.35 * k), stickerAnchor.x, stickerAnchor.y), stickerAnchor, stickerFrom, toMs, track, zTop + 2, { fill: { colour: STICKER_RED } }),
    );

    // --- pop ticks: three keylined ticks burst off the cube as it lands ---
    const tickSets = [[-50, -6, 40], [-34, 12, 54]] as const;
    const set = tickSets[(sticker.bar.plan.hero ? heroNumber : plainNumber + 1) % 2]!;
    const reach0 = (STICKER_SIZE / 2 + 17) * k;
    set.forEach((angle, j) => {
      const phi = angle + (rng() - 0.5) * 14;
      const t0 = Math.round(stickerLand + j * 45);
      const life = 380;
      const to = Math.min(toMs, t0 + life);
      if (to <= t0 + 30) return;
      const radius = (t: number) => reach0 + 12 * k * EASES.out(prog(t, t0, 160));
      const dir = { x: Math.cos(rad(phi)), y: Math.sin(rad(phi)) };
      const tickEdges = [t0 + 130, t0 + 160, t0 + life - 130];
      const pivot = { x: stickerAnchor.x + dir.x * reach0, y: stickerAnchor.y + dir.y * reach0 };
      const grow = sampled((t) => lerp(0.2, 1, outBack125(prog(t, t0, 130))), t0, to, tickEdges, 0.002);
      const own = (t: number) => 1 - prog(t, t0 + life - 130, 130);
      const tickTrack: Track = {
        ...position(pivot, t0, to, (t) => ({ dx: dir.x * (radius(t) - reach0), dy: dir.y * (radius(t) - reach0) }), tickEdges),
        sx: grow,
        sy: grow,
        rz: [[t0, m * (tilt + phi)]],
        o: sampled((t) => own(t) * fadeOut(t), t0, to, tickEdges, 0.01),
      };
      pieces.push(
        shape(`tk${j}`, roundedRectPath(pivot.x - 10 * k, pivot.y - 4.5 * k, 20 * k, 9 * k, 4.5 * k), pivot, t0, to, tickTrack, zTop - 6, {
          fill: { colour: (j + turn) % 2 === 0 ? input.colours.highlight : input.colours.primary },
          stroke: { widthPx: 3.5 * k, colour: INK },
        }),
      );
    });
  }

  // --- speed dashes: red slashes, slanted like the depth faces, pop out along the first bar's depth face as its edge passes ---
  const lead = barInfo[0];
  if (lead) {
    const { bar, width, dropOf, from, edges } = lead;
    const count = [3, 2, 3, 2][turn % 4]!;
    const fractions = count === 3 ? [0.18, 0.5, 0.82] : [0.3, 0.72];
    const strip = bar.dy - 1.5 * bar.out;
    const dh = 0.75 * strip;
    const slant = dh * (-bar.dx / bar.dy);
    const range = bar.full + bar.dx;
    const order = ledgeShuffle(count, rng);
    order.forEach((slot, j) => {
      const dw = (24 + 12 * rng()) * bar.f;
      const margin = 18 * bar.f;
      const usable = range - 2 * margin - dw;
      if (usable < dw) return;
      const cxLocal = margin + dw / 2 + clamp(fractions[slot]! + (rng() - 0.5) * 0.1, 0, 1) * usable;
      let appear = Number.NaN;
      for (let t = from; t < exitFrom; t += 5) {
        if (width(t) + bar.dx >= cxLocal + dw / 2 + 4 * bar.f) {
          appear = t;
          break;
        }
      }
      if (Number.isNaN(appear)) return;
      const t0 = Math.round(appear + j * 25);
      const pivot = { x: bar.x + cxLocal, y: bar.y + bar.h + strip / 2 - 0.5 * bar.f };
      const dashEdges = [t0, t0 + 110, t0 + 500];
      const popped = sampled((t) => lerp(0.15, 1, outBack125(prog(t, t0, 110))), t0, toMs, dashEdges, 0.002);
      const slide = (t: number) => -8 * bar.f * (1 - EASES.out(prog(t, t0, 500)));
      if (toMs <= t0 + 30) return;
      const path = polygonPath([
        [pivot.x - dw / 2 + slant / 2, pivot.y - dh / 2],
        [pivot.x + dw / 2 + slant / 2, pivot.y - dh / 2],
        [pivot.x + dw / 2 - slant / 2, pivot.y + dh / 2],
        [pivot.x - dw / 2 - slant / 2, pivot.y + dh / 2],
      ]);
      pieces.push(
        shape(`ds${j}`, path, pivot, t0, toMs, {
          ...position(pivot, t0, toMs, (t) => ({ dx: slide(t), dy: dropOf(t) }), [...edges, ...dashEdges]),
          sx: popped,
          rz: [[t0, tiltDeg]],
          o: fade(t0),
        }, band + 3, { fill: { colour: STICKER_RED } }),
      );
    });

    // --- popcorn: two small flat cubes flip up and away from the first bar's top edge ---
    const swatches = [[input.colours.primary, input.colours.highlight], [input.colours.highlight, input.colours.primary], [STICKER_RED, input.colours.primary]] as const;
    const sideBase = rng() < 0.5 ? 1 : -1;
    for (let j = 0; j < 2; j++) {
      const at = Math.round(lastOf(bar) + 40 + j * 110);
      const dur = clamp(toMs - at, 240, 600);
      const to = Math.min(toMs, at + dur);
      if (to <= at + 30) continue;
      const start = { x: bar.x + (0.45 + 0.4 * rng()) * bar.full * (j === 0 ? 0.85 : 1.1) + 0, y: bar.y - 4 * bar.f };
      start.x = clamp(start.x, bar.x + 0.2 * bar.full, bar.x + 0.92 * bar.full);
      const rise = (70 + 40 * rng()) * bar.f;
      let drift = (sideBase * (j === 0 ? 1 : -1)) * (18 + 26 * rng()) * bar.f;
      const endPoint = P(start.x + drift, start.y - rise);
      if (endPoint.x < safe.x1 + 30 * bar.f || endPoint.x > safe.x2 - 30 * bar.f) drift = -drift;
      const spin = (j === 0 ? 1 : -1) * (30 + 35 * rng());
      const half = 13 * bar.f;
      const cube = cubePaths(start.x, start.y, half, -5.5 * bar.f, 6 * bar.f);
      const [face, depth] = swatches[(turn * 2 + j) % swatches.length]!;
      const flightEdges = [at + 130, at + 0.55 * dur, at + dur];
      const flown = (t: number) => EASES.out(prog(t, at, dur));
      const scale = sampled((t) => lerp(0.35, 1, outBack125(prog(t, at, 130))), at, to, flightEdges, 0.002);
      const track: Track = {
        ...position(start, at, to, (t) => ({ dx: drift * flown(t), dy: -rise * flown(t) }), flightEdges),
        sx: scale,
        sy: scale,
        rz: sampled((t) => tiltDeg + m * spin * flown(t), at, to, flightEdges, 0.05),
        o: sampled((t) => (1 - prog(t, at + 0.55 * dur, 0.45 * dur)) * fadeOut(t), at, to, flightEdges, 0.01),
      };
      const stroke = { widthPx: 3 * bar.f, colour: INK };
      pieces.push(
        shape(`pc${j}d`, cube.depth, start, at, to, track, zTop - 4, { fill: { colour: depth }, stroke }),
        shape(`pc${j}f`, cube.front, start, at, to, track, zTop - 3, { fill: { colour: face }, stroke }),
      );
    }
  }

  return clampToSafeArea(pieces, safe, input.measure);
}

export const ledgeProgram: SceneProgram = {
  build(input) {
    const counters: Counters = { cues: 0, heroes: 0, plain: 0 };
    return { pieces: input.cues.flatMap((cue, number) => (cue.words.length === 0 ? [] : buildCue(cue, number, input, counters))) };
  },
};

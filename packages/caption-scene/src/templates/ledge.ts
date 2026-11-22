import { captionColourContrast } from "@narriflow/validators";
import type { DemoScript } from "../demo";
import { EASES, clamp, lerp, prog } from "../ease";
import { SCENE_DEFAULT_FPS, exportFrameAtOrAfter, exportFrameAtOrBefore, paintedFrameCount, sceneSampleRate } from "../frame-grid";
import { sampleFrames } from "../frames";
import type { SceneCue, SceneInput, SceneProgram } from "../input";
import { balancedRows, cueDirection, rowVisualOrder, sceneSpace, shiftPiece } from "../layout";
import { type Box, type Clip, type Frames, type PathCmd, type Piece, type ShapePiece, type TextPiece, type Track, pieceBounds, sceneBoundsAt } from "../scene";
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
 * - Review fixes (2026-11-21), the gallery-3 cue handoff rule, reasoned in painted 30 fps frames. Entrances are locked to speech (a word's
 *   piece starts 85 ms before it is spoken, less when the cue before needs the room, never after; with a lead under 67 ms the reveal and
 *   the key word's drop are already open and settled) and never wait for the cue before. The outgoing cue gives way in the rule's order:
 *   its exit is shortened to a cut; the two lockups overlap where the next cue's pieces are not over its ink (the next cue is built as a
 *   probe and the first painted frame in which a piece covers a word's ink is the cut); the next entrance's lead shrinks toward 0; and only
 *   then are the entrance effects quickened, word by word and as little as needed (down to 80 ms). It leaves on the next cue's first painted
 *   frame (no covering, no blank frame in continuous speech), or by its own end when nothing follows soon. Every window is two painted
 *   frames or the decoration is left out (text never is: the last word's window is floored at two frames), and a motion that cannot settle
 *   in its window is drawn settled. Outgoing words sit above the next cue's bars. A bar and baseline are as tall as the measured ink needs
 *   when a script is taller than Anton (Anton's size is the minimum); a bar's timing follows the order the words are spoken in, its placement
 *   the bidi order; the exit drop scales with the fitted lockup and is reserved in the fit with the reveal's overshoot, and the shift into
 *   the safe area is searched every 4 ms, every ms of the exit and of the first 450 ms; the red is `#E82D37` (3.1:1 on the catalogue's
 *   yellow depth, and the brand guard names it), and dashes turn to ink or white when a brand's depth colour is within 3:1 of it.
 * - Ship fixes: a cue that starts while the cue before is still being spoken (two speakers) is stacked under it, or over it when there is no
 *   room, so two lockups never share a spot and the first one keeps its natural hold; the 150 ms of a word start where its ink is open
 *   and settled (not where its reveal's window ends), so a normal 60 ms gap keeps the next cue's sample entrance; the cube's hold is fitted
 *   into what is left; a cue too short for an accent's motion shows it static from two frames before it leaves; a word whose reveal
 *   cannot finish a frame before the cue goes is open at once; `frameAtOrBefore` returns the real preceding frame.
 * - Ship fixes 2: the handoff looks at every later cue that can be painted before this one has gone (each built as a probe after the one before),
 *   not only the next; a word is never exited before its spoken end (the first exit frame is at or after it; the next entrance's lead steps
 *   down 85, 80, 78 ... 67 to find the frame boundary that allows it, and only then is its reveal quickened, before any lead under 67 ms); a
 *   reveal that would end after the cue is shortened to two painted frames at least before it is dropped; and the text clips' open edges are
 *   unbounded, so the safe-area shift of a stacked cue never moves one over the row it clips.
 *   All frame reasoning (two painted frames, the first frame at or after an onset) uses the shared export frame grid at the render's own
 *   rate (`input.fps`, 24/25/30/60), not 30 fps constants.
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
/** The sample's red, nudged to clear 3:1 on the catalogue's yellow depth faces (`#E82D37` on `#FFD83A` is 3.1:1). */
const STICKER_RED = "#E82D37";
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
const EXIT_DROP = 46;
const CLEAR = 90;
const HOLD = 150;
const STICKER_HOLD = 90;
const STICKER_SIZE = 70;
const STICKER_LEAD = 160;
const STICKER_MS = 420;
const MINI_SCALE = 0.62;
/** The lockup's own shadow: the sample's `0 14px 22px` is a 14 px offset and an 11 px sigma; this is 10 px and 4 (cost, see the header). */
/** An animated exit, entrance or accent lasts at least this long (two 30 fps frames); anything shorter is a cut or is left out. */
/** Room kept between a word's ink and the keylines above and below it. */
const INK_GAP = 4;
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
export function ledgeBarWidth(t: number, items: readonly { readonly startMs: number; readonly reach: number; readonly ms?: number }[], lead = REVEAL_LEAD, revealMs = REVEAL_MS): number {
  let width = 0;
  let previous = MIN_W;
  for (const item of items) {
    const p = outBack125(prog(t, item.startMs - lead, item.ms ?? revealMs));
    width = Math.max(width, lerp(previous, item.reach, p) * (p > 0 ? 1 : 0));
    previous = item.reach;
  }
  if (items.length > 0 && prog(t, items[0]!.startMs - lead, 1) > 0 && width < MIN_W) width = MIN_W;
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
  /** The lead (ms before its first word) this cue's entrance uses: shorter when the cue before is squeezed against it. */
  lead: number;
  cues: number;
  heroes: number;
  plain: number;
  /** The cue before: where its lockup is and when its last word ends (a cue that starts inside it stacks beside it). */
  prev: { box: Box; lastEnd: number } | null;
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
  /** Baseline of the words, px below the bar's top. */
  readonly baseline: number;
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

/** `probe` builds the cue as a throwaway to see where it would be (the cue before asks where they meet): it looks at no cue after it. */
function buildCue(cue: SceneCue, cueNumber: number, input: SceneInput, counters: Counters, probe = false): Piece[] {
  const space = sceneSpace(input, ANCHOR_LINE);
  const { u, safe } = space;
  // The export's own frame grid at the render's real rate: "painted frames" means what the ASS writer samples.
  const fps = input.fps ?? SCENE_DEFAULT_FPS;
  const rate = sceneSampleRate(fps);
  const oneFrame = Math.ceil(1000 / rate);
  /** Two painted frames: the least an animation (or a decoration) may last. */
  const minAnim = Math.ceil(2000 / rate);
  const frameAtOrAfter = (t: number) => exportFrameAtOrAfter(t, fps);
  const frameAtOrBefore = (t: number) => exportFrameAtOrBefore(t, fps);
  const paintedFrames = (from: number, to: number) => paintedFrameCount(from, to, fps);
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
    // The bar is Anton's height at least; a script whose ink is taller (Arabic, Devanagari) gets the bar and baseline its measured ink needs.
    const inks = plan.words.map((index) => input.measure(texts[index]!, FACE, size, LS));
    const above = Math.max(...inks.map((ink) => -ink.inkTop));
    const below = Math.max(...inks.map((ink) => ink.inkBottom));
    const out = OUT * f;
    const room = INK_GAP * f;
    const nominal = ((spec.h - 1.04 * spec.size) / 2 + 0.04 * spec.size + ledgeBaseline(spec.size)) * f;
    const lowest = out + room + above;
    let h = spec.h * f;
    let baseline = nominal;
    if (lowest > h - out - room - below) {
      h = lowest + below + room + out;
      baseline = lowest;
    } else baseline = clamp(nominal, lowest, h - out - room - below);
    return { plan, spec, f, size, h, dx: spec.dx * f, dy: spec.dy * f, pad, out, items, full, baseline, x: 0, y: 0 };
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
  const overshootOf = (bar: Bar) => {
    let reached = MIN_W * bar.f;
    let biggest = 0;
    for (const item of [...bar.items].sort((a, b) => cue.words[a.index]!.startMs - cue.words[b.index]!.startMs)) {
      biggest = Math.max(biggest, item.reach - reached);
      reached = Math.max(reached, item.reach);
    }
    return 0.06 * biggest;
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
      // The reveal overshoots its reach (outBack peaks 5.7 % past the biggest step), and the edge is part of the lockup then.
      maxX = Math.max(maxX, bar.x + bar.full + bar.out + overshootOf(bar));
      minY = Math.min(minY, bar.y - bar.out);
      // The caps' keylines reach half a stroke past their corners; the engine's bounds count them whole.
      maxY = Math.max(maxY, bar.y + bar.h + bar.dy + bar.out / 2);
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
    // The exit drop is part of the lockup's height: it must stay inside the safe area too.
    const ratio = Math.min((FIT * (safe.x2 - safe.x1)) / size.w, (FIT * (safe.y2 - safe.y1)) / (size.h + EXIT_DROP * u * g));
    if (ratio >= 1) break;
    g *= Math.max(0.3, ratio * 0.998);
    geo = layout(g);
  }
  const { bars, sticker, box } = geo;
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  const turnRad = rad(m * tilt);
  const dropPx = EXIT_DROP * u * g;
  const home = { x: space.x(540), y: space.y(ANCHOR_LINE) };
  /** Canvas point of a point of the (unmirrored, unturned) lockup, for a lockup centred on `centre`. */
  const pointAt = (centre: { x: number; y: number }, x: number, y: number) => {
    const vx = m * (x - cx);
    const vy = y - cy;
    return { x: centre.x + vx * Math.cos(turnRad) - vy * Math.sin(turnRad), y: centre.y + vx * Math.sin(turnRad) + vy * Math.cos(turnRad) };
  };
  /** The turned lockup's box (bars and cube, the exit drop included) for a lockup centred on `centre`. */
  const lockupBoxAt = (centre: { x: number; y: number }): Box => {
    const corners = [pointAt(centre, box.minX, box.minY), pointAt(centre, box.maxX, box.minY), pointAt(centre, box.maxX, box.maxY), pointAt(centre, box.minX, box.maxY)];
    return { x1: Math.min(...corners.map((c) => c.x)), y1: Math.min(...corners.map((c) => c.y)), x2: Math.max(...corners.map((c) => c.x)), y2: Math.max(...corners.map((c) => c.y)) + dropPx };
  };
  // A cue that starts while the cue before is still being spoken (two speakers) has its own place: stacked under it, or over it when
  // there is no room under, so two lockups never share a spot and each word is read where it is spoken.
  const onsetFirst = Math.min(...cue.words.map((word) => word.startMs));
  let stackDy = 0;
  if (counters.prev && onsetFirst < counters.prev.lastEnd) {
    const own = lockupBoxAt(home);
    const gap = 14 * u * g;
    const below = counters.prev.box.y2 + gap - own.y1;
    const above = counters.prev.box.y1 - gap - own.y2;
    const roomBelow = safe.y2 - (own.y2 + below);
    const roomAbove = own.y1 + above - safe.y1;
    stackDy = roomBelow >= 0 ? below : roomAbove >= 0 ? above : roomBelow >= roomAbove ? below : above;
  }
  const C = { x: home.x, y: home.y + stackDy };
  /** Canvas point of a point of the (unmirrored, unturned) lockup. */
  const P = (x: number, y: number) => pointAt(C, x, y);
  const ownBox = lockupBoxAt(C);
  const lastWordEnd = Math.max(...cue.words.map((word) => word.endMs));

  // --- timing: entrances are locked to speech; the handoff to the next cue is settled on this (outgoing) side ---
  // Every word's reveal starts `lead` ms before it is spoken, whatever the cue before did. When the next cue is close, this cue's
  // reveal is quickened, its cube and ticks are fitted before its exit, and its exit is the last moment before the next entrance
  // (a cut when the words had barely the time they needed): never a delay of the next cue.
  const lead = counters.lead;
  const startOf = (index: number) => cue.words[index]!.startMs;
  const firstOf = (bar: Bar) => Math.min(...bar.items.map((item) => startOf(item.index)));
  const lastOf = (bar: Bar) => Math.max(...bar.items.map((item) => startOf(item.index)));
  const lastSpoken = Math.max(...cue.words.map((word) => word.startMs));
  const nextAt = probe ? -1 : input.cues.findIndex((candidate, at) => at > cueNumber && candidate.words.length > 0);
  const next = nextAt >= 0 ? input.cues[nextAt] : undefined;
  const nextFirst = next ? Math.min(...next.words.map((word) => word.startMs)) : Number.POSITIVE_INFINITY;
  const continuous = next !== undefined && nextFirst - cue.endMs <= 100;
  const hostFirst = firstOf(sticker.bar);
  const cos = Math.cos(turnRad);
  const sin = Math.sin(turnRad);
  /** The rest ink of every word, as the box of the turned word (what a piece of the next cue may not cover), and when it is first there. */
  const inkBoxes = bars.flatMap((bar) =>
    bar.items.map((item) => {
      const ink = input.measure(item.text, FACE, bar.size, LS);
      const anchor = P(bar.x + (rtl ? item.right : item.left), bar.y + bar.baseline);
      const corners = [[0, ink.inkTop], [ink.advance, ink.inkTop], [ink.advance, ink.inkBottom], [0, ink.inkBottom]].map(([x, y]) => ({ x: anchor.x + x! * cos - y! * sin, y: anchor.y + x! * sin + y! * cos }));
      const box: Box = { x1: Math.min(...corners.map((c) => c.x)), y1: Math.min(...corners.map((c) => c.y)), x2: Math.max(...corners.map((c) => c.x)), y2: Math.max(...corners.map((c) => c.y)) };
      return { box, from: startOf(item.index) - lead };
    }),
  );
  const meets = new Map<number, number>();
  /** The first ms a piece of the next cue, entering `nextLead` ms before its first word, is drawn over the ink of a word of this cue. */
  const firstMeeting = (nextLead: number): number => {
    if (!next) return Number.POSITIVE_INFINITY;
    const known = meets.get(nextLead);
    if (known !== undefined) return known;
    // Every later cue that can be on screen before this one has cleared, not only the next: each is built as a probe after the one before.
    const chain = { ...counters, lead: nextLead, prev: { box: ownBox, lastEnd: lastWordEnd } };
    const incoming: Piece[] = [];
    for (let at = nextAt; at < input.cues.length; at++) {
      const later = input.cues[at]!;
      if (later.words.length === 0) continue;
      if (at > nextAt && Math.min(...later.words.map((word) => word.startMs)) - REVEAL_LEAD > cue.endMs + 150) break;
      incoming.push(...buildCue(later, at, input, chain, true));
    }
    const from = Math.min(...incoming.map((piece) => piece.fromMs));
    let hit = Number.POSITIVE_INFINITY;
    // Looked at on the export's frames only: the first painted frame in which they meet.
    for (let t = frameAtOrAfter(from); t < from + 1600 && hit === Number.POSITIVE_INFINITY; t = frameAtOrAfter(t + 1)) {
      for (const piece of incoming) {
        const box = pieceBounds(piece, t, input.measure);
        if (box && inkBoxes.some((ink) => ink.from <= t && box.x1 < ink.box.x2 && box.x2 > ink.box.x1 && box.y1 < ink.box.y2 && box.y2 > ink.box.y1)) {
          hit = t;
          break;
        }
      }
    }
    meets.set(nextLead, hit);
    return hit;
  };
  /** Every word of this cue gets a window of its own, whatever the next cue does (speakers overlap). */
  const nextOverlaps = next !== undefined && nextFirst < lastWordEnd;
  const wordFloor = nextOverlaps ? frameAtOrAfter(lastSpoken) + minAnim + 1 : frameAtOrAfter(lastSpoken - lead) + oneFrame + 1;
  /** Where this cue would end for a next cue entering `nextLead` ms early: its first frame, or this cue's own end when nothing follows soon. */
  const endFor = (nextLead: number) => (next ? (continuous || nextFirst < cue.endMs ? frameAtOrAfter(Math.round(nextFirst - nextLead)) : Math.min(frameAtOrAfter(Math.round(nextFirst - nextLead)), cue.endMs)) : cue.endMs);
  /** A bar's reveal as `ledgeBarWidth` reads it: in the order the words are spoken, the edge pulled out to the furthest reach so far. */
  const chronological = (bar: Bar, revealOf: (index: number) => number) => {
    let reached = 0;
    return [...bar.items]
      .sort((x, y) => startOf(x.index) - startOf(y.index))
      .map((item) => {
        reached = Math.max(reached, item.reach);
        return { startMs: startOf(item.index), reach: reached, ms: revealOf(item.index) };
      });
  };
  /** When every word of a bar is open (the clip's edge is past its ink): from then the word is settled and can be read. */
  const inkOpen = (bar: Bar, revealOf: (index: number) => number): number => {
    const starts = chronological(bar, revealOf);
    let ready = 0;
    for (const item of bar.items) {
      let t = startOf(item.index) - lead;
      const last = t + REVEAL_MS + 40;
      while (t < last && ledgeBarWidth(t, starts, lead) - 4 * bar.f < item.right) t += 2;
      ready = Math.max(ready, t);
    }
    return ready;
  };
  /**
   * This cue's schedule when it must be gone by `endAt`. The sample's entrance pace is kept (`quick` false); `quick` quickens only the
   * words that need it, down to 80 ms. A word whose reveal cannot finish a frame before the cue goes, and every word of a cue entering
   * with a lead under 67 ms, is open at once (an entrance that cannot animate is a cut).
   */
  const schedule = (nextLead: number, endAt: number, own = false, quick = false) => {
    // On a frame; a cue bounded by its own end leaves on the last frame at or before it (the words' floor aside).
    const deadline = own && endAt >= wordFloor ? Math.max(frameAtOrBefore(endAt), wordFloor) : frameAtOrAfter(Math.max(endAt, wordFloor));
    const revealOf = (index: number) => {
      // A lead under 67 ms still animates when two painted frames fit before the word: the reveal then ends exactly at its onset.
      const early = Math.round(startOf(index) - lead);
      const ms = lead < minAnim ? (lead >= oneFrame && paintedFrames(early, Math.round(startOf(index))) >= 2 ? lead : 0) : quick ? clamp(deadline - HOLD - (startOf(index) - lead), 80, REVEAL_MS) : REVEAL_MS;
      // A reveal that would end after the cue is shortened to what is left (a frame before the cue goes) while that still grows over
      // two painted frames; only below that is the word open at once.
      const room = deadline - oneFrame - 1 - (startOf(index) - lead);
      return ms === 0 || room >= ms ? ms : room >= minAnim ? room : 0;
    };
    const dropMsOf = (bar: Bar) => (quick && lead >= minAnim ? clamp((deadline - HOLD - (firstOf(bar) - lead)) / 0.79, 160, HERO_DROP_MS) : HERO_DROP_MS);
    // The words are settled when their ink is open (and a key word's drop is over): that is where the 150 ms start.
    const barLand = (bar: Bar) => {
      const open = inkOpen(bar, revealOf);
      return bar.plan.hero && lead >= minAnim ? Math.max(open, firstOf(bar) - lead + 0.79 * dropMsOf(bar)) : open;
    };
    const barsLand = Math.max(...bars.map(barLand));
    // Continuous speech (the next cue starts as this one ends) must not blink: the exit then ends exactly at the next cue's first frame.
    const nominalExit = (continuous ? deadline : cue.endMs - CLEAR) - EXIT;
    const stickerLastWord = [...sticker.bar.items].sort((x, y) => startOf(y.index) - startOf(x.index))[0]!.index;
    const stickerAt0 = sticker.bar.plan.hero
      ? hostFirst + Math.min(STICKER_LEAD, 0.42 * dropMsOf(sticker.bar), Math.max(20, 0.35 * (deadline - hostFirst)))
      : lastOf(sticker.bar) + Math.min(120, 0.5 * Math.max(revealOf(stickerLastWord), 80), Math.max(10, 0.25 * (deadline - lastOf(sticker.bar))));
    const stickerMs0 = clamp((Math.min(nominalExit, deadline - minAnim) - STICKER_HOLD - stickerAt0) / 0.55, 120, STICKER_MS);
    // The words hold 150 ms once they are settled; the cube, which only decorates, is fitted into the time that is left.
    // And never before the last word has been spoken: the first exit frame that touches ink is at or after its end.
    const idealFrom = Math.max(nominalExit, barsLand + HOLD, lastWordEnd);
    return { nextLead, deadline, revealOf, dropMsOf, stickerAt0, stickerMs0, idealFrom };
  };
  /** Whether this cue is bounded by its own end rather than by a next cue's first frame. */
  const ownEnd = (nextLead: number) => !next || (!(continuous || nextFirst < cue.endMs) && frameAtOrAfter(Math.round(nextFirst - nextLead)) > cue.endMs);
  /** The words get their 150 ms: the exit may be as short as a cut, but it never starts before the hold is over. */
  const roomFor = (candidate: ReturnType<typeof schedule>) => candidate.idealFrom <= candidate.deadline;
  // The handoff, in cue handoff rule 3's order: (a) the exit is shortened to a cut, (b) the two lockups overlap where the next cue's
  // pieces are not over this cue's ink (it ends at the first frame they are), (c) the next entrance's lead shrinks toward 0, and (d) only
  // then are this cue's entrance effects quickened, word by word and as little as needed. The sample's entrance pace is kept before that.
  let plan = schedule(REVEAL_LEAD, endFor(REVEAL_LEAD), ownEnd(REVEAL_LEAD));
  if (next && !roomFor(plan)) {
    let settled = false;
    // Frames quantise the lead: a few ms less than 85 often moves the next cue's first painted frame past this cue's last word. Leads under
    // 67 ms leave the next cue no room to animate its reveal, so the entrance is quickened (word by word) before any of them is taken.
    const animatedLeads = [REVEAL_LEAD, 80, 78, 75, 72, 70, 67].filter((candidate) => candidate >= minAnim || candidate === REVEAL_LEAD);
    const tryLeads = (leads: readonly number[]) => {
      for (const tighter of leads) {
        const direct = schedule(tighter, endFor(tighter), ownEnd(tighter));
        if (roomFor(direct)) return direct;
        const meeting = firstMeeting(tighter);
        const overlapped = schedule(tighter, Number.isFinite(meeting) ? Math.max(meeting, endFor(tighter)) : direct.idealFrom + EXIT);
        if (roomFor(overlapped)) return overlapped;
      }
      return null;
    };
    const found =
      tryLeads(animatedLeads) ??
      animatedLeads.map((tighter) => schedule(tighter, endFor(tighter), ownEnd(tighter), true)).find(roomFor) ??
      tryLeads([60, 40, 20, 0]);
    if (found) {
      plan = found;
      settled = true;
    }
    if (!settled) {
      const meeting = firstMeeting(0);
      const end = Number.isFinite(meeting) ? Math.max(meeting, endFor(0)) : endFor(0);
      const quick = schedule(0, end, ownEnd(0) && !Number.isFinite(meeting), true);
      plan = quick;
    }
  }
  counters.lead = plan.nextLead;
  const { deadline, revealOf, dropMsOf, stickerAt0, idealFrom } = plan;
  const stickerMs0 = plan.stickerMs0;
  // An exit is an animation of at least 67 ms (two 30 fps frames) that ends before the cue must be gone, or a cut exactly there.
  const animated = paintedFrames(idealFrom, deadline) >= 2;
  const exitDur = animated ? Math.min(EXIT, deadline - idealFrom) : 0;
  const exitFrom = animated ? (continuous ? deadline - exitDur : idealFrom) : deadline;
  /** What is left of the safe height above the lockup once its exit drop is counted: the popcorn's flight may use no more. */
  const spanRoom = safe.y2 - safe.y1 - (turned(geo).h + dropPx);
  const exitTo = exitFrom + exitDur;
  // The cube's pop fits before the cue leaves: it starts at least 80 ms before the end (a pop of under 67 ms would be a one-frame flash).
  const stickerAt = Math.min(stickerAt0, Math.round(exitTo) - (minAnim + 13));
  const stickerMs = Math.min(stickerMs0, Math.max(60, exitTo - stickerAt - 10));
  const stickerLand = stickerAt + 0.55 * stickerMs;
  const exitY = (t: number) => (exitDur > 0 ? dropPx * EASES.in(prog(t, exitFrom, exitDur)) : 0);
  const fadeOut = (t: number) => (exitDur > 0 ? 1 - EASES.in(prog(t, exitFrom, exitDur)) : 1);
  const fade = (from: number): Frames => (exitDur === 0 ? [[from, 1]] : from < exitFrom ? [[from, 1], [exitFrom, 1], [exitTo, 0, "in"]] : [[from, 1], [exitTo, 0, "in"]]);
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

  const toMs = Math.round(exitTo);
  // The clip's open edges are unbounded: the cue's shift into the safe area moves a clip with its piece, and an edge at the canvas would
  // then cut away the row it was shifted past (a stacked cue's upper row). Only the reveal edge means anything.
  const OPEN = 100_000;
  const openClip = (x1: Frames, x2: Frames): Clip => ({ x1, x2, y1: [[0, -OPEN]], y2: [[0, OPEN]] });
  const wideOpen: Frames = [[0, -OPEN]];

  const barInfo: { bar: Bar; width: (t: number) => number; dropOf: (t: number) => number; from: number; edges: number[] }[] = [];
  bars.forEach((bar, barAt) => {
    const first = firstOf(bar);
    const from = Math.round(first - lead);
    // Text is never dropped to fit a window: the last word's own window is guaranteed two painted frames (see `wordFloor`).
    if (toMs <= from) return;
    const z = band + barAt * 14;
    // Timing is chronological, placement is by position: a word that sits further along the bar than a word spoken later still pulls the edge out to it.
    const starts = chronological(bar, revealOf);
    const width = (t: number) => ledgeBarWidth(t, starts, lead);
    // A key word's drop is a spring that needs ~0.8 of its length plus a moment to be read: a cue that cannot fit it (or that enters with a
    // lead under 67 ms) shows the settled pose instead of a motion that never settles.
    const dropMs = dropMsOf(bar);
    const dropFits = lead >= minAnim && exitFrom - (first - lead) >= 0.79 * dropMs + 70;
    const dropOf = bar.plan.hero && dropFits ? (t: number) => (1 - EASES.spring(prog(t, first - lead, dropMs))) * -HERO_DROP * bar.f : () => 0;
    const edges = [...bar.items.flatMap((item) => [startOf(item.index) - lead, startOf(item.index) - lead + revealOf(item.index)]), first - lead + dropMs];
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
    const clip = rtl ? openClip(edgeFrames, [[0, OPEN]]) : openClip(wideOpen, edgeFrames);
    const baselineY = bar.y + bar.baseline;
    for (const item of bar.items) {
      const start = startOf(item.index);
      const wordFrom = Math.round(start - lead);
      // The word's visual left end: the left edge of its box, or for a mirrored lockup the mirror of its right edge.
      const anchorX = bar.x + (rtl ? item.right : item.left);
      const track = position({ x: anchorX, y: baselineY }, wordFrom, toMs, moving, edges);
      pieces.push({
        id: `ledge:${cueNumber}:w${item.index}`,
        kind: "text",
        // Above the next cue's bars: if two cues must overlap (speakers do), the word is never the thing covered.
        z: band + 380 + barAt,
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
  // A cue too short for the pop shows the cube from two frames before it leaves, settled: a static accent rather than none.
  const stickerFrom = Math.max(host?.from ?? 0, Math.min(Math.round(stickerAt) + 10, toMs - (minAnim + 1)));
  const stickerAnchor = { x: sticker.cx, y: sticker.cy };
  // The pop is a spring (it lands in ~0.55 of its length): a cue that leaves before it can land shows the cube settled.
  const stickerLive = exitFrom - stickerAt >= 0.55 * stickerMs + 40;
  const stickerPop = (t: number) => (stickerLive ? EASES.spring(prog(t, stickerAt, stickerMs)) : 1);
  const stickerFall = (t: number) => (stickerLive ? -(1 - EASES.outExpo(prog(t, stickerAt, (stickerMs * 260) / 420))) * 60 * sticker.bar.f : 0);
  if (host && paintedFrames(stickerFrom, toMs) >= 2) {
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
    // Fitted before the exit: they start when the cube lands (earlier, and closer together, when the cue leaves soon) and last up to
    // 380 ms, never starting later than 20 ms before the exit begins.
    const tickBase = clamp(stickerLand, stickerAt, Math.max(stickerAt, exitFrom - 150));
    const stagger = clamp((exitFrom - 40 - tickBase) / 2, 6, 45);
    set.forEach((angle, j) => {
      const phi = angle + (rng() - 0.5) * 14;
      const t0 = Math.round(Math.max(stickerFrom, Math.min(tickBase + j * stagger, exitFrom - 20, toMs - (minAnim + 3))));
      const life = clamp(exitFrom + 60 - t0, 140, 380);
      const to = Math.min(toMs, t0 + life);
      if (paintedFrames(t0, to) < 2) return;
      const burst = to - t0 >= 160;
      const radius = (t: number) => reach0 + 12 * k * (burst ? EASES.out(prog(t, t0, 160)) : 1);
      const dir = { x: Math.cos(rad(phi)), y: Math.sin(rad(phi)) };
      const tickEdges = [t0 + 130, t0 + 160, t0 + life - 130];
      const pivot = { x: stickerAnchor.x + dir.x * reach0, y: stickerAnchor.y + dir.y * reach0 };
      const grow = sampled((t) => (burst ? lerp(0.2, 1, outBack125(prog(t, t0, 130))) : 1), t0, to, tickEdges, 0.002);
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
  const leadBar = barInfo[0];
  if (leadBar) {
    const { bar, width, dropOf, from, edges } = leadBar;
    const count = [3, 2, 3, 2][turn % 4]!;
    const fractions = count === 3 ? [0.18, 0.5, 0.82] : [0.3, 0.72];
    const strip = bar.dy - 1.5 * bar.out;
    const dh = 0.75 * strip;
    const slant = dh * (-bar.dx / bar.dy);
    const range = bar.full + bar.dx;
    // Red on the depth face it sits on; where the brand colours make that face too close to red, ink.
    const depthColour = bar.plan.hero ? input.colours.primary : input.colours.highlight;
    const dashColour = [STICKER_RED, INK, "#FFFFFF"].find((colour) => captionColourContrast(colour, depthColour) >= 3) ?? [STICKER_RED, INK, "#FFFFFF"].sort((a, b) => captionColourContrast(b, depthColour) - captionColourContrast(a, depthColour))[0]!;
    const order = ledgeShuffle(count, rng);
    order.forEach((slot, j) => {
      // A very short bar (one letter) gets one narrower dash rather than none.
      const dw = Math.min((24 + 12 * rng()) * bar.f, 0.4 * range);
      const margin = Math.min(18 * bar.f, 0.12 * range);
      const usable = range - 2 * margin - dw;
      if (usable < 0 || (j > 0 && usable < dw * 1.2 * j)) return;
      const cxLocal = margin + dw / 2 + clamp(fractions[slot]! + (rng() - 0.5) * 0.1, 0, 1) * usable;
      let appear = Number.NaN;
      for (let t = from; t < exitFrom; t += 5) {
        if (width(t) + bar.dx >= cxLocal + dw / 2 + 4 * bar.f) {
          appear = t;
          break;
        }
      }
      if (Number.isNaN(appear)) return;
      // Late or short: a dash that cannot fit its pop shows from two frames before the cue leaves (settled), and none if there is no room.
      const t0 = Math.max(from, Math.min(Math.round(appear + j * 25), toMs - (minAnim + 1)));
      const pivot = { x: bar.x + cxLocal, y: bar.y + bar.h + strip / 2 - 0.5 * bar.f };
      const dashEdges = [t0, t0 + 110, t0 + 500];
      const popped = sampled((t) => (toMs - t0 >= 130 ? lerp(0.15, 1, outBack125(prog(t, t0, 110))) : 1), t0, toMs, dashEdges, 0.002);
      const slide = (t: number) => (toMs - t0 >= 500 ? -8 * bar.f * (1 - EASES.out(prog(t, t0, 500))) : 0);
      if (paintedFrames(t0, toMs) < 2) return;
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
        }, band + 3, { fill: { colour: dashColour } }),
      );
    });

    // --- popcorn: two small flat cubes flip up and away from the first bar's top edge ---
    const swatches = [[input.colours.primary, input.colours.highlight], [input.colours.highlight, input.colours.primary], [STICKER_RED, input.colours.primary]] as const;
    const sideBase = rng() < 0.5 ? 1 : -1;
    for (let j = 0; j < 2; j++) {
      const latest = Math.max(from, Math.min(exitFrom - 40, toMs - (minAnim + 3)));
      const at = Math.round(clamp(lastOf(bar) + 40 + j * 110, from, latest));
      const dur = clamp(toMs - at, 240, 600);
      const to = Math.min(toMs, at + dur);
      if (paintedFrames(at, to) < 2) continue;
      const start = { x: bar.x + (0.45 + 0.4 * rng()) * bar.full * (j === 0 ? 0.85 : 1.1) + 0, y: bar.y - 4 * bar.f };
      start.x = clamp(start.x, bar.x + 0.2 * bar.full, bar.x + 0.92 * bar.full);
      const rise0 = (70 + 40 * rng()) * bar.f;
      let rise = rise0;
      let drift = (sideBase * (j === 0 ? 1 : -1)) * (18 + 26 * rng()) * bar.f;
      // Keep the flight inside the safe area: a lockup high in the frame gets a shorter rise.
      while (rise > 20 * bar.f && (P(start.x, start.y - rise).y < safe.y1 + 16 * bar.f || rise > spanRoom - 6 * bar.f)) rise *= 0.85;
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

  // The shift into the safe area, looked for every 4 ms: the exit's drop is a fast ease-in whose last frames `clampToSafeArea`'s 16 ms grid can miss.
  let union: Box | null = null;
  const from = Math.min(...pieces.map((piece) => piece.fromMs));
  const end = Math.max(...pieces.map((piece) => piece.toMs));
  // Every 4 ms, and every millisecond of the exit (a fast ease-in) and the last frame of each piece.
  const probes = new Set<number>();
  for (let ms = from; ms <= end; ms += 4) probes.add(ms);
  for (let ms = Math.floor(exitFrom); ms <= end; ms++) probes.add(ms);
  // The entrance's peak (a spring's overshoot, the reveal's) too, every millisecond of the first 450.
  for (let ms = from; ms <= from + 450; ms++) probes.add(ms);
  for (const piece of pieces) probes.add(piece.toMs - 1);
  for (const ms of probes) {
    const box = sceneBoundsAt(pieces, ms, input.measure);
    if (box) union = union ? { x1: Math.min(union.x1, box.x1), y1: Math.min(union.y1, box.y1), x2: Math.max(union.x2, box.x2), y2: Math.max(union.y2, box.y2) } : box;
  }
  if (!union) return pieces;
  const axis = (low: number, high: number, safeLow: number, safeHigh: number) => {
    if (high - low >= safeHigh - safeLow) return (safeLow + safeHigh) / 2 - (low + high) / 2;
    return low < safeLow ? safeLow - low : high > safeHigh ? safeHigh - high : 0;
  };
  const dx = axis(union.x1, union.x2, safe.x1, safe.x2);
  const dy = axis(union.y1, union.y2, safe.y1, safe.y2);
  counters.prev = { box: { x1: union.x1 + dx, y1: union.y1 + dy, x2: union.x2 + dx, y2: union.y2 + dy }, lastEnd: lastWordEnd };
  return dx === 0 && dy === 0 ? pieces : pieces.map((piece) => shiftPiece(piece, dx, dy));
}

export const ledgeProgram: SceneProgram = {
  build(input) {
    const counters: Counters = { lead: REVEAL_LEAD, cues: 0, heroes: 0, plain: 0, prev: null };
    return { pieces: input.cues.flatMap((cue, number) => (cue.words.length === 0 ? [] : buildCue(cue, number, input, counters))) };
  },
};

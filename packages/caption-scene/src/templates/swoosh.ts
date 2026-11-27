import { captionTextClusters } from "@narriflow/caption-fonts/caption-block";
import { CAPTION_SCENE_BRAND_MIN_CONTRAST, captionColourContrast, captionSceneMeta } from "@narriflow/validators";
import type { DemoScript } from "../demo";
import { clamp, EASES, type Frames, prog } from "../ease";
import { exportFrameAtOrBefore, paintedFrameCount } from "../frame-grid";
import { sampleFrames } from "../frames";
import { balancedRows, rowVisualOrder } from "../layout";
import { type Box, type ColourFrames, mixColour, type Piece, type TextPiece, type Track } from "../scene";
import { polygonPath } from "../shapes";
import { galleryScene } from "./gallery-layout";

/**
 * Swoosh (`samples/templates/m77-swoosh.js`, after Motion Array "Lyrics Animated Text"): lyric-poster captions in a white
 * brush script (Kaushan Script) with a dark edge, set as a staircase (each line stepped in from the one above), riding
 * slightly uphill. Ordinary words slide a short way into their slots as they are spoken. The key word is the signature: a
 * fat lime brush swoosh flies in from the lower right, the word swings out of its tip (sheared, squeezed and leaning) and
 * settles larger in yellow with a short coral offset shadow while the swoosh is eaten back into it.
 *
 * Changes from the sample, and why:
 * - **Rows from the words.** The sample's two lines (before the key word / the key word and after, or two halves) stay the
 *   rule, but each line wraps (balanced) when it is wider than the column, a word wider than the column shrinks to a floor
 *   and below it breaks into the fewest even rows (Latin, Cyrillic, Greek, CJK; a joined script such as Devanagari or
 *   Arabic never breaks, it shrinks), and every fragment sits on its own row. More than two rows keep stepping in, the
 *   whole indent capped at two steps and reduced when a row would leave the column. The sample's whole-block scale fit
 *   is gone (it shrank every word when one line was long).
 * - **Row pitch from measured ink.** The sample's fixed steps (0.5/0.42 em, 0.7/0.72 em for a key word first) collided on
 *   real phrasing and tall scripts. Each step is the largest painted overlap of any two words of neighbouring rows that
 *   share horizontal space (ink, dark edge and the key word's coral offset, measured on the turned corners so even their
 *   upright bounding boxes stay apart under the tilt), never tighter than the sample's step, so Devanagari matras and
 *   Nastaliq grow the row. Words beside a key word keep room for its coral offset and its 5% swing overshoot.
 * - **Once spoken, a word holds still.** An ordinary word slides in during its 90 ms lead and is settled at its spoken
 *   start (the sample kept sliding for 200 ms after it). With no lead (a cue that follows the last one at once) it slides
 *   for three frames after the onset, then holds. A word slides only as far as the space to its neighbour allows (the
 *   first word of a row the full 44 px), so it never starts inside the key word's coral edge (Sol's round 3 finding).
 * - **The key word's swing compresses.** The 380 ms swing is shortened so its travel is done before the next word slides
 *   in, and finishes before the cue leaves; its travel is cut to the room inside the band so the fly-in never forces the
 *   cue smaller, and runs on a faster ease than the shear, squeeze and lean, so the word is nearly home at its spoken start
 *   (the swing itself keeps the sample's timing). It is opaque from 10 ms before its spoken start (70 ms ramp), or at once
 *   when the cue has no lead.
 * - **Swoosh timing from speech.** It starts up to 200 ms before the key word but never before the cue's window (so never
 *   more than 100 ms before the cue's first word), flies in over at least two frames and is eaten back into the word over
 *   the 110 ms before the spoken start, while the word swings out of it (the sample ate it from 10 ms before to 100 ms
 *   after): the key word reads alone when it is spoken, and an emoji placed against it measures from the word, not from
 *   the brush (with the brush still there, the emoji layer took it for the word's plate and hung the emoji 1h below the
 *   settled caption). A short window compresses the whole beat, and below four painted frames it is a compact static
 *   pose. Its length and thickness come from the room inside the band (the sample's caption-zone fit), trying the other
 *   side when the preferred one has no room; it mirrors for right-to-left cues. The sample's blurred drop shadows under
 *   the two strokes are dropped (the coral echo already separates it, and a big blur costs on every frame it moves).
 * - **Exit.** The staircase slides 46 px back against the reading direction and fades over its last 130 ms, only when two
 *   painted frames fit after every word has read 150 ms; otherwise the next cue simply replaces it.
 * - **Brand colours.** Words take the preset's primary, the key word the highlight, its offset the accent, each kept at 3:1
 *   against the fixed dark edge (else the style's own). A brand highlight also colours the swoosh, so the brush and the
 *   word it throws match.
 * - **Every language.** Mixed case as spoken (no case transform). Right-to-left cues read right to left, the staircase
 *   steps in from the right, the uphill tilt, the swing, the swoosh and the exit mirror. Fallback faces are measured, so
 *   rows, pitch, the swoosh's anchor and the flick are sized from the real ink.
 *
 * Extra recurring beats, in the swoosh's own brush language:
 * - **Wet paint.** Every spoken word lands tinted with the swoosh lime and dries to its own colour over 160 ms.
 * - **Bristle spray** (every key-word cue). As the swoosh is eaten, two or three thin tapered brush hairs (lime and coral)
 *   flick out of the key word's trailing corner along the swoosh's line and vanish, behind the lettering; when that corner
 *   is crowded they fly from the leading corner, or from the top corners, wherever every hair has free space in the band.
 * - **Brush flick** (every cue without a key word). A short tapered lime stroke with its coral echo is drawn under the last
 *   word, or under the whole last row (alternating by cue), just after it is spoken, and holds until the cue leaves; it is
 *   lowered until its turned box clears the words.
 *
 * Words per cue: 4 (the scaffold's guess held on the real-cue sheets: two or three rows, no fit below 0.9). Emoji slot:
 * the default (above). A key-word cue whose short first line sits at the left usually takes it below, close to the
 * settled key word, or level with the last row's free start.
 */

export const SWOOSH_DEMO: DemoScript = {
  lines: [
    "nobody:b believed:b in:m me:m",
    "so:m I:m built:h@500 it:m myself:b",
    "dream:h@540 bigger:b",
    "never:b stop:b",
    "someday:b it:m will:b click:h@520",
    "you:m got:h@480 this:b",
  ],
  options: { rate: 195, gap: 30, cueGap: 520, tail: 270, lead: 300 },
};

const FACE = "Kaushan Script";
/** Words around a key word, words of a cue with none, the key word (sample px). */
const BODY = 100;
const SOLO = 118;
const HERO = 172;
/** Smallest size a word over the column shrinks to before it breaks across rows. */
const FLOOR = 64;
const HERO_FLOOR = 96;
const COLUMN = 900;
const PAD = 30;
const INDENT = 64;
/** Degrees: the staircase rides slightly uphill in the reading direction. */
const TILT = -2.2;

const EDGE = "#15110E";
const LIME = "#C8F02A";
/** Visible dark edge outside the glyph, em (the sample's centred CSS stroke of 0.12 / 0.1 em). */
const BODY_EDGE = 0.06;
const HERO_EDGE = 0.05;
/** The key word's coral offset, em. */
const OFFSET = 0.07;

const LEAD = 100;
const ENTER_LEAD = 90;
const SLIDE = 44;
const RISE = 10;
const TINT = 0.6;
const TINT_MS = 160;
const HERO_LEAD = 80;
const SWING_MS = 380;
const TRAVEL = 300;
const SWOOSH_LEAD = 200;
const EAT_MS = 110;
const SPRAY_MS = 200;
const FLICK_MS = 140;
const EXIT_MS = 130;
const EXIT_SLIDE = 46;

/** Words that can break between clusters when wider than the column. Joined and complex scripts never do. */
const SPLITTABLE = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{N}\p{P}\p{S}]+$/u;

type Key = [number, number, ("out" | "outExpo" | "outQuint" | "in" | "inOut")?];

/** The sample's `ease.outBack(p, 1.25)`. */
const outBack = (p: number) => 1 + 2.25 * (p - 1) ** 3 + 1.25 * (p - 1) ** 2;

/** A deterministic 0..1 from a cue index and text. */
function hash(seed: number, text: string): number {
  let h = (2166136261 ^ seed) >>> 0;
  for (const ch of text) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/**
 * A brush stroke lying along +x (the sample's `brushPts`): a needle point at x = 0, swelling to its fattest about two thirds
 * along, then thinning to a flicked tail; the centre line bows and the edges are a little ragged. `from`/`to` cut a shorter
 * piece of the same shape, `lift` moves it sideways so a bristle split rides beside the main body. Lengths are canvas px;
 * `u` scales the sample's fixed wobble.
 */
function brushPoints(L: number, hw: number, u: number, o: { from?: number; to?: number; lift?: number; thin?: number; bow?: number; flick?: number; seed?: number; dx?: number; dy?: number; mirror?: boolean } = {}): [number, number][] {
  const { from = 0, to = 1, lift = 0, thin = 1, bow = 30, flick = 18, seed = 0, dx = 0, dy = 0, mirror = false } = o;
  const n = 32;
  const top: [number, number][] = [];
  const bot: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const v = i / n;
    const p = from + (to - from) * v;
    const swell = Math.min(1, p / 0.62) ** 0.7 * (p < 0.62 ? 1 : 1 - 0.8 * ((p - 0.62) / 0.38) ** 1.4);
    const half = Math.max(0.5 * u, hw * thin * swell * (from > 0 ? Math.sin(v * Math.PI) ** 0.6 : 1));
    const yc = -bow * u * Math.sin(p * Math.PI * 0.9) - flick * u * p ** 4 + lift * (0.65 + 0.7 * p);
    const rag = (Math.sin(p * 47 + seed) * 2.4 * p + Math.sin(p * 19 + 1 + seed) * 3 * p) * u;
    top.push([p * L, yc - half + rag]);
    bot.push([p * L, yc + half - rag * 0.7 + 3 * u * p]);
  }
  const s = mirror ? -1 : 1;
  return [...top, ...bot.reverse()].map(([x, y]) => [s * (x + dx), y + dy]);
}

/** A thin brush hair along +x, tapered at both ends. */
function hairPoints(len: number, hw: number): [number, number][] {
  const n = 10;
  const top: [number, number][] = [];
  const bot: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const v = i / n;
    const half = Math.max(0.3, hw * Math.sin(Math.PI * v) ** 0.7 * (1 - 0.35 * v));
    top.push([v * len, -half]);
    bot.push([v * len, half]);
  }
  return [...top, ...bot.reverse()];
}

const rotate = (x: number, y: number, degrees: number): [number, number] => {
  const a = (degrees * Math.PI) / 180;
  return [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
};

const aabb = (cx: number, cy: number, w: number, h: number, degrees: number): Box => {
  const a = (degrees * Math.PI) / 180;
  const hw = (Math.abs(Math.cos(a)) * w + Math.abs(Math.sin(a)) * h) / 2;
  const hh = (Math.abs(Math.sin(a)) * w + Math.abs(Math.cos(a)) * h) / 2;
  return { x1: cx - hw, y1: cy - hh, x2: cx + hw, y2: cy + hh };
};

const meets = (a: Box, b: Box) => a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;

interface Item {
  readonly word: number;
  readonly part: number;
  readonly parts: number;
  readonly text: string;
  readonly size: number;
  readonly hero: boolean;
  readonly width: number;
  readonly inkTop: number;
  readonly inkBottom: number;
  readonly edge: number;
  /** How far the coral offset reaches past the ink, right and down (0 for ordinary words). */
  readonly offset: number;
}

interface Placed extends Item {
  readonly row: number;
  /** Flat layout: advance centre and baseline, before the tilt. */
  x: number;
  baseline: number;
}

export const swooshProgram = galleryScene("swoosh", 1290, (ctx) => {
  const { cue, index, to, bounds, spokenEnd } = ctx.window;
  const windowFrom = ctx.window.from;
  const { fps, space, rtl, side } = ctx;
  const u = space.u;
  const { words } = cue;
  const measure = (text: string, size: number) => ctx.input.measure(text, FACE, size, 0);

  // Colours as received, each kept at 3:1 against the fixed dark edge it sits in (the Studio's colour controls can send any).
  const c = ctx.input.colours;
  const defaults = captionSceneMeta("swoosh").colours;
  const keep = (colour: string, fallback: string) => (captionColourContrast(colour, EDGE) >= CAPTION_SCENE_BRAND_MIN_CONTRAST ? colour : fallback);
  const faceColour = keep(c.primary, defaults.primary);
  const heroColour = keep(c.highlight, defaults.highlight);
  const brush = heroColour.toUpperCase() === defaults.highlight.toUpperCase() ? LIME : heroColour;
  const coral = captionColourContrast(c.accent, heroColour) >= 1.4 ? c.accent : defaults.accent;
  const tintOf = (colour: string) => mixColour(colour, brush, TINT);

  // Counters over the clip: hero cues and cues without one cycle their variants independently.
  const heroed = (k: number) => ctx.input.cues[k]!.words.some((word) => word.role === "hero");
  let heroCount = 0;
  let plainCount = 0;
  for (let k = 0; k < ctx.input.cues.length && ctx.input.cues[k]!.index < cue.index; k++) {
    if (heroed(k)) heroCount++;
    else plainCount++;
  }
  const hasHero = words.some((word) => word.role === "hero");

  // ---- Sizes: the sample's; a word wider than the column shrinks to a floor, then breaks into the fewest even rows. ----
  const column = Math.min(COLUMN * u, bounds.x2 - bounds.x1 - 2 * PAD * u);
  const w100 = (text: string) => measure(text, 100).advance;
  const chunks = (text: string, size: number): string[] => {
    const clusters = captionTextClusters(text);
    const split = (room: number) => {
      const out: string[] = [];
      let row = "";
      for (const cluster of clusters) {
        if (row && w100(row + cluster) > room) {
          out.push(row);
          row = "";
        }
        row += cluster;
      }
      if (row) out.push(row);
      return out;
    };
    const room = (column * 0.97 * 100) / size;
    const rows = split(room).length;
    let lo = 0;
    let hi = room;
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      if (split(mid).length <= rows) hi = mid;
      else lo = mid;
    }
    return split(hi);
  };
  const itemOf = (word: number, part: number, parts: number, text: string, size: number, hero: boolean): Item => {
    const m = measure(text, size);
    return { word, part, parts, text, size, hero, width: m.advance, inkTop: m.inkTop, inkBottom: m.inkBottom, edge: (hero ? HERO_EDGE : BODY_EDGE) * size, offset: hero ? OFFSET * size : 0 };
  };
  const itemsOfWord = words.map((word, w) => {
    const hero = word.role === "hero";
    const base = (hero ? HERO : hasHero ? BODY : SOLO) * u;
    const floor = Math.min(base, (hero ? HERO_FLOOR : FLOOR) * u);
    const natural = measure(word.text, base).advance;
    if (natural <= column) return [itemOf(w, 0, 1, word.text, base, hero)];
    const fitted = (base * column) / natural;
    if (fitted >= floor || !SPLITTABLE.test(word.text) || captionTextClusters(word.text).length < 2) return [itemOf(w, 0, 1, word.text, fitted, hero)];
    const parts = chunks(word.text, floor);
    const size = clamp((column * 0.97 * 100) / Math.max(...parts.map(w100)), floor, base);
    return parts.map((text, part) => itemOf(w, part, parts.length, text, size, hero));
  });

  // ---- Lines: the words before the key word, then the key word and what follows (a key word first sits alone on top); a
  // cue without one splits in halves. Each line wraps when wide; every fragment of a broken word is its own row. ----
  const starts = new Set<number>([0]);
  const heroes = words.flatMap((word, w) => (word.role === "hero" ? [w] : []));
  if (!heroes.length) {
    if (words.length >= 2) starts.add(Math.ceil(words.length / 2));
  } else {
    for (const h of heroes) starts.add(h);
    if (heroes[0] === 0 && words.length > 1) starts.add(1);
  }
  const lineGroups: number[][] = [];
  for (const [w] of words.entries()) {
    if (starts.has(w) || !lineGroups.length) lineGroups.push([]);
    lineGroups.at(-1)!.push(w);
  }
  // A key word's coral offset reaches right; its swing overshoots about 5% of its size either way.
  const swell = (item: Item) => (item.hero ? 0.05 * item.size : 0);
  const gapBetween = (left: Item, right: Item) => 0.13 * (left.size + right.size) + left.offset + swell(left) + swell(right);
  const rowsOfItems: Item[][] = [];
  for (const line of lineGroups) {
    let run: Item[] = [];
    const flush = () => {
      if (!run.length) return;
      const gap = 0.26 * Math.min(...run.map((item) => item.size));
      for (const row of balancedRows(run.map((item) => item.width + item.offset), gap, column - INDENT * u)) rowsOfItems.push(row.map((at) => run[at]!));
      run = [];
    };
    for (const w of line) {
      const items = itemsOfWord[w]!;
      if (items.length > 1) {
        flush();
        for (const item of items) rowsOfItems.push([item]);
      } else run.push(items[0]!);
    }
    flush();
  }

  // ---- The staircase: each row stepped in from the one above (from the right in RTL), the indent capped and kept inside
  // the column; the rows' pitch from the painted ink of words that share horizontal space. ----
  const ordered = rowsOfItems.map((row) => rowVisualOrder(row.map((item) => item.text), rtl ? "rtl" : "ltr").map((at) => row[at]!));
  const rowWidthOf = (row: readonly Item[]) => row.reduce((sum, item, at) => sum + item.width + (at > 0 ? gapBetween(row[at - 1]!, item) : 0), 0);
  const widths = ordered.map(rowWidthOf);
  const R = ordered.length;
  let step = R <= 2 ? INDENT * u : (2 * INDENT * u) / (R - 1);
  for (let r = 1; r < R; r++) step = Math.min(step, Math.max(0, (column - widths[r]!) / r));
  const span = Math.max(...widths.map((w, r) => w + r * step));
  const cx = span <= bounds.x2 - bounds.x1 - 2 * PAD * u ? clamp(space.x(540), bounds.x1 + PAD * u + span / 2, bounds.x2 - PAD * u - span / 2) : (bounds.x1 + bounds.x2) / 2;
  const x0 = cx - span / 2;
  const placed: Placed[] = [];
  ordered.forEach((row, r) => {
    let x = rtl ? x0 + span - r * step - widths[r]! : x0 + r * step;
    row.forEach((item, at) => {
      if (at > 0) x += gapBetween(row[at - 1]!, item);
      placed.push({ ...item, row: r, x: x + item.width / 2, baseline: 0 });
      x += item.width;
    });
  });
  const inRow = (r: number) => placed.filter((item) => item.row === r);
  const tilt = TILT * side;
  const reachDown = (item: Item) => item.inkBottom + item.edge + item.offset;
  const reachUp = (item: Item) => -item.inkTop + item.edge;
  for (let r = 1; r < R; r++) {
    const above = inRow(r - 1);
    const here = inRow(r);
    const sizeAbove = Math.max(...above.map((item) => item.size));
    const sizeHere = Math.max(...here.map((item) => item.size));
    let pitch = 0.5 * sizeAbove + 0.42 * sizeHere;
    for (const a of above) {
      for (const b of here) {
        const ax1 = a.x - a.width / 2 - a.edge;
        const ax2 = a.x + a.width / 2 + a.edge + a.offset;
        const bx1 = b.x - b.width / 2 - b.edge;
        const bx2 = b.x + b.width / 2 + b.edge + b.offset;
        if (!(ax1 < bx2 + 8 * u && bx1 < ax2 + 8 * u)) continue;
        // The tilt turns the block rigidly, so turned words never meet; the pitch keeps even their upright bounding boxes
        // (what the emoji layer and the bounds checks see) apart: the turned corners of both boxes, the lower row moved down.
        const sin = Math.sin((tilt * Math.PI) / 180);
        const cos = Math.cos((tilt * Math.PI) / 180);
        const turnedY = (x: number, y: number) => x * sin + y * cos;
        const lowestA = Math.max(...[ax1, ax2].flatMap((x) => [turnedY(x, -reachUp(a)), turnedY(x, reachDown(a))]));
        const highestB = Math.min(...[bx1, bx2].flatMap((x) => [turnedY(x, -reachUp(b)), turnedY(x, reachDown(b))]));
        pitch = Math.max(pitch, (lowestA - highestB + 0.05 * Math.min(a.size, b.size)) / cos);
      }
    }
    const baseline = above[0]!.baseline + pitch;
    for (const item of here) item.baseline = baseline;
  }
  const top = Math.min(...placed.map((item) => item.baseline - reachUp(item)));
  const bottom = Math.max(...placed.map((item) => item.baseline + reachDown(item)));
  const targetY = space.y(1290);
  let shiftY = targetY - (top + bottom) / 2;
  if (bottom - top <= bounds.y2 - bounds.y1 - 2 * PAD * u) shiftY = clamp(shiftY, bounds.y1 + PAD * u - top, bounds.y2 - PAD * u - bottom);
  for (const item of placed) item.baseline += shiftY;
  const bcx = cx;
  const bcy = (top + bottom) / 2 + shiftY;
  const tilted = (x: number, y: number): [number, number] => {
    const [dx, dy] = rotate(x - bcx, y - bcy, tilt);
    return [bcx + dx, bcy + dy];
  };
  const pivotOf = (item: Placed) => tilted(item.x, item.baseline + (item.inkTop + item.inkBottom) / 2);
  const boxOf = (item: Placed): Box => {
    const [px, py] = pivotOf(item);
    return aabb(px + item.offset / 2, py + item.offset / 2, item.width + 2 * item.edge + item.offset, item.inkBottom - item.inkTop + 2 * item.edge + item.offset, tilt);
  };

  // ---- Timing ----
  const exitFrom = Math.max(spokenEnd + 150, to - EXIT_MS);
  const exitOn = exitFrom < to && paintedFrameCount(exitFrom, to, fps) >= 2;
  const limit = exitOn ? exitFrom : to;
  const withExit = (track: Track, x: number, from: number): Track => {
    if (!exitOn) return track;
    const before = (frames: Frames | undefined, rest: number): Key[] => (frames ? (frames.filter((frame) => frame[0] < exitFrom) as Key[]) : [[from, rest]]);
    return {
      ...track,
      x: [...before(track.x, x), [exitFrom, x], [to, x - side * EXIT_SLIDE * u, "in"]],
      o: [...before(track.o, 1), [exitFrom, 1], [to, 0, "in"]],
    };
  };

  const pieces: Piece[] = [];
  const firstHero = placed.filter((item) => item.hero && item.part === 0).sort((a, b) => a.word - b.word)[0] ?? null;
  const textPiece = (item: Placed, id: string, z: number, from: number, fill: string, track: Track, extra: Partial<TextPiece> = {}): TextPiece => ({
    id, kind: "text", z, fromMs: from, toMs: to, text: item.text, face: FACE, sizePx: item.size, letterSpacingEm: 0, fill,
    stroke: { widthPx: item.edge, colour: EDGE }, anchor: "baseline-center", language: cue.language,
    origin: { dx: 0, dy: (item.inkTop + item.inkBottom) / 2 }, track, ...extra,
  });
  const idOf = (item: Placed) => (item.parts > 1 ? `${ctx.id}:w${item.word}l${item.part}` : `${ctx.id}:w${item.word}`);

  // Swoosh direction for the first key word: down toward the reading end, jittered per cue, mirrored in RTL.
  let swooshDir = side;
  let theta = 20 + 12 * hash(index, cue.words.map((word) => word.text).join(" "));
  let swooshL = 0;
  let swooshHw = 0;
  if (firstHero) {
    const [hx, hy] = pivotOf(firstHero);
    const box = { x1: bounds.x1 + 12 * u, y1: bounds.y1 + 12 * u, x2: bounds.x2 - 12 * u, y2: bounds.y2 - 12 * u };
    const fits = (L: number, hw: number, angle: number, dir: number) => {
      for (const path of swooshPaths(L, hw, u, index, dir < 0)) {
        for (const [px, py] of path.points) {
          const [rx, ry] = rotate(px, py, dir * angle);
          const X = hx + rx;
          const Y = hy + ry;
          if (X < box.x1 || X > box.x2 || Y < box.y1 || Y > box.y2) return false;
        }
      }
      return true;
    };
    search: for (const dir of [side, -side]) {
      for (const angle of [theta, 14, 30]) {
        for (let L = 440 * u; L >= 160 * u; L -= 10 * u) {
          const hw = clamp(L * 0.1, 22 * u, 44 * u);
          if (fits(L, hw, angle, dir)) {
            swooshDir = dir;
            theta = angle;
            swooshL = L;
            swooshHw = hw;
            break search;
          }
        }
      }
    }
    if (!swooshL) {
      swooshL = 160 * u;
      swooshHw = 22 * u;
    }
  }

  for (const item of placed) {
    const word = words[item.word]!;
    const s = word.startMs;
    const [px, py] = pivotOf(item);
    const id = idOf(item);
    const shadow = { dx: 0, dy: (item.hero ? 0.06 : 0.045) * item.size, blur: (item.hero ? 0.07 : 0.06) * item.size, colour: "#000000", alpha: item.hero ? 0.45 : 0.5 };

    if (!item.hero) {
      const from = Math.max(windowFrom, s - ENTER_LEAD);
      const lastFrame = exportFrameAtOrBefore(word.endMs - 1, fps);
      const settle = Math.max(from, Math.min(Math.max(s, from + 67), Math.max(from, lastFrame)));
      const motion = paintedFrameCount(from, settle, fps) >= 2;
      // The slide never starts inside the neighbour it moves toward (its ink, edge and any coral offset).
      const row = ordered[item.row]!;
      const at = row.findIndex((other) => other.word === item.word && other.part === item.part);
      const toward = rtl ? row[at + 1] : row[at - 1];
      const lean = toward ? 0.5 * (toward.inkBottom - toward.inkTop + item.inkBottom - item.inkTop) * Math.sin((Math.abs(TILT) * Math.PI) / 180) : 0;
      const clearance = toward ? gapBetween(rtl ? item : toward, rtl ? toward : item) - toward.edge - (rtl ? 0 : toward.offset) - swell(toward) - item.edge - lean - 4 * u : SLIDE * u;
      const slide = clamp(clearance, 6 * u, SLIDE * u);
      const o: Key[] = s - from >= 34 ? [[from, 0], [Math.min(from + 45, s), 1]] : [[from, 0.55], [from + 30, 1]];
      const track: Track = {
        x: motion ? [[from, px - side * slide], [settle, px, "outExpo"]] : [[from, px]],
        y: motion ? [[from, py + RISE * u], [settle, py, "outExpo"]] : [[from, py]],
        rz: [[from, tilt]],
        o,
        colour: [[from, tintOf(faceColour)], [settle + TINT_MS, faceColour, "out"]],
      };
      pieces.push(textPiece(item, id, 6, from, faceColour, withExit(track, px, from), { shadows: [shadow] }));
      continue;
    }

    // The key word swings out of the swoosh: sheared, squeezed and leaning, travelling in along the swoosh's line.
    const heroFrom = Math.max(windowFrom, s - HERO_LEAD);
    const swingStart = heroFrom - 30;
    const next = words[item.word + 1];
    let swingEnd = swingStart + SWING_MS;
    if (next && item.part === item.parts - 1) {
      const nextFrom = Math.max(windowFrom, next.startMs - ENTER_LEAD);
      swingEnd = Math.min(swingEnd, swingStart + Math.max(160, (nextFrom - swingStart) / 0.8));
    }
    swingEnd = Math.min(swingEnd, limit);
    const swing = paintedFrameCount(heroFrom, swingEnd, fps) >= 2;
    const dir = firstHero ? swooshDir : side;
    // The swoosh's axis: down and toward the reading end (mirrored, its drawing runs along -x turned by -theta).
    const ux = dir * Math.cos((theta * Math.PI) / 180);
    const uy = Math.sin((theta * Math.PI) / 180);
    // Travel only as far as the band allows: at its first painted pose the word is still about 78% of the way out.
    const box = boxOf(item);
    const roomX = ux > 0 ? (bounds.x2 - 6 * u - box.x2) / ux : (bounds.x1 + 6 * u - box.x1) / ux;
    const roomY = (bounds.y2 - 6 * u - box.y2) / uy;
    const travel = Math.max(0, Math.min(TRAVEL * u, roomX / 0.78, roomY / 0.78));
    const sw = Math.max(1, swingEnd - swingStart);
    const q = (t: number) => prog(t, swingStart, sw);
    const e = (t: number) => EASES.out(q(t));
    // The travel runs on a faster ease than the swing: the word is nearly home by its spoken start (an emoji placed against
    // it then sits where the word settles), while the shear, squeeze and lean keep the sample's timing.
    const home = (t: number) => EASES.outQuint(q(t));
    const bk = (t: number) => outBack(q(t));
    const edges = [heroFrom, swingEnd];
    const frames = (fn: (t: number) => number, tolerance: number): Frames => (swing ? sampleFrames(fn, edges, tolerance, { simplify: true }) : [[heroFrom, fn(swingEnd)]]);
    const o: Key[] = s - heroFrom >= 34 ? [[heroFrom, 0], [Math.min(heroFrom + 70, s), 1]] : [[heroFrom, 0.55], [heroFrom + 30, 1]];
    const track: Track = {
      x: frames((t) => px + ux * travel * (1 - home(t)), 0.5),
      y: frames((t) => py + uy * travel * (1 - home(t)), 0.5),
      rz: frames((t) => tilt - dir * 16 * (1 - bk(t)), 0.3),
      skx: frames((t) => -dir * 44 * (1 - bk(t)), 0.4),
      sx: frames((t) => 0.3 + 0.7 * bk(t), 0.006),
      sy: frames((t) => 0.88 + 0.12 * e(t), 0.004),
      o,
    };
    const tintAt = (t: number) => mixColour(brush, heroColour, EASES.out(prog(t, s - 40, 240)));
    const colour: ColourFrames = [[heroFrom, tintAt(heroFrom)], [Math.max(heroFrom + 1, s + 200), heroColour, "out"]];
    const finished = withExit(track, px, heroFrom);
    const d = item.offset;
    pieces.push(
      textPiece(item, `${id}o`, 5, heroFrom, coral, finished, { stroke: { widthPx: item.edge, colour: coral }, origin: { dx: -d, dy: (item.inkTop + item.inkBottom) / 2 - d } }),
      textPiece(item, id, 6, heroFrom, heroColour, { ...finished, colour }, { shadows: [shadow] }),
    );

    if (item !== firstHero) continue;

    // ---- The swoosh: lime brush and bristle split with their coral echoes, behind the lettering. ----
    const A = Math.max(windowFrom, s - SWOOSH_LEAD);
    // Flies in, then is eaten back into the word as it swings out, gone by the spoken start (the word reads alone then, and
    // an emoji placed against the word does not measure from the brush).
    let F = Math.max(A + 67, Math.min(heroFrom, s - EAT_MS));
    let E0 = Math.max(F, s - EAT_MS);
    let E1 = Math.max(E0 + 67, s - 5);
    let still = false;
    if (E1 > limit) {
      const avail = limit - A;
      if (paintedFrameCount(A, limit, fps) >= 4) {
        const k = avail / (E1 - A);
        F = A + (F - A) * k;
        E0 = A + (E0 - A) * k;
        E1 = limit;
      } else {
        still = true;
        E1 = limit;
      }
    }
    const fly = (t: number) => EASES.outQuint(prog(t, A, F - A));
    // Linear: at 30 fps the eat has three or four painted frames, and an in-out curve put most of it between two.
    const eat = (t: number) => prog(t, E0, E1 - E0);
    const [hx, hy] = [px, py];
    const slideAt = (t: number) => swooshL * 0.25 * (1 - fly(t));
    const sEdges = [A, F, E0, E0 + 0.64 * (E1 - E0), E1];
    const st = (fn: (t: number) => number, tolerance: number): Frames => (still ? [[A, fn(F)]] : sampleFrames(fn, sEdges, tolerance, { simplify: true }));
    const swooshTrack: Track = {
      x: still ? [[A, hx]] : st((t) => hx + ux * slideAt(t), 0.5),
      y: still ? [[A, hy]] : st((t) => hy + uy * slideAt(t), 0.5),
      rz: [[A, dir * theta]],
      sx: still ? [[A, 0.8]] : st((t) => Math.max(0.001, (0.4 + 0.6 * fly(t)) * (1 - eat(t))), 0.004),
      sy: still ? [[A, 0.8]] : st((t) => Math.max(0.02, (0.45 + 0.55 * fly(t)) * (1 - eat(t)) ** 0.9), 0.004),
      o: still ? [[A, 1]] : st((t) => Math.min(1, prog(t, A, F - A) * 1.6) * (1 - EASES.in(prog(t, E0 + 0.64 * (E1 - E0), 0.36 * (E1 - E0)))), 0.01),
    };
    const paths = swooshPaths(swooshL, swooshHw, u, index, dir < 0);
    for (const path of paths) {
      pieces.push({
        id: `${ctx.id}:sw${item.word}${path.suffix}`, kind: "shape", z: path.coral ? 2 : 3, fromMs: A, toMs: E1,
        path: polygonPath(path.points), fill: { colour: path.coral ? coral : brush }, track: swooshTrack,
      });
    }

    // ---- Bristle spray: thin brush hairs flick out of the key word's trailing corner along the swoosh's line. ----
    const B0 = Math.max(E0 + 0.35 * (E1 - E0), heroFrom + 67, windowFrom);
    const B1 = Math.min(B0 + SPRAY_MS, limit);
    const frames2 = paintedFrameCount(B0, B1, fps);
    if (frames2 >= 2) {
      const others = placed.filter((other) => other.word !== item.word).map((other) => {
        const b = boxOf(other);
        return { x1: b.x1 - 6 * u, y1: b.y1 - 6 * u, x2: b.x2 + 6 * u, y2: b.y2 + 6 * u };
      });
      const hb = boxOf(item);
      const count = 2 + (heroCount % 2);
      const spreads = [-16, 2, 18];
      // Corners tried in order: trailing bottom (along the swoosh), leading bottom, trailing top, leading top; the first where
      // every hair has free space inside the band, else the one with the most.
      const plan = (corner: number) => {
        const trailing = corner % 2 === 0 ? dir : -dir;
        const up = corner >= 2 ? -1 : 1;
        const cornerX = trailing > 0 ? hb.x2 - 0.1 * (hb.x2 - hb.x1) : hb.x1 + 0.1 * (hb.x2 - hb.x1);
        const cornerY = up > 0 ? hb.y2 - 0.3 * (hb.y2 - hb.y1) : hb.y1 + 0.3 * (hb.y2 - hb.y1);
        const hairs = [];
        for (let j = 0; j < count; j++) {
          const jitter = (hash(index * 7 + j, word.text) - 0.5) * 8;
          const a = theta + spreads[j]! + jitter;
          const dx = trailing * Math.cos((a * Math.PI) / 180);
          const dy = up * Math.sin((a * Math.PI) / 180);
          const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
          const len = (30 + 14 * hash(index + 31 * j, word.text)) * u;
          const travel2 = (30 + 14 * hash(index + 13 * j, word.text)) * u;
          const sx0 = cornerX + dx * 10 * u;
          const sy0 = cornerY + dy * 10 * u;
          const ex = sx0 + dx * travel2;
          const ey = sy0 + dy * travel2;
          const swept = { x1: Math.min(sx0, ex + dx * len) - 4 * u, y1: Math.min(sy0, ey + dy * len) - 4 * u, x2: Math.max(sx0, ex + dx * len) + 4 * u, y2: Math.max(sy0, ey + dy * len) + 4 * u };
          if (others.some((other) => meets(swept, other))) continue;
          if (swept.x1 < bounds.x1 + 4 * u || swept.x2 > bounds.x2 - 4 * u || swept.y1 < bounds.y1 + 4 * u || swept.y2 > bounds.y2 - 4 * u) continue;
          hairs.push({ j, angle, len, sx0, sy0, ex, ey });
        }
        return hairs;
      };
      const plans = [0, 1, 2, 3].map(plan);
      const hairs = plans.find((hairsOf) => hairsOf.length === count) ?? plans.reduce((best, next) => (next.length > best.length ? next : best));
      for (const { j, angle, len, sx0, sy0, ex, ey } of hairs) {
        const moving = frames2 >= 3;
        pieces.push({
          id: `${ctx.id}:sp${item.word}-${j}`, kind: "shape", z: 4, fromMs: B0, toMs: B1,
          path: polygonPath(hairPoints(len, 4.6 * u)), fill: { colour: j % 2 ? coral : brush },
          track: {
            x: moving ? [[B0, sx0], [B1, ex, "out"]] : [[B0, (sx0 + ex) / 2]],
            y: moving ? [[B0, sy0], [B1, ey, "out"]] : [[B0, (sy0 + ey) / 2]],
            rz: [[B0, angle]],
            sx: moving ? [[B0, 1], [B1, 0.25, "in"]] : [[B0, 0.7]],
            o: moving ? [[B0, 1], [B0 + 0.55 * (B1 - B0), 1], [B1, 0, "in"]] : [[B0, 1]],
          },
        });
      }
    }
  }

  // ---- Brush flick: a cue without a key word gets a short tapered stroke under its last word or its last row. ----
  if (!hasHero) {
    const last = words.length - 1;
    const lastItems = placed.filter((item) => item.word === last);
    const lastRow = lastItems.at(-1)!.row;
    const under = plainCount % 2 === 0 ? lastItems.filter((item) => item.row === lastRow) : inRow(lastRow);
    const x1 = Math.min(...under.map((item) => item.x - item.width / 2));
    const x2 = Math.max(...under.map((item) => item.x + item.width / 2));
    const baseline = under[0]!.baseline;
    const below = Math.max(...under.map((item) => item.inkBottom + item.edge));
    const size = Math.max(...under.map((item) => item.size));
    const W = x2 - x1;
    const L = clamp(0.84 * W, 60 * u, 420 * u);
    const hw = clamp(0.065 * size, 6 * u, 10 * u);
    const startX = rtl ? x2 - 0.06 * W : x1 + 0.06 * W;
    const angle = tilt + (hash(index, words[last]!.text) - 0.6) * 4 * side;
    const opts = { bow: 4, flick: 7, seed: index };
    const outline = [...brushPoints(L, hw, u, { ...opts, mirror: rtl }), ...brushPoints(L, hw, u, { ...opts, dx: 3 * u, dy: 5 * u, mirror: rtl })];
    const wordBoxes = placed.map(boxOf);
    // Under the words with a little air, lowered until its turned box clears every word's box.
    let drop = below + 6 * u + hw;
    let [fx, fy] = tilted(startX, baseline + drop);
    for (let tries = 0; tries < 30; tries++) {
      const turned = outline.map(([x, y]) => rotate(x, y, angle));
      const box = { x1: fx + Math.min(...turned.map((p) => p[0])), y1: fy + Math.min(...turned.map((p) => p[1])), x2: fx + Math.max(...turned.map((p) => p[0])), y2: fy + Math.max(...turned.map((p) => p[1])) };
      if (!wordBoxes.some((other) => meets(box, { ...other, y2: other.y2 + 2 * u }))) break;
      drop += 2 * u;
      [fx, fy] = tilted(startX, baseline + drop);
    }
    const ft0 = Math.max(windowFrom, words[last]!.startMs + 40);
    const room = limit - ft0;
    if (paintedFrameCount(ft0, limit, fps) >= 2) {
      const draw = Math.min(FLICK_MS, room * 0.6);
      const moving = paintedFrameCount(ft0, ft0 + draw, fps) >= 2;
      const flickTrack: Track = {
        x: [[ft0, fx]],
        y: [[ft0, fy]],
        rz: [[ft0, angle]],
        sx: moving ? [[ft0, 0.05], [ft0 + draw, 1, "outQuint"]] : [[ft0, 1]],
        o: moving ? [[ft0, 0], [ft0 + Math.min(40, draw / 2), 1]] : [[ft0, 1]],
      };
      const finished = withExit(flickTrack, fx, ft0);
      const shape = (points: [number, number][]) => polygonPath(points);
      pieces.push(
        { id: `${ctx.id}:fl${last}c`, kind: "shape", z: 3, fromMs: ft0, toMs: to, path: shape(brushPoints(L, hw, u, { ...opts, dx: 3 * u, dy: 5 * u, mirror: rtl })), fill: { colour: coral }, track: finished },
        { id: `${ctx.id}:fl${last}`, kind: "shape", z: 4, fromMs: ft0, toMs: to, path: shape(brushPoints(L, hw, u, { ...opts, mirror: rtl })), fill: { colour: brush }, track: finished },
      );
    }
  }
  return pieces;
}, undefined, LEAD);

/** The swoosh's four flat drawings (main stroke and bristle split, each with its coral echo), local to the key word's centre. */
function swooshPaths(L: number, hw: number, u: number, seed: number, mirror: boolean): { suffix: string; coral: boolean; points: [number, number][] }[] {
  const split = { from: 0.34, to: 0.84, lift: hw * 1.45, thin: 0.3, bow: 30, flick: 10, seed: seed + 3, mirror };
  const main = { seed, mirror };
  return [
    { suffix: "sc", coral: true, points: brushPoints(L, hw, u, { ...split, dx: 8 * u, dy: 14 * u }) },
    { suffix: "c", coral: true, points: brushPoints(L, hw, u, { ...main, dx: 9 * u, dy: 16 * u }) },
    { suffix: "s", coral: false, points: brushPoints(L, hw, u, split) },
    { suffix: "", coral: false, points: brushPoints(L, hw, u, main) },
  ];
}


import { CAPTION_SCENE_BRAND_MIN_CONTRAST, captionColourContrast, captionSceneMeta } from "@narriflow/validators";
import type { DemoScript } from "../demo";
import { clamp, type Frames } from "../ease";
import { exportFrameAfter, exportFrameAtOrAfter, exportFrameTimes, paintedFrameCount } from "../frame-grid";
import type { SceneWord } from "../input";
import { rowsFromRoles } from "../layout";
import { type Box, type PathCmd, type Piece, SCENE_PIECE_BUDGET, type Shadow, type TextPiece } from "../scene";
import { caps, galleryScene, rowBounds, rowsOf } from "./gallery-layout";
import type { SpeechCell } from "./speech-layout";

/**
 * Pixelpop (`samples/templates/m70-pixelpop.js`): the full 3D pixel-art look. Chunky pixel caps with a stepped extrusion
 * down and to the right; ordinary words are white over cyan and pink layers, the key word has a hard-banded cyan, yellow
 * and pink face over a blue stack. Words come in through a stair-step wipe, three rows with a one-step lag, and a pixel
 * icon pops in beside the block.
 *
 * Changes from the sample, and why (Sol's gallery 6 review, 2026-11-25, and the real-cue rules):
 * - **Ink starts at the word's onset.** The sample's first strip painted up to 80 ms early. Every face is on the first
 *   frame at or after its spoken start; nothing but the next cue's own window decides when a cue begins.
 * - **A short, stepped build.** Three hard steps of 16 ms per row, each row one step behind the one above, so a word is
 *   whole 64 ms after its onset (an 8 ms step when the word is shorter: a 70 ms word is whole by its last painted frame,
 *   and a word with a single painted frame is simply there). The extrusion is cut by the same rows, so the depth is built
 *   with the face, never before it. The direction follows the cue's (right to left for Urdu and Arabic).
 * - **The extrusion is one uncut stack.** The sample drew seven offset copies per row strip, three strips per word. Each
 *   word is now one text piece whose hard shadows are the stack (4 layers, 5 for the key word, far to near: dark seam,
 *   then the cyan and pink, or the pink, blue and deep blue, layers), snapped to a 4 to 6 px grid. The key word's three
 *   colour bands are two clipped copies of the face over the pink one; the cuts come from the measured face ink of the
 *   row, not the depth-inclusive box the sample took them from.
 * - **The exit waits for the word.** The sample's stepped wipe began 150 ms before the next cue and ate the last word on a
 *   short gap. It now starts only after the last spoken word has had its reading hold, in three steps that fit the time
 *   left (and is dropped when two painted frames do not fit: the cue then ends in a hard cut).
 * - **Nothing falls on the words.** The loose pixels fell through the word's own letters, and the icons sat on the last
 *   letter's depth. Cells now shed from the end of the key word's row into free space beside it (four at most), and the
 *   icon, the twinkle and the progress cells are placed by a free-space search against every word's ink and depth with
 *   16 px of clearance. A decoration with no free spot is left out; there is no clamping onto the text.
 * - **One icon, bigger cells.** The sample put three icons around the block with a minimum cell of 5 px, which forced them
 *   onto the letters after clamping. One icon per cue (flame, trophy, star, heart, thumbs-up, cycled by a per-cue counter,
 *   hero cues and plain cues each with their own), the largest cell that fits (never under 4 px), and it bobs a whole
 *   cell every 420 ms on a long hold.
 * - **Long words and every language.** A word that would need to shrink below 62 % of its size to fit the 740 px column is
 *   broken across rows (Latin, Cyrillic and Greek only); anything else is fitted whole. Pixelify has no Devanagari, so
 *   Hindi, Urdu and the rest are drawn whole in the fallback face, with the same colours, hard shadow steps and icon, and
 *   the bands are cut from that face's measured ink.
 * - Words are laid out by role, as the sample's `breaks` were: the words before the key word, the key word, the words
 *   after it, and a word alone on its row is drawn larger (1.3x, the key word 1.2x), fitted to the column. No cue-indexed
 *   table remains (the sample's icon table became the per-cue counters).
 * - Extra recurring beats, in the pixel language, on every cue: a plus-shaped pixel twinkle beside the block (again on every
 *   1.5 s of a long hold), and a row of coloured cells that fills in step by step under the block.
 * - Brand colours: the face, the key word's yellow band and the cyan are the preset's three colours; the pinks and blues
 *   of the extrusion are the style's own, and the catalogue row's `readsOn` keeps a brand colour that vanishes against
 *   the dark seam from replacing the face.
 */

export const PIXELPOP_DEMO: DemoScript = {
  lines: [
    "level:b up:b skills:h@640",
    "press:b start:h@560",
    "just:b hit:b record:b",
    "you:m got:m this:h@520",
    "new:b high:b score:h@600",
  ],
  options: { rate: 205, gap: 40, cueGap: 200, tail: 680, lead: 320 },
};

const FACE = "Pixelify Sans Bold";
const SPACING = 0.02;
const BODY = 128;
const MINOR = 78;
const HERO = 200;
const SOLO_BODY = 1.3;
const SOLO_HERO = 1.2;
const COLUMN = 740;
const GAP = 34;
const PADDING = 48;
const CLEAR = 16;
/** A word shrinking below this share of its size to fit the column is broken across rows instead. */
const MIN_FIT = 0.62;
/** The build takes four of these (64 ms) when the frame rate allows. */
const STEP_MS = 16;
const CUTS = [0.44, 0.6] as const;
const PINK = "#FF3DAE";
const BLUE = "#4A3BFF";
const DEEP = "#2514A8";
const INK = "#14093F";
/** The extrusion, far to near. */
const STACK: readonly (readonly string[])[] = [[PINK, "#2BE4FF", "#2BE4FF", INK], [DEEP, BLUE, BLUE, PINK, INK]];

/** What the decorations of one cue draw at most (icon with its stack, cells, twinkle, three progress pieces with shadows). */
const DECORATION_BUDGET = 20;

const SPLITTABLE = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{N}\p{P}]+$/u;

const BITMAPS = {
  heart: [".##...##.", "####.####", "#########", "#########", ".#######.", "..#####..", "...###...", "....#...."],
  star: ["....#....", "....#....", "...###...", "#########", ".#######.", "..#####..", "..#####..", ".###.###.", ".#.....#."],
  flame: ["....#....", "....##...", "...###..#", "..#####.#", "..#######", ".########", ".###.####", ".##...###", ".###.####", "..#####.."],
  thumbs: ["....##....", "...###....", "...###....", "...####...", "#.########", "#.#######.", "#.########", "#.#######.", "#.########", "..#######."],
  trophy: ["#########", "#.#####.#", "#.#####.#", "#.#####.#", ".#######.", "..#####..", "...###...", "...###...", ".#######."],
} as const;
type Icon = keyof typeof BITMAPS;
const HERO_ICONS: readonly Icon[] = ["flame", "trophy", "star", "heart", "thumbs"];
const PLAIN_ICONS: readonly Icon[] = ["heart", "star", "thumbs", "flame", "trophy"];

/** Hard steps: a value holds until 1 ms before its time and jumps there (the exporter samples at frames, so a step lands on one). */
function stairs(points: readonly (readonly [number, number])[]): Frames {
  const out: [number, number][] = [];
  for (const [at, value] of points) {
    const last = out.at(-1);
    if (!last) {
      out.push([at, value]);
      continue;
    }
    if (last[1] === value) continue;
    const jump = Math.max(last[0] + 1, at);
    if (jump - 1 > last[0]) out.push([jump - 1, last[1]]);
    out.push([jump, value]);
  }
  return out;
}

const rect = (x1: number, y1: number, x2: number, y2: number): PathCmd[] => [["M", x1, y1], ["L", x2, y1], ["L", x2, y2], ["L", x1, y2], ["Z"]];

/** Runs of `#` in the bitmap rows `[from, to)` as rectangles, cell `c`, centred on (0, 0) of the whole bitmap. */
function bitmapPath(map: readonly string[], from: number, to: number, c: number): PathCmd[] {
  const w = map[0]!.length;
  const h = map.length;
  const path: PathCmd[] = [];
  for (let y = from; y < to; y++) {
    for (let x = 0; x < w; x++) {
      if (map[y]![x] !== "#") continue;
      let end = x;
      while (map[y]![end + 1] === "#") end++;
      path.push(...rect((x - w / 2) * c, (y - h / 2) * c, (end + 1 - w / 2) * c, (y + 1 - h / 2) * c));
      x = end;
    }
  }
  return path;
}

const overlaps = (a: Box, b: Box) => a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
const inflate = (box: Box, by: number): Box => ({ x1: box.x1 - by, y1: box.y1 - by, x2: box.x2 + by, y2: box.y2 + by });

export const pixelpopProgram = galleryScene("pixelpop", 1290, (ctx) => {
  const { cue, index, to, from: cueFrom, bounds } = ctx.window;
  const { exit, exitAt, fps, side, space } = ctx;
  const c = ctx.input.colours;
  // The pair that is really drawn: the face and the yellow band sit inside the navy outline, so each keeps 3:1 against it or
  // falls back to the style default (the catalogue `readsOn` keeps brand colours off the same pair).
  const defaults = captionSceneMeta("pixelpop").colours;
  const keep = (colour: string, fallback: string) => (captionColourContrast(colour, INK) >= CAPTION_SCENE_BRAND_MIN_CONTRAST ? colour : fallback);
  const faceColour = keep(c.primary, defaults.primary);
  const yellow = keep(c.highlight, defaults.highlight);
  const cyan = c.accent;
  const pieces: Piece[] = [];
  const u = space.u;
  const roles = cue.words.map((word) => word.role);
  const { lead, hero, tail } = rowsFromRoles(roles);
  const heroed = hero.length > 0;

  // The words as the face draws them, a long one broken into rows when it cannot fit the column at a readable size.
  const room = COLUMN * u;
  const advance = (text: string, size: number) => ctx.input.measure(text, FACE, size * u, SPACING).advance;
  const nominal = (word: SceneWord) => (word.role === "hero" ? HERO : word.role === "minor" ? MINOR : BODY);
  const fit = (text: string, size: number) => Math.min(size, (size * room) / Math.max(1, advance(text, size)));
  /** The fewest rows that keep every piece at 62 % of its size or more, cut where the measured widths come out even. */
  const chunkOf = (text: string, size: number): string[] => {
    const width = advance(text, size);
    if (!SPLITTABLE.test(text) || width * MIN_FIT <= room) return [text];
    const letters = [...text];
    const rowsNeeded = Math.min(letters.length, Math.ceil((width * MIN_FIT) / room));
    const prefix = letters.map((_, at) => advance(letters.slice(0, at + 1).join(""), size));
    const out: string[] = [];
    let start = 0;
    for (let row = 1; row < rowsNeeded; row++) {
      const target = (width * row) / rowsNeeded;
      let cut = start + 1;
      for (let at = start + 1; at <= letters.length - (rowsNeeded - row); at++) {
        if (Math.abs(prefix[at - 1]! - target) < Math.abs(prefix[cut - 1]! - target)) cut = at;
      }
      out.push(letters.slice(start, cut).join(""));
      start = cut;
    }
    out.push(letters.slice(start).join(""));
    return out;
  };
  interface Item {
    readonly word: number;
    readonly part: number;
    readonly parts: number;
    readonly text: string;
  }
  const items: Item[] = [];
  const flatOf = cue.words.map((word, at) => {
    const texts = chunkOf(caps(word, cue), nominal(word));
    return texts.map((text, part) => items.push({ word: at, part, parts: texts.length, text }) - 1);
  });
  const groupOf = (list: readonly number[]) => list.flatMap((at) => flatOf[at]!);
  const groups = heroed ? [lead, hero, tail].filter((list) => list.length > 0).map(groupOf) : [groupOf(cue.words.map((_, at) => at))];
  const sizes = items.map((item) => fit(item.text, nominal(cue.words[item.word]!)));
  // The rows of a broken word share one size, the smallest any of them needs.
  for (const list of flatOf) {
    if (list.length < 2) continue;
    const common = Math.min(...list.map((at) => sizes[at]!));
    for (const at of list) sizes[at] = common;
  }
  const arrange = () => ctx.layout({ column: COLUMN, padding: PADDING, gap: GAP, groups, words: items.map((item, at) => ({ text: item.text, size: sizes[at]!, face: FACE, spacing: SPACING })) });
  let laid = arrange();
  // A word alone on its row is drawn larger, as the sample did.
  let grown = false;
  for (const row of rowsOf(laid.cells)) {
    if (row.length !== 1) continue;
    const at = row[0]!.at;
    const item = items[at]!;
    if (item.parts > 1) continue;
    const word = cue.words[item.word]!;
    sizes[at] = fit(item.text, nominal(word) * (word.role === "hero" ? SOLO_HERO : SOLO_BODY));
    grown = true;
  }
  if (grown) laid = arrange();
  const unit = laid.unit;

  // The extrusion makes every row wider and the block taller than its ink: centre the painted block, not the ink.
  interface Placed extends SpeechCell {
    readonly item: Item;
    readonly dep: number;
    readonly cell: number;
    /** The navy outline around the whole silhouette, behind all three colour bands. */
    readonly outline: number;
    readonly stack: readonly string[];
    readonly heroWord: boolean;
  }
  const rows0 = rowsOf(laid.cells);
  const depOf = (cell: SpeechCell) => {
    const heroWord = cue.words[items[cell.at]!.word]!.role === "hero";
    const stack = STACK[heroWord ? 1 : 0]!;
    const px = clamp(Math.round((cell.size / unit) * 0.04), 4, 6) * unit;
    return { heroWord, stack, cell: px, outline: 0.5 * px, dep: stack.length * px };
  };
  const reachOf = (cell: SpeechCell) => depOf(cell).dep + depOf(cell).outline;
  const lastDep = Math.max(...rows0.at(-1)!.map(reachOf));
  const placed: Placed[] = rows0.flatMap((row) => {
    const shift = -Math.max(...row.map(reachOf)) / 2;
    return row.map((cell): Placed => ({ ...cell, x: cell.x + shift, baseline: cell.baseline - lastDep / 2, item: items[cell.at]!, ...depOf(cell) }));
  });
  const rows = rowsOf(placed) as Placed[][];
  const inked = (cell: Placed): Box => ({
    x1: cell.x - cell.width / 2 - cell.outline, x2: cell.x + cell.width / 2 + cell.dep + cell.outline,
    y1: cell.baseline + cell.inkTop - cell.outline, y2: cell.baseline + cell.inkBottom + cell.dep + cell.outline,
  });
  const painted = placed.map(inked);
  const block: Box = {
    x1: Math.min(...painted.map((box) => box.x1)), x2: Math.max(...painted.map((box) => box.x2)),
    y1: Math.min(...painted.map((box) => box.y1)), y2: Math.max(...painted.map((box) => box.y2)),
  };

  const heroRow = rows.find((row) => row.some((cell) => cell.heroWord)) ?? rows.at(-1)!;
  const rowBox = (row: readonly Placed[]): Box => ({ ...rowBounds(row), x1: Math.min(...row.map((cell) => inked(cell).x1)), x2: Math.max(...row.map((cell) => inked(cell).x2)), y2: Math.max(...row.map((cell) => inked(cell).y2)) });
  const anchorBox = rowBox(heroRow);

  // Counters: hero cues and plain cues each cycle on their own.
  const earlier = ctx.input.cues.slice(0, index).filter((other) => other.words.length > 0);
  const count = earlier.filter((other) => other.words.some((word) => word.role === "hero") === heroed).length;
  const flip = count % 2 === 1;

  // Free space: inside the lane, clear of every word's ink and depth, clear of what is already placed.
  const area: Box = { x1: bounds.x1 + 4, y1: bounds.y1 + 4, x2: bounds.x2 - 4, y2: bounds.y2 - 4 };
  const taken: Box[] = [];
  const clear = CLEAR * u;
  const free = (box: Box) =>
    box.x1 >= area.x1 && box.x2 <= area.x2 && box.y1 >= area.y1 && box.y2 <= area.y2 &&
    !painted.some((ink) => overlaps(box, inflate(ink, clear))) && !taken.some((other) => overlaps(box, inflate(other, 6 * u)));
  const claim = (w: number, h: number, candidates: readonly (readonly [number, number])[]): Box | null => {
    for (const [x, y] of candidates) {
      const box = { x1: x, y1: y, x2: x + w, y2: y + h };
      if (free(box)) {
        taken.push(box);
        return box;
      }
    }
    return null;
  };
  const beside = (box: Box, w: number, left: boolean, drop = 0.1) => [(left ? box.x1 - clear - w : box.x2 + clear), box.y1 + (box.y2 - box.y1) * drop] as const;
  const above = (w: number, h: number, at: number) => [block.x1 + (block.x2 - block.x1 - w) * at, block.y1 - clear - h] as const;
  const below = (w: number, at: number) => [block.x1 + (block.x2 - block.x1 - w) * at, block.y2 + clear] as const;

  // The faces.
  /** The whole block's stepped exit: the share of each row still drawn, in thirds over the time left. */
  const exits: [number, number][] = exit ? [[exitAt + (to - exitAt) / 3, 2 / 3], [exitAt + (2 * (to - exitAt)) / 3, 1 / 3]] : [];
  let heroSettled = cueFrom;
  let heroFrom = cueFrom;
  let heroFirst = true;
  // Every layer of a shadow stack is a draw: a cue whose staged build plus decorations would pass the piece budget (a long word
  // broken into many rows) shows its words complete at once instead.
  const stagedCost = placed.reduce((sum, cell) => sum + (cell.heroWord ? 8 + 12 : 5 + 10), 0);
  const stagingFits = stagedCost + DECORATION_BUDGET <= SCENE_PIECE_BUDGET;
  for (const cell of placed) {
    const word = cue.words[cell.item.word]!;
    const wid = cell.item.parts > 1 ? `${ctx.id}:w${cell.item.word}l${cell.item.part}` : `${ctx.id}:w${cell.item.word}`;
    // About 64 ms, or the time of three painted frames when the frame rate is low (a stair needs two before the complete one);
    // `enter` still ends it on the word's last painted frame when the word is short.
    const onset = ctx.enter(word, 0, 0).from;
    const third = exportFrameTimes(onset, onset + 200, fps)[2];
    const { from, settled } = ctx.enter(word, third === undefined ? 4 * STEP_MS : Math.max(4 * STEP_MS, Math.min(110, third - onset)), 0);
    // The build is planned on the export frame grid: `stairFrames` painted frames before the complete one (`tc`). With fewer
    // than two the whole word is simply there; a temporary piece lives through the complete frame and one more, so it
    // paints on two frames and the shared visibility filter keeps it.
    const tc = exportFrameAtOrAfter(settled, fps);
    const frames = exportFrameTimes(from, tc + 1, fps);
    const stairFrames = frames.length - 1;
    const staged = stagingFits && stairFrames >= 2 && frames[frames.length - 1] === tc;
    const tempEnd = Math.min(to, exportFrameAfter(tc, fps) + 1);
    const row = rows.find((r) => r.includes(cell))!;
    const ink = rowBounds(row);
    const top = ink.y1;
    const bottom = ink.y2;
    const cut = [top + CUTS[0] * (bottom - top), top + CUTS[1] * (bottom - top)] as const;
    const pad = Math.max(6 * u, cell.outline + 2 * u);
    const left = cell.x - cell.width / 2 - pad;
    const reach = cell.width + cell.dep + 2 * pad;
    const right = left + reach;
    const bandTop = top - pad;
    const bandBottom = bottom + cell.dep + pad;
    // The edge of a wipe at a share of the width, snapped to the 4 to 6 px cell grid; the reveal runs with the reading direction.
    const edge = (share: number) => {
      const w = share >= 1 ? reach : share <= 0 ? 0 : Math.max(cell.cell, Math.round((share * reach) / cell.cell) * cell.cell);
      return side > 0 ? left + w : right - w;
    };
    const reveal = (r: number): [number, number][] =>
      staged ? frames.map((t, f) => [t, f >= stairFrames ? 1 : clamp((f - r + 1) / (stairFrames - 1))] as [number, number]) : [[from, 1]];
    const track = (r: number, permanent: boolean): { x1: Frames; x2: Frames } => {
      const shares = stairs([...reveal(r), ...(permanent ? exits : [])]);
      if (side > 0) return { x1: [[from, left]], x2: shares.map(([t, v]) => [t, edge(v)] as const) };
      return { x1: shares.map(([t, v]) => [t, edge(v)] as const), x2: [[from, right]] };
    };
    const shadows: Shadow[] = cell.stack.map((colour, k) => ({ dx: (cell.stack.length - k) * cell.cell, dy: (cell.stack.length - k) * cell.cell, blur: 0, colour, alpha: 1 }));
    const body = cell.heroWord ? PINK : faceColour;
    const make = (suffix: string, fill: string, y1: Frames, y2: Frames, r: number, permanent: boolean, depth: boolean, end?: number): TextPiece => {
      const t = track(r, permanent);
      return {
        ...ctx.face(cell, from, fill, { o: [[from, 1]] }),
        id: `${wid}${suffix}`,
        z: suffix === "" || suffix === "row1d" ? 6 : 7,
        ...(end !== undefined ? { toMs: end } : {}),
        ...(depth ? { shadows, stroke: { widthPx: cell.outline, colour: INK } } : {}),
        clip: { x1: t.x1, x2: t.x2, y1, y2 },
      };
    };
    // The face: the top row first, widening to the whole word on the complete frame; the rows below arrive as their own
    // copies, so the picture is the sample's stair and the face piece is whole and readable by the last painted frame.
    const baseBottom: Frames = staged ? stairs([[frames[0]!, cut[0]], [tc, bandBottom]]) : [[from, bandBottom]];
    pieces.push(make("", body, [[from, bandTop]], baseBottom, 0, true, true));
    if (cell.heroWord) {
      pieces.push(make("row0", cyan, [[from, bandTop]], [[from, cut[0]]], 0, true, false));
      pieces.push(make("row1", yellow, [[from, cut[0]]], [[from, cut[1]]], 1, true, false));
      if (staged) {
        pieces.push(make("row1d", body, [[from, cut[0]]], [[from, cut[1]]], 1, false, true, tempEnd));
        pieces.push(make("row2", body, [[from, cut[1]]], [[from, bandBottom]], 2, false, true, tempEnd));
      }
      if (heroFirst) {
        heroFirst = false;
        heroFrom = from;
        heroSettled = tc;
      }
    } else if (staged) {
      pieces.push(make("row1", body, [[from, cut[0]]], [[from, cut[1]]], 1, false, true, tempEnd));
      pieces.push(make("row2", body, [[from, cut[1]]], [[from, bandBottom]], 2, false, true, tempEnd));
    }
  }

  // Decorations, in free space, scheduled against the painted frames the cue really has: a beat takes its preferred start
  // when it fits, an earlier one when the cue is short, and a compact static pose when only two frames are left.
  const beat = heroed ? heroFrom : cue.words[Math.max(0, cue.words.length - 2)]!.startMs;
  const bandHold = exit ? exitAt : to;
  const gridTimes = exportFrameTimes(cueFrom, bandHold, fps);
  const startFor = (preferred: number, need: number): number | null => {
    if (gridTimes.length < need) return null;
    return Math.max(cueFrom, Math.min(preferred, gridTimes[gridTimes.length - need]!));
  };
  const stepsOut = (from: number): readonly (readonly [number, number])[] =>
    exit ? [[exitAt + (to - exitAt) / 3, 0.75], [exitAt + (2 * (to - exitAt)) / 3, 0.45]].map(([at, v]) => [Math.max(at!, from + 1), v!] as const) : [];
  /** More places to look when the preferred ones are taken: beside, above and below every row. */
  const elsewhere = (w: number, h: number): (readonly [number, number])[] =>
    rows.flatMap((row) => {
      const box = rowBox(row);
      const middle = box.y1 + (box.y2 - box.y1 - h) / 2;
      return [[box.x1 - clear - w, middle], [box.x2 + clear, middle], [box.x1 - clear - w, box.y1], [box.x2 + clear, box.y1]] as const;
    }).concat([above(w, h, 0), above(w, h, 0.5), above(w, h, 1), below(w, 0), below(w, 0.5), below(w, 1)]);

  // 1. The icon: the largest cell that fits beside the key word's row (above or below the block as a last resort).
  const names = heroed ? HERO_ICONS : PLAIN_ICONS;
  const icon = names[count % names.length]!;
  const map = BITMAPS[icon];
  const cols = map[0]!.length + 3;
  const lines = map.length + 3;
  const iconAt = startFor(beat + 130, 2);
  if (iconAt !== null) {
    let iconBox: Box | null = null;
    let cellPx = 0;
    for (const size of [12, 11, 10, 9, 8, 7, 6, 5, 4]) {
      const px = size * u;
      const w = cols * px * 1.12;
      const h = lines * px * 1.12;
      iconBox = claim(w, h, [
        beside(anchorBox, w, !flip), beside(anchorBox, w, flip), beside(rowBox(rows[0]!), w, !flip), beside(rowBox(rows.at(-1)!), w, flip),
        above(w, h, flip ? 1 : 0), below(w, flip ? 0 : 1), ...elsewhere(w, h),
      ]);
      if (iconBox) {
        cellPx = px;
        break;
      }
    }
    if (iconBox) {
      const px = cellPx;
      const cx = iconBox.x1 + 0.06 * cols * px + (map[0]!.length * px) / 2;
      const cy = iconBox.y1 + 0.06 * lines * px + (map.length * px) / 2;
      const pop = paintedFrameCount(iconAt, iconAt + 180, fps) >= 5 && iconAt + 200 < bandHold;
      const scale: (readonly [number, number])[] = [...(pop ? [[iconAt, 0.5], [iconAt + 55, 0.9], [iconAt + 110, 1.15], [iconAt + 165, 1]] as [number, number][] : [[iconAt, 1]] as [number, number][]), ...stepsOut(iconAt + 170)];
      const bobs: [number, number][] = [[iconAt, 0]];
      for (let k = 1; iconAt + 500 + k * 420 < bandHold - 120 && k < 12; k++) bobs.push([iconAt + 500 + k * 420, k % 2 === 1 ? -px : 0]);
      const track = { x: [[iconAt, cx]] as Frames, y: stairs(bobs).map(([at, v]) => [at, cy + v] as const) as Frames, sx: stairs(scale), sy: stairs(scale), o: [[iconAt, 1]] as Frames };
      const third = map.length / 3;
      const bands = [Math.round(third), Math.round(2 * third)];
      const body = ctx.shape("icon", iconAt, bitmapPath(map, 0, map.length, px), track, PINK);
      pieces.push({ ...body, z: 7, shadows: [DEEP, BLUE, PINK].map((colour, k) => ({ dx: (3 - k) * px, dy: (3 - k) * px, blur: 0, colour, alpha: 1 })) });
      pieces.push({ ...ctx.shape("iconA", iconAt, bitmapPath(map, 0, bands[0]!, px), track, cyan), z: 8 });
      pieces.push({ ...ctx.shape("iconB", iconAt, bitmapPath(map, bands[0]!, bands[1]!, px), track, yellow), z: 8 });
    }
  }

  // 2. Cells shed from the end of the key word's row, beside it, falling in whole steps (a short cue holds them still).
  {
    const sz = clamp(Math.round(((heroRow[0]?.size ?? BODY) / unit) * 0.075), 6, 12) * u;
    const offsets = [[0, 0], [1.5, 1.6], [2.8, 0.4], [3.6, 2.4]] as const;
    const fall = 0.9 * sz;
    const w = 3.6 * sz + sz;
    const h = 2.4 * sz + sz + 3 * fall;
    const life = 260;
    const falls = startFor(heroed ? heroSettled : beat, 5);
    const born = falls ?? startFor(heroed ? heroSettled : beat, 2);
    if (born !== null) {
      const first = heroRow[side > 0 ? heroRow.length - 1 : 0]!;
      const ends = rowBox([first]);
      const spot = claim(w, h, [beside(ends, w, side < 0, 0), beside(ends, w, side < 0, 0.3), beside(anchorBox, w, flip, 0), above(w, h, flip ? 0 : 1), ...elsewhere(w, h)]);
      if (spot) {
        const shapePath = offsets.flatMap(([ox, oy]) => rect(ox! * sz, oy! * sz, ox! * sz + sz, oy! * sz + sz));
        const colour = [cyan, yellow, PINK, faceColour][(count + (heroed ? 0 : 2)) % 4]!;
        const end = Math.min(bandHold, born + (falls === null ? 2 * 34 : life));
        const drops = falls === null ? [[born, spot.y1]] as const : ([0, 1, 2, 3].map((k) => [born + (k * life) / 4, spot.y1 + k * fall] as const));
        const piece = ctx.shape("cells", born, shapePath, { x: [[born, spot.x1]], y: stairs(drops), o: [[born, 1]] }, colour);
        pieces.push({ ...piece, z: 7, toMs: Math.max(end, exportFrameAfter(born, fps) + 1) });
      }
    }
  }

  // 3. A pixel twinkle: a plus of nine cells that grows, shrinks and grows again at a free corner of the block, again every
  // 1.5 s of a long hold. It ends at its last burst, so the exit never brings it back; a cue too short for a burst holds
  // the plus still.
  {
    const px = clamp(Math.round(((heroRow[0]?.size ?? BODY) / unit) * 0.055), 6, 11) * u;
    const span = 5 * px * 1.5;
    const animated = startFor(beat + 220, 12);
    const at0 = animated ?? startFor(beat + 220, 2);
    if (at0 !== null) {
      const spot = claim(span, span, [above(span, span, flip ? 0 : 1), above(span, span, flip ? 1 : 0), beside(anchorBox, span, flip, 0), beside(anchorBox, span, !flip, 0), below(span, flip ? 1 : 0), ...elsewhere(span, span)]);
      if (spot) {
        const plus = [...rect(-2.5 * px, -0.5 * px, 2.5 * px, 0.5 * px), ...rect(-0.5 * px, -2.5 * px, 0.5 * px, -0.5 * px), ...rect(-0.5 * px, 0.5 * px, 0.5 * px, 2.5 * px)];
        const points: [number, number][] = [];
        let last = at0;
        if (animated !== null) {
          for (let burst = 0; burst < 3 && at0 + burst * 1500 + 360 <= bandHold; burst++) {
            const t = at0 + burst * 1500;
            points.push([t, 0.4], [t + 90, 1], [t + 180, 0.6], [t + 270, 1], [t + 360, 0.01]);
            last = t + 360;
          }
        }
        const still = points.length === 0;
        const scale = still ? stairs([[at0, 1], ...stepsOut(at0)]) : stairs(points);
        const piece = ctx.shape("spark", at0, plus, { x: [[at0, spot.x1 + span / 2]], y: [[at0, spot.y1 + span / 2]], sx: scale, sy: scale, o: [[at0, 1]] }, faceColour);
        pieces.push({ ...piece, z: 7, ...(still ? {} : { toMs: last }), shadows: [{ dx: px, dy: px, blur: 0, colour: PINK, alpha: 1 }] });
      }
    }
  }

  // 4. A row of cells that fills in under the block, one cell per step, in the three band colours.
  {
    const n = 6;
    const px = clamp(Math.round(((heroRow[0]?.size ?? BODY) / unit) * 0.05), 6, 10) * u;
    const w = n * px * 1.5 - 0.5 * px;
    const at0 = startFor((heroed ? heroFrom : cue.words[0]!.startMs) + 60, 2);
    if (at0 !== null) {
      const span = Math.min(300, Math.max(0, bandHold - at0 - 120));
      const spot = claim(w, px, [below(w, 0.5), above(w, px, 0.5), below(w, flip ? 0 : 1), ...elsewhere(w, px)]);
      if (spot) {
        const colours = [cyan, yellow, PINK] as const;
        const reachAt = (k: number) => (side > 0 ? spot.x1 + k * px * 1.5 : spot.x2 - k * px * 1.5);
        colours.forEach((colour, kind) => {
          const path = Array.from({ length: n }, (_, k) => k).filter((k) => k % 3 === kind).flatMap((k) => rect(k * px * 1.5, 0, k * px * 1.5 + px, px));
          const grow = span >= 90 ? stairs([...Array.from({ length: n }, (_, k) => [at0 + (k * span) / n, reachAt(k + 1) - (side > 0 ? 0.5 * px : -0.5 * px)] as [number, number]), ...(exit ? [[exitAt, reachAt(n)] as [number, number], [exitAt + (to - exitAt) / 2, reachAt(n / 2)] as [number, number]] : [])]) : [[at0, reachAt(n)] as const];
          const clip = side > 0
            ? { x1: [[at0, spot.x1 - px]] as Frames, x2: grow as Frames, y1: [[at0, spot.y1 - px]] as Frames, y2: [[at0, spot.y2 + px]] as Frames }
            : { x1: grow as Frames, x2: [[at0, spot.x2 + px]] as Frames, y1: [[at0, spot.y1 - px]] as Frames, y2: [[at0, spot.y2 + px]] as Frames };
          const piece = ctx.shape(`bar${kind}`, at0, path, { x: [[at0, spot.x1]], y: [[at0, spot.y1]], o: [[at0, 1]] }, colour);
          pieces.push({ ...piece, z: 7, clip, shadows: [{ dx: 0.5 * px, dy: 0.5 * px, blur: 0, colour: INK, alpha: 1 }] });
        });
      }
    }
  }
  return pieces;
}, undefined, 0);

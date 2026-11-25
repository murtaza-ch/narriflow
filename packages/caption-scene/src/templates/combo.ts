import type { CaptionFontName } from "@narriflow/validators";
import type { DemoScript } from "../demo";
import { EASES, kf, lerp, prog } from "../ease";
import { paintedFrameCount } from "../frame-grid";
import { sampleFrames } from "../frames";
import type { SceneInput, SceneProgram } from "../input";
import { type SceneSpace, sceneSpace } from "../layout";
import type { Box, Frames, Piece } from "../scene";
import { ellipsePath, polygonPath } from "../shapes";
import { caps, galleryScene, rowsOf } from "./gallery-layout";
import { speechWindows } from "./speech-layout";

/**
 * Combo (`samples/templates/m54-combo.js`): arcade "combo hit" caps with a pink and cyan colour-split edge. Every word slams
 * in with the split closing up, and the key word lands as a critical hit: a ring and a fan of shards behind the words.
 *
 * What changed from the sample, and why:
 * - No XP bar and no combo counter (owner, after testing it in the Studio: "remove bottom line progress and numbers"). The
 *   counter, its pulse ring and break drop, the segmented bar, its shine and the room reserved for them are gone; the block
 *   is centred in the caption band like any other style.
 * - A different face: the sample's Chakra Petch "doesn't fit" (owner). Archivo Black, the heaviest of four candidates tried
 *   on the same real cues (Archivo Black, Bricolage Grotesque, Anton, Racing Sans One): its wide, closed forms keep the pink
 *   and cyan split and the ink outline legible on busy footage where Anton's tight counters fill in and Racing Sans One's
 *   thinner italic strokes wash out. It reads as a game-title hit at body size; the body is 76 px (the sample's 84 px was
 *   Chakra Petch's narrower caps). Devanagari and Arabic fall back as in every style.
 * - Rows come from the words, not a cue table: each key word sits on its own row and the words around it wrap into
 *   balanced rows (the sample's flex-wrap, shrunk to fit). Every key word of a cue lands as a critical hit, not only the
 *   first (a cue with two gets two rows, two rings, two fans).
 * - The key word's size fits its row (never below 1.15x the body) before the shared fit, so a long key word does not
 *   shrink the body; an overlong Latin, Cyrillic, Greek or CJK word breaks across rows (pieces of equal measured width) at
 *   a readable floor instead of shrinking the block. Joined scripts shrink instead of breaking.
 * - The slam (2.0x) and the body pop (1.3x) start as large as the real clearance allows: the neighbouring rows and words,
 *   the colour-split copies (0.12 em out at the peak), the safe area and the caption band. Hero rows get a little extra air
 *   so the slam still has room. An entrance never covers a word.
 * - The ring and the shards are drawn behind every word (the sample's z order, made explicit) and each shard's flight is
 *   clamped to the safe area. A window too short for the whole beat plays it compressed.
 * - Speech first: the first word of a cue enters with the cue's first painted frame (no empty frame between cues), the
 *   slam, pop and colour split compress into a short word's own time, and the row recentres as words arrive exactly as
 *   the sample's rows do.
 * - The whole block is fitted into the caption band (860-1650 px of a 1920 px frame at the default position, the same share
 *   of any canvas, never past the safe area): shrunk when too tall, centred in it. Two speakers on screen together read at
 *   the smaller lane's size.
 * - Extra recurring beats, all behind the words: a small cyan ring on the last word of a cue that has no key word, and the
 *   critical-hit fan turns by a seeded amount and rotates its colours on every key word.
 * - Colours: white words, the highlight on the key word, the accent as the ink outline (brand colours read on it), and the
 *   sample's pink and cyan split copies fixed.
 */

export const COMBO_DEMO: DemoScript = {
  lines: [
    "listen:b up:b guys:b",
    "this:m one:b trick:b doubled:h@560 my:m views:b",
    "in:m just:b ten:b days:b",
    "your:m+850 turn:h@520",
    "go:b crush:b it:b",
  ],
  options: { rate: 240, gap: 20, cueGap: 90, tail: 700 },
};

const HOT = "#FF2E88";
const COOL = "#00E5FF";
const FACE: CaptionFontName = "Archivo Black";
const S = 76;
/** The key word, at the sample's 1.55x of the body. */
const HERO = Math.round(S * 1.55);
const COLUMN = 880;
const ROW_GAP = 0.12 * S;
const WORD_GAP = 0.3 * S;
const LEAD_NEXT = 40;
/** How far the colour-split copies reach from the ink at the peak of the slam, in em. */
const COPY = 0.12;

/** A small deterministic hash of a cue and a word, for seeded variety. */
function seeded(...parts: readonly (number | string)[]): number {
  let h = 2166136261;
  for (const char of parts.join(":")) h = Math.imul(h ^ char.charCodeAt(0), 16777619);
  return (h >>> 0) % 997;
}

/** Scripts a word may be broken inside without breaking its shaping. */
const BREAKABLE = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{N}\p{P}]+$/u;
/** The smallest body and key word sizes (sample px) worth reading on a phone before a word is broken across rows. */
const BODY_FLOOR = 58;
const HERO_FLOOR = S * 1.15;

interface Unit {
  readonly word: number;
  readonly part: number;
  readonly parts: number;
  readonly text: string;
  readonly size: number;
}

function comboCuesFor(grow: number): SceneProgram {
  return galleryScene("combo", 1320, (ctx) => {
  const { cue, index, to } = ctx.window;
  const { safe } = ctx.space;
  const c = ctx.input.colours;
  const ink = c.accent;
  const side = ctx.side;
  const frame = 1000 / (ctx.fps || 30);
  const heroAt = new Set(cue.words.flatMap((word, at) => (word.role === "hero" ? [at] : [])));
  const advance100 = (text: string) => ctx.input.measure(text, FACE, 100, 0).advance;
  const fitSize = (text: string) => ((COLUMN - 30) * 100) / Math.max(1, advance100(text));

  // Units: a word, or the pieces of an overlong breakable word, each on a row of its own at a readable size.
  const units: Unit[] = [];
  cue.words.forEach((word, at) => {
    const text = caps(word, cue);
    const hero = heroAt.has(at);
    const normal = hero ? Math.min(HERO, Math.max(HERO_FLOOR, fitSize(text))) : S;
    const floor = hero ? HERO_FLOOR : BODY_FLOOR;
    const letters = [...text];
    if (fitSize(text) >= floor || !BREAKABLE.test(text) || letters.length < 2) {
      units.push({ word: at, part: 0, parts: 1, text, size: normal });
      return;
    }
    // Pieces of equal measured width, not equal letter counts (a run of M and a run of I need different letter counts).
    const parts = Math.min(letters.length, Math.ceil(floor / fitSize(text)));
    const advances = letters.map((letter) => advance100(letter));
    const total = advances.reduce((sum, advance) => sum + advance, 0);
    const cuts = [0];
    let run = 0;
    advances.forEach((advance, i) => {
      if (cuts.length < parts && run + advance / 2 >= (cuts.length * total) / parts && i > cuts.at(-1)!) cuts.push(i);
      run += advance;
    });
    cuts.push(letters.length);
    const chunks = cuts.slice(0, -1).map((cut, k) => letters.slice(cut, cuts[k + 1]).join(""));
    const size = Math.min(normal, Math.max(floor, Math.min(...chunks.map(fitSize))));
    for (const [part, chunk] of chunks.entries()) units.push({ word: at, part, parts: chunks.length, text: chunk, size });
  });
  const groups: number[][] = [];
  units.forEach((unit, at) => {
    const previous = units[at - 1];
    const alone = heroAt.has(unit.word) || unit.parts > 1;
    if (alone || !groups.length || !previous || heroAt.has(previous.word) || previous.parts > 1) groups.push([at]);
    else groups.at(-1)!.push(at);
  });
  const wordOf = (cell: { at: number }) => units[cell.at]!.word;
  const band = captionBand(ctx.input, ctx.space, grow);

  // Rows: the sample's line boxes (1.08 em, ink centred). Rows next to a key word get a little more air so its slam has room.
  const geometry = (k: number) => {
    const { cells, unit } = ctx.layout({
      column: COLUMN, gap: WORD_GAP * k, padding: 50, groups,
      words: units.map((part) => ({ text: part.text, face: FACE, size: part.size * k, spacing: 0 })),
    });
    const u = unit * k;
    const rows = rowsOf(cells);
    const isHeroRow = rows.map((row) => row.some((cell) => heroAt.has(wordOf(cell))));
    const rowSize = rows.map((row) => Math.max(...row.map((cell) => cell.size)));
    const rowInk = rows.map((row) => ({ top: Math.min(...row.map((cell) => cell.inkTop)), bottom: Math.max(...row.map((cell) => cell.inkBottom)) }));
    const rowHeight = rows.map((_, r) => Math.max(1.08 * rowSize[r]!, rowInk[r]!.bottom - rowInk[r]!.top + 0.2 * rowSize[r]!));
    const gapAfter = rows.map((_, r) => (ROW_GAP + (isHeroRow[r] || isHeroRow[r + 1] ? 0.18 * S : 0)) * u);
    // The colour-split copies sit up to 0.12 em beyond the ink at the slam: keep that much of the band free at both ends.
    const padTop = COPY * rowSize[0]!;
    const padBottom = COPY * rowSize.at(-1)!;
    const total = rowHeight.reduce((sum, h) => sum + h, 0) + gapAfter.slice(0, -1).reduce((sum, g) => sum + g, 0);
    return { cells, u, rows, rowInk, rowHeight, gapAfter, total, padTop, padBottom, k };
  };
  // The block lives in the caption band: shrink it until it fits, then centre it there.
  const room = band.y2 - band.y1;
  const need = (shape: { total: number; padTop: number; padBottom: number }) => shape.total + shape.padTop + shape.padBottom;
  let shape = geometry(1);
  for (let tries = 0; tries < 3 && need(shape) > room + 0.5; tries++) shape = geometry(Math.max(0.3, shape.k * (room / need(shape)) * 0.98));
  const { cells, u, rows, rowInk, rowHeight, gapAfter, total, padTop, padBottom } = shape;
  const blockTop = Math.min(Math.max(ctx.space.y(1320) - total / 2, band.y1 + padTop), band.y2 - padBottom - total);
  const baselines: number[] = [];
  let y = blockTop;
  rows.forEach((_, r) => {
    baselines[r] = y + rowHeight[r]! / 2 - (rowInk[r]!.top + rowInk[r]!.bottom) / 2;
    y += rowHeight[r]! + gapAfter[r]!;
  });
  const rowOfCell = new Map(rows.flatMap((row, r) => row.map((cell) => [cell.at, r] as const)));

  // Entrances: each word is locked to its speech; the cue's first word enters with the cue's first frame.
  const enters = cue.words.map((word, at) => ctx.enter(word, heroAt.has(at) ? 150 : 110, at === 0 ? 80 : LEAD_NEXT));
  const ARRIVE = 150;
  // The row recentres as its words arrive: all words of a row share one shift.
  const shifts = rows.map((row) => {
    const spoken = [...row].sort((a, b) => a.at - b.at);
    const full = spoken.reduce((sum, cell, i) => sum + cell.width + (i ? WORD_GAP * u : 0), 0);
    const edges = spoken.flatMap((cell) => [enters[wordOf(cell)]!.from, enters[wordOf(cell)]!.from + ARRIVE]);
    const fn = (t: number) => {
      if (spoken.length === 1) return 0;
      let shown = 0;
      spoken.forEach((cell, i) => {
        shown += EASES.out(prog(t, enters[wordOf(cell)]!.from, ARRIVE)) * (cell.width + (i ? WORD_GAP * u : 0));
      });
      return side * (full - shown) / 2;
    };
    return { fn, edges, end: Math.max(...edges) };
  });

  // Where each word sits as a whole, for the key word's ring and shards.
  const wordBox = cue.words.map((_, at) => {
    const own = cells.filter((cell) => wordOf(cell) === at);
    const tops = own.map((cell) => baselines[rowOfCell.get(cell.at)!]! + cell.inkTop);
    const bottoms = own.map((cell) => baselines[rowOfCell.get(cell.at)!]! + cell.inkBottom);
    const x1 = Math.min(...own.map((cell) => cell.x - cell.width / 2));
    const x2 = Math.max(...own.map((cell) => cell.x + cell.width / 2));
    return { cx: (x1 + x2) / 2, cy: (Math.min(...tops) + Math.max(...bottoms)) / 2, size: Math.max(...own.map((cell) => cell.size)) };
  });

  /** The largest entrance scale a word may start at: its ink, the colour-split copies (0.12 em out at the peak) and the
   * outline stay clear of the neighbouring rows and words, and inside the safe area. */
  const clearScale = (cell: (typeof cells)[number], peak: number): number => {
    const r = rowOfCell.get(cell.at)!;
    const outline = 0.05 * cell.size;
    const halfW = cell.width / 2 + outline;
    const halfH = (cell.inkBottom - cell.inkTop) / 2 + outline;
    const grow = (limit: number, half: number) => (limit + half) / (half + COPY * cell.size);
    const above = r > 0 ? baselines[r]! + cell.inkTop - Math.max(...rows[r - 1]!.map((other) => baselines[r - 1]! + other.inkBottom)) : baselines[r]! + cell.inkTop - band.y1;
    const below = r < rows.length - 1 ? Math.min(...rows[r + 1]!.map((other) => baselines[r + 1]! + other.inkTop)) - (baselines[r]! + cell.inkBottom) : Number.POSITIVE_INFINITY;
    // The row above is already on screen; the row below is spoken later, so it only gets half the gap. The last row may
    // pop down to the foot of the band.
    const foot = r === rows.length - 1 ? band.y2 - (baselines[r]! + cell.inkBottom) : Number.POSITIVE_INFINITY;
    const vertical = Math.min(above - 3, below / 2 - 1.5, foot - 3);
    const sideways = rows[r]!.filter((other) => other !== cell).map((other) => Math.abs(other.x - cell.x) - other.width / 2 - cell.width / 2);
    const across = sideways.length ? Math.min(...sideways) / 2 - 2 : Infinity;
    const edge = Math.min(cell.x - cell.width / 2 - safe.x1, safe.x2 - cell.x - cell.width / 2) - 12;
    return Math.max(1, Math.min(peak, grow(vertical, halfH), grow(across, halfW), grow(edge, halfW)));
  };

  const pieces: Piece[] = [];

  for (const cell of cells) {
    const unit = units[cell.at]!;
    const at = unit.word;
    const hero = heroAt.has(at);
    const r = rowOfCell.get(cell.at)!;
    const { from, settled, motion } = enters[at]!;
    const shift = shifts[r]!;
    const centreY = baselines[r]! + (cell.inkTop + cell.inkBottom) / 2;
    const k = motion ? (settled - from) / (hero ? 150 : 110) : 1;
    const tag = unit.parts > 1 ? `l${unit.part}` : "";

    // The slam: the key word drops in at up to 2x, undershoots, settles. Body words pop from 1.3x.
    const wide = clearScale(cell, hero ? 2 : 1.3);
    const scaleFrames: Frames = !motion ? [[from, 1]]
      : hero ? [[from, wide], [from + 70 * k, 0.92, "in"], [settled, 1, "out"]]
        : [[from, wide], [settled, 1, "out"]];
    const scaleAt = (t: number) => kf(t, scaleFrames);
    const splitDur = motion ? Math.min(120, settled - from) : 0;
    const split = (t: number) => (motion ? lerp(2.4, 1, EASES.out(prog(t, from, splitDur))) : 1);
    const horizon = Math.max(settled, shift.end, from + splitDur);
    const edges = [from, settled, from + 70 * k, from + splitDur, ...shift.edges];
    const positions = (dx: number, dy: number) => ({
      x: sampleFrames((t) => cell.x + shift.fn(t) + dx * 0.05 * cell.size * split(t) * scaleAt(t), edges, 0.15, { range: [from, Math.max(from + 1, horizon)], simplify: true }),
      y: sampleFrames((t) => centreY + dy * 0.05 * cell.size * split(t) * scaleAt(t), edges, 0.15, { range: [from, Math.max(from + 1, horizon)], simplify: true }),
    });
    const origin = { dx: 0, dy: (cell.inkTop + cell.inkBottom) / 2 };
    const outline = 0.05 * cell.size;
    const name = `${ctx.id}:w${at}${tag}`;

    for (const [suffix, fill, [dx, dy]] of [["h", HOT, [1, 1]], ["k", COOL, [-1, -0.6]]] as const) {
      pieces.push({
        ...ctx.face(cell, from, fill, { ...positions(dx, dy), sx: scaleFrames, sy: scaleFrames }),
        id: `${name}${suffix}`, z: 5, origin, stroke: { colour: fill, widthPx: outline },
      });
    }
    const face = ctx.face(cell, from, hero ? c.highlight : c.primary, { ...positions(0, 0), sx: scaleFrames, sy: scaleFrames });
    pieces.push({ ...face, id: name, origin, stroke: { colour: ink, widthPx: outline } });
  }

  // The critical hit of each key word: a ring and a fan of shards, behind every word. A window too short for the whole
  // beat plays it compressed (and a static pose if even that cannot move).
  for (const at of heroAt) {
    const { from } = enters[at]!;
    const burst = Math.min(1, (to - from) / 360);
    if (paintedFrameCount(from, to, ctx.fps) < 2) continue;
    const { cx, cy, size } = wordBox[at]!;
    const h = seeded(index, at, cue.words[at]!.text);
    const reach = (ox: number, oy: number) => Math.min(cx - safe.x1 + ox, safe.x2 - cx + ox, cy - safe.y1 + oy, safe.y2 - cy + oy);
    const end = (dur: number) => Math.min(to, Math.max(from + dur * burst, from + 2 * frame));
    const ringBase = 0.6 * size;
    const ringTo = Math.max(1, Math.min(2.1, (reach(-6, -6) - 0.035 * size) / ringBase));
    const ringStroke = 0.07 * size;
    const ringEnd = end(340);
    pieces.push({
      ...ctx.shape(`ring${at}`, from, ellipsePath(0, 0, ringBase - ringStroke / 2), {
        x: [[from, cx]], y: [[from, cy]],
        sx: [[from, 0.5], [ringEnd, ringTo, "out"]], sy: [[from, 0.5], [ringEnd, ringTo, "out"]],
        o: [[from, 1], [from + (ringEnd - from) * 0.18, 1], [ringEnd, 0]],
      }),
      z: 1.5, toMs: ringEnd, stroke: { colour: c.highlight, widthPx: ringStroke },
    });
    const palette = [c.highlight, c.primary, HOT, COOL, c.highlight, c.primary];
    const turn = ((h % 5) - 2) * 9;
    [-80, -25, 25, 80, 140, 200].forEach((angle, i) => {
      const s = [1, 0.8, 1, 0.8, 0.9, 0.7][i]!;
      const dist = [230, 280, 240, 220, 260, 210][i]! * u;
      const len = size * 0.62;
      const rad = ((angle + turn) * Math.PI) / 180;
      const room = Math.min(
        Math.cos(rad) > 0 ? (safe.x2 - 6 - len / 2 - cx) / Math.cos(rad) : Math.cos(rad) < 0 ? (cx - safe.x1 - 6 - len / 2) / -Math.cos(rad) : Number.POSITIVE_INFINITY,
        Math.sin(rad) > 0 ? (safe.y2 - 6 - len / 2 - cy) / Math.sin(rad) : Math.sin(rad) < 0 ? (cy - safe.y1 - 6 - len / 2) / -Math.sin(rad) : Number.POSITIVE_INFINITY,
      );
      const d = Math.max(0, Math.min(dist, room));
      const start = from + 20 * burst;
      const shardEnd = Math.min(to, Math.max(start + 320 * burst, start + 2 * frame));
      const span = shardEnd - start;
      const flight = (t: number) => EASES.out(prog(t, start, span * 0.8));
      const frames = (fn: (t: number) => number) => sampleFrames(fn, [start, start + span * 0.8, start + span * 0.3, shardEnd], 0.05, { range: [start, shardEnd], simplify: true });
      pieces.push({
        ...ctx.shape(`shard${at}-${i}`, start, polygonPath([[-len / 2, 0], [len / 2, -len * 0.3], [len / 2, len * 0.3]]), {
          x: frames((t) => cx + Math.cos(rad) * d * flight(t)),
          y: frames((t) => cy + Math.sin(rad) * d * flight(t)),
          rz: frames((t) => angle + turn + flight(t) * 180),
          sx: frames((t) => s * (1 - 0.35 * flight(t))), sy: frames((t) => s * (1 - 0.35 * flight(t))),
          o: frames((t) => 1 - EASES.in(prog(t, start + span * 0.3, span * 0.7))),
        }, palette[(i + h) % palette.length]!),
        z: 1.5, toMs: shardEnd, stroke: { colour: ink, widthPx: 0.025 * size },
      });
    });
  }

  // No key word: the last word of the cue lands a small cyan hit ring, behind the words.
  if (heroAt.size === 0 && cue.words.length) {
    const at = cue.words.length - 1;
    const { from } = enters[at]!;
    const { cx, cy, size } = wordBox[at]!;
    const dur = Math.min(280, to - from);
    if (paintedFrameCount(from, from + dur, ctx.fps) >= 2) {
      const base = 0.5 * size;
      const grow = Math.max(1, Math.min(1.7, (Math.min(cy - safe.y1, safe.y2 - cy) - 4) / base));
      pieces.push({
        ...ctx.shape(`hit${at}`, from, ellipsePath(0, 0, base), {
          x: [[from, cx]], y: [[from, cy]],
          sx: [[from, 0.55], [from + dur, grow, "out"]], sy: [[from, 0.55], [from + dur, grow, "out"]],
          o: [[from, 0.9], [from + dur, 0, "in"]],
        }),
        z: 1.5, toMs: from + dur, stroke: { colour: COOL, widthPx: 0.05 * size },
      });
    }
  }

  return pieces;
  });
}

/** The caption band, as shares of the canvas height around the anchor line (860-1650 px of a 1920 px frame at the default position). */
const BAND_UP = 460 / 1920;
const BAND_DOWN = 330 / 1920;

/** The band a cue's block is fitted into: moves with the anchor and the lane, grows with the user's size scale, stays in the safe area. */
function captionBand(input: Pick<SceneInput, "canvas">, space: SceneSpace, grow: number): Box {
  const { safe } = space;
  const ay = space.y(1320);
  return {
    x1: safe.x1 + 3, x2: safe.x2 - 3,
    y1: Math.max(safe.y1 + 3, ay - BAND_UP * input.canvas.height * grow),
    y2: Math.min(safe.y2 - 3, ay + BAND_DOWN * input.canvas.height * grow),
  };
}

const FACE_ID = /^combo:(\d+):w(\d+)(?:l\d+)?$/;
/** The lead and reading hold `galleryScene` uses to cut its windows. */
const LEAD = 80;
const HOLD = 150;

/** Cues on screen together (two speakers) read alike: the larger lane is drawn again at the smaller lane's body size. */
function sharedSize(input: SceneInput, scene: readonly Piece[], grow: number): Piece[] {
  const base = sceneSpace(input, 1320);
  const windows = speechWindows(input, base.safe, LEAD, HOLD);
  const bodyOf = (index: number) => {
    const cue = input.cues[index]!;
    const sizes = scene.flatMap((piece) => {
      const match = FACE_ID.exec(piece.id);
      return match && Number(match[1]) === index && piece.kind === "text" && cue.words[Number(match[2])]?.role !== "hero" ? [piece.sizePx] : [];
    });
    return sizes.length ? Math.min(...sizes) : undefined;
  };
  const overlap = (a: (typeof windows)[number], b: (typeof windows)[number]) => a.from < b.to && b.from < a.to;
  let result = [...scene];
  for (const window of windows) {
    const mine = bodyOf(window.index);
    if (mine === undefined) continue;
    const peers = windows.filter((other) => other !== window && other.lane !== window.lane && overlap(window, other));
    const target = Math.min(mine, ...peers.map((other) => bodyOf(other.index) ?? Number.POSITIVE_INFINITY));
    if (target >= mine * 0.98) continue;
    const redraw = comboCuesFor(grow).build({ ...input, scale: input.scale * (target / mine) }).pieces;
    const prefix = `combo:${window.index}:`;
    result = [...result.filter((piece) => !piece.id.startsWith(prefix)), ...redraw.filter((piece) => piece.id.startsWith(prefix))];
  }
  return result;
}

export const comboProgram: SceneProgram = {
  build(input) {
    const grow = Math.max(1, input.scale);
    return { pieces: sharedSize(input, comboCuesFor(grow).build(input).pieces, grow) };
  },
};

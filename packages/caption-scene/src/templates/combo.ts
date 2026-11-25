import type { DemoScript } from "../demo";
import { EASES, kf, lerp, prog } from "../ease";
import { SCENE_DEFAULT_FPS, paintedFrameCount } from "../frame-grid";
import { sampleFrames } from "../frames";
import type { SceneCue, SceneInput, SceneProgram } from "../input";
import { type SceneSpace, cueDirection, sceneSpace } from "../layout";
import type { Box, Frames, Piece, TextPiece } from "../scene";
import { ellipsePath, polygonPath } from "../shapes";
import { caps, galleryScene, rowsOf } from "./gallery-layout";
import { speechLaneSpace, speechWindows } from "./speech-layout";

/**
 * Combo (`samples/templates/m54-combo.js`): an arcade HUD driven by the speaker's delivery. Chunky Chakra Petch caps with a
 * red/cyan colour-split edge, a combo counter that climbs with every word of a breathless run and breaks on a pause, an XP
 * bar that fills a segment per word, and a critical hit (ring and shards) on the key word.
 *
 * What changed from the sample, and why:
 * - Rows come from the words, not a cue table: each key word sits on its own row and the words around it wrap into
 *   balanced rows (the sample's flex-wrap, shrunk to fit). Every key word of a cue lands as a critical hit, not only the
 *   first (a cue with two gets two rows, two rings, two fans).
 * - The key word's size fits its row (never below 1.15x the body) before the shared fit, so a long key word does not
 *   shrink the body; its 2.0x slam starts no wider than the safe area allows.
 * - The counter is derived from the speech the sample's way (words since the last pause of 500 ms), now per speaker, and
 *   it spans cues: every cue draws the counts of its own words, a run that goes on across a cue boundary is not broken
 *   or faded at the handoff, and the break (drop, spin, fade) plays only where the speech really pauses. Counts that
 *   would paint on one frame at fast speech are merged into the next, so the counter never flashes.
 * - The counter sits above the block (the sample's fixed place, raised when a tall block needs the room) and mirrors for
 *   right-to-left cues. Its blurred glow is dropped (libass blur costs every frame); the hard ink drop shadow stays.
 * - The ring and the shards are drawn behind every word (the sample's z order, made explicit) and each shard's flight is
 *   clamped to the safe area, so the burst never covers a word and never pushes the text smaller.
 * - Speech first: the first word of a cue enters with the cue's first painted frame (no empty frame between cues), the
 *   slam, pop and colour split compress into a short word's own time, and the row recentres as words arrive exactly as
 *   the sample's rows do.
 * - Extra recurring beats, all behind the words: a pulse ring on the counter at every fifth word of a run, a shine that
 *   sweeps the XP bar when its last segment fills (every cue), a small cyan ring on the last word of a cue that has no key
 *   word, and the critical-hit fan turns by a seeded amount and rotates its colours on every key word.
 * - Review fixes: the slam and pop are limited by the real clearance to the neighbouring rows and words (hero rows get
 *   a little extra air), so an entrance never covers a word; the counter stays anchored across a run (an eased slide between
 *   cues, never a jump), restarts at a pause or sentence-final punctuation, stops at x99 and caps its width; an overlong
 *   Latin, Cyrillic, Greek or CJK word breaks across rows at a readable floor instead of shrinking the block; and a window
 *   too short for the full beat still gets a compact ring, shards, hit ring and shine.
 * - Colours: white words, the highlight on key word, counter and filled segments, the accent as the ink outline and
 *   shadow (brand colours read on it), and the sample's pink and cyan split copies fixed.
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
const FACE = "Chakra Petch";
const S = 84;
const HERO = 130;
const COLUMN = 880;
const ROW_GAP = 0.12 * S;
const WORD_GAP = 0.3 * S;
const BAR_HEIGHT = 22;
const BAR_GAP = 8;
const BAR_MARGIN = 0.32 * S;
const SKEW = Math.tan((24 * Math.PI) / 180);
const COUNTER_SIZE = 148;
const BREAK = 260;
const LEAD_NEXT = 40;

interface RunWord {
  readonly n: number;
  readonly last: boolean;
  readonly breakAt: number;
  /** -1 for a run that starts in a right-to-left cue: the badge keeps one side for the whole run. */
  readonly side: number;
}

const runCache = new WeakMap<readonly SceneCue[], Map<string, RunWord>>();

/** A word that ends a sentence (. ? ! and the Hindi, Arabic and CJK stops, closing quotes allowed after it). */
const SENTENCE_END = /[.!?।؟。！？…]["'”’)\]]*$/u;

/** Per speaker, words since the last pause of 500 ms or more or the last sentence end, keyed `<cue>:<word>`. */
function runsOf(cues: readonly SceneCue[]): Map<string, RunWord> {
  const cached = runCache.get(cues);
  if (cached) return cached;
  const bySpeaker = new Map<number | null, { key: string; start: number; end: number; ends: boolean; side: number }[]>();
  cues.forEach((cue, ci) => {
    const list = bySpeaker.get(cue.speaker) ?? [];
    for (const [wi, word] of cue.words.entries()) list.push({ key: `${ci}:${wi}`, start: word.startMs, end: word.endMs, ends: SENTENCE_END.test(word.text.trim()), side: cueDirection(cue) === "rtl" ? -1 : 1 });
    bySpeaker.set(cue.speaker, list);
  });
  const runs = new Map<string, RunWord>();
  for (const list of bySpeaker.values()) {
    list.sort((a, b) => a.start - b.start);
    let run: typeof list = [];
    const flush = () => {
      for (const [at, word] of run.entries()) runs.set(word.key, { n: at + 1, last: at === run.length - 1, breakAt: run.at(-1)!.end, side: run[0]!.side });
      run = [];
    };
    for (const word of list) {
      const previous = run.at(-1);
      if (previous && word.start - previous.end >= 500) flush();
      run.push(word);
      if (word.ends) flush();
    }
    flush();
  }
  runCache.set(cues, runs);
  return runs;
}

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
  const slot = badgeSlot(ctx.input, ctx.space, grow);

  // Rows: the sample's line boxes (1.08 em, ink centred), then the XP bar under the widest row. Rows next to a key word
  // get a little more air so its slam has room.
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
    const barH = BAR_HEIGHT * u;
    const barMargin = BAR_MARGIN * u;
    const total = rowHeight.reduce((sum, h) => sum + h, 0) + gapAfter.slice(0, -1).reduce((sum, g) => sum + g, 0) + barMargin + barH;
    return { cells, u, rows, rowInk, rowHeight, gapAfter, barH, barMargin, total, k };
  };
  // The block lives in the caption band under the badge's reserved box: shrink it until it fits, then centre it there.
  const room = slot.band.y2 - slot.bottom;
  let shape = geometry(1);
  for (let tries = 0; tries < 3 && shape.total > room + 0.5; tries++) shape = geometry(Math.max(0.3, shape.k * (room / shape.total) * 0.98));
  const { cells, u, rows, rowInk, rowHeight, gapAfter, barH, barMargin, total } = shape;
  const blockTop = Math.min(Math.max(ctx.space.y(1320) - total / 2, slot.bottom), slot.band.y2 - total);
  const baselines: number[] = [];
  let y = blockTop;
  rows.forEach((_, r) => {
    baselines[r] = y + rowHeight[r]! / 2 - (rowInk[r]!.top + rowInk[r]!.bottom) / 2;
    y += rowHeight[r]! + gapAfter[r]!;
  });
  const barBottom = y - gapAfter.at(-1)! + barMargin + barH;
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
  const COPY = 0.12;
  const clearScale = (cell: (typeof cells)[number], peak: number): number => {
    const r = rowOfCell.get(cell.at)!;
    const outline = 0.05 * cell.size;
    const halfW = cell.width / 2 + outline;
    const halfH = (cell.inkBottom - cell.inkTop) / 2 + outline;
    const grow = (limit: number, half: number) => (limit + half) / (half + COPY * cell.size);
    const above = r > 0 ? baselines[r]! + cell.inkTop - Math.max(...rows[r - 1]!.map((other) => baselines[r - 1]! + other.inkBottom)) : baselines[r]! + cell.inkTop - (slot.bottom - 12 * slot.ub);
    const below = r < rows.length - 1 ? Math.min(...rows[r + 1]!.map((other) => baselines[r + 1]! + other.inkTop)) - (baselines[r]! + cell.inkBottom) : Infinity;
    // The row above and the XP bar are already on screen; the row below is spoken later, so it only gets half the gap.
    const bar = r === rows.length - 1 ? barBottom - barH - (baselines[r]! + cell.inkBottom) : Number.POSITIVE_INFINITY;
    const vertical = Math.min(above - 3, below / 2 - 1.5, bar - 3);
    const sideways = rows[r]!.filter((other) => other !== cell).map((other) => Math.abs(other.x - cell.x) - other.width / 2 - cell.width / 2);
    const across = sideways.length ? Math.min(...sideways) / 2 - 2 : Infinity;
    const edge = Math.min(cell.x - cell.width / 2 - safe.x1, safe.x2 - cell.x - cell.width / 2) - 12;
    return Math.max(1, Math.min(peak, grow(vertical, halfH), grow(across, halfW), grow(edge, halfW)));
  };

  const pieces: Piece[] = [];
  const cueFrom = enters[0]?.from ?? ctx.window.from;

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

  // XP bar: one parallelogram per word under the widest row, filled as each word is spoken.
  const widest = rows.map((row) => ({ x1: Math.min(...row.map((cell) => cell.x - cell.width / 2)), x2: Math.max(...row.map((cell) => cell.x + cell.width / 2)) }))
    .reduce((best, row) => (row.x2 - row.x1 > best.x2 - best.x1 ? row : best));
  const barW = widest.x2 - widest.x1;
  const n = cue.words.length;
  const segGap = BAR_GAP * u;
  const segW = Math.max(4 * u, (barW - segGap * (n - 1)) / n);
  const lean = SKEW * barH;
  const seg = [[-segW / 2, 0], [segW / 2, 0], [segW / 2 + lean, -barH], [-segW / 2 + lean, -barH]] as const;
  const segX = (i: number) => (widest.x1 + widest.x2) / 2 + side * (-barW / 2 + segW / 2 + i * (segW + segGap));
  cue.words.forEach((_, i) => {
    const { from } = enters[i]!;
    pieces.push({
      ...ctx.shape(`seg${i}`, cueFrom, polygonPath(seg), { x: [[cueFrom, segX(i)]], y: [[cueFrom, barBottom]] }),
      z: 2, fill: { colour: "#FFFFFF", alpha: 0.3 }, stroke: { colour: ink, widthPx: 3 * u, alpha: 0.55 },
    });
    const pop = Math.min(120, to - from);
    const grow: Frames = paintedFrameCount(from, from + pop, ctx.fps) >= 2 ? [[from, 1.7], [from + pop, 1, "out"]] : [[from, 1]];
    const flash = Math.min(70, pop);
    pieces.push({
      ...ctx.shape(`fill${i}`, from, polygonPath(seg), {
        x: [[from, segX(i)]], y: [[from, barBottom]], sx: [[from, 1]], sy: grow,
        colour: paintedFrameCount(from, from + flash, ctx.fps) >= 2 ? [[from, "#FFFFFF"], [from + flash, "#FFFFFF"], [from + flash + 1, c.highlight]] : [[from, c.highlight]],
      }, c.highlight),
      z: 3,
    });
  });
  // The shine: when the last segment fills, a thin light sweeps the bar (compressed into a short window, a static glint
  // when it cannot move).
  const lastFrom = enters[n - 1]?.from ?? cueFrom;
  const sweep = Math.min(280, to - lastFrom);
  if (n > 0 && paintedFrameCount(lastFrom, lastFrom + sweep, ctx.fps) >= 2) {
    const x1 = Math.min(segX(0), segX(n - 1)) - segW / 2;
    const x2 = Math.max(segX(0), segX(n - 1)) + segW / 2 + lean;
    const shineW = Math.max(6 * u, 0.1 * (x2 - x1));
    const shine = polygonPath([[-shineW / 2, 0], [shineW / 2, 0], [shineW / 2 + lean, -barH], [-shineW / 2 + lean, -barH]]);
    const [a, b] = side > 0 ? [x1 - shineW, x2 + shineW] : [x2 + shineW, x1 - shineW];
    const moves = paintedFrameCount(lastFrom, lastFrom + sweep, ctx.fps) >= 3;
    pieces.push({
      ...ctx.shape("shine", lastFrom, shine, {
        x: moves ? [[lastFrom, a], [lastFrom + sweep, b, "inOut"]] : [[lastFrom, (a + b) / 2]], y: [[lastFrom, barBottom]], o: [[lastFrom, 0.85]],
      }, "#FFFFFF"),
      z: 4, toMs: lastFrom + sweep,
      clip: { x1: [[lastFrom, x1]], x2: [[lastFrom, x2]], y1: [[lastFrom, barBottom - barH * 1.8]], y2: [[lastFrom, barBottom]] },
    });
  }

  return pieces;
  });
}

/** The caption band, as shares of the canvas height around the anchor line (860-1650 px of a 1920 px frame at the default position). */
const BAND_UP = 460 / 1920;
const BAND_DOWN = 330 / 1920;

interface BadgeSlot {
  readonly band: Box;
  /** The badge's unit: the canvas's, less when the band is too short to hold it above a block. */
  readonly ub: number;
  readonly u0: number;
  readonly baseline: number;
  /** Where the block may start: under the badge's reserved box. */
  readonly bottom: number;
  /** The pivot x of a left-to-right badge (its right end) and of a right-to-left one (its left end). */
  readonly right: number;
  readonly left: number;
}

/**
 * The badge's reserved box: one fixed slot at the top of the caption band (inside the lane for two speakers), clamped to the
 * safe area and following the anchor's x. Every cue fits its block into the band under it, so the badge never moves and no
 * word ever enters it. Computed from the canvas, the anchor and the lane only, never from the user's scale or a cue's fit.
 */
function badgeSlot(input: Pick<SceneInput, "canvas" | "anchor" | "measure">, space: SceneSpace, grow: number): BadgeSlot {
  const { canvas } = input;
  const { safe } = space;
  const u0 = Math.min(canvas.width, canvas.height) / 1080;
  const ay = space.y(1320);
  const band: Box = {
    x1: safe.x1 + 3, x2: safe.x2 - 3,
    y1: Math.max(safe.y1 + 3, ay - BAND_UP * canvas.height * grow),
    y2: Math.min(safe.y2 - 3, ay + BAND_DOWN * canvas.height * grow),
  };
  const ub = u0 * Math.min(1, (band.y2 - band.y1) / (700 * u0));
  // Resting ink top is 134 px above the baseline (digits, a 14 degree lean); a pop swings 70 px further, which stays in the safe area.
  const baseline = Math.max(band.y1 + 138 * ub, safe.y1 + 3 + 210 * ub);
  const lowest = Math.max(0, input.measure("×0", FACE, COUNTER_SIZE * ub, 0).inkBottom);
  const bottom = baseline + (6 + 24) * ub + lowest;
  const anchorX = (input.anchor.xPct / 100) * canvas.width;
  const reach = (215 * 1.5 + 0.32 * COUNTER_SIZE) * ub;
  const edge = 8 * ub;
  const right = Math.max(safe.x1 + reach + edge, Math.min(anchorX + (1000 - 540) * u0, safe.x2 - 0.32 * COUNTER_SIZE * ub - edge));
  const left = Math.min(safe.x2 - reach - edge, Math.max(anchorX - (1000 - 540) * u0, safe.x1 + 0.32 * COUNTER_SIZE * ub + edge));
  return { band, ub, u0, baseline, bottom, right, left };
}

const FACE_ID = /^combo:(\d+):w(\d+)(?:l\d+)?$/;
/** The lead and reading hold `galleryScene` uses to cut its windows. */
const LEAD = 80;
const HOLD = 150;

/**
 * The combo badge, drawn after the cues so that a cue's fit (its scale or its shift into the safe area) can never move it.
 * A run's badge ends on the frame the next badge of its lane starts, whatever a cue's reading hold did to its own window.
 */
function comboCounters(input: SceneInput, pieces: readonly Piece[], grow: number): Piece[] {
  const fps = input.fps ?? SCENE_DEFAULT_FPS;
  const base = sceneSpace(input, 1320);
  const times = new Map<string, { from: number; to: number }>();
  for (const piece of pieces) {
    const match = FACE_ID.exec(piece.id);
    if (!match) continue;
    const key = `${match[1]}:${match[2]}`;
    const known = times.get(key);
    times.set(key, { from: Math.min(known?.from ?? Number.POSITIVE_INFINITY, piece.fromMs), to: Math.max(known?.to ?? 0, piece.toMs) });
  }
  const runs = runsOf(input.cues);

  interface Entry {
    readonly lane: number;
    readonly index: number;
    readonly cue: SceneCue;
    readonly slot: BadgeSlot;
    readonly side: number;
    readonly span: { n: number; last: boolean; breakAt: number; wi: number; from: number; end: number };
  }
  const entries: Entry[] = [];
  for (const window of speechWindows(input, base.safe, LEAD, HOLD)) {
    const { cue, index } = window;
    const space = speechLaneSpace(base, window.bounds, 1320);
    const words = cue.words.map((_, wi) => ({ wi, info: runs.get(`${index}:${wi}`)!, ...times.get(`${index}:${wi}`)! })).filter((word) => word.info && word.from !== undefined);
    if (!words.length) continue;
    const to = Math.max(...words.map((word) => word.to));
    const slot = badgeSlot(input, space, grow);
    const side = words[0]!.info.side;
    const spans = words.map((word, at) => ({
      n: word.info.n, last: word.info.last, breakAt: word.info.breakAt, wi: word.wi, from: word.from,
      end: word.info.last ? Math.min(to, word.info.breakAt + BREAK, words[at + 1]?.from ?? Number.POSITIVE_INFINITY) : words[at + 1]?.from ?? to,
    }));
    // A count that would paint on a single frame is folded into the one before it (or skipped at the start).
    const kept: typeof spans = [];
    for (const span of spans) {
      if (paintedFrameCount(span.from, span.end, fps) < 2 && !span.last) {
        const previous = kept.at(-1);
        if (previous && !previous.last) previous.end = span.end;
        continue;
      }
      kept.push({ ...span });
    }
    for (const span of kept) entries.push({ lane: window.lane, index, cue, slot, side, span });
  }
  // One badge per lane at a time: each ends where the next one of its lane starts.
  const byLane = new Map<number, Entry[]>();
  for (const entry of entries) byLane.set(entry.lane, [...(byLane.get(entry.lane) ?? []), entry]);
  for (const list of byLane.values()) {
    list.sort((a, b) => a.span.from - b.span.from);
    list.forEach((entry, at) => {
      const next = list[at + 1];
      if (next && next.span.from < entry.span.end) entry.span.end = Math.max(entry.span.from, next.span.from);
    });
  }

  const out: Piece[] = [];
  for (const { index, cue, slot, side, span } of entries) {
    if (span.end <= span.from || paintedFrameCount(span.from, span.end, fps) < 2) continue;
    const { ub } = slot;
    const pivotX = side > 0 ? slot.right : slot.left;
    const text = `×${Math.min(99, span.n)}`;
    const size = COUNTER_SIZE * ub * Math.min(1, (215 * ub) / Math.max(1, input.measure(text, FACE, COUNTER_SIZE * ub, 0).advance));
    const m = input.measure(text, FACE, size, 0);
    const mid = (m.inkTop + m.inkBottom) / 2;
    const pop = Math.min(110, span.end - span.from);
    const animate = paintedFrameCount(span.from, span.from + pop, fps) >= 2;
    const breakDur = span.last ? Math.min(BREAK, span.end - span.breakAt) : 0;
    const breaks = span.last && paintedFrameCount(span.breakAt, span.breakAt + breakDur, fps) >= 2;
    const kick = span.n >= 10 ? 0.25 : 0.5;
    const popAt = (t: number) => (animate ? 1 - EASES.out(prog(t, span.from, pop)) : 0);
    const brokeAt = (t: number) => (breaks ? prog(t, span.breakAt, breakDur) : 0);
    const edges = [span.from, span.from + pop, span.breakAt, span.breakAt + breakDur];
    const frames = (fn: (t: number) => number, error: number) => sampleFrames(fn, edges, error, { range: [span.from, span.end], simplify: true });
    const scale = frames((t) => 1 + kick * popAt(t), 0.01);
    const id = `combo:${index}`;
    const piece: TextPiece = {
      id: `${id}:count${span.wi}`, kind: "text", z: 7, fromMs: span.from, toMs: span.end, text, face: FACE, sizePx: size, letterSpacingEm: 0,
      fill: span.n >= 10 ? HOT : input.colours.highlight, anchor: "baseline-center", language: cue.language,
      stroke: { colour: input.colours.accent, widthPx: 0.045 * size },
      shadows: [{ dx: 0, dy: 6 * ub, blur: 0, colour: input.colours.accent, alpha: 0.85 }],
      origin: { dx: (side * m.advance) / 2, dy: mid },
      track: {
        x: [[span.from, pivotX]], y: frames((t) => slot.baseline + mid + brokeAt(t) * 0.4 * S * 1.2 * ub, 0.2),
        sx: scale, sy: scale, skx: [[span.from, -14]],
        rz: frames((t) => side * (8 + 6 * popAt(t) + 22 * EASES.in(brokeAt(t))), 0.2),
        o: frames((t) => 1 - EASES.in(brokeAt(t)), 0.01),
      },
    };
    out.push(piece);
    // Every fifth word of a run: a pulse ring rings out behind the counter.
    if (span.n % 5 === 0 && span.n < 100 && animate) {
      const dur = Math.min(300, span.end - span.from);
      const centre = pivotX - (side * m.advance) / 2;
      const room = Math.min(centre - slot.band.x1, slot.band.x2 - centre, slot.baseline + mid - (slot.band.y1 - 60 * ub));
      const growTo = Math.max(1, Math.min(1.4, room / (0.55 * size)));
      out.push({
        id: `${id}:pulse${span.wi}`, kind: "shape", z: 1, fromMs: span.from, toMs: span.from + dur, path: ellipsePath(0, 0, 0.5 * size),
        stroke: { colour: HOT, widthPx: 0.05 * size },
        track: {
          x: [[span.from, centre]], y: [[span.from, slot.baseline + mid]],
          sx: [[span.from, 0.7], [span.from + dur, growTo, "out"]], sy: [[span.from, 0.7], [span.from + dur, growTo, "out"]],
          o: [[span.from, 1], [span.from + dur, 0, "in"]],
        },
      });
    }
  }
  return out;
}

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
    const cues = sharedSize(input, comboCuesFor(grow).build(input).pieces, grow);
    return { pieces: [...cues, ...comboCounters(input, cues, grow)] };
  },
};

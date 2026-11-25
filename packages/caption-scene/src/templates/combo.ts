import type { DemoScript } from "../demo";
import { EASES, kf, lerp, prog } from "../ease";
import { paintedFrameCount } from "../frame-grid";
import { sampleFrames } from "../frames";
import type { SceneCue } from "../input";
import type { Frames, Piece, ShapePiece, TextPiece } from "../scene";
import { ellipsePath, polygonPath } from "../shapes";
import { caps, galleryScene, rowsOf } from "./gallery-layout";

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
const COUNTER_BASELINE = 1110;
const BREAK = 260;
const LEAD_NEXT = 40;

interface RunWord {
  readonly n: number;
  readonly last: boolean;
  readonly breakAt: number;
}

const runCache = new WeakMap<readonly SceneCue[], Map<string, RunWord>>();

/** Per speaker, words since the last pause of 500 ms or more (the sample's runs), keyed `<cue>:<word>`. */
function runsOf(cues: readonly SceneCue[]): Map<string, RunWord> {
  const cached = runCache.get(cues);
  if (cached) return cached;
  const bySpeaker = new Map<number | null, { key: string; start: number; end: number }[]>();
  cues.forEach((cue, ci) => {
    const list = bySpeaker.get(cue.speaker) ?? [];
    for (const [wi, word] of cue.words.entries()) list.push({ key: `${ci}:${wi}`, start: word.startMs, end: word.endMs });
    bySpeaker.set(cue.speaker, list);
  });
  const runs = new Map<string, RunWord>();
  for (const list of bySpeaker.values()) {
    list.sort((a, b) => a.start - b.start);
    let run: typeof list = [];
    const flush = () => {
      for (const [at, word] of run.entries()) runs.set(word.key, { n: at + 1, last: at === run.length - 1, breakAt: run.at(-1)!.end });
      run = [];
    };
    for (const word of list) {
      const previous = run.at(-1);
      if (previous && word.start - previous.end >= 500) flush();
      run.push(word);
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

export const comboProgram = galleryScene("combo", 1320, (ctx) => {
  const { cue, index, to } = ctx.window;
  const { safe } = ctx.space;
  const c = ctx.input.colours;
  const ink = c.accent;
  const side = ctx.side;
  const heroAt = new Set(cue.words.flatMap((word, at) => (word.role === "hero" ? [at] : [])));
  const heroSize = (at: number) => {
    const advance = ctx.input.measure(caps(cue.words[at]!, cue), FACE, 100, 0).advance;
    return Math.max(S * 1.15, Math.min(HERO, (COLUMN - 30) * 100 / Math.max(1, advance)));
  };
  const groups: number[][] = [];
  cue.words.forEach((_, at) => {
    if (heroAt.has(at) || !groups.length || heroAt.has(at - 1)) groups.push([at]);
    else groups.at(-1)!.push(at);
  });
  const { cells, unit: u } = ctx.layout({
    column: COLUMN, gap: WORD_GAP, padding: 50, groups,
    words: cue.words.map((word, at) => ({ text: caps(word, cue), face: FACE, size: heroAt.has(at) ? heroSize(at) : S, spacing: 0 })),
  });

  // Rows: the sample's line boxes (1.08 em, ink centred), then the XP bar under the widest row.
  const rows = rowsOf(cells);
  const rowSize = rows.map((row) => Math.max(...row.map((cell) => cell.size)));
  const rowInk = rows.map((row) => ({ top: Math.min(...row.map((cell) => cell.inkTop)), bottom: Math.max(...row.map((cell) => cell.inkBottom)) }));
  const rowHeight = rows.map((_, r) => Math.max(1.08 * rowSize[r]!, rowInk[r]!.bottom - rowInk[r]!.top + 0.2 * rowSize[r]!));
  const gap = ROW_GAP * u;
  const barH = BAR_HEIGHT * u;
  const barMargin = BAR_MARGIN * u;
  const total = rowHeight.reduce((sum, h) => sum + h, 0) + gap * (rows.length - 1) + barMargin + barH;
  const blockTop = ctx.space.y(1320) - total / 2;
  const baselines: number[] = [];
  let y = blockTop;
  rows.forEach((_, r) => {
    baselines[r] = y + rowHeight[r]! / 2 - (rowInk[r]!.top + rowInk[r]!.bottom) / 2;
    y += rowHeight[r]! + gap;
  });
  const barBottom = y - gap + barMargin + barH;
  const rowOfCell = new Map(rows.flatMap((row, r) => row.map((cell) => [cell.at, r] as const)));

  // Entrances: each word is locked to its speech; the cue's first word enters with the cue's first frame.
  const enters = cue.words.map((word, at) => ctx.enter(word, heroAt.has(at) ? 150 : 110, at === 0 ? 80 : LEAD_NEXT));
  const ARRIVE = 150;
  // The row recentres as its words arrive: all words of a row share one shift.
  const shifts = rows.map((row) => {
    const spoken = [...row].sort((a, b) => a.at - b.at);
    const full = spoken.reduce((sum, cell, i) => sum + cell.width + (i ? WORD_GAP * u : 0), 0);
    const edges = spoken.flatMap((cell) => [enters[cell.at]!.from, enters[cell.at]!.from + ARRIVE]);
    const fn = (t: number) => {
      if (spoken.length === 1) return 0;
      let shown = 0;
      spoken.forEach((cell, i) => {
        shown += EASES.out(prog(t, enters[cell.at]!.from, ARRIVE)) * (cell.width + (i ? WORD_GAP * u : 0));
      });
      return side * (full - shown) / 2;
    };
    return { fn, edges, end: Math.max(...edges) };
  });

  const pieces: Piece[] = [];
  const cueFrom = enters[0]?.from ?? ctx.window.from;

  cells.forEach((cell) => {
    const at = cell.at;
    const word = cue.words[at]!;
    const hero = heroAt.has(at);
    const r = rowOfCell.get(at)!;
    const { from, settled, motion } = enters[at]!;
    const shift = shifts[r]!;
    const centreY = baselines[r]! + (cell.inkTop + cell.inkBottom) / 2;
    const k = motion ? (settled - from) / (hero ? 150 : 110) : 1;
    const burst = Math.min(1, ((to - from) / 360));

    // The slam: the key word drops in at up to 2x, undershoots, settles. Body words pop from 1.3x.
    // The slam and pop start as large as the room beside the word allows: the colour-split copies reach 0.12 em further at the peak.
    const room = Math.min(cell.x - cell.width / 2 - safe.x1, safe.x2 - cell.x - cell.width / 2) - 6;
    const reachFor = (peak: number) => Math.max(1, Math.min(peak, 1 + (2 * (room - 0.17 * peak * cell.size)) / cell.width));
    const wide = hero ? Math.min(reachFor(2), Math.max(1, (safe.x2 - safe.x1 - 8) / (cell.width + 0.34 * cell.size))) : reachFor(1.3);
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

    for (const [name, fill, [dx, dy]] of [["h", HOT, [1, 1]], ["k", COOL, [-1, -0.6]]] as const) {
      pieces.push({
        ...ctx.face(cell, from, fill, { ...positions(dx, dy), sx: scaleFrames, sy: scaleFrames }),
        id: `${ctx.id}:w${at}${name}`, z: 5, origin, stroke: { colour: fill, widthPx: outline },
      });
    }
    const face = ctx.face(cell, from, hero ? c.highlight : c.primary, { ...positions(0, 0), sx: scaleFrames, sy: scaleFrames });
    pieces.push({ ...face, origin, stroke: { colour: ink, widthPx: outline } });

    if (hero && motion) {
      // The critical hit: a ring and a fan of shards, behind every word.
      const size = cell.size;
      const h = seeded(index, at, word.text);
      const reach = (ox: number, oy: number) => Math.min(cell.x - safe.x1 + ox, safe.x2 - cell.x + ox, centreY - safe.y1 + oy, safe.y2 - centreY + oy);
      const ringBase = 0.6 * size;
      const ringTo = Math.max(1, Math.min(2.1, (reach(-6, -6) - 0.035 * size) / ringBase));
      const ringStroke = 0.07 * size;
      const ringEnd = Math.min(to, from + 340 * burst);
      pieces.push({
        ...ctx.shape(`ring${at}`, from, ellipsePath(0, 0, ringBase - ringStroke / 2), {
          x: [[from, cell.x + shift.fn(from)]], y: [[from, centreY]],
          sx: [[from, 0.5], [from + 340 * burst, ringTo, "out"]], sy: [[from, 0.5], [from + 340 * burst, ringTo, "out"]],
          o: [[from, 1], [from + 60 * burst, 1], [from + 340 * burst, 0]],
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
          Math.cos(rad) > 0 ? (safe.x2 - 6 - len / 2 - cell.x) / Math.cos(rad) : Math.cos(rad) < 0 ? (cell.x - safe.x1 - 6 - len / 2) / -Math.cos(rad) : Infinity,
          Math.sin(rad) > 0 ? (safe.y2 - 6 - len / 2 - centreY) / Math.sin(rad) : Math.sin(rad) < 0 ? (centreY - safe.y1 - 6 - len / 2) / -Math.sin(rad) : Infinity,
        );
        const d = Math.max(0, Math.min(dist, room));
        const start = from + 20 * burst;
        const flight = (t: number) => EASES.out(prog(t, start, 260 * burst));
        const frames = (fn: (t: number) => number) => sampleFrames(fn, [start, start + 260 * burst, from + 120 * burst, from + 340 * burst], 0.05, { range: [start, Math.min(to, start + 320 * burst)], simplify: true });
        pieces.push({
          ...ctx.shape(`shard${at}-${i}`, start, polygonPath([[-len / 2, 0], [len / 2, -len * 0.3], [len / 2, len * 0.3]]), {
            x: frames((t) => cell.x + shift.fn(from) + Math.cos(rad) * d * flight(t)),
            y: frames((t) => centreY + Math.sin(rad) * d * flight(t)),
            rz: frames((t) => angle + turn + flight(t) * 180),
            sx: frames((t) => s * (1 - 0.35 * flight(t))), sy: frames((t) => s * (1 - 0.35 * flight(t))),
            o: frames((t) => 1 - EASES.in(prog(t, from + 120 * burst, 220 * burst))),
          }, palette[(i + h) % palette.length]!),
          z: 1.5, toMs: Math.min(to, start + 320 * burst), stroke: { colour: ink, widthPx: 0.025 * size },
        });
      });
    }
  });

  // No key word: the last word of the cue lands a small cyan hit ring, behind the words.
  if (heroAt.size === 0 && cells.length) {
    const cell = cells.find((candidate) => candidate.at === cue.words.length - 1)!;
    const { from, motion } = enters[cell.at]!;
    const r = rowOfCell.get(cell.at)!;
    const dur = Math.min(280, to - from);
    if (motion && dur >= 100) {
      const centreY = baselines[r]! + (cell.inkTop + cell.inkBottom) / 2;
      const base = 0.5 * cell.size;
      const grow = Math.max(1, Math.min(1.7, (Math.min(centreY - safe.y1, safe.y2 - centreY) - 4) / base));
      pieces.push({
        ...ctx.shape(`hit${cell.at}`, from, ellipsePath(0, 0, base), {
          x: [[from, cell.x + shifts[r]!.fn(from)]], y: [[from, centreY]],
          sx: [[from, 0.55], [from + dur, grow, "out"]], sy: [[from, 0.55], [from + dur, grow, "out"]],
          o: [[from, 0.9], [from + dur, 0, "in"]],
        }),
        z: 1.5, toMs: from + dur, stroke: { colour: COOL, widthPx: 0.05 * cell.size },
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
  // The shine: when the last segment fills, a thin light sweeps the bar.
  const lastFrom = enters[n - 1]?.from ?? cueFrom;
  const sweep = Math.min(280, to - lastFrom);
  if (n > 0 && sweep >= 100) {
    const x1 = Math.min(segX(0), segX(n - 1)) - segW / 2;
    const x2 = Math.max(segX(0), segX(n - 1)) + segW / 2 + lean;
    const shineW = Math.max(6 * u, 0.1 * (x2 - x1));
    const shine = polygonPath([[-shineW / 2, 0], [shineW / 2, 0], [shineW / 2 + lean, -barH], [-shineW / 2 + lean, -barH]]);
    const [a, b] = side > 0 ? [x1 - shineW, x2 + shineW] : [x2 + shineW, x1 - shineW];
    pieces.push({
      ...ctx.shape("shine", lastFrom, shine, { x: [[lastFrom, a], [lastFrom + sweep, b, "inOut"]], y: [[lastFrom, barBottom]], o: [[lastFrom, 0.85]] }, "#FFFFFF"),
      z: 4, toMs: lastFrom + sweep,
      clip: { x1: [[lastFrom, x1]], x2: [[lastFrom, x2]], y1: [[lastFrom, barBottom - barH * 1.8]], y2: [[lastFrom, barBottom]] },
    });
  }

  pieces.push(...counterPieces());
  return pieces;

  /** The combo counter: the count of each word of this cue's run, held until the next count, then the break. */
  function counterPieces(): Piece[] {
    const runs = runsOf(ctx.input.cues);
    const spans = cue.words.map((_, wi) => {
      const info = runs.get(`${index}:${wi}`)!;
      const next = enters[wi + 1]?.from;
      return { ...info, wi, from: enters[wi]!.from, end: info.last ? Math.min(to, info.breakAt + BREAK, next ?? Infinity) : next ?? to };
    });
    // A count that would paint on a single frame is folded into the one before it (or skipped at the start).
    const kept: typeof spans = [];
    for (const span of spans) {
      if (paintedFrameCount(span.from, span.end, ctx.fps) < 2 && !span.last) {
        const previous = kept.at(-1);
        if (previous && !previous.last) previous.end = span.end;
        continue;
      }
      kept.push({ ...span });
    }
    const size = COUNTER_SIZE * u;
    // The pop grows the counter 1.5x about its middle: its lowest ink, shadow and all, stays above the first row.
    const lowest = Math.max(0, ctx.input.measure("×0", FACE, size, 0).inkBottom);
    const baseline = Math.min(ctx.space.y(COUNTER_BASELINE), blockTop - 34 * u - 1.5 * lowest);
    const cx = ctx.space.x(540);
    const right = Math.min(ctx.space.x(1000), safe.x2 - 30 * u);
    const pivotX = side > 0 ? right : 2 * cx - right;
    const out: Piece[] = [];
    for (const span of kept) {
      const text = `×${span.n}`;
      const m = ctx.input.measure(text, FACE, size, 0);
      const mid = (m.inkTop + m.inkBottom) / 2;
      const pop = Math.min(110, span.end - span.from);
      const animate = paintedFrameCount(span.from, span.from + pop, ctx.fps) >= 2;
      const breakDur = span.last ? Math.min(BREAK, span.end - span.breakAt) : 0;
      const breaks = span.last && paintedFrameCount(span.breakAt, span.breakAt + breakDur, ctx.fps) >= 2;
      const popAt = (t: number) => (animate ? 1 - EASES.out(prog(t, span.from, pop)) : 0);
      const brokeAt = (t: number) => (breaks ? prog(t, span.breakAt, breakDur) : 0);
      const edges = [span.from, span.from + pop, span.breakAt, span.breakAt + breakDur];
      const frames = (fn: (t: number) => number, error: number) => sampleFrames(fn, edges, error, { range: [span.from, span.end], simplify: true });
      const scale = frames((t) => 1 + 0.5 * popAt(t), 0.01);
      const piece: TextPiece = {
        id: `${ctx.id}:count${span.wi}`, kind: "text", z: 7, fromMs: span.from, toMs: span.end, text, face: FACE, sizePx: size, letterSpacingEm: 0,
        fill: span.n >= 10 ? HOT : c.highlight, anchor: "baseline-center", language: cue.language,
        stroke: { colour: ink, widthPx: 0.045 * size },
        shadows: [{ dx: 0, dy: 6 * u, blur: 0, colour: ink, alpha: 0.85 }],
        origin: { dx: (side * m.advance) / 2, dy: mid },
        track: {
          x: [[span.from, pivotX]], y: frames((t) => baseline + mid + brokeAt(t) * 0.4 * S * 1.2 * u, 0.2),
          sx: scale, sy: scale, skx: [[span.from, -14]],
          rz: frames((t) => side * (8 + 6 * popAt(t) + 22 * EASES.in(brokeAt(t))), 0.2),
          o: frames((t) => 1 - EASES.in(brokeAt(t)), 0.01),
        },
      };
      out.push(piece);
      // Every fifth word of a run: a pulse ring rings out behind the counter.
      if (span.n % 5 === 0 && animate) {
        const dur = Math.min(300, span.end - span.from);
        const centre = pivotX - (side * m.advance) / 2;
        const grow = Math.max(1, Math.min(1.4, (centre - safe.x1 - 4) / (0.55 * size), (safe.x2 - 4 - centre) / (0.55 * size)));
        const ring: ShapePiece = {
          ...ctx.shape(`pulse${span.wi}`, span.from, ellipsePath(0, 0, 0.5 * size), {
            x: [[span.from, centre]], y: [[span.from, baseline + mid]],
            sx: [[span.from, 0.7], [span.from + dur, grow, "out"]], sy: [[span.from, 0.7], [span.from + dur, grow, "out"]],
            o: [[span.from, 1], [span.from + dur, 0, "in"]],
          }),
          z: 1, toMs: span.from + dur, stroke: { colour: HOT, widthPx: 0.05 * size },
        };
        out.push(ring);
      }
    }
    return out;
  }
});

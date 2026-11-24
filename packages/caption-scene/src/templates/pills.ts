import type { DemoScript } from "../demo";
import { clamp, EASES, lerp, prog } from "../ease";
import { exportFrameAtOrBefore, paintedFrameCount } from "../frame-grid";
import { sampleFrames } from "../frames";
import type { Piece } from "../scene";
import { polylinePath } from "../shapes";
import { galleryScene, roleRows, rotatePoint, rowsOf } from "./gallery-layout";

export const PILLS_DEMO: DemoScript = {
  lines: ["nobody:b is:m coming:b to:m save:b you", "so:m build:h@560", "before:b you:m feel:b ready:h@620", "today:b@560", "not:m someday:b", "the:m work:b gets:b easier:h@640"],
  options: { rate: 255, cueGap: 150, tail: 760 },
};

export const pillsProgram = galleryScene("pills", 1290, (ctx) => {
  const { cue, spokenEnd, from: cueFrom, to } = ctx.window;
  const c = ctx.input.colours;
  const heroAt = cue.words.reduce((last, word, at) => word.role === "hero" ? at : last, -1);
  const hasHero = heroAt >= 0;
  const few = !hasHero && cue.words.length <= 2;
  const { cells, unit: u } = ctx.layout({
    column: 738, padding: 89, gap: few ? 138 : 98, groups: roleRows(cue, 3),
    words: cue.words.map((word) => ({ text: word.text, size: word.role === "hero" ? 104 : few ? 92 : 64,
      face: word.role === "hero" ? "Manrope ExtraBold" : "Manrope Bold", spacing: -0.01 })),
  });
  const rows = rowsOf(cells);
  const heightOf = (at: number, ink: number) => Math.max((cue.words[at]!.role === "hero" ? 160 : few ? 142 : 112) * u, ink + 24 * u);
  const heights = rows.map((row) => Math.max(...row.map((cell) =>
    heightOf(cell.at, cell.inkBottom - cell.inkTop) + (cue.words[cell.at]!.role === "hero" ? 20 * u : 0))));
  const gap = 20 * u;
  const total = heights.reduce((sum, height) => sum + height, (rows.length - 1) * gap);
  const cx = ctx.space.x(540);
  const anchor = ctx.space.y(1290);
  let top = anchor - total / 2;
  const centres = new Map<number, number>();
  rows.forEach((row, i) => {
    for (const { at } of row) centres.set(at, top + heights[i]! / 2);
    top += heights[i]! + gap;
  });
  const holdUntil = spokenEnd + 150;
  // Leave the demo's quiet beat before the cut when there is time for it after the speech hold.
  const toWithClear = to - 90;
  const endAt = paintedFrameCount(holdUntil, toWithClear, ctx.fps) >= 2 ? toWithClear : to;
  const exitAt = Math.max(holdUntil, endAt - 150);
  const hasExit = paintedFrameCount(exitAt, endAt, ctx.fps) >= 2;
  const out = (t: number) => hasExit ? EASES.in(prog(t, exitAt, endAt - exitAt)) : 0;
  const blockScale = (t: number) => 1 - 0.07 * out(t);
  const floodStarts = cue.words.map((word, at) => Math.max(word.startMs - 55, cue.words[at - 1]?.startMs ?? 0));
  const pieces: Piece[] = [];
  for (const cell of cells) {
    const word = cue.words[cell.at]!;
    const hero = word.role === "hero";
    const cy = centres.get(cell.at)!;
    const popAt = Math.min(ctx.window.start - 100 + cell.at * 38, word.startMs - 60);
    const from = Math.max(cueFrom, popAt);
    const pop = (t: number) => prog(t, popAt, 300);
    const near = (t: number) => prog(t, word.startMs - 40, 340);
    const dir = (cell.at % 2 ? 1 : -1) * ctx.side;
    const tilt = hero ? -5 * ctx.side : hasHero ? 1.6 * dir : 0;
    const rotation = (t: number) => tilt + (1 - EASES.out(pop(t))) * dir * 16;
    const scale = (t: number) => {
      const p = pop(t) - 1;
      const opened = lerp(0.45, 1, 1 + 3.1 * p ** 3 + 2.1 * p ** 2);
      const stamp = hero ? 1 + 0.1 * Math.sin(Math.PI * near(t)) : 1;
      return opened * stamp * blockScale(t);
    };
    const alpha = (t: number) => clamp(pop(t) * 5) * (1 - out(t));
    const x = (t: number) => cx + (cell.x - cx) * blockScale(t);
    const y = (t: number) => anchor + (cy - anchor) * blockScale(t);
    const floodAt = floodStarts[cell.at]!;
    const floodEnd = Math.min(floodAt + 150, Math.max(word.startMs, exportFrameAtOrBefore(word.endMs - 1, ctx.fps)));
    const flood = (t: number) => EASES.out(prog(t, floodAt, floodEnd - floodAt));
    const releaseAt = hero ? endAt : floodStarts[cell.at + 1] ?? endAt;
    const release = (t: number) => EASES.inOut(prog(t, releaseAt, 160));
    const keys = [popAt + 60, popAt + 300, word.startMs - 40, word.startMs + 300, floodAt, floodEnd, releaseAt, releaseAt + 160, exitAt];
    const frames = (fn: (t: number) => number, error: number, a = from, b = endAt, extra: number[] = []) =>
      sampleFrames(fn, [...keys, ...extra], error, { range: [a, b], simplify: true });
    const s = frames(scale, 0.003);
    const pose = { x: frames(x, 0.15), y: frames(y, 0.15), rz: frames(rotation, 0.12), sx: s, sy: s, o: frames(alpha, 0.004) };
    const colour = hero ? c.highlight : c.primary;
    const inkHeight = cell.inkBottom - cell.inkTop;
    const h = heightOf(cell.at, inkHeight);
    const border = (hero ? 6 : 5) * u;
    const w = Math.max(h, cell.width + (hero ? 120 : few ? 112 : 72) * u + 2 * border);
    pieces.push({ ...ctx.rect(`outline${cell.at}`, from, cell.x, cy, w - border, h - border, (h - border) / 2, "#08080C", pose), toMs: endAt,
      fill: { colour: "#08080C", alpha: 0.55 }, stroke: { colour, widthPx: border } });
    const origin = { dx: 0, dy: (cell.inkTop + cell.inkBottom) / 2 };
    const base = ctx.face(cell, from, c.primary, { ...pose, o: frames((t) => alpha(t) * lerp(0.5, 1, flood(t)), 0.004) });
    pieces.push({ ...base, z: 3, origin, toMs: endAt });

    const fillFrom = Math.max(from, floodAt);
    const fillTo = Math.min(endAt, releaseAt + 160);
    const fillFrames = (fn: (t: number) => number) => frames(fn, 0.12, fillFrom, fillTo);
    const leading = (t: number) => (release(t) - 0.5) * w * ctx.side;
    const trailing = (t: number) => (Math.max(flood(t), release(t)) - 0.5) * w * ctx.side;
    // The fill stays the full size of the pill. A rounded, pill-local mask sweeps across both the fill and its ink.
    const clip = {
      x1: fillFrames(ctx.rtl ? trailing : leading),
      x2: fillFrames(ctx.rtl ? leading : trailing),
      y1: [[fillFrom, -h / 2]] as const,
      y2: [[fillFrom, h / 2]] as const,
      radius: h / 2,
    };
    pieces.push({ ...ctx.rect(`fill${cell.at}`, fillFrom, cell.x, cy, w, h, h / 2, colour, pose), z: 4, clip, toMs: fillTo });
    const face = ctx.face(cell, fillFrom, c.accent, pose);
    pieces.push({ ...face, id: `${face.id}flood`, origin, clip, toMs: fillTo });

    if (cell.at !== heroAt) continue;
    const decoration = (at: number, duration: number, turn: number, dx: number, dy: number) => {
      const start = Math.max(from, at);
      const progress = (t: number) => prog(t, at, duration);
      const position = (t: number) => rotatePoint(dx * scale(t), dy * scale(t), rotation(t));
      const sample = (fn: (t: number) => number, error: number) => frames(fn, error, start, endAt, [at + duration / 6, at + duration]);
      const size = sample((t) => scale(t) * EASES.spring(progress(t)), 0.003);
      return {
        start,
        track: { x: sample((t) => x(t) + position(t)[0], 0.15), y: sample((t) => y(t) + position(t)[1], 0.15), sx: size, sy: size,
          rz: sample((t) => rotation(t) + turn * (1 - EASES.out(progress(t))) * ctx.side, 0.12),
          o: sample((t) => alpha(t) * clamp(progress(t) * 6), 0.004) },
      };
    };
    const star = decoration(word.startMs - 20, 380, -90, (w / 2 + 30 * u) * ctx.side, h * 0.1);
    for (let a = 0; a < 4; a++) {
      const rz = star.track.rz.map(([t, angle]) => [t, angle + 45 * a] as const);
      pieces.push({ ...ctx.rect(`star${cell.at}-${a}`, star.start, cell.x, cy, 84 * u, 14 * u, 7 * u, c.primary, { ...star.track, rz }), toMs: endAt, z: 8 });
    }
    if (word.startMs + 90 >= endAt) continue;
    const arrow = decoration(word.startMs + 90, 360, -40, -(w / 2 - 26 * u) * ctx.side, h / 2 + 4 * u);
    const stroke = { colour: c.primary, widthPx: 7.4 * u };
    pieces.push({ ...ctx.dot(`ring${cell.at}`, arrow.start, cell.x, cy, 39 * u, "#08080C"), track: arrow.track, toMs: endAt,
      fill: { colour: "#08080C", alpha: 0.55 }, stroke, z: 8 });
    const rz = arrow.track.rz.map(([t, angle]) => [t, angle - 45 * ctx.side] as const);
    pieces.push({ ...ctx.shape(`arrow${cell.at}`, arrow.start,
      polylinePath([[-14 * u, 0], [14 * u, 0], [3 * u, -11 * u], [14 * u, 0], [3 * u, 11 * u]]),
      { ...arrow.track, rz }), toMs: endAt, stroke, z: 9 });
  }
  return pieces;
});

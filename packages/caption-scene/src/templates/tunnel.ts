import type { DemoScript } from "../demo";
import { EASES, clamp, lerp, prog } from "../ease";
import { sampleFrames } from "../frames";
import type { Piece, PathCmd, TextPiece } from "../scene";
import { balancedRows } from "../layout";
import { galleryScene, rowsOf } from "./gallery-layout";

/**
 * Tunnel (`samples/templates/m64-tunnel.js`, gallery 5): a cue flies in from deep behind the last one, small, blurred and
 * dim, and snaps into place; words appear as they are spoken and the stack re-centres around what is visible; the key word
 * lands in acid lime with a spring overshoot; the cue leaves by zooming through the camera.
 *
 * Changes from the sample, and why:
 * - **No rushing frames (owner, 2026-11-25).** The three rounded white frames that rush past are gone; nothing box-shaped is
 *   drawn. Their sense of speed is replaced by thin speed streaks that radiate from the vanishing point around the block as
 *   every cue arrives (fatter and brighter at the far end, they accelerate outward), and by short lime speed dashes that
 *   shoot out beside the key word (white beside the last word of a cue with no key word).
 * - **The exit waits for the speech.** The sample starts the zoom 230 ms before the cue's end, so the last word is already
 *   fading while it is spoken. Here it starts once the last word has been readable for 150 ms, and it is the visible part of
 *   the sample's exit only (the sample's zoom to 2.5x happens at opacity 0): a blur-dissolve with a zoom as far as the safe
 *   area allows (at most 1.28x). When the next cue arrives sooner the exit is compressed, then dropped (a hard cut): the
 *   outgoing cue always gives way, so it never covers the incoming words (cue handoff rule).
 * - **The arrival is locked to speech.** The cue's depth fly-in (0.3x to 1x, outExpo) is shortened for fast first words so
 *   the first word is at full size by its spoken end; every word's fade and pop are compressed into its own time.
 * - **Rows come from the words, fitted.** The sample bakes nothing per cue index; sizes are the sample's (104 body, x0.82
 *   minor, x1.42 for a cue with no key word, key word up to 280 fitted to 860) and rows wrap at 760 (balanced); a cue wider
 *   or taller than the safe area shrinks as a whole. A second key word gets its own row like the first.
 * - **Continuous re-centring.** The stack slides to its new centre with a 300 ms outExpo ease as in the sample, but each slide
 *   starts from where the word actually is, so fast speech never jumps.
 * - **Cheap text shadow.** The sample's two drop shadows become one centred black halo (blur and alpha only).
 * - Speed streaks and dashes vary by a hash of the cue (count, angle offset, lengths); every fourth streak of a key-word cue is lime.
 */
export const TUNNEL_DEMO: DemoScript = {
  lines: [
    "most:m people:b quit:b",
    "right:m before:m the:m breakthrough:h@720",
    "so:m keep:b going:b",
    "deeper:h@640 every:b day:b",
    "that's:m how:m you:m win:h@620",
  ],
  options: { rate: 270, cueGap: 150, tail: 850, lead: 380 },
};

const FACE: TextPiece["face"] = "Bricolage Grotesque";
const SPACING = -0.02;
const BODY = 104;
const HERO_MAX = 280;
const MAX_ROW = 760;
const HERO_ROW = 860;
const SLIDE = 300;
const WORD_LEAD = 70;
const ZOOM_MAX = 1.28;

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** A deterministic 0..1 from a cue key and a salt. */
const rand = (key: number, salt: number) => hash(`${key}:${salt}`) / 4294967296;

export const tunnelProgram = galleryScene("tunnel", 1290, (ctx) => {
  const { cue, index, to } = ctx.window;
  const c = ctx.input.colours;
  const measure = ctx.input.measure;
  const hasHero = cue.words.some((word) => word.role === "hero");
  const body = hasHero ? BODY : BODY * 1.42;
  const gapSample = body * 0.24;

  // Sample-px sizes: key word fitted to 860, the rest to 760, as the sample does.
  const width100 = cue.words.map((word) => measure(word.text, FACE, 100, SPACING).advance);
  const sizes = cue.words.map((word, at) => {
    const natural = word.role === "hero" ? HERO_MAX : word.role === "minor" ? body * 0.82 : body;
    return Math.min(natural, ((word.role === "hero" ? HERO_ROW : MAX_ROW) / Math.max(1, width100[at]!)) * 100);
  });
  const widths = sizes.map((size, at) => (width100[at]! * size) / 100);
  // Key words stand alone; the words between them wrap into balanced rows of at most 760.
  const groups: number[][] = [];
  let run: number[] = [];
  const flush = () => {
    for (const row of balancedRows(run.map((at) => widths[at]!), gapSample, MAX_ROW)) groups.push(row.map((k) => run[k]!));
    run = [];
  };
  cue.words.forEach((word, at) => {
    if (word.role === "hero") {
      flush();
      groups.push([at]);
    } else run.push(at);
  });
  flush();

  const { cells, unit: u } = ctx.layout({
    column: HERO_ROW, gap: gapSample, padding: 30, groups,
    words: cue.words.map((word, at) => ({ text: word.text, face: FACE, size: sizes[at]!, spacing: SPACING })),
  });
  const rows = rowsOf(cells);
  const cellAt = new Map(cells.map((cell) => [cell.at, cell]));
  const rowOfWord = new Map<number, number>();
  rows.forEach((row, r) => { for (const cell of row) rowOfWord.set(cell.at, r); });
  const rowSize = rows.map((row) => Math.max(...row.map((cell) => cell.size)));
  const gapPx = gapSample * u;
  const pitch = 4 * u;
  const metric = cells.map((cell) => {
    const m = measure(cell.text, cell.face, cell.size, cell.spacing);
    return { at: cell.at, top: m.inkTop, bottom: m.inkBottom, mid: (m.inkTop + m.inkBottom) / 2, lift: 0.03 * cell.size + (m.ascent - m.descent) / 2 };
  });
  const metricAt = new Map(metric.map((m) => [m.at, m]));

  // How far a row's ink reaches above and below its centre line (never less than half its size, as the sample's 1 em box).
  const reach = rows.map((row, r) => ({
    up: Math.max(rowSize[r]! / 2, ...row.map((cell) => -(metricAt.get(cell.at)!.lift + metricAt.get(cell.at)!.top))),
    down: Math.max(rowSize[r]! / 2, ...row.map((cell) => metricAt.get(cell.at)!.lift + metricAt.get(cell.at)!.bottom)),
  }));
  // The visible stack after word k has appeared, centred on (0, 0): pivot offsets of every word spoken so far.
  const target = cue.words.map((_, k) => {
    const out = new Map<number, { x: number; y: number }>();
    const shown = rows.map((row) => row.filter((cell) => cell.at <= k)).map((row, r) => ({ row, r })).filter(({ row }) => row.length > 0);
    const height = shown.reduce((sum, { r }) => sum + reach[r]!.up + reach[r]!.down, 0) + pitch * (shown.length - 1);
    let top = -height / 2;
    for (const { row, r } of shown) {
      const centre = top + reach[r]!.up;
      const total = row.reduce((sum, cell) => sum + cell.width, 0) + gapPx * (row.length - 1);
      let x = -total / 2;
      for (const cell of row) {
        const m = metricAt.get(cell.at)!;
        out.set(cell.at, { x: x + cell.width / 2, y: centre + m.lift + m.mid });
        x += cell.width + gapPx;
      }
      top += reach[r]!.up + reach[r]!.down + pitch;
    }
    return out;
  });
  const final = target[cue.words.length - 1]!;
  const blockW = Math.max(...rows.map((row) => row.reduce((sum, cell) => sum + cell.width, 0) + gapPx * (row.length - 1)));
  const blockH = reach.reduce((sum, r) => sum + r.up + r.down, 0) + pitch * (rows.length - 1);
  const safe = ctx.space.safe;
  const margin = 3;
  const cx = clamp(ctx.space.x(540), safe.x1 + margin + blockW / 2, Math.max(safe.x1 + margin + blockW / 2, safe.x2 - margin - blockW / 2));
  const cy = clamp(ctx.space.y(1290), safe.y1 + margin + blockH / 2, Math.max(safe.y1 + margin + blockH / 2, safe.y2 - margin - blockH / 2));
  const zoom = clamp(Math.min((safe.x2 - safe.x1 - 2 * margin) / blockW, (safe.y2 - safe.y1 - 2 * margin) / blockH) * 0.985, 1, ZOOM_MAX);

  // When each word appears, and where it slides from: continuous from where the previous slide had got to.
  const enters = cue.words.map((word, at) => ctx.enter(word, word.role === "hero" ? 420 : at === 0 ? 600 : 260, WORD_LEAD));
  const steps = enters.map((enter) => enter.from);
  const startPos: Map<number, { x: number; y: number }>[] = [];
  cue.words.forEach((_, k) => {
    const out = new Map<number, { x: number; y: number }>();
    for (const [i, at] of target[k]!) {
      if (i === k || k === 0) out.set(i, at);
      else {
        const before = startPos[k - 1]!.get(i)!;
        const was = target[k - 1]!.get(i)!;
        const e = EASES.outExpo(prog(steps[k]!, steps[k - 1]!, SLIDE));
        out.set(i, { x: lerp(before.x, was.x, e), y: lerp(before.y, was.y, e) });
      }
    }
    startPos.push(out);
  });
  const position = (i: number, t: number) => {
    let k = i;
    for (let s = i; s < steps.length; s++) if (t >= steps[s]!) k = s;
    const from = startPos[k]!.get(i)!;
    const to2 = target[k]!.get(i)!;
    const e = EASES.outExpo(prog(t, steps[k]!, SLIDE));
    return { x: lerp(from.x, to2.x, e), y: lerp(from.y, to2.y, e) };
  };

  // The cue's depth: arrives from far behind (0.3x, blurred) and, when there is room, leaves through the camera.
  const first = enters[0]!;
  const arriveAt = first.from - WORD_LEAD;
  const arriveFor = clamp(2 * (first.settled - arriveAt), 134, 600);
  const arrive = (t: number) => EASES.outExpo(prog(t, arriveAt, arriveFor));
  const exitFor = Math.max(1, to - ctx.exitAt);
  const leave = (t: number) => (ctx.exit ? prog(t, ctx.exitAt, exitFor) : 0);
  const depth = (t: number) => lerp(0.3, 1, arrive(t)) * (1 + (zoom - 1) * leave(t) ** 2);
  const fade = (t: number) => 1 - leave(t) ** 1.4;

  const pieces: Piece[] = [];
  for (const [at, word] of cue.words.entries()) {
    const cell = cellAt.get(at)!;
    const m = metricAt.get(at)!;
    const hero = word.role === "hero";
    const { from, settled } = enters[at]!;
    const room = Math.max(1, settled - from);
    const ramp = Math.min(hero ? 105 : 65, room);
    const popFor = hero ? clamp(room / 0.15, 100, 420) : clamp(2 * room, 100, 260);
    const pop = (t: number) => prog(t, from, popFor);
    const scaleOf = (t: number) => (hero ? lerp(0.45, 1, EASES.spring(pop(t))) : lerp(0.86, 1, EASES.outExpo(pop(t)))) * depth(t);
    const opacity = (t: number) => lerp(0.3, 1, clamp(prog(t, from, ramp))) * fade(t);
    const blur = (t: number) => Math.hypot((1 - EASES.outExpo(pop(t))) * (hero ? 10 : 5), (1 - arrive(t)) * 16, 6 * leave(t) ** 1.4) * u;
    const edges = [from, from + ramp, from + popFor, from + popFor * 0.3, arriveAt, arriveAt + arriveFor, ctx.exitAt, to, ...steps, ...steps.map((s) => s + SLIDE)];
    const frames = (fn: (t: number) => number, tolerance: number) => sampleFrames(fn, edges, tolerance, { range: [from, Math.max(to, from + 1)], simplify: true });
    const x = (t: number) => cx + position(at, t).x * depth(t);
    const y = (t: number) => cy + position(at, t).y * depth(t);
    const scale = frames(scaleOf, 0.002);
    const piece = ctx.face(cell, from, hero ? c.highlight : c.primary, {
      x: frames(x, 0.15), y: frames(y, 0.15), sx: scale, sy: scale, o: frames(opacity, 0.004), blur: frames(blur, 0.05),
    });
    piece.origin = { dx: 0, dy: m.mid };
    piece.shadows = [{ dx: 0, dy: 0, blur: 9 * u, colour: c.shadow, alpha: 0.6 }];
    pieces.push(piece);
  }

  // Beat 1, every cue: speed streaks radiate from the vanishing point around the block as the cue arrives.
  const key = hash(`${index}:${cue.words.map((word) => word.text).join(" ")}`);
  const streakFrom = first.from;
  const streakFor = Math.min(380, to - streakFrom);
  const count = 12 + (key & 3);
  const offset = (rand(key, 1) * Math.PI * 2) / count;
  for (let j = 0; j < count; j++) {
    const angle = offset + (j + (rand(key, 10 + j) - 0.5) * 0.5) * ((Math.PI * 2) / count);
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const inBlock = Math.min(Math.abs(dx) < 1e-6 ? Infinity : blockW / 2 / Math.abs(dx), Math.abs(dy) < 1e-6 ? Infinity : blockH / 2 / Math.abs(dy));
    const r0 = inBlock * 1.1 + 36 * u + rand(key, 30 + j) * 30 * u;
    const edge = 8 * u;
    const reach = Math.min(
      dx > 0 ? (safe.x2 - edge - cx) / dx : dx < 0 ? (safe.x1 + edge - cx) / dx : Infinity,
      dy > 0 ? (safe.y2 - edge - cy) / dy : dy < 0 ? (safe.y1 + edge - cy) / dy : Infinity,
    );
    const length = (56 + rand(key, 50 + j) * 64) * u;
    const travel = Math.min((100 + rand(key, 70 + j) * 90) * u, reach - r0 - length);
    if (streakFor < 67 || travel < 40 * u) continue;
    const thick = (3.2 + rand(key, 90 + j) * 2) * u;
    const lime = hasHero && j % 4 === 3;
    const path: PathCmd[] = [["M", 0, thick * 0.4], ["L", length, 0], ["L", length, thick], ["L", 0, thick * 0.6], ["Z"]];
    const fn = (g: (p: number) => number) => (t: number) => g(prog(t, streakFrom, streakFor));
    const stops = [streakFrom, streakFrom + streakFor * 0.2, streakFrom + streakFor * 0.6, streakFrom + streakFor];
    const sample = (g: (p: number) => number, tolerance: number) => sampleFrames(fn(g), stops, tolerance, { range: [streakFrom, streakFrom + streakFor], simplify: true });
    const radius = (p: number) => r0 + travel * p ** 1.7;
    const shape = ctx.shape(`streak${j}`, streakFrom, path, {
      x: sample((p) => cx + dx * radius(p), 0.2), y: sample((p) => cy + dy * radius(p), 0.2),
      sx: sample((p) => 0.3 + 0.7 * EASES.out(clamp(p * 1.6)), 0.004), sy: [[streakFrom, 1]], rz: [[streakFrom, (angle * 180) / Math.PI]],
      o: sample((p) => EASES.out(clamp(p / 0.2)) * (1 - EASES.in(clamp((p - 0.45) / 0.55))), 0.004),
    }, lime ? c.highlight : c.accent);
    pieces.push({ ...shape, toMs: streakFrom + streakFor, origin: { dx: 0, dy: thick / 2 }, fill: { colour: lime ? c.highlight : c.accent, alpha: 0.55 } });
  }

  // Beat 2, every cue: speed dashes shoot out beside the key word (or the last word of a cue without one).
  const dashAt = hasHero ? cue.words.findIndex((word) => word.role === "hero") : cue.words.length - 1;
  const dashRow = rows[rowOfWord.get(dashAt)!]!;
  const dashCells = dashRow.filter((cell) => cell.at <= dashAt || !hasHero);
  const rowW = dashCells.reduce((sum, cell) => sum + cell.width, 0) + gapPx * (dashCells.length - 1);
  const dashEnter = enters[dashAt]!;
  const dashFrom = Math.min(Math.max(dashEnter.from, cue.words[dashAt]!.startMs - 20), Math.max(dashEnter.from, to - 100));
  const dashFor = Math.min(300, to - dashFrom);
  const dashSize = rowSize[rowOfWord.get(dashAt)!]!;
  const dashY = cy + final.get(dashAt)!.y - metricAt.get(dashAt)!.mid;
  const dashPad = Math.max(rowW * 0.035, 8 * u) + 18 * u;
  if (dashFor >= 67) {
    for (const side of [-1, 1]) {
      const edge = cx + side * (rowW / 2 + dashPad);
      const room = (side > 0 ? safe.x2 - 6 * u - edge : edge - (safe.x1 + 6 * u));
      const length = Math.min((70 + rand(key, 200) * 50) * u, room * 0.55);
      const travel = Math.min((50 + rand(key, 201) * 40) * u, room - length);
      if (length < 24 * u || travel < 16 * u) continue;
      const thick = Math.max(4 * u, dashSize * 0.03);
      for (const [n, lift] of [-1, 1].entries()) {
        const path: PathCmd[] = [["M", 0, 0], ["L", length, 0], ["L", length, thick], ["L", 0, thick], ["Z"]];
        const stops = [dashFrom, dashFrom + dashFor * 0.35, dashFrom + dashFor];
        const sample = (g: (p: number) => number, tolerance: number) =>
          sampleFrames((t) => g(prog(t, dashFrom, dashFor)), stops, tolerance, { range: [dashFrom, dashFrom + dashFor], simplify: true });
        const delay = n * 0.12;
        const q = (p: number) => clamp((p - delay) / (1 - delay));
        const colour = hasHero ? c.highlight : c.primary;
        const shape = ctx.shape(`dash${side > 0 ? "r" : "l"}${n}`, dashFrom, path, {
          x: sample((p) => edge + side * travel * EASES.out(q(p)), 0.2),
          y: [[dashFrom, dashY + lift * dashSize * 0.2]],
          sx: sample((p) => 0.25 + 0.75 * EASES.out(clamp(q(p) * 1.5)), 0.004),
          o: sample((p) => EASES.out(clamp(q(p) / 0.15)) * (1 - EASES.in(clamp((q(p) - 0.4) / 0.6))), 0.004),
        }, colour);
        pieces.push({ ...shape, toMs: dashFrom + dashFor, fill: { colour, alpha: hasHero ? 0.95 : 0.6 }, origin: { dx: side > 0 ? 0 : length, dy: thick / 2 } });
      }
    }
  }
  return pieces;
});

import type { DemoScript } from "../demo";
import { EASES, clamp, prog } from "../ease";
import type { Frames } from "../ease";
import { exportFrameTimes, paintedFrameCount } from "../frame-grid";
import { sampleFrames } from "../frames";
import { balancedRows } from "../layout";
import { type Box, type PathCmd, type Piece, type TextPiece, pieceBounds } from "../scene";
import { ellipsePath, polygonPath } from "../shapes";
import { caps, galleryScene, rotatePoint, rowsOf } from "./gallery-layout";
import type { SpeechCell } from "./speech-layout";

/**
 * Anime (`samples/templates/m65-anime.js`, gallery 5; the sample's "Anime Graphics", after Motion Array 3448728): every line
 * slams into its own charcoal slab in chunky arcade pixel caps (Pixelify Sans Bold, stretched 1.2x tall) drawn the reference's
 * way: a white face, a black inline and a pale-cyan outer outline. A line of only small words is hollow (outline only). Flat
 * primary doodles bob around the block, the key word lands biggest behind a burst of white manga speed lines, and every slab
 * jitters in for two hard frames before it settles.
 *
 * Changes from the sample, and why:
 * - **Rows come from the words.** The sample already wraps by width; here a key word gets its own row (its own slab, fitted to
 *   840) and the words between key words wrap into balanced rows of at most 820, each row shrinking as a whole when one long word
 *   needs it, and the cue as a whole when the safe area needs it. A second key word gets its own slab like the first.
 * - **Colours go through the brand map.** The face is the primary colour, the outer outline the highlight, the slab the accent
 *   (the guard checks the first two against it); the black inline and the primary-colour doodles stay as drawn.
 * - **Doodles stay clear of words.** The sample's two front doodles hang over the slabs' bottom corners and can cover letters
 *   (and every doodle cycled by a cue-indexed table). Every doodle is drawn behind the slabs and the words; the two that tuck
 *   over a slab edge only take a spot no word's ink reaches (they move out, or are dropped), the others sit in the block's
 *   corners and sides, clamped into the safe area. Shapes and colours cycle by a per-cue counter plus a seeded hash, four per
 *   cue and six when it has a key word, as in the sample.
 * - **The stamp is locked to speech.** Each slab's two-frame jitter and its spring settle start with its first word (40 ms
 *   early, as the sample) and are compressed into that word's own time when it is short; a word spoken too fast to animate
 *   gets the settled pose. The first word of a row takes the slab's stamp, the following words keep the sample's one-frame
 *   1.18x pop. The jitter and the pops are capped so no slab or word ever reaches past the safe area (a 936 px slab at 1.22x would).
 * - **The exit waits for the speech.** The sample squashes each slab 190 ms before the cue ends, with the last word still being
 *   spoken. Here the same six-step squash runs from the end of the words' reading hold to the cue's end, and is dropped (a
 *   cut) when the next cue arrives sooner: the outgoing cue always gives way.
 * - **Speed lines are clipped to the caption zone and vary.** The sample's 18 rays are 12 here (budget); their starting angle turns by a
 *   seeded amount on every key word so a long clip does not repeat one burst.
 * - Extra recurring beats, all behind the words: impact ticks (three chunky dashes, alternately white and cyan) jump off a
 *   corner of every slab as it lands (top corner on even rows, bottom on odd, on the leading side), and pixel sparks pop off
 *   the block's top or bottom edge when the key word (or the last word of a cue with none) is spoken. Both are placed in free
 *   space and dropped when the safe area leaves no room.
 * - **Review fixes (Sol, 2026-11-25).**
 *   - A word too long for a row at a readable size (under half the body) is cut into equal chunks, each on its own slab at one
 *     size (the sample squeezed a 45-letter word to 27 px). Joined scripts are never cut and shrink as before.
 *   - The whole stack, stamp jitter and pops included, is fitted into the caption band (y 880..1630 of 1920, moving with the
 *     anchor and the lane): shifted when it only sits off-centre, shrunk when it is too tall. Landscape frames wrap rows wider.
 *   - A cue whose window paints one frame keeps its slab one frame longer, so the word is never bare (the one-frame filter
 *     would drop the slab); the doodles, ticks, sparks and rays compress into a short cue's own time instead of starting late.
 *   - The doodles land with the cue and then sit still (their idle bob cost more libass events than the rest of the cue);
 *     a doodle's landing overshoot is kept clear of the safe area.
 * - Slabs grow word by word with a clip on one full-size rectangle (the sample resizes the box); the slab and its words move as
 *   one rigid piece (jitter, settle, squash) about the slab's centre.
 */
export const ANIME_DEMO: DemoScript = {
  lines: [
    "this:m will:b blow:b your:m mind:h@720",
    "nobody:b tells:b you:m this:m",
    "stop:b wasting:b time:h@600",
    "you:m just:m leveled:b up:h@560",
    "ready:b player:b one:h@640",
  ],
  options: { rate: 255, cueGap: 150, tail: 900, lead: 400 },
};

const FACE: TextPiece["face"] = "Pixelify Sans Bold";
const INLINE = "#0A0E0F";
const RED = "#FF3B2F";
const YELLOW = "#FFD60A";
const BLUE = "#2F6BFF";
const SPACING = 0.02;
const ANCHOR = 1275;
const BODY = 128;
const HERO_MAX = 250;
const COLUMN = 820;
const HERO_ROW = 840;
const GAP = 0.34 * BODY;
const TALL = 1.2;
const CAP = 0.7;
const PAD_X = 38;
const OVERLAP = 22;
const FRAME = 33;
const LEAD = 40;
const SLAM = 2 * FRAME + 230;
const POP = FRAME + 200;
const EXIT_X = [1.04, 0.96, 0.9, 0.7, 0.4, 0.2] as const;
const EXIT_Y = [1, 0.8, 0.45, 0.2, 0.1, 0.05] as const;

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** A deterministic 0..1 from a cue key and a salt. */
const rand = (key: number, salt: number) => hash(`${key}:${salt}`) / 4294967296;

/** A step function as keyframes: each value holds until one ms before the next time, then jumps. */
function stepFrames(points: readonly (readonly [number, number])[]): Frames {
  const out: [number, number][] = [[points[0]![0], points[0]![1]]];
  for (const [at, value] of points.slice(1)) {
    const last = out.at(-1)!;
    if (at - 1 > last[0]) out.push([at - 1, last[1]]);
    out.push([Math.max(at, out.at(-1)![0] + 1), value]);
  }
  return out;
}

const star = (spikes: number, outer: number, inner: number, rotDeg: number): PathCmd[] => {
  const points: [number, number][] = [];
  for (let i = 0; i < spikes * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = ((rotDeg + (i * 180) / spikes) * Math.PI) / 180;
    points.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return polygonPath(points);
};

/** The sample's flat doodles in its 100-unit box, centred on (0, 0) and scaled by `k`. */
function doodle(kind: string, k: number): PathCmd[] {
  const poly = (pts: readonly (readonly [number, number])[]) => polygonPath(pts.map(([x, y]) => [(x - 50) * k, (y - 50) * k] as const));
  switch (kind) {
    case "star": return star(5, 46 * k, 19 * k, -90);
    case "burst": return star(9, 48 * k, 27 * k, -80);
    case "plus": return poly([[36, 6], [64, 6], [64, 36], [94, 36], [94, 64], [64, 64], [64, 94], [36, 94], [36, 64], [6, 64], [6, 36], [36, 36]]);
    case "circle": return ellipsePath(0, 0, 40 * k);
    default: return poly([[50, 8], [94, 88], [6, 88]]);
  }
}

const STICKER_KINDS = ["star", "plus", "circle", "burst", "triangle", "star"] as const;
const STICKER_COLOURS = [YELLOW, RED, BLUE, YELLOW, RED, BLUE] as const;
// The sample's six slots around the block: which block edge each hangs from, its offset from it (sample px), its size, and
// whether it tucks over a slab edge (the two front ones).
const SLOTS = [
  { ax: "l", ox: -20, ay: "t", oy: -18, size: 108, front: false },
  { ax: "r", ox: -70, ay: "t", oy: -30, size: 92, front: false },
  { ax: "r", ox: 10, ay: "m", oy: -40, size: 100, front: false },
  { ax: "l", ox: -36, ay: "m", oy: 40, size: 84, front: false },
  { ax: "r", ox: -90, ay: "b", oy: 6, size: 88, front: true },
  { ax: "l", ox: 90, ay: "b", oy: -4, size: 76, front: true },
] as const;

const FLOOR = 0.5 * BODY;
const RAYS = 12;
const SPARKS = 6;
const SPLITTABLE = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{N}\p{P}]+$/u;

/** What is drawn: a word, or one equal chunk of a word too long for a row at a readable size. */
interface Unit {
  readonly word: number;
  readonly text: string;
  readonly size: number;
  readonly width100: number;
  readonly part: number;
  readonly parts: number;
}

interface Line {
  readonly r: number;
  readonly hero: boolean;
  readonly hollow: boolean;
  readonly size: number;
  readonly h: number;
  readonly cx: number;
  readonly cy: number;
  readonly slabW: number;
  readonly rot: number;
  readonly baseline: number;
  readonly inkTop: number;
  readonly inkBottom: number;
  readonly words: { readonly cell: SpeechCell; readonly unit: Unit; readonly lx: number; readonly size: number }[];
  readonly pose: (t: number) => { x: number; y: number; s: number; r: number; ex: number; ey: number };
  readonly from: number;
  readonly edges: number[];
  readonly roomHalf: number;
  readonly bare: boolean;
}

interface Main {
  readonly pieces: Piece[];
  readonly lines: Line[];
  readonly u: number;
  readonly extent: Box | null;
}

export const animeProgram = galleryScene("anime", ANCHOR, (ctx) => {
  const { cue, index, to } = ctx.window;
  const c = ctx.input.colours;
  const { safe } = ctx.space;
  const side = ctx.side;
  const measure = ctx.input.measure;
  const texts = cue.words.map((word) => caps(word, cue));
  const heroAt = cue.words.findIndex((word) => word.role === "hero");
  const key = hash(`${index}:${texts.join(" ")}`);
  const width100 = texts.map((text) => measure(text, FACE, 100, SPACING).advance);
  // The caption band the sample's speed lines are clipped to (y 880..1630 of 1920, moving with the anchor), inside the safe area.
  const band: Box = { x1: safe.x1, x2: safe.x2, y1: Math.max(safe.y1, ctx.space.y(880)), y2: Math.min(safe.y2, ctx.space.y(1630)) };
  // A landscape frame has room for longer rows than the sample's 1080 px column.
  const wide = ctx.input.canvas.width > 1.2 * ctx.input.canvas.height;
  const col = wide ? Math.max(COLUMN, (safe.x2 - safe.x1) / ctx.space.u - 2 * (PAD_X + 20)) : COLUMN;
  const heroCol = col + (HERO_ROW - COLUMN);

  // Nothing may paint after the clip's last cue.
  const lastCue = to >= Math.max(...ctx.input.cues.map((other) => other.endMs));
  const exitFor = Math.max(1, to - ctx.exitAt);
  const exitEdges = ctx.exit ? EXIT_X.flatMap((_, q) => { const e = Math.round(ctx.exitAt + (exitFor * q) / 6); return [e - 1, e]; }) : [];
  const enters = cue.words.map((word) => ctx.enter(word, POP, LEAD));
  const frames = (fn: (t: number) => number, edges: readonly number[], tolerance: number, a: number, b: number) =>
    sampleFrames(fn, edges, tolerance, { range: [a, Math.max(b, a + 1)], wholeMs: true, simplify: true });

  /** The units drawn: one per word, or, for a word too long for a row at a readable size, equal chunks on their own slabs. */
  const unitsFor = (f: number): Unit[] => {
    const units: Unit[] = [];
    cue.words.forEach((word, at) => {
      const hero = word.role === "hero";
      const natural = (hero ? HERO_MAX : BODY) * f;
      const fit = ((hero ? heroCol : col) / Math.max(1, width100[at]!)) * 100;
      const letters = [...texts[at]!];
      if (fit >= FLOOR * f || letters.length < 8 || !SPLITTABLE.test(texts[at]!)) {
        units.push({ word: at, text: texts[at]!, size: Math.min(natural, fit), width100: width100[at]!, part: 0, parts: 1 });
        return;
      }
      const target = natural * 0.6;
      const parts = Math.min(4, Math.max(2, Math.ceil(target / fit)));
      const per = Math.ceil(letters.length / parts);
      const chunks = Array.from({ length: Math.ceil(letters.length / per) }, (_, k) => letters.slice(k * per, (k + 1) * per).join(""));
      const chunkWidths = chunks.map((chunk) => measure(chunk, FACE, 100, SPACING).advance);
      const size = Math.min(target, ((hero ? heroCol : col) / Math.max(1, ...chunkWidths)) * 100);
      for (const [part, text] of chunks.entries()) units.push({ word: at, text, size, width100: chunkWidths[part]!, part, parts: chunks.length });
    });
    return units;
  };

  /** The words, slabs and their stamp for size factor `f`, the block `dy` px lower than centred. */
  const main = (f: number, dy: number): Main => {
    const units = unitsFor(f);
    const heroUnit = (i: number) => cue.words[units[i]!.word]!.role === "hero";
    const widths = units.map((unit) => (unit.width100 * unit.size) / 100);
    const groups: number[][] = [];
    let run: number[] = [];
    const flush = () => {
      for (const row of balancedRows(run.map((i) => widths[i]!), GAP, col)) groups.push(row.map((k) => run[k]!));
      run = [];
    };
    units.forEach((unit, i) => {
      if (heroUnit(i) || unit.parts > 1) {
        flush();
        groups.push([i]);
      } else run.push(i);
    });
    flush();

    const { cells, unit: u } = ctx.layout({
      column: heroCol, gap: GAP, padding: PAD_X + 20, groups,
      words: units.map((unit) => ({ text: unit.text, face: FACE, size: unit.size, spacing: SPACING })),
    });
    const rows = rowsOf(cells);
    const padX = PAD_X * u;
    const overlap = OVERLAP * u;

    // The slabs: height from the stretched cap ink, stacked with a little overlap and centred on the anchor line.
    const geometry = rows.map((row) => {
      const hero = row.some((cell) => heroUnit(cell.at));
      const size = Math.max(...row.map((cell) => cell.size));
      const inkTop = Math.min(-CAP * size, ...row.map((cell) => cell.inkTop)) * TALL;
      const inkBottom = Math.max(0, ...row.map((cell) => cell.inkBottom)) * TALL;
      const h = inkBottom - inkTop + 0.24 * size + (hero ? 46 : 38) * u;
      const left = Math.min(...row.map((cell) => cell.x - cell.width / 2));
      const right = Math.max(...row.map((cell) => cell.x + cell.width / 2));
      const hollow = !hero && row.every((cell) => cue.words[units[cell.at]!.word]!.role === "minor");
      return { row, hero, size, inkTop, inkBottom, h, left, right, hollow };
    });
    const total = geometry.reduce((sum, g) => sum + g.h, 0) - overlap * (rows.length - 1);
    let top = ctx.space.y(ANCHOR) - total / 2 + dy;

    const lines: Line[] = geometry.map((g, r) => {
      const slabW = g.right - g.left + 2 * padX;
      const parity = (index + r) % 2 === 0 ? -1 : 1;
      const shift = g.hero ? 0 : (parity < 0 ? -36 : 40) * u * side;
      const mid = (g.left + g.right) / 2 + shift;
      const lo = safe.x1 + 4 + slabW / 2;
      const hi = safe.x2 - 4 - slabW / 2;
      const cx = lo <= hi ? clamp(mid, lo, hi) : (safe.x1 + safe.x2) / 2;
      const cy = top + g.h / 2;
      const baseline = cy - (g.inkTop + g.inkBottom) / 2;
      top += g.h - overlap;
      const rot = (g.hero ? -0.9 : parity < 0 ? -1.3 : 1.1) * side;
      const shiftX = cx - (g.left + g.right) / 2;
      const spoken = [...g.row].sort((a, b) => a.at - b.at);
      const words = spoken.map((cell) => ({ cell: { ...cell, x: cell.x + shiftX }, unit: units[cell.at]!, lx: cell.x + shiftX - cx, size: cell.size }));
      const firstWord = words[0]!.unit.word;
      const lineEnter = ctx.enter(cue.words[firstWord]!, SLAM, LEAD);
      const k = lineEnter.motion ? clamp((lineEnter.settled - lineEnter.from) / SLAM) : 0;
      const a = FRAME * k;
      const settle = 230 * k;
      // The jitter and the settle never reach past the safe area: scale the sample's excess down to the room beside the slab.
      const jit = g.hero
        ? { a: { x: -30, y: 18, s: 1.12 }, b: { x: 22, y: -10, s: 1.05 }, amp: 0.1 }
        : { a: { x: -22, y: 11, s: 1.22 }, b: { x: 15, y: -7, s: 1.09 }, amp: 0.05 };
      const peak = Math.max(jit.a.s, jit.b.s, 1 + jit.amp) - 1;
      const roomHalf = Math.min(cx - safe.x1, safe.x2 - cx) - 6 * u;
      const fit = clamp((roomHalf - (g.h / 2) * Math.sin((4 * Math.PI) / 180) - 8 * u) / (slabW / 2) - 1, 0, peak) / peak;
      const slack = roomHalf - (slabW / 2) * (1 + peak * fit) - (g.h / 2) * Math.sin((4 * Math.PI) / 180);
      const gx = clamp(slack / (30 * u), 0, 1);
      const from = lineEnter.from;
      const pose = (t: number) => {
        let x = 0;
        let y = 0;
        let s = 1;
        let r2 = 0;
        if (lineEnter.motion) {
          const p = t - from;
          if (p < a) ({ x, y, s, r: r2 } = { x: jit.a.x * gx * u * side, y: jit.a.y * u, s: 1 + (jit.a.s - 1) * fit, r: -3.5 * side });
          else if (p < 2 * a) ({ x, y, s, r: r2 } = { x: jit.b.x * gx * u * side, y: jit.b.y * u, s: 1 + (jit.b.s - 1) * fit, r: 2.5 * side });
          else s = 1 + jit.amp * fit * (1 - EASES.spring(prog(t, from + 2 * a, settle)));
        }
        let ex = 1;
        let ey = 1;
        if (ctx.exit && t >= ctx.exitAt) {
          const q = clamp(Math.floor((t - ctx.exitAt) / (exitFor / 6)), 0, 5);
          ex = EXIT_X[q]!;
          ey = EXIT_Y[q]!;
        }
        return { x, y, s, r: r2, ex, ey };
      };
      const edges = [from, from + a - 1, from + a, from + 2 * a - 1, from + 2 * a, from + 2 * a + settle, ...exitEdges];
      return { r, hero: g.hero, hollow: g.hollow, size: g.size, h: g.h, cx, cy, slabW, rot, baseline, inkTop: g.inkTop, inkBottom: g.inkBottom, words, pose, from, edges, roomHalf, bare: paintedFrameCount(from, to, ctx.fps) < 2 };
    });

    const pieces: Piece[] = [];
    for (const line of lines) {
      const { cx, cy, pose, rot } = line;
      const turn = (t: number) => rot + pose(t).r;
      const idOf = (unit: Unit, suffix = "") => `${ctx.id}:w${unit.word}${suffix}`;

      // The slab: one full-size rectangle, its clip opening word by word along the reading direction. A line whose window paints
      // only one frame holds its slab one frame longer (under the next cue's own slab and words), so the word is never bare:
      // the one-frame filter would otherwise drop the slab and leave white text on the video.
      const slabFrom = line.from;
      const slabEnd = lastCue ? to : (exportFrameTimes(slabFrom, to + 200, ctx.fps)[1] ?? to) + 1;
      const shown = line.words.map(({ cell, unit, lx }) => ({ from: enters[unit.word]!.from, left: lx - cell.width / 2 - padX, right: lx + cell.width / 2 + padX }));
      let left = Infinity;
      let right = -Infinity;
      const stepsL: [number, number][] = [];
      const stepsR: [number, number][] = [];
      for (const word of shown) {
        left = Math.min(left, word.left);
        right = Math.max(right, word.right);
        stepsL.push([word.from, left]);
        stepsR.push([word.from, right]);
      }
      const slab = ctx.rect(`slab${line.r}`, slabFrom, cx, cy, line.slabW, line.h, 0, c.accent, {
        x: frames((t) => cx + pose(t).x, line.edges, 0.15, slabFrom, to),
        y: frames((t) => cy + pose(t).y, line.edges, 0.15, slabFrom, to),
        rz: frames(turn, line.edges, 0.05, slabFrom, to),
        sx: frames((t) => pose(t).s * pose(t).ex, line.edges, 0.003, slabFrom, to),
        sy: frames((t) => pose(t).s * pose(t).ey, line.edges, 0.003, slabFrom, to),
        o: [[slabFrom, 1]],
      });
      pieces.push({
        ...slab, z: 3, toMs: line.bare ? slabEnd : to,
        clip: { x1: stepFrames(stepsL), x2: stepFrames(stepsR), y1: [[slabFrom, -line.h / 2]], y2: [[slabFrom, line.h / 2]], radius: 0 },
      });

      // The words: each pivots on its baseline, takes the slab's pose, then its own one-frame pop.
      for (const [position, { cell, unit, lx, size }] of line.words.entries()) {
        const enter = enters[unit.word]!;
        const ly = line.baseline - cy;
        const wordMotion = enter.motion && position > 0;
        const kw = wordMotion ? clamp((enter.settled - enter.from) / POP) : 0;
        const aw = FRAME * kw;
        const far = Math.max(Math.abs(lx - cell.width / 2), Math.abs(lx + cell.width / 2));
        const cap = clamp((line.roomHalf - 4 * u) / (far * 1.1), 1, 1.18);
        const over = 0.06 * ((cap - 1) / 0.18);
        const pop = (t: number) => {
          if (!wordMotion) return 1;
          return t - enter.from < aw ? cap : 1 + over * (1 - EASES.spring(prog(t, enter.from + aw, 200 * kw)));
        };
        const edges = [...line.edges, enter.from, enter.from + aw - 1, enter.from + aw, enter.from + aw + 200 * kw];
        const place = (t: number) => {
          const p = pose(t);
          const [px, py] = rotatePoint(p.s * p.ex * lx, p.s * p.ey * ly, turn(t));
          return { x: cx + p.x + px, y: cy + p.y + py };
        };
        const track = {
          x: frames((t) => place(t).x, edges, 0.15, enter.from, to),
          y: frames((t) => place(t).y, edges, 0.15, enter.from, to),
          rz: frames(turn, edges, 0.05, enter.from, to),
          sx: frames((t) => pose(t).s * pose(t).ex * pop(t), edges, 0.003, enter.from, to),
          sy: frames((t) => pose(t).s * pose(t).ey * pop(t) * TALL, edges, 0.003, enter.from, to),
          o: [[enter.from, 1]] as Frames,
        };
        const face = { ...ctx.face(cell, enter.from, c.primary, track), id: idOf(unit, unit.part > 0 ? `l${unit.part}` : "") };
        const ring = { ...face, id: idOf(unit, `o${unit.part}`), z: 4, fill: c.highlight };
        if (line.hollow) {
          pieces.push({ ...ring, fillAlpha: 0, stroke: { widthPx: 0.05 * size, colour: c.highlight } });
          pieces.push({ ...face, fillAlpha: 0, stroke: { widthPx: 0.02 * size, colour: c.primary } });
        } else {
          pieces.push({ ...ring, stroke: { widthPx: 0.095 * size, colour: c.highlight } });
          pieces.push({ ...face, stroke: { widthPx: 0.0425 * size, colour: INLINE } });
        }
      }
    }

    // Everything the slabs and words ever cover, the stamp's jitter and pops included.
    const times = new Set<number>();
    for (const line of lines) for (const edge of line.edges) times.add(edge);
    for (let t = ctx.window.from; t < to; t += 16) times.add(t);
    let extent: Box | null = null;
    for (const piece of pieces) {
      for (const t of times) {
        if (t < piece.fromMs || t >= piece.toMs) continue;
        const at = pieceBounds(piece, t, measure);
        if (at) extent = extent ? { x1: Math.min(extent.x1, at.x1), y1: Math.min(extent.y1, at.y1), x2: Math.max(extent.x2, at.x2), y2: Math.max(extent.y2, at.y2) } : at;
      }
    }
    return { pieces, lines, u, extent };
  };

  // Fit the whole stack, stamp motion included, into the caption band: shift it when it merely sits off-centre, shrink it when it is too tall.
  let f = 1;
  let dy = 0;
  let made = main(f, dy);
  for (let tries = 0; tries < 4 && made.extent; tries++) {
    const { extent } = made;
    const bandH = band.y2 - band.y1;
    const heightNow = extent.y2 - extent.y1;
    if (extent.y1 >= band.y1 - 0.5 && extent.y2 <= band.y2 + 0.5) break;
    if (heightNow <= bandH) dy += extent.y1 < band.y1 ? band.y1 - extent.y1 : band.y2 - extent.y2;
    else {
      f *= (bandH / heightNow) * 0.985;
      dy = 0;
    }
    made = main(f, dy);
  }
  const { pieces, lines, u } = made;

  // The block and the ink every doodle has to keep clear of.
  const block: Box = {
    x1: Math.min(...lines.map((line) => line.cx - line.slabW / 2)),
    x2: Math.max(...lines.map((line) => line.cx + line.slabW / 2)),
    y1: Math.min(...lines.map((line) => line.cy - line.h / 2)),
    y2: Math.max(...lines.map((line) => line.cy + line.h / 2)),
  };
  // Every spot a word's ink (outer outline included) reaches during the cue, the stamp's jitter and pops too.
  const inkBoxes: Box[] = [];
  for (const piece of pieces) {
    if (piece.kind !== "text") continue;
    let box: Box | null = null;
    for (let t = piece.fromMs; t < piece.toMs; t += 16) {
      const at = pieceBounds(piece, t, measure);
      if (at) box = box ? { x1: Math.min(box.x1, at.x1), y1: Math.min(box.y1, at.y1), x2: Math.max(box.x2, at.x2), y2: Math.max(box.y2, at.y2) } : at;
    }
    if (box) inkBoxes.push({ x1: box.x1 - 6 * u, y1: box.y1 - 6 * u, x2: box.x2 + 6 * u, y2: box.y2 + 6 * u });
  }
  const meets = (a: Box, b: Box) => a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
  const firstFrom = enters[0]?.from ?? ctx.window.from;
  const counter = index;
  const lineOfWord = (at: number) => lines.find((l) => l.words.some(({ unit }) => unit.word === at))!;
  const frames2 = (from: number, until: number) => paintedFrameCount(from, until, ctx.fps) >= 2;

  // Flat doodles around the block: four per cue, six with a key word. They land with the cue (sooner when it is short) and
  // then sit still; a cue too short to animate them still shows them whole.
  const count = heroAt >= 0 ? 6 : 4;
  const colourOffset = (counter + (key >>> 3)) % STICKER_COLOURS.length;
  const avail = to - firstFrom;
  SLOTS.slice(0, count).forEach((slot, si) => {
    const kind = STICKER_KINDS[(si + counter) % STICKER_KINDS.length]!;
    const size = slot.size * (kind === "plus" ? 0.9 : 1) * u;
    const mirror = side < 0 ? (x: number) => block.x1 + block.x2 - x : (x: number) => x;
    let x = mirror((slot.ax === "l" ? block.x1 : block.x2) + slot.ox * u);
    let y = slot.ay === "t" ? block.y1 + slot.oy * u : slot.ay === "b" ? block.y2 + slot.oy * u : (block.y1 + block.y2) / 2 + slot.oy * u;
    const halfBox = size * 0.62 + 15 * u;
    // Its landing overshoots to ~1.3x and it is turned, so keep 0.66 of its size (and the stroke) to the safe edge.
    const edge = 0.66 * size + 8 * u;
    const place = (px: number, py: number) => ({
      x: clamp(px, safe.x1 + edge, Math.max(safe.x1 + edge, safe.x2 - edge)),
      y: clamp(py, safe.y1 + edge, Math.max(safe.y1 + edge, safe.y2 - edge)),
    });
    ({ x, y } = place(x, y));
    if (slot.front) {
      // Over a slab edge: only where no word's ink is near, moving away from the block until it is clear.
      const outward = slot.ay === "b" ? 1 : -1;
      let tries = 0;
      const touches = () => inkBoxes.some((ink) => meets(ink, { x1: x - halfBox, x2: x + halfBox, y1: y - halfBox, y2: y + halfBox }));
      while (touches() && tries < 10) {
        ({ x, y } = place(x, y + outward * 14 * u));
        tries++;
      }
      if (touches()) return;
    }
    const delay = Math.min(40 + si * 55, (Math.max(0, avail - 150) * (si + 1)) / (count + 1));
    const from = Math.max(ctx.window.from, firstFrom + delay);
    const dur = Math.min(360, to - from);
    if (!frames2(from, to)) return;
    const spin = (si % 2 ? 1 : -1) * (8 + si * 3);
    const animated = dur >= 100;
    const pop = (t: number) => (animated ? Math.max(0, EASES.spring(prog(t, from, dur))) : 1);
    const out = (t: number) => (ctx.exit ? 1 - prog(t, ctx.exitAt, exitFor) : 1);
    const edges = [from, from + dur, ctx.exitAt, to];
    const colour = STICKER_COLOURS[(si + colourOffset) % STICKER_COLOURS.length]!;
    const scale = frames((t) => pop(t) * out(t), edges, 0.004, from, to);
    const shape = ctx.shape(`sticker${si}`, from, doodle(kind, size / 100), {
      x: [[from, x]], y: [[from, y]], rz: [[from, spin]], sx: scale, sy: scale, o: [[from, 1]],
    }, colour);
    pieces.push({ ...shape, z: slot.front ? 3.5 : 1.5, toMs: to, stroke: { widthPx: 0.04 * size, colour: INLINE } });
  });

  // The key word's speed lines: 12 white wedges burst out of its slab behind everything, clipped to the caption zone.
  if (heroAt >= 0) {
    const line = lineOfWord(heroAt);
    const from = enters[heroAt]!.from;
    const dur = Math.min(340, to - from);
    const zone = {
      x1: Math.max(safe.x1 + 4, ctx.space.x(60)), x2: Math.min(safe.x2 - 4, ctx.space.x(1020)),
      y1: band.y1 + 4, y2: band.y2 - 4,
    };
    const r0 = Math.max(line.slabW, line.h) * 0.3;
    const turn = (rand(key, 1) - 0.5) * 0.35;
    const grow = (t: number) => EASES.outExpo(clamp((t - from) / Math.min(190, dur)));
    const alpha = (t: number) => 1 - prog(t, from + Math.min(120, dur * 0.35), Math.max(1, dur - Math.min(120, dur * 0.35)));
    const edges = [from, from + 120, from + 190, from + 340];
    if (frames2(from, from + dur)) {
      for (let k = 0; k < RAYS; k++) {
        const angle = (k / RAYS) * Math.PI * 2 + 0.11 + turn;
        const half = 0.05 + 0.03 * ((k * 7) % 3);
        const lengthK = 0.8 + 0.5 * (((k * 5) % 4) / 3);
        const point = (rad: number, a: number) => ({ x: line.cx + rad * Math.cos(a) * 1.5, y: line.cy + rad * Math.sin(a) * 0.9 });
        const base = (g: number) => point(r0 + 20 * u * g, angle);
        const r1 = r0 + 20 * u + 420 * u * lengthK;
        const tip = point(r1, angle);
        const mid = base(1);
        const reach = Math.hypot(tip.x - mid.x, tip.y - mid.y);
        const phi = Math.atan2(tip.y - mid.y, tip.x - mid.x);
        const b1 = point(r0 + 20 * u, angle - half * 0.5);
        const wing = Math.hypot(b1.x - mid.x, b1.y - mid.y) * 1.2;
        const path: PathCmd[] = [["M", 0, -wing], ["L", reach, 0], ["L", 0, wing], ["Z"]];
        const shape = ctx.shape(`ray${k}`, from, path, {
          x: frames((t) => base(grow(t)).x, edges, 0.2, from, from + dur), y: frames((t) => base(grow(t)).y, edges, 0.2, from, from + dur),
          rz: [[from, (phi * 180) / Math.PI]],
          sx: frames((t) => 0.05 + 0.95 * grow(t), edges, 0.004, from, from + dur),
          sy: frames((t) => 2 - grow(t), edges, 0.004, from, from + dur),
          o: frames(alpha, edges, 0.004, from, from + dur),
        }, "#FFFFFF");
        pieces.push({ ...shape, z: 1, toMs: from + dur, clip: { x1: [[from, zone.x1]], x2: [[from, zone.x2]], y1: [[from, zone.y1]], y2: [[from, zone.y2]] } });
      }
    }
  }

  // Beat 1, every row: three impact ticks jump off a corner of the slab as it lands, on the side it leans from.
  for (const line of lines) {
    const from = line.from;
    const dur = Math.min(220, to - from);
    if (!frames2(from, from + dur)) continue;
    const top = line.r % 2 === 0;
    const lean = ((index + line.r) % 2 === 0 ? -1 : 1) * side;
    const corner = { x: line.cx + lean * (line.slabW / 2), y: line.cy + (top ? -1 : 1) * (line.h / 2) };
    const dashes: PathCmd[] = [];
    let fits = 0;
    for (const [n, angle] of [-135, -165, -105].entries()) {
      const radians = ((top ? angle : -angle) * Math.PI) / 180;
      const dirX = lean < 0 ? Math.cos(radians) : -Math.cos(radians);
      const dirY = Math.sin(radians);
      const length = [34, 24, 28][n]! * u;
      const gap = 12 * u;
      const thick = 8 * u;
      const endX = corner.x + dirX * (gap + length);
      const endY = corner.y + dirY * (gap + length);
      if (endX < safe.x1 + 4 * u || endX > safe.x2 - 4 * u || endY < safe.y1 + 4 * u || endY > safe.y2 - 4 * u) continue;
      const nx = -dirY;
      const ny = dirX;
      dashes.push(
        ["M", dirX * gap + (nx * thick) / 2, dirY * gap + (ny * thick) / 2],
        ["L", dirX * (gap + length) + (nx * thick) / 2, dirY * (gap + length) + (ny * thick) / 2],
        ["L", dirX * (gap + length) - (nx * thick) / 2, dirY * (gap + length) - (ny * thick) / 2],
        ["L", dirX * gap - (nx * thick) / 2, dirY * gap - (ny * thick) / 2],
        ["Z"],
      );
      fits++;
    }
    if (!fits) continue;
    const colour = line.r % 2 === 0 ? c.primary : c.highlight;
    const grow = Math.min(130, dur);
    const shape = ctx.shape(`tick${line.r}`, from, dashes, {
      x: [[from, corner.x]], y: [[from, corner.y]],
      sx: [[from, 0.4], [from + grow, 1, "outExpo"]], sy: [[from, 0.4], [from + grow, 1, "outExpo"]],
      o: [[from, 1], [from + dur * 0.5, 1], [from + dur, 0, "in"]],
    }, colour);
    pieces.push({ ...shape, z: 1.4, toMs: from + dur });
  }

  // Beat 2, every cue: pixel sparks pop off the block's top or bottom edge when the key word (or the last word) is spoken.
  {
    const sparkAt = heroAt >= 0 ? heroAt : cue.words.length - 1;
    const sparkLine = lineOfWord(sparkAt);
    const upward = heroAt >= 0 && sparkLine.r <= (lines.length - 1) / 2;
    const from = enters[sparkAt]!.from;
    const dur = Math.min(360, to - from);
    const palette = [YELLOW, c.highlight, c.primary, RED, BLUE, YELLOW];
    if (frames2(from, from + dur)) {
      const edgeLine = upward ? lines[0]! : lines[lines.length - 1]!;
      const edgeY = upward ? edgeLine.cy - edgeLine.h / 2 : edgeLine.cy + edgeLine.h / 2;
      for (let n = 0; n < SPARKS; n++) {
        const size = (14 + rand(key, 300 + n) * 10) * u;
        const x0 = edgeLine.cx + (rand(key, 310 + n) - 0.5) * 0.7 * edgeLine.slabW;
        const sign = upward ? -1 : 1;
        const roomY = (upward ? edgeY - safe.y1 : safe.y2 - edgeY) - size * 1.5 - 4 * u;
        const travel = Math.min((70 + rand(key, 320 + n) * 90) * u, roomY);
        if (travel < 24 * u) continue;
        const drift = (rand(key, 330 + n) - 0.5) * 80 * u;
        const dx = clamp(drift, safe.x1 + size - x0, safe.x2 - size - x0);
        const delay = Math.min(n * 22, dur * 0.3);
        const q = (t: number) => EASES.out(prog(t, from + delay, dur - delay));
        const edges = [from + delay, from + dur * 0.5, from + dur];
        const shape = ctx.shape(`spark${n}`, from + delay, polygonPath([[-size / 2, -size / 2], [size / 2, -size / 2], [size / 2, size / 2], [-size / 2, size / 2]]), {
          x: frames((t) => x0 + dx * q(t), edges, 0.2, from + delay, from + dur), y: frames((t) => edgeY + sign * (size / 2 + travel * q(t)), edges, 0.2, from + delay, from + dur),
          rz: [[from + delay, 0], [from + dur, 45 * (n % 2 ? 1 : -1)]],
          o: [[from + delay, 1], [from + dur * 0.55, 1], [from + dur, 0, "in"]],
        }, palette[(n + key) % palette.length]!);
        pieces.push({ ...shape, z: 1.6, toMs: from + dur });
      }
    }
  }
  return pieces;
});

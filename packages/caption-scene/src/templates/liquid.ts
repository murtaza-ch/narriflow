import type { DemoScript } from "../demo";
import { type Frames, kf, prog, EASES } from "../ease";
import { sampleFrames } from "../frames";
import { cueDirection, balancedRows, rowVisualOrder, rowWidth } from "../layout";
import { type PathCmd, type ShapePiece, mixColour, type Piece } from "../scene";
import { arcPath, roundedRectPath, sparklePath } from "../shapes";
import { galleryScene } from "./gallery-layout";
import type { SpeechCell } from "./speech-layout";

/**
 * Liquid (`samples/templates/m60-glass.js`, the sample's "Glass"; the classic `glass` preset owns that name).
 * The sample is one flat frosted pill with a 1.5 px rim. The owner asked for it to be much more modern, so this is
 * "liquid glass" (iOS 26 / visionOS) drawn with what libass has: no backdrop blur, no blend modes, so the glass is
 * layered translucent bands.
 *
 * Changes from the sample, and why:
 * - Glass body. A smoky navy base (0.5 alpha) keeps white text at 4.5:1 on dark and busy video (the sample's 16 % white
 *   fill reads on nothing bright), an upper "dome" band with a curved lower edge, a bright specular lens along the top
 *   rim, a cool catch-light arc top-left and a warm one bottom-right (the refraction-like edge tints) and a hairline
 *   rim. One blurred soft shadow under the pill, drawn as its own capsule that widens with the pill.
 * - The pill still grows word by word and re-centres, but every glass layer is the final capsule under a rounded clip
 *   of its own height that opens with each landed word, so the ends stay round at every width (a path cannot animate
 *   its width in libass). It lands as a liquid droplet: narrow and tall, then it springs into a wide capsule.
 * - The key word's thumb is a solid-tinted capsule (the highlight colour darkened so white text stays readable on any
 *   brand colour) with its own dome, specular lens, bright rim and a coloured glow. It slides in from the previous
 *   word like an iOS segmented thumb, stretching as it travels, and snaps into its slot.
 * - Words land with a short chromatic split (cyan and pink copies that close up) and a focus pull (blur to sharp).
 * - Recurring beats on every cue, in the glass's own language: a light sweep that crosses each row when its last word
 *   lands and again as a gentle idle shimmer on long holds, a sparkle glint that catches the rim of every row, and
 *   the exit squashes the capsule flat like a drop.
 * - The sample's cue-indexed nothing: rows are balanced from the words, the key slot grows with its word's width, row
 *   height grows for tall scripts (Devanagari), RTL rows mirror, and every word is whole (no letter splitting).
 * - Brand colours: the text colour and the key tint read against the dark glass (`readsOn`).
 */

export const LIQUID_DEMO: DemoScript = {
  lines: [
    "the:m new:b update:b feels:b like:m glass:h@600",
    "every:b edge:b catches:b light:b",
    "simple:h@600",
    "nothing:b extra:h@540",
    "just:m clear:b",
  ],
  options: { rate: 245, cueGap: 150, lead: 380, tail: 700, gap: 30 },
};

const ROW_H = 150;
const PADX = 56;
const GAP = 26;
const IPAD = 36;
const BODY = 86;
const HERO = 104;
const MAXW = 800;
const ROW_GAP = 16;
const SPACING = -0.02;
// Inter's baseline sits this far below the middle of its line box (cap height centred in the pill).
const BASELINE_BELOW_CENTRE = 0.364;
const SMOKE = "#0B1226";
const COOL = "#4FD8FF";

const hash = (text: string) => {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619);
  return (h >>> 0) / 4294967296;
};

const move = (path: readonly PathCmd[], dx: number, dy: number): PathCmd[] => path.map((command): PathCmd => {
  switch (command[0]) {
    case "Z": return command;
    case "C": return ["C", command[1] + dx, command[2] + dy, command[3] + dx, command[4] + dy, command[5] + dx, command[6] + dy];
    default: return [command[0], command[1] + dx, command[2] + dy];
  }
});

/** A thin lens from -L to L on y = 0, `t` thick on the +y side (negative t bulges up). */
const lens = (L: number, t: number): PathCmd[] => [
  ["M", -L, 0], ["C", -L * 0.55, -t * 0.12, L * 0.55, -t * 0.12, L, 0], ["C", L * 0.55, t, -L * 0.55, t, -L, 0], ["Z"],
];

const K = 0.5522847498307936;

/** The upper half of a capsule inset by `m`, with a soft downward-bowing lower edge: the glass's upper reflection. */
function dome(W: number, H: number, m: number): PathCmd[] {
  const r = H / 2;
  const r2 = r - m;
  const xl = -W / 2 + r;
  const xr = W / 2 - r;
  return [
    ["M", xl - r2, 0],
    ["C", xl - r2, -K * r2, xl - K * r2, -r2, xl, -r2],
    ["L", xr, -r2],
    ["C", xr + K * r2, -r2, xr + r2, -K * r2, xr + r2, 0],
    ["C", xr + r2 * 0.5, H * 0.14, xl - r2 * 0.5, H * 0.14, xl - r2, 0],
    ["Z"],
  ];
}

const capsule = (W: number, H: number, inset = 0) => roundedRectPath(-W / 2 + inset, -H / 2 + inset, W - 2 * inset, H - 2 * inset, (H - 2 * inset) / 2);

interface Placed {
  readonly at: number;
  readonly row: number;
  readonly cx: number;
  readonly slot: number;
  readonly size: number;
  readonly hero: boolean;
  readonly face: "Inter" | "Inter SemiBold";
  readonly advance: number;
  readonly inkTop: number;
  readonly inkBottom: number;
}

export const liquidProgram = galleryScene("liquid", 1290, (ctx) => {
  const { cue, from: cueFrom, to } = ctx.window;
  const c = ctx.input.colours;
  const u = ctx.space.u;
  const { exit, exitAt } = ctx;
  const direction = cueDirection(cue);
  const out = (t: number) => (exit ? EASES.in(prog(t, exitAt, to - exitAt)) : 0);

  // Plan rows from the measured words: a key word's slot is its text plus the thumb's padding.
  const specs = cue.words.map((word) => {
    const hero = word.role === "hero";
    const size = (hero ? HERO : BODY) * u;
    const face = hero ? "Inter" as const : "Inter SemiBold" as const;
    const m = ctx.input.measure(word.text, face, size, SPACING);
    return { hero, size, face, advance: m.advance, inkTop: m.inkTop, inkBottom: m.inkBottom, slot: m.advance + (hero ? 2 * IPAD * u : 0) };
  });
  const gap = GAP * u;
  const rows = balancedRows(specs.map((s) => s.slot), gap, MAXW * u);
  const rowH = rows.map((row) => {
    const half = Math.max(...row.map((at) => {
      const s = specs[at]!;
      const centre = BASELINE_BELOW_CENTRE * s.size;
      return Math.max(-(centre + s.inkTop), centre + s.inkBottom);
    }));
    return Math.max(ROW_H * u, 2 * (half + 22 * u));
  });
  const total = rowH.reduce((sum, h) => sum + h, 0) + (rows.length - 1) * ROW_GAP * u;
  const cx = ctx.space.x(540);
  let top = ctx.space.y(1290) - total / 2;
  const placed: Placed[] = [];
  const rowGeo = rows.map((row, r) => {
    const width = rowWidth(specs.map((s) => s.slot), row, gap);
    const cy = top + rowH[r]! / 2;
    top += rowH[r]! + ROW_GAP * u;
    let x = cx - width / 2;
    for (const i of rowVisualOrder(row.map((at) => cue.words[at]!.text), direction)) {
      const at = row[i]!;
      const s = specs[at]!;
      placed[at] = { at, row: r, cx: x + s.slot / 2, ...s };
      x += s.slot + gap;
    }
    return { row, cy, H: rowH[r]!, W: width + 2 * PADX * u };
  });

  const pieces: Piece[] = [];
  const shape = (suffix: string, from: number, path: readonly PathCmd[], track: ShapePiece["track"], extra: Partial<ShapePiece> = {}): ShapePiece =>
    ({ ...ctx.shape(suffix, from, path, track), ...extra }) as ShapePiece;
  const withExit = (frames: [number, number, ("outExpo" | "in" | "outBack" | "spring" | "out" | "outQuint" | "linear" | "inOut")?][], rest: number, gone: number): Frames => {
    const last = frames[frames.length - 1]![0];
    if (exit && exitAt > last) frames.push([exitAt, rest], [to, gone, "in"]);
    return frames;
  };

  const rowMotion = new Map<number, { shift: (t: number) => number; edges: number[] }>();
  for (const geo of rowGeo) {
    const { row, cy, H, W } = geo;
    const r = H / 2;
    const rowStart = Math.min(...row.map((at) => cue.words[at]!.startMs));
    const rowLast = Math.max(...row.map((at) => cue.words[at]!.startMs));
    const capStart = Math.max(cueFrom, rowStart - 90);
    const D = 440;
    const sxFn = (t: number) => kf(t, [[capStart, 0.62], [capStart + D, 1, "spring"]]) * (1 + 0.05 * out(t));
    const syFn = (t: number) => kf(t, [[capStart, 1.22], [capStart + D, 1, "spring"]]) * (1 - 0.45 * out(t));
    const edges = [capStart, capStart + D, exitAt, to];
    // The capsule grows word by word: a rounded clip of the capsule's own height opens from the row's leading edge to the
    // edge of each landed word's slot (plus the pill padding), so the ends stay round at every width.
    const extents = row.map((at) => {
      const p = placed[at]!;
      return (ctx.rtl ? cx + W / 2 - (p.cx - p.slot / 2) : p.cx + p.slot / 2 - (cx - W / 2)) + PADX * u;
    }).map((value, k, all) => Math.max(value, ...all.slice(0, k)));
    const starts = row.map((at) => Math.max(capStart, cue.words[at]!.startMs - 110));
    const widthFn = (t: number) => extents.reduce((sum, extent, k) => k === 0 ? extent : sum + (extent - extents[k - 1]!) * EASES.outBack(prog(t, starts[k]!, 280)), 0);
    // The row is centred on what has landed, so it eases outward as the capsule widens (the sample's re-centring).
    const shiftFn = (t: number) => ((W - widthFn(t)) / 2) * (ctx.rtl ? -1 : 1);
    const growEdges = [...starts, ...starts.map((at) => at + 280)];
    rowMotion.set(geo.row[0]!, { shift: shiftFn, edges: [capStart, ...growEdges] });
    const pose = {
      x: sampleFrames((t) => cx + shiftFn(t), [...edges, ...growEdges], 0.2, { range: [capStart, to], simplify: true }),
      y: [[capStart, cy]] as Frames,
      sx: sampleFrames(sxFn, edges, 0.004, { range: [capStart, to], simplify: true }),
      sy: sampleFrames(syFn, edges, 0.004, { range: [capStart, to], simplify: true }),
      o: withExit([[capStart, 0], [capStart + 90, 1]], 1, 0),
    };
    const id = (name: string) => `${name}${geo.row[0]}`;
    const lensL = W / 2 - r * 0.9;
    const arcR = r - 4 * u;
    const xl = -W / 2 + r;
    const xr = W / 2 - r;
    const lightCool = mixColour(c.highlight, "#FFFFFF", 0.8);
    const widths = sampleFrames(widthFn, [capStart, ...starts, ...starts.map((at) => at + 280)], 0.4, { range: [capStart, to], simplify: true });
    const near = (frames: Frames, from: number) => frames.map(([t, v, e]) => (e ? [t, from + (ctx.rtl ? -v : v), e] : [t, from + (ctx.rtl ? -v : v)]) as [number, number, ("in")?]);
    const edge = ctx.rtl ? W / 2 : -W / 2;
    const open = near(widths, edge);
    const clip = {
      x1: ctx.rtl ? open : [[capStart, edge]] as Frames,
      x2: ctx.rtl ? [[capStart, edge]] as Frames : open,
      y1: [[capStart, -H / 2]] as Frames,
      y2: [[capStart, H / 2]] as Frames,
      radius: r,
    };
    // The soft shadow is its own blurred capsule that widens with the clip (blur hides the squeeze).
    const shadowX = (t: number) => cx + shiftFn(t) + ((ctx.rtl ? cx + W / 2 - widthFn(t) / 2 : cx - W / 2 + widthFn(t) / 2) - cx) * sxFn(t);
    pieces.push(
      shape(id("shadow"), capStart, capsule(W, H), {
        x: sampleFrames(shadowX, [...edges, ...growEdges], 0.2, { range: [capStart, to], simplify: true }), y: [[capStart, cy + 14 * u]],
        sx: sampleFrames((t) => sxFn(t) * widthFn(t) / W, edges, 0.004, { range: [capStart, to], simplify: true }), sy: pose.sy, o: pose.o,
        blur: [[capStart, 10 * u]],
      }, { z: 0, fill: { colour: "#000000", alpha: 0.4 } }),
      shape(id("smoke"), capStart, capsule(W, H), pose, { z: 1, clip, fill: { colour: mixColour(SMOKE, "#FFFFFF", 0.1), alpha: 0.52 } }),
      shape(id("dome"), capStart, dome(W, H, 3 * u), pose, { z: 2, clip, fill: { colour: "#FFFFFF", alpha: 0.09 } }),
      shape(id("spec"), capStart, move(lens(lensL, 8 * u), 0, -H / 2 + 6 * u), pose, { z: 3, clip, fill: { colour: "#FFFFFF", alpha: 0.55 } }),
      shape(id("catchcool"), capStart, arcPath(xl, 0, arcR, 200, 268), pose, { z: 3, clip, stroke: { widthPx: 3.2 * u, colour: lightCool, alpha: 0.7 } }),
      shape(id("catchwarm"), capStart, arcPath(xr, 0, arcR, 20, 88), pose, { z: 3, clip, stroke: { widthPx: 3.2 * u, colour: c.accent, alpha: 0.55 } }),
      shape(id("rim"), capStart, capsule(W, H, 1 * u), pose, { z: 3, clip, stroke: { widthPx: 1.8 * u, colour: "#FFFFFF", alpha: 0.34 } }),
    );

    // Light sweeps: one when the row's last word lands, then a gentle idle shimmer on long holds.
    const sweepW = H * 0.32;
    const lean = H * 0.35;
    const band: PathCmd[] = [["M", -sweepW / 2 + lean, -H / 2], ["L", sweepW / 2 + lean, -H / 2], ["L", sweepW / 2 - lean, H / 2], ["L", -sweepW / 2 - lean, H / 2], ["Z"]];
    const limit = exit ? exitAt : to;
    const settle = capStart + D;
    // The first sweep is squeezed into the time a short cue has; the idle ones only play when they fit whole.
    const first = Math.max(Math.min(Math.max(rowLast + 260, settle), limit - 560), capStart + 150);
    const sweeps = [{ at: first, dur: Math.min(560, limit - first) }];
    for (let k = 1; k <= 2; k++) sweeps.push({ at: first + 1700 * k, dur: 560 });
    sweeps.forEach(({ at, dur: sweepDur }, k) => {
      if (sweepDur < 130 || at + sweepDur > limit) return;
      const a = -W / 2 - sweepW;
      const b = W / 2 + sweepW;
      const [x0, x1] = ctx.rtl ? [cx + b, cx + a] : [cx + a, cx + b];
      const clip = {
        x1: [[at, cx - W / 2 - x0], [at + sweepDur, cx - W / 2 - x1, "inOut"]] as Frames,
        x2: [[at, cx + W / 2 - x0], [at + sweepDur, cx + W / 2 - x1, "inOut"]] as Frames,
        y1: [[at, -H / 2]] as Frames,
        y2: [[at, H / 2]] as Frames,
        radius: r,
      };
      pieces.push(shape(`${id("sweep")}-${k}`, at, band, { x: [[at, x0], [at + sweepDur, x1, "inOut"]], y: [[at, cy]], o: [[at, 1]] },
        { z: 3, toMs: at + sweepDur, clip, fill: { colour: "#FFFFFF", alpha: k === 0 ? 0.16 : 0.1 } }));
    });

    // A glint that catches the rim as the row completes.
    const side = hash(`${cue.index}:${geo.row[0]}:${cue.words[row[0]!]!.text}`) < 0.5 ? -1 : 1;
    const glintAt = Math.max(capStart + 60, Math.min(rowLast + 20, limit - 380));
    const gd = Math.min(380, limit - glintAt);
    if (gd >= 134) {
      const gx = cx + side * W * 0.22;
      const glintTrack = {
        x: [[glintAt, gx]] as Frames, y: [[glintAt, cy - H / 2 + 3 * u]] as Frames,
        sx: [[glintAt, 0.05], [glintAt + gd * 0.4, 1, "outBack"], [glintAt + gd, 0.05, "in"]] as Frames,
        sy: [[glintAt, 0.05], [glintAt + gd * 0.4, 1, "outBack"], [glintAt + gd, 0.05, "in"]] as Frames,
        rz: [[glintAt, -30], [glintAt + gd, 40]] as Frames,
        o: [[glintAt, 1]] as Frames,
      };
      pieces.push(shape(id("glint"), glintAt, sparklePath(13 * u), glintTrack, { z: 5, toMs: glintAt + gd, fill: { colour: "#FFFFFF", alpha: 0.95 } }));
    }
  }

  // Words: focus pull, chromatic split, and the key word's sliding thumb.
  cue.words.forEach((word, at) => {
    const p = placed[at]!;
    const geo = rowGeo[p.row]!;
    const cellY = geo.cy + BASELINE_BELOW_CENTRE * p.size;
    const en = ctx.enter(word, 320, 60);
    const cell: SpeechCell = {
      at, text: word.text, size: p.size, face: p.face, spacing: SPACING, x: p.cx, baseline: cellY,
      width: p.advance, inkTop: p.inkTop, inkBottom: p.inkBottom,
    };
    const motion = rowMotion.get(geo.row[0]!)!;
    const slide = (dx: (t: number) => number, from: number, until: number) =>
      sampleFrames((t) => p.cx + motion.shift(t) + dx(t), [...motion.edges, from], 0.2, { range: [from, until], simplify: true });
    const rise = en.motion ? 14 * u : 0;
    const settledAt = en.motion ? en.settled : en.from;
    const oFrames: [number, number, ("in")?][] = en.motion ? [[en.from, 0.35], [en.from + Math.min(90, (en.settled - en.from) * 0.5), 1]] : [[en.from, 1]];
    const track = {
      x: slide(() => 0, en.from, to),
      y: ctx.drift(en.from, cellY, rise, settledAt, -10 * u),
      ...(en.motion ? { sx: [[en.from, 0.92], [en.settled, 1, "outQuint"]] as Frames, sy: [[en.from, 0.92], [en.settled, 1, "outQuint"]] as Frames,
        blur: [[en.from, 5 * u], [en.settled, 0, "outQuint"]] as Frames } : {}),
      o: withExit(oFrames, 1, 0),
    };
    const face = ctx.face(cell, en.from, c.primary, track);
    pieces.push({ ...face, z: 6 });

    if (en.motion) {
      const d = (p.hero ? 4.6 : 3.2) * u;
      for (const [suffix, colour, dx] of [["ca", COOL, -d], ["cb", c.accent, d]] as const) {
        const copy = ctx.face(cell, en.from, colour, {
          x: slide((t) => dx * (1 - EASES.outQuint(prog(t, en.from, en.settled - en.from))), en.from, en.settled),
          y: track.y, o: [[en.from, 0.6], [en.settled, 0]],
          ...(en.motion ? { sx: track.sx, sy: track.sy } : {}),
        });
        pieces.push({ ...copy, id: `${ctx.id}:w${at}${suffix}`, z: 5, toMs: en.settled });
      }
    }

    if (!p.hero) return;
    // The thumb: slides from the previous word's slot, stretching, and snaps into this word's slot.
    const prev = placed[at - 1];
    const x1 = p.cx;
    const x0 = prev && prev.row === p.row ? prev.cx : x1;
    const ts = Math.max(cueFrom, word.startMs - 90);
    const D = 420;
    const th = geo.H - 30 * u;
    const tw = p.slot;
    const tsx = (t: number) => kf(t, [[ts, 0.45], [ts + 0.35 * D, 1.22, "out"], [ts + D, 1, "spring"]]) * (1 + 0.05 * out(t));
    const tsy = (t: number) => kf(t, [[ts, 0.7], [ts + 0.35 * D, 0.86, "out"], [ts + D, 1, "spring"]]) * (1 - 0.45 * out(t));
    const edges = [ts, ts + 0.35 * D, ts + D, exitAt, to];
    const pose = {
      x: sampleFrames((t) => kf(t, [[ts, x0], [ts + 0.7 * D, x1, "outExpo"]]) + motion.shift(t), [...motion.edges, ...edges], 0.2, { range: [ts, to], simplify: true }),
      y: [[ts, geo.cy]] as Frames,
      sx: sampleFrames(tsx, edges, 0.004, { range: [ts, to], simplify: true }),
      sy: sampleFrames(tsy, edges, 0.004, { range: [ts, to], simplify: true }),
      o: withExit([[ts, 0], [ts + 80, 1]], 1, 0),
    };
    const tint = mixColour(c.highlight, "#05070F", 0.5);
    const bright = mixColour(c.highlight, "#FFFFFF", 0.55);
    const name = (suffix: string) => `thumb${suffix}${at}`;
    pieces.push(
      shape(name("fill"), ts, capsule(tw, th), pose, { z: 4, fill: { colour: tint, alpha: 0.88 }, shadows: [{ dx: 0, dy: 6 * u, blur: 14 * u, colour: c.highlight, alpha: 0.7 }] }),
      shape(name("dome"), ts, dome(tw, th, 3 * u), pose, { z: 4, fill: { colour: "#FFFFFF", alpha: 0.16 } }),
      shape(name("spec"), ts, move(lens(tw / 2 - th * 0.45, 7 * u), 0, -th / 2 + 6 * u), pose, { z: 4, fill: { colour: "#FFFFFF", alpha: 0.6 } }),
      shape(name("rim"), ts, capsule(tw, th, 1 * u), pose, { z: 4, stroke: { widthPx: 2.4 * u, colour: bright, alpha: 0.95 } }),
    );
  });
  return pieces;
});

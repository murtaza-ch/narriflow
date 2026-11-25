import type { DemoScript } from "../demo";
import { EASES, type Frames, kf, prog } from "../ease";
import { sampleFrames } from "../frames";
import { balancedRows, cueDirection, rowVisualOrder, rowWidth } from "../layout";
import { type PathCmd, type Piece, type ShapePiece, mixColour } from "../scene";
import { arcPath, polylinePath, roundedRectPath, sparklePath } from "../shapes";
import { galleryScene } from "./gallery-layout";
import type { SpeechCell } from "./speech-layout";

/**
 * Liquid (`samples/templates/m60-glass.js`, the sample's "Glass"; the classic `glass` preset owns that name).
 * The sample is one flat frosted pill with a 1.5 px rim. The owner asked for it to be much more modern, so this is
 * "liquid glass" (iOS 26 / visionOS) drawn with what libass has: no backdrop blur, no blend modes, no gradients, so
 * the glass is a few layered translucent bands and not one of them is blurred.
 *
 * Changes from the sample, and why:
 * - Glass body. A deep navy body (0.70 alpha, so white text keeps at least 7:1 even over a white frame), an ice-white
 *   tapered highlight along the top edge, a faint blue reflection along the bottom edge and a hairline rim. The
 *   soft drop shadow is one faint offset capsule and the key word's glow one larger translucent capsule (a blur costs
 *   every frame).
 * - The pill still grows word by word and re-centres, but every glass layer is the final capsule under a rounded clip
 *   of its own height that opens with each landed word, so the ends stay round at every width (a path cannot animate
 *   its width in libass). The backing is there on the first painted word and reaches every later word's slot by that
 *   word's first painted frame; only its contour moves: it lands as a liquid droplet (a touch tall and narrow, then it
 *   springs into a wide capsule). The rim is not clipped but drawn against that same moving contour (two end caps and
 *   two straight runs), so nothing pops onto an edge as the pill widens.
 * - The key word's thumb is a solid-tinted capsule (the highlight colour darkened until the text on it reaches 4.5:1)
 *   with a bright rim and two narrow low-alpha highlights (no broad dome: its edge cut across the face). It slides in from the previous word like an iOS segmented thumb,
 *   stretching as it travels, and snaps into its slot.
 * - Words land with a short chromatic split (cyan and pink copies that close up) and a focus pull (blur to sharp).
 * - Recurring beats on every cue: a light sweep that rides inside the opening capsule (scaled with its morph) when a row's last word lands
 *   (and again as an idle shimmer on long holds), a sparkle glint on the rim that follows the capsule's ends, and an
 *   exit that squashes the capsule flat like a drop.
 * - No cue-indexed tables: rows are balanced from the words and capped by the safe width, the key slot grows with its
 *   word, row height grows for tall scripts, RTL rows mirror, joined scripts stay whole, and a Latin word wider than a
 *   row breaks into readable pieces on their own rows instead of shrinking.
 * - Brand colours: the text colour must read on the two composited fills it sits on, the body glass over a white frame
 *   (#545967) and the key thumb over that body (#355284), both listed in `readsOn` (the shared 3:1 guard). A colour that
 *   passes is painted as given; the thumb's tint darkens until that text reads on it.
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
const BODY_ALPHA = 0.7;
const THUMB_ALPHA = 0.9;
const ICE = "#EAF4FF";
const BLUE = "#7FB0FF";
const COOL = "#4FD8FF";
/** The glass body over a white frame, the lightest ground a caption text has to read against. */
const BODY_WORST = mixColour("#FFFFFF", SMOKE, BODY_ALPHA);

const channel = (hex: string, at: number) => Number.parseInt(hex.slice(1 + 2 * at, 3 + 2 * at), 16) / 255;
const luminance = (hex: string) => {
  const [r, g, b] = [0, 1, 2].map((at) => {
    const v = channel(hex, at);
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

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

const capsule = (W: number, H: number, inset = 0) => roundedRectPath(-W / 2 + inset, -H / 2 + inset, W - 2 * inset, H - 2 * inset, (H - 2 * inset) / 2);

/** One drawn run: a whole word, or one piece of a Latin word too long for a row. */
interface Item {
  readonly at: number;
  /** Null for a whole word. */
  readonly part: number | null;
  readonly text: string;
  readonly hero: boolean;
  readonly size: number;
  readonly face: "Inter" | "Inter SemiBold";
  readonly advance: number;
  readonly inkTop: number;
  readonly inkBottom: number;
  readonly slot: number;
}

interface Placed extends Item {
  readonly row: number;
  readonly cx: number;
}

export const liquidProgram = galleryScene("liquid", 1290, (ctx) => {
  const { cue, from: cueFrom, to, bounds } = ctx.window;
  const c = ctx.input.colours;
  const u = ctx.space.u;
  const { exit, exitAt } = ctx;
  const direction = cueDirection(cue);
  const out = (t: number) => (exit ? EASES.in(prog(t, exitAt, to - exitAt)) : 0);

  // An accepted brand colour (the shared 3:1 guard against the fills in `readsOn`) is painted as given.
  const text = c.primary;
  // The thumb's tint is the highlight darkened until the text on it (the thumb over the body over the lightest ground)
  // reaches 4.5:1. `readsOn` lists the same two composited fills for the default highlight.
  let darkness = 0.5;
  let tint = mixColour(c.highlight, "#05070F", darkness);
  while (darkness < 0.94 && contrast(text, mixColour(BODY_WORST, tint, THUMB_ALPHA)) < 4.5) {
    darkness += 0.06;
    tint = mixColour(c.highlight, "#05070F", darkness);
  }
  const bright = mixColour(c.highlight, "#FFFFFF", 0.55);

  // Plan runs from the measured words: a key word's slot is its text plus the thumb's padding, and a Latin word wider
  // than a row breaks into pieces that each fit one.
  const maxRow = Math.max(160 * u, Math.min(MAXW * u, bounds.x2 - bounds.x1 - 2 * PADX * u));
  const items: Item[] = [];
  cue.words.forEach((word, at) => {
    const hero = word.role === "hero";
    const size = (hero ? HERO : BODY) * u;
    const face = hero ? "Inter" as const : "Inter SemiBold" as const;
    const pad = hero ? 2 * IPAD * u : 0;
    const make = (part: number | null, run: string): Item => {
      const m = ctx.input.measure(run, face, size, SPACING);
      return { at, part, text: run, hero, size, face, advance: m.advance, inkTop: m.inkTop, inkBottom: m.inkBottom, slot: m.advance + pad };
    };
    const whole = make(null, word.text);
    const letters = Array.from(word.text);
    if (whole.slot <= maxRow || letters.length < 8 || !/^[\p{Script=Latin}\p{N}\p{P}]+$/u.test(word.text)) {
      items.push(whole);
      return;
    }
    for (let count = 2; count <= 8; count++) {
      const per = Math.ceil(letters.length / count);
      const runs = Array.from({ length: count }, (_, k) => letters.slice(k * per, (k + 1) * per).join("")).filter(Boolean);
      const made = runs.map((run, k) => make(k, run));
      if (made.every((item) => item.slot <= maxRow) || count === 8) {
        items.push(...made);
        return;
      }
    }
  });
  const gap = GAP * u;
  const rows = balancedRows(items.map((s) => s.slot), gap, maxRow);
  const rowH = rows.map((row) => {
    const half = Math.max(...row.map((i) => {
      const s = items[i]!;
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
    const width = rowWidth(items.map((s) => s.slot), row, gap);
    const cy = top + rowH[r]! / 2;
    top += rowH[r]! + ROW_GAP * u;
    let x = cx - width / 2;
    for (const k of rowVisualOrder(row.map((i) => items[i]!.text), direction)) {
      const i = row[k]!;
      const s = items[i]!;
      placed[i] = { ...s, row: r, cx: x + s.slot / 2 };
      x += s.slot + gap;
    }
    return { row, cy, H: rowH[r]!, W: width + 2 * PADX * u };
  });
  const startOf = (i: number) => cue.words[items[i]!.at]!.startMs;

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
    const rowStart = Math.min(...row.map(startOf));
    const rowLast = Math.max(...row.map(startOf));
    const capStart = Math.max(cueFrom, rowStart - 90);
    const D = 440;
    // The backing is there from the first frame; only its contour moves: a touch tall and narrow, then a spring.
    const sxFn = (t: number) => kf(t, [[capStart, 0.9], [capStart + D, 1, "spring"]]) * (1 + 0.05 * out(t));
    const syFn = (t: number) => kf(t, [[capStart, 1.12], [capStart + D, 1, "spring"]]) * (1 - 0.45 * out(t));
    const edges = [capStart, capStart + D, exitAt, to];
    // The capsule grows word by word: a rounded clip of the capsule's own height opens from the row's leading edge to the
    // edge of each landed run's slot (plus the pill padding), so the ends stay round at every width.
    const extents = row.map((i) => {
      const p = placed[i]!;
      return (ctx.rtl ? cx + W / 2 - (p.cx - p.slot / 2) : p.cx + p.slot / 2 - (cx - W / 2)) + PADX * u;
    }).map((value, k, all) => Math.max(value, ...all.slice(0, k)));
    // The backing reaches each run's slot by that run's first painted frame: the growth ends there and starts up to 110 ms before.
    const lands = row.map((i) => ctx.enter(cue.words[items[i]!.at]!, 320, 60).from);
    const starts = lands.map((land) => Math.max(capStart, land - 110));
    const spans = lands.map((land, k) => Math.max(1, land - starts[k]!));
    const widthFn = (t: number) => Math.min(W, extents.reduce((sum, extent, k) => k === 0 ? extent : sum + (extent - extents[k - 1]!) * EASES.outBack(prog(t, starts[k]!, spans[k]!)), 0));
    // The row is centred on what has landed, so it eases outward as the capsule widens (the sample's re-centring).
    const shiftFn = (t: number) => ((W - widthFn(t)) / 2) * (ctx.rtl ? -1 : 1);
    const growEdges = [...starts, ...starts.map((at, k) => at + spans[k]!)];
    const track = [...edges, ...growEdges];
    rowMotion.set(row[0]!, { shift: shiftFn, edges: [capStart, ...growEdges] });
    const pose = {
      x: sampleFrames((t) => cx + shiftFn(t), track, 0.2, { range: [capStart, to], simplify: true }),
      y: [[capStart, cy]] as Frames,
      sx: sampleFrames(sxFn, edges, 0.004, { range: [capStart, to], simplify: true }),
      sy: sampleFrames(syFn, edges, 0.004, { range: [capStart, to], simplify: true }),
      o: withExit([[capStart, 1]], 1, 0),
    };
    const id = (name: string) => `${name}${row[0]}`;
    const widths = sampleFrames(widthFn, track, 0.4, { range: [capStart, to], simplify: true });
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
    // The revealed contour on the canvas, scaled by the capsule's own morph, for everything that rides it (shadow, rim,
    // sweep and glint) so none of them can drift off the pill's edge.
    const reveal = (t: number) => {
      const w = widthFn(t);
      const scale = sxFn(t);
      const pivot = cx + shiftFn(t);
      const left = pivot + (ctx.rtl ? W / 2 - w : -W / 2) * scale;
      return { left, right: left + w * scale, w: w * scale };
    };
    const frames = (fn: (t: number) => number, tolerance = 0.35) => sampleFrames(fn, track, tolerance, { range: [capStart, to], simplify: true });
    // One faint offset capsule is the shadow; it widens with the pill.
    const shadow = {
      x: frames((t) => { const { left, right } = reveal(t); return (left + right) / 2; }),
      y: [[capStart, cy + 8 * u]] as Frames,
      sx: frames((t) => reveal(t).w / W, 0.004),
      sy: pose.sy,
      o: pose.o,
    };
    const lensL = W / 2 - r * 0.85;
    pieces.push(
      shape(id("shadow"), capStart, capsule(W, H), shadow, { z: 0, fill: { colour: "#000000", alpha: 0.13 } }),
      shape(id("smoke"), capStart, capsule(W, H), pose, { z: 1, clip, fill: { colour: SMOKE, alpha: BODY_ALPHA } }),
      shape(id("spec"), capStart, move(lens(lensL, 15 * u), 0, -H / 2 + 4 * u), pose, { z: 3, clip, fill: { colour: ICE, alpha: 0.48 } }),
      shape(id("under"), capStart, move(lens(lensL * 0.9, -12 * u), 0, H / 2 - 3 * u), pose, { z: 3, clip, fill: { colour: BLUE, alpha: 0.18 } }),
    );
    // The rim is drawn against the same moving contour instead of being clipped: two end caps that ride the leading and
    // trailing edges and two straight runs between them, so nothing pops onto an edge when the pill widens.
    const rr = r - 1 * u;
    const rim = { widthPx: 1.6 * u, colour: "#FFFFFF", alpha: 0.3 };
    const capTrack = (leading: boolean) => ({
      x: frames((t) => { const { left, right } = reveal(t); return (leading !== ctx.rtl ? left + r * sxFn(t) : right - r * sxFn(t)); }),
      y: [[capStart, cy]] as Frames, sx: pose.sx, sy: pose.sy, o: pose.o,
    });
    const runTrack = (dir: -1 | 1) => ({
      x: frames((t) => { const { left, right } = reveal(t); return (left + right) / 2; }),
      y: frames((t) => cy + dir * rr * syFn(t)),
      // The run is drawn at the final length and scaled down, so its stroke reach (counted in local px) stays small.
      sx: frames((t) => Math.max(0.001, reveal(t).w - 2 * r * sxFn(t)) / W, 0.002),
      o: pose.o,
    });
    pieces.push(
      shape(id("rimlead"), capStart, ctx.rtl ? arcPath(0, 0, rr, -90, 90) : arcPath(0, 0, rr, 90, 270), capTrack(true), { z: 3, stroke: rim }),
      shape(id("rimtrail"), capStart, ctx.rtl ? arcPath(0, 0, rr, 90, 270) : arcPath(0, 0, rr, -90, 90), capTrack(false), { z: 3, stroke: rim }),
      shape(id("rimtop"), capStart, polylinePath([[-W / 2, 0], [W / 2, 0]]), runTrack(-1), { z: 3, stroke: rim }),
      shape(id("rimbottom"), capStart, polylinePath([[-W / 2, 0], [W / 2, 0]]), runTrack(1), { z: 3, stroke: rim }),
    );

    // Light sweep: rides inside the opening capsule once the row's last word has landed, then an idle shimmer on long holds.
    const sweepW = H * 0.32;
    const lean = H * 0.35;
    const band: PathCmd[] = [["M", -sweepW / 2 + lean, -H / 2], ["L", sweepW / 2 + lean, -H / 2], ["L", sweepW / 2 - lean, H / 2], ["L", -sweepW / 2 - lean, H / 2], ["Z"]];
    const limit = exit ? exitAt : to;
    const settle = capStart + 300;
    const first = Math.max(Math.min(Math.max(rowLast + 260, settle), limit - 560), settle);
    const sweeps = [{ at: first, dur: Math.min(560, limit - first) }];
    for (let k = 1; k <= 2; k++) sweeps.push({ at: first + 1700 * k, dur: 560 });
    sweeps.forEach(({ at, dur }, k) => {
      if (dur < 130 || at + dur > limit) return;
      const sweepEdges = [at, at + dur, ...growEdges];
      const xs = (t: number) => {
        const { left, right, w } = reveal(t);
        const p = EASES.inOut(prog(t, at, dur));
        return ctx.rtl ? right + sweepW - p * (w + 2 * sweepW) : left - sweepW + p * (w + 2 * sweepW);
      };
      const local = (pick: "left" | "right") => sampleFrames((t) => reveal(t)[pick] - xs(t), sweepEdges, 0.3, { range: [at, at + dur], simplify: true });
      const rows = (sign: -1 | 1) => sampleFrames((t) => (sign * H * syFn(t)) / 2, sweepEdges, 0.3, { range: [at, at + dur], simplify: true });
      const sweepClip = { x1: local("left"), x2: local("right"), y1: rows(-1), y2: rows(1), radius: r * syFn(at) };
      pieces.push(shape(`${id("sweep")}-${k}`, at, band, { x: sampleFrames(xs, sweepEdges, 0.3, { range: [at, at + dur], simplify: true }), y: [[at, cy]], o: [[at, 1]] },
        { z: 3, toMs: at + dur, clip: sweepClip, fill: { colour: "#FFFFFF", alpha: k === 0 ? 0.16 : 0.1 } }));
    });

    // A glint on the top rim, riding the capsule's moving end.
    const side = hash(`${cue.index}:${row[0]}:${items[row[0]!]!.text}`) < 0.5 ? -1 : 1;
    const glintAt = Math.max(capStart + 60, Math.min(rowLast + 20, limit - 340));
    const gd = Math.min(340, limit - glintAt);
    if (gd >= 100) {
      const glintEdges = [glintAt, glintAt + gd, ...growEdges];
      const gx = (t: number) => {
        const { left, right, w } = reveal(t);
        return side < 0 ? left + w * 0.2 : right - w * 0.2;
      };
      const pulse = [[glintAt, 0.05], [glintAt + gd * 0.4, 1, "outBack"], [glintAt + gd, 0.05, "in"]] as Frames;
      const glintTrack = {
        x: sampleFrames(gx, glintEdges, 0.3, { range: [glintAt, glintAt + gd], simplify: true }),
        y: [[glintAt, cy - H / 2 + 3 * u]] as Frames,
        sx: pulse, sy: pulse,
        rz: [[glintAt, -30], [glintAt + gd, 40]] as Frames,
        o: [[glintAt, 1]] as Frames,
      };
      pieces.push(shape(id("glint"), glintAt, sparklePath(13 * u), glintTrack, { z: 5, toMs: glintAt + gd, fill: { colour: "#FFFFFF", alpha: 0.95 } }));
    }
  }

  // Words: focus pull, chromatic split, and the key word's sliding thumb.
  placed.forEach((p, index) => {
    const word = cue.words[p.at]!;
    const geo = rowGeo[p.row]!;
    const cellY = geo.cy + BASELINE_BELOW_CENTRE * p.size;
    const en = ctx.enter(word, 320, 60);
    const cell: SpeechCell = {
      at: p.at, text: p.text, size: p.size, face: p.face, spacing: SPACING, x: p.cx, baseline: cellY,
      width: p.advance, inkTop: p.inkTop, inkBottom: p.inkBottom,
    };
    const name = p.part === null ? `w${p.at}` : `w${p.at}l${p.part}`;
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
    const face = ctx.face(cell, en.from, text, track);
    pieces.push({ ...face, id: `${ctx.id}:${name}`, z: 6 });

    if (en.motion) {
      const d = (p.hero ? 4.6 : 3.2) * u;
      for (const [suffix, colour, dx] of [["ca", COOL, -d], ["cb", c.accent, d]] as const) {
        const copy = ctx.face(cell, en.from, colour, {
          x: slide((t) => dx * (1 - EASES.outQuint(prog(t, en.from, en.settled - en.from))), en.from, en.settled),
          y: track.y, o: [[en.from, 0.6], [en.settled, 0]],
          sx: track.sx, sy: track.sy,
        });
        pieces.push({ ...copy, id: `${ctx.id}:${name}${suffix}`, z: 5, toMs: en.settled });
      }
    }

    if (!p.hero) return;
    // The thumb: slides from the previous run's slot, stretching, and snaps into this run's slot.
    const prev = placed[index - 1];
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
      o: withExit([[ts, 0.7], [ts + 60, 1]], 1, 0),
    };
    const tag = (suffix: string) => `thumb${suffix}${index}`;
    pieces.push(
      shape(tag("glow"), ts, capsule(tw + 12 * u, th + 12 * u), pose, { z: 4, fill: { colour: c.highlight, alpha: 0.13 } }),
      shape(tag("fill"), ts, capsule(tw, th), pose, { z: 4, fill: { colour: tint, alpha: THUMB_ALPHA } }),
      shape(tag("spec"), ts, move(lens(tw / 2 - th * 0.45, 8 * u), 0, -th / 2 + 5 * u), pose, { z: 4, fill: { colour: "#FFFFFF", alpha: 0.34 } }),
      shape(tag("under"), ts, move(lens(tw / 2 - th * 0.5, -6 * u), 0, th / 2 - 4 * u), pose, { z: 4, fill: { colour: bright, alpha: 0.24 } }),
      shape(tag("rim"), ts, capsule(tw, th, 1 * u), pose, { z: 4, stroke: { widthPx: 2.4 * u, colour: bright, alpha: 0.95 } }),
    );
  });
  return pieces;
});

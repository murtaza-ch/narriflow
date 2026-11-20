import type { DemoScript } from "../demo";
import { EASES, type Ease, type Frames, prog } from "../ease";
import type { SceneCue, SceneInput, SceneProgram } from "../input";
import { balancedRows, clampToSafeArea, cueDirection, fitScale, rowVisualOrder, rowWidth, sceneSpace } from "../layout";
import type { Clip, Piece, ShapePiece, TextPiece } from "../scene";
import { centredRect, polygonPath } from "../shapes";
import { sampleFrames } from "../frames";

/**
 * Signal (`samples/templates/40-signal.js`): a terminal that glitches when it matters. The support
 * words type onto one monospaced line behind a block cursor; the hero lands with a stepped RGB split
 * and two sliced bands, four brackets lock onto it, a scanline reads it once, and on exit everything
 * collapses vertically (the hero to a 4 px line, then gone).
 *
 * Geometry is the sample's, read from its layout in Chrome (`.scratch/motion-captions/tools/probe-sample.ts`):
 * a support row is JetBrains Mono at 52 px (64 px when the cue has no hero) in cells of 0.6 em, centred
 * on its final width so typing never shifts it; the hero's "cap box" is a fixed 0.165 / 0.705 em slice of
 * a Chakra Petch line box (the sample's own constants), centred on y 1340, and its baseline sits
 * 0.8368 em below the line box's top. Everything about the glitch is time-sampled and stepped, never eased.
 *
 * Pieces: a word is one text piece cut by a stepped clip (the typing); the cursor is a rectangle that
 * steps along the line and blinks through its opacity; the hero is seven text pieces (cyan and magenta
 * copies, the white copy in three clipped parts while it is sliced, the two thrown slices) and the
 * brackets, scan line, counter and tube-off line are shapes.
 */

export const SIGNAL_DEMO: DemoScript = {
  lines: [
    "stop memorizing+380 syntax.",
    "the:m real:b skill:b is:m TASTE:h@580",
    "you:m decide:b what:m SHIPS:h@560",
    "the:m rest?:b NOISE:h@600",
  ],
  options: { lead: 300, tail: 700, cueGap: 160 },
};

const ANCHOR_LINE = 1290;
const MONO = "JetBrains Mono Medium" as const;
const HERO_FACE = "Chakra Petch" as const;
const ROW_FS = 52;
const SOLO_FS = 64;
/** Baseline of a mono row below its box top at the nominal size (probe: 49.99 at 52 px, 62.0 at 64 px). */
const ROW_BASELINE = { [ROW_FS]: 49.99, [SOLO_FS]: 62.0 } as const;
const HERO_FS = 190;
const HERO_MAX_W = 760;
const HERO_Y = 1340;
const ROW_Y = 1146;
const SOLO_Y = 1290;
const PAD = 26;
const ARM = 46;
const STROKE = 5;
const LETTER_SPACING = 0.01;
/** The hero's cap box inside its `line-height: 1` box (em): the sample's own constants. */
const CAP_TOP = 0.165;
const CAP_H = 0.705;
const HERO_BASELINE = 0.8368;
const COUNTER = { size: 28, spacing: 0.04, baseline: 24, rise: 44 } as const;
/** Widest a support row may be before it wraps, share of the canvas width (the safe area). */
const MAX_ROW_SHARE = 0.9;

const SPLIT_A = "#00F0FF";
const SPLIT_B = "#FF2BD6";
const SHADE = "#000804";
const SHADE_ALPHA = 0.9;
const BLACK = "#000000";
/** The RGB split in hard 45 ms steps: wide, swapped, narrow, then a permanent 3 px fringe. */
const SPLIT = [16, -9, 5] as const;
const FRINGE = 3;
const STEP_MS = 45;
const SLICE_MS = 90;
/** The two bands of the word thrown sideways, as shares of the cap box. */
const BANDS = [[0.3, 0.44], [0.62, 0.74]] as const;
const EXIT_MS = 190;
const COLLAPSE_MS = 110;
const TYPE_MS_PER_CHAR = 28;
const BLINK_AFTER_MS = 300;
const BLINK_MS = 260;

/** The sample's RGB split at `dt` ms after the hero's lead (`hero.start - 30`). */
export function signalSplitPx(dt: number): number {
  return dt < 0 ? 0 : (SPLIT[Math.floor(dt / STEP_MS)] ?? FRINGE);
}

/** How many characters of a support word the sample has typed at `t`. */
export function signalTyped(t: number, startMs: number, endMs: number, n: number): number {
  if (t < startMs - 40) return 0;
  const span = Math.max(n * TYPE_MS_PER_CHAR, (endMs - startMs) * 0.8);
  return Math.min(n, 1 + Math.floor(((t - startMs + 40) / span) * n));
}

/** A hard-stepped track: frames carry `fn`'s value, with a 1 ms ramp into every change found among `candidates`. */
function stepped(fn: (t: number) => number, from: number, to: number, candidates: readonly number[]): Frames {
  const times = [...new Set(candidates.map((t) => Math.ceil(t)))].filter((t) => t > from && t < to).sort((a, b) => a - b);
  const frames: [number, number][] = [[from, fn(from)]];
  for (const t of times) {
    if (fn(t) === fn(t - 1)) continue;
    if (frames[frames.length - 1]![0] < t - 1) frames.push([t - 1, fn(t - 1)]);
    frames.push([t, fn(t)]);
  }
  return frames;
}

interface Window {
  readonly from: number;
  readonly to: number;
  readonly ease: Ease;
}

/**
 * A track that is `fn` made of eased windows: one segment per window (exact, the ease and all) when
 * the windows sit inside `[from, to]` and do not overlap, else sampled.
 */
function windowed(fn: (t: number) => number, windows: readonly Window[], from: number, to: number, tolerance = 0.05): Frames {
  const inside = windows.filter((w) => w.to > from && w.from < to).sort((a, b) => a.from - b.from);
  const clean = inside.every((w, at) => w.from >= from && w.to <= to && (at === 0 || w.from >= inside[at - 1]!.to));
  if (!clean) return sampleFrames(fn, [from, to, ...inside.flatMap((w) => [w.from, w.to]).filter((t) => t > from && t < to)], tolerance);
  const frames: [number, number, Ease?][] = [[from, fn(from)]];
  for (const w of inside) {
    if (w.from > frames[frames.length - 1]![0]) frames.push([w.from, fn(w.from)]);
    frames.push([w.to, fn(w.to), w.ease]);
  }
  return frames;
}

const still = (at: number, value: number): Frames => [[at, value]];

interface Typed {
  readonly word: SceneCue["words"][number];
  readonly n: number;
  readonly span: number;
  readonly left: number;
  readonly width: number;
  readonly rowCentreY: number;
  readonly baselineY: number;
}

function buildCue(cue: SceneCue, input: SceneInput, number: number, total: number): Piece[] {
  const space = sceneSpace(input, ANCHOR_LINE);
  const { u, canvas } = space;
  const rtl = cueDirection(cue) === "rtl";
  const hero = cue.words.find((word) => word.role === "hero") ?? null;
  const support = cue.words.filter((word) => word !== hero);
  const cx = space.x(540);

  const exitFrom = cue.endMs - EXIT_MS;
  const exitTo = exitFrom + COLLAPSE_MS;
  const pieces: Piece[] = [];
  /** 1 - the collapse's ease, the typed words' scale and opacity, and the brackets' opacity. */
  const squash = (t: number) => EASES.out(prog(t, exitFrom, COLLAPSE_MS));
  const collapseWindow: Window = { from: exitFrom, to: exitTo, ease: "out" };

  // ---- The typed line ---------------------------------------------------------------------------
  if (support.length > 0) {
    const nominal = (hero ? ROW_FS : SOLO_FS) as typeof ROW_FS | typeof SOLO_FS;
    const maxRow = MAX_ROW_SHARE * canvas.width;
    const widthsAt = (size: number) => support.map((word) => input.measure(word.text, MONO, size, 0).advance);
    let size = nominal * u;
    // One line when it fits; a word wider than a row shrinks the line, the rest wraps evenly.
    // The block cursor sits one cell past the end of a row, so a row keeps a cell of the width free.
    size *= fitScale(Math.max(...widthsAt(size)) + input.measure("0", MONO, size, 0).advance, maxRow);
    const widths = widthsAt(size);
    const cell = input.measure("0", MONO, size, 0).advance;
    const rows = balancedRows(widths, cell, maxRow - cell);
    const pitch = 1.24 * size;
    const baseRowY = space.y(hero ? ROW_Y : SOLO_Y);
    const rowCentre = (row: number) => (hero ? baseRowY - (rows.length - 1 - row) * pitch : baseRowY + (row - (rows.length - 1) / 2) * pitch);
    const baselineOffset = (ROW_BASELINE[nominal] / nominal) * size;
    const lineTop = (row: number) => rowCentre(row) - 0.62 * size;

    const typed: Typed[] = new Array(support.length);
    rows.forEach((row, rowIndex) => {
      const ordered = rowVisualOrder(row.map((at) => support[at]!.text), rtl ? "rtl" : "ltr").map((at) => row[at]!);
      const total = rowWidth(widths, ordered, cell);
      // The sample rounds the row's left edge to a whole px.
      let x = space.x(Math.round(540 - total / u / 2));
      for (const at of ordered) {
        const word = support[at]!;
        const n = [...word.text].length;
        typed[at] = {
          word,
          n,
          span: Math.max(n * TYPE_MS_PER_CHAR, (word.endMs - word.startMs) * 0.8),
          left: x,
          width: widths[at]!,
          rowCentreY: rowCentre(rowIndex),
          baselineY: lineTop(rowIndex) + baselineOffset,
        };
        x += widths[at]! + cell;
      }
    });

    const shownOf = (item: Typed, t: number) => signalTyped(t, item.word.startMs, item.word.endMs, item.n);
    const shadow = [
      { dx: 0, dy: 3 * u, blur: 0, colour: SHADE, alpha: SHADE_ALPHA },
      { dx: 0, dy: 0, blur: 9 * u, colour: BLACK, alpha: 0.85 },
    ];
    const wordEnd = exitTo;

    typed.forEach((item, at) => {
      const start = Math.ceil(item.word.startMs - 40);
      if (start >= wordEnd) return;
      // The sample's `inset(-20% r% -20% -4%)` of the word's 1.24 em line box, in canvas px.
      const top = item.rowCentreY - 0.62 * size;
      const height = 1.24 * size;
      const edge = (t: number) => (item.width * shownOf(item, t)) / item.n;
      const steps = Array.from({ length: item.n }, (_, k) => item.word.startMs - 40 + (k * item.span) / item.n);
      const reveal = (t: number) => (rtl ? item.left + item.width - edge(t) : item.left + edge(t));
      const clip: Clip = {
        x1: rtl ? stepped(reveal, start, wordEnd, steps) : still(start, item.left - 0.04 * item.width),
        x2: rtl ? still(start, item.left + item.width * 1.04) : stepped(reveal, start, wordEnd, steps),
        y1: still(start, top - 0.2 * height),
        y2: still(start, top + height + 0.2 * height),
      };
      const fade = (t: number) => 1 - squash(t);
      pieces.push({
        id: `signal:${number}:w${at}`,
        kind: "text",
        z: 1,
        fromMs: start,
        toMs: wordEnd,
        track: {
          x: still(start, item.left + item.width / 2),
          y: still(start, item.rowCentreY),
          sy: windowed(fade, [collapseWindow], start, wordEnd),
          o: windowed(fade, [collapseWindow], start, wordEnd),
        },
        clip,
        origin: { dx: item.width / 2, dy: item.rowCentreY - item.baselineY },
        text: item.word.text,
        face: MONO,
        sizePx: size,
        letterSpacingEm: 0,
        fill: input.colours.primary,
        shadows: shadow,
        anchor: "baseline-left",
        language: cue.language,
      } satisfies TextPiece);
    });

    // The cursor: at the end of the last word that has begun typing; solid while typing, then blinking.
    const cursorFrom = Math.ceil(Math.min(...support.map((word) => word.startMs)) - 40);
    const cursorTo = exitFrom;
    if (cursorTo > cursorFrom) {
      const state = (t: number) => {
        let last: Typed | null = null;
        let shown = 0;
        for (const item of typed) {
          const k = shownOf(item, t);
          if (k > 0) {
            last = item;
            shown = k;
          }
        }
        if (!last) return null;
        const idle = t - (last.word.startMs - 40 + last.span);
        const blinkOn = idle < BLINK_AFTER_MS || Math.floor((idle - BLINK_AFTER_MS) / BLINK_MS) % 2 === 1;
        const reach = (last.width * shown) / last.n;
        return { x: rtl ? last.left + last.width - reach - cell : last.left + reach, y: last.rowCentreY, on: blinkOn };
      };
      const candidates: number[] = [];
      typed.forEach((item, at) => {
        const typingEnd = item.word.startMs - 40 + item.span;
        const horizon = Math.min(cursorTo, typed[at + 1] ? typed[at + 1]!.word.startMs - 40 : cursorTo);
        for (let k = 0; k < item.n; k++) candidates.push(item.word.startMs - 40 + (k * item.span) / item.n);
        for (let t = typingEnd + BLINK_AFTER_MS; t < horizon; t += BLINK_MS) candidates.push(t);
      });
      const cursorHeight = 1.18 * size;
      pieces.push({
        id: `signal:${number}:cursor`,
        kind: "shape",
        z: 2,
        fromMs: cursorFrom,
        toMs: cursorTo,
        track: {
          x: stepped((t) => (state(t)?.x ?? typed[0]!.left) + cell / 2, cursorFrom, cursorTo, candidates),
          y: stepped((t) => (state(t)?.y ?? typed[0]!.rowCentreY) - 0.01 * size, cursorFrom, cursorTo, candidates),
          o: stepped((t) => (state(t)?.on ? 1 : 0), cursorFrom, cursorTo, candidates),
        },
        path: centredRect(cell, cursorHeight),
        fill: { colour: input.colours.accent },
        shadows: [{ dx: 0, dy: 0, blur: 8 * u, colour: input.colours.accent, alpha: 0.45 }],
      } satisfies ShapePiece);
    }
  }

  // ---- The hero ---------------------------------------------------------------------------------
  if (hero && hero.startMs - 30 < exitTo) {
    const lead = hero.startMs - 30;
    const text = hero.text.toUpperCase();
    const nominal = HERO_FS * u;
    const natural = input.measure(text, HERO_FACE, nominal, LETTER_SPACING).advance + LETTER_SPACING * nominal;
    // A long word shrinks to the width, the sample's one fit.
    const size = nominal * fitScale(natural, HERO_MAX_W * u);
    const width = input.measure(text, HERO_FACE, size, LETTER_SPACING).advance + LETTER_SPACING * size;
    const heroY = space.y(HERO_Y);
    const capH = CAP_H * size;
    const boxTop = heroY - (CAP_TOP + CAP_H / 2) * size;
    const baselineY = boxTop + HERO_BASELINE * size;
    const left = cx - width / 2 - PAD * u;
    const right = cx + width / 2 + PAD * u;
    const top = heroY - capH / 2 - PAD * u;
    const bottom = heroY + capH / 2 + PAD * u;
    const bandY = BANDS.map(([a, b]) => [boxTop + (CAP_TOP + CAP_H * a) * size, boxTop + (CAP_TOP + CAP_H * b) * size] as const);

    // Slices and the white copy's holes last 90 ms, or until the exit starts to scale the word.
    const slicing = Math.max(lead, Math.min(lead + SLICE_MS, exitFrom));
    const dtOf = (t: number) => t - lead;

    // The hero collapses to a 4 px line about the cap box's centre: scale Y of every copy.
    const lineHeight = 4 * u;
    const floor = lineHeight / capH;
    const collapse = (t: number) => Math.max(floor, 1 - squash(t));
    // The scale hits the floor where `1 - out(p) = floor`.
    const floorAt = exitFrom + COLLAPSE_MS * (1 - Math.cbrt(Math.min(1, floor)));
    const collapseFrames = (from: number): Frames => sampleFrames(collapse, [from, exitFrom, floorAt, exitTo].filter((t) => t >= from), 0.002);
    const common = {
      kind: "text" as const,
      face: HERO_FACE,
      sizePx: size,
      letterSpacingEm: LETTER_SPACING,
      anchor: "baseline-center" as const,
      language: cue.language,
      text,
      // The pivot is the cap box's centre on the word's centre line; the anchor is the baseline's middle (less the trailing spacing CSS adds).
      origin: { dx: (LETTER_SPACING * size) / 2, dy: heroY - baselineY },
    };
    const whole = (id: string, z: number, fill: string, from: number, to: number, x: Frames, extra: Partial<TextPiece> = {}): TextPiece => ({
      ...common,
      id: `signal:${number}:${id}`,
      z,
      fromMs: from,
      toMs: to,
      track: { x, y: still(from, heroY), ...(to > exitFrom ? { sy: collapseFrames(from) } : {}) },
      fill,
      ...extra,
    });
    const fringe = (sign: number): Frames => stepped((t) => cx + sign * signalSplitPx(dtOf(t)) * u, lead, exitTo, [lead + STEP_MS, lead + 2 * STEP_MS, lead + 3 * STEP_MS]);
    const glow = [{ dx: 0, dy: 0, blur: 15 * u, colour: BLACK, alpha: 0.55 }];
    const band = (index: 0 | 1, sign: number, firstX: number, thenX: number): TextPiece => ({
      ...common,
      id: `signal:${number}:slice${index === 0 ? "A" : "B"}`,
      z: 5,
      fromMs: lead,
      toMs: slicing,
      track: { x: stepped((t) => cx + (dtOf(t) < STEP_MS ? firstX : thenX) * u * sign, lead, slicing, [lead + STEP_MS]), y: still(lead, heroY) },
      clip: { x1: still(lead, 0), x2: still(lead, canvas.width), y1: still(lead, bandY[index]![0]), y2: still(lead, bandY[index]![1]) },
      fill: input.colours.highlight,
    });

    pieces.push(whole("cyan", 3, SPLIT_A, lead, exitTo, fringe(-1)));
    pieces.push(whole("magenta", 3, SPLIT_B, lead, exitTo, fringe(1)));
    // The white copy: in parts while it is sliced (a hole per band), whole afterwards.
    if (slicing > lead) {
      const holes = (x1: number, y1: number, x2: number, y2: number, inverse?: boolean): Clip => ({ x1: still(lead, x1), y1: still(lead, y1), x2: still(lead, x2), y2: still(lead, y2), ...(inverse ? { inverse } : {}) });
      pieces.push(whole("whiteOut", 4, input.colours.highlight, lead, slicing, still(lead, cx), { clip: holes(0, bandY[0]![0], canvas.width, bandY[1]![1], true), shadows: glow }));
      pieces.push(whole("whiteMid", 4, input.colours.highlight, lead, slicing, still(lead, cx), { clip: holes(0, bandY[0]![1], canvas.width, bandY[1]![0]), shadows: glow }));
    }
    if (slicing < exitTo) pieces.push(whole("white", 4, input.colours.highlight, slicing, exitTo, still(slicing, cx), { shadows: glow }));
    if (slicing > lead) {
      pieces.push(band(0, 1, 26, -18));
      pieces.push(band(1, -1, 26, -14));
    }

    // Four brackets snap in from 44 px outside, then follow the collapse to the centre line.
    const snapWindow: Window = { from: lead, to: lead + 160, ease: "outExpo" };
    const snap = (t: number) => 44 * u * (1 - EASES.outExpo(prog(t, lead, 160)));
    const squeezeTo = (bottom - top) / 2 - (ARM * u) / 2;
    const corner = (sx: number, sy: number) => {
      const arm = ARM * u;
      const stroke = STROKE * u;
      const h = arm / 2;
      const px = sx * h;
      const py = sy * h;
      const path = polygonPath([[px, py], [px - sx * arm, py], [px - sx * arm, py - sy * stroke], [px - sx * stroke, py - sy * stroke], [px - sx * stroke, py - sy * arm], [px, py - sy * arm]]);
      const centreX = sx < 0 ? left + h : right - h;
      const centreY = sy < 0 ? top + h : bottom - h;
      return {
        path,
        x: windowed((t) => centreX + sx * snap(t), [snapWindow], lead, exitTo),
        y: windowed((t) => centreY + sy * snap(t) - sy * squash(t) * squeezeTo, [snapWindow, collapseWindow], lead, exitTo),
      };
    };
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([sx, sy], at) => {
      const { path, x, y } = corner(sx!, sy!);
      pieces.push({
        id: `signal:${number}:bracket${at}`,
        kind: "shape",
        z: 6,
        fromMs: lead,
        toMs: exitTo,
        track: { x, y, o: windowed((t) => 1 - squash(t), [collapseWindow], lead, exitTo) },
        path,
        fill: { colour: input.colours.accent },
        shadows: [{ dx: 0, dy: 0, blur: 5 * u, colour: input.colours.accent, alpha: 0.35 }],
      } satisfies ShapePiece);
    });

    // One scanline pass, top to bottom (linear), 40 ms after the lead.
    const scanFrom = hero.startMs + 40 + 1;
    const scanTo = Math.min(hero.startMs + 360, exitTo);
    if (scanTo > scanFrom) {
      pieces.push({
        id: `signal:${number}:scan`,
        kind: "shape",
        z: 7,
        fromMs: scanFrom,
        toMs: scanTo,
        track: { x: still(scanFrom, cx), y: [[hero.startMs + 40, top + u], [hero.startMs + 360, bottom + u]] },
        path: centredRect(right - left - 20 * u, 2 * u),
        fill: { colour: input.colours.accent },
        shadows: [{ dx: 0, dy: 0, blur: 6 * u, colour: input.colours.accent, alpha: 0.7 }],
      } satisfies ShapePiece);
    }

    // The cue counter above the top-left bracket, there from 60 ms after the hero starts.
    const counterFrom = hero.startMs + 61;
    if (counterFrom < exitTo) {
      pieces.push({
        id: `signal:${number}:counter`,
        kind: "text",
        z: 8,
        fromMs: counterFrom,
        toMs: exitTo,
        track: { x: still(counterFrom, left), y: still(counterFrom, top - (COUNTER.rise - COUNTER.baseline) * u), o: windowed((t) => 1 - prog(t, exitFrom, COLLAPSE_MS), [{ from: exitFrom, to: exitTo, ease: "linear" }], counterFrom, exitTo) },
        text: `${String(number + 1).padStart(2, "0")}/${String(total).padStart(2, "0")}`,
        face: MONO,
        sizePx: COUNTER.size * u,
        letterSpacingEm: COUNTER.spacing,
        fill: input.colours.accent,
        shadows: [{ dx: 0, dy: 2 * u, blur: 0, colour: SHADE, alpha: SHADE_ALPHA }],
        anchor: "baseline-left",
        language: cue.language,
      } satisfies TextPiece);
    }

    // The tube-off line the hero collapses into: from the collapse's last quarter until it shrinks away.
    const lineFrom = Math.max(lead, Math.ceil(exitFrom + 0.75 * COLLAPSE_MS));
    const lineTo = cue.endMs - 30;
    if (lineTo > lineFrom) {
      pieces.push({
        id: `signal:${number}:line`,
        kind: "shape",
        z: 9,
        fromMs: lineFrom,
        toMs: lineTo,
        track: {
          x: still(lineFrom, cx),
          y: still(lineFrom, heroY),
          sx: windowed((t) => 1 - EASES.in(prog(t, cue.endMs - 90, 60)), [{ from: cue.endMs - 90, to: lineTo, ease: "in" }], lineFrom, lineTo),
        },
        path: centredRect(width, lineHeight),
        fill: { colour: input.colours.highlight },
        shadows: [
          { dx: 0, dy: 0, blur: 7 * u, colour: input.colours.accent, alpha: 0.75 },
          { dx: 0, dy: 0, blur: 7 * u, colour: input.colours.accent, alpha: 0.4 },
        ],
      } satisfies ShapePiece);
    }
  }

  return clampToSafeArea(pieces, space.safe, input.measure);
}

export const signalProgram: SceneProgram = {
  build(input) {
    return { pieces: input.cues.flatMap((cue, number) => buildCue(cue, input, number, input.cues.length)) };
  },
};

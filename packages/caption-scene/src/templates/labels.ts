import type { DemoScript } from "../demo";
import { type Frames, EASES, clamp, prog } from "../ease";
import { SCENE_DEFAULT_FPS, exportFrameAtOrBefore, paintedFrameCount, sceneSampleRate } from "../frame-grid";
import { sampleFrames } from "../frames";
import type { SceneCue, SceneInput, SceneProgram } from "../input";
import { type SceneSpace, balancedRows, clampToSafeArea, cueDirection, rowVisualOrder, sceneSpace } from "../layout";
import { type Box, type Piece, type ShapePiece, type TextPiece, type Track, evaluatePiece, pieceBounds } from "../scene";
import { polygonPath, polylinePath, rectPath } from "../shapes";
import { speechLaneSpace, speechWindows } from "./speech-layout";

/**
 * Labels (`samples/templates/m26-labels.js`, after Motion Array "Titles Typography"): every spoken word is its own tight white
 * label, cut like a strip off a label maker. Each flies in tilted from the side as its word is said and straightens with a small
 * spring, and the labels pile into overlapping rows. The key word gets a yellow label that lands bigger (1.2x) and stays crooked.
 * On the exit the labels collapse onto their baseline, last word first.
 *
 * Geometry is the sample's, in its 1080 x 1920 frame: Montserrat ExtraBold 100 px (114 px key word) at -0.02 em on labels padded
 * 18 / 3 / 6 px (22 / 5 / 7 key) in a 1.1 line box, 10 px apart, rows 118 px apart (the labels overlap their neighbours a little),
 * a row nudged by a few px, the block centred on y 1290. Two box shadows (a hard 9 px one and a soft 16 px one).
 *
 * What changed from the sample, and why (gallery-3 brief, 2026-11-24):
 * - Rows came from a baked `breaks` table by cue index, and the tilt of the key word from `KEY_TILT[ci]`. Rows now come from the words
 *   (balanced wraps of the labels' real widths), the row nudge cycles by a row + cue counter, the key word's tilt alternates its sign
 *   by a key-word counter with a seeded 5-6 degree size, and the side a label flies in from alternates by word and cue. The seeded
 *   hash is FNV-1a (never `Math.random`).
 * - Fit: rows were `nowrap` with no fit. A label wider than the safe width shrinks by itself, and the whole block shrinks (rows and
 *   gaps, with room for the tape and rays) when its rows are too tall. A label is as tall as the measured ink needs
 *   when a script is taller than Montserrat. A flight (the sample's 340 px sideways and 150 px down, 16 degrees, 1.2x) is scaled
 *   back for a label whose flight would leave the safe area, so a wide label drops in nearly where it rests.
 * - Real speech: a label first paints at most 90 ms before its word is said and never after it (the sample's first frame is fully
 *   visible; ours starts at 35 % and settles within 45 ms), and its flight is compressed into the word's own time (down to 150 ms)
 *   when the word is short. A cue never waits for the cue before. The cue before gives way: when the next cue is close, the next
 *   cue's lead shrinks toward 0 (never past its spoken start) and the cue before leaves on the next cue's first painted frame; the
 *   sample's staggered collapse (85 ms a label, 20 ms apart, ending with the cue) starts no earlier than 150 ms after the last
 *   word's spoken end, is compressed to the room that is left, and is dropped for a cut when there is less than two painted frames
 *   of room. A word is never collapsed before its spoken end.
 * - Overlapping speakers: a cue that starts while the one before is still being spoken is stacked above it (below when there is no
 *   room above) and its flights keep clear of it, so neither covers the other.
 * - Right-to-left cues mirror the rows (bidi order). Words are never split into letters, so every script works; no case change.
 * - Brand colours: the label takes the brand's primary colour, the key label its highlight colour, both with the sample's near-black
 *   ink (`readsOn` in the catalogue row).
 * - Cost: the sample's 30 px blurred shadow is a small soft shadow under the hard one.
 * - New recurring beats, in the labels' own language and on every cue: a TAPE scrap (a zig-zag-ended masking-tape strip, pops onto
 *   a top corner of the first or last label of the top row, the side and angle from the hash) and a fan of short RAYS bursting
 *   from the key label's free top corner as it lands (a no-key cue gets two on its last label). Rays that
 *   would touch another label or leave the safe area are dropped.
 */

export const LABELS_DEMO: DemoScript = {
  lines: [
    "i:b quit:b my:m job:h@440",
    "best:b decision:b ever:b",
    "it:m was:m scary:h@520",
    "but:m staying:b was:m scarier:h@560",
    "bet:b on:m yourself:h@560",
  ],
  options: { rate: 215, gap: 35, cueGap: 230, tail: 560, lead: 300 },
};

const ANCHOR_LINE = 1290;
const FACE = "Montserrat ExtraBold" as const;
const LS = -0.02;
const INK = "#0C0C10";
const SHADOW_INK = "#08080C";
const FS = 100;
const KEY_FS = 114;
const ROW_H = 118;
const GAP = 10;
const PAD = { body: { x: 18, t: 3, b: 6 }, key: { x: 22, t: 5, b: 7 } } as const;
/** Montserrat's baseline below the top of its padding in a 1.1 line box, in em (0.968 ascent, 0.251 descent). */
const BASELINE_EM = 0.9085;
const ROW_SHIFT = [-14, 20, -8] as const;
const FLY_X = 340;
const FLY_Y = 150;
const FLY_MS = 340;
const SETTLE_RATIO = 420 / 340;
const FROM_R = 13;
const KEY_FROM_R = 16;
const KEY_POP = 0.2;
const LEAD = 90;
const FADE_MS = 45;
const FADE_FROM = 0.35;
const READ = 150;
const EXIT_MS = 85;
const EXIT_STAGGER = 20;
/** The width rows wrap at (sample px): the sample's rows are 520 to 740 px, so a long cue piles into rows instead of one long strip. */
const ROW_MAX = 760;
/** Room kept left and right of the rows for a row's nudge, the tape and the rays (sample px). */
const MARGIN_X = 60;
/** Room above and below the rows for the tape, rays and shadows (sample px). */
const UP = 50;
const DOWN = 50;

/** FNV-1a of a string: the seed that makes a cue's variety a pure function of its index and words. */
export function labelsHash(text: string): number {
  let h = 0x811c9dc5;
  for (let at = 0; at < text.length; at++) {
    h ^= text.charCodeAt(at);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const unit = (...parts: (string | number)[]) => labelsHash(parts.join("|")) / 4294967296;

interface Label {
  readonly at: number;
  readonly key: boolean;
  readonly row: number;
  /** Visual position inside the row, 0 at the left. */
  readonly col: number;
  readonly q: number;
  readonly fs: number;
  readonly w: number;
  readonly h: number;
  /** Pivot: the label's bottom centre. */
  readonly cx: number;
  readonly bottom: number;
  readonly baseline: number;
  readonly textCx: number;
  readonly tilt: number;
  readonly side: 1 | -1;
}

interface CueLayout {
  readonly cue: SceneCue;
  readonly number: number;
  readonly labels: readonly Label[];
  readonly rows: readonly (readonly Label[])[];
  readonly q: number;
  /** The rests of every label plus the room for the tape, rays and shadows. */
  readonly box: Box;
  readonly start: number;
  readonly spoken: number;
  readonly lead: number;
  /** The last frame this cue may paint: its own end, or the first painted frame of the cue after it. */
  release: number;
  readonly space: SceneSpace;
}

const meets = (a: Box, b: Box) => a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
const inflate = (box: Box, by: number): Box => ({ x1: box.x1 - by, y1: box.y1 - by, x2: box.x2 + by, y2: box.y2 + by });
const rotate = (x: number, y: number, deg: number): [number, number] => {
  const a = (deg * Math.PI) / 180;
  return [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
};

/** A label's rest rectangle, turned about its pivot. */
function restBox(l: Label): Box {
  let x1 = Number.POSITIVE_INFINITY;
  let y1 = Number.POSITIVE_INFINITY;
  let x2 = Number.NEGATIVE_INFINITY;
  let y2 = Number.NEGATIVE_INFINITY;
  for (const [ux, uy] of [[-l.w / 2, -l.h], [l.w / 2, -l.h], [l.w / 2, 0], [-l.w / 2, 0]] as const) {
    const [rx, ry] = rotate(ux, uy, l.tilt);
    x1 = Math.min(x1, l.cx + rx);
    x2 = Math.max(x2, l.cx + rx);
    y1 = Math.min(y1, l.bottom + ry);
    y2 = Math.max(y2, l.bottom + ry);
  }
  return { x1, y1, x2, y2 };
}

function unionOf(boxes: readonly Box[]): Box {
  return {
    x1: Math.min(...boxes.map((b) => b.x1)),
    y1: Math.min(...boxes.map((b) => b.y1)),
    x2: Math.max(...boxes.map((b) => b.x2)),
    y2: Math.max(...boxes.map((b) => b.y2)),
  };
}

function layoutCue(cue: SceneCue, number: number, heroCount: number, input: SceneInput, space: SceneSpace): { labels: Label[]; rows: Label[][]; q: number; box: Box } {
  const { u, safe } = space;
  const safeW = safe.x2 - safe.x1;
  const safeH = safe.y2 - safe.y1;
  const rtl = cueDirection(cue) === "rtl";
  const words = cue.words;
  const measureAt = (k: number, fs: number) => input.measure(words[k]!.text, FACE, fs, LS);
  const nominal = words.map((word, k) => {
    const key = word.role === "hero";
    const fs = (key ? KEY_FS : FS) * u;
    const pad = (key ? PAD.key : PAD.body).x * u;
    return { key, w: measureAt(k, fs).advance + LS * fs + 2 * pad };
  });

  // The whole block shrinks until its rows (and the room for the decorations) fit the safe height.
  let cf = 1;
  let rows: number[][] = [];
  let ws: number[] = [];
  for (let i = 0; i < 40; i++) {
    const q = u * cf;
    const maxW = Math.max(1, safeW - 2 * MARGIN_X * q);
    ws = nominal.map((n) => Math.min(1, maxW / (n.w * cf)));
    const widths = nominal.map((n, k) => n.w * cf * ws[k]!);
    // A cue of three words or more always piles into two rows at least, as the sample's do.
    const pile = widths.length >= 3 ? Math.max(...widths, 0.75 * (widths.reduce((sum, w) => sum + w, 0) + GAP * q * (widths.length - 1))) : Number.POSITIVE_INFINITY;
    rows = balancedRows(widths, GAP * q, Math.min(maxW, ROW_MAX * q, pile));
    const need = (rows.length * ROW_H + 20 + UP + DOWN) * q;
    if (need <= safeH || cf <= 0.08) break;
    cf = Math.max(0.08, cf * clamp(safeH / need, 0.5, 0.97));
  }
  const q = u * cf;

  // Exact label geometry at the final sizes.
  let keyNumber = heroCount;
  const sized = words.map((word, k) => {
    const key = word.role === "hero";
    const qk = q * ws[k]!;
    const fs = (key ? KEY_FS : FS) * qk;
    const pad = key ? PAD.key : PAD.body;
    const m = measureAt(k, fs);
    const w = m.advance + LS * fs + 2 * pad.x * qk;
    const offset = pad.t * qk + BASELINE_EM * fs;
    const above = Math.max(offset, -m.inkTop + 4 * qk);
    const below = Math.max(1.1 * fs + (pad.t + pad.b) * qk - offset, m.inkBottom + 4 * qk);
    const tilt = key ? (keyNumber++ % 2 === 0 ? -1 : 1) * (5 + 1.2 * unit("tilt", number, word.text)) : 0;
    return { k, key, qk, fs, w, h: above + below, baseline: above, textCx: pad.x * qk + m.advance / 2, tilt, side: (k + number) % 2 === 0 ? (-1 as const) : (1 as const) };
  });

  const direction = rtl ? "rtl" : "ltr";
  const blockH = rows.length * ROW_H * q;
  const centreX = space.x(540);
  const blockTop = space.y(ANCHOR_LINE) - blockH / 2;
  const labels: Label[] = [];
  const visualRows: Label[][] = [];
  rows.forEach((row, r) => {
    const order = rowVisualOrder(row.map((k) => words[k]!.text), direction).map((at) => row[at]!);
    const rowW = order.reduce((sum, k) => sum + sized[k]!.w, 0) + GAP * q * (order.length - 1);
    let left = centreX + ROW_SHIFT[(r + number) % ROW_SHIFT.length]! * q - rowW / 2;
    const centreY = blockTop + (r + 0.5) * ROW_H * q;
    const line: Label[] = [];
    order.forEach((k, col) => {
      const s = sized[k]!;
      const top = centreY - s.h / 2;
      const label: Label = { at: k, key: s.key, row: r, col, q: s.qk, fs: s.fs, w: s.w, h: s.h, cx: left + s.w / 2, bottom: centreY + s.h / 2, baseline: top + s.baseline, textCx: left + s.textCx, tilt: s.tilt, side: s.side };
      line.push(label);
      labels.push(label);
      left += s.w + GAP * q;
    });
    visualRows.push(line);
  });
  labels.sort((a, b) => a.at - b.at);

  const withRoom = (boxes: readonly Box[]): Box => {
    const box = unionOf(boxes);
    return { x1: box.x1 - MARGIN_X * q, y1: box.y1 - UP * q, x2: box.x2 + MARGIN_X * q, y2: box.y2 + DOWN * q };
  };
  let box = withRoom(labels.map(restBox));

  let dy = 0;
  if (box.y1 + dy < safe.y1) dy = safe.y1 - box.y1;
  else if (box.y2 + dy > safe.y2) dy = safe.y2 - box.y2;
  if (dy !== 0) {
    for (let i = 0; i < labels.length; i++) {
      const l = labels[i]!;
      const moved: Label = { ...l, bottom: l.bottom + dy, baseline: l.baseline + dy };
      labels[i] = moved;
      visualRows[l.row]![l.col] = moved;
    }
    box = { ...box, y1: box.y1 + dy, y2: box.y2 + dy };
  }
  return { labels, rows: visualRows, q, box };
}

interface Timing {
  readonly from: number;
  readonly fly: number;
  readonly settle: number;
  /** Share of the sample's flight, entrance spin and pop this label keeps (1 = all of it). */
  readonly g: number;
}

interface ExitPlan {
  readonly start: number;
  readonly dur: number;
  readonly stagger: number;
}

function exitPlan(count: number, spoken: number, release: number, fps: number): ExitPlan | null {
  const two = Math.ceil((2 * 1000) / sceneSampleRate(fps)) + 1;
  const natural = EXIT_MS + (count - 1) * EXIT_STAGGER;
  const start = Math.max(release - natural, spoken + READ);
  const room = release - start;
  if (room < two) return null;
  const dur = Math.min(EXIT_MS, room);
  const stagger = count > 1 ? Math.min(EXIT_STAGGER, (room - dur) / (count - 1)) : 0;
  return { start, dur, stagger };
}

function cuePieces(layout: CueLayout, heroNumberOf: ReadonlyMap<number, number>, input: SceneInput): Piece[] {
  const { cue, number, labels, rows, q, spoken, release, lead } = layout;
  const fps = input.fps ?? SCENE_DEFAULT_FPS;
  const { space } = layout;
  const words = cue.words;
  const n = words.length;
  const exit = exitPlan(n, spoken, release, fps);
  const firstFrom = layout.start - lead;
  const pieces: Piece[] = [];
  const safe = { x1: space.safe.x1 + 1, y1: space.safe.y1 + 1, x2: space.safe.x2 - 1, y2: space.safe.y2 - 1 };
  const timings = new Map<number, Timing>();
  const exitOf = (k: number) => (exit ? exit.start + (n - 1 - k) * exit.stagger : null);
  const endOf = (k: number) => {
    const e = exitOf(k);
    return e === null ? release : Math.min(release, e + exit!.dur);
  };

  const track = (l: Label, tm: Timing, withExit: boolean): Track => {
    const fx = FLY_X * q * tm.g * l.side;
    const fy = FLY_Y * q * tm.g;
    const fromR = (l.key ? KEY_FROM_R : FROM_R) * l.side;
    const startR = l.tilt + (fromR - l.tilt) * tm.g;
    const pop = 1 + KEY_POP * tm.g;
    const settleEnd = tm.from + tm.settle;
    const e = withExit ? exitOf(l.at) : null;
    const t: Track = {
      x: [[tm.from, l.cx + fx], [tm.from + tm.fly, l.cx, "outExpo"]],
      y: [[tm.from, l.bottom - fy], [tm.from + tm.fly, l.bottom, "outExpo"]],
      rz: [[tm.from, startR], [settleEnd, l.tilt, "spring"]],
      o: opacityOf(tm, words[l.at]!.endMs),
    };
    if (l.key) t.sx = [[tm.from, pop], [settleEnd, 1, "spring"]];
    if (e !== null) {
      const dur = exit!.dur;
      if (!l.key) t.sy = [[e, 1], [e + dur, 0.001, "in"]];
      else if (e >= settleEnd) t.sy = [[tm.from, pop], [settleEnd, 1, "spring"], [e, 1], [e + dur, 0.001, "in"]];
      else {
        const sy = (ms: number) => (1 + KEY_POP * tm.g * (1 - EASES.spring(prog(ms, tm.from, tm.settle)))) * Math.max(0.001, 1 - EASES.in(prog(ms, e, dur)));
        t.sy = sampleFrames(sy, [settleEnd, e, e + dur], 0.003, { range: [tm.from, e + dur] });
      }
    } else if (l.key) t.sy = t.sx;
    return t;
  };
  const opacityOf = (tm: Timing, wordEnd: number): Frames => {
    const opaqueAt = Math.min(tm.from + FADE_MS, exportFrameAtOrBefore(wordEnd - 1, fps));
    return opaqueAt > tm.from ? [[tm.from, FADE_FROM], [opaqueAt, 1]] : [[tm.from, 1]];
  };

  const plateOf = (l: Label, tm: Timing, to: number, withExit: boolean): ShapePiece => {
    const word = words[l.at]!;
    const zRole = l.key ? 1 : 2 + (l.at % 2);
    return {
      id: `labels:${number}:p${l.at}`,
      kind: "shape",
      z: number * 100 + zRole * 2,
      fromMs: tm.from,
      toMs: to,
      track: track(l, tm, withExit),
      path: rectPath(0, 0, l.w, l.h),
      origin: { dx: l.w / 2, dy: l.h },
      fill: { colour: word.role === "hero" ? input.colours.highlight : input.colours.primary },
      shadows: [
        { dx: 0, dy: 9 * l.q, blur: 0, colour: SHADOW_INK, alpha: 0.34 },
        { dx: 0, dy: 15 * l.q, blur: 7 * l.q, colour: SHADOW_INK, alpha: 0.3 },
      ],
    };
  };

  const faceOf = (l: Label, tm: Timing, to: number, withExit: boolean): TextPiece => ({
    id: `labels:${number}:w${l.at}`, kind: "text",
    z: number * 100 + (l.key ? 1 : 2 + (l.at % 2)) * 2 + 1,
    fromMs: tm.from, toMs: to, track: track(l, tm, withExit),
    text: words[l.at]!.text, face: FACE, sizePx: l.fs, letterSpacingEm: LS, fill: INK,
    anchor: "baseline-center", origin: { dx: l.cx - l.textCx, dy: l.bottom - l.baseline },
    language: cue.language,
  });

  // Every label: when it first paints, how long it flies, and how much of the flight fits the safe area (and clear of a cue that
  // is still being spoken).
  const firstWord = Math.min(...words.map((w) => w.startMs));
  for (const l of labels) {
    const word = words[l.at]!;
    const from = l.at === 0 || word.startMs === firstWord ? firstFrom : Math.max(firstFrom, word.startMs - LEAD);
    const fly = clamp(word.endMs - from + 120, 150, FLY_MS);
    const base: Timing = { from, fly, settle: fly * SETTLE_RATIO, g: 1 };
    const fits = (g: number) => {
      const tm = { ...base, g };
      const plate = plateOf(l, tm, release, false);
      for (let t = from; t <= from + tm.settle; t += 12) {
        const box = pieceBounds(plate, t, input.measure);
        if (!box) continue;
        if (box.x1 < safe.x1 || box.x2 > safe.x2 || box.y1 < safe.y1 || box.y2 > safe.y2) return false;
        for (const earlier of labels) {
          const timing = timings.get(earlier.at);
          if (!timing || t >= words[earlier.at]!.endMs || t < words[earlier.at]!.startMs) continue;
          const face = pieceBounds(faceOf(earlier, timing, release, false), t, input.measure);
          if (face && meets(box, inflate(face, 1))) return false;
        }
      }
      return true;
    };
    let g = 1;
    if (!fits(1)) {
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 8; i++) {
        const mid = (lo + hi) / 2;
        if (fits(mid)) lo = mid;
        else hi = mid;
      }
      g = lo;
    }
    timings.set(l.at, { ...base, g });
  }

  for (const l of labels) {
    const tm = timings.get(l.at)!;
    const to = endOf(l.at);
    const text = faceOf(l, tm, to, true);
    if (paintedFrameCount(tm.from, to, fps) >= 2) {
      pieces.push(plateOf(l, tm, to, true), text);
    } else {
      pieces.push({
        ...text,
        track: track(l, { ...tm, g: 0 }, false),
        fill: input.colours.primary,
        shadows: [{ dx: 0, dy: 2 * l.q, blur: 3 * l.q, colour: SHADOW_INK, alpha: 0.75 }],
      });
    }
  }

  // ---- Recurring beats ----
  const decoEnd = exit ? exit.start : release;
  const fits2 = (from: number, to: number) => to > from && paintedFrameCount(from, to, fps) >= 2;
  const seed = `${number}|${words.map((w) => w.text).join(" ")}`;
  const topRow = rows[0]!;

  // TAPE: a zig-zag-ended strip across a top corner of the first or last label of the top row.
  const tapeAtEnd = unit("tape", seed) < 0.5;
  // The tape goes on the end of the top row that the rays do not use, when the row has two ends.
  const rayHero = labels.find((l) => l.key);
  const rayTarget = rayHero ?? labels[n - 1]!;
  const ends = tapeAtEnd ? [topRow[topRow.length - 1]!, topRow[0]!] : [topRow[0]!, topRow[topRow.length - 1]!];
  const host = ends.find((l) => l.at !== rayTarget.at) ?? ends[0]!;
  const hostTm = timings.get(host.at)!;
  const tapeCorner = (host === topRow[topRow.length - 1] && (host !== topRow[0] || tapeAtEnd) ? 1 : -1) as 1 | -1;
  const cornerOf = (l: Label, side: 1 | -1): [number, number] => {
    const [rx, ry] = rotate(side * (l.w / 2), -l.h, l.tilt);
    return [l.cx + rx, l.bottom + ry];
  };
  {
    const tw = 84 * host.q;
    const th = 26 * host.q;
    const z = th / 4;
    const angle = tapeCorner * (30 + 10 * unit("tapeAngle", seed)) + host.tilt * 0.5;
    const hostEnd = exit ? exitOf(host.at)! : release;
    const to = Math.min(release, hostEnd);
    const landing = Math.round(hostTm.from + hostTm.fly * 0.3);
    const from = fits2(landing, to) ? landing : hostTm.from;
    if (fits2(from, to)) {
      const pop = Math.min(150, Math.max(1, Math.floor((to - from) / 2)));
      // The scrap rides the label it is stuck to: its offset from the label's pivot turns and scales with the label's own pose.
      const hostPlate = plateOf(host, hostTm, release, false);
      const offX = tapeCorner * (host.w / 2 + 2 * host.q);
      const offY = -host.h + 2 * host.q;
      const settled = Math.max(from + pop, hostTm.from + hostTm.settle);
      const popOf = (t: number) => EASES.outBack(prog(t, from, pop));
      const pose = (t: number) => {
        const p = evaluatePiece(hostPlate, t);
        const [rx, ry] = rotate(offX * p.sx, offY * p.sy, p.rz);
        return { x: p.x + rx, y: p.y + ry, rz: p.rz + angle - tapeCorner * 25 * (1 - popOf(t)) };
      };
      const edges = [from + pop, hostTm.from + hostTm.fly, hostTm.from + hostTm.settle];
      const frames = (pick: (t: number) => number, tolerance: number) => sampleFrames(pick, edges, tolerance, { range: [from, settled] });
      const piece: ShapePiece = {
        id: `labels:${number}:tape`,
        kind: "shape",
        z: number * 100 + 90,
        fromMs: from,
        toMs: to,
        path: polygonPath([[0, 0], [tw, 0], [tw - z, th / 4], [tw, th / 2], [tw - z, (3 * th) / 4], [tw, th], [0, th], [z, (3 * th) / 4], [0, th / 2], [z, th / 4]]),
        origin: { dx: tw / 2, dy: th / 2 },
        fill: { colour: input.colours.accent, alpha: 0.9 },
        shadows: [{ dx: 0, dy: 3 * host.q, blur: 0, colour: SHADOW_INK, alpha: 0.25 }],
        track: {
          x: frames((t) => pose(t).x, 0.3),
          y: frames((t) => pose(t).y, 0.3),
          rz: frames((t) => pose(t).rz, 0.2),
          sx: [[from, 0.3], [from + pop, 1, "outBack"]],
          sy: [[from, 0.3], [from + pop, 1, "outBack"]],
          o: [[from, 0.4], [from + Math.min(60, pop), 1]],
        },
      };
      pieces.push(piece);
    }
  }

  // RAYS: a fan of short strokes from the key label's free top corner as it lands (the last label of a cue without one).
  {
    const hero = rayHero;
    const target = rayTarget;
    const heroRank = hero ? (heroNumberOf.get(number) ?? 0) : 0;
    const tm = timings.get(target.at)!;
    const others = labels.filter((l) => l.at !== target.at).map((l) => inflate(restBox(l), 5 * q));
    const avoid = others;
    const reach = 5 * q + 2;
    const room = { x1: space.safe.x1 + reach, y1: space.safe.y1 + reach, x2: space.safe.x2 - reach, y2: space.safe.y2 - reach };
    const count = hero ? 3 : 2;
    const tapeHere = host.at === target.at ? tapeCorner : 0;
    const preferred = ((unit("rays", seed) < 0.5) !== (heroRank % 2 === 1) ? 1 : -1) as 1 | -1;
    let best: { side: 1 | -1; rays: { x: number; y: number; length: number; angle: number }[] } | null = null;
    for (const side of [preferred, (preferred === 1 ? -1 : 1) as 1 | -1]) {
      if (side === tapeHere) continue;
      const [cornerX, cornerY] = cornerOf(target, side);
      const rays = Array.from({ length: count }, (_, i) => {
        const spread = count === 3 ? [-75, -45, -15][i]! : [-65, -25][i]!;
        const angle = side === 1 ? spread : -180 - spread;
        const length = (22 + 6 * unit("ray", seed, i)) * q;
        const r0 = 10 * q;
        const [sx, sy] = [cornerX + side * 4 * q + Math.cos((angle * Math.PI) / 180) * r0, cornerY - 4 * q + Math.sin((angle * Math.PI) / 180) * r0];
        return { x: sx, y: sy, length, angle };
      }).filter((ray) => {
        const dx = Math.cos((ray.angle * Math.PI) / 180);
        const dyy = Math.sin((ray.angle * Math.PI) / 180);
        return [0, 0.33, 0.66, 1].every((f) => {
          const px = ray.x + dx * ray.length * f;
          const py = ray.y + dyy * ray.length * f;
          const b: Box = { x1: px - 3 * q, y1: py - 3 * q, x2: px + 3 * q, y2: py + 3 * q };
          return b.x1 >= room.x1 && b.x2 <= room.x2 && b.y1 >= room.y1 && b.y2 <= room.y2 && !avoid.some((o) => meets(b, o));
        });
      });
      if (!best || rays.length > best.rays.length) best = { side, rays };
      if (rays.length === count) break;
    }
    const landing = Math.round(tm.from + tm.fly * 0.35);
    const t0 = fits2(landing, decoEnd) ? landing : tm.from;
    const total = 350;
    const avail = decoEnd - t0;
    if (best && best.rays.length > 0 && fits2(t0, t0 + Math.min(total, avail))) {
      const k = Math.min(1, avail / total);
      const grow = Math.max(40, Math.round(110 * k));
      const hold = Math.round(130 * k);
      const fade = Math.max(40, Math.round(110 * k));
      const to = Math.min(decoEnd, t0 + grow + hold + fade);
      best.rays.forEach((ray, i) => {
        if (!fits2(t0, to)) return;
        pieces.push({
          id: `labels:${number}:ray${i}`,
          kind: "shape",
          z: number * 100 + 95,
          fromMs: t0,
          toMs: to,
          path: polylinePath([[0, 0], [ray.length, 0]]),
          stroke: { widthPx: 5 * q, colour: hero ? input.colours.highlight : input.colours.primary },
          shadows: [{ dx: 0, dy: 3 * q, blur: 0, colour: SHADOW_INK, alpha: 0.4 }],
          track: {
            x: [[t0, ray.x]],
            y: [[t0, ray.y]],
            rz: [[t0, ray.angle]],
            sx: [[t0, 0.05], [t0 + grow, 1, "outExpo"]],
            o: [[t0 + grow + hold, 1], [t0 + grow + hold + fade, 0, "in"]],
          },
        });
      });
    }
  }
  return clampToSafeArea(pieces, safe, input.measure);
}

export const labelsProgram: SceneProgram = {
  build(input) {
    const space = sceneSpace(input, ANCHOR_LINE);
    const layouts: CueLayout[] = [];
    const heroNumberOf = new Map<number, number>();
    let heroCount = 0;
    let heroCues = 0;
    for (const window of speechWindows(input, space.safe, LEAD, READ)) {
      const { cue, index: number, start, spokenEnd, from, to, bounds } = window;
      const lane = speechLaneSpace(space, bounds, ANCHOR_LINE);
      const laid = layoutCue(cue, number, heroCount, input, lane);
      const heroes = cue.words.filter((w) => w.role === "hero").length;
      if (heroes > 0) heroNumberOf.set(number, heroCues++);
      heroCount += heroes;
      layouts.push({ cue, number, labels: laid.labels, rows: laid.rows, q: laid.q, box: laid.box, start, spoken: spokenEnd, lead: start - from, release: to, space: lane });
    }
    return { pieces: layouts.flatMap((layout) => cuePieces(layout, heroNumberOf, input)) };
  },
};

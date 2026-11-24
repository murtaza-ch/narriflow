import { captionColourContrast, toCaptionUpperCase } from "@narriflow/validators";
import type { DemoScript } from "../demo";
import { EASES, type Frames, clamp, prog } from "../ease";
import { SCENE_DEFAULT_FPS, exportFrameAtOrBefore, paintedFrameCount, sceneSampleRate } from "../frame-grid";
import { sampleFrames } from "../frames";
import type { SceneCue, SceneInput, SceneProgram } from "../input";
import { balancedRows, clampToSafeArea, cueDirection, rowVisualOrder, sceneSpace } from "../layout";
import { type Box, type Clip, type Piece, type ShapePiece, type TextPiece, type Track, mixColour } from "../scene";
import { rectPath } from "../shapes";
import { hasTwoPaintedFrames, speechLaneSpace, speechWindows } from "./speech-layout";

/**
 * Slab (`samples/templates/m25-slab.js`): heavy geometric caps, each line riding a white slab that steps on word by word,
 * the slab a beat ahead of its dark text; a finished line's slab wipes off and leaves the same words in white over the
 * footage; the key word keeps a saturated knock-out slab, a new colour every cue.
 *
 * Changes from the sample, and why:
 * - Rows come from the words. The sample bakes " / " breaks per cue and sets them `nowrap` with no fit (its hero row is
 *   1010 px wide). Words wrap evenly into rows no wider than the safe area (and a 980 px column); a word wider than that,
 *   or a block taller than the safe area, shrinks the whole block so rows keep one size. RTL cues mirror: the staircase,
 *   the retract and the exit run right to left and the rows keep their visual order.
 * - Nothing is cue-indexed. The key colour is a counter over highlight, accent, mint and blue (the sample's four, the first
 *   two being the preset's colours), the ink on it comes from contrast, and the beats below cycle by counters and a seeded
 *   hash of the cue's index and text.
 * - Real speech. The slab steps on at most 95 ms before its word (never late) and compresses into the word's own time when
 *   a word is short. A cue's first word gives up lead (down to 0) so the cue before keeps its last word through its spoken
 *   end plus 150 ms where the gap allows. The dark ink is the word's face and is never wiped or covered before its spoken
 *   end plus 150 ms: the retract waits that long after the row's last word, the exit after the cue's last word, and both
 *   are shortened (or dropped for a cut) to the time a later cue leaves them. Overlapping speakers stack, the later one in
 *   free space under (or over) the earlier one.
 * - Budget. The white text only exists from the moment its slab starts to leave (the sample keeps it under the slab all
 *   along); its two shadows are the sample's (hard 5 px, soft 24 px blur). Measured: 0.95x Headline on the 60 s full export
 *   (CPU, best of 3); every clip is the ink's own rectangle, a slab leaving ends its pieces when the front has passed it.
 *
 * Extra recurring beats, in the slab's own language (hard rectangles, wipes, the cue's key colour):
 *   rule    a thin bar under the last row, wiped in from the side the slabs do not come from; every cue; it cycles
 *           full width / short at the leading end / short at the trailing end, with a seeded width;
 *   bullet  a key-colour square (a diamond on every other cue) popping in before the first row, where there is room;
 *   scan    a thin bar riding the front of each row's retract wipe, per run of words that leave;
 *   flash   hero cues: the key slab lands hot (a white flash fading over 160 ms) and kicks to 105 % and back.
 */
export const SLAB_DEMO: DemoScript = {
  lines: [
    "most:b people:b quit:b right:m before:b it:m works:h@520",
    "nobody:b is:m watching:b",
    "so:m start:b ugly:h@480",
    "post:b it:m before:m you're:m ready:h@500",
    "every:b expert was:m once:m a:m beginner:h@560",
  ],
  options: { rate: 205, gap: 25, cueGap: 200, tail: 560, lead: 300 },
};

const FACE = "Montserrat ExtraBold" as const;
const ANCHOR = 1290;
const FS = 100;
const ROW = 94;
const PADX = 16;
const BASELINE = 83;
const TRACKING = -0.01;
const KEY_OVER = 4;
const SLAB_INSET = 1;
const LEAD = 95;
const SLAB_MS = 190;
const INK_LAG = 15;
const INK_MS = 170;
const HOLD = 150;
const RETRACT_MS = 230;
const MIN_RETRACT_MS = 100;
const EXIT_MS = 85;
const EXIT_STAGGER = 12;
const EXIT_ANCHOR = 200;
const KICK = 1.05;
const KICK_MS = 250;
const FLASH_MS = 160;
const COLUMN = 980;
const EXTRA = 34;
const RULE_GAP = 9;
const RULE_H = 7;
const RULE_MS = 240;
const BULLET = 30;
const BULLET_GAP = 14;
const SHADOW_PAD = 36;
const INK = "#101014";
const MINT = "#7CF0C8";
const BLUE = "#4C6CF5";
const SIMPLE = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Common}\p{Script=Inherited}]+$/u;
const PICTO = /\p{Extended_Pictographic}/u;

interface Cell {
  /** The word's index in its cue. */
  readonly at: number;
  readonly text: string;
  readonly spacing: number;
  readonly hero: boolean;
  readonly x: number;
  readonly w: number;
  /** Distance from the row's leading edge (left for LTR, right for RTL) to this cell's leading side. */
  readonly a: number;
}

interface RowGeo {
  readonly top: number;
  readonly height: number;
  readonly baseline: number;
  readonly left: number;
  readonly right: number;
  readonly cells: readonly Cell[];
  readonly endMs: number;
}

interface Geo {
  readonly rtl: boolean;
  /** Block scale: every row shares one size, shrunk to fit. */
  readonly f: number;
  readonly rows: readonly RowGeo[];
  /** Everything the cue can draw, at dy = 0. */
  readonly box: Box;
  /** How far a kicking key slab reaches beyond its cell, canvas px. */
  readonly kickPad: number;
}

interface Plan {
  readonly dy: number;
  readonly from: number;
  /** Hard end (exclusive): the cue's natural end, or an earlier cue's first painted frame if one meets it. */
  end: number;
  readonly first: number;
  readonly last: number;
  readonly box: Box;
}

interface Ctx {
  readonly input: SceneInput;
  readonly u: number;
  readonly fps: number;
  readonly frameMs: number;
  readonly space: Space;
}

interface Palette {
  readonly key: string;
  readonly keyInk: string;
  /** The rule, bullet and scan bars. */
  readonly deco: string;
}

type Space = ReturnType<typeof sceneSpace>;

const seeded = (text: string, salt: number) => {
  let h = 2166136261 ^ salt;
  for (let at = 0; at < text.length; at++) {
    h ^= text.charCodeAt(at);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10007) / 10007;
};


/** The first time in [a, b] at which the non-decreasing `fn` reaches `target`; null when it never does. */
function reaches(fn: (t: number) => number, target: number, a: number, b: number): number | null {
  if (b <= a || fn(b) < target - 1e-6) return null;
  if (fn(a) >= target) return a;
  let lo = a;
  let hi = b;
  for (let step = 0; step < 30; step++) {
    const mid = (lo + hi) / 2;
    if (fn(mid) < target) lo = mid;
    else hi = mid;
  }
  return hi;
}

const sampled = (fn: (t: number) => number, from: number, to: number, edges: readonly number[], tolerance = 0.25): Frames =>
  to - from < 1 ? [[from, fn(from)]] : sampleFrames(fn, edges, tolerance, { range: [from, to] });

function layoutCue(cue: SceneCue, input: SceneInput, space: Space): Geo | null {
  if (cue.words.length === 0) return null;
  const { u } = space;
  const rtl = cueDirection(cue) === "rtl";
  const words = cue.words.map((word) => {
    const text = toCaptionUpperCase(word.text, cue.language);
    return { text, spacing: SIMPLE.test(text) && !PICTO.test(text) ? TRACKING : 0, hero: word.role === "hero" };
  });
  const maxW = Math.min((space.safe.x2 - space.safe.x1) / KICK, COLUMN * u);
  const maxH = space.safe.y2 - space.safe.y1 - 4 * u;
  const geometryAt = (unit: number) => {
    const ink = words.map((word) => input.measure(word.text, FACE, FS * unit, word.spacing));
    const widths = words.map((word, i) => Math.max(1, ink[i]!.advance + word.spacing * FS * unit) + 2 * PADX * unit);
    const rows = balancedRows(widths, 0, maxW).map((row) => {
      const fallback = row.filter((at) => words[at]!.spacing === 0);
      const above = Math.max(BASELINE * unit, ...fallback.map((at) => -ink[at]!.inkTop + 4 * unit));
      const below = Math.max((ROW - BASELINE) * unit, ...fallback.map((at) => ink[at]!.inkBottom + 4 * unit));
      return { row, above, height: above + below };
    });
    return { widths, rows, height: rows.reduce((sum, row) => sum + row.height, 0) };
  };
  let f = 1;
  let layout = geometryAt(u);
  for (let step = 0; step < 80; step++) {
    const widest = Math.max(...layout.widths);
    const high = layout.height + EXTRA * u * f;
    if (widest <= maxW + 0.5 && high <= maxH) break;
    f *= Math.min(0.98, maxW / widest, maxH / high);
    layout = geometryAt(u * f);
  }
  const { widths, rows, height } = layout;
  const cx = space.x(540);
  const lowerDecoration = (RULE_GAP + RULE_H + 3) * u * f;
  const blockTop = clamp(space.y(ANCHOR) - height / 2, space.safe.y1 + 8 * u * f, space.safe.y2 - height - lowerDecoration);
  let top = blockTop;
  const geoRows = rows.map(({ row, above, height: rowH }): RowGeo => {
    const width = row.reduce((sum, at) => sum + widths[at]!, 0);
    const left = cx - width / 2;
    const order = rowVisualOrder(row.map((at) => words[at]!.text), rtl ? "rtl" : "ltr").map((at) => row[at]!);
    let x = left;
    const cells = order.map((at): Cell => {
      const w = widths[at]!;
      const cell: Cell = { at, text: words[at]!.text, spacing: words[at]!.spacing, hero: words[at]!.hero, x, w, a: rtl ? left + width - (x + w) : x - left };
      x += w;
      return cell;
    });
    const made: RowGeo = { top, height: rowH, baseline: above, left, right: left + width, cells, endMs: Math.max(...row.map((at) => cue.words[at]!.endMs)) };
    top += rowH;
    return made;
  });
  const widest = Math.max(...geoRows.map((row) => row.right - row.left));
  const kickPad = (KICK - 1) * 0.5 * widest + 1;
  const bullet = (BULLET * 1.5 + BULLET_GAP) * u * f;
  const box: Box = {
    x1: Math.min(...geoRows.map((row) => row.left)) - kickPad - bullet,
    x2: Math.max(...geoRows.map((row) => row.right)) + kickPad + bullet,
    y1: blockTop - 8 * u * f,
    y2: top + (RULE_GAP + RULE_H + 3) * u * f,
  };
  return { rtl, f, rows: geoRows, box, kickPad };
}

/** Black ink on a light key colour, white on a dark one. */
const inkOn = (colour: string) => (captionColourContrast(colour, "#FFFFFF") >= 3 ? "#FFFFFF" : INK);

function flashOpacity(plate: string, ink: string): number {
  let low = 0;
  let high = 0.55;
  if (captionColourContrast(mixColour(plate, "#FFFFFF", high), ink) >= 3) return high;
  for (let i = 0; i < 8; i++) {
    const mid = (low + high) / 2;
    if (captionColourContrast(mixColour(plate, "#FFFFFF", mid), ink) >= 3) low = mid;
    else high = mid;
  }
  return low;
}

function buildCue(n: number, cue: SceneCue, geo: Geo, plan: Plan, palette: Palette, ctx: Ctx): Piece[] {
  const { input, u, fps, frameMs, space } = ctx;
  const { rtl, f, rows, kickPad } = geo;
  const { dy, from, end, last } = plan;
  if (end <= from) return [];
  const size = FS * u * f;
  const padX = PADX * u * f;
  const z = n * 10;
  const pieces: Piece[] = [];
  const flashAlpha = flashOpacity(palette.key, palette.keyInk);
  const growsFromLeft = (side: "lead" | "trail") => (side === "lead") !== rtl;

  // The exit: every row wipes away, staggered, no earlier than 150 ms after the last spoken word.
  const room = end - (last + HOLD);
  const exitCapable = room >= frameMs * 2.2;
  const staggered = exitCapable && room >= EXIT_MS + (rows.length - 1) * EXIT_STAGGER;
  const exitDur = exitCapable ? (staggered || room >= EXIT_MS ? EXIT_MS : room) : 0;
  const stagger = staggered ? EXIT_STAGGER : 0;
  const exitStart0 = exitCapable ? clamp(end - EXIT_ANCHOR, last + HOLD, Math.max(last + HOLD, end - exitDur - (rows.length - 1) * stagger)) : end;
  const exitAt = (row: number) => exitStart0 + row * stagger;
  const exitEnd = (row: number) => (exitCapable ? Math.min(end, Math.ceil(exitAt(row) + exitDur)) : end);
  const exitProgress = (row: number) => (t: number) => (exitCapable ? EASES.out(prog(t, exitAt(row), exitDur)) : 0);

  /** A clip that reveals from one side and follows a wipe front (the retract and the exit) moving in the cue's direction. */
  const clipOf = (lo: number, hi: number, side: "lead" | "trail", reveal: (t: number) => number, front: ((t: number) => number) | null, y1: number, y2: number, start: number, stop: number, edges: readonly number[]): Clip => {
    const left = growsFromLeft(side);
    const x1 = (t: number) => Math.max(left ? lo : hi - (hi - lo) * reveal(t), !rtl && front ? clamp(front(t), lo, hi) : lo);
    const x2 = (t: number) => Math.min(left ? lo + (hi - lo) * reveal(t) : hi, rtl && front ? clamp(front(t), lo, hi) : hi);
    return { x1: sampled(x1, start, stop, edges), x2: sampled(x2, start, stop, edges), y1: [[start, y1]], y2: [[start, y2]] };
  };

  const decoFrom = Math.max(from, plan.first - 40);
  const lastRow = rows.at(-1)!;
  const rowExit = rows.map((_, ri) => exitProgress(ri));

  rows.forEach((row, ri) => {
    const top = row.top + dy;
    const rowH = row.height;
    const width = row.right - row.left;
    const mRow = row.cells.some((cell) => cell.hero) ? kickPad : 0;
    const exit = rowExit[ri]!;
    const retractAt = row.endMs + HOLD;
    const retractAvail = (exitCapable ? exitAt(ri) : end) - retractAt;
    const retracts = retractAvail >= MIN_RETRACT_MS && row.cells.some((cell) => !cell.hero);
    const retractDur = retracts ? Math.min(RETRACT_MS, retractAvail) : 0;
    const retract = (t: number) => (retracts ? EASES.inOut(prog(t, retractAt, retractDur)) : 0);
    // Where the wipe front is, as a distance from the row's leading edge and as an x.
    const dist = (p: number) => (width + mRow) * p - mRow;
    const frontX = (p: number) => (rtl ? row.right - dist(p) : row.left + dist(p));

    for (const cell of row.cells) {
      const word = cue.words[cell.at]!;
      const S = word.startMs;
      const dur = Math.max(1, word.endMs - word.startMs);
      const rev0 = Math.max(from, S - LEAD);
      const lead = S - rev0;
      const finish = exportFrameAtOrBefore(S + dur - 1, fps);
      const slabDur = Math.max(0, Math.min(SLAB_MS, finish - rev0));
      const instant = slabDur < frameMs * 0.9;
      // With no lead the first painted frame already shows a sliver of ink, not an empty clip.
      const p0 = instant ? 1 : lead < 40 ? clamp((padX + 0.25 * (cell.w - 2 * padX)) / cell.w, 0.12, 0.6) : 0;
      const slabReveal = (t: number) => (instant ? 1 : p0 + (1 - p0) * EASES.outExpo(prog(t, rev0, slabDur)));
      const inkAt = rev0 + (instant ? 0 : INK_LAG);
      const inkDur = instant ? 0 : Math.max(0, Math.min(INK_MS, rev0 + slabDur - inkAt));
      const inkReveal = (t: number) => (instant ? 1 : p0 + (1 - p0) * EASES.outExpo(prog(t, inkAt, inkDur)));
      const m = cell.hero ? kickPad : 0;
      const lo = cell.x - m;
      const hi = cell.x + cell.w + m;
      const landing = rev0 + slabDur;
      const progress = (t: number) => Math.max(cell.hero ? 0 : retract(t), exit(t));
      const front = (t: number) => frontX(progress(t));
      const dAt = (t: number) => dist(progress(t));
      const crossings = [reaches(dAt, cell.a - m, rev0, end), reaches(dAt, cell.a + cell.w + m, rev0, end)].flatMap((t) => (t === null ? [] : [t]));
      const goneAt = reaches(dAt, cell.a + cell.w, rev0, end);
      const toMs = Math.min(end, goneAt === null ? end : Math.ceil(goneAt) + 1);
      const edges = [rev0, rev0 + slabDur, inkAt, inkAt + inkDur, retractAt, retractAt + retractDur, exitAt(ri), exitAt(ri) + exitDur, ...crossings];

      const slabTop = cell.hero ? top - KEY_OVER * u * f : top + SLAB_INSET * u * f;
      const slabH = cell.hero ? rowH + 2 * KEY_OVER * u * f : rowH - 2 * SLAB_INSET * u * f;
      const pivotX = cell.x + cell.w / 2;
      const pivotY = top + rowH / 2;
      const textX = cell.x + padX;
      const baseline = top + row.baseline;

      // A key slab kicks (105 % and back) as it lands, slab, flash and ink on one pivot.
      const available = (exitCapable ? exitAt(ri) : end) - landing;
      const kickDur = cell.hero && Math.min(KICK_MS, available) >= frameMs * 2.2 ? Math.min(KICK_MS, available) : 0;
      const kickFrames: Frames = [[landing, 1], [landing + Math.min(70, kickDur * 0.3), KICK, "out"], [landing + kickDur, 1, "inOut"]];
      const kick: Track = kickDur > 0 ? { sx: kickFrames, sy: kickFrames } : {};

      const slab: ShapePiece = {
        id: `slab:${n}:w${cell.at}s`, kind: "shape", z: z + 2, fromMs: rev0, toMs,
        track: cell.hero ? { x: [[rev0, pivotX]], y: [[rev0, pivotY]], ...kick } : { x: [[rev0, cell.x]], y: [[rev0, slabTop]] },
        clip: clipOf(lo, hi, "lead", slabReveal, front, top - 14 * u * f, top + rowH + 14 * u * f, rev0, toMs, edges),
        path: rectPath(0, 0, cell.w, slabH),
        fill: { colour: cell.hero ? palette.key : input.colours.primary },
        ...(cell.hero ? { origin: { dx: pivotX - cell.x, dy: pivotY - slabTop } } : {}),
      };
      const hasSlab = hasTwoPaintedFrames(slab, input);
      if (hasSlab) pieces.push(slab);

      if (hasSlab && cell.hero && kickDur > 0 && flashAlpha >= 0.04) {
        const flashDur = Math.min(FLASH_MS, kickDur);
        const flashEnd = Math.min(toMs, Math.ceil(landing + flashDur));
        if (paintedFrameCount(landing, flashEnd, fps) >= 2) {
          pieces.push({
            id: `slab:${n}:w${cell.at}f`, kind: "shape", z: z + 3, fromMs: landing, toMs: flashEnd,
            track: { x: [[landing, pivotX]], y: [[landing, pivotY]], o: [[landing, flashAlpha], [landing + flashDur, 0, "out"]], ...kick },
            clip: clipOf(lo, hi, "lead", () => 1, null, top - 14 * u * f, top + rowH + 14 * u * f, landing, flashEnd, []),
            path: rectPath(0, 0, cell.w, slabH), fill: { colour: "#FFFFFF" },
            origin: { dx: pivotX - cell.x, dy: pivotY - slabTop },
          });
        }
      }

      // The dark ink on the slab: the word's face.
      pieces.push({
        id: `slab:${n}:w${cell.at}`, kind: "text", z: z + 4, fromMs: rev0, toMs,
        track: cell.hero ? { x: [[rev0, pivotX]], y: [[rev0, pivotY]], ...kick } : { x: [[rev0, textX]], y: [[rev0, baseline]] },
        clip: clipOf(lo, hi, "lead", inkReveal, front, top - 0.4 * rowH, top + 1.4 * rowH, rev0, toMs, edges),
        text: cell.text, face: FACE, sizePx: size, letterSpacingEm: cell.spacing, fill: hasSlab ? (cell.hero ? palette.keyInk : INK) : input.colours.primary, anchor: "baseline-left", language: cue.language,
        ...(!hasSlab ? { shadows: [{ dx: 0, dy: 3 * u * f, blur: 3 * u * f, colour: input.colours.shadow, alpha: 0.75 }] } : {}),
        ...(cell.hero ? { origin: { dx: pivotX - textX, dy: pivotY - baseline } } : {}),
      });

      // The white text under the slab, uncovered as the retract front passes.
      if (!cell.hero && retracts) {
        const baseEnd = exitEnd(ri);
        const shadows = [
          { dx: 0, dy: 5 * u * f, blur: 0, colour: input.colours.shadow, alpha: 0.8 },
          { dx: 0, dy: 8 * u * f, blur: 12 * u * f, colour: input.colours.shadow, alpha: 0.8 },
        ].slice(0, cue.words.length > 18 ? 1 : 2);
        const base: TextPiece = {
          id: `slab:${n}:w${cell.at}b`, kind: "text", z: z + 1, fromMs: retractAt, toMs: baseEnd,
          track: { x: [[retractAt, textX]], y: [[retractAt, baseline]] },
          text: cell.text, face: FACE, sizePx: size, letterSpacingEm: cell.spacing, fill: input.colours.primary, anchor: "baseline-left", language: cue.language, shadows,
        };
        if (exitCapable) {
          const pad = SHADOW_PAD * u * f;
          const loB = cell.x - pad;
          const hiB = cell.x + cell.w + pad;
          const edgeB = (t: number) => clamp(rtl ? row.right + pad - (width + pad) * exit(t) : row.left - pad + (width + pad) * exit(t), loB, hiB);
          const exitEdges = [exitAt(ri), exitAt(ri) + exitDur];
          base.clip = {
            x1: sampled((t) => (rtl ? loB : edgeB(t)), retractAt, baseEnd, exitEdges),
            x2: sampled((t) => (rtl ? edgeB(t) : hiB), retractAt, baseEnd, exitEdges),
            y1: [[retractAt, top - 60 * u * f]], y2: [[retractAt, top + rowH + 60 * u * f]],
          };
        }
        pieces.push(base);
      }
    }

    // The scan bar rides the retract front across each run of words that leave.
    if (retracts) {
      const runs: Cell[][] = [];
      let open = false;
      for (const cell of row.cells) {
        if (cell.hero) open = false;
        else if (open) runs.at(-1)!.push(cell);
        else {
          runs.push([cell]);
          open = true;
        }
      }
      runs.forEach((run, ri2) => {
        const a1 = Math.min(...run.map((cell) => cell.a));
        const a2 = Math.max(...run.map((cell) => cell.a + cell.w));
        const dFront = (t: number) => dist(retract(t));
        const enter = reaches(dFront, a1 + 0.5, retractAt, retractAt + retractDur);
        const leave = reaches(dFront, a2, retractAt, retractAt + retractDur);
        if (enter === null || leave === null) return;
        const barFrom = Math.floor(enter);
        const barTo = Math.ceil(leave);
        if (paintedFrameCount(barFrom, barTo, fps) < 3) return;
        const barW = 4 * u * f;
        const runLo = Math.min(...run.map((cell) => cell.x));
        const runHi = Math.max(...run.map((cell) => cell.x + cell.w));
        const slabH = rowH - 2 * SLAB_INSET * u * f;
        pieces.push({
          id: `slab:${n}:scan${ri}-${ri2}`, kind: "shape", z: z + 5, fromMs: barFrom, toMs: barTo,
          track: { x: sampled((t) => frontX(retract(t)), barFrom, barTo, [retractAt, retractAt + retractDur], 0.4), y: [[barFrom, top + SLAB_INSET * u * f]] },
          clip: { x1: [[barFrom, runLo]], x2: [[barFrom, runHi]], y1: [[barFrom, top - 4 * u * f]], y2: [[barFrom, top + rowH + 4 * u * f]] },
          path: rectPath(0, 0, barW, slabH), origin: { dx: barW / 2, dy: 0 }, fill: { colour: palette.deco },
        });
      });
    }
  });

  // The rule under the last row: wiped in from the side the slabs do not come from, leaving with the last row's exit.
  const lastIndex = rows.length - 1;
  const variant = n % 3;
  const lastWidth = lastRow.right - lastRow.left;
  const ruleWidth = variant === 0 ? lastWidth : lastWidth * (0.34 + 0.16 * seeded(cue.words.map((word) => word.text).join(" "), n));
  const flushRight = variant === 0 ? false : (variant === 1) === rtl;
  const ruleLo = flushRight ? lastRow.right - ruleWidth : lastRow.left;
  const ruleHi = ruleLo + ruleWidth;
  const ruleTop = lastRow.top + dy + lastRow.height + RULE_GAP * u * f;
  const ruleH = RULE_H * u * f;
  // It lands with the line's last word.
  const lastWordStart = Math.max(...lastRow.cells.map((cell) => cue.words[cell.at]!.startMs));
  const ruleFrom = Math.max(from, lastWordStart - 60);
  const ruleTo = exitEnd(lastIndex);
  if (paintedFrameCount(ruleFrom, ruleTo, fps) >= 3) {
    const ruleDur = Math.max(0, Math.min(RULE_MS, ruleTo - ruleFrom - frameMs * 2));
    const ruleReveal = (t: number) => (ruleDur < frameMs ? 1 : 0.1 + 0.9 * EASES.outExpo(prog(t, ruleFrom, ruleDur)));
    const exit = rowExit[lastIndex]!;
    const lastMargin = lastRow.cells.some((cell) => cell.hero) ? kickPad : 0;
    const lastWidthPx = lastRow.right - lastRow.left;
    const front = (t: number) => (rtl ? lastRow.right - ((lastWidthPx + lastMargin) * exit(t) - lastMargin) : lastRow.left + (lastWidthPx + lastMargin) * exit(t) - lastMargin);
    pieces.push({
      id: `slab:${n}:rule`, kind: "shape", z: z + 0, fromMs: ruleFrom, toMs: ruleTo,
      track: { x: [[ruleFrom, ruleLo]], y: [[ruleFrom, ruleTop]] },
      clip: clipOf(ruleLo, ruleHi, "trail", ruleReveal, front, ruleTop - 2, ruleTop + ruleH + 2, ruleFrom, ruleTo, [ruleFrom, ruleFrom + ruleDur, exitAt(lastIndex), exitAt(lastIndex) + exitDur]),
      path: rectPath(0, 0, ruleWidth, ruleH), fill: { colour: palette.deco },
    });
  }

  // The bullet: a key-colour square before the first row, where the safe area leaves room for it.
  const first = rows[0]!;
  const bulletSize = BULLET * u * f;
  const diamond = n % 2 === 1;
  const reach = bulletSize * (diamond ? 1.45 : 1.15);
  const bulletX = rtl ? first.right + BULLET_GAP * u * f + reach / 2 : first.left - BULLET_GAP * u * f - reach / 2;
  const canvas = input.canvas;
  const bulletRoom = rtl ? bulletX + reach / 2 <= canvas.width * 0.95 : bulletX - reach / 2 >= canvas.width * 0.05;
  const bulletTo = exitCapable ? Math.min(end, Math.ceil(exitAt(0) + exitDur)) : end;
  if (bulletRoom && paintedFrameCount(decoFrom, bulletTo, fps) >= 3) {
    const popDur = Math.min(220, Math.max(frameMs * 2, bulletTo - decoFrom - frameMs * 2));
    const out = exitCapable ? exitAt(0) : end;
    const scale: Frames = exitCapable
      ? [[decoFrom, 0.15], [decoFrom + popDur, 1, "outBack"], [Math.max(decoFrom + popDur, out), 1], [Math.max(decoFrom + popDur, out) + exitDur, 0.15, "in"]]
      : [[decoFrom, 0.15], [decoFrom + popDur, 1, "outBack"]];
    pieces.push({
      id: `slab:${n}:bullet`, kind: "shape", z: z + 5, fromMs: decoFrom, toMs: bulletTo,
      track: { x: [[decoFrom, bulletX]], y: [[decoFrom, first.top + dy + first.height / 2]], sx: scale, sy: scale, rz: [[decoFrom, diamond ? 45 : 0]] },
      path: rectPath(0, 0, bulletSize, bulletSize), origin: { dx: bulletSize / 2, dy: bulletSize / 2 }, fill: { colour: palette.deco },
    });
  }

  const margin = 2 * u;
  const safe = { x1: space.safe.x1 + margin, y1: space.safe.y1 + margin, x2: space.safe.x2 - margin, y2: space.safe.y2 - margin };
  const withinCue = pieces.map((piece) => piece.fromMs < from ? { ...piece, fromMs: from } : piece);
  return clampToSafeArea(withinCue, safe, input.measure).filter((piece) => /^slab:\d+:w\d+$/.test(piece.id) || hasTwoPaintedFrames(piece, input));
}

export const slabProgram: SceneProgram = {
  build(input) {
    const space = sceneSpace(input, ANCHOR);
    const fps = input.fps ?? SCENE_DEFAULT_FPS;
    const keys = [input.colours.highlight, input.colours.accent, MINT, BLUE];
    let heroCount = 0;
    let plainCount = 0;
    const pieces: Piece[] = [];
    for (const window of speechWindows(input, space.safe, LEAD, HOLD)) {
      const { cue, index: n, start, spokenEnd, from, to, bounds } = window;
      const lane = speechLaneSpace(space, bounds, ANCHOR);
      const geo = layoutCue(cue, input, lane);
      if (!geo) continue;
      const plan: Plan = { dy: 0, from, end: to, first: start, last: spokenEnd, box: geo.box };
      const ctx: Ctx = { input, u: space.u, fps, frameMs: 1000 / sceneSampleRate(fps), space: lane };
      const hero = cue.words.some((word) => word.role === "hero");
      const key = keys[heroCount % keys.length]!;
      const palette: Palette = { key, keyInk: inkOn(key), deco: hero ? key : keys[(plainCount + 1) % keys.length]! };
      pieces.push(...buildCue(n, cue, geo, plan, palette, ctx));
      if (hero) heroCount++;
      else plainCount++;
    }
    return { pieces };
  },
};

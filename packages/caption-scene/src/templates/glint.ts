import { CAPTION_SCENE_BRAND_MIN_CONTRAST, captionColourContrast, captionSceneMeta } from "@narriflow/validators";
import type { DemoScript } from "../demo";
import { clamp, type Ease } from "../ease";
import { exportFrameAtOrBefore, paintedFrameCount } from "../frame-grid";
import { type Box, mixColour, type PathCmd, type Piece, type TextPiece, type Track } from "../scene";
import { sparklePath } from "../shapes";
import { caps, galleryScene, letterCells, rotatePoint, rowBounds, rowsOf } from "./gallery-layout";
import type { SpeechCell } from "./speech-layout";

/**
 * Glint (`samples/templates/m72-glint.js`): fat rounded caps in two colours, yellow over hot pink, each letter wearing a
 * thick dark outline, a hard stepped extrusion and a soft drop shadow, the rows on a playful tilt. Words pop in whole;
 * the key word pops in letter by letter at small resting angles; a white light pass runs across each word, and small
 * sparkles and hearts twinkle at the key word's shoulders.
 *
 * Changes from the sample, and why (Sol's gallery 6 review, `gallery6-sample-review.md`, and the owner's "fix the issues
 * in the demos and make them more correct and amazing"):
 * - **Readable at onset.** The sample faded the key word in letter by letter over a 150 ms stagger and recoloured every
 *   word from white over 230 ms, so the colour only arrived long after the word was spoken. Every word lands in its own
 *   pink or yellow on its first painted frame, opaque; nothing is drawn before its spoken start (the sample started up
 *   to 70 ms early). The key word is whole on its first painted frame: every letter is drawn from the word's start and only
 *   the letters' bounces are staggered (within 45 ms, never past 40% of a short word's time), so "SAY" never shows as "SA".
 *   A key word of more than 12 letters, a joined script or a word broken across rows bounces as one.
 * - **A light pass, not a recolour.** The white flash is a narrow white copy of the word, clipped to a vertical band that
 *   crosses it in about 200 ms, so any point of the lettering is white for roughly 48 ms (Sol: 35-55 ms) while the
 *   word is already readable. On a long hold the band crosses the whole caption again, every 1.5 s. The band is a thin strip
 *   along the top edge of the lettering (it follows the tilt), not a fill of the whole letter, and it runs on every cue:
 *   what does not fit in the 150-260 ms crossing is compressed into the frames the cue has.
 * - **One short bounce.** 88% to 105% to 100% over 115 ms with the sample's tilt settling and a short drop, instead of the
 *   420 ms spring; the time compresses into a short word's own time.
 * - **Twinkles are small and off the ink.** Two 18-28 px (tip to tip with the outline) sparkles or hearts (hearts every third), placed at the key
 *   word's shoulders, chosen among four spots by the least overlap with any other word, and kept inside the safe area. The
 *   sample's 130 px star sat in the middle of the "O". A cue without a key word twinkles over its last word.
 * - **Depth is painted, so rows are cleared from it.** The extrusion is far-to-near (soft shadow and dark back, the depth
 *   colour, the face; a mid copy changed nothing in a side-by-side, so it is not drawn), all on one pivot so it tilts and scales with the face. The row pitch is the painted
 *   depth of the row above plus the outline of the next, plus what the two rows' different tilts take at their ends, so
 *   an extrusion never runs into the next row's lettering (the sample's second row sat on the first row's shadow).
 * - **Cost.** The soft drop shadow is one blurred copy per whole-word unit; a hero word's letters skip the dark back copy and
 *   its shadow (their extrusion outline is widened to the same reach). Each light pass is its own short-lived copy, so
 *   nothing is rasterised and clipped between passes. Full export 1.36x Headline (CPU).
 * - **Twinkles on short cues.** A cue too short for the full 300 ms twinkle compresses it into the frames it has, and into a
 *   compact static pose below four painted frames; never before the key word, never past the cue.
 * - **Long words.** A word that breaks across rows takes the fewest rows, split to even measured widths, and the rows take the
 *   fitted size (the largest at which the widest still fits the column), not the floor, so the pieces read as one stacked word.
 * - **Packing.** A cue is laid out at the largest of five scales that packs it into three rows (else the fewest it can reach),
 *   before it ever stacks four. Words per cue is 3: at 4 the text had to shrink to 0.70-0.79 of its size on real cues, at 3 it
 *   holds the full 0.86 floor of the minor words.
 * - **Colours as received.** The Studio's colour controls bypass the brand kit's check, so each face keeps 3:1 against the dark
 *   outline it sits in (else the style's own pink or yellow) and the light pass must be lighter than both faces (else white).
 * - **Cue handoff.** The cue leaves as one unit (fade and a small shrink over the last 70 ms of its window, only when two
 *   painted frames fit after the reading hold); nothing of it is left behind for the next cue to land on ("MAKE" over the
 *   ghost of "TODAY").
 * - **Rows from the words.** The sample's " / " breaks and its `BLOCK_TILT[ci]` table are gone: rows are balanced from the
 *   words at the sample's sizes, the row with the key word is pink, rows alternate from it, and the block tilt cycles by
 *   cue. Minor words are 86% of the body size so "the" and "a" do not carry a line. A word wider than the column shrinks
 *   to a readable floor and, below it, breaks across rows (a Devanagari or Arabic word never breaks, it shrinks).
 * - **Brand colours.** The two row colours are the preset's primary and highlight; a brand colour gets a depth colour
 *   derived from it. The dark outline is fixed, so the row's `readsOn` is that dark.
 *
 * Extra recurring beats on every cue: the light pass on each word (and the caption-wide pass on holds), the twinkle pair
 * (re-fired on holds, alternating spots), and the key word's letters resting at small alternating angles.
 */

export const GLINT_DEMO: DemoScript = {
  lines: [
    "stop:b scrolling:b and:m LISTEN:h@520",
    "nobody:b tells:b you:m THIS:h@460",
    "it's:m free:b and:m easy:b",
    "just:b start:b TODAY:h@520",
    "make:b it:m HAPPEN:h@560",
  ],
  options: { rate: 225, gap: 45, cueGap: 160, tail: 640, lead: 340 },
};

const FACE = "Titan One";
const SPACING = 0.012;
const FS = 142;
const HERO_FS = 214;
const MINOR_SCALE = 0.86;
const BODY_FLOOR = FS * 0.64;
const HERO_FLOOR = FS * 0.82;
const COLUMN = 870;
/** Smaller scales tried when a cue would stack four rows or more. */
const SCALES = [0.92, 0.84, 0.77, 0.7] as const;
const GAP = 30;
const BLOCK_TILT = [-4, 3.5, -3, 4, -3.5] as const;
const ROW_TILT = [-1.4, 1.2] as const;
const LETTER_REST = [-3, 2, -2, 3, -3, 2, -2, 3, -2] as const;

const INK = "#2B0F45";
const SHADOW_INK = "#140828";
const OUTLINE = 0.07;
const DEPTH = 0.105;
const BACK = 1.3;
/** Lowest painted point of the stack below the ink, in em: the back copy's offset and its outline. */
const REACH_BELOW = BACK * DEPTH + OUTLINE;

const BOUNCE_MS = 115;
const HERO_SPREAD_MS = 45;
const DWELL_MS = 48;
const SWEEP_MIN_MS = 150;
const SWEEP_MAX_MS = 260;
const PASS_EVERY_MS = 1500;
const TWINKLE_MS = 300;
const EXIT_MS = 70;

/** The sample's two lines: yellow over burnt orange, hot pink over wine. */
const SAMPLE_DEPTH: Record<string, string> = { "#FFD320": "#D2570B", "#FF2F8B": "#9C0F55" };
const depthOf = (face: string) => SAMPLE_DEPTH[face.toUpperCase()] ?? mixColour(face, "#5A0B2E", 0.55);

/** Words the face can draw letter by letter, and so can be broken across rows when one is wider than the column. */
const SPLITTABLE = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{N}\p{P}]+$/u;

const heartPath = (r: number): PathCmd[] => {
  const p = (x: number, y: number) => [x * r, y * r] as const;
  const c = (a: readonly [number, number], b: readonly [number, number], e: readonly [number, number]): PathCmd => ["C", ...a, ...b, ...e];
  return [["M", ...p(0, 0.92)], c(p(-1.15, 0.12), p(-0.95, -0.82), p(-0.42, -0.82)), c(p(-0.16, -0.82), p(0, -0.62), p(0, -0.46)), c(p(0, -0.62), p(0.16, -0.82), p(0.42, -0.82)), c(p(0.95, -0.82), p(1.15, 0.12), p(0, 0.92)), ["Z"]];
};

type Key = [number, number, Ease?];

interface Sweep {
  readonly t0: number;
  readonly t1: number;
  readonly left: number;
  readonly right: number;
  readonly band: number;
}

interface Unit {
  readonly id: string;
  readonly word: number;
  /** One letter of a key word: its light pass is the word's. */
  readonly letter: boolean;
  readonly cell: SpeechCell;
  readonly row: number;
  /** Pivot, canvas px: the ink centre. */
  readonly x: number;
  readonly y: number;
  readonly angle: number;
  readonly fill: string;
  readonly depth: string;
  readonly from: number;
  /** Delay of this letter's bounce inside the word's first frame onward; the letter itself is painted from `from`. */
  readonly delay: number;
  readonly settled: number;
  readonly motion: boolean;
  readonly box: Box;
}

const union = (boxes: readonly Box[]): Box => ({
  x1: Math.min(...boxes.map((box) => box.x1)),
  y1: Math.min(...boxes.map((box) => box.y1)),
  x2: Math.max(...boxes.map((box) => box.x2)),
  y2: Math.max(...boxes.map((box) => box.y2)),
});

const aabb = (cx: number, cy: number, w: number, h: number, angle: number): Box => {
  const a = (angle * Math.PI) / 180;
  const hw = (Math.abs(Math.cos(a)) * w + Math.abs(Math.sin(a)) * h) / 2;
  const hh = (Math.abs(Math.sin(a)) * w + Math.abs(Math.cos(a)) * h) / 2;
  return { x1: cx - hw, y1: cy - hh, x2: cx + hw, y2: cy + hh };
};

const overlapArea = (a: Box, b: Box) => Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1)) * Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));

export const glintProgram = galleryScene("glint", 1290, (ctx) => {
  const { cue, index, to, bounds } = ctx.window;
  const { exit, exitAt, fps, space } = ctx;
  const c = ctx.input.colours;
  const { words } = cue;
  const heroed = words.some((word) => word.role === "hero");
  const texts = words.map((word) => caps(word, cue));

  // The scene's colours as drawn: each face keeps 3:1 against the dark outline it sits in, else the style's own; the light pass
  // must be lighter than both faces or it is the style's white (the Studio's colour controls can send any of these).
  const defaults = captionSceneMeta("glint").colours;
  const keep = (colour: string, fallback: string) => (captionColourContrast(colour, INK) >= CAPTION_SCENE_BRAND_MIN_CONTRAST ? colour : fallback);
  const faceA = keep(c.primary, defaults.primary);
  const faceB = keep(c.highlight, defaults.highlight);
  const light = captionColourContrast(c.accent, INK) >= Math.max(captionColourContrast(faceA, INK), captionColourContrast(faceB, INK)) ? c.accent : defaults.accent;

  // Sizes: the sample's, minor words a little smaller; a word wider than the column shrinks to a floor, then breaks across
  // rows. The whole cue is laid out at the largest scale that packs it into three rows (or the fewest it can reach).
  const at100 = (text: string) => ctx.input.measure(text, FACE, 100 * space.u, SPACING).advance / space.u;
  const chunkAt = (text: string, size: number): string[] => {
    const split = (room: number): string[] => {
      const out: string[] = [];
      let row = "";
      for (const ch of text) {
        if (row && at100(row + ch) > room) {
          out.push(row);
          row = "";
        }
        row += ch;
      }
      if (row) out.push(row);
      return out;
    };
    // The fewest rows that fit the column, then the narrowest limit that still gives that many, so the rows come out even
    // (UNBELIEVABLE is UNBELIE / VABLE-ish halves, never UNBELI / EVABL / E).
    const room = (COLUMN * 0.97 * 100) / size;
    const rows = split(room).length;
    let lo = 0;
    let hi = room;
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      if (split(mid).length <= rows) hi = mid;
      else lo = mid;
    }
    return split(hi);
  };
  const arrange = (scale: number) => {
    const flat: { word: number; part: number; text: string; size: number }[] = [];
    const indexes = words.map((word, at) => {
      const hero = word.role === "hero";
      const base = (hero ? HERO_FS : word.role === "minor" ? FS * MINOR_SCALE : FS) * scale;
      const floor = hero ? HERO_FLOOR : BODY_FLOOR;
      const natural = (at100(texts[at]!) * base) / 100;
      const fitted = natural > COLUMN ? (base * COLUMN) / natural : base;
      const splittable = SPLITTABLE.test(texts[at]!);
      if (natural <= COLUMN || fitted >= floor || !splittable) return [flat.push({ word: at, part: 0, text: texts[at]!, size: fitted }) - 1];
      // Split rows take the fitted size: the largest at which the widest even row still fits the column, never below the floor.
      const chunks = chunkAt(texts[at]!, floor);
      const widest = Math.max(...chunks.map((chunk) => at100(chunk)));
      const size = clamp((COLUMN * 0.97 * 100) / widest, floor, Math.max(floor, base));
      return chunks.map((text, part) => flat.push({ word: at, part, text, size }) - 1);
    });
    const groups: number[][] = [];
    let run: number[] = [];
    for (const list of indexes) {
      if (list.length > 1) {
        // Each fragment of a broken word is its own group, so no fragment can share a row (the shared layout keeps the row
        // width when it shrinks a lane, so shrunk fragments would otherwise sit side by side with a word gap).
        if (run.length) groups.push(run);
        run = [];
        for (const at of list) groups.push([at]);
      } else run.push(list[0]!);
    }
    if (run.length) groups.push(run);
    const { cells, unit } = ctx.layout({
      column: COLUMN, padding: 40, gap: GAP, groups,
      words: flat.map((item) => ({ text: item.text, size: item.size, face: FACE, spacing: SPACING })),
    });
    return { flat, indexes, laid: cells, u: unit, rows: rowsOf(cells) };
  };
  let plan = arrange(1);
  for (const scale of SCALES) {
    if (plan.rows.length <= 3) break;
    const next = arrange(scale);
    if (next.rows.length < plan.rows.length) plan = next;
  }
  const { flat, indexes, laid, u, rows } = plan;
  const rowOfCell = new Map<SpeechCell, number>();
  for (const [r, row] of rows.entries()) for (const cell of row) rowOfCell.set(cell, r);

  // Row pitch from the painted depth above, the outline below, and what the rows' different tilts take at their ends.
  const rowTilt = (r: number) => ROW_TILT[r % 2]!;
  const tilt = BLOCK_TILT[index % BLOCK_TILT.length]!;
  const shift: number[] = [0];
  rows.forEach((row, r) => {
    if (r === 0) return;
    const prev = rows[r - 1]!;
    const below = Math.max(...prev.map((cell) => cell.inkBottom + REACH_BELOW * cell.size));
    const above = Math.max(...row.map((cell) => -cell.inkTop + (OUTLINE + 0.05) * cell.size));
    const widths = [rowBounds(prev), rowBounds(row)].map((box) => box.x2 - box.x1);
    const slope = Math.tan((Math.abs(rowTilt(r) - rowTilt(r - 1)) * Math.PI) / 180);
    const needed = below + above + 0.03 * Math.max(...row.map((cell) => cell.size)) + 0.5 * Math.min(...widths) * slope;
    const actual = row[0]!.baseline - prev[0]!.baseline;
    shift.push(shift[r - 1]! + Math.max(0, needed - actual));
  });
  const inkTop = (r: number, dy: number) => rows[r]![0]!.baseline + dy + Math.min(...rows[r]!.map((cell) => cell.inkTop));
  const inkBottom = (r: number, dy: number) => rows[r]![0]!.baseline + dy + Math.max(...rows[r]!.map((cell) => cell.inkBottom + REACH_BELOW * cell.size));
  const last = rows.length - 1;
  const recentre = (inkTop(0, 0) + inkBottom(last, 0) - inkTop(0, shift[0]!) - inkBottom(last, shift[last]!)) / 2;
  const baselineOf = (cell: SpeechCell) => {
    const r = rowOfCell.get(cell)!;
    return cell.baseline + shift[r]! + recentre;
  };

  // The block turns about its centre; each row first turns a little about its own.
  const all = rowBounds(laid);
  const bcx = (all.x1 + all.x2) / 2;
  const bcy = (inkTop(0, shift[0]! + recentre) + inkBottom(last, shift[last]! + recentre)) / 2;
  const spot = (cell: SpeechCell, px: number, mid: number) => {
    const r = rowOfCell.get(cell)!;
    const box = rowBounds(rows[r]!);
    const rcx = (box.x1 + box.x2) / 2;
    const rcy = baselineOf(cell) - 0.36 * Math.max(...rows[r]!.map((item) => item.size));
    const [rx, ry] = rotatePoint(px - rcx, baselineOf(cell) + mid - rcy, rowTilt(r));
    const [bx, by] = rotatePoint(rcx + rx - bcx, rcy + ry - bcy, tilt);
    return { x: bcx + bx, y: bcy + by, angle: tilt + rowTilt(r) };
  };

  // Which rows are pink: the key word's, and every second row from it.
  const heroRows = new Set<number>();
  flat.forEach((item, at) => {
    if (words[item.word]!.role === "hero") heroRows.add(rowOfCell.get(laid.find((cell) => cell.at === at)!)!);
  });
  const anchorRow = heroRows.size ? Math.min(...heroRows) : 1;
  const pink = (r: number) => heroRows.has(r) || (r - anchorRow) % 2 === 0;

  const exitFrom = Math.max(exitAt, to - EXIT_MS);
  const exitOn = exit && paintedFrameCount(exitFrom, to, fps) >= 2;
  const units: Unit[] = [];
  words.forEach((word, w) => {
    const cells = indexes[w]!.map((at) => laid.find((cell) => cell.at === at)!);
    const hero = word.role === "hero";
    const timing = ctx.enter(word, BOUNCE_MS, 0);
    const lastFrame = exportFrameAtOrBefore(word.endMs - 1, fps);
    const parts: { cell: SpeechCell; id: string; rest: number; delay: number }[] = [];
    if (cells.length > 1) {
      for (const [part, cell] of cells.entries()) parts.push({ cell, id: `${ctx.id}:w${w}l${part}`, rest: 0, delay: 0 });
    } else {
      const letters = hero ? letterCells(cells[0]!, ctx.input, 12) : [cells[0]!];
      if (letters.length > 1) {
        const spread = Math.min(HERO_SPREAD_MS, Math.max(0, lastFrame - timing.from) * 0.4);
        for (const [k, cell] of letters.entries()) parts.push({ cell, id: `${ctx.id}:w${w}l${k}`, rest: LETTER_REST[k % LETTER_REST.length]!, delay: (k * spread) / (letters.length - 1) });
      } else parts.push({ cell: cells[0]!, id: `${ctx.id}:w${w}`, rest: 0, delay: 0 });
    }
    for (const part of parts) {
      const owner = cells.length > 1 ? part.cell : cells[0]!;
      const r = rowOfCell.get(owner)!;
      const mid = (part.cell.inkTop + part.cell.inkBottom) / 2;
      const at = spot(owner, part.cell.x, mid);
      const settled = Math.max(timing.from, Math.min(timing.from + BOUNCE_MS, lastFrame));
      const fill = pink(r) ? faceB : faceA;
      const reach = OUTLINE * part.cell.size;
      units.push({
        id: part.id, word: w, letter: cells.length === 1 && parts.length > 1, cell: part.cell, row: r, x: at.x, y: at.y, angle: at.angle + part.rest, fill, depth: depthOf(fill),
        from: timing.from, delay: part.delay, settled, motion: paintedFrameCount(timing.from, settled, fps) >= 2,
        box: aabb(at.x, at.y, part.cell.width + 2 * reach, part.cell.inkBottom - part.cell.inkTop + 2 * reach, at.angle + part.rest),
      });
    }
  });

  const wordBox = (w: number) => union(units.filter((unit) => unit.word === w).map((unit) => unit.box));
  const blockBox = union(units.map((unit) => unit.box));
  const lastStart = Math.max(...words.map((word) => word.startMs));

  // Light passes: one over each word as it lands, then one across the whole caption every 1.5 s of a hold.
  const sweepOf = (t0: number, left: number, right: number, share: number): Sweep => {
    const width = Math.max(1, right - left);
    const band = share * width;
    return { t0, t1: t0 + clamp((DWELL_MS * (width + band)) / band, SWEEP_MIN_MS, SWEEP_MAX_MS), left, right, band };
  };
  const passes: number[] = [];
  const passLength = sweepOf(0, blockBox.x1, blockBox.x2, 0.22).t1;
  for (let t = lastStart + 650; t + passLength <= exitFrom; t += PASS_EVERY_MS) passes.push(t);

  const pieces: Piece[] = [];
  const poseTrack = (unit: Unit): Track => {
    const { from, settled, motion, x, y, cell } = unit;
    // A letter is whole from the word's first frame; its bounce starts a few ms later (held at 88% until then).
    const at = from + Math.min(unit.delay, 0.4 * (settled - from));
    const sx: Key[] = motion ? [[from, 0.88], ...(at > from ? [[at, 0.88] as Key] : []), [at + 0.55 * (settled - at), 1.05, "out"], [settled, 1, "inOut"]] : [[from, 1]];
    const py: Key[] = motion ? [[from, y + 0.06 * cell.size], [settled, y, "out"]] : [[from, y]];
    const rz: Key[] = motion ? [[from, unit.angle - 7], [settled, unit.angle, "out"]] : [[from, unit.angle]];
    const o: Key[] = [[from, 1]];
    if (exitOn) {
      sx.push([exitFrom, 1], [to, 0.93, "in"]);
      py.push([exitFrom, y], [to, y - 0.03 * cell.size, "in"]);
      o.push([exitFrom, 1], [to, 0, "in"]);
    }
    return { x: [[from, x]], y: py, sx, sy: sx, rz, o };
  };

  for (const unit of units) {
    const { cell } = unit;
    const mid = (cell.inkTop + cell.inkBottom) / 2;
    const d = DEPTH * cell.size;
    const stroke = { widthPx: OUTLINE * cell.size, colour: INK };
    const base = ctx.face(cell, unit.from, unit.fill, poseTrack(unit));
    const layer = (suffix: string, z: number, fill: string, offset: number, extra: Partial<TextPiece> = {}): TextPiece => ({
      ...base, id: `${unit.id}${suffix}`, z, fill, stroke, origin: { dx: -offset * d, dy: mid - offset * d }, ...extra,
    });
    // A hero word's letters skip the dark back copy (and its soft shadow): their extrusion outline is widened to the same reach.
    if (!unit.letter) pieces.push(layer("b", 3, INK, BACK, { shadows: [{ dx: 0, dy: 0.085 * cell.size, blur: 0.05 * cell.size, colour: SHADOW_INK, alpha: 0.34 }] }));
    pieces.push(
      layer("e", 4, unit.depth, 1, unit.letter ? { stroke: { widthPx: (OUTLINE + (BACK - 1) * DEPTH) * cell.size, colour: INK } } : {}),
      { ...base, id: unit.id, origin: { dx: 0, dy: mid }, fill: unit.fill, stroke },
    );

    // The light pass: a thin white glint along the top edge of the face, a white copy of it seen through a vertical band that
    // crosses the word and a strip that follows the (tilted) top edge. It runs on every cue, compressed into the frames the cue has.
    const w = cell.width;
    const h = cell.inkBottom - cell.inkTop;
    const [ax, ay] = rotatePoint(-w / 2, -h / 2, unit.angle);
    const [bx, by] = rotatePoint(w / 2, -h / 2, unit.angle);
    const slope = (by - ay) / Math.max(1, bx - ax);
    const topAt = (x: number) => unit.y + ay + (clamp(x, unit.x + ax, unit.x + bx) - (unit.x + ax)) * slope;
    const local = unit.letter ? wordBox(unit.word) : unit.box;
    const sweeps: Sweep[] = [sweepOf(unit.from, local.x1, local.x2, 0.2)];
    for (const t0 of passes) {
      if (t0 >= sweeps[0]!.t1 + 2) sweeps.push({ ...sweepOf(t0, blockBox.x1, blockBox.x2, 0.22), t0 });
    }
    for (const [k, full] of sweeps.entries()) {
      const sweep = { ...full, t1: Math.min(full.t1, to) };
      const frames = paintedFrameCount(sweep.t0, sweep.t1, fps);
      if (frames < 2) continue;
      // A crossing needs a few frames to read; with fewer, the strip is static over the unit's own box.
      const steps = frames < 4 ? [0] : Array.from({ length: 5 }, (_, n) => n / 4);
      const at = (f: number) => {
        if (frames < 4) return { t: sweep.t0, x1: unit.box.x1, x2: unit.box.x2 };
        const x1 = sweep.left - sweep.band + f * (sweep.right - sweep.left + sweep.band);
        return { t: sweep.t0 + f * (sweep.t1 - sweep.t0), x1, x2: x1 + sweep.band };
      };
      const stripe = 0.18 * h + (frames < 4 ? w : sweep.band) * Math.abs(slope);
      const y1 = (f: number) => (frames < 4 ? topAt(unit.x) - 0.07 * h - 0.5 * w * Math.abs(slope) : topAt((at(f).x1 + at(f).x2) / 2) - 0.07 * h);
      pieces.push({
        ...base, id: k === 0 ? `${unit.id}h` : `${unit.id}h${k}`, z: 7, fill: light, origin: { dx: 0, dy: mid },
        fromMs: sweep.t0, toMs: sweep.t1,
        clip: {
          x1: steps.map((f) => [at(f).t, at(f).x1] as Key),
          x2: steps.map((f) => [at(f).t, at(f).x2] as Key),
          y1: steps.map((f) => [at(f).t, y1(f)] as Key),
          y2: steps.map((f) => [at(f).t, y1(f) + stripe] as Key),
        },
      });
    }
  }

  // Twinkles at the key word's shoulders (the last word's in a cue without one): the first spot with room, else the roomiest.
  const target = heroed ? words.findIndex((word) => word.role === "hero") : words.length - 1;
  const targetBox = wordBox(target);
  const size = Math.max(...units.filter((unit) => unit.word === target).map((unit) => unit.cell.size));
  // 18-28 px across with the outline: a radius of 8-12 px.
  const radius = clamp(0.08 * size, 8.5 * u, 12 * u);
  const others = units.filter((unit) => unit.word !== target).map((unit) => unit.box);
  const height = targetBox.y2 - targetBox.y1;
  const spots = [
    { x: targetBox.x2 - 0.6 * radius, y: targetBox.y1 - 0.55 * radius },
    { x: targetBox.x1 + 0.6 * radius, y: targetBox.y1 - 0.55 * radius },
    { x: targetBox.x2 + 0.75 * radius, y: targetBox.y1 + 0.2 * height },
    { x: targetBox.x1 - 0.75 * radius, y: targetBox.y1 + 0.2 * height },
  ];
  const fits = spots.map((spot) => {
    const x = clamp(spot.x, bounds.x1 + radius + 4 * u, bounds.x2 - radius - 4 * u);
    const y = clamp(spot.y, bounds.y1 + radius + 4 * u, bounds.y2 - radius - 4 * u);
    const square = { x1: x - radius, y1: y - radius, x2: x + radius, y2: y + radius };
    return { x, y, hit: others.reduce((sum, box) => sum + overlapArea(square, box), 0) };
  });
  const rank = fits.map((spot, k) => ({ ...spot, k })).sort((a, b) => (a.hit === b.hit ? a.k - b.k : a.hit - b.hit));
  const firstTwinkle = (targetStart: number) => Math.max(ctx.window.from, targetStart + 70);
  const fire = [firstTwinkle(words[target]!.startMs), ...passes.map((t) => t + 120)];
  fire.forEach((t0, j) => {
    for (let pair = 0; pair < 2; pair++) {
      const spot = rank[(pair + j) % rank.length]!;
      const wanted = t0 + pair * 110;
      // A short cue still twinkles: the pair starts as early as the key word allows, and what does not fit in the full 300 ms
      // is compressed into the frames the cue has; with only two or three painted frames it is a compact static pose.
      const stop = exitOn ? exitFrom : to;
      const start = j === 0 ? Math.max(ctx.window.from, words[target]!.startMs, Math.min(wanted, stop - 3 * (1000 / fps))) : wanted;
      const end = Math.min(stop, start + TWINKLE_MS);
      const frames = paintedFrameCount(start, end, fps);
      if (frames < 2 || end <= start) continue;
      const span = end - start;
      const still = frames < 4;
      const heart = (index + j + pair) % 3 === 0 && pair === 1;
      const path = heart ? heartPath(radius * 0.9) : sparklePath(radius, 0, 0, 0.32);
      const turn = ((index + j + pair) % 2 ? -1 : 1) * (heart ? 14 : 8);
      const shape = ctx.shape(`tw${target}-${j}${pair}`, start, path, {
        x: [[start, spot.x]], y: [[start, spot.y]],
        sx: still ? [[start, 0.8]] : [[start, 0.2], [start + 0.35 * span, 1, "out"], [end, 0, "in"]],
        sy: still ? [[start, 0.8]] : [[start, 0.2], [start + 0.35 * span, 1, "out"], [end, 0, "in"]],
        rz: still ? [[start, turn]] : [[start, turn], [end, turn + 70 * (span / TWINKLE_MS)]],
      }, light);
      pieces.push({ ...shape, z: 9, toMs: end, stroke: { widthPx: Math.max(1.5 * u, 0.12 * radius), colour: INK } });
    }
  });
  return pieces;
}, undefined, 0);

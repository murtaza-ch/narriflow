import type { DemoScript } from "../demo";
import { clamp, type Frames, lerp } from "../ease";
import { exportFrameAtOrBefore, exportFrameTimes } from "../frame-grid";
import type { SceneColours } from "../input";
import { rowsFromRoles } from "../layout";
import { type Box, mixColour, type Piece, type PathCmd, type ShapePiece, type TextPiece, type Track } from "../scene";
import { CAPTION_SCENES, captionColourContrast } from "@narriflow/validators";
import { ellipsePath } from "../shapes";
import { galleryScene, rowsOf } from "./gallery-layout";
import type { SpeechCell } from "./speech-layout";

/**
 * Halftone (`samples/templates/m75-halftone.js`): a 70s groovy fat script. Every word is a warm face (yellow, cream or
 * amber) over a short stack of offset shadow bands in orange, red and deep wine, and behind each line sits a field of flat
 * halftone dots that grows toward the shadow corner and is revealed under the words as they are spoken. Words roll in from
 * the left with a bounce and leave rolling out to the right.
 *
 * Changes from the sample, and why (Sol's gallery 6 review, 2026-11-25, plus the owner's "fix the demos"):
 * - **Readable at onset.** The sample started every word 80 ms early at 62 % scale and 34° and rolled for a fixed 560 ms,
 *   longer than most spoken words. A word now first paints on its spoken start, opaque, at 92 % scale, 40 px (never more
 *   than the gap to its neighbour) to the side and 10° turned, and settles in 110-150 ms with one 3 % overshoot, always
 *   inside the word's own time (a word too short to animate takes its rest pose at once).
 * - **Slimmer shadow.** The sample's nine stroked copies (0.18 em deep) are three offset copies, one per band, 0.04 / 0.075 /
 *   0.11 em deep with a 0.02 em border that bridges the steps, so the stack is solid at a third of the cost. A wine keyline
 *   (about 2 px) outlines the face so it separates from bright footage. The sample's CSS `drop-shadow` is left out and the thin
 *   orange rim has no bridging border (together about a quarter of the style's measured libass cost, for a 28 %-opaque shadow and a step the
 *   face's keyline already covers), which keeps the full export inside 1.5x Headline.
 * - **Quiet dots.** The large saturated dots that beaded between rows are small (radius at most 0.22 of the pitch), 36 %
 *   opaque, and appear as whole columns on the beat of the word above them (the sample's rectangular wipe sliced the leading
 *   dot in half). The field is shifted toward the shadow corner only as far as the next row's ink allows, drops to its
 *   right-hand part when the block is squeezed (a landscape frame), and stays under 76 dots and 26 columns a cue.
 * - **Rows and words follow speech.** The sample's rows were baked into " / " breaks and its palettes, tilts and sizes were
 *   indexed by cue. Rows now come from the roles (words before the key word, the key word on a row of its own, words after
 *   it, wrapped to the column before any size shrinks), a long word gets its own row before it is made smaller, and a word
 *   still wider than the column at the smallest readable size breaks across rows. Palettes and tilts cycle by cue counter.
 *   Rows are stacked by their real ink and depth and moved apart until no tilted word box meets another, so rows never touch
 *   each other, in Devanagari either. Words keep the transcript's casing (the sample lowercased everything).
 * - **Real speech.** The exit (a 160 ms roll to the right with a fade) only runs when two painted frames fit after the reading
 *   hold; nothing waits on the previous cue.
 * - Extra recurring beats, in the dots' language, on every cue: the dot field pulses in a wave out from the key word (or the
 *   last word of a key-less cue) when it lands, again every 1.7 s of a long hold; and three solid beads of falling size flick
 *   out of the key word's shoulder, in whichever free corner has room (none when there is none).
 * - Brand colours: the face is the preset's primary, the cream face the highlight, the bands are mixed from them and the red
 *   accent; the catalogue row's `readsOn` keeps a brand colour that vanishes against the wine keyline from replacing them.
 */

export const HALFTONE_DEMO: DemoScript = {
  lines: [
    "keep:b it:m Groovy:h@640",
    "good:b vibes:b Only:h@560",
    "slow:b down:b and:m smell:b the:m roses:b",
    "peace:b love:b Sunshine:h@680",
    "stay:b Golden:h@640",
  ],
  options: { rate: 235, gap: 50, cueGap: 170, tail: 720, lead: 340 },
};

const FACE = "Pacifico" as const;
const BODY = 140;
const MINOR_SCALE = 0.88;
const HERO_MAX = 244;
const HERO_MIN = 130;
/** A lone key word shrinks this far to stay whole before it is broken across rows. */
const HERO_FLOOR = 100;
/** The least contrast a face keeps against its keyline. */
const FACE_CONTRAST = 3;
const BODY_FLOOR = 96;
const COLUMN = 820;
const GAP_EM = 0.3;
/** Depth of each band's far edge, em: orange, red, wine. */
const DEPTH_EM = [0.04, 0.075, 0.11] as const;
const BORD_EM = 0.02;
const KEYLINE = 2.2;
const BLOCK_TILT = [-2, 1.5, -1, 2, -1.5] as const;
const ROW_TILT = [-3, 2.2, -1.5] as const;
const HERO_ROLL = -3;
const PALETTE_ORDER = [0, 1, 2, 0, 2] as const;
const ROLL_PX = 40;
const SETTLE_BODY = 120;
const SETTLE_HERO = 150;
/** Dots rest at 36 % (a fill of 62 % under a 58 % piece opacity) and flash to half when the wave passes. */
const DOT_FILL = 0.62;
const DOT_REST = 0.58;
const DOT_PEAK = 0.8;
const DOT_BUDGET = 76;
const COLUMN_BUDGET = 26;
/** Columns that appear and pulse as one piece. */
const CLUSTER = 3;
const PULSE_EVERY = 1700;
const PULSE_MS = 260;
/** The wave leaves the key word this long after it starts landing, and a pulse is never shorter than two frames. */
const WAVE_LEAD = 30;
const MIN_PULSE = 80;
const BAND_ABOVE = 430;
const BAND_BELOW = 380;

interface Palette {
  readonly face: string;
  readonly s1: string;
  readonly s2: string;
  readonly s3: string;
  readonly dots: string;
}

/** The sample's three palettes, derived from the preset's three colours so a brand colour recolours all of them. */
function palettesOf(c: SceneColours): readonly Palette[] {
  const wine = (tone: string, k = 0.76) => mixColour(tone, "#2A0A12", k);
  const red = c.accent;
  return [
    { face: c.primary, s1: mixColour(c.primary, red, 0.5), s2: red, s3: wine(red), dots: mixColour(c.primary, red, 0.55) },
    { face: c.highlight, s1: mixColour(c.highlight, red, 0.42), s2: mixColour(red, wine(red), 0.12), s3: wine(red), dots: red },
    { face: mixColour(c.primary, red, 0.28), s1: mixColour(c.primary, red, 0.74), s2: mixColour(red, wine(red), 0.38), s3: wine(red, 0.84), dots: mixColour(c.primary, red, 0.72) },
  ];
}

/**
 * The palettes as drawn: a palette whose final face (the blend of the second included) does not keep 3:1 against its own
 * keyline is replaced by the catalogue's default one, so a brand colour can never sink into the outline.
 */
function palettes(c: SceneColours): readonly Palette[] {
  const defaults = palettesOf({ ...CAPTION_SCENES.halftone.colours, shadow: c.shadow });
  return palettesOf(c).map((palette, at) => (captionColourContrast(palette.face, palette.s3) >= FACE_CONTRAST ? palette : defaults[at]!));
}

/** Words the face can draw letter by letter, and so can be broken across rows when one is wider than the column. */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const SPLITTABLE = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{N}\p{P}]+$/u;

const turn = (x: number, y: number, cx: number, cy: number, degrees: number): [number, number] => {
  const a = (degrees * Math.PI) / 180;
  const dx = x - cx;
  const dy = y - cy;
  return [cx + dx * Math.cos(a) - dy * Math.sin(a), cy + dx * Math.sin(a) + dy * Math.cos(a)];
};

const meets = (a: Box, b: Box, margin: number) => a.x1 < b.x2 + margin && b.x1 < a.x2 + margin && a.y1 < b.y2 + margin && b.y1 < a.y2 + margin;

interface Item {
  readonly cell: SpeechCell;
  readonly word: number;
  readonly part: number;
  readonly row: number;
  /** The pivot (the ink's centre) and turn at rest, canvas px and degrees. */
  readonly x: number;
  readonly y: number;
  readonly rz: number;
  /** Everything the word draws at rest, rotated: face, keyline and depth. */
  readonly box: Box;
}

interface Column {
  readonly row: number;
  readonly cx: number;
  readonly cy: number;
  readonly word: number;
  readonly dots: readonly { x: number; y: number; r: number }[];
}

// Words paint on their spoken onset, so a cue's window opens there (lead 0) and the cue before keeps the time up to it for its exit.
export const halftoneProgram = galleryScene("halftone", 1290, (ctx) => {
  const { cue, to, bounds, index } = ctx.window;
  const { exit, exitAt, fps, side } = ctx;
  const space = ctx.space;
  const pal = palettes(ctx.input.colours)[PALETTE_ORDER[index % PALETTE_ORDER.length]!]!;
  const pieces: Piece[] = [];

  const { lead, hero, tail } = rowsFromRoles(cue.words.map((word) => word.role));
  const heroed = hero.length > 0;
  const waveAt = heroed ? hero[0]! : cue.words.length - 1;

  // The caption band of the sample, at the user's position but not at the user's size (a larger size shrinks to fit it).
  const natural = space.u / ctx.input.scale;
  const anchorY = space.y(1290);
  const band = { y1: Math.max(bounds.y1 + 3, anchorY - BAND_ABOVE * natural), y2: Math.min(bounds.y2 - 3, anchorY + BAND_BELOW * natural) };
  const laned = bounds.y2 - bounds.y1 < 0.75 * 0.9 * space.canvas.height;

  // Sizes. The key words share one size, as large as the column allows; a long body word shrinks before it is cut.
  const at100 = (text: string) => ctx.input.measure(text, FACE, 100 * space.u, 0).advance / space.u;
  const gapPx = GAP_EM * BODY;
  const heroWidth = hero.reduce((sum, at) => sum + at100(cue.words[at]!.text), 0);
  const heroRoom = COLUMN * 0.97 - gapPx * Math.max(0, hero.length - 1);
  const heroCap = laned ? Math.min(HERO_MAX, (0.3 * (bounds.y2 - bounds.y1)) / space.u) : HERO_MAX;
  // A lone key word may shrink to HERO_FLOOR to stay whole; several share a row down to HERO_MIN and wrap beyond it.
  const heroFloor = Math.min(hero.length === 1 ? HERO_FLOOR : HERO_MIN, heroCap);
  let heroSize = heroed ? clamp((heroRoom * 100) / Math.max(1, heroWidth), heroFloor, heroCap) : 0;
  const body = laned ? Math.min(BODY, heroCap * 0.62) : BODY;
  const naturalOf = (at: number) => (cue.words[at]!.role === "minor" ? body * MINOR_SCALE : body);
  const bodyFit = (at: number) => clamp((COLUMN * 0.97 * 100) / Math.max(1, at100(cue.words[at]!.text)), BODY_FLOOR * (body / BODY), naturalOf(at));
  const sizeOf = (at: number) => (hero.includes(at) ? heroSize : bodyFit(at));

  // A word wider than the column even at its smallest readable size breaks at grapheme boundaries into the fewest rows that
  // fit, balanced by measured width; each fragment takes a row of its own, so no space ever opens inside the word.
  const chunkAt = (text: string, size: number): string[] => {
    if (!SPLITTABLE.test(text) || (at100(text) * size) / 100 <= COLUMN * 0.97) return [text];
    const room = (COLUMN * 0.9 * 100) / size;
    const parts = [...GRAPHEMES.segment(text)].map((part) => part.segment);
    const pack = (limit: number): string[] => {
      const out: string[] = [];
      let row = "";
      for (const ch of parts) {
        if (row && at100(row + ch) > limit) {
          out.push(row);
          row = "";
        }
        row += ch;
      }
      if (row) out.push(row);
      return out;
    };
    let best: string[] = pack(room);
    for (let n = 2; n <= parts.length; n++) {
      let lo = Math.max(...parts.map(at100));
      let hi = at100(text);
      for (let step = 0; step < 14; step++) {
        const mid = (lo + hi) / 2;
        if (pack(mid).length <= n) hi = mid;
        else lo = mid;
      }
      const balanced = pack(hi);
      if (balanced.length <= n && Math.max(...balanced.map(at100)) <= room) return balanced;
      best = balanced;
    }
    return best;
  };
  const chunks = cue.words.map((word, at) => chunkAt(word.text, sizeOf(at)));
  if (heroed && hero.length === 1 && chunks[hero[0]!]!.length > 1) {
    const widest = Math.max(...chunks[hero[0]!]!.map(at100));
    heroSize = clamp((COLUMN * 0.9 * 100) / widest, Math.min(HERO_FLOOR, heroCap), heroCap);
  }

  const flat: { word: number; part: number; text: string }[] = [];
  const indexes = chunks.map((texts, word) => texts.map((text, part) => flat.push({ word, part, text }) - 1));
  const isLong = (at: number) => (at100(cue.words[at]!.text) * sizeOf(at)) / 100 > 0.62 * COLUMN;
  const groupsOf = (list: number[], ownRow = isLong) => {
    const out: number[][] = [];
    let row: number[] = [];
    for (const at of list) {
      if (indexes[at]!.length > 1) {
        if (row.length > 0) out.push(row);
        row = [];
        for (const piece of indexes[at]!) out.push([piece]);
      } else if (ownRow(at)) {
        if (row.length > 0) out.push(row);
        row = [];
        out.push(indexes[at]!);
      } else row.push(indexes[at]![0]!);
    }
    if (row.length > 0) out.push(row);
    return out;
  };
  const buildGroups = (ownRow?: (at: number) => boolean) => [...groupsOf(lead, ownRow), ...groupsOf(hero, ownRow), ...groupsOf(tail, ownRow)];
  let groups = buildGroups();

  const blockTilt = BLOCK_TILT[index % BLOCK_TILT.length]!;
  const tightFrame = space.canvas.width > space.canvas.height || laned;

  const laidAt = (f: number, rowGroups: readonly number[][] = groups) =>
    ctx.layout({
      column: COLUMN,
      padding: 30,
      gap: gapPx * f,
      groups: rowGroups,
      words: flat.map((item) => ({ text: item.text, size: sizeOf(item.word) * f, face: FACE, spacing: 0 })),
    });

  /** The cue laid out at size factor `f`, rows `extra` px further apart and moved `dy`. */
  const arrange = (f: number, laid: ReturnType<typeof laidAt>, extra: number, dy: number) => {
    const { cells, unit } = laid;
    const u = unit * f;
    const rows = rowsOf(cells).sort((a, b) => a[0]!.baseline - b[0]!.baseline);
    const origTop = Math.min(...cells.map((cell) => cell.baseline + cell.inkTop));
    const origBottom = Math.max(...cells.map((cell) => cell.baseline + cell.inkBottom));
    // Rows restacked by their ink and their depth.
    let cursor = 0;
    const metas = rows.map((row, r) => {
      const size = Math.max(...row.map((cell) => cell.size));
      const above = Math.max(...row.map((cell) => -cell.inkTop)) + KEYLINE * u;
      const below = Math.max(...row.map((cell) => cell.inkBottom)) + (DEPTH_EM[2] + BORD_EM) * size + KEYLINE * u;
      if (r > 0) cursor += 0.02 * size + extra;
      const baseline = cursor + above;
      cursor = baseline + below;
      return { row, size, above, below, baseline, top: baseline - above, bottom: baseline + below };
    });
    const shift = (origTop + origBottom) / 2 - cursor / 2 + dy;
    for (const meta of metas) {
      meta.baseline += shift;
      meta.top += shift;
      meta.bottom += shift;
    }
    const left = Math.min(...cells.map((cell) => cell.x - cell.width / 2));
    const right = Math.max(...cells.map((cell) => cell.x + cell.width / 2));
    const blockX = (left + right) / 2;
    const blockY = (metas[0]!.top + metas[metas.length - 1]!.bottom) / 2;
    const rowCentre = metas.map((meta) => {
      const x1 = Math.min(...meta.row.map((cell) => cell.x - cell.width / 2));
      const x2 = Math.max(...meta.row.map((cell) => cell.x + cell.width / 2));
      return { x: (x1 + x2) / 2, y: (meta.top + meta.bottom) / 2, x1, x2 };
    });
    const rowTilt = (r: number) => ROW_TILT[r % ROW_TILT.length]!;
    const world = (x: number, y: number, r: number): [number, number] => {
      const [rx, ry] = turn(x, y, rowCentre[r]!.x, rowCentre[r]!.y, rowTilt(r));
      return turn(rx, ry, blockX, blockY, blockTilt);
    };

    const items: Item[] = metas.flatMap((meta, r) =>
      meta.row.map((cell): Item => {
        const word = flat[cell.at]!;
        const centre = (cell.inkTop + cell.inkBottom) / 2;
        const [x, y] = world(cell.x, meta.baseline + centre, r);
        const rz = blockTilt + rowTilt(r) + (hero.includes(word.word) ? HERO_ROLL : 0);
        const reach = (DEPTH_EM[2] + BORD_EM) * cell.size + KEYLINE * u;
        // The ink box with keyline and depth (the shadow falls right and down), turned about the pivot.
        const local = [
          [cell.x - cell.width / 2 - KEYLINE * u, meta.baseline + cell.inkTop - KEYLINE * u],
          [cell.x + cell.width / 2 + reach, meta.baseline + cell.inkTop - KEYLINE * u],
          [cell.x + cell.width / 2 + reach, meta.baseline + cell.inkBottom + reach],
          [cell.x - cell.width / 2 - KEYLINE * u, meta.baseline + cell.inkBottom + reach],
        ].map(([px, py]) => {
          const [tx, ty] = turn(px!, py!, cell.x, meta.baseline + centre, rz);
          return [tx! - cell.x + x, ty! - (meta.baseline + centre) + y] as const;
        });
        return {
          cell, word: word.word, part: word.part, row: r, x, y, rz,
          box: { x1: Math.min(...local.map((p) => p[0])), y1: Math.min(...local.map((p) => p[1])), x2: Math.max(...local.map((p) => p[0])), y2: Math.max(...local.map((p) => p[1])) },
        };
      }),
    );

    // Dot fields: under each row, toward its shadow corner, never closer to the next row than its ink allows.
    const pitchOf = (size: number) => clamp(0.3 * size, 34 * u, 66 * u);
    let squeeze = 1;
    const widthSum = rowCentre.reduce((sum, rc) => sum + (rc.x2 - rc.x1), 0);
    const pitchSum = metas.reduce((sum, meta, r) => sum + (rowCentre[r]!.x2 - rowCentre[r]!.x1) / pitchOf(meta.size), 0);
    if (pitchSum > COLUMN_BUDGET) squeeze = pitchSum / COLUMN_BUDGET;
    const fieldRows = tightFrame || f < 0.8 ? 2 : 3;
    if ((widthSum / (34 * u * squeeze)) * fieldRows > DOT_BUDGET * 1.6) squeeze = Math.max(squeeze, 1.15);
    const buildColumns = (squeezed: number): Column[] => {
    const columns: Column[] = [];
    let dotCount = 0;
    metas.forEach((meta, r) => {
      const pitch = pitchOf(meta.size) * squeezed;
      const inkBottom = Math.max(...meta.row.map((cell) => meta.baseline + cell.inkBottom));
      const nextTop = r + 1 < metas.length ? metas[r + 1]!.top - 3 * u : Number.POSITIVE_INFINITY;
      const fieldBottom = Math.min(inkBottom + 0.24 * meta.size, nextTop, band.y2 - 6 * u);
      const rc = rowCentre[r]!;
      const w = rc.x2 - rc.x1 + 0.06 * meta.size;
      const total = Math.max(2, Math.round(w / pitch));
      const first = tightFrame || f < 0.8 ? Math.floor(total * 0.42) : 0;
      if (fieldBottom < inkBottom - 0.05 * meta.size || total - first < 2) return;
      const rowCells = [...meta.row].sort((a, b) => a.x - b.x);
      for (let col = first; col < total; col++) {
        const dots: Column["dots"][number][] = [];
        for (let j = 0; j < fieldRows; j++) {
          const k = fieldRows - 1 - j;
          const fx = (col + 0.5) / total;
          const fy = (j + 0.5) / fieldRows;
          const g = Math.min(1, (fx * 0.62 + fy * 0.38) * 1.05);
          const radius = Math.max(1.8 * u, pitch * lerp(0.06, 0.22, g * g));
          const x = rc.x1 + (col + 0.5 + (k % 2) * 0.5) * (w / (total + 0.5));
          const y = fieldBottom - 0.42 * pitch - k * pitch * 0.86;
          if (y - radius < meta.top - 0.3 * meta.size) continue;
          const [wx, wy] = world(x, y, r);
          dots.push({ x: wx, y: wy, r: radius });
        }
        if (dots.length === 0 || dotCount + dots.length > DOT_BUDGET) continue;
        dotCount += dots.length;
        const x = rc.x1 + (col + 0.5) * (w / (total + 0.5));
        const owner = rowCells.reduce((best, cell) => (Math.abs(cell.x - x) - cell.width / 2 < Math.abs(best.x - x) - best.width / 2 ? cell : best));
        columns.push({
          row: r,
          cx: dots.reduce((sum, dot) => sum + dot.x, 0) / dots.length,
          cy: dots.reduce((sum, dot) => sum + dot.y, 0) / dots.length,
          word: flat[owner.at]!.word,
          dots,
        });
      }
    });
    return columns;
    };
    // Rounding can put a few columns over the cap: widen the pitch until the field fits, and cut what is still over.
    let columns = buildColumns(squeeze);
    for (let widen = 0; columns.length > COLUMN_BUDGET && widen < 12; widen++) {
      squeeze *= 1.07;
      columns = buildColumns(squeeze);
    }
    columns.length = Math.min(columns.length, COLUMN_BUDGET);

    // Neighbouring columns under one word share a piece, so a cue draws a handful of dot pieces, not dozens.
    const clusters: Column[] = [];
    const grouped = new Map<string, Column[]>();
    for (const column of columns) grouped.set(`${column.row}:${column.word}`, [...(grouped.get(`${column.row}:${column.word}`) ?? []), column]);
    for (const list of grouped.values()) {
      list.sort((a, b) => a.cx - b.cx);
      for (let at = 0; at < list.length; at += CLUSTER) {
        const part = list.slice(at, at + CLUSTER);
        const dots = part.flatMap((column) => column.dots);
        clusters.push({
          row: part[0]!.row, word: part[0]!.word, dots,
          cx: dots.reduce((sum, dot) => sum + dot.x, 0) / dots.length,
          cy: dots.reduce((sum, dot) => sum + dot.y, 0) / dots.length,
        });
      }
    }

    let x1 = Math.min(...items.map((item) => item.box.x1));
    let x2 = Math.max(...items.map((item) => item.box.x2));
    let y1 = Math.min(...items.map((item) => item.box.y1));
    let y2 = Math.max(...items.map((item) => item.box.y2));
    for (const column of clusters) {
      for (const dot of column.dots) {
        x1 = Math.min(x1, dot.x - dot.r * 1.45);
        x2 = Math.max(x2, dot.x + dot.r * 1.45);
        y1 = Math.min(y1, dot.y - dot.r * 1.45);
        y2 = Math.max(y2, dot.y + dot.r * 1.45);
      }
    }
    // A word rolls in a little low and out a little low.
    y2 += 16 * u;
    return { items, columns: clusters, unit, u, x1, x2, y1, y2 };
  };

  const crowded = (items: readonly Item[]) =>
    items.some((a, i) => items.slice(i + 1).some((b) => a.row !== b.row && meets(a.box, b.box, -1)));

  // A long word gets a row of its own, but four rows or more is too tall a block: when words can share rows, pack two or three
  // rows first, shrinking no further than the readable floor to do it.
  const rowCount = (rowGroups: readonly number[][], at = 1) => rowsOf(laidAt(at, rowGroups).cells).length;
  let f = 1;
  if (rowCount(groups) > 3) {
    const packed = buildGroups(() => false);
    const smallest = Math.min(...flat.map((item) => sizeOf(item.word)));
    const floor = Math.max(0.8, (BODY_FLOOR * (body / BODY)) / smallest);
    for (let at = 1; at >= floor - 1e-9; at -= 0.04) {
      if (rowCount(packed, at) <= 3) {
        groups = packed;
        f = at;
        break;
      }
    }
  }
  let laid = laidAt(f);
  let extra = 0;
  let arranged = arrange(f, laid, extra, 0);
  for (let tries = 0; tries < 12; tries++) {
    for (let pass = 0; pass < 16 && crowded(arranged.items); pass++) {
      extra += 5 * arranged.u;
      arranged = arrange(f, laid, extra, 0);
    }
    const height = arranged.y2 - arranged.y1;
    const room = band.y2 - band.y1;
    const wide = arranged.x2 - arranged.x1;
    const across = bounds.x2 - bounds.x1 - 6;
    if (height <= room + 0.5 && wide <= across + 0.5) break;
    f *= Math.min(0.95, (0.98 * room) / height, (0.98 * across) / wide);
    laid = laidAt(f);
    extra = 0;
    arranged = arrange(f, laid, extra, 0);
  }
  const dy = arranged.y1 < band.y1 ? band.y1 - arranged.y1 : arranged.y2 > band.y2 ? band.y2 - arranged.y2 : 0;
  if (dy !== 0) arranged = arrange(f, laid, extra, dy);
  const { items, columns, u } = arranged;

  // Words.
  const timing = new Map<number, ReturnType<typeof ctx.enter> & { d: number }>();
  const from = (at: number) => {
    const word = cue.words[at]!;
    const d = hero.includes(at) ? SETTLE_HERO : SETTLE_BODY;
    const known = timing.get(at);
    if (known) return known;
    const made = { ...ctx.enter(word, d, 0), d };
    timing.set(at, made);
    return made;
  };

  for (const item of items) {
    const { cell, word: at, part, row } = item;
    const { from: t0, settled, motion } = from(at);
    const size = cell.size;
    // The roll comes from the reading start, never further than the gap to the neighbour on that side.
    const neighbours = items.filter((other) => other.row === row && other !== item && Math.sign(other.cell.x - cell.x) === -side);
    const room = neighbours.reduce((least, other) => Math.min(least, Math.abs(other.cell.x - cell.x) - (other.cell.width + cell.width) / 2), Number.POSITIVE_INFINITY);
    const roll = -side * clamp(room - (DEPTH_EM[2] + BORD_EM) * size - 3 * u, 0, ROLL_PX * u);
    const lift = 16 * u;
    // The bounce needs a frame before the peak and one after it; a word with fewer frames settles monotonically instead.
    const entering = exportFrameTimes(t0, settled + 1, fps);
    const bounce = motion && entering.length >= 4;
    const peak = entering[clamp(Math.round(0.62 * (entering.length - 1)), 1, Math.max(1, entering.length - 2))] ?? settled;
    const track: Track = {
      x: [[t0, item.x + (motion ? roll : 0)]],
      y: [[t0, item.y + (motion ? lift : 0)]],
      rz: [[t0, item.rz + (motion ? -10 * side : 0)]],
      sx: [[t0, motion ? 0.92 : 1]],
      sy: [[t0, motion ? 0.92 : 1]],
    };
    const push = (key: "x" | "y" | "rz" | "sx" | "sy", ...frames: [number, number, ("outExpo" | "out" | "inOut" | "in")?][]) => {
      track[key] = [...track[key]!, ...frames];
    };
    if (motion) {
      push("x", [settled, item.x, "outExpo"]);
      push("y", [settled, item.y, "outExpo"]);
      push("rz", [settled, item.rz, "outExpo"]);
      if (bounce) {
        push("sx", [peak, 1.03, "out"], [settled, 1, "inOut"]);
        push("sy", [peak, 1.03, "out"], [settled, 1, "inOut"]);
      } else {
        push("sx", [settled, 1, "outExpo"]);
        push("sy", [settled, 1, "outExpo"]);
      }
    }
    if (exit) {
      push("x", [exitAt, item.x], [to, item.x + side * 60 * u, "in"]);
      push("y", [exitAt, item.y], [to, item.y + 10 * u, "in"]);
      push("rz", [exitAt, item.rz], [to, item.rz + 8 * side, "in"]);
      push("sx", [exitAt, 1], [to, 0.85, "in"]);
      push("sy", [exitAt, 1], [to, 0.85, "in"]);
    }

    const id = chunks[at]!.length > 1 ? `${ctx.id}:w${at}l${part}` : `${ctx.id}:w${at}`;
    const centre = (cell.inkTop + cell.inkBottom) / 2;
    const face: TextPiece = {
      ...ctx.face(cell, t0, pal.face, track),
      id,
      origin: { dx: 0, dy: centre },
      stroke: { widthPx: KEYLINE * u, colour: pal.s3 },
    };
    const bands = [pal.s3, pal.s2, pal.s1] as const;
    // The bands are plain fills with no keyline of their own; the two deeper ones keep a thin border that bridges the steps, the
    // thin rim beside the face does not (its steps are covered by the face's own keyline), which saves a bitmap per word per frame.
    const { stroke: _keyline, ...plain } = face;
    for (let k = 0; k < 3; k++) {
      const depth = DEPTH_EM[2 - k]! * size;
      const colour = bands[k]!;
      pieces.push({
        ...plain,
        id: `${id}d${3 - k}`,
        z: 3 + k,
        fill: colour,
        ...(k < 2 ? { stroke: { widthPx: BORD_EM * size, colour } } : {}),
        origin: { dx: -depth, dy: centre - depth },
      });
    }
    pieces.push(face);
  }

  // Dot clusters: whole dots appear on the beat of the word above them, flash in a wave out from the key word, and settle.
  const originStart = from(waveAt).from;
  const originItem = items.find((item) => item.word === waveAt) ?? items[0]!;
  const byWord = new Map<number, Column[]>();
  for (const column of columns) byWord.set(column.word, [...(byWord.get(column.word) ?? []), column]);
  for (const [at, list] of byWord) {
    const word = cue.words[at]!;
    const { from: t0 } = from(at);
    const spare = Math.max(0, exportFrameAtOrBefore(word.endMs - 1, fps) - t0);
    list
      .sort((a, b) => (a.cx - b.cx) * side)
      .forEach((column, order) => {
        const t = t0 + Math.min(order * 30, spare * 0.45);
        const pop = Math.min(110, Math.max(1, exitAt - t - 1));
        const shown = Math.min(t + 80, exitAt);
        const o: [number, number, ("out" | "inOut" | "in")?][] = [[t, 0], [shown, DOT_REST, "out"]];
        // The wave leaves the key word as it lands and fits into whatever time the cue has: a short cue gets a short, quick
        // pulse, a long hold repeats it every PULSE_EVERY while time remains. Every track ends before the exit begins.
        const end = exit ? exitAt : to;
        const room = end - (originStart + WAVE_LEAD);
        const spread = clamp((room - MIN_PULSE) / (280 + PULSE_MS), 0, 1);
        const delay = Math.min(280, Math.abs(column.cx - originItem.x) / (2.4 * u)) * spread;
        let last = shown;
        for (let burst = 0; ; burst++) {
          const start = Math.max(originStart + (burst === 0 ? WAVE_LEAD : 140 + burst * PULSE_EVERY) + delay, last + 1);
          const length = Math.min(PULSE_MS, end - start);
          if (length < MIN_PULSE) break;
          o.push([start, DOT_REST], [start + 0.35 * length, DOT_PEAK, "out"], [start + length, DOT_REST, "inOut"]);
          last = start + length;
        }
        if (exit) o.push([exitAt, DOT_REST], [to, 0, "in"]);
        const grow: Frames = [[t, 0.4], [t + pop, 1, "outBack"]];
        const path: PathCmd[] = column.dots.flatMap((dot) => ellipsePath(dot.x - column.cx, dot.y - column.cy, dot.r));
        const shape = ctx.shape(`dot${column.row}-${order}-${at}`, t, path, { x: [[t, column.cx]], y: [[t, column.cy]], sx: grow, sy: grow, o }, pal.dots);
        pieces.push({ ...shape, fill: { colour: pal.dots, alpha: DOT_FILL } } satisfies ShapePiece);
      });
  }

  // Beads: three solid dots of falling size flick out of the origin word's shoulder, in whichever free corner has room.
  const sizeBead = originItem.cell.size;
  const colours = [pal.face, pal.s1, pal.s2];
  const box = originItem.box;
  const w = box.x2 - box.x1;
  const h = box.y2 - box.y1;
  const inside = { x1: bounds.x1 + 4 * u, x2: bounds.x2 - 4 * u, y1: bounds.y1 + 4 * u, y2: bounds.y2 - 4 * u };
  const free = (around: Box) =>
    around.x1 >= inside.x1 && around.x2 <= inside.x2 && around.y1 >= inside.y1 && around.y2 <= inside.y2
    && items.every((item) => !meets(around, item.box, 3 * u))
    && columns.every((column) => column.dots.every((dot) => !meets(around, { x1: dot.x - dot.r, x2: dot.x + dot.r, y1: dot.y - dot.r, y2: dot.y + dot.r }, 0)));
  // The full chain first; a smaller one when the corner is tight.
  let placed = false;
  for (const shrink of [1, 0.7, 0.5]) {
    if (placed) break;
    const radii = [0.085, 0.058, 0.036].map((k) => k * sizeBead * shrink);
    const candidates = [
      { x: box.x2 + 0.07 * sizeBead, y: box.y1 + 0.32 * h, sx: side },
      { x: box.x1 - 0.07 * sizeBead, y: box.y1 + 0.32 * h, sx: -side },
      { x: box.x2 - 0.22 * w, y: box.y1 - 0.08 * sizeBead, sx: side },
      { x: box.x1 + 0.22 * w, y: box.y1 - 0.08 * sizeBead, sx: -side },
    ];
    for (const start of candidates) {
      let travel = radii[0]!;
      const len = Math.hypot(start.sx, -0.8);
      const spots = radii.map((r, k) => {
        if (k > 0) travel += radii[k - 1]! + r + 0.045 * sizeBead * shrink;
        return { x: start.x + (start.sx / len) * travel, y: start.y + (-0.8 / len) * travel, r };
      });
      const clear = spots.every((spot) => free({ x1: spot.x - spot.r - KEYLINE * u, x2: spot.x + spot.r + KEYLINE * u, y1: spot.y - spot.r - KEYLINE * u, y2: spot.y + spot.r + KEYLINE * u }));
      if (!clear) continue;
      spots.forEach((spot, k) => {
        const t = originStart + 70 + k * 45;
        const pop: Frames = [[t, 0.3], [t + 120, 1, "outBack"]];
        const o: Frames = exit ? [[t, 1], [exitAt, 1], [to, 0, "in"]] : [[t, 1]];
        const shape = ctx.shape(`bead${waveAt}-${k}`, t, ellipsePath(0, 0, spot.r), { x: [[t, spot.x]], y: [[t, spot.y]], sx: pop, sy: pop, o }, colours[k]!);
        pieces.push({ ...shape, z: 2, stroke: { widthPx: KEYLINE * u, colour: pal.s3 } } satisfies ShapePiece);
      });
      placed = true;
      break;
    }
  }
  return pieces;
}, undefined, 0);

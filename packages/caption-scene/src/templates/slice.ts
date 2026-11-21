import type { DemoScript } from "../demo";
import { type Ease, type Frames, EASES, clamp, prog } from "../ease";
import { sampleFrames } from "../frames";
import type { SceneCue, SceneInput, SceneProgram } from "../input";
import { balancedRows, clampToSafeArea, cueDirection, rowVisualOrder, rowsFromRoles, sceneSpace } from "../layout";
import type { Clip, PathCmd, Piece, ShapePiece, TextPiece } from "../scene";
import { pathBounds, roundedRectPath, starPath } from "../shapes";

/**
 * Slice (`samples/templates/m11-slice.js`): editorial neo-grotesk capitals stepped down a diagonal. Every word cuts in
 * through a horizontal slit that splits open from its middle while it slides toward the reading end; the hero word gets
 * an acid-lime "pixel staircase" plate that snakes in one rounded cell at a time, each letter turning from white to ink as
 * the snake passes under it. A cue with no hero ends on a slowly turning lime starburst sticker.
 *
 * Geometry is the sample's, read in Chrome (`.scratch/motion-captions/tools/probe-sample.ts`): Inter Tight ExtraBold 106 px
 * (-0.035 em), a word is two stacked copies (top and bottom half) in a 1.28 em box (0.14 em padding), lines 97 px apart
 * (150 px for a hero line), each 66 px further along; the plate is `ceil((word + 84) / 62)` cells of 62 px in two rows,
 * one step out at each end, centred on the word's cap middle; the starburst is a 12-point star (66 / 42 px) at the last
 * word's end.
 *
 * What changed from the sample, and why (gallery 2 brief):
 * - Rows come from the words (lead rows, a hero row, tail rows, wrapped evenly), not from the sample's baked " / " breaks.
 * - Every row, plate and star is fitted to the safe area (rows are re-wrapped narrower first, then the whole cue scales).
 * - A cue's decoration cycles by counter instead of looking identical: hero cues alternate the staircase's step (low
 *   entry / high exit, then its mirror), and every second pair of cues steps the diagonal the other way; no-hero cues
 *   cycle three starbursts (12, 9 and 14 points, other sizes, spin directions and spots) with a hashed start angle.
 * - Exits no longer end 80 ms before the cue: with real speech (about 60 ms between cues) they start only once the last
 *   word has landed and been read for 150 ms, then run as fast as the cue's end leaves room (every stagger and window
 *   scales together), ending 20 ms before the cue ends.
 * - The plate's snake compresses when a fast hero word could not land its last cell in time.
 * - A word in a script that needs shaping, or in RTL text, is never split into letters (its ink flip is per word) and has
 *   no letter spacing; a long hero (over 9 letters) flips per word too. Right-to-left cues mirror everything: lines step
 *   left, words slide in from the right, the snake runs right to left, the star sits at the left end.
 * - The hero's letters do not turn white again at the exit (the sample flips them back 123 ms into it, over a plate that
 *   is nearly gone); that second white copy would cost a third of the cue's piece budget.
 */

export const SLICE_DEMO: DemoScript = {
  lines: [
    "nobody:b is:m coming:b to:m save:b you:b",
    "build:b it:m yourself:h@560",
    "start:b ugly:h@520",
    "fix:b it:m in:m public:b",
    "just:m keep:b shipping:h@600",
  ],
  options: { rate: 300, cueGap: 160, tail: 700 },
};

const FACE = "Inter Tight ExtraBold" as const;
const SIZE = 106;
const LS = -0.035;
const PITCH = 97;
const STEP = 66;
const CELL = 62;
const HERO_LINE = CELL * 2 + 26;
const CENTER_Y = 1290;
const GAP_EM = 0.2;
const PAD_Y = 0.14;
const PAD_X = 0.06;
/** Chrome rounds Inter Tight's `line-height: 1` baseline to whole px: 91 of 106. */
const BASELINE_EM = 0.862;
const ROW_CAPS = [640, 520, 420, 340] as const;
const MIN_FIT = 0.82;

const SLIDE_IN = 38;
const SLIDE_OUT = 44;
const LEAD_MS = 80;
const ENTER_MS = 260;
const BOTTOM_LAG = 55;
const EXIT_MS = 180;
const STAGGER = 25;
const CELL_MS = 120;
const CELL_OUT = 110;
const CELL_OUT_STAGGER = 4;
const CELL_STAGGER = 19;
const PLATE_LEAD = 230;
const CELL_OVERLAP = 1;
const MIN_EXIT = 40;
/** A word is read this long once both halves are open before its line may begin to close. */
const HOLD_MS = 150;
/** Both halves of a word are 98 % open this long after its start (the bottom half's `outExpo` at 0.564 of 260 ms). */
const LAND_MS = 122;
/** The hero letter turns to ink when `ease.out(prog(t, at, 70))` passes a half: 14.44 ms after the cell under it landed. */
const FLIP_MS = 14.44;
const LETTER_LIMIT = 9;
const SHADOWS = [
  { dx: 0, dy: 5, blur: 13, colour: "#000000", alpha: 0.55 },
  { dx: 0, dy: 2, blur: 2.5, colour: "#000000", alpha: 0.5 },
] as const;

interface StarVariant {
  readonly points: number;
  readonly outer: number;
  readonly inner: number;
  readonly dx: number;
  readonly dy: number;
  /** Degrees per ms. */
  readonly rate: number;
  /** Room the layout keeps past the last row's end. */
  readonly reserve: number;
}
const STARS: readonly StarVariant[] = [
  { points: 12, outer: 66, inner: 42, dx: 30, dy: -30, rate: 0.03, reserve: 104 },
  { points: 9, outer: 58, inner: 36, dx: 22, dy: 26, rate: -0.04, reserve: 88 },
  { points: 14, outer: 72, inner: 48, dx: 40, dy: -46, rate: 0.022, reserve: 120 },
];

/** FNV-1a over the parts: a deterministic stand-in for randomness. */
export function sliceHash(...parts: readonly (string | number)[]): number {
  let hash = 2166136261;
  for (const char of parts.join("|")) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Latin, Cyrillic, Greek and symbols: scripts that take the tight letter spacing; others (Arabic, Indic, Hebrew, CJK) draw at 0. */
const TIGHT = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{N}\p{P}\p{S}\p{M}\s]+$/u;
const isTight = (text: string) => TIGHT.test(text);
/** A word may be drawn letter by letter only when each code point is a letter of its own (no marks, joiners or emoji). */
const isSplittable = (text: string) => isTight(text) && !/\p{M}|\u{200d}|\u{fe0f}|\p{Extended_Pictographic}/u.test(text);

/** A path drawn from its own top-left with its pivot (local (0, 0)) in `origin`: libass places a drawing by its box. */
function anchored(path: readonly PathCmd[]): { path: PathCmd[]; origin: { dx: number; dy: number } } {
  const box = pathBounds(path);
  const moved = path.map((cmd): PathCmd => {
    if (cmd[0] === "Z") return cmd;
    if (cmd[0] === "C") return ["C", cmd[1] - box.x1, cmd[2] - box.y1, cmd[3] - box.x1, cmd[4] - box.y1, cmd[5] - box.x1, cmd[6] - box.y1];
    return [cmd[0], cmd[1] - box.x1, cmd[2] - box.y1];
  });
  return { path: moved, origin: { dx: -box.x1, dy: -box.y1 } };
}

const sorted = (...times: number[]) => [...new Set(times)].sort((a, b) => a - b);

/** The sample's slide: `-38 px` before the word opens, `+44 px` as its line closes, toward the reading end (`sign`). */
export function sliceSlide(enterStart: number, closeStart: number, closeMs: number, k: number, sign: number): Frames {
  const enterEnd = enterStart + ENTER_MS;
  if (closeStart >= enterEnd) {
    return [[enterStart, -SLIDE_IN * k * sign], [enterEnd, 0, "outExpo"], [closeStart, 0], [closeStart + closeMs, SLIDE_OUT * k * sign, "in"]];
  }
  const at = (t: number) => sign * k * (-SLIDE_IN * (1 - EASES.outExpo(prog(t, enterStart, ENTER_MS))) + SLIDE_OUT * EASES.in(prog(t, closeStart, closeMs)));
  return sampleFrames(at, sorted(enterStart, enterEnd, closeStart, closeStart + closeMs), 0.2);
}

/** `closed + (open - closed) * a * (1 - o)`: a slit edge, opening with the word's `outExpo` and shutting with the line's `in`. */
export function sliceOpening(enterStart: number, closeStart: number, closeMs: number, closed: number, open: number): Frames {
  const enterEnd = enterStart + ENTER_MS;
  if (closeStart >= enterEnd) {
    return [[enterStart, closed], [enterEnd, open, "outExpo"], [closeStart, open], [closeStart + closeMs, closed, "in"]];
  }
  const at = (t: number) => closed + (open - closed) * EASES.outExpo(prog(t, enterStart, ENTER_MS)) * (1 - EASES.in(prog(t, closeStart, closeMs)));
  return sampleFrames(at, sorted(enterStart, enterEnd, closeStart, closeStart + closeMs), 0.2);
}

/** The sample's `outBack(p, 2.2)` clamped to 1.2 times the exit's `in`: one cell's scale. */
export function sliceCellScale(t: number, begin: number, closeStart: number, closeMs: number): number {
  const back = (p: number) => 1 + 3.2 * (p - 1) ** 3 + 2.2 * (p - 1) ** 2;
  return clamp(back(prog(t, begin, CELL_MS)) * (1 - EASES.in(prog(t, closeStart, closeMs))), 0, 1.2);
}

/** Cells of the plate in the order the snake lays them: `[column, row]`, columns counted along the reading direction. */
export function slicePlateSpots(columns: number, mirrored: boolean): [number, number][] {
  const spots: [number, number][] = mirrored ? [[-1, -1], [-1, 0]] : [[-1, 2], [-1, 1]];
  for (let c = 0; c < columns; c++) {
    const down = mirrored ? c % 2 === 1 : c % 2 === 0;
    if (down) spots.push([c, 1], [c, 0]);
    else spots.push([c, 0], [c, 1]);
  }
  if (mirrored) spots.push([columns, 1], [columns, 2]);
  else spots.push([columns, 0], [columns, -1]);
  return spots;
}

interface Row {
  readonly words: readonly number[];
  readonly hero: boolean;
}

interface PlacedWord {
  readonly index: number;
  readonly left: number;
  readonly width: number;
  readonly ls: number;
}

interface PlacedRow {
  readonly row: Row;
  readonly left: number;
  readonly width: number;
  readonly boxTop: number;
  readonly lineTop: number;
  readonly lineHeight: number;
  readonly overhang: number;
  readonly columns: number;
  readonly words: readonly PlacedWord[];
}

interface Layout {
  readonly k: number;
  readonly size: number;
  readonly rows: readonly PlacedRow[];
  readonly total: number;
  readonly textMin: number;
  readonly textMax: number;
  readonly decoMin: number;
  readonly decoMax: number;
}

function buildCue(cue: SceneCue, cueNumber: number, input: SceneInput, heroCount: number, plainCount: number): Piece[] {
  const space = sceneSpace(input, CENTER_Y);
  const { u } = space;
  const rtl = cueDirection(cue) === "rtl";
  const sign = rtl ? -1 : 1;
  const texts = cue.words.map((word) => word.text.toUpperCase());
  const roles = cue.words.map((word) => word.role);
  const split = rowsFromRoles(roles);
  const hasHero = split.hero.length > 0;
  const counter = hasHero ? heroCount : plainCount;
  const stairMirrored = hasHero && heroCount % 2 === 1;
  const diagMirrored = Math.floor(counter / 2) % 2 === 1 && cueNumber > 0;
  const star = hasHero ? null : STARS[plainCount % STARS.length]!;
  const fromLeft = rtl === diagMirrored;
  const band = cueNumber * 8;
  const measure = (text: string, size: number, ls: number) => input.measure(text, FACE, size, ls);
  const lsOf = (index: number) => (isTight(texts[index]!) ? LS : 0);

  // --- rows: lead rows, the hero row, tail rows; wrapped evenly at the narrowest cap that keeps the cue large ---
  const natural = texts.map((text, index) => measure(text, SIZE * u, lsOf(index)).advance + lsOf(index) * SIZE * u);
  const rowsFor = (cap: number): Row[] => {
    const wrap = (indices: readonly number[]): Row[] =>
      balancedRows(indices.map((at) => natural[at]!), GAP_EM * SIZE * u, cap * u).map((row) => ({ words: row.map((at) => indices[at]!), hero: false }));
    return [...wrap(split.lead), ...(hasHero ? [{ words: split.hero, hero: true }] : []), ...wrap(split.tail)];
  };

  const place = (rows: readonly Row[], f: number): Layout => {
    const k = u * f;
    const size = SIZE * k;
    const gap = GAP_EM * size;
    const widthOf = texts.map((text, index) => measure(text, size, lsOf(index)).advance + lsOf(index) * size);
    const measured = rows.map((row) => {
      const width = row.words.reduce((sum, at) => sum + widthOf[at]!, 0) + gap * (row.words.length - 1);
      const columns = row.hero ? Math.ceil((width + 84 * k) / (CELL * k)) : 0;
      const overhang = row.hero ? CELL * k + (columns * CELL * k - width) / 2 : 0;
      return { row, width, columns, overhang, lineHeight: (row.hero ? HERO_LINE : PITCH) * k };
    });
    const starRoom = star ? star.reserve * k : 0;
    const blockW = Math.max(...measured.map((m, i) => m.width + i * STEP * k + m.overhang * 2 - 24 * k + (star && i === measured.length - 1 ? starRoom : 0)));
    const pad = Math.round((1080 * u - blockW) / 2);
    const leftEdge = space.x(0) + pad;
    const rightEdge = space.x(1080) - pad;
    const total = measured.reduce((sum, m) => sum + m.lineHeight, 0);
    const boxH = (1 + 2 * PAD_Y) * size;
    let y = space.y(CENTER_Y) - total / 2;
    let textMin = Number.POSITIVE_INFINITY;
    let textMax = Number.NEGATIVE_INFINITY;
    let decoMin = Number.POSITIVE_INFINITY;
    let decoMax = Number.NEGATIVE_INFINITY;
    const placed = measured.map((m, i): PlacedRow => {
      const shift = i * STEP * k + (m.row.hero ? m.overhang - 24 * k : 0);
      const left = fromLeft ? leftEdge + shift : rightEdge - shift - m.width;
      const order = rowVisualOrder(m.row.words.map((at) => texts[at]!), rtl ? "rtl" : "ltr").map((at) => m.row.words[at]!);
      let x = left;
      const words = order.map((index): PlacedWord => {
        const word = { index, left: x, width: widthOf[index]!, ls: lsOf(index) };
        x += widthOf[index]! + gap;
        return word;
      });
      const lineTop = y;
      y += m.lineHeight;
      textMin = Math.min(textMin, left);
      textMax = Math.max(textMax, left + m.width);
      decoMin = Math.min(decoMin, left - m.overhang);
      decoMax = Math.max(decoMax, left + m.width + m.overhang);
      return { row: m.row, left, width: m.width, boxTop: lineTop + (m.lineHeight - boxH) / 2, lineTop, lineHeight: m.lineHeight, overhang: m.overhang, columns: m.columns, words };
    });
    if (star) {
      const last = placed[placed.length - 1]!;
      const cx = rtl ? last.left - star.dx * k : last.left + last.width + star.dx * k;
      decoMin = Math.min(decoMin, cx - star.outer * k);
      decoMax = Math.max(decoMax, cx + star.outer * k);
    }
    return { k, size, rows: placed, total, textMin, textMax, decoMin, decoMax };
  };

  const fits = (rows: readonly Row[], f: number) => {
    const p = place(rows, f);
    const left = (rtl ? SLIDE_OUT : SLIDE_IN) * p.k;
    const right = (rtl ? SLIDE_IN : SLIDE_OUT) * p.k;
    return p.textMin - left >= space.safe.x1 && p.textMax + right <= space.safe.x2 && p.decoMin >= space.safe.x1 && p.decoMax <= space.safe.x2 && p.total + 130 * p.k <= space.safe.y2 - space.safe.y1;
  };
  const fitOf = (rows: readonly Row[]) => {
    if (fits(rows, 1)) return 1;
    let lo = 0.1;
    let hi = 1;
    for (let step = 0; step < 14; step++) {
      const mid = (lo + hi) / 2;
      if (fits(rows, mid)) lo = mid;
      else hi = mid;
    }
    return lo;
  };
  let chosen: { rows: Row[]; f: number } | null = null;
  const seen = new Set<string>();
  for (const cap of ROW_CAPS) {
    const rows = rowsFor(cap);
    const key = rows.map((row) => row.words.join(",")).join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    const f = fitOf(rows);
    if (!chosen || f > chosen.f) chosen = { rows, f };
    if (f >= MIN_FIT) {
      chosen = { rows, f };
      break;
    }
  }
  const layout = place(chosen!.rows, chosen!.f);
  const { k, size } = layout;
  const heroRow = layout.rows.find((row) => row.row.hero) ?? null;

  // --- timing: the exit waits for the last word to land and be read, then runs as fast as the cue's end allows ---
  const lastStart = Math.max(...cue.words.map((word) => word.startMs));
  const lineCount = layout.rows.length;
  const heroWord = hasHero ? cue.words[split.hero[0]!]! : null;
  const heroLast = hasHero ? cue.words[split.hero[split.hero.length - 1]!]! : null;
  const spots = heroRow ? slicePlateSpots(heroRow.columns, stairMirrored) : [];
  const beginAt = heroWord ? heroWord.startMs - PLATE_LEAD : 0;
  // The snake lays one cell every 19 ms, faster only when a short hero word would otherwise end before its last cell.
  const stagger = heroLast && spots.length > 0 ? Math.min(CELL_STAGGER, Math.max(6, (heroLast.endMs + 100 - beginAt - CELL_MS) / spots.length)) : CELL_STAGGER;
  const lastCellLands = spots.length > 0 ? beginAt + (spots.length - 1) * stagger + CELL_MS : 0;
  const exitEnd = cue.endMs - 20;
  const earliest = Math.max(lastStart + LAND_MS + HOLD_MS, spots.length > 0 ? lastCellLands + 100 : 0);
  const exitBase = Math.min(Math.max(cue.endMs - 280, earliest), exitEnd - MIN_EXIT);
  const rowStagger = lineCount > 1 ? Math.min(STAGGER, 100 / (lineCount - 1)) : 0;
  const nominal = Math.max(EXIT_MS, spots.length > 0 ? CELL_OUT + (spots.length - 1) * CELL_OUT_STAGGER : 0);
  const g = clamp((exitEnd - exitBase) / nominal, 0.05, 1);
  const closeOf = (line: number) => ({ start: exitBase + (lineCount - 1 - line) * rowStagger * g, ms: (EXIT_MS - rowStagger * (lineCount - 1)) * g });
  const pieces: Piece[] = [];

  // --- the hero's plate: cells in the snake's order, each popping with the sample's `outBack(p, 2.2)` ---
  interface Landed {
    readonly cx: number;
    readonly at: number;
  }
  const landed: Landed[] = [];
  if (heroRow && heroWord) {
    const hero = heroRow;
    const cell = CELL * k;
    const spanLeft = hero.left;
    const spanRight = hero.left + hero.width;
    const plateLeft = spanLeft + (hero.width - hero.columns * cell) / 2;
    const plateRight = spanRight - (hero.width - hero.columns * cell) / 2;
    const capMid = hero.boxTop + ((1 + 2 * PAD_Y) * size) / 2 + SIZE * 0.01 * k;
    const plateTop = capMid - cell;
    const has = new Set(spots.map(([c, r]) => `${c},${r}`));
    const radius = CELL * 0.34 * k;
    const corner = (a: string, b: string) => (has.has(a) || has.has(b) ? 0 : radius);
    const side = cell + 2 * CELL_OVERLAP * u;
    spots.forEach(([c, r], at) => {
      const x = rtl ? plateRight - (c + 1) * cell : plateLeft + c * cell;
      const left = x - CELL_OVERLAP * u;
      const top = plateTop + r * cell - CELL_OVERLAP * u;
      // Neighbours are named in the reading direction: "before" is toward the entry end.
      const before = `${c - 1},${r}`;
      const after = `${c + 1},${r}`;
      const up = `${c},${r - 1}`;
      const down = `${c},${r + 1}`;
      const [l, rr] = rtl ? [after, before] : [before, after];
      const radii = [corner(l, up), corner(rr, up), corner(rr, down), corner(l, down)] as const;
      const begin = beginAt + at * stagger;
      const closeStart = exitBase + (spots.length - 1 - at) * CELL_OUT_STAGGER * g;
      const closeMs = CELL_OUT * g;
      const from = begin + 2;
      const to = closeStart + closeMs;
      landed.push({ cx: x + cell / 2, at: begin + 50 });
      if (to <= from) return;
      const edges = sorted(begin, begin + CELL_MS, closeStart, closeStart + closeMs, begin + CELL_MS * 0.54).filter((t) => t >= from);
      const scale = sampleFrames((t) => sliceCellScale(t, begin, closeStart, closeMs), [from, ...edges.filter((t) => t > from)], 0.012);
      pieces.push({
        id: `slice:${cueNumber}:c${at}`,
        kind: "shape",
        z: band + 1,
        fromMs: from,
        toMs: to,
        track: { x: [[from, left + side / 2]], y: [[from, top + side / 2]], sx: scale, sy: scale },
        origin: { dx: side / 2, dy: side / 2 },
        path: roundedRectPath(0, 0, side, side, radii),
        fill: { colour: input.colours.highlight },
      });
    });
  }

  // --- the words: two clipped halves each; hero letters flip to ink as the snake passes under them ---
  const baseline = (row: PlacedRow) => row.boxTop + PAD_Y * size + Math.round(BASELINE_EM * SIZE * (k / u)) * u;
  const boxH = (1 + 2 * PAD_Y) * size;
  layout.rows.forEach((row, line) => {
    const close = closeOf(line);
    const y = baseline(row);
    for (const word of row.words) {
      const text = texts[word.index]!;
      const spoken = cue.words[word.index]!;
      const isHero = row.row.hero;
      const nodeLeft = word.left - PAD_X * size;
      const nodeWidth = word.width + 2 * PAD_X * size;
      const x1 = nodeLeft - 0.1 * nodeWidth;
      const x2 = nodeLeft + 1.1 * nodeWidth;
      const mid = row.boxTop + boxH / 2;
      const bottom = row.boxTop + boxH;
      // Units drawn: letters of a hero in a simple script, otherwise the whole word.
      const letters = isHero && !rtl && isSplittable(text) && [...text].length <= LETTER_LIMIT ? [...text] : null;
      const units: { text: string; left: number; width: number }[] = [];
      if (letters) {
        let x = word.left;
        for (const letter of letters) {
          const width = measure(letter, size, word.ls).advance + word.ls * size;
          units.push({ text: letter, left: x, width });
          x += width;
        }
      } else {
        units.push({ text, left: word.left, width: word.width });
      }
      const flipOf = (left: number, width: number): number | null => {
        if (!isHero || landed.length === 0) return null;
        const under = landed.filter((cell) => cell.cx >= left - CELL * k * 0.5 && cell.cx <= left + width + CELL * k * 0.5);
        const centre = left + width / 2;
        const near = landed.filter((cell) => Math.abs(cell.cx - centre) <= (CELL * k) / 2 + 0.01);
        const pool = letters ? (near.length > 0 ? near : [landed.reduce((a, b) => (Math.abs(b.cx - centre) < Math.abs(a.cx - centre) ? b : a))]) : under;
        if (pool.length === 0) return null;
        // A letter turns when the first cell under it lands; a whole word, when the snake has covered it.
        const byColumn = new Map<number, number>();
        for (const cell of pool) byColumn.set(Math.round(cell.cx), Math.min(byColumn.get(Math.round(cell.cx)) ?? Number.POSITIVE_INFINITY, cell.at));
        const times = [...byColumn.values()];
        return (letters ? Math.min(...times) : Math.max(...times)) + FLIP_MS;
      };
      for (const half of ["t", "b"] as const) {
        const enterStart = spoken.startMs - LEAD_MS + (half === "b" ? BOTTOM_LAG : 0);
        const from = enterStart + 1;
        const to = close.start + close.ms;
        if (to <= from) continue;
        const slide = sliceSlide(enterStart, close.start, close.ms, k, sign);
        const shifted = (offset: number): Frames => slide.map(([at, value, name]) => (name ? [at, value + offset, name] : [at, value + offset])) as unknown as Frames;
        const opening = (closed: number, open: number) => sliceOpening(enterStart, close.start, close.ms, closed, open);
        const clip: Clip =
          half === "t"
            ? { x1: shifted(x1), x2: shifted(x2), y1: opening(mid, row.boxTop), y2: [[from, mid]] }
            : { x1: shifted(x1), x2: shifted(x2), y1: [[from, mid]], y2: opening(mid, bottom) };
        units.forEach((unit, at) => {
          const flip = flipOf(unit.left, unit.width);
          const make = (variant: "w" | "i", fromMs: number, toMs: number): TextPiece => ({
            id: `slice:${cueNumber}:w${word.index}${letters ? `l${at}` : ""}${half}${variant}`,
            kind: "text",
            z: band + (half === "t" ? 3 : 4),
            fromMs,
            toMs,
            track: { x: shifted(unit.left), y: [[fromMs, y]] },
            clip,
            text: unit.text,
            face: FACE,
            sizePx: size,
            letterSpacingEm: word.ls,
            fill: variant === "w" ? input.colours.primary : input.colours.accent,
            ...(variant === "w" ? { shadows: SHADOWS } : {}),
            anchor: "baseline-left",
            language: cue.language,
          });
          const whiteEnd = flip === null ? to : Math.min(to, flip);
          if (whiteEnd > from) pieces.push(make("w", from, whiteEnd));
          if (flip !== null && to > Math.max(from, flip)) pieces.push(make("i", Math.max(from, flip), to));
        });
      }
    }
  });

  // --- a cue without a hero ends on a slowly turning starburst, springing in with its last word ---
  if (star) {
    const last = layout.rows[layout.rows.length - 1]!;
    const lastWord = cue.words.reduce((a, b) => (b.startMs > a.startMs ? b : a));
    const cx = rtl ? last.left - star.dx * k : last.left + last.width + star.dx * k;
    const cy = last.lineTop + last.lineHeight / 2 + star.dy * k;
    const shape = anchored(starPath(star.points, star.outer * k, star.inner * k));
    const begin = lastWord.startMs - 40;
    const from = begin + 4;
    const to = exitBase + EXIT_MS * g;
    const jitter = ((sliceHash(cue.index, cue.words[0]!.text) % 1000) / 1000 - 0.5) * (360 / star.points);
    const spring = (t: number) => EASES.spring(prog(t, begin, 520));
    const out = (t: number) => EASES.in(prog(t, exitBase, EXIT_MS * g));
    const edges = sorted(from, begin + 520, exitBase, to).filter((t) => t >= from && t <= to);
    if (to > from) {
      const scale = sampleFrames((t) => spring(t) * (1 - out(t)), edges, 0.012);
      const turn = sampleFrames((t) => jitter + (t - lastWord.startMs) * star.rate - 40 * (1 - spring(t)), edges, 0.3);
      pieces.push({
        id: `slice:${cueNumber}:star`,
        kind: "shape",
        z: band,
        fromMs: from,
        toMs: to,
        track: { x: [[from, cx]], y: [[from, cy]], sx: scale, sy: scale, rz: turn },
        origin: shape.origin,
        path: shape.path,
        fill: { colour: input.colours.highlight },
      });
    }
  }
  return clampToSafeArea(pieces, space.safe, input.measure);
}

export const sliceProgram: SceneProgram = {
  build(input) {
    let heroes = 0;
    let plain = 0;
    const pieces: Piece[] = [];
    input.cues.forEach((cue, number) => {
      if (cue.words.length === 0) return;
      const hasHero = cue.words.some((word) => word.role === "hero");
      pieces.push(...buildCue(cue, number, input, heroes, plain));
      if (hasHero) heroes++;
      else plain++;
    });
    return { pieces };
  },
};

export type { Ease, ShapePiece };

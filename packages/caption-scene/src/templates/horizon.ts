import { CAPTION_SCENE_BRAND_MIN_CONTRAST, captionColourContrast, captionSceneMeta } from "@narriflow/validators";
import type { DemoScript } from "../demo";
import { clamp, type Ease, type Frames } from "../ease";
import { exportFrameAfter, exportFrameAtOrAfter, exportFrameAtOrBefore, exportFrameTimes, paintedFrameCount } from "../frame-grid";
import { sampleFrames } from "../frames";
import { rowVisualOrder } from "../layout";
import { type Clip, mixColour, type PathCmd, type Piece, type Shadow, type TextPiece, type Track } from "../scene";
import { polygonPath } from "../shapes";
import { caps, galleryScene } from "./gallery-layout";
import type { SpeechCell } from "./speech-layout";

/**
 * Horizon (`samples/templates/m74-synthwave.js`, after Motion Array "Retro Style Title Logo"): an 80s synthwave logo badge that
 * powers on like a CRT. A bright line flashes across, the dark trapezoid badge opens out of it with a double neon outline and a
 * skyline of bars along its base. The key word is heavy italic Racing Sans One caps in six hard bands of sunset chrome with a pale
 * neon edge, a stepped extrusion and a cyan/pink split that converges as it lands. The words before it sit above in tracked
 * Orbitron, the words after it below; a cue with no key word is pale italic caps with a cyan and pink fringe.
 *
 * Changes from the sample, and why (Sol's gallery 6 review, 2026-11-25, plus the owner's "fix the demos"):
 * - **Text is above every CRT effect.** The sample's badge opened with a clip that also cut the words (a hero-first word lost its
 *   opening, the labels were clipped as the badge closed), its power-on flicker dimmed and jittered the whole group (START and its
 *   frame dipped together) and a 95 % white flash washed out the chrome. Now the badge, rim, bars, scanlines and sweeps are
 *   separate pieces behind the words and carry the aperture clip; the words are never clipped by it. The flicker is gone: the
 *   power-on is the line (8 px, about 40 ms), the plate opening in 90 ms with a cubic-out, and a rim flash of 20 % white for two
 *   frames. Nothing moves sideways.
 * - **Every glyph paints on the word's spoken start.** The sample's words started 50 ms early and wiped in over 200 to 230 ms (a
 *   70 ms word was never whole, and a wipe hides glyphs on its first frame). Every word is whole and opaque on the first export
 *   frame at or after its onset: it slides in 0.09 em from the reading side (cubic-out, planned on the export frame grid in at most
 *   90 ms, hero 110 ms) and a word with a single painted frame is simply there. The glitch opacity dips are gone.
 * - **A darker field round the chrome.** The sample's fill washed FUTURE's chrome out at 450 ms. The six hard bands are cut from
 *   the measured cap height of each row (the sample cut the line box): the word's own piece is the pale neon edge with a two-step
 *   dark extrusion (the sample's seven copies), under six clipped colour copies; the badge plate is held at 90 % ink.
 * - **Cost.** libass blends every event's whole bounding box each frame, so the three outlines (rim glow, pale rim, inner line) are
 *   four edge segments each instead of 880 x 500 rings, the glows use a small blur, and the face is not drawn twice: 1.4x Headline on
 *   the full export (the first port was 2.0x).
 * - **The cyan/pink split sits under the face.** In the sample the split copies lay over the word at 85 % for 380 ms. They are
 *   now under the chrome: they peek out at the sides, converge in 140 ms and fade, and the face is readable from its onset.
 * - **The badge never closes on a word.** The sample began closing 270 ms before the cue's end, through the label rows, and
 *   the word the speaker was still on. The cue's reading hold (150 ms after the last spoken word) comes first, then the plate
 *   collapses to the line in the last 66 ms (or whatever two painted frames allow) while the words fade; if two frames do not
 *   fit, the cue ends in a hard cut. Fast speech keeps one badge: a cue that opens with no time before its first word shows
 *   the plate at once (a rim flash and the split mark the change) instead of blinking it shut and open again.
 * - **Rows fit the trapezoid.** The sample fitted each lane to a fixed 640/690 px. Each row is fitted to the badge's actual width
 *   at its own height (less the outline and glow), support words wrap at word boundaries before a label shrinks, a long key word
 *   is broken into the fewest balanced rows before it drops below 120 px (UNBELIEVABLE is UNBELIE / VABLE, never a stray letter),
 *   and the stack is fitted to the plate above the skyline strip. In 16:9 and 1:1 the badge is capped at a third of the frame's
 *   height. Hindi and the other shaped scripts are whole words with no tracking.
 * - **No cue-indexed tables.** The sample's themes were `themeOf[ci]`; the three palettes now cycle by a per-cue counter (hero
 *   cues and plain cues each have their own) and the skyline's heights come from a hash of the cue's index.
 * - Colours: the plain words are the preset's primary, the neon family (glow, bars, rim and the label below the key word)
 *   follows the highlight when it is customised, the accent is the cyan; each colour is checked against the navy plate it is
 *   drawn on and falls back to the style default when it fails 3:1 (the catalogue row's `readsOn` keeps brand colours off the
 *   same pair).
 * - Extra recurring beats, in the style's own language, on every cue: a thin scan bar sweeps down the plate when it has opened (and
 *   again every 1.8 s of a long hold); the skyline breathes as a travelling wave of three bar groups; a neon rule draws out from
 *   the middle under the words when there is room; the sparkles twinkle all hold.
 */

export const HORIZON_DEMO: DemoScript = {
  lines: [
    "future:h@1100 is:m loading:b",
    "no:b brakes:b no:b limits:b no:b regrets",
    "neon:h@1000 nights:b",
    "press:b start:h@1000",
    "game:b on:m",
  ],
  options: { rate: 245, gap: 30, cueGap: 170, tail: 800, lead: 350 },
};

const HERO_FACE = "Racing Sans One" as const;
const LABEL_FACE = "Orbitron Black" as const;
type FaceName = typeof HERO_FACE | typeof LABEL_FACE;

/** The badge, design px from its centre (the sample's svg is 960 x 560 about 480, 280). */
const HALF_TOP = 440;
const HALF_BOTTOM = 300;
const HALF_H = 250;
const INNER_INSET_TOP = 25;
const INNER_INSET_BOTTOM = 13;
const INNER_INSET_Y = 20;
const OUTER: readonly (readonly [number, number])[] = [[-HALF_TOP, -HALF_H], [HALF_TOP, -HALF_H], [HALF_BOTTOM, HALF_H], [-HALF_BOTTOM, HALF_H]];
const INNER: readonly (readonly [number, number])[] = [
  [-(HALF_TOP - INNER_INSET_TOP), -(HALF_H - INNER_INSET_Y)], [HALF_TOP - INNER_INSET_TOP, -(HALF_H - INNER_INSET_Y)],
  [HALF_BOTTOM - INNER_INSET_BOTTOM, HALF_H - INNER_INSET_Y], [-(HALF_BOTTOM - INNER_INSET_BOTTOM), HALF_H - INNER_INSET_Y],
];
/** The text zone: between the top outline and the skyline strip. */
const CONTENT_TOP = -216;
const CONTENT_BOTTOM = 170;
const CONTENT_H = CONTENT_BOTTOM - CONTENT_TOP;
/** Air between a row and the inner outline (outline, edge and glow included), per side. */
const SIDE_MARGIN = 44;
const widthAt = (y: number) => 2 * HALF_TOP - (HALF_TOP - HALF_BOTTOM) * ((y + HALF_H) / HALF_H);
const usable = (y: number) => widthAt(y) - 2 * SIDE_MARGIN;

const HERO = 236;
const HERO_MIN = 120;
const LABEL = 46;
const PLAIN = 178;
const PLAIN_MIN = 96;
const MINOR = 0.86;
const BADGE_SHARE = 0.33;

const INK = "#13072E";
const DEEP = "#2B0F63";
const THEMES = [
  { bands: ["#F1FBFF", "#82D5FF", "#4A8CFF", "#1B1263", "#FF5BD3", "#FF9A52"], edge: "#A5F5FF", glow: "#FF3FD0", top: "#7DF3FF", bot: "#FF86E4", bars: "#FF4FD8" },
  { bands: ["#FFF5B5", "#FFD23C", "#FF8A22", "#3A0E3C", "#FF3B5E", "#B5176E"], edge: "#FFC46B", glow: "#FF4A1F", top: "#FFE18C", bot: "#FF8F66", bars: "#FF6B2C" },
  { bands: ["#FFFFFF", "#CBA8FF", "#8B5CFF", "#1C0C50", "#FF5CCF", "#FF92DA"], edge: "#D8BCFF", glow: "#7B3CFF", top: "#7DF3FF", bot: "#FF8AE0", bars: "#9B6BFF" },
] as const;
/** Hero cues walk the palettes in this order, plain cues in the other (the sample's demo shows palettes 0, 1 on its hero cues and 2, 1 on its plain ones). */
const THEME_ORDER = { hero: [0, 1, 2], plain: [2, 1, 0] } as const;
/** Where each hard band of the chrome ends, as a share of the cap height (the sample's 33 / 44 / 55 / 58 / 74 % of the line box, on the caps). */
const BAND_CUTS = [0.3, 0.42, 0.54, 0.585, 0.78] as const;

const SPLITTABLE = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{N}\p{P}]+$/u;

const SLIDE_LABEL = 90;
const SLIDE_PLAIN = 100;
const SLIDE_HERO = 110;
const OPEN_MS = 90;
const COLLAPSE_MS = 66;

/** The sample's four-point sparkle (`M0,-9.5 C0.5,-2 ...` in a 20 px box), radius `r`. */
export function horizonSparklePath(r: number): PathCmd[] {
  const k = r / 9.5;
  return [
    ["M", 0, -9.5 * k], ["C", 0.5 * k, -2 * k, 2 * k, -0.5 * k, 9.5 * k, 0], ["C", 2 * k, 0.5 * k, 0.5 * k, 2 * k, 0, 9.5 * k],
    ["C", -0.5 * k, 2 * k, -2 * k, 0.5 * k, -9.5 * k, 0], ["C", -2 * k, -0.5 * k, -0.5 * k, -2 * k, 0, -9.5 * k], ["Z"],
  ];
}

const rectPath = (x1: number, y1: number, x2: number, y2: number): PathCmd[] => [["M", x1, y1], ["L", x2, y1], ["L", x2, y2], ["L", x1, y2], ["Z"]];
const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

type Kind = "hero" | "label" | "plain";
interface Run {
  readonly word: number;
  readonly part: number;
  readonly parts: number;
  readonly text: string;
  readonly scale: number;
  readonly face: FaceName;
  readonly spacing: number;
  /** Per unit of font size: advance, ink top (negative) and ink bottom. */
  readonly adv: number;
  readonly top: number;
  readonly bot: number;
}
interface Row {
  readonly kind: Kind;
  readonly runs: readonly Run[];
  readonly nominal: number;
  readonly gapEm: number;
  readonly tone: "lead" | "tail" | "";
}
interface Group {
  readonly words: readonly number[];
  /** The pieces of one word that is too wide for a row at a readable size. */
  readonly chunks: readonly string[] | null;
}

export const horizonProgram = galleryScene("horizon", 1290, (ctx) => {
  const { cue, index, to, bounds, from: cueFrom } = ctx.window;
  const { exit, exitAt, fps, side, input, space } = ctx;
  const pieces: Piece[] = [];
  const direction = ctx.rtl ? "rtl" : "ltr";

  // Colours: each is checked against the navy plate it is drawn on and falls back to the style default.
  const defaults = captionSceneMeta("horizon").colours;
  const keep = (colour: string, fallback: string) => (captionColourContrast(colour, INK) >= CAPTION_SCENE_BRAND_MIN_CONTRAST ? colour : fallback);
  const pale = keep(input.colours.primary, defaults.primary);
  const neon = keep(input.colours.highlight, defaults.highlight);
  const cyan = keep(input.colours.accent, defaults.accent);

  const roles = cue.words.map((word) => word.role);
  const first = roles.indexOf("hero");
  let last = first;
  while (first >= 0 && roles[last + 1] === "hero") last++;
  const heroed = first >= 0;
  const lead = heroed ? cue.words.slice(0, first).map((_, at) => at) : [];
  const heroList = heroed ? cue.words.slice(first, last + 1).map((_, at) => first + at) : [];
  const tail = heroed ? cue.words.slice(last + 1).map((_, at) => last + 1 + at) : [];
  const plainList = heroed ? [] : cue.words.map((_, at) => at);
  const texts = cue.words.map((word) => caps(word, cue));

  // Counters: hero cues and plain cues cycle their own palette.
  const earlier = input.cues.slice(0, index).filter((other) => other.words.length > 0);
  const count = earlier.filter((other) => other.words.some((word) => word.role === "hero") === heroed).length;
  const order = heroed ? THEME_ORDER.hero : THEME_ORDER.plain;
  const base = THEMES[order[count % order.length]!]!;
  const custom = neon !== defaults.highlight;
  const th = {
    ...base,
    top: base.top === "#7DF3FF" ? cyan : base.top,
    ...(custom ? { glow: neon, bars: neon, bot: mixColour(neon, "#FFFFFF", 0.35), edge: mixColour(neon, "#FFFFFF", 0.6) } : {}),
  };

  // The badge: the sample's, at its natural size, capped at a third of a landscape or square frame's height.
  const u = space.u;
  const natural = u / input.scale;
  const landscape = input.canvas.width >= input.canvas.height;
  const k = landscape ? Math.min(1, (BADGE_SHARE * input.canvas.height) / (2 * HALF_H * natural)) : 1;
  const b = u * k;
  const cx = space.x(540);
  const cy = space.y(1290);

  // Measurement: everything per unit of font size, so a size is arithmetic.
  const memo = new Map<string, { adv: number; top: number; bot: number }>();
  const unitMetrics = (text: string, face: FaceName, spacing: number) => {
    const key = `${face}|${spacing}|${text}`;
    const known = memo.get(key);
    if (known) return known;
    const m = input.measure(text, face, 100 * b, spacing);
    const made = { adv: m.advance / (100 * b), top: m.inkTop / (100 * b), bot: m.inkBottom / (100 * b) };
    memo.set(key, made);
    return made;
  };
  const runOf = (word: number, part: number, parts: number, text: string, kind: Kind): Run => {
    const face: FaceName = kind === "label" ? LABEL_FACE : HERO_FACE;
    const plainScript = SPLITTABLE.test(text);
    const spacing = !plainScript ? 0 : kind === "label" ? 0.16 : kind === "hero" ? 0.015 : 0.02;
    // Devanagari and the other fallback faces draw smaller at the same em than Orbitron and Racing Sans One.
    const boost = plainScript ? 1 : kind === "label" ? 1.3 : kind === "plain" ? 1.2 : 1;
    const scale = (kind === "plain" && cue.words[word]!.role === "minor" ? MINOR : 1) * boost;
    return { word, part, parts, text, scale, face, spacing, ...unitMetrics(text, face, spacing) };
  };
  const nominalOf = (kind: Kind) => (kind === "hero" ? HERO : kind === "label" ? LABEL : PLAIN);
  const gapEmOf = (kind: Kind) => (kind === "label" ? 0.62 : kind === "hero" ? 0.28 : 0.26);

  /** The fewest balanced pieces of a long word, cut where the measured widths come out even. */
  const chunkText = (text: string, kind: Kind, rows: number): string[] => {
    const letters = [...text];
    const n = letters.length;
    const face: FaceName = kind === "label" ? LABEL_FACE : HERO_FACE;
    const spacing = kind === "hero" ? 0.015 : 0.02;
    const width = (a: number, z: number) => unitMetrics(letters.slice(a, z).join(""), face, spacing).adv;
    const best: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(n + 1).fill(Number.POSITIVE_INFINITY));
    const cut: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(n + 1).fill(0));
    best[0]![0] = 0;
    for (let r = 1; r <= rows; r++) {
      for (let i = r; i <= n; i++) {
        for (let j = r - 1; j < i; j++) {
          const cost = Math.max(best[r - 1]![j]!, width(j, i));
          if (cost < best[r]![i]!) {
            best[r]![i] = cost;
            cut[r]![i] = j;
          }
        }
      }
    }
    const out: string[] = [];
    let end = n;
    for (let r = rows; r >= 1; r--) {
      const start = cut[r]![end]!;
      out.unshift(letters.slice(start, end).join(""));
      end = start;
    }
    return out;
  };
  /** One row, or the fewest rows (up to three) that keep the word at a readable size. */
  const chunkPlan = (word: number, kind: Kind): readonly string[] | null => {
    const text = texts[word]!;
    const nominal = nominalOf(kind);
    const floor = kind === "hero" ? HERO_MIN : PLAIN_MIN;
    if (kind === "label" || !SPLITTABLE.test(text) || [...text].length < 5) return null;
    const room = usable(-30);
    const fits = (parts: readonly string[]) => (nominal * room) / Math.max(...parts.map((part) => unitMetrics(part, HERO_FACE, kind === "hero" ? 0.015 : 0.02).adv * nominal)) >= floor;
    if (fits([text])) return null;
    for (const rows of [2, 3]) {
      const parts = chunkText(text, kind, rows);
      if (fits(parts) || rows === 3) return parts;
    }
    return null;
  };

  /** The rows of one block of words: runs of whole words split into `splits` rows each, long words broken into rows of their own. */
  const groupsOf = (list: readonly number[], kind: Kind): Group[] => {
    const groups: Group[] = [];
    let cur: number[] = [];
    const flush = () => {
      if (cur.length > 0) groups.push({ words: cur, chunks: null });
      cur = [];
    };
    for (const word of list) {
      const chunks = chunkPlan(word, kind);
      if (chunks) {
        flush();
        groups.push({ words: [word], chunks });
      } else cur.push(word);
    }
    flush();
    return groups;
  };
  const splitRows = (list: readonly number[], kind: Kind, rows: number): number[][] => {
    const gap = gapEmOf(kind) * nominalOf(kind);
    const w = list.map((word) => unitMetrics(texts[word]!, kind === "label" ? LABEL_FACE : HERO_FACE, 0).adv * nominalOf(kind) * (kind === "plain" && cue.words[word]!.role === "minor" ? MINOR : 1));
    const n = list.length;
    const width = (a: number, z: number) => w.slice(a, z).reduce((sum, value) => sum + value, 0) + gap * Math.max(0, z - a - 1);
    const best: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(n + 1).fill(Number.POSITIVE_INFINITY));
    const cut: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(n + 1).fill(0));
    best[0]![0] = 0;
    for (let r = 1; r <= rows; r++) {
      for (let i = r; i <= n; i++) {
        for (let j = r - 1; j < i; j++) {
          const cost = Math.max(best[r - 1]![j]!, width(j, i)) + 1e-6 * width(j, i) ** 2;
          if (cost < best[r]![i]!) {
            best[r]![i] = cost;
            cut[r]![i] = j;
          }
        }
      }
    }
    const out: number[][] = [];
    let end = n;
    for (let r = rows; r >= 1; r--) {
      const start = cut[r]![end]!;
      out.unshift(list.slice(start, end) as number[]);
      end = start;
    }
    return out;
  };
  const maxRowsOf = (kind: Kind, words: number) => (kind === "hero" ? Math.min(2, words) : Math.min(words >= 5 ? 3 : 2, words));

  /** Every arrangement of a block: how many rows each run of whole words takes. */
  const arrangements = (list: readonly number[], kind: Kind, tone: "lead" | "tail" | ""): Row[][] => {
    if (list.length === 0) return [[]];
    const groups = groupsOf(list, kind);
    const options = (group: Group): Row[][] => {
      if (group.chunks) {
        const word = group.words[0]!;
        return [group.chunks.map((text, part) => ({ kind, tone, nominal: nominalOf(kind), gapEm: gapEmOf(kind), runs: [runOf(word, part, group.chunks!.length, text, kind)] }))];
      }
      const out: Row[][] = [];
      for (let rows = 1; rows <= maxRowsOf(kind, group.words.length); rows++) {
        out.push(splitRows(group.words, kind, rows).map((words) => ({ kind, tone, nominal: nominalOf(kind), gapEm: gapEmOf(kind), runs: words.map((word) => runOf(word, 0, 1, texts[word]!, kind)) })));
      }
      return out;
    };
    let acc: Row[][] = [[]];
    for (const group of groups) {
      const next: Row[][] = [];
      for (const prefix of acc) for (const option of options(group)) next.push([...prefix, ...option]);
      acc = next.slice(0, 24);
    }
    return acc;
  };

  const rowDims = (row: Row, size: number) => {
    const widths = row.runs.map((run) => run.adv * size * run.scale);
    const width = widths.reduce((sum, value) => sum + value, 0) + row.gapEm * size * Math.max(0, row.runs.length - 1);
    const above = Math.max(...row.runs.map((run) => -run.top * size * run.scale)) + (row.kind === "hero" ? 0.045 * size : 2);
    const below = Math.max(...row.runs.map((run) => run.bot * size * run.scale)) + (row.kind === "hero" ? 0.105 * size : row.kind === "plain" ? 0.02 * size : 4);
    return { widths, width, above, below };
  };
  const gapBetween = (a: Row, row: Row, sa: number, sb: number) => {
    if (a.kind === "label" && row.kind === "label") return 10;
    if (a.kind === "label" || row.kind === "label") return 20;
    return 0.05 * Math.max(sa, sb);
  };

  interface Solved {
    readonly rows: readonly Row[];
    readonly sizes: readonly number[];
    readonly baselines: readonly number[];
    readonly score: number;
    readonly top: number;
    readonly bottom: number;
  }
  const solve = (rows: readonly Row[]): Solved => {
    const sizes = rows.map((row) => row.nominal);
    let baselines: number[] = [];
    let top = CONTENT_TOP;
    let bottom = CONTENT_BOTTOM;
    for (let iter = 0; iter < 16; iter++) {
      const dims = rows.map((row, at) => rowDims(row, sizes[at]!));
      const gaps = rows.map((row, at) => (at === 0 ? 0 : gapBetween(rows[at - 1]!, row, sizes[at - 1]!, sizes[at]!)));
      const total = dims.reduce((sum, dim) => sum + dim.above + dim.below, 0) + gaps.reduce((sum, gap) => sum + gap, 0);
      top = CONTENT_TOP + Math.max(0, (CONTENT_H - total) / 2);
      let cursor = top;
      baselines = [];
      rows.forEach((_, at) => {
        cursor += gaps[at]!;
        baselines.push(cursor + dims[at]!.above);
        cursor += dims[at]!.above + dims[at]!.below;
      });
      bottom = cursor;
      let changed = false;
      if (total > CONTENT_H + 0.5) {
        const f = (CONTENT_H / total) * 0.985;
        for (let at = 0; at < sizes.length; at++) sizes[at] = sizes[at]! * f;
        changed = true;
      } else {
        rows.forEach((_, at) => {
          const limit = usable(baselines[at]! + dims[at]!.below);
          if (dims[at]!.width > limit + 0.5) {
            sizes[at] = sizes[at]! * (limit / dims[at]!.width) * 0.985;
            changed = true;
          }
        });
      }
      if (!changed) break;
    }
    const ratio = Math.min(...rows.map((row, at) => sizes[at]! / row.nominal));
    return { rows, sizes, baselines, score: ratio - 0.002 * rows.length, top, bottom };
  };
  const blocks = heroed
    ? [arrangements(lead, "label", "lead"), arrangements(heroList, "hero", ""), arrangements(tail, "label", "tail")]
    : [arrangements(plainList, "plain", "")];
  let best: Solved | null = null;
  const search = (at: number, rows: Row[]) => {
    if (at === blocks.length) {
      const made = solve(rows);
      if (!best || made.score > best.score) best = made;
      return;
    }
    for (const option of blocks[at]!) search(at + 1, [...rows, ...option]);
  };
  search(0, []);
  const solved = best as Solved | null;
  if (!solved) return pieces;

  // Row geometry on the canvas.
  interface Placed {
    readonly run: Run;
    readonly row: number;
    readonly kind: Kind;
    readonly size: number;
    readonly x: number;
    readonly baseline: number;
    readonly width: number;
    readonly rowTop: number;
    readonly rowBottom: number;
  }
  const placed: Placed[] = [];
  solved.rows.forEach((row, at) => {
    const size = solved.sizes[at]!;
    const dims = rowDims(row, size);
    const order = rowVisualOrder(row.runs.map((run) => run.text), direction);
    let x = -dims.width / 2;
    for (const slot of order) {
      const run = row.runs[slot]!;
      const width = dims.widths[slot]!;
      const baseline = solved.baselines[at]!;
      placed.push({ run, row: at, kind: row.kind, size: size * run.scale, x: cx + (x + width / 2) * b, baseline: cy + baseline * b, width: width * b, rowTop: cy + (baseline - dims.above) * b, rowBottom: cy + (baseline + dims.below) * b });
      x += width + row.gapEm * size;
    }
  });
  const cellOf = (item: Placed): SpeechCell => ({
    at: item.run.word, text: item.run.text, face: item.run.face, size: item.size * b, spacing: item.run.spacing,
    x: item.x, baseline: item.baseline, width: item.width, inkTop: item.run.top * item.size * b, inkBottom: item.run.bot * item.size * b,
  });

  // The cue's clock, on the export frame grid.
  const bandHold = exit ? exitAt : to;
  const onsets = cue.words.map((word) => ctx.enter(word, 0, 0).from);
  const onset = Math.min(...onsets);
  const T0 = exportFrameAtOrAfter(cueFrom, fps);
  const times0 = exportFrameTimes(cueFrom, cueFrom + 400, fps);
  const T1 = times0[1] ?? T0;
  const powerOn = paintedFrameCount(cueFrom, onset, fps) >= 2 && times0.length >= 4;
  const tOpen = powerOn ? exportFrameAtOrAfter(T1 + OPEN_MS, fps) : T0;
  const collapseFrom = exit ? Math.max(exitAt, to - COLLAPSE_MS) : to;

  // Words: a wipe along the reading direction, planned on the frames the word really has.
  const wipeOf = (word: number, ms: number) => {
    const { from, settled } = ctx.enter(cue.words[word]!, ms, 0);
    const tc = exportFrameAtOrAfter(settled, fps);
    const times = exportFrameTimes(from, tc + 1, fps);
    const staged = times.length >= 2 && times[times.length - 1] === tc;
    return { from, tc, times, staged };
  };
  /** A static cut for one colour band (or the whole word's height), wide enough for the slide and the split. */
  const clipFor = (item: Placed, y1: number, y2: number, pad: number): Clip => {
    const left = item.x - item.width / 2 - pad;
    const right = item.x + item.width / 2 + pad;
    return { x1: [[cueFrom, left]], x2: [[cueFrom, right]], y1: [[cueFrom, y1]], y2: [[cueFrom, y2]] };
  };
  /** Every glyph is there on the first painted frame; the word slides in from the reading side and settles on the frames it has. */
  const slideOf = (item: Placed, wipe: ReturnType<typeof wipeOf>, extra = 0): Frames => {
    const n = wipe.times.length;
    if (!wipe.staged) return [[wipe.from, item.x]];
    return wipe.times.map((t, at) => {
      const left = (1 - at / (n - 1)) ** 3;
      return [t, item.x - side * (0.09 * item.size * b * left + extra * (1 - at / (n - 1)))] as const;
    });
  };

  const timing = new Map<number, ReturnType<typeof wipeOf>>();
  const timed = (word: number, ms: number) => {
    const known = timing.get(word);
    if (known) return known;
    const made = wipeOf(word, ms);
    timing.set(word, made);
    return made;
  };

  for (const item of placed) {
    const { run } = item;
    const cell = cellOf(item);
    const px = cell.size;
    const id = run.parts > 1 ? `${ctx.id}:w${run.word}l${run.part}` : `${ctx.id}:w${run.word}`;
    const wipe = timed(run.word, item.kind === "hero" ? SLIDE_HERO : item.kind === "label" ? SLIDE_LABEL : SLIDE_PLAIN);
    const t0 = wipe.from;
    const make = (suffix: string, fill: string, z: number, clip: Clip | null, extra: Partial<TextPiece> = {}, track: Track = {}): TextPiece => ({
      ...ctx.face(cell, t0, fill, { x: slide, ...track }),
      id: `${id}${suffix}`,
      z,
      ...(clip ? { clip } : {}),
      ...extra,
    });
    /** A constant opacity that still leaves with the cue. */
    const holdAt = (alpha: number): Frames => (exit ? [[t0, alpha], [exitAt, alpha], [to, 0, "in"]] : [[t0, alpha]]);
    const reach = 0.3 * px;
    const slide = slideOf(item, wipe);

    if (item.kind === "hero") {
      const capTop = cell.baseline + cell.inkTop;
      const capH = cell.baseline - capTop;
      const bandY = [capTop - 0.3 * px, ...BAND_CUTS.map((cut) => capTop + cut * capH), cell.baseline + 0.35 * px];
      const tone = th.bands;
      const stack: Shadow[] = [
        { dx: 0.0267 * px, dy: 0.068 * px, blur: 0, colour: DEEP, alpha: 1 },
        { dx: 0.0133 * px, dy: 0.034 * px, blur: 0, colour: DEEP, alpha: 1 },
      ];
      pieces.push(make("g", th.glow, 4, null, { stroke: { widthPx: 0.045 * px, colour: th.glow } }, { blur: [[t0, 0.045 * px]], o: holdAt(0.85) }));
      // The word's own piece is the pale neon edge with the extrusion under it; the six chrome bands are clipped copies over it.
      pieces.push(make("", th.edge, 5, null, { stroke: { widthPx: 0.032 * px, colour: th.edge }, shadows: stack }));
      for (let band = 0; band < 6; band++) {
        pieces.push(make(`b${band}`, tone[band]!, 7, clipFor(item, bandY[band]!, bandY[band + 1]!, reach)));
      }
      // The cyan/pink split sits under the chrome and converges in 140 ms.
      const gEnd = Math.min(to, exportFrameAtOrAfter(t0 + 140, fps) + 1);
      if (wipe.staged && paintedFrameCount(t0, gEnd, fps) >= 2) {
        for (const [tag, colour, dir] of [["cy", cyan, -1], ["pk", neon, 1]] as const) {
          pieces.push(make(tag, colour, 5.5, null, { toMs: gEnd }, { x: [...slideOf(item, wipe, 0.11 * px * dir).filter(([t]) => t < gEnd), [gEnd, item.x]], o: [[t0, 0.85], [gEnd, 0]] }));
        }
      }
    } else if (item.kind === "plain") {
      const s = px / 104;
      pieces.push(make("g", th.glow, 4, null, { stroke: { widthPx: 0.048 * px, colour: th.glow } }, { blur: [[t0, 7 * s]], o: holdAt(0.8) }));
      pieces.push(make("", pale, 6, null, { shadows: [{ dx: -4 * s, dy: 0, blur: 0, colour: cyan, alpha: 1 }, { dx: 4 * s, dy: 0, blur: 0, colour: neon, alpha: 1 }] }));
    } else {
      const fill = solved.rows[item.row]!.tone === "lead" ? th.top : th.bot;
      const sh = 0.075 * px;
      pieces.push(make("", fill, 6, null, { shadows: [{ dx: sh, dy: sh, blur: 0, colour: INK, alpha: 1 }] }));
    }
  }

  // The badge: pieces behind every word, cut by one aperture so the words are never clipped by it.
  const hh = (HALF_H + 34) * b;
  const openFrames: [number, number, Ease?][] = powerOn ? [[cueFrom, 0], [T1, 0], [T1 + OPEN_MS, 1, "out"]] : [[cueFrom, 1]];
  if (exit) {
    const lastOpen = openFrames[openFrames.length - 1]![0];
    const shut = Math.max(exportFrameAtOrBefore(to - 1, fps), Math.max(collapseFrom, lastOpen + 1) + 1);
    openFrames.push([Math.max(collapseFrom, lastOpen + 1), 1], [shut, 0, "out"]);
  }
  const aperture = (halfW: number): Clip => ({
    x1: [[cueFrom, cx - halfW * b]],
    x2: [[cueFrom, cx + halfW * b]],
    y1: openFrames.map(([t, o, e]) => [t, cy - hh * o, e] as const),
    y2: openFrames.map(([t, o, e]) => [t, cy + hh * o, e] as const),
  });
  const polygon = (points: readonly (readonly [number, number])[]) => polygonPath(points.map(([x, y]) => [x * b, y * b] as const));
  // libass blends the whole bounding box of every event on every frame, so each outline is four edge segments (two slanted
  // sides, the top and the bottom, joined by round caps) instead of one 880 x 500 ring.
  const edges = (points: readonly (readonly [number, number])[]) =>
    points.map((point, at) => {
      const next = points[(at + 1) % points.length]!;
      return [["M", point[0] * b, point[1] * b], ["L", next[0] * b, next[1] * b]] as PathCmd[];
    });
  const ring = (tag: string, points: readonly (readonly [number, number])[], z: number, width: number, colour: string, halfW: number, track: { o?: Frames; blur?: Frames } = {}, from = cueFrom, until = to) => {
    edges(points).forEach((path, at) => {
      const seg = ctx.shape(`${tag}${at}`, from, path, { ...at0, ...track });
      pieces.push({ ...seg, z, toMs: until, stroke: { widthPx: width * b, colour }, clip: aperture(halfW) });
    });
  };
  const at0 = { x: [[cueFrom, cx]] as Frames, y: [[cueFrom, cy]] as Frames };
  const glowTrack: Frames = exit ? [[cueFrom, 0.85], [exitAt, 0.85], [to, 0, "in"]] : [[cueFrom, 0.85]];
  ring("rimglow", OUTER, 1, 10, th.glow, HALF_TOP + 24, { blur: [[cueFrom, 6 * b]], o: glowTrack });
  const plate = ctx.shape("plate", cueFrom, polygon(OUTER), at0, INK);
  pieces.push({ ...plate, z: 2, fill: { colour: INK, alpha: 0.9 }, clip: aperture(HALF_TOP + 8) });
  ring("rim", OUTER, 2.5, 5, th.edge, HALF_TOP + 8);
  ring("inner", INNER, 3, 2.5, th.glow, HALF_TOP);

  // The skyline: three interleaved bar groups that breathe as a wave while the cue holds.
  {
    const base0 = (HALF_H - INNER_INSET_Y) * b;
    const hold = bandHold - tOpen;
    const wave = hold >= 500;
    for (let g = 0; g < 3; g++) {
      const path: PathCmd[] = [];
      for (let i = g; i < 22; i += 3) {
        const h = 10 + 36 * Math.abs(Math.sin(i * 1.7 + index * 2.3));
        const x = (-273 + i * 25.5) * b;
        path.push(...rectPath(x, -h * b, x + 16 * b, 0));
      }
      const phase = g * 2.1 + hash(index + 5) * 2;
      const fn = (t: number) => 0.8 + 0.2 * Math.sin(t / 380 + phase);
      const sy: Frames = wave ? sampleFrames(fn, [tOpen, bandHold], 0.02, { range: [tOpen, bandHold], wholeMs: true, simplify: true }) : [[cueFrom, 0.92]];
      const bars = ctx.shape(`bars${g}`, cueFrom, path, { x: [[cueFrom, cx]], y: [[cueFrom, cy + base0]], sy }, th.bars);
      pieces.push({ ...bars, z: 3, fill: { colour: th.bars, alpha: 0.92 }, clip: aperture(HALF_TOP) });
    }
  }

  // The power-on line: 8 px of white for about 40 ms, then the plate opens out of it.
  if (powerOn) {
    const end = exportFrameAfter(T1, fps);
    const lineTrack = { x: [[T0, cx]] as Frames, y: [[T0, cy]] as Frames, sx: [[T0, 0.35], [T1, 1, "outExpo" as Ease]] as Frames, o: [[T0, 1], [T1, 0.9]] as Frames };
    const halo = ctx.shape("linehalo", T0, rectPath(-HALF_TOP * b, -9 * b, HALF_TOP * b, 9 * b), lineTrack, th.edge);
    pieces.push({ ...halo, z: 3, toMs: end, fill: { colour: th.edge, alpha: 0.55 } });
    const line = ctx.shape("line", T0, rectPath(-HALF_TOP * b, -4 * b, HALF_TOP * b, 4 * b), lineTrack, "#FFFFFF");
    pieces.push({ ...line, z: 3.5, toMs: end });
  }

  // The rim flash: 20 % white on the rim for two frames when the plate is up.
  {
    const t = tOpen;
    const end = exportFrameAfter(exportFrameAfter(t, fps), fps);
    if (end < bandHold && paintedFrameCount(t, end, fps) >= 2) {
      ring("flash", OUTER, 3, 16, "#FFFFFF", HALF_TOP + 8, { o: [[t, 0.2]] }, t, end);
    }
  }

  // The scan bar: sweeps down the plate once it has opened, again every 1.8 s of a long hold.
  {
    const topY = CONTENT_TOP - 4;
    const botY = HALF_H - INNER_INSET_Y - 6;
    const sweepMs = (start: number) => clamp(bandHold - start - 2 * 34, 0, 260);
    for (let sweep = 0, a = powerOn ? tOpen : Math.max(cueFrom, onset); sweep < 3; sweep++, a += 1800) {
      const ms = sweepMs(a);
      if (ms < 100 || a + ms > bandHold) break;
      const end = a + ms;
      const rowAt = (y: number) => usable(y) + 2 * SIDE_MARGIN - 56;
      const path = rectPath(-HALF_TOP * b, -1.5 * b, HALF_TOP * b, 1.5 * b);
      const scan = ctx.shape(`scan${sweep}`, a, path, {
        x: [[a, cx]],
        y: [[a, cy + topY * b], [end, cy + botY * b]],
        sx: [[a, rowAt(topY) / (2 * HALF_TOP)], [end, rowAt(botY) / (2 * HALF_TOP)]],
        o: [[a, 0], [a + ms * 0.2, 0.55, "out"], [a + ms * 0.8, 0.55], [end, 0]],
      }, th.top);
      pieces.push({ ...scan, z: 3, toMs: end, clip: aperture(HALF_TOP) });
    }
  }

  // A neon rule draws out from the middle under the key word (under the last row of a plain cue), when the plate has room.
  {
    const mainKind: Kind = heroed ? "hero" : "plain";
    const mainRows = solved.rows.flatMap((row, at) => (row.kind === mainKind ? [at] : []));
    const lastMain = mainRows[mainRows.length - 1]!;
    const mainBottom = solved.baselines[lastMain]! + rowDims(solved.rows[lastMain]!, solved.sizes[lastMain]!).below;
    const ruleY = cy + (mainBottom + 5) * b;
    const limit = cy + (HALF_H - INNER_INSET_Y - 56) * b;
    if (ruleY + 2 * b < limit) {
      const items = placed.filter((item) => item.kind === mainKind);
      const half = Math.min(usable(mainBottom + 5) / 2 - 20, Math.max(...items.map((item) => Math.abs(item.x - cx) + item.width / 2)) / b);
      const a = Math.max(cueFrom, heroed ? onsets[heroList[0]!]! : onset);
      const end = Math.min(bandHold, a + 130);
      if (half > 40 && paintedFrameCount(a, bandHold, fps) >= 3) {
        const rule = ctx.shape("rule", a, rectPath(-half * b, -1.5 * b, half * b, 1.5 * b), {
          x: [[a, cx]],
          y: [[a, ruleY]],
          sx: end - a >= 34 ? [[a, 0.05], [end, 1, "outExpo"]] : [[a, 1]],
        }, th.edge);
        pieces.push({ ...rule, z: 3 });
      }
    }
  }

  // Sparkles round the corners, outside the badge, twinkling all hold; a short cue holds them still.
  {
    const spots = [
      { x: -452, y: -262, s: 62, per: 1500, off: 0 },
      { x: 452, y: -196, s: 46, per: 1200, off: 420 },
      { x: -430, y: 236, s: 40, per: 1350, off: 800 },
      { x: 456, y: 262, s: 70, per: 1700, off: 250 },
    ];
    const inside = { x1: bounds.x1 + 4, x2: bounds.x2 - 4, y1: bounds.y1 + 4, y2: bounds.y2 - 4 };
    const upAt = Math.max(cueFrom, onset + 120);
    const hold = bandHold - upAt;
    spots.forEach((spot, si) => {
      const r = 0.475 * spot.s * b;
      const x = clamp(cx + spot.x * b, inside.x1 + r * 1.5, inside.x2 - r * 1.5);
      const y = clamp(cy + spot.y * b, inside.y1 + r * 1.5, inside.y2 - r * 1.5);
      const animated = hold >= 400;
      if (!animated && (hold < 70 || si > 1)) return;
      const t0 = upAt;
      const pulse = (t: number) => {
        const q = (t - upAt - spot.off) / spot.per;
        const ph = q - Math.floor(q);
        return t < upAt + spot.off ? 0 : Math.max(0, Math.sin(ph * Math.PI)) ** 3;
      };
      const edges: number[] = [];
      for (let e = upAt + spot.off; e < bandHold; e += spot.per / 2) edges.push(e);
      const grow: Frames = animated ? sampleFrames((t) => pulse(t), [t0, ...edges, bandHold], 0.03, { range: [t0, bandHold], wholeMs: true, simplify: true }) : [[t0, 0.85]];
      const spin: Frames = animated ? sampleFrames((t) => {
        const q = (t - upAt - spot.off) / spot.per;
        return (q - Math.floor(q)) * 40 - 20;
      }, [t0, ...edges, bandHold], 0.5, { range: [t0, bandHold], wholeMs: true, simplify: true }) : [[t0, 0]];
      const tracks = { x: [[t0, x]] as Frames, y: [[t0, y]] as Frames, sx: grow, sy: grow, rz: spin };
      const halo = ctx.shape(`spark${si}h`, t0, horizonSparklePath(r * 1.5), tracks, th.edge);
      pieces.push({ ...halo, z: 7, fill: { colour: th.edge, alpha: 0.38 } });
      const core = ctx.shape(`spark${si}`, t0, horizonSparklePath(r), tracks, "#FFFFFF");
      pieces.push({ ...core, z: 7.5 });
    });
  }

  return pieces;
}, undefined, 80);


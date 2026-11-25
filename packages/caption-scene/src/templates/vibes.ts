import { CAPTION_SCENE_BRAND_MIN_CONTRAST, captionColourContrast } from "@narriflow/validators";
import type { DemoScript } from "../demo";
import { clamp, type Frames } from "../ease";
import { exportFrameAtOrAfter, exportFrameTimes, paintedFrameCount } from "../frame-grid";
import { balancedRows, rowsFromRoles, rowVisualOrder } from "../layout";
import { type Box, mixColour, type PathCmd, type Piece, pieceBounds, type ShapePiece, type TextPiece, type Track } from "../scene";
import { ellipsePath, pathBounds, polylinePath, roundedRectPath, sparklePath } from "../shapes";
import { caps, galleryScene } from "./gallery-layout";
import type { SpeechCell } from "./speech-layout";

/**
 * Vibes (`samples/templates/m69-vibes.js`): a retro sticker script. The key word is a bold black script with a thick white
 * outline and a hard black offset shadow; tiny tracked caps sit above and below it, one of them in a black pill. Around it
 * accents pop: a pastel circle or flower behind, sunburst strokes, four-point sparkles and a little swirl. Soft pink and
 * lilac, very Instagram.
 *
 * Changes from the sample, and why (Sol's gallery 6 review, 2026-11-25, and the real-cue rules):
 * - **The sticker is whole at the word's onset.** The sample wrote each word on with a 420-620 ms clip, so ENOUGH spent half
 *   a second behind the wipe and the hero showed only its opening while it was being said. Every face (script, caps, pill)
 *   now paints whole, opaque, on the first frame at or after its spoken start. The write-on survives as a highlight wipe: a
 *   copy of the script in the pastel colour sweeps left to right (right to left for Urdu and Arabic) across the finished
 *   word in 66-110 ms, cubic-out (the short end for a short word), and is gone before the word has been read.
 * - **A short pop instead of a slow entrance.** Script words swing in from 7 degrees off and 90 % scale, over-shoot to 104 %
 *   and settle in 130-150 ms (always inside the word's own time; a word with no room for two painted frames is simply
 *   there); caps rise 14 px at 82 % scale. The sample's early start (70 ms before speech) is gone.
 * - **No entrance reservation.** Every face first paints on the word's own onset, so the cue window opens with no lead
 *   (`galleryScene`'s `lead` is 0) and the outgoing cue keeps the time the sample's 80 ms reservation would have taken.
 * - **The exit is one short fade.** The sample wiped the block out from the left and cut KIND down to ND while it was
 *   still on screen. The whole block now holds until the last word has had its reading hold, then fades in 35-60 ms (a hard
 *   cut when two painted frames do not fit).
 * - **Fewer, smaller accents, kept clear of the ink.** The big spiral (about 110 px of radius in the sample's viewBox) is a
 *   58 px swirl, sparkles are 30-44 px (the sample had three, up to 96 px), the rays start 18 px or more from the key word's
 *   painted box (the sample's sat on the H's shoulder), and nothing but the pastel disc or flower (which is behind the
 *   words, as in the sample) overlaps a word. Every accent is placed by a free-space search against every word's ink,
 *   outline and shadow; one with no free spot is left out, never clamped onto the text.
 * - **Real width fitting.** The sample's support row and the no-hero script rows had no width check (132 px script rows, a
 *   0.16 em tracked caps row). Both lanes are measured with the pill's padding; Latin tracking is 0.07 em (none for other
 *   scripts, so Devanagari, Arabic and the rest stay whole and untouched); rows reflow (balanced) before any size is
 *   squeezed, a word wider than the column at 62 % of its size is broken across rows (Latin, Cyrillic and Greek only), and
 *   anything else is fitted whole. Rows are stacked by their real ink (tilt, outline and shadow included), so none touches
 *   another, in Devanagari too.
 * - **Rows and words follow speech.** The sample's rows were baked into role runs and its accent sides, pastel colours and
 *   flower or circle were indexed by cue. Rows now come from the roles (words before the key word, the key word on its own
 *   row, words after it); the pill goes on the last word after the key word (else before it); the accent kit cycles by a
 *   per-cue counter (hero cues and plain cues each with their own) and the tilts are the sample's -3 and -2 degrees varied by
 *   counter and a deterministic hash. Words keep the transcript's casing in the script (caps in the tracked rows).
 * - **A rounded sticker shadow.** The sample's CSS group shadow is one low-alpha blurred copy under the script; the four
 *   stacked copies of the hard shadow are two (a half-offset one bridges the gap), solid at a third of the cost.
 * - Extra recurring beats, in the sticker language, on every cue: three tiny pastel dots with an ink keyline pop beside the
 *   accents one after another (a trail for the sparkle); the sparkles twinkle again every 1.1 s of a long hold; and the
 *   sunburst and the swirl alternate by cue so a long clip keeps changing (the swirl is its own variant, never both).
 * - Brand colours: the paper white (outline, pill text), the pastel (disc, flower, sweep, dots) and the ink are the preset's
 *   three colours; the catalogue row's `readsOn` keeps a brand colour that vanishes against the ink from replacing them.
 */

export const VIBES_DEMO: DemoScript = {
  lines: [
    "you:b are:m ENOUGH:h@640 right:b now:b",
    "good:b VIBES:h@620 only:b",
    "be:m KIND:h@560",
    "take:b a:m deep:b breath:b",
    "stay:b WEIRD:h@620 and:m shine:b",
  ],
  options: { rate: 230, gap: 50, cueGap: 170, tail: 700, lead: 360 },
};

const SCRIPT = "Oleo Script Bold" as const;
const CAPS_FACE = "Archivo Black" as const;
const HERO_FS = 236;
const WORD_FS = 132;
const CAPS_FS = 46;
const HERO_COLUMN = 720;
const COLUMN = 800;
const TRACKING = 0.07;
const MIN_FIT = 0.62;
const OUTLINE_EM = 0.05;
const DEPTH_EM = 0.065;
const CAPS_STROKE = 5;
const PILL_PX = 32;
const PILL_PY = 13;
const CAPS_GAP = 22;
const SCRIPT_GAP = 26;
const CLEAR = 18;
const HERO_TILTS = [-3, 2.5, -2, 3] as const;
const WORD_TILTS = [-2, 1.5, -1.5, 2] as const;
const PINK_ALT = "#C8AEFF";
const HOT = "#FF4FA3";
const VIOLET = "#8B6CF2";
const GLOW = "#3C1446";
const DEFAULT_PAPER = "#FFFFFF";
const DEFAULT_INK = "#17111F";
const DEFAULT_PASTEL = "#FFA9D2";

const SIDE_GAP = 44;

const SPLITTABLE = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{N}\p{P}]+$/u;

const hash = (text: string) => {
  let h = 2166136261;
  for (const ch of text) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

const overlaps = (a: Box, b: Box) => a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
const inflate = (box: Box, by: number): Box => ({ x1: box.x1 - by, y1: box.y1 - by, x2: box.x2 + by, y2: box.y2 + by });
const union = (boxes: readonly Box[]): Box => ({
  x1: Math.min(...boxes.map((box) => box.x1)),
  y1: Math.min(...boxes.map((box) => box.y1)),
  x2: Math.max(...boxes.map((box) => box.x2)),
  y2: Math.max(...boxes.map((box) => box.y2)),
});

type Kind = "hero" | "script" | "caps";

interface Item {
  readonly word: number;
  readonly part: number;
  readonly parts: number;
  readonly text: string;
  readonly kind: Kind;
  readonly face: typeof SCRIPT | typeof CAPS_FACE;
  readonly size: number;
  readonly spacing: number;
}

interface Placed extends Item {
  readonly flat: number;
  /** Local px (sample px, block centre at the anchor). `cx` is the middle of the advance, `c` the ink centre above the baseline. */
  readonly cx: number;
  readonly baseline: number;
  readonly w: number;
  readonly inkTop: number;
  readonly inkBottom: number;
  readonly c: number;
  readonly tilt: number;
  readonly pill: boolean;
  /** Everything the item paints at rest, tilted, outline and shadow included. */
  readonly box: Box;
}

const sparkle = (radius: number): PathCmd[] => sparklePath(radius);

/** A spiral of `turns` turns out to radius `radius`, an open path (stroke it). */
function spiralPath(radius: number, turns: number): PathCmd[] {
  const steps = 56;
  const points: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * turns * 2 * Math.PI;
    const r = (radius * i) / steps;
    points.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return polylinePath(points);
}

export const vibesProgram = galleryScene("vibes", 1290, (ctx) => {
  const { cue, index, to, from: cueFrom, bounds } = ctx.window;
  const { exitAt, fps, side, space, rtl } = ctx;
  const c = ctx.input.colours;
  // The pairs that are really drawn must read at 3:1: paper against the ink (outline, pill text), and below the pastel against
  // the ink (disc, sweep) once the odd-cue blend is applied. The first pair that reads wins: the brand's own, then each
  // default in turn (an all-white palette falls back to the style's white on ink).
  const reads = (a: string, b: string) => captionColourContrast(a, b) >= CAPTION_SCENE_BRAND_MIN_CONTRAST;
  const [paper, ink] = ([[c.primary, c.accent], [c.primary, DEFAULT_INK], [DEFAULT_PAPER, c.accent]] as const).find(([a, b]) => reads(a, b)) ?? ([DEFAULT_PAPER, DEFAULT_INK] as const);
  const u = space.u;
  const ox = space.x(540);
  const oy = space.y(1290);
  const pieces: Piece[] = [];
  const direction = rtl ? "rtl" : "ltr";

  const roles = cue.words.map((word) => word.role);
  const { lead, hero, tail } = rowsFromRoles(roles);
  const heroed = hero.length > 0;

  // Counters: hero cues and plain cues each cycle on their own.
  const earlier = ctx.input.cues.slice(0, index).filter((other) => other.words.length > 0);
  const count = earlier.filter((other) => other.words.some((word) => word.role === "hero") === heroed).length;
  const flip = count % 2 === 1;
  const pastelNow = [count % 2 === 0 ? c.highlight : mixColour(c.highlight, PINK_ALT, 0.6), c.highlight, DEFAULT_PASTEL].find((colour) => reads(colour, ink)) ?? DEFAULT_PASTEL;
  const seed = hash(`${index}:${cue.words.map((word) => word.text).join(" ")}`);

  // ---- Measuring, in sample px (the layout is in a block centred on the anchor). ----
  const measure = (text: string, face: Item["face"], size: number, spacing: number) => {
    const m = ctx.input.measure(text, face, size * u, spacing);
    return { advance: m.advance / u, inkTop: m.inkTop / u, inkBottom: m.inkBottom / u };
  };
  const spacingOf = (text: string) => (SPLITTABLE.test(text) ? TRACKING : 0);
  const advance = (text: string, face: Item["face"], size: number, spacing: number) => measure(text, face, size, spacing).advance;
  /**
   * A word too wide for its column at 62 % of its size is cut into the fewest rows whose parts all fit the column at that
   * floor, then the widest part is made as narrow as that many rows allow. (Estimating the rows from the total width alone
   * can leave every two-row split just over the column.)
   */
  const breakInto = (text: string, face: Item["face"], size: number, spacing: number, column: number): string[] => {
    const total = advance(text, face, size, spacing);
    if (!SPLITTABLE.test(text) || total * MIN_FIT <= column) return [text];
    const chars = [...text];
    const parts = (limit: number): string[] => {
      const out: string[] = [];
      let row = "";
      for (const ch of chars) {
        if (row && advance(row + ch, face, size, spacing) > limit) {
          out.push(row);
          row = "";
        }
        row += ch;
      }
      if (row) out.push(row);
      return out;
    };
    const widest = column / MIN_FIT;
    const rows = Math.max(2, parts(widest).length);
    let low = total / rows;
    let high = widest;
    let best = parts(widest);
    for (let step = 0; step < 14; step++) {
      const mid = (low + high) / 2;
      const split = parts(mid);
      if (split.length <= rows) {
        best = split;
        high = mid;
      } else low = mid;
    }
    return best;
  };

  const pillWord = heroed ? (tail.length > 0 ? tail.at(-1)! : lead.at(-1)!) : -1;
  const kindOf = (at: number): Kind => (!heroed ? "script" : hero.includes(at) ? "hero" : "caps");
  // Scripts without case draw small beside tracked Latin caps in the fallback face, so they get a larger nominal size.
  const nominalOf = (kind: Kind, text = "") => (kind === "hero" ? HERO_FS : kind === "script" ? WORD_FS : SPLITTABLE.test(text) ? CAPS_FS : CAPS_FS * 1.3);
  const textOf = (at: number, kind: Kind) => (kind === "caps" ? caps(cue.words[at]!, cue) : cue.words[at]!.text);
  const toLocal = (box: Box): Box => ({ x1: (box.x1 - ox) / u, x2: (box.x2 - ox) / u, y1: (box.y1 - oy) / u, y2: (box.y2 - oy) / u });
  const area = toLocal({ x1: bounds.x1 + 4, y1: bounds.y1 + 4, x2: bounds.x2 - 4, y2: bounds.y2 - 4 });
  const availW = area.x2 - area.x1;
  const availH = area.y2 - area.y1;

  // ---- Tilt, extents and stacking. ----
  const tiltOf = (item: Item, row: number) => {
    if (item.kind === "caps") return 0;
    const jitter = ((((seed >>> (item.word % 8)) % 11)) - 5) * 0.12;
    const table = item.kind === "hero" ? HERO_TILTS : WORD_TILTS;
    return table[(count + row) % table.length]! + jitter;
  };
  const rotate = (x: number, y: number, degrees: number): [number, number] => {
    const a = (degrees * Math.PI) / 180;
    return [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
  };
  interface Metric {
    readonly w: number;
    readonly inkTop: number;
    readonly inkBottom: number;
    readonly c: number;
    readonly tilt: number;
    readonly pill: boolean;
    /** The painted box relative to the baseline centre (x) and baseline (y). */
    readonly rel: Box;
  }

  interface Plan {
    readonly items: readonly Item[];
    readonly flatOf: readonly (readonly number[])[];
    readonly placed: Placed[];
    readonly block: Box;
    /** The scale (at most 1) at which the block fits the lane. */
    readonly fit: number;
  }

  /** The cue laid out in one column (support rows above and below the key word), or with the support rows in a lane beside it. */
  const plan = (beside: boolean): Plan => {
    const supportColumn = beside ? clamp(0.34 * availW, 240, COLUMN) : COLUMN;
    const heroColumn = beside ? Math.max(HERO_COLUMN, availW - supportColumn - SIDE_GAP) : HERO_COLUMN;
    const columnOf = (kind: Kind, at: number) =>
      kind === "hero" ? heroColumn : kind === "script" ? COLUMN : supportColumn - (at === pillWord ? 2 * PILL_PX : 0) - 2 * CAPS_STROKE;
    interface Chunked {
      readonly word: number;
      readonly texts: string[];
      readonly kind: Kind;
    }
    const chunked: Chunked[] = cue.words.map((_, at) => {
      const kind = kindOf(at);
      const face = kind === "caps" ? CAPS_FACE : SCRIPT;
      const spacing = kind === "caps" ? spacingOf(textOf(at, kind)) : 0;
      return { word: at, kind, texts: breakInto(textOf(at, kind), face, nominalOf(kind, textOf(at, kind)), spacing, columnOf(kind, at)) };
    });
    // Hero words share one size and script words share one (the largest every piece fits at); caps are fitted word by word.
    const fitted = (kind: Kind, text: string, at: number) => {
      const face = kind === "caps" ? CAPS_FACE : SCRIPT;
      const nominal = nominalOf(kind, text);
      return Math.min(nominal, (nominal * columnOf(kind, at)) / Math.max(1, advance(text, face, nominal, kind === "caps" ? spacingOf(text) : 0)));
    };
    const sizeOfKind = (kind: "hero" | "script") => Math.min(nominalOf(kind), ...chunked.filter((entry) => entry.kind === kind).flatMap((entry) => entry.texts.map((text) => fitted(kind, text, entry.word))));
    const sizes = { hero: sizeOfKind("hero"), script: sizeOfKind("script") };
    // Pack fewer rows first: key words that would wrap onto two rows share one when that costs under 30 % of their size.
    const heroTexts = hero.flatMap((at) => chunked[at]!.texts);
    if (heroTexts.length >= 2 && chunked.every((entry) => entry.kind !== "hero" || entry.texts.length === 1)) {
      const total = heroTexts.reduce((sum, text) => sum + advance(text, SCRIPT, sizes.hero, 0), 0) + 0.24 * sizes.hero * (heroTexts.length - 1);
      if (total > heroColumn && heroColumn / total >= 0.7) sizes.hero *= (heroColumn / total) * 0.995;
    }

    const items: Item[] = [];
    const flatOf: number[][] = chunked.map((entry) =>
      entry.texts.map((text, part) => {
        const kind = entry.kind;
        const face = kind === "caps" ? CAPS_FACE : SCRIPT;
        return items.push({ word: entry.word, part, parts: entry.texts.length, text, kind, face, size: kind === "caps" ? fitted(kind, text, entry.word) : sizes[kind], spacing: kind === "caps" ? spacingOf(text) : 0 }) - 1;
      }),
    );
    const groupOf = (list: readonly number[]) => list.flatMap((at) => flatOf[at]!);

    // Rows.
    const widthOf = (item: Item, pill: boolean) => {
      const w = advance(item.text, item.face, item.size, item.spacing);
      return item.kind === "caps" ? w + (pill ? 2 * PILL_PX : 2 * CAPS_STROKE) : w;
    };
    const isPill = (flat: number) => items[flat]!.kind === "caps" && flatOf[pillWord]?.at(-1) === flat;
    const capsRows = (group: readonly number[]) => {
      if (group.length === 0) return [];
      const widths = group.map((flat) => widthOf(items[flat]!, isPill(flat)));
      return balancedRows(widths, CAPS_GAP, supportColumn).map((row) => row.map((at) => group[at]!));
    };
    const scriptRows = (group: readonly number[], kind: Kind): number[][] => {
      if (group.length === 0) return [];
      const gap = kind === "hero" ? 0.24 * sizes.hero : SCRIPT_GAP;
      const column = kind === "hero" ? heroColumn : COLUMN;
      const widths = group.map((flat) => widthOf(items[flat]!, false));
      let rows: number[][];
      if (kind === "script" && group.length >= 2) {
        // The sample's two rows, halved; more rows only when a half does not fit.
        const half = Math.ceil(group.length / 2);
        rows = [group.slice(0, half), group.slice(half)].map((row) => row.map((flat) => group.indexOf(flat)));
        const fits = rows.every((row) => row.reduce((sum, at) => sum + widths[at]!, 0) + gap * Math.max(0, row.length - 1) <= column);
        if (!fits) rows = balancedRows(widths, gap, column);
      } else rows = balancedRows(widths, gap, column);
      return rows.map((row) => row.map((at) => group[at]!));
    };
    const rowSpecs: { kind: Kind; flats: number[]; gap: number; lane: number }[] = [];
    const addRows = (rows: number[][], kind: Kind) => {
      for (const row of rows) {
        const order = rowVisualOrder(row.map((flat) => items[flat]!.text), direction);
        rowSpecs.push({ kind, flats: order.map((at) => row[at]!), gap: kind === "caps" ? CAPS_GAP : kind === "hero" ? 0.24 * sizes.hero : SCRIPT_GAP, lane: beside && kind === "caps" ? 1 : 0 });
      }
    };
    if (heroed && beside) {
      addRows(capsRows([...groupOf(lead), ...groupOf(tail)]), "caps");
      addRows(scriptRows(groupOf(hero), "hero"), "hero");
    } else if (heroed) {
      addRows(capsRows(groupOf(lead)), "caps");
      addRows(scriptRows(groupOf(hero), "hero"), "hero");
      addRows(capsRows(groupOf(tail)), "caps");
    } else {
      addRows(scriptRows(groupOf(cue.words.map((_, at) => at)), "script"), "script");
    }

    const metricOf = (flat: number, row: number): Metric => {
      const item = items[flat]!;
      const m = measure(item.text, item.face, item.size, item.spacing);
      const centre = (m.inkTop + m.inkBottom) / 2;
      const pill = isPill(flat);
      const tilt = tiltOf(item, row);
      let rel: Box;
      if (item.kind === "caps") {
        if (pill) {
          const pw = m.advance + 2 * PILL_PX;
          const ph = m.inkBottom - m.inkTop + 2 * PILL_PY;
          rel = { x1: -pw / 2, x2: pw / 2, y1: centre - ph / 2, y2: centre + ph / 2 };
        } else rel = { x1: -m.advance / 2 - CAPS_STROKE, x2: m.advance / 2 + CAPS_STROKE, y1: m.inkTop - CAPS_STROKE, y2: m.inkBottom + CAPS_STROKE };
      } else {
        const o = OUTLINE_EM * item.size;
        const d = DEPTH_EM * item.size;
        const local: Box = { x1: -m.advance / 2 - o, x2: m.advance / 2 + o + d, y1: m.inkTop - o, y2: m.inkBottom + o + d };
        const corners = [[local.x1, local.y1], [local.x2, local.y1], [local.x2, local.y2], [local.x1, local.y2]].map(([x, y]) => {
          const [rx, ry] = rotate(x!, y! - centre, tilt);
          return [rx, ry + centre] as const;
        });
        rel = { x1: Math.min(...corners.map((p) => p[0])), x2: Math.max(...corners.map((p) => p[0])), y1: Math.min(...corners.map((p) => p[1])), y2: Math.max(...corners.map((p) => p[1])) };
      }
      return { w: m.advance, inkTop: m.inkTop, inkBottom: m.inkBottom, c: centre, tilt, pill, rel };
    };

    // Stacking: each lane is its own column of rows, centred vertically on the anchor line (the sample's translateY(-50%)).
    const metrics = rowSpecs.map((row, r) => row.flats.map((flat) => metricOf(flat, r)));
    const cursors = [0, 0];
    const lastKind: (Kind | null)[] = [null, null];
    const laneWidth = [0, 0];
    const rowsOut = rowSpecs.map((row, r) => {
      const top = Math.min(...metrics[r]!.map((m) => m.rel.y1));
      const bottom = Math.max(...metrics[r]!.map((m) => m.rel.y2));
      const previous = lastKind[row.lane];
      if (previous) cursors[row.lane]! += previous === "caps" && row.kind === "caps" ? 6 : previous === "caps" || row.kind === "caps" ? 10 : 6;
      const baseline = cursors[row.lane]! - top;
      cursors[row.lane] = baseline + bottom;
      lastKind[row.lane] = row.kind;
      const widths = metrics[r]!.map((m, k) => (items[row.flats[k]!]!.kind === "caps" ? Math.max(m.w + (m.pill ? 2 * PILL_PX : 2 * CAPS_STROKE), m.rel.x2 - m.rel.x1) : m.w));
      const total = widths.reduce((sum, w) => sum + w, 0) + row.gap * Math.max(0, row.flats.length - 1);
      laneWidth[row.lane] = Math.max(laneWidth[row.lane]!, total);
      return { baseline, widths, total };
    });
    // Lane centres: one lane on the axis; two lanes side by side, the support lane first in reading direction.
    const centres = beside ? (() => {
      const total = laneWidth[0]! + SIDE_GAP + laneWidth[1]!;
      const supportFirst = !rtl;
      const heroX = supportFirst ? -total / 2 + laneWidth[1]! + SIDE_GAP + laneWidth[0]! / 2 : -total / 2 + laneWidth[0]! / 2;
      const supportX = supportFirst ? -total / 2 + laneWidth[1]! / 2 : -total / 2 + laneWidth[0]! + SIDE_GAP + laneWidth[1]! / 2;
      return [heroX, supportX];
    })() : [0, 0];
    const placed: Placed[] = [];
    rowSpecs.forEach((row, r) => {
      const { baseline: base, widths, total } = rowsOut[r]!;
      const baseline = base - cursors[row.lane]! / 2;
      let x = centres[row.lane]! - total / 2;
      row.flats.forEach((flat, k) => {
        const m = metrics[r]![k]!;
        const item = items[flat]!;
        const cx = x + widths[k]! / 2;
        placed.push({
          ...item, flat, cx, baseline, w: m.w, inkTop: m.inkTop, inkBottom: m.inkBottom, c: m.c, tilt: m.tilt, pill: m.pill,
          box: { x1: cx + m.rel.x1, x2: cx + m.rel.x2, y1: baseline + m.rel.y1, y2: baseline + m.rel.y2 },
        });
        x += widths[k]! + row.gap;
      });
    });
    const block = union(placed.map((p) => p.box));
    return { items, flatOf, placed, block, fit: Math.min(1, availH / Math.max(1, block.y2 - block.y1), availW / Math.max(1, block.x2 - block.x1)) };
  };
  let chosen = plan(false);
  // A wide lane that would shrink a stacked caption takes the support words beside the key word instead, when that fits better.
  if (heroed && chosen.fit < 0.9 && availW >= 1.15 * availH) {
    const alongside = plan(true);
    if (alongside.fit > chosen.fit * 1.12) chosen = alongside;
  }
  const { placed, block } = chosen;
  // Into the lane (the framework scales the cue down when it is taller or wider than the lane).
  const dyIn = block.y1 < area.y1 ? area.y1 - block.y1 : block.y2 > area.y2 ? area.y2 - block.y2 : 0;
  const dxIn = block.x1 < area.x1 ? area.x1 - block.x1 : block.x2 > area.x2 ? area.x2 - block.x2 : 0;
  for (let k = 0; k < placed.length; k++) {
    const p = placed[k]!;
    placed[k] = {
      ...p, cx: p.cx + dxIn, baseline: p.baseline + dyIn,
      box: { x1: p.box.x1 + dxIn, x2: p.box.x2 + dxIn, y1: p.box.y1 + dyIn, y2: p.box.y2 + dyIn },
    };
  }
  const X = (x: number) => ox + x * u;
  const Y = (y: number) => oy + y * u;

  // ---- Timing. ----
  // One fade of 60 ms; a frame rate that cannot paint two frames in it gets 67 ms; no room for two frames is a hard cut.
  const fadeAt = [60, 67].map((length) => Math.max(exitAt, to - length)).find((at) => paintedFrameCount(at, to, fps) >= 2) ?? to;
  const fades = fadeAt < to;
  const hold = fades ? fadeAt : to;
  const opacity = (from: number): Frames => (fades ? [[from, 1], [fadeAt, 1], [to, 0, "in"]] : [[from, 1]]);
  /** A pop on the frames there are: a bounce from four painted frames, a monotone settle from three, else the rest pose. */
  const pop = (at: number, end: number, start: number, peak: number): Frames => {
    const frames = paintedFrameCount(at, end, fps);
    if (frames >= 4) return [[at, start], [at + 0.55 * (end - at), peak, "out"], [end, 1, "inOut"]];
    if (frames >= 2) return [[at, start], [end, 1, "out"]];
    return [[at, 1]];
  };
  const wordTimes = cue.words.map((word, at) => {
    const d = kindOf(at) === "hero" ? 150 : kindOf(at) === "script" ? 130 : 120;
    return { ...ctx.enter(word, d, 0), d };
  });

  // ---- The words. ----
  const heroItems = placed.filter((p) => p.kind === "hero");
  let heroFrom = cueFrom;
  for (const p of placed) {
    const word = cue.words[p.word]!;
    const { from, settled, motion } = wordTimes[p.word]!;
    const wid = p.parts > 1 ? `${ctx.id}:w${p.word}l${p.part}` : `${ctx.id}:w${p.word}`;
    const px = X(p.cx);
    const py = Y(p.baseline + p.c);
    const script = p.kind !== "caps";
    const swing = script ? -7 * side : 0;
    const track: Track = {
      x: [[from, px]],
      y: motion ? [[from, py + 14 * u], [settled, py, "outExpo"]] : [[from, py]],
      sx: motion ? pop(from, settled, script ? 0.9 : 0.82, script ? 1.04 : 1.06) : [[from, 1]],
      sy: motion ? pop(from, settled, script ? 0.9 : 0.82, script ? 1.04 : 1.06) : [[from, 1]],
      rz: motion && script ? [[from, p.tilt + swing], [settled, p.tilt, "outExpo"]] : [[from, p.tilt]],
      o: opacity(from),
    };
    const cell: SpeechCell = {
      at: p.word, text: p.text, face: p.face, size: p.size * u, spacing: p.spacing, x: X(p.cx), baseline: Y(p.baseline),
      width: p.w * u, inkTop: p.inkTop * u, inkBottom: p.inkBottom * u,
    };
    const base = { origin: { dx: 0, dy: p.c * u } };
    if (p.kind === "caps") {
      const face: TextPiece = {
        ...ctx.face(cell, from, p.pill ? paper : ink, track),
        id: wid, ...base,
        ...(p.pill ? {} : { stroke: { widthPx: CAPS_STROKE * u, colour: paper } }),
      };
      if (p.pill) {
        const pw = (p.w + 2 * PILL_PX) * u;
        const ph = (p.inkBottom - p.inkTop + 2 * PILL_PY) * u;
        const plate: ShapePiece = {
          ...ctx.shape("pill", from, roundedRectPath(-pw / 2, -ph / 2, pw, ph, ph / 2), { ...track, x: [[from, px]], y: track.y }, ink),
          id: `${wid}pill`, z: 5,
        };
        pieces.push(plate);
      }
      pieces.push(face);
      continue;
    }
    // The script: soft group shadow, two hard offset copies, the white outline, the ink fill.
    const outline = OUTLINE_EM * p.size * u;
    const depth = DEPTH_EM * p.size * u;
    const face: TextPiece = {
      ...ctx.face(cell, from, ink, track),
      id: wid, ...base,
      stroke: { widthPx: outline, colour: paper },
      shadows: [
        { dx: 0, dy: 8 * u, blur: 5 * u, colour: GLOW, alpha: 0.22 },
        { dx: depth * 0.5, dy: depth * 0.5, blur: 0, colour: ink, alpha: 1 },
        { dx: depth, dy: depth, blur: 0, colour: ink, alpha: 1 },
      ],
    };
    pieces.push(face);
    if (p.kind === "hero" && p.part === 0 && heroItems[0] === p) heroFrom = from;

    // The highlight wipe: a pastel copy of the script sweeps across the finished word, then is gone. It is anchored to the
    // first painted frame (not the raw timestamp, which is partway through that frame) and planned on the export grid: the
    // band already covers a third of the word on the first frame and at least two frames show 18 % or more of it. A wipe
    // that cannot do that inside the 110 ms cap is left out (the sticker is complete without it). The pastel copy carries a
    // thin ink keyline, so a light highlight never merges with the white outline.
    const left = px - (p.w / 2 + OUTLINE_EM * p.size) * u;
    const right = px + (p.w / 2 + (OUTLINE_EM + DEPTH_EM) * p.size) * u;
    const band = 0.5 * (right - left);
    const tall = (p.inkBottom - p.inkTop + 60) * u;
    const t0 = exportFrameAtOrAfter(from, fps);
    const sweepAt = (end: number): TextPiece => {
      const head0 = 0.32 * (right - left);
      const clip = rtl
        ? { x1: [[t0, right - head0], [end, left - band, "out" as const]] as Frames, x2: [[t0, right - head0 + band], [end, left, "out" as const]] as Frames }
        : { x1: [[t0, left + head0 - band], [end, right, "out" as const]] as Frames, x2: [[t0, left + head0], [end, right + band, "out" as const]] as Frames };
      return {
        ...face, id: `${wid}sweep`, z: 7, fromMs: t0, toMs: end, fill: pastelNow, stroke: { widthPx: 0.025 * p.size * u, colour: ink }, shadows: undefined,
        track: { ...track, o: [[t0, 1]] },
        clip: { ...clip, y1: [[t0, py - tall]], y2: [[t0, py + tall]] },
      } as TextPiece;
    };
    const wipe = clamp(Math.round((word.endMs - word.startMs) * 0.6), 66, 110);
    if (motion) {
      const whole = pieceBounds({ ...sweepAt(t0 + 110), clip: undefined }, t0, ctx.input.measure);
      for (const length of [...new Set([wipe, 100, 110])].sort((a, b) => a - b)) {
        const end = Math.min(t0 + length, hold);
        if (end <= t0) continue;
        const sweep = sweepAt(end);
        const shown = exportFrameTimes(t0, end, fps).filter((t) => {
          const box = pieceBounds(sweep, t, ctx.input.measure);
          return box !== null && whole !== null && box.x2 - box.x1 >= 0.18 * (whole.x2 - whole.x1);
        });
        if (shown.length >= 2) {
          pieces.push(sweep);
          break;
        }
      }
    }
  }

  // ---- Accents, in free space. ----
  // Each word's box is the one it covers during its entrance, not only at rest: tilted 7 degrees either side of its rest
  // angle, at the pop's peak scale, and 14 px low (the rise), all about its pivot.
  const swept = (p: Placed): Box => {
    const peak = p.kind === "caps" ? 1.06 : 1.04;
    const pivotY = p.baseline + p.c;
    let local: Box;
    if (p.kind === "caps") {
      local = p.box;
    } else {
      const o = OUTLINE_EM * p.size;
      const d = DEPTH_EM * p.size;
      local = { x1: p.cx - p.w / 2 - o, x2: p.cx + p.w / 2 + o + d, y1: p.baseline + p.inkTop - o, y2: p.baseline + p.inkBottom + o + d };
    }
    const boxes = (p.kind === "caps" ? [0] : [p.tilt - 7, p.tilt, p.tilt + 7]).map((degrees): Box => {
      const corners = [[local.x1, local.y1], [local.x2, local.y1], [local.x2, local.y2], [local.x1, local.y2]].map(([x, y]) => {
        const [rx, ry] = rotate((x! - p.cx) * peak, (y! - pivotY) * peak, degrees);
        return [p.cx + rx, pivotY + ry] as const;
      });
      return {
        x1: Math.min(...corners.map((c) => c[0])), x2: Math.max(...corners.map((c) => c[0])),
        y1: Math.min(...corners.map((c) => c[1])), y2: Math.max(...corners.map((c) => c[1])) + 14,
      };
    });
    return union([p.box, ...boxes]);
  };
  const wordBoxes = placed.map(swept);
  const taken: Box[] = [];
  const free = (box: Box) =>
    box.x1 >= area.x1 && box.x2 <= area.x2 && box.y1 >= area.y1 && box.y2 <= area.y2 &&
    !wordBoxes.some((word) => overlaps(box, inflate(word, CLEAR))) && !taken.some((other) => overlaps(box, inflate(other, 6)));
  /** The first free spot for a w x h box centred on one of the points, each tried again pushed outward along (dx, dy). */
  const claim = (w: number, h: number, points: readonly (readonly [number, number, number, number])[]): { x: number; y: number } | null => {
    for (const [cx, cy, dx, dy] of points) {
      for (let k = 0; k < 6; k++) {
        const x = cx + dx * k * 8;
        const y = cy + dy * k * 8;
        const box = { x1: x - w / 2, y1: y - h / 2, x2: x + w / 2, y2: y + h / 2 };
        if (free(box)) {
          taken.push(box);
          return { x, y };
        }
      }
    }
    return null;
  };
  const anchorBox = heroed ? union(heroItems.map((p) => p.box)) : union(placed.filter((p) => p.baseline === placed[0]!.baseline).map((p) => p.box));
  const anchorH = anchorBox.y2 - anchorBox.y1;
  const beat = heroed ? heroFrom : cue.words[0]!.startMs;
  const settle = (t: number) => Math.max(cueFrom, t);
  const lastStart = cue.words.at(-1)!.startMs;
  // Which edge the pastel shape takes (the sample's `side`, mirrored for right-to-left cues).
  const lean = (flip ? -1 : 1) * side;
  const stamp = (id: string, at: number, path: PathCmd[], x: number, y: number, track: Track, fill?: string): ShapePiece => {
    // Paths are drawn in sample px; a piece's path is in canvas px, so they scale with the cue (as the text does).
    const scaled = path.map((cmd): PathCmd => (cmd[0] === "Z" ? cmd : cmd[0] === "C" ? ["C", cmd[1] * u, cmd[2] * u, cmd[3] * u, cmd[4] * u, cmd[5] * u, cmd[6] * u] : [cmd[0], cmd[1] * u, cmd[2] * u]));
    const shape = ctx.shape(id, at, scaled, { x: [[at, X(x)]], y: [[at, Y(y)]], o: opacity(at), ...track }, fill);
    return shape;
  };
  type Point = readonly [number, number, number, number];
  const blockBox = union(placed.map((p) => p.box));
  /** Spots all round the block, outside it, as a last resort when the usual places are taken. */
  const ring = (w: number, h: number): Point[] => {
    const g = CLEAR + 4;
    const mx = (blockBox.x1 + blockBox.x2) / 2;
    const my = (blockBox.y1 + blockBox.y2) / 2;
    return [
      [blockBox.x1 - w / 2 - g, blockBox.y1 + h / 2, -1, -0.2], [blockBox.x2 + w / 2 + g, blockBox.y1 + h / 2, 1, -0.2],
      [blockBox.x1 - w / 2 - g, blockBox.y2 - h / 2, -1, 0.2], [blockBox.x2 + w / 2 + g, blockBox.y2 - h / 2, 1, 0.2],
      [mx, blockBox.y1 - h / 2 - g, 0.4, -1], [mx, blockBox.y2 + h / 2 + g, 0.4, 1],
      [blockBox.x1 - w / 2 - g, my, -1, 0], [blockBox.x2 + w / 2 + g, my, 1, 0],
    ];
  };
  /** The largest of three sizes that finds a free spot (the usual places first, then all round the block). */
  const claimFit = (make: (k: number) => { w: number; h: number; points: readonly Point[] }): { k: number; spot: { x: number; y: number } } | null => {
    for (const k of [1, 0.8, 0.65]) {
      const spec = make(k);
      const spot = claim(spec.w, spec.h, [...spec.points, ...ring(spec.w, spec.h)]);
      if (spot) return { k, spot };
    }
    return null;
  };
  /** The first start at or after the beat that still leaves two painted frames before the exit, else null (no room for the accent). */
  const slot = (desired: number): number | null => {
    for (const t of [desired, beat + 60, beat + 30, beat]) {
      const at = settle(t);
      if (paintedFrameCount(at, hold, fps) >= 2) return at;
    }
    return null;
  };
  /** A grow-in on the frames there are (bounce from four painted frames, monotone from two, else the rest pose). */
  const ramp = (at: number, dur: number, start: number, peak = 1): Frames => {
    const run = Math.max(1, Math.min(dur, hold - at - 1));
    return pop(at, at + run, start, peak);
  };

  // 1. The pastel disc or flower, behind the words (as in the sample).
  {
    const R = heroed ? clamp(0.36 * anchorH, 52, 100) : clamp(0.62 * anchorH, 52, 78);
    const edgeX = lean > 0 ? anchorBox.x1 : anchorBox.x2;
    let bx = edgeX - lean * R * 0.15;
    let by = anchorBox.y1 + 0.62 * anchorH;
    bx = clamp(bx, area.x1 + R, Math.max(area.x1 + R, area.x2 - R));
    by = clamp(by, area.y1 + R, Math.max(area.y1 + R, area.y2 - R));
    const at = slot(beat - 50);
    if (at !== null && area.x2 - area.x1 >= 2 * R && area.y2 - area.y1 >= 2 * R) {
      const flower = count % 2 === 1;
      const path: PathCmd[] = flower
        ? [...Array.from({ length: 6 }, (_, k) => ellipsePath(Math.cos((k * Math.PI) / 3) * 0.62 * R, Math.sin((k * Math.PI) / 3) * 0.62 * R, 0.46 * R)).flat(), ...ellipsePath(0, 0, 0.62 * R)]
        : ellipsePath(0, 0, R);
      const popMs = Math.max(1, Math.min(160, hold - at - 1));
      const turn: Frames = paintedFrameCount(at, at + popMs, fps) >= 3 ? [[at, -20], [at + popMs, 0, "out"]] : [[at, 0]];
      const grow = ramp(at, 160, 0.4, 1.08);
      const blob = stamp("blob", at, path, bx, by, { rz: turn, sx: grow, sy: grow }, pastelNow);
      pieces.push({ ...blob, z: 1 });
    }
  }

  // 2. The sunburst (even cues) or the swirl (odd cues), on the far side from the disc, outside the key word's box.
  {
    const at = slot(beat + 60);
    const edgeX = lean > 0 ? anchorBox.x2 : anchorBox.x1;
    const away = lean > 0 ? 1 : -1;
    // The sunburst needs the most room; a cue with none takes the swirl instead, so the beat still comes back.
    let burst = false;
    if (at !== null && !flip && heroed) {
      const angles = (away > 0 ? [28, 58, 88] : [152, 122, 92]).map((deg) => (deg * Math.PI) / 180);
      const lens = [70, 92, 66];
      const fit = claimFit((k) => {
        const path: PathCmd[] = angles.flatMap((a, i) => [
          ["M", Math.cos(a) * 30 * k, -Math.sin(a) * 30 * k] as const,
          ["L", Math.cos(a) * (30 + lens[i]!) * k, -Math.sin(a) * (30 + lens[i]!) * k] as const,
        ]);
        const bb = pathBounds(path);
        const w = bb.x2 - bb.x1 + 30 * k;
        const h = bb.y2 - bb.y1 + 30 * k;
        return {
          w, h, path, mid: { x: (bb.x1 + bb.x2) / 2, y: (bb.y1 + bb.y2) / 2 },
          points: [
            [edgeX + away * (w / 2 + 6), anchorBox.y1 + h / 2 - 4, away * 0.7, -0.7],
            [anchorBox.x1 + (anchorBox.x2 - anchorBox.x1) * 0.5, anchorBox.y1 - h / 2 - 4, away, -0.4],
          ] as Point[],
        };
      });
      if (fit) {
        burst = true;
        const k = fit.k;
        const path: PathCmd[] = angles.flatMap((a, i) => [
          ["M", Math.cos(a) * 30 * k, -Math.sin(a) * 30 * k] as const,
          ["L", Math.cos(a) * (30 + lens[i]!) * k, -Math.sin(a) * (30 + lens[i]!) * k] as const,
        ]);
        // Centred on its own box, so the grow-in shrinks toward the middle of the claimed spot, never toward the key word.
        const bb = pathBounds(path);
        const mx = (bb.x1 + bb.x2) / 2;
        const my = (bb.y1 + bb.y2) / 2;
        const centred = path.map((cmd): PathCmd => (cmd[0] === "M" || cmd[0] === "L" ? [cmd[0], cmd[1] - mx, cmd[2] - my] : cmd));
        const grow = ramp(at, 240, 0.35);
        const rays = stamp("rays", at, centred, fit.spot.x, fit.spot.y, { sx: grow, sy: grow }, undefined);
        pieces.push({ ...rays, z: 7, stroke: { widthPx: 15 * k * u, colour: ink } });
      }
    }
    if (at !== null && !burst) {
      const hot = (count >> 1) % 2 === 0 ? VIOLET : HOT;
      const fit = claimFit((k) => {
        const size = 2 * 29 * k + 12 * k;
        return {
          w: size, h: size,
          points: (heroed
            ? [
              [anchorBox.x1 + (lean > 0 ? (anchorBox.x2 - anchorBox.x1) * 0.2 : (anchorBox.x2 - anchorBox.x1) * 0.8), anchorBox.y1 - size / 2 - 2, away, -0.5],
              [edgeX + away * (size / 2 + 6), anchorBox.y1 + 0.2 * anchorH, away, -0.3],
            ]
            : [[edgeX + away * (size / 2 + 6), anchorBox.y1 + 0.3 * anchorH, away, -0.3], [anchorBox.x1 + 0.5 * (anchorBox.x2 - anchorBox.x1), anchorBox.y1 - size / 2 - 2, away, -0.5]]) as Point[],
        };
      });
      if (fit) {
        const run = Math.max(1, Math.min(300, hold - at - 1));
        const turn: Frames = paintedFrameCount(at, at + run, fps) >= 3 ? [[at, 160 * away], [at + run, 0, "out"]] : [[at, 0]];
        const grow = ramp(at, 300, 0.4, 1.1);
        const swirl = stamp("swirl", at, spiralPath(29 * fit.k, 2.25), fit.spot.x, fit.spot.y, { rz: turn, sx: grow, sy: grow }, undefined);
        pieces.push({ ...swirl, z: 7, stroke: { widthPx: 6 * fit.k * u, colour: hot } });
      }
    }
  }

  // 3. Two four-point sparkles that pop, then twinkle (the first time soon after they land, again every 1.1 s of a long hold).
  {
    const sparks = [
      { r: 22, fill: paper, line: ink, at: slot((heroed ? beat : lastStart) + 100), spin: 14 },
      { r: 15, fill: ink, line: paper, at: slot((heroed ? beat : lastStart) + 160), spin: -10 },
    ];
    const rowEnd = placed.at(-1)!;
    const around = heroed ? anchorBox : union(placed.map((p) => p.box));
    const spots: Point[][] = [
      [
        [lean > 0 ? around.x2 + 30 : around.x1 - 30, around.y1 + 0.7 * (around.y2 - around.y1), lean, 0.2],
        [lean > 0 ? around.x1 - 30 : around.x2 + 30, around.y1 + 0.7 * (around.y2 - around.y1), -lean, 0.2],
        [rowEnd.box.x2 + 24, rowEnd.box.y1, 1, -0.4],
      ],
      [
        [lean > 0 ? around.x1 - 30 : around.x2 + 30, around.y1 + 0.1 * (around.y2 - around.y1), -lean, -0.3],
        [(around.x1 + around.x2) / 2, around.y2 + 24, 0.5, 0.5],
        [(around.x1 + around.x2) / 2, around.y1 - 24, 0.5, -0.5],
      ],
    ];
    sparks.forEach((spark, k) => {
      if (spark.at === null) return;
      const at = spark.at;
      const fit = claimFit((scale) => {
        const r = Math.max(15, spark.r * scale);
        return { w: r * 2 + 8, h: r * 2 + 8, points: spots[k]!, r };
      });
      if (!fit) return;
      const r = Math.max(15, spark.r * fit.k);
      const run = Math.max(1, Math.min(200, hold - at - 1));
      const entry = paintedFrameCount(at, at + run, fps);
      const scale: [number, number, ("out" | "inOut" | "spring")?][] = entry < 2 ? [[at, 1]] : entry >= 4 ? [[at, 0.3], [at + run, 1, "spring"]] : [[at, 0.5], [at + run, 1, "out"]];
      // The first twinkle comes soon after the sparkle lands: a full one (260 ms) when the hold has room, a compact one
      // (133 ms, three frames at 24 fps and up) when it has less; long holds twinkle again every 1.1 s.
      const settled = at + run + 60 + k * 100;
      const room = hold - 40 - settled;
      if (room >= 300) {
        for (let t = settled, burst = 0; burst < 3 && t + 260 < hold - 40; burst++, t += 1100) scale.push([t, 1], [t + 110, 1.18, "out"], [t + 260, 1, "inOut"]);
      } else if (room >= 140 && entry >= 2) scale.push([settled, 1], [settled + 66, 1.15, "out"], [settled + 133, 1, "inOut"]);
      const turn: Frames = entry >= 3 ? [[at, spark.spin], [at + run, -0.4 * spark.spin, "out"]] : [[at, 0]];
      const piece = stamp(`spark${k}`, at, sparkle(r), fit.spot.x, fit.spot.y, { rz: turn, sx: scale, sy: scale }, spark.fill);
      pieces.push({ ...piece, z: 7, stroke: { widthPx: 3 * u, colour: spark.line } });
    });
  }

  // 4. A trail of three tiny pastel dots with an ink keyline: popping one after another when there is room, else all at once.
  {
    const at = slot((heroed ? beat : lastStart) + 220);
    const radii = [8, 6, 4.5] as const;
    const fit = at === null ? null : claimFit((k) => {
      const w = 66 * k + 6;
      const h = 30 * k + 6;
      return {
        w, h,
        points: [
          [lean > 0 ? anchorBox.x1 - w / 2 - 10 : anchorBox.x2 + w / 2 + 10, anchorBox.y2 - 0.25 * anchorH, -lean, 0.3],
          [(anchorBox.x1 + anchorBox.x2) / 2 - lean * 0.2 * (anchorBox.x2 - anchorBox.x1), anchorBox.y2 + h / 2 + 4, lean, 0.4],
          [lean > 0 ? anchorBox.x2 + w / 2 + 10 : anchorBox.x1 - w / 2 - 10, anchorBox.y2 - 0.1 * anchorH, lean, 0.3],
        ] as Point[],
      };
    });
    if (fit && at !== null) {
      const k = fit.k;
      const centres = radii.map((r, i) => [(i - 1) * 22 * k, -(i - 1) * 7 * k, r * k] as const);
      // Staggered (60 ms apart) when a second dot still has three frames left; otherwise one static trail.
      const staggered = paintedFrameCount(at + 120, hold, fps) >= 3;
      if (staggered) {
        centres.forEach(([dx, dy, r], i) => {
          const start = at + i * 60;
          if (paintedFrameCount(start, hold, fps) < 2) return;
          const grow = ramp(start, 140, 0.3, 1.15);
          const dot = stamp(i === 0 ? "dots" : `dots${i}`, start, ellipsePath(0, 0, r), fit.spot.x + dx, fit.spot.y + dy, { sx: grow, sy: grow }, pastelNow);
          pieces.push({ ...dot, z: 7, stroke: { widthPx: 2.5 * k * u, colour: ink } });
        });
      } else {
        const trail = stamp("dots", at, centres.flatMap(([dx, dy, r]) => ellipsePath(dx, dy, r)), fit.spot.x, fit.spot.y, {}, pastelNow);
        pieces.push({ ...trail, z: 7, stroke: { widthPx: 2.5 * k * u, colour: ink } });
      }
    }
  }
  return pieces;
}, undefined, 0);

import { CAPTION_SCENE_BRAND_MIN_CONTRAST, captionColourContrast } from "@narriflow/validators";
import type { DemoScript } from "../demo";
import { clamp, type Ease, type Frames, kf } from "../ease";
import { exportFrameAtOrAfter, paintedFrameCount } from "../frame-grid";
import type { SceneCue } from "../input";
import { balancedRows, rowVisualOrder } from "../layout";
import type { Box, PathCmd, Piece, ShapePiece, TextPiece, Track } from "../scene";
import { ellipsePath, sparklePath } from "../shapes";
import { caps, galleryScene, rotatePoint } from "./gallery-layout";

/**
 * Toon (`samples/templates/m85-toon.js`, after Motion Array "Clean Toon Type"): heavy slanted Bangers caps with a
 * two-tone face (mint over cyan-blue), a fat navy outline with a hard navy drop and a thin lighter indigo rim outside it.
 * Every word pops in with a short vertical squash and a swing. Short function words sit small and tilted between the
 * bigger words. The key word is bigger, on its own row, and a broken swoosh (a wide tapered lilac crest, a white sweep
 * and a gold edge, with open gaps) wipes in behind it and holds, with a pink ball peeking from behind its top. Cues leave
 * by squashing flat vertically (never wider than they settled).
 *
 * Changes from the sample, and why:
 * - **Split face without an engine change.** The sample clipped the mint copy with a slanted CSS polygon. Here the
 *   readable face (`w…`) is the whole word in the lower colour with the navy outline and drop; a mint copy of the same
 *   word sits on it under an inverse rectangular clip that removes everything below a level seam at half the word's own
 *   measured ink. The word's pivot is on the seam, so the pop's squash and swing turn about the seam and the clip only
 *   follows the pivot's rise (the same frames). Body words tilt 1-2 degrees and the key word 2.5, so the level seam
 *   crosses the letters a little off level, like the sample's slanted one.
 * - **Rows from the words.** The sample's " / " rows and cue-indexed tilts are gone. Each key word has a row of its own
 *   (the sample's hero rows also held small words; on real cues they stood alone on the row before the key word was
 *   spoken, Sol's round 2 finding, so they join the row before instead). Other words wrap into balanced rows of at most
 *   800 sample px, shrinking up to 28% to pack into two rows before stacking more (the sample fitted each row). Row pitch
 *   comes from each row's measured ink plus the rim and drop, and a key word's row also reserves the ribbon's measured
 *   crest and lower strokes and the ball, so the rows above and below keep a visible gap from the ribbon.
 * - **Fit by repacking, floors kept.** A cue taller than the band is laid out again at smaller sizes (down to half),
 *   never under the floors (140 px key word, 96 px others, 64 px small words), so its rows get wider rather than its
 *   letters thinner. A word wider than its column shrinks to its floor, then breaks between whole graphemes across the
 *   full lane width into the fewest even rows (Latin, Cyrillic, Greek and CJK; a joined script takes the lane, then
 *   shrinks). A token that still does not fit the band at its floor (90 Han characters) pages through it: groups of rows
 *   follow one another within the word's time, at the floor. A cue never draws more than 150 pieces (shadows counted):
 *   past that, decorations go first, then the rims, then the upper colour; the faces always stay.
 * - **Small words by rule, not by an English list.** A word is drawn small (0.46 em of its row, never under 64 sample
 *   px) and tilted 4 degrees when the emphasis scorer marks it minor and it is at most four graphemes long, in any
 *   script. A joined-script word (Arabic, Devanagari, Thai …) qualifies only when its measured ink is at least as wide
 *   and tall as a short Latin word's (Urdu "یہ" and Hindi "तो" keep the normal size), and joined words keep extra space
 *   between outlines. A row made only of small words draws them at 0.7 of the row size, so no cue is all tiny.
 * - **Real speech timing.** A word's pop (squash, swing, rise, quick fade-in) happens in the time before it is spoken:
 *   up to 220 ms (300 ms for the key word), from the previous word's onset, and for a cue's first word within the
 *   cue's 100 ms lead. On its first spoken frame the word is whole, opaque and settled in its slot; with fewer than two
 *   frames of lead it simply appears there. A wide row swings less (its ends lift at most a quarter em) and overscales
 *   only into the room it has. Rows keep room for the spring's overshoot, the rest of the rise and the swing, so an
 *   entering word never touches a neighbour or another row; the exit levels each word's tilt as it flattens, for the
 *   same reason. The ribbon wipes and the ball compress into the time before the exit (the ball lands before it), and a
 *   wipe with fewer than two painted frames shows its section whole. The exit squash runs only after the last word has
 *   read for 150 ms and when it gets two painted frames; otherwise the cue cuts at the next one.
 * - **Ribbon and ball** are the sample's six fixed polygons and two circles, behind every letter and every rim, fitted
 *   to the lane; right-to-left cues mirror the ribbon and wipe it from the right. A wipe clip opens fully once its wipe
 *   is done, so the exit squash never cuts a section. The ball's lower edge tucks behind the key word's outline, so it
 *   peeks out of the word.
 * - **Copies.** Three per word: the indigo rim (no drop copy of its own: the sample's rim drop was a second wide-bordered
 *   copy on every frame and the budget's largest cost), the face with its navy outline and hard navy drop, and the
 *   upper colour. The upper colour is whole to the bounds (its clip is inverse), so it is named as a part of its word
 *   (`w<n>l1000`). On a cue that paints a single frame, the rim, ribbon and ball are named as parts too (`l2000…`,
 *   `l3000…`) and drawn in their settled pose: the shared one-frame filter keeps parts of words, so a one-frame key
 *   word keeps its whole look on that frame and clears with it.
 * - **Extra recurring beats** in the reference's comic language: on every cue three tapered gold pop lines (white on
 *   alternate cues) burst out of a free corner of the key word as it lands (of the last word on a cue without one), and
 *   a gold sparkle with a navy edge pops beside a free end of a row (first row, then last, then the others; a top
 *   corner, else a lower one), twinkling (a quarter turn and a dip) every second while the cue holds; where none has
 *   room, a smaller still sparkle takes the first free pocket. Both touch no word, ribbon or ball, inside the lane.
 * - **Every language.** Whole words only, so joined scripts are never split. Text is composed (NFC) before it is
 *   measured, broken or hashed, so decomposed accents and Hangul jamo lay out like their composed forms. Upper case only
 *   for cased scripts; letter spacing only for Latin, Cyrillic and Greek. Bangers draws Latin only: other scripts use the
 *   fallback face at the same size (its letters stand about as tall as Bangers caps), with seam, outline, rows and
 *   ribbon taken from their measured ink. Right-to-left rows read right to left and the forward slant mirrors.
 * - **Brand colours.** The upper face takes the primary colour, the lower face the accent colour (the brand
 *   template's secondary), the ribbon body the highlight colour; each is checked at 3:1 against the navy outline it
 *   is drawn with and falls back to the default.
 */

export const TOON_DEMO: DemoScript = {
  lines: [
    "stop:b waiting:b for:m a:m perfect:h@560 moment:b",
    "just:b start:h@520",
    "nobody:b is:m watching:b you:b that:m closely:b",
    "consistency:h@720 wins:b",
    "it:m only:b takes a:m spark:h@520",
  ],
  options: { rate: 200, gap: 30, cueGap: 330, tail: 420, lead: 260 },
};

const FACE = "Bangers" as const;
const ANCHOR = 1290;
/** Sample px: the key word, words of a cue with a key word, words of a cue without one. */
const HERO = 250;
const BODY = 140;
const SOLO = 176;
const SMALL_EM = 0.46;
const SMALL_FLOOR = 64;
/** A row made only of small words draws them at this share of the row size. */
const SMALL_ALONE = 0.7;
/** A run of words may shrink this far to pack into fewer rows. */
const PACK_SCALES = [1, 0.9, 0.8, 0.72] as const;
const BODY_FLOOR = 96;
const HERO_FLOOR = 140;
/** Widest row and widest key word, sample px (the key word leaves room for the ribbon on both sides). */
const COLUMN = 800;
const HERO_COLUMN = 700;
const SLANT = -8;
const LS = 0.02;
/** Navy outline, the rim outside it (both from the glyph contour), and the hard drop, em. */
const OUTLINE = 0.07;
const RIM = 0.105;
const DROP_X = 0.045;
const DROP_Y = 0.06;
/** Space each side of a word, em of that word; clear gap between rows' painted edges, em of the larger row. */
const GAP_EM = 0.13;
const ROW_GAP = 0.12;
/** The pop's spring overshoots the rest height by up to this share about the seam; rows keep room for it. */
const POP_ROOM = 0.1;
/** The share of the rise still left when the spring peaks (the rise lands on \`outExpo\`); rows keep room for it below. */
const RISE_LEFT = 0.15;
/** The pop's swing lifts a word's ends at most this far, em. */
const SWING_LIFT = 0.25;
/** The seam sits this far down the word's measured ink. */
const SEAM = 0.5;
/** A cue opens at most this long before its first word: its first word's pop happens in it. */
const LEAD = 100;
/** Sizes tried, as shares of the sample's, before a cue that does not fit pages or shrinks (floors hold throughout). */
const FIT_SCALES = [0.9, 0.8, 0.7, 0.6, 0.5] as const;
/** Pieces one cue may draw, shadow copies counted (the scene budget is 150). */
const PIECE_CAP = 148;
/** Part numbers of a word's other copies, named as parts so the shared one-frame filter keeps them with the face. */
const UPPER_PART = 1000;
const RIM_PART = 2000;
const RIBBON_PART = 3000;
/** How far the ball's centre sits above the key word's ink top, em: its lower edge tucks behind the outline. */
const BALL_LIFT = 0.16;
/** The sparkle's size where the full one has no room (drawn still). */
const SPARKLE_SMALL = 0.6;
const EXIT_SQUASH = 0.08;
/** The caption band of the sample (y 860..1650 of 1920), above and below the anchor line. */
const BAND_ABOVE = ANCHOR - 860;
const BAND_BELOW = 1650 - ANCHOR;

const NAVY = "#1A1250";
const RIM_COLOUR = "#6B5FE0";
const RIBBON_WHITE = "#FFFFFF";
const GOLD = "#FFC93C";
const BALL = "#FF5FA2";
const BALL_HI = "#FF9CC6";
const DEFAULT = { primary: "#4DF5B8", highlight: "#C99BFF", accent: "#1FA3F2" } as const;

/** Scripts whose letters join or stack (a short word in them reads small only when its measured ink allows). */
const JOINED = /[\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Hebrew}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Gurmukhi}\p{Script=Gujarati}\p{Script=Oriya}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Sinhala}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Tibetan}]/u;
/** A short joined-script word is drawn small only when its ink is at least this wide and tall, at 100 px (a short Latin word's). */
const JOINED_SMALL = { advance: 90, ink: 85 } as const;
/** Extra clear space each side of a joined-script word, em: its strokes overhang the advance. */
const JOINED_GAP = 0.06;
const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemes = (text: string) => [...SEGMENTER.segment(text)].map((part) => part.segment);
/** The part number of a piece named as a part of a word (`w3l1000`), or -1. */
const partOf = (piece: { readonly id: string }) => Number(/:w\d+l(\d+)$/.exec(piece.id)?.[1] ?? -1);

/** Scripts that take letter spacing (never a joined script). */
const SPACED = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Common}\p{Script=Inherited}]+$/u;
/** Words that may break between glyph clusters when one is wider than the column (CJK has no spaces to break at). */
const SPLITTABLE = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{M}\p{N}\p{P}\p{S}ー]+$/u;

const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

const textHash = (text: string) => {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619);
  return (h >>> 0) / 4294967296;
};

/** Per cue index: its place among all cues, and how many cues with a key word came before it (the variant counters). */
const ORDINALS = new WeakMap<readonly SceneCue[], Map<number, { n: number; hero: number }>>();
function ordinalOf(cues: readonly SceneCue[], index: number) {
  let map = ORDINALS.get(cues);
  if (!map) {
    map = new Map();
    let heroes = 0;
    for (const [n, cue] of cues.entries()) {
      map.set(cue.index, { n, hero: heroes });
      if (cue.words.some((word) => word.role === "hero")) heroes++;
    }
    ORDINALS.set(cues, map);
  }
  return map.get(index) ?? { n: index, hero: index };
}

/** Width profile with an early peak and a long tail: a brush-stroke belly, not a symmetric lens (the sample's). */
const belly = (u: number, peak: number, k = 0.8) => (u < peak ? (u / peak) ** k : ((1 - u) / (1 - peak)) ** (k * 1.4));

export interface ToonRibbonSection {
  readonly fill: "highlight" | "white" | "gold";
  /** Wipe direction: along x (from the reading start) or down. */
  readonly dir: "x" | "y";
  readonly t0: number;
  readonly span: number;
  /** Outline points relative to the ribbon's centre, px. */
  readonly points: readonly (readonly [number, number])[];
}

/**
 * The sample's broken swoosh around a key word of font size `fs`: six tapered sections on a tilted ellipse (radii `rx`,
 * `ry`), relative to its centre. `mirror` flips it for right-to-left cues.
 */
export function toonRibbon(fs: number, rx: number, ry: number, mirror: boolean): ToonRibbonSection[] {
  const W = fs * 0.34;
  const rot = mirror ? 7 : -7;
  const lilacA = { a0: 198, a1: 338, w: (u: number) => W * belly(u, 0.32), o: (u: number) => W * 0.1 * Math.sin(Math.PI * u) };
  const sections: { fill: ToonRibbonSection["fill"]; dir: "x" | "y"; t0: number; span: number; a0: number; a1: number; w: (u: number) => number; o: (u: number) => number }[] = [
    { fill: "highlight", dir: "x", t0: 0, span: 330, ...lilacA },
    { fill: "white", dir: "x", t0: 60, span: 280, a0: 206, a1: 304, w: (u) => W * 0.3 * belly(u, 0.4), o: (u) => -W * 0.17 * Math.sin(Math.PI * u) },
    {
      fill: "gold",
      dir: "x",
      t0: 90,
      span: 260,
      a0: 232,
      a1: 322,
      w: (u) => fs * 0.034 * belly(u, 0.5, 0.6),
      // Rides the outer edge of the lilac crest and stops short of both of its ends.
      o: (u) => {
        const ua = (232 + 90 * u - lilacA.a0) / (lilacA.a1 - lilacA.a0);
        return lilacA.o(ua) + lilacA.w(ua) / 2 + fs * 0.022;
      },
    },
    { fill: "white", dir: "y", t0: 70, span: 300, a0: 98, a1: 172, w: (u) => W * 0.62 * belly(u, 0.5), o: () => 0 },
    { fill: "highlight", dir: "y", t0: 30, span: 300, a0: 16, a1: 80, w: (u) => W * 0.7 * belly(u, 0.45), o: (u) => W * 0.08 * Math.sin(Math.PI * u) },
    { fill: "gold", dir: "y", t0: 140, span: 220, a0: 110, a1: 160, w: (u) => fs * 0.028 * belly(u, 0.5, 0.6), o: (u) => -(W * 0.62 * belly(0.5 + (u - 0.5) * 0.7, 0.5)) / 2 - fs * 0.02 },
  ];
  const cr = Math.cos((rot * Math.PI) / 180);
  const sr = Math.sin((rot * Math.PI) / 180);
  return sections.map((sec) => {
    const n = 24;
    const out: [number, number][] = [];
    const inn: [number, number][] = [];
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      const th = ((sec.a0 + (sec.a1 - sec.a0) * u) * Math.PI) / 180;
      const w = sec.w(u) / 2;
      const o = sec.o(u);
      for (const [list, d] of [[out, o + w], [inn, o - w]] as const) {
        const px = (rx + d) * Math.cos(th) * (mirror ? -1 : 1);
        const py = (ry + d) * Math.sin(th);
        list.push([px * cr - py * sr, px * sr + py * cr]);
      }
    }
    return { fill: sec.fill, dir: sec.dir, t0: sec.t0, span: sec.span, points: [...out, ...inn.reverse()] };
  });
}

const polygon = (points: readonly (readonly [number, number])[]): PathCmd[] => [
  ["M", points[0]![0], points[0]![1]],
  ...points.slice(1).map(([x, y]) => ["L", x, y] as const),
  ["Z"],
];

const boundsOf = (points: readonly (readonly [number, number])[]): Box => ({
  x1: Math.min(...points.map((p) => p[0])),
  x2: Math.max(...points.map((p) => p[0])),
  y1: Math.min(...points.map((p) => p[1])),
  y2: Math.max(...points.map((p) => p[1])),
});

const union = (a: Box, b: Box): Box => ({ x1: Math.min(a.x1, b.x1), x2: Math.max(a.x2, b.x2), y1: Math.min(a.y1, b.y1), y2: Math.max(a.y2, b.y2) });
const meets = (a: Box, b: Box) => a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
const inside = (a: Box, b: Box) => a.x1 >= b.x1 && a.x2 <= b.x2 && a.y1 >= b.y1 && a.y2 <= b.y2;

interface Metrics {
  readonly advance: number;
  readonly inkTop: number;
  readonly inkBottom: number;
}

interface Item {
  readonly word: number;
  readonly part: number;
  readonly parts: number;
  readonly text: string;
  /** Sample px. */
  readonly size: number;
  readonly small: boolean;
  readonly ls: number;
  /** At 100 sample px. */
  readonly m: Metrics;
}

/** A placed word (or piece of one), block-local px: `x` is the middle of its advance; `seam` is its pivot's y. */
interface Cell extends Item {
  readonly line: number;
  readonly x: number;
  readonly baseline: number;
  readonly seam: number;
  readonly width: number;
  readonly px: number;
  readonly rest: number;
  /** Painted box at rest (ink, rim, drop, slant and tilt), block-local. */
  readonly box: Box;
}

export const toonProgram = galleryScene(
  "toon",
  ANCHOR,
  (ctx) => {
    const { cue, index: cueIndex, from: cueFrom, to, bounds } = ctx.window;
    const { exit, exitAt, fps, rtl, space } = ctx;
    const pieces: Piece[] = [];
    const words = cue.words;
    const keep = (colour: string, fallback: string) => (captionColourContrast(colour, NAVY) >= CAPTION_SCENE_BRAND_MIN_CONTRAST ? colour : fallback);
    const colours = {
      upper: keep(ctx.input.colours.primary, DEFAULT.primary),
      lower: keep(ctx.input.colours.accent, DEFAULT.accent),
      ribbon: keep(ctx.input.colours.highlight, DEFAULT.highlight),
    };
    const ord = ordinalOf(ctx.input.cues, cueIndex);
    const isHero = (at: number) => words[at]!.role === "hero";
    const heroAt = words.findIndex((word) => word.role === "hero");
    const heroed = heroAt >= 0;
    // Canonically equivalent input lays out the same: decomposed accents and Hangul jamo are composed first.
    const display = words.map((word) => caps(word, cue).normalize("NFC"));
    const textSeed = textHash(display.join(" "));
    const slant = rtl ? -SLANT : SLANT;
    const shear = Math.tan((slant * Math.PI) / 180);

    // Measure once at 100 sample px; every size is linear from it.
    const memo = new Map<string, Metrics>();
    const lsOf = (text: string) => (SPACED.test(text) ? LS : 0);
    const at100 = (text: string): Metrics => {
      let m = memo.get(text);
      if (!m) {
        const ls = lsOf(text);
        const r = ctx.input.measure(text, FACE, 100 * space.u, ls);
        m = { advance: r.advance / space.u, inkTop: r.inkTop / space.u, inkBottom: r.inkBottom / space.u };
        memo.set(text, m);
      }
      return m;
    };
    const widthOf = (text: string, size: number) => (at100(text).advance * size) / 100;

    /** Short minor words are drawn small; a joined-script word only when its measured ink stays as readable as a short Latin word's. */
    const isSmall = (at: number) => {
      const text = display[at]!;
      if (isHero(at) || words[at]!.role !== "minor" || words.length < 2 || graphemes(text).length > 4) return false;
      if (!JOINED.test(text)) return true;
      const m = at100(text);
      return m.advance >= JOINED_SMALL.advance && m.inkBottom - m.inkTop >= JOINED_SMALL.ink;
    };
    /** Clear space each side of a word; joined scripts overhang their advance, so they keep a little more. */
    const sideGap = (item: { readonly text: string; readonly size: number }) => (GAP_EM + (JOINED.test(item.text) ? JOINED_GAP : 0)) * item.size;

    // Columns, sample px: the sample's, or what the lane leaves (the key word keeps room for the ribbon each side). A word
    // that has to break uses the whole lane.
    const laneW = (bounds.x2 - bounds.x1) / space.u;
    const column = Math.min(COLUMN, laneW - 60);
    const heroColumn = Math.max(laneW * 0.55, Math.min(HERO_COLUMN, laneW - 230));
    const longRoom = Math.max(column, laneW - 60);

    /** The fewest pieces, cut between whole graphemes at even widths, that each fit `room` at `size`. */
    const split = (text: string, size: number, room: number): string[] => {
      const clusters = graphemes(text);
      const prefix: number[] = [];
      let joined = "";
      for (const cluster of clusters) {
        joined += cluster;
        prefix.push(widthOf(joined, size));
      }
      const full = prefix.at(-1)!;
      // The least count that can fit, then up from there (a long token tries few counts).
      const start = Math.max(2, Math.ceil(full / room));
      for (let k = start; k <= clusters.length; k++) {
        const cuts = [0];
        for (let j = 1; j < k; j++) {
          let best = cuts.at(-1)! + 1;
          let error = Number.POSITIVE_INFINITY;
          for (let c = cuts.at(-1)! + 1; c <= clusters.length - (k - j); c++) {
            const e = Math.abs(prefix[c - 1]! - (full * j) / k);
            if (e < error) {
              error = e;
              best = c;
            } else if (e > error) break;
          }
          cuts.push(best);
        }
        cuts.push(clusters.length);
        const parts = cuts.slice(1).map((end, j) => clusters.slice(cuts[j], end).join(""));
        if (parts.every((part) => widthOf(part, size) <= room)) return parts;
      }
      return clusters;
    };

    interface Line {
      readonly items: Item[];
      readonly hero: boolean;
    }
    const rowBase = heroed ? BODY : SOLO;

    /** The rows with every size at `f` of the sample's, never under its floor: a cue that does not fit repacks smaller, not thinner. */
    const planLines = (f: number): Line[] => {
      const sized = words.map((_, at) => {
        const text = display[at]!;
        const hero = isHero(at);
        const small = isSmall(at);
        const base = hero ? HERO : small ? Math.max(SMALL_FLOOR, SMALL_EM * rowBase) : rowBase;
        const floor = hero ? HERO_FLOOR : small ? SMALL_FLOOR : BODY_FLOOR;
        const want = Math.min(base, Math.max(floor, base * f));
        const room = hero ? heroColumn : column;
        const width = widthOf(text, want);
        if (width <= room) return { size: want, parts: [text], small };
        const fit = (want * room) / width;
        if (fit >= floor) return { size: fit, parts: [text], small };
        // A joined script never breaks: it takes the whole lane, then shrinks.
        if (!SPLITTABLE.test(text) || graphemes(text).length < 2) return { size: Math.min(want, (want * longRoom) / width), parts: [text], small };
        const parts = split(text, floor, longRoom);
        const widest = Math.max(...parts.map((part) => widthOf(part, 100)));
        return { size: Math.max(floor, Math.min(want, (100 * longRoom) / widest)), parts, small };
      });
      const lines: Line[] = [];
      let run: Item[] = [];
      const itemsOf = (at: number) => {
        const { size, parts, small } = sized[at]!;
        return parts.map((text, part) => ({ word: at, part, parts: parts.length, text, size, small, ls: lsOf(text), m: at100(text) }));
      };
      // A run packs into fewer rows at a slightly smaller size before it stacks more (the sample fitted each row to 800 px).
      const flush = () => {
        if (!run.length) return;
        const packs = PACK_SCALES.map((scale) => {
          const items = run.map((item) => ({ ...item, size: Math.max(item.small ? SMALL_FLOOR : BODY_FLOOR, item.size * scale) }));
          const widths = items.map((item) => widthOf(item.text, item.size));
          const gap = 2 * Math.max(...items.map(sideGap));
          return { items, rows: balancedRows(widths, gap, column) };
        });
        const fewest = Math.min(...packs.map((pack) => pack.rows.length));
        const target = Math.max(fewest, Math.min(2, packs[0]!.rows.length));
        const pack = packs.find((candidate) => candidate.rows.length <= target)!;
        for (const row of pack.rows) {
          let items = row.map((at) => pack.items[at]!);
          // Small words read small beside a bigger word; a row of nothing but small words takes a middle size instead.
          if (items.every((item) => item.small)) {
            const lifted = items.map((item) => ({ ...item, size: Math.max(item.size, SMALL_ALONE * rowBase * Math.max(f, BODY_FLOOR / rowBase)) }));
            const width = lifted.reduce((sum, item, i) => sum + widthOf(item.text, item.size) + (i ? sideGap(item) + sideGap(lifted[i - 1]!) : 0), 0);
            if (width <= column) items = lifted;
          }
          lines.push({ items, hero: false });
        }
        run = [];
      };
      for (const [at] of words.entries()) {
        const items = itemsOf(at);
        if (isHero(at)) {
          flush();
          for (const item of items) lines.push({ items: [item], hero: true });
        } else if (items.length > 1) {
          flush();
          for (const item of items) lines.push({ items: [item], hero: false });
        } else run.push(items[0]!);
      }
      flush();
      return lines;
    };

    // Natural size: the band at the user's position (a larger size shrinks to fit it), inside the lane.
    const natural = space.u / ctx.input.scale;
    const anchorY = space.y(ANCHOR);
    const band = { y1: Math.max(bounds.y1 + 3, anchorY - BAND_ABOVE * natural), y2: Math.min(bounds.y2 - 3, anchorY + BAND_BELOW * natural) };
    const laneHalf = (bounds.x2 - bounds.x1) / 2;

    /** How far a word rises into its slot as it pops, sample px. */
    const riseOf = (item: Item) => (isHero(item.word) ? 40 : 20);

    /** Rest tilt per word: small words lean 4 degrees, others 1-2, the key word 2.5; signs alternate by counter. */
    const restOf = (item: Item, order: number) => {
      if (isHero(item.word)) return (ord.hero % 2 ? 2.5 : -2.5) * (rtl ? -1 : 1);
      const sign = (ord.n + item.word + item.part) % 2 ? 1 : -1;
      return item.small ? 4 * sign : sign * (1.2 + 0.8 * hash(cueIndex * 13 + order * 3.7 + textSeed * 40));
    };

    /** The painted box of a word at rest around its pivot (ink + rim + drop, slanted and tilted). */
    const paintedBox = (width: number, px: number, top: number, bottom: number, seam: number, rest: number, x: number): Box => {
      const edge = RIM * px;
      const corners = [
        [-width / 2 - edge, top - edge],
        [width / 2 + edge + DROP_X * px, top - edge],
        [-width / 2 - edge, bottom + edge + DROP_Y * px],
        [width / 2 + edge + DROP_X * px, bottom + edge + DROP_Y * px],
      ] as const;
      // Slanted (as drawn) and unslanted (as the shared bounds measure it).
      const pts = corners.flatMap(([cx, cy]) => {
        const ly = cy - seam;
        return [rotatePoint(cx + shear * ly, ly, rest), rotatePoint(cx, ly, rest)].map(([rx, ry]) => [x + rx, seam + ry] as const);
      });
      return boundsOf(pts);
    };

    /** Rows laid out at `g` times their size (1 unless the cue still has to shrink), block-local px centred on the block. */
    const arrange = (lines: readonly Line[], g: number, withRibbon: boolean) => {
      const k = space.u * g;
      const metrics = lines.map((line) => {
        const visual = rtl ? rowVisualOrder(line.items.map((item) => item.text), "rtl") : line.items.map((_, i) => i);
        const ordered = visual.map((i) => line.items[i]!);
        let x = 0;
        const xs: number[] = [];
        ordered.forEach((item, i) => {
          if (i > 0) x += (sideGap(item) + sideGap(ordered[i - 1]!)) * k;
          const w = (item.m.advance * item.size * k) / 100;
          xs.push(x + w / 2);
          x += w;
        });
        // Each word's rest box, grown by the pop's spring overshoot about its seam.
        const boxes = ordered.map((item, i) => {
          const px = item.size * k;
          const top = (item.m.inkTop * px) / 100;
          const bottom = (Math.max(item.m.inkBottom, 0) * px) / 100;
          const seam = top + (bottom - top) * SEAM;
          const box = paintedBox((item.m.advance * px) / 100, px, top, bottom, seam, restOf(item, i), 0);
          return { ...box, y1: seam + (box.y1 - seam) * (1 + POP_ROOM), y2: seam + (box.y2 - seam) * (1 + POP_ROOM) + RISE_LEFT * riseOf(item) * k };
        });
        const above = Math.max(...boxes.map((box) => -box.y1));
        const below = Math.max(...boxes.map((box) => box.y2));
        return { ordered, xs, width: x, above, below, px: Math.max(...ordered.map((item) => item.size)) * k };
      });
      const gapAfter = (i: number) => ROW_GAP * Math.max(metrics[i]!.px, metrics[i + 1]!.px);

      // The ribbon around the first key word's rows, relative to the first of them (baseline 0).
      const ribbonLines = withRibbon && heroed ? lines.flatMap((line, i) => (line.hero && line.items[0]!.word === heroAt ? [i] : [])) : [];
      let ribbon: { sections: ToonRibbonSection[]; ball: { x: number; y: number; r: number }; box: Box; first: number; last: number } | null = null;
      if (ribbonLines.length) {
        const first = ribbonLines[0]!;
        const last = ribbonLines.at(-1)!;
        const rel: number[] = [0];
        for (let i = first + 1; i <= last; i++) rel.push(rel.at(-1)! + metrics[i - 1]!.below + gapAfter(i - 1) + metrics[i]!.above);
        const heroItems = ribbonLines.map((i) => metrics[i]!.ordered[0]!);
        const fs = heroItems[0]!.size * k;
        const hw = Math.max(...ribbonLines.map((i) => metrics[i]!.width));
        const inkTop = (heroItems[0]!.m.inkTop * fs) / 100;
        const inkMid = (rel[0]! + inkTop + rel.at(-1)! + (Math.max(heroItems.at(-1)!.m.inkBottom, 0) * fs) / 100) / 2;
        const cy = inkMid - 0.15 * fs + 4 * k;
        const W = fs * 0.34;
        const outer = W * 0.7;
        const rx = Math.max(hw * 0.35, Math.min(hw / 2 + 30 * k + W * 0.3, laneHalf - 8 - outer));
        const ry = fs * 0.5 + W * 0.4 + (rel.at(-1)! - rel[0]!) / 2;
        const sections = toonRibbon(fs, rx, ry, rtl).map((sec) => ({ ...sec, points: sec.points.map(([x, y]) => [x, y + cy] as const) }));
        const r = fs * 0.19;
        // The ball sits on the key word's top, a third of the way in from its reading end; its lower edge tucks behind the
        // letters' outline so it peeks out of the word rather than floating over it.
        const ball = { x: (rtl ? -1 : 1) * Math.min(hw * 0.3, rx - r), y: inkTop - BALL_LIFT * fs, r };
        const box = sections.map((sec) => boundsOf(sec.points)).reduce(union);
        ribbon = { sections, ball, box: union(box, { x1: ball.x - r, x2: ball.x + r, y1: ball.y - r, y2: ball.y + r }), first, last };
        metrics[first]!.above = Math.max(metrics[first]!.above, -ribbon.box.y1);
        metrics[last]!.below = Math.max(metrics[last]!.below, ribbon.box.y2 - rel.at(-1)!);
      }

      const baselines: number[] = [];
      let y = 0;
      metrics.forEach((line, i) => {
        y += i === 0 ? line.above : metrics[i - 1]!.below + gapAfter(i - 1) + line.above;
        baselines.push(y);
      });
      const height = y + metrics.at(-1)!.below;
      const cells: Cell[] = [];
      metrics.forEach((line, i) => {
        const baseline = baselines[i]! - height / 2;
        line.ordered.forEach((item, j) => {
          const px = item.size * k;
          const width = (item.m.advance * px) / 100;
          const top = (item.m.inkTop * px) / 100;
          const bottom = (Math.max(item.m.inkBottom, 0) * px) / 100;
          const seam = baseline + top + (bottom - top) * SEAM;
          const x = line.xs[j]! - line.width / 2;
          const rest = restOf(item, j);
          const rested = paintedBox(width, px, baseline + top, baseline + bottom, seam, rest, x);
          cells.push({ ...item, line: i, x, baseline, seam, width, px, rest, box: { ...rested, y1: seam + (rested.y1 - seam) * (1 + POP_ROOM), y2: seam + (rested.y2 - seam) * (1 + POP_ROOM) + RISE_LEFT * riseOf(item) * k } });
        });
      });
      const ribbonPlaced = ribbon ? { ...ribbon, dy: baselines[ribbon.first]! - height / 2 } : null;
      let box = cells.map((cell) => cell.box).reduce(union);
      if (ribbonPlaced) box = union(box, { ...ribbonPlaced.box, y1: ribbonPlaced.box.y1 + ribbonPlaced.dy, y2: ribbonPlaced.box.y2 + ribbonPlaced.dy });
      // Each row's own height with its share of the gaps, for paging.
      const heights = metrics.map((line, i) => line.above + line.below + (i < metrics.length - 1 ? gapAfter(i) : 0));
      return { cells, ribbon: ribbonPlaced, k, box, heights };
    };

    // Fit: smaller sizes repack into fewer, wider rows (floors held); a token too long for the band at its floor pages
    // through it; anything else that still does not fit shrinks as a whole.
    const bandH = band.y2 - band.y1;
    const laneFit = bounds.x2 - bounds.x1 - 12;
    const fits = (a: ReturnType<typeof arrange>) => a.box.y2 - a.box.y1 <= bandH && a.box.x2 - a.box.x1 <= laneFit;
    let lines = planLines(1);
    let arranged = arrange(lines, 1, true);
    for (const f of FIT_SCALES) {
      if (fits(arranged)) break;
      lines = planLines(f);
      arranged = arrange(lines, 1, true);
    }
    let pages: Line[][] = [lines];
    let g = 1;
    if (!fits(arranged)) {
      if (lines.some((line) => line.items.some((item) => item.parts > 1))) {
        const flat = arrange(lines, 1, false);
        pages = [];
        let page: Line[] = [];
        let height = 0;
        lines.forEach((line, i) => {
          const h = flat.heights[i]!;
          if (page.length && height + h > bandH) {
            pages.push(page);
            page = [];
            height = 0;
          }
          page.push(line);
          height += h;
        });
        pages.push(page);
      } else {
        for (let tries = 0; tries < 8 && !fits(arranged); tries++) {
          const { box } = arranged;
          g *= Math.min(0.97, Math.min(bandH / (box.y2 - box.y1), laneFit / (box.x2 - box.x1)) * 0.98);
          arranged = arrange(lines, g, true);
        }
      }
    }
    const paged = pages.length > 1;

    // A page shows from its first word (or, inside one long word, its first piece's share of the word) to the next page.
    const pageStart = (page: readonly Line[], index: number) => {
      if (index === 0) return cueFrom;
      const item = page[0]!.items[0]!;
      const word = words[item.word]!;
      return exportFrameAtOrAfter(word.startMs + ((word.endMs - word.startMs) * item.part) / item.parts, fps);
    };
    const starts = pages.map(pageStart);
    // A key word whose cue paints on a single frame keeps its whole look on that frame: its copies and its ribbon are named
    // as parts of the word (`w<word>l…`), the one name the shared one-frame filter leaves.
    const oneFrame = paintedFrameCount(cueFrom, to, fps) < 2;

    for (const [pageAt, page] of pages.entries()) {
      const last = pageAt === pages.length - 1;
      const pageFrom = starts[pageAt]!;
      const pageTo = last ? to : starts[pageAt + 1]!;
      const placedPage = paged ? arrange(page, 1, false) : arranged;
      const { cells, k, box: blockBox } = placedPage;
      // Where the block centre sits on the canvas: on the anchor, moved into the band and the lane.
      const cx0 = clamp(space.x(540), bounds.x1 + 6 - blockBox.x1, bounds.x2 - 6 - blockBox.x2);
      const cy0 = clamp(anchorY, band.y1 - blockBox.y1, Math.max(band.y1 - blockBox.y1, band.y2 - blockBox.y2));
      const toCanvasBox = (b: Box): Box => ({ x1: b.x1 + cx0, x2: b.x2 + cx0, y1: b.y1 + cy0, y2: b.y2 + cy0 });
      // Beats stay inside the lane and the caption band.
      const lane: Box = { x1: bounds.x1 + 4, x2: bounds.x2 - 4, y1: Math.max(bounds.y1 + 4, band.y1), y2: Math.min(bounds.y2 - 4, band.y2) };
      const Y0 = cy0 + (blockBox.y1 + blockBox.y2) / 2;
      const pageExit = last && exit;
      const liveEnd = pageExit ? exitAt : pageTo;

      /** Adds the cue's exit (vertical squash toward the block's middle and a fade) to a track. */
      const withExit = (track: Track, from: number, y: number): Track => {
        if (!pageExit) return track;
        const sy = track.sy ?? [[from, 1]];
        const o = track.o ?? [[from, 1]];
        const ys = track.y ?? [[from, y]];
        const syAt = kf(exitAt, sy);
        const yAt = kf(exitAt, ys);
        // A tilted word squashed in its own frame keeps its tilt's height; it levels as it flattens, so rows never meet.
        const rz = track.rz ? { rz: [...track.rz, [exitAt, kf(exitAt, track.rz)], [to, 0, "in"]] as Frames } : {};
        return {
          ...track,
          ...rz,
          y: [...ys, [exitAt, yAt], [to, Y0 + (yAt - Y0) * EXIT_SQUASH, "in"]],
          sy: [...sy, [exitAt, syAt], [to, syAt * EXIT_SQUASH, "in"]],
          o: [...o, [exitAt, kf(exitAt, o)], [to, 0, "in"]],
        };
      };

      // Words: the rim, the readable face (lower colour, navy outline and drop), and the upper colour above the seam.
      for (const cell of cells) {
        const at = cell.word;
        const word = words[at]!;
        const hero = isHero(at);
        // The pop happens in the time before the word is spoken (from the previous word's onset, at most the cue's lead
        // for its first word) and has settled on the first spoken frame: the word is whole, opaque and in its slot when it
        // is heard. With fewer than two frames before that, the word appears settled.
        const onset = exportFrameAtOrAfter(word.startMs, fps);
        const want = hero ? 300 : cell.small ? 200 : 220;
        const previous = at > 0 ? words[at - 1]!.startMs : Number.NEGATIVE_INFINITY;
        const from = Math.max(pageFrom, Math.min(onset, Math.max(word.startMs - want, previous)));
        const motion = !paged && paintedFrameCount(from, onset, fps) >= 2;
        const X = cx0 + cell.x;
        const Y = cy0 + cell.seam;
        const settleEase: Ease = onset - from >= 200 ? "spring" : "out";
        // A wide row swings less (its ends lift at most a quarter em) and overscales only into the room it has.
        const maxSwing = (Math.atan((SWING_LIFT * cell.px) / Math.max(1, cell.width / 2)) * 180) / Math.PI;
        const swing = Math.min(hero ? 8 : 6, maxSwing) * ((ord.n + at) % 2 ? 1 : -1);
        const cellBox = toCanvasBox(cell.box);
        const room = Math.min(X - (bounds.x1 + 4), bounds.x2 - 4 - X) / Math.max(1, Math.max(X - cellBox.x1, cellBox.x2 - X));
        const over = clamp(room, 1, 1.03);
        const rise = riseOf(cell) * k;
        const opaque = Math.min(from + 35, onset);
        const base: Track = motion
          ? {
              x: [[from, X]],
              y: [[from, Y + rise], [onset, Y, "outExpo"]],
              sx: [[from, over], [onset, 1, settleEase]],
              sy: [[from, hero ? 0.3 : 0.5], [onset, 1, settleEase]],
              rz: [[from, cell.rest + swing], [onset, cell.rest, settleEase]],
              skx: [[from, slant]],
              o: [[from, 0.4], [opaque, 1]],
            }
          : { x: [[from, X]], y: [[from, Y]], rz: [[from, cell.rest]], skx: [[from, slant]], o: [[from, 1]] };
        const track = withExit(base, from, Y);
        const id = cell.parts > 1 ? `${ctx.id}:w${at}l${cell.part}` : `${ctx.id}:w${at}`;
        const text = {
          kind: "text" as const,
          fromMs: from,
          toMs: pageTo,
          text: cell.text,
          face: FACE,
          sizePx: cell.px,
          letterSpacingEm: cell.ls,
          anchor: "baseline-center" as const,
          language: cue.language,
          origin: { dx: 0, dy: cell.seam - cell.baseline },
          track,
        };
        const drop = (colour: string) => [{ dx: DROP_X * cell.px, dy: DROP_Y * cell.px, blur: 0, colour, alpha: 1 }];
        // The upper colour keeps everything outside a rectangle below the seam (an inverse clip that follows the pivot): the
        // copy is the whole word to the bounds, so it is named as a part of its word and kept on a one-frame cue.
        const FAR = 4000;
        pieces.push(
          { ...text, id: oneFrame ? `${ctx.id}:w${at}l${RIM_PART + cell.part}` : `${id}rim`, z: 3, fill: RIM_COLOUR, stroke: { widthPx: RIM * cell.px, colour: RIM_COLOUR } } satisfies TextPiece,
          { ...text, id, z: 6, fill: colours.lower, stroke: { widthPx: OUTLINE * cell.px, colour: NAVY }, shadows: drop(NAVY) } satisfies TextPiece,
          {
            ...text,
            id: `${ctx.id}:w${at}l${UPPER_PART + cell.part}`,
            z: 7,
            fill: colours.upper,
            clip: { x1: [[from, bounds.x1 - FAR]], x2: [[from, bounds.x2 + FAR]], y1: track.y!, y2: [[from, bounds.y2 + FAR]], inverse: true },
          } satisfies TextPiece,
        );
      }

      // Decorations only on a cue that fits in one page.
      if (paged) continue;
      const placed = (cell: Cell) => toCanvasBox(cell.box);
      const ribbon = placedPage.ribbon;
      const obstacles: Box[] = cells.map(placed);
      let ribbonBox: Box | null = null;

      // The ribbon and the ball behind the first key word.
      if (ribbon) {
        const hs = words[heroAt]!.startMs;
        const start = hs - 30;
        const c = clamp((liveEnd - start - 20) / 400, 0.25, 1);
        const RX = cx0;
        const RY = cy0 + ribbon.dy;
        ribbonBox = toCanvasBox({ ...ribbon.box, y1: ribbon.box.y1 + ribbon.dy, y2: ribbon.box.y2 + ribbon.dy });
        const fillOf = { highlight: colours.ribbon, white: RIBBON_WHITE, gold: GOLD } as const;
        const heroFrom = Math.max(cueFrom, Math.min(...pieces.filter((piece) => piece.id === `${ctx.id}:w${heroAt}` || piece.id === `${ctx.id}:w${heroAt}l0`).map((piece) => piece.fromMs)));
        ribbon.sections.forEach((sec, j) => {
          // On a one-frame cue the section is drawn whole, still, for the key word's frame.
          const a = oneFrame ? heroFrom : Math.max(cueFrom, start + sec.t0 * c);
          const b = a + sec.span * c;
          const wipe = !oneFrame && paintedFrameCount(a, b, fps) >= 2;
          const sb = boundsOf(sec.points);
          const box = { x1: RX + sb.x1 - 2, x2: RX + sb.x2 + 2, y1: RY + sb.y1 - 2, y2: RY + sb.y2 + 2 };
          // Only the wiping edge is near the section; the clip opens fully once the wipe is done, so the exit squash
          // (which moves the section toward the block's middle) is never cut by it.
          const FAR = 4000;
          const still = (v: number): Frames => [[a, v]];
          const grow = (v0: number, v1: number, open: number): Frames => [[a, v0], [b, v1, "outQuint"], [b + 1, open]];
          const clip = !wipe
            ? undefined
            : sec.dir === "y"
              ? { x1: still(box.x1 - FAR), x2: still(box.x2 + FAR), y1: still(box.y1 - FAR), y2: grow(box.y1, box.y2, box.y2 + FAR) }
              : rtl
                ? { x1: grow(box.x2, box.x1, box.x1 - FAR), x2: still(box.x2 + FAR), y1: still(box.y1 - FAR), y2: still(box.y2 + FAR) }
                : { x1: still(box.x1 - FAR), x2: grow(box.x1, box.x2, box.x2 + FAR), y1: still(box.y1 - FAR), y2: still(box.y2 + FAR) };
          pieces.push({
            id: oneFrame ? `${ctx.id}:w${heroAt}l${RIBBON_PART + j}` : `${ctx.id}:rib${j}`,
            kind: "shape",
            z: 1,
            fromMs: a,
            toMs: to,
            path: polygon(sec.points),
            fill: { colour: fillOf[sec.fill] },
            ...(clip ? { clip } : {}),
            track: withExit({ x: [[a, RX]], y: [[a, RY]] }, a, RY),
          } satisfies ShapePiece);
        });
        // The ball pops up from behind the letters, settled before the exit starts.
        const { ball } = ribbon;
        const pa = oneFrame ? heroFrom : Math.max(cueFrom, hs + 40 * c);
        const pb = Math.min(pa + 360 * c, liveEnd - 1);
        const moves = !oneFrame && paintedFrameCount(pa, pb, fps) >= 2;
        const bx = cx0 + ball.x;
        const by = cy0 + ribbon.dy + ball.y;
        const ballEase: Ease = pb - pa >= 200 ? "spring" : "out";
        const ballTrack: Track = moves
          ? { x: [[pa, bx]], y: [[pa, by + 26 * k], [pb, by, "out"]], sx: [[pa, 0.05], [pb, 1, ballEase]], sy: [[pa, 0.05], [pb, 1, ballEase]] }
          : { x: [[pa, bx]], y: [[pa, by]] };
        const track = withExit(ballTrack, pa, by);
        const ballId = (n: number, plain: string) => (oneFrame ? `${ctx.id}:w${heroAt}l${RIBBON_PART + 6 + n}` : `${ctx.id}:${plain}`);
        pieces.push(
          { id: ballId(0, "ball"), kind: "shape", z: 2, fromMs: pa, toMs: to, path: ellipsePath(0, 0, ball.r), fill: { colour: BALL }, track } satisfies ShapePiece,
          { id: ballId(1, "ballhi"), kind: "shape", z: 2, fromMs: pa, toMs: to, path: ellipsePath(-ball.r * 0.34, -ball.r * 0.36, ball.r * 0.3), fill: { colour: BALL_HI }, track } satisfies ShapePiece,
        );
      }

      // Beat: three tapered pop lines burst out of a free corner of the key word as it lands (the last word without one).
      const target = heroed ? cells.find((cell) => cell.word === heroAt && cell.part === 0)! : cells.filter((cell) => cell.word === words.length - 1).at(-1)!;
      {
        const word = words[target.word]!;
        const start = Math.max(cueFrom, word.startMs + 20);
        const end = Math.min(start + 300, liveEnd - 10);
        if (paintedFrameCount(start, end, fps) >= 2) {
          const tb = placed(target);
          const fs = target.px;
          const towardStart = heroed !== rtl;
          // Corners in order of preference: the top corner at the reading start for a key word, at the reading end otherwise.
          const corners: { x: number; y: number; angles: number[] }[] = [];
          const top = (left: boolean) => ({ x: left ? tb.x1 : tb.x2, y: tb.y1 + 0.12 * fs, angles: left ? [-165, -135, -105] : [-15, -45, -75] });
          const bottom = (left: boolean) => ({ x: left ? tb.x1 : tb.x2, y: tb.y2 - 0.12 * fs, angles: left ? [165, 135, 105] : [15, 45, 75] });
          corners.push(top(towardStart), top(!towardStart), bottom(towardStart), bottom(!towardStart));
          const d0 = 0.06 * fs;
          const lens = [0.22, 0.3, 0.22].map((l) => l * fs);
          const wOut = 0.075 * fs;
          const others = cells.filter((cell) => cell.word !== target.word).map(placed);
          for (const corner of corners) {
            const pts: (readonly [number, number])[] = [];
            const path: PathCmd[] = [];
            corner.angles.forEach((deg, i) => {
              const a = (deg * Math.PI) / 180;
              const [dx, dy] = [Math.cos(a), Math.sin(a)];
              const tip = [dx * d0, dy * d0] as const;
              const o1 = [dx * (d0 + lens[i]!) - dy * wOut * 0.5, dy * (d0 + lens[i]!) + dx * wOut * 0.5] as const;
              const o2 = [dx * (d0 + lens[i]!) + dy * wOut * 0.5, dy * (d0 + lens[i]!) - dx * wOut * 0.5] as const;
              path.push(["M", tip[0], tip[1]], ["L", o1[0], o1[1]], ["L", o2[0], o2[1]], ["Z"]);
              pts.push(tip, o1, o2);
            });
            const reach = boundsOf(pts);
            const box = { x1: corner.x + reach.x1 - 3 * k, x2: corner.x + reach.x2 + 3 * k, y1: corner.y + reach.y1 - 3 * k, y2: corner.y + reach.y2 + 3 * k };
            if (!inside(box, lane) || others.some((other) => meets(box, other))) continue;
            const grow = Math.min(110, (end - start) * 0.4);
            const fade = end - Math.min(100, (end - start) * 0.35);
            pieces.push({
              id: `${ctx.id}:pop${target.word}`,
              kind: "shape",
              z: 4,
              fromMs: start,
              toMs: end,
              path,
              fill: { colour: ord.n % 2 ? RIBBON_WHITE : GOLD },
              stroke: { widthPx: 2.5 * k, colour: NAVY },
              track: {
                x: [[start, corner.x]],
                y: [[start, corner.y]],
                sx: [[start, 0.35], [start + grow, 1, "out"]],
                sy: [[start, 0.35], [start + grow, 1, "out"]],
                o: [[start, 1], [fade, 1], [end, 0, "in"]],
              },
            } satisfies ShapePiece);
            obstacles.push(box);
            break;
          }
        }
      }

      // Beat: a gold sparkle pops beside a free end of the first row (else of the last; a top corner, else a lower one)
      // and twinkles every second while the cue holds. Where a full sparkle has no room, a smaller still one goes in the
      // first free pocket.
      {
        const lastLine = Math.max(...cells.map((cell) => cell.line));
        const rowOf = (line: number) => ({ box: cells.filter((cell) => cell.line === line).map(placed).reduce(union), px: Math.max(...cells.filter((cell) => cell.line === line).map((cell) => cell.px)) });
        const preferEnd = (ord.n + Math.floor(textSeed * 4)) % 2 === 0;
        const sides = [preferEnd !== rtl, preferEnd === rtl];
        const lineList = [...new Set([0, lastLine, ...cells.map((cell) => cell.line)])];
        const spots = [1, SPARKLE_SMALL].flatMap((scale) => lineList.flatMap((line) => [false, true].flatMap((low) => sides.map((right) => ({ ...rowOf(line), right, low, scale })))));
        const all = ribbonBox ? [...obstacles, ribbonBox] : obstacles;
        const s0 = words[0]!.startMs;
        const from = Math.max(cueFrom, s0 + 60);
        for (const { box: row, px, right, low, scale } of spots) {
          if (paintedFrameCount(from, to, fps) < 2) break;
          const full = scale === 1;
          const r = clamp(0.24 * px, 22 * k, 46 * k) * scale;
          // Its reach while it turns and springs (a turned box is up to 1.42x wider, the spring overshoots about 13%); a
          // small sparkle is still and unturned.
          const reach = full ? 1.6 * (r + 3 * k) : r + 3 * k;
          const x = right ? row.x2 + 0.1 * px + reach : row.x1 - 0.1 * px - reach;
          const y = low ? Math.min(row.y2 - r * 1.1, lane.y2 - reach) : Math.max(row.y1 + r * 1.1, lane.y1 + reach);
          const box = { x1: x - reach, x2: x + reach, y1: y - reach, y2: y + reach };
          if (!inside(box, lane) || all.some((other) => meets(box, other))) continue;
          const popEnd = Math.min(from + 280, liveEnd - 20);
          const moves = full && paintedFrameCount(from, popEnd, fps) >= 2;
          const sc: [number, number, Ease?][] = moves ? [[from, 0.05], [popEnd, 1, popEnd - from >= 200 ? "spring" : "out"]] : [[from, 1]];
          const rz: [number, number, Ease?][] = moves ? [[from, -40], [popEnd, 0, "out"]] : [[from, 0]];
          if (full) {
            for (let t = from + 1000, turn = 90; t + 300 <= liveEnd - 40; t += 1000, turn += 90) {
              sc.push([t, 1], [t + 130, 0.6, "inOut"], [t + 260, 1, "inOut"]);
              rz.push([t, turn - 90], [t + 260, turn, "inOut"]);
            }
          }
          pieces.push({
            id: `${ctx.id}:star`,
            kind: "shape",
            z: 4,
            fromMs: from,
            toMs: to,
            path: sparklePath(r, 0, 0, 0.2),
            fill: { colour: GOLD },
            stroke: { widthPx: 3 * k * scale, colour: NAVY },
            track: withExit({ x: [[from, x]], y: [[from, y]], sx: sc, sy: sc, rz }, from, y),
          } satisfies ShapePiece);
          break;
        }
      }
    }

    // The piece budget counts shadow copies. Over it (a pathological token), decorations go first, then the rims, then the
    // upper colour; the readable faces always stay.
    const cost = (list: readonly Piece[]) => list.reduce((sum, piece) => sum + 1 + (piece.shadows?.length ?? 0), 0);
    let kept = pieces;
    const drops: ((piece: Piece) => boolean)[] = [
      (piece) => /:(star|pop\d+)$/.test(piece.id),
      (piece) => /:(rib\d|ball|ballhi)$/.test(piece.id),
      (piece) => /rim$/.test(piece.id) || partOf(piece) >= RIM_PART && partOf(piece) < RIBBON_PART,
      (piece) => partOf(piece) >= UPPER_PART && partOf(piece) < RIM_PART,
    ];
    for (const drop of drops) {
      if (cost(kept) <= PIECE_CAP) break;
      kept = kept.filter((piece) => !drop(piece));
    }
    return kept;
  },
  undefined,
  LEAD,
);

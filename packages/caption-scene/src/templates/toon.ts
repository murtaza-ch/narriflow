import { captionTextClusters } from "@narriflow/caption-fonts/caption-block";
import { CAPTION_SCENE_BRAND_MIN_CONTRAST, captionColourContrast } from "@narriflow/validators";
import type { DemoScript } from "../demo";
import { clamp, type Ease, type Frames, kf } from "../ease";
import { exportFrameAtOrBefore, paintedFrameCount } from "../frame-grid";
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
 *   word sits on it under a rectangular `\clip` whose lower edge is a level seam at half the word's own measured ink.
 *   The word's pivot is on the seam, so the pop's squash and swing turn about the seam and the clip only follows the
 *   pivot's rise (the same frames). Body words tilt 1-2 degrees and the key word 2.5, so the level seam crosses the
 *   letters a little off level, like the sample's slanted one.
 * - **Rows from the words.** The sample's " / " rows and cue-indexed tilts are gone. Each key word has a row of its own
 *   (the sample's hero rows also held small words; on real cues they stood alone on the row before the key word was
 *   spoken, Sol's round 2 finding, so they join the row before instead). Other words wrap into balanced rows of at most
 *   800 sample px, shrinking up to 28% to pack into two rows before stacking more (the sample fitted each row). A word wider than its column shrinks to a floor (140 px key word, 96 px others), then breaks between
 *   glyph clusters into the fewest even rows (Latin, Cyrillic, Greek and CJK; a joined script shrinks instead). Row
 *   pitch comes from each row's measured ink plus the rim and drop, and a key word's row also reserves the ribbon's
 *   measured crest and lower strokes and the ball, so the rows above and below keep a visible gap from the ribbon.
 * - **Small words by rule, not by an English list.** A word is drawn small (0.46 em of its row, never under 64 sample
 *   px) and tilted 4 degrees when the emphasis scorer marks it minor and it is at most four glyph clusters long, in any
 *   script. A row made only of such words ("it's been that") draws them at 0.7 of the row size, so no cue is all tiny.
 * - **Real speech timing.** Words pop 40 ms before they are spoken (the key word and a cue's first word 60 ms, the cue's
 *   whole lead), and are near opaque from their first frame. The pop compresses into the word's own time; when it gets under
 *   200 ms it settles without the spring's overshoot. Rows keep room for the overshoot and the swing so an entering word
 *   never touches a neighbour or another row; the exit levels each word's tilt as it flattens, for the same reason. The ribbon wipes and the ball compress into the time before the
 *   exit, and a wipe with fewer than two painted frames shows its section whole. The exit squash runs only after the
 *   last word has read for 150 ms and when it gets two painted frames; otherwise the cue cuts at the next one.
 * - **Ribbon and ball** are the sample's six fixed polygons and two circles, behind every letter and every rim, fitted
 *   to the lane; right-to-left cues mirror the ribbon and wipe it from the right. A wipe clip opens fully once its wipe
 *   is done, so the exit squash never cuts a section.
 * - **Copies.** Three per word: the indigo rim (no drop copy of its own: the sample's rim drop was a second wide-bordered
 *   copy on every frame and the budget's largest cost), the face with its navy outline and hard navy drop, and the
 *   clipped upper colour.
 * - **Extra recurring beats** in the reference's comic language: on every cue three tapered gold pop lines (white on
 *   alternate cues) burst out of a free corner of the key word as it lands (of the last word on a cue without one), and
 *   a gold sparkle with a navy edge pops beside a free end of the first row (else the last; a top corner, else a lower one), twinkling (a quarter turn
 *   and a dip) every second while the cue holds. Both are placed only where they touch no word, ribbon or ball, inside the lane.
 * - **Every language.** Whole words only, so joined scripts are never split. Upper case only for cased scripts; letter
 *   spacing only for Latin, Cyrillic and Greek. Bangers draws Latin only: other scripts use the fallback face at the same
 *   size (its letters stand about as tall as Bangers caps), with seam, outline, rows and ribbon taken from their
 *   measured ink. Right-to-left rows read right to left and the forward slant mirrors.
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
/** The seam sits this far down the word's measured ink. */
const SEAM = 0.5;
const LEAD = 60;
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
    const textSeed = textHash(words.map((word) => word.text).join(" "));
    const isHero = (at: number) => words[at]!.role === "hero";
    const heroAt = words.findIndex((word) => word.role === "hero");
    const heroed = heroAt >= 0;
    const display = words.map((word) => caps(word, cue));
    const isSmall = (at: number) => !isHero(at) && words[at]!.role === "minor" && words.length > 1 && captionTextClusters(display[at]!).length <= 4;
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

    // Columns, sample px: the sample's, or what the lane leaves (the key word keeps room for the ribbon each side).
    const laneW = (bounds.x2 - bounds.x1) / space.u;
    const column = Math.min(COLUMN, laneW - 60);
    const heroColumn = Math.max(laneW * 0.55, Math.min(HERO_COLUMN, laneW - 230));

    /** The fewest pieces, cut between clusters at even widths, that each fit `room` at `size`. */
    const split = (text: string, size: number, room: number): string[] => {
      const clusters = captionTextClusters(text);
      const prefix = clusters.map((_, c) => widthOf(clusters.slice(0, c + 1).join(""), size));
      const full = prefix.at(-1)!;
      for (let k = 2; k <= clusters.length; k++) {
        const cuts = [0];
        for (let j = 1; j < k; j++) {
          let best = cuts.at(-1)! + 1;
          let error = Number.POSITIVE_INFINITY;
          for (let c = cuts.at(-1)! + 1; c <= clusters.length - (k - j); c++) {
            const e = Math.abs(prefix[c - 1]! - (full * j) / k);
            if (e < error) {
              error = e;
              best = c;
            }
          }
          cuts.push(best);
        }
        cuts.push(clusters.length);
        const parts = cuts.slice(1).map((end, j) => clusters.slice(cuts[j], end).join(""));
        if (parts.every((part) => widthOf(part, size) <= room)) return parts;
      }
      return clusters;
    };

    /** A word's size and pieces: the sample size, fitted to its column down to the floor, then broken. */
    const rowBase = heroed ? BODY : SOLO;
    const sized = words.map((_, at) => {
      const text = display[at]!;
      const hero = isHero(at);
      const small = isSmall(at);
      const base = hero ? HERO : small ? Math.max(SMALL_FLOOR, SMALL_EM * rowBase) : rowBase;
      const floor = hero ? HERO_FLOOR : small ? SMALL_FLOOR : BODY_FLOOR;
      const room = hero ? heroColumn : column;
      const width = widthOf(text, base);
      if (width <= room) return { size: base, parts: [text], small };
      const fit = (base * room) / width;
      if (fit >= floor || !SPLITTABLE.test(text) || captionTextClusters(text).length < 2) return { size: fit, parts: [text], small };
      const parts = split(text, floor, room);
      const widest = Math.max(...parts.map((part) => widthOf(part, 100)));
      return { size: Math.min(base, (100 * room) / widest), parts, small };
    });

    // Lines: every key word on its own row(s); the words between them wrap into balanced rows.
    interface Line {
      readonly items: Item[];
      readonly hero: boolean;
    }
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
        const items = run.map((item) => ({ ...item, size: item.small ? Math.max(SMALL_FLOOR, item.size * scale) : item.size * scale }));
        const widths = items.map((item) => widthOf(item.text, item.size));
        const gap = 2 * GAP_EM * Math.max(...items.map((item) => item.size));
        return { items, rows: balancedRows(widths, gap, column) };
      });
      const fewest = Math.min(...packs.map((pack) => pack.rows.length));
      const target = Math.max(fewest, Math.min(2, packs[0]!.rows.length));
      const pack = packs.find((candidate) => candidate.rows.length <= target)!;
      for (const row of pack.rows) {
        let items = row.map((at) => pack.items[at]!);
        // Small words read small beside a bigger word; a row of nothing but small words takes a middle size instead.
        if (items.every((item) => item.small)) {
          const lifted = items.map((item) => ({ ...item, size: Math.max(item.size, SMALL_ALONE * rowBase) }));
          const width = lifted.reduce((sum, item, i) => sum + widthOf(item.text, item.size) + (i ? GAP_EM * (item.size + lifted[i - 1]!.size) : 0), 0);
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

    // The ribbon goes around the first key word (all its rows).
    const ribbonLines = heroed ? lines.flatMap((line, i) => (line.hero && line.items[0]!.word === heroAt ? [i] : [])) : [];

    // Natural size: the band at the user's position (a larger size shrinks to fit it), inside the lane.
    const natural = space.u / ctx.input.scale;
    const anchorY = space.y(ANCHOR);
    const band = { y1: Math.max(bounds.y1 + 3, anchorY - BAND_ABOVE * natural), y2: Math.min(bounds.y2 - 3, anchorY + BAND_BELOW * natural) };
    const laneHalf = (bounds.x2 - bounds.x1) / 2;

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

    /** The rows at size factor `f`, block-local px centred on the block. */
    const arrange = (f: number) => {
      const k = space.u * f;
      const metrics = lines.map((line) => {
        const visual = rtl ? rowVisualOrder(line.items.map((item) => item.text), "rtl") : line.items.map((_, i) => i);
        const ordered = visual.map((i) => line.items[i]!);
        let x = 0;
        const xs: number[] = [];
        ordered.forEach((item, i) => {
          if (i > 0) x += GAP_EM * (item.size + ordered[i - 1]!.size) * k;
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
          return { ...box, y1: seam + (box.y1 - seam) * (1 + POP_ROOM), y2: seam + (box.y2 - seam) * (1 + POP_ROOM) };
        });
        const above = Math.max(...boxes.map((box) => -box.y1));
        const below = Math.max(...boxes.map((box) => box.y2));
        return { ordered, xs, width: x, above, below, px: Math.max(...ordered.map((item) => item.size)) * k };
      });
      const gapAfter = (i: number) => ROW_GAP * Math.max(metrics[i]!.px, metrics[i + 1]!.px);

      // The ribbon around the key word's rows, relative to the first of them (baseline 0).
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
        // The ball sits on the key word's top, a third of the way in from its reading end, its lower edge behind the letters.
        const ball = { x: (rtl ? -1 : 1) * Math.min(hw * 0.3, rx - r), y: inkTop - 0.28 * fs, r };
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
          cells.push({ ...item, line: i, x, baseline, seam, width, px, rest, box: { ...rested, y1: seam + (rested.y1 - seam) * (1 + POP_ROOM), y2: seam + (rested.y2 - seam) * (1 + POP_ROOM) } });
        });
      });
      const ribbonPlaced = ribbon
        ? {
            ...ribbon,
            dy: baselines[ribbon.first]! - height / 2,
          }
        : null;
      let box = cells.map((cell) => cell.box).reduce(union);
      if (ribbonPlaced) box = union(box, { ...ribbonPlaced.box, y1: ribbonPlaced.box.y1 + ribbonPlaced.dy, y2: ribbonPlaced.box.y2 + ribbonPlaced.dy });
      return { cells, metrics, ribbon: ribbonPlaced, k, box };
    };

    let f = 1;
    let arranged = arrange(f);
    for (let tries = 0; tries < 8; tries++) {
      const { box } = arranged;
      const fit = Math.min(1, (band.y2 - band.y1) / (box.y2 - box.y1), (bounds.x2 - bounds.x1 - 12) / (box.x2 - box.x1));
      if (fit >= 1) break;
      f *= Math.min(0.97, fit * 0.98);
      arranged = arrange(f);
    }
    const { cells, k, box: blockBox } = arranged;
    // Where the block centre sits on the canvas: on the anchor, moved into the band and the lane.
    const cx0 = clamp(space.x(540), bounds.x1 + 6 - blockBox.x1, bounds.x2 - 6 - blockBox.x2);
    const cy0 = clamp(anchorY, band.y1 - blockBox.y1, Math.max(band.y1 - blockBox.y1, band.y2 - blockBox.y2));
    const toCanvasBox = (b: Box): Box => ({ x1: b.x1 + cx0, x2: b.x2 + cx0, y1: b.y1 + cy0, y2: b.y2 + cy0 });
    // Beats stay inside the lane and the caption band.
    const lane: Box = { x1: bounds.x1 + 4, x2: bounds.x2 - 4, y1: Math.max(bounds.y1 + 4, band.y1), y2: Math.min(bounds.y2 - 4, band.y2) };
    const Y0 = cy0 + (blockBox.y1 + blockBox.y2) / 2;
    const liveEnd = exit ? exitAt : to;

    /** Adds the cue's exit (vertical squash toward the block's middle and a fade) to a track. */
    const withExit = (track: Track, from: number, y: number): Track => {
      if (!exit) return track;
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

    // Words: the rim, the readable face (lower colour, navy outline and drop), and the upper colour clipped to the seam.
    for (const cell of cells) {
      const at = cell.word;
      const word = words[at]!;
      const hero = isHero(at);
      // The cue's first word takes the whole cue lead, so the incoming cue paints on the frame after the outgoing one.
      const pop = ctx.enter(word, hero ? 430 : cell.small ? 280 : 250, hero || at === 0 ? LEAD : 40);
      const from = cell.part === 0 ? pop.from : Math.max(cueFrom, pop.from);
      const last = Math.max(from, exportFrameAtOrBefore(word.endMs - 1, fps));
      const X = cx0 + cell.x;
      const Y = cy0 + cell.seam;
      const springy = pop.settled - from >= 200;
      const settleEase: Ease = springy ? "spring" : "out";
      const swing = (hero ? 8 : 6) * ((ord.n + at) % 2 ? 1 : -1);
      const rise = (hero ? 40 : 20) * k;
      const opaque = Math.min(from + 35, last);
      const base: Track = pop.motion
        ? {
            x: [[from, X]],
            y: [[from, Y + rise], [pop.settled, Y, "out"]],
            sx: [[from, 1.03], [pop.settled, 1, settleEase]],
            sy: [[from, hero ? 0.3 : 0.5], [pop.settled, 1, settleEase]],
            rz: [[from, cell.rest + swing], [pop.settled, cell.rest, settleEase]],
            skx: [[from, slant]],
            o: opaque > from ? [[from, 0.4], [opaque, 1]] : [[from, 1]],
          }
        : { x: [[from, X]], y: [[from, Y]], rz: [[from, cell.rest]], skx: [[from, slant]], o: [[from, 1]] };
      const track = withExit(base, from, Y);
      const id = cell.parts > 1 ? `${ctx.id}:w${at}l${cell.part}` : `${ctx.id}:w${at}`;
      const origin = { dx: 0, dy: cell.seam - cell.baseline };
      const text = {
        kind: "text" as const,
        fromMs: from,
        toMs: to,
        text: cell.text,
        face: FACE,
        sizePx: cell.px,
        letterSpacingEm: cell.ls,
        anchor: "baseline-center" as const,
        language: cue.language,
        origin,
        track,
      };
      const drop = (colour: string) => [{ dx: DROP_X * cell.px, dy: DROP_Y * cell.px, blur: 0, colour, alpha: 1 }];
      pieces.push(
        { ...text, id: `${id}rim`, z: 3, fill: RIM_COLOUR, stroke: { widthPx: RIM * cell.px, colour: RIM_COLOUR } } satisfies TextPiece,
        { ...text, id, z: 6, fill: colours.lower, stroke: { widthPx: OUTLINE * cell.px, colour: NAVY }, shadows: drop(NAVY) } satisfies TextPiece,
        {
          ...text,
          id: `${id}hi`,
          z: 7,
          fill: colours.upper,
          clip: { x1: [[from, bounds.x1 - 400]], x2: [[from, bounds.x2 + 400]], y1: [[from, bounds.y1 - 400]], y2: track.y! },
        } satisfies TextPiece,
      );
    }

    const placed = (cell: Cell) => toCanvasBox(cell.box);
    const ribbon = arranged.ribbon;
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
      ribbon.sections.forEach((sec, j) => {
        const a = Math.max(cueFrom, start + sec.t0 * c);
        const b = a + sec.span * c;
        const wipe = paintedFrameCount(a, b, fps) >= 2;
        const sb = boundsOf(sec.points);
        const box = { x1: RX + sb.x1 - 2, x2: RX + sb.x2 + 2, y1: RY + sb.y1 - 2, y2: RY + sb.y2 + 2 };
        // Only the wiping edge is near the section; the clip opens fully once the wipe is done, so the exit squash
        // (which moves the section toward the block's middle) is never cut by it.
        const FAR = 4000;
        const still = (v: number): Frames => [[a, v]];
        const grow = (v0: number, v1: number, open: number): Frames => (wipe ? [[a, v0], [b, v1, "outQuint"], [b + 1, open]] : [[a, open]]);
        const clip =
          sec.dir === "y"
            ? { x1: still(box.x1 - FAR), x2: still(box.x2 + FAR), y1: still(box.y1 - FAR), y2: grow(box.y1, box.y2, box.y2 + FAR) }
            : rtl
              ? { x1: grow(box.x2, box.x1, box.x1 - FAR), x2: still(box.x2 + FAR), y1: still(box.y1 - FAR), y2: still(box.y2 + FAR) }
              : { x1: still(box.x1 - FAR), x2: grow(box.x1, box.x2, box.x2 + FAR), y1: still(box.y1 - FAR), y2: still(box.y2 + FAR) };
        pieces.push({
          id: `${ctx.id}:rib${j}`,
          kind: "shape",
          z: 1,
          fromMs: a,
          toMs: to,
          path: polygon(sec.points),
          fill: { colour: fillOf[sec.fill] },
          clip,
          track: withExit({ x: [[a, RX]], y: [[a, RY]] }, a, RY),
        } satisfies ShapePiece);
      });
      // The ball pops up from behind the letters.
      const { ball } = ribbon;
      const pa = Math.max(cueFrom, hs + 40 * c);
      const pb = pa + 360 * c;
      const moves = paintedFrameCount(pa, pb, fps) >= 2;
      const bx = cx0 + ball.x;
      const by = cy0 + ribbon.dy + ball.y;
      const ballEase: Ease = pb - pa >= 200 ? "spring" : "out";
      const ballTrack: Track = moves
        ? { x: [[pa, bx]], y: [[pa, by + 26 * k], [pb, by, "out"]], sx: [[pa, 0.05], [pb, 1, ballEase]], sy: [[pa, 0.05], [pb, 1, ballEase]] }
        : { x: [[pa, bx]], y: [[pa, by]] };
      const track = withExit(ballTrack, pa, by);
      pieces.push(
        { id: `${ctx.id}:ball`, kind: "shape", z: 2, fromMs: pa, toMs: to, path: ellipsePath(0, 0, ball.r), fill: { colour: BALL }, track } satisfies ShapePiece,
        { id: `${ctx.id}:ballhi`, kind: "shape", z: 2, fromMs: pa, toMs: to, path: ellipsePath(-ball.r * 0.34, -ball.r * 0.36, ball.r * 0.3), fill: { colour: BALL_HI }, track } satisfies ShapePiece,
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

    // Beat: a gold sparkle pops beside a free end of the first row (else of the last) and twinkles every second while
    // the cue holds.
    {
      const lastLine = Math.max(...cells.map((cell) => cell.line));
      const rowOf = (line: number) => ({ box: cells.filter((cell) => cell.line === line).map(placed).reduce(union), px: Math.max(...cells.filter((cell) => cell.line === line).map((cell) => cell.px)) });
      const preferEnd = (ord.n + Math.floor(textSeed * 4)) % 2 === 0;
      const sides = [preferEnd !== rtl, preferEnd === rtl];
      const spots = [...new Set([0, lastLine])].flatMap((line) => [false, true].flatMap((low) => sides.map((right) => ({ ...rowOf(line), right, low }))));
      const all = ribbonBox ? [...obstacles, ribbonBox] : obstacles;
      for (const { box: row, px, right, low } of spots) {
        const r = clamp(0.24 * px, 22 * k, 46 * k);
        // Its reach while it turns and springs (a turned box is up to 1.42x wider, the spring overshoots about 13%).
        const reach = 1.6 * (r + 3 * k);
        const x = right ? row.x2 + 0.1 * px + reach : row.x1 - 0.1 * px - reach;
        const y = low ? Math.min(row.y2 - r * 1.1, lane.y2 - reach) : Math.max(row.y1 + r * 1.1, lane.y1 + reach);
        const box = { x1: x - reach, x2: x + reach, y1: y - reach, y2: y + reach };
        if (!inside(box, lane) || all.some((other) => meets(box, other))) continue;
        const s0 = words[0]!.startMs;
        const from = Math.max(cueFrom, s0 + 60);
        if (paintedFrameCount(from, to, fps) < 2) break;
        const popEnd = Math.min(from + 280, liveEnd - 20);
        const moves = paintedFrameCount(from, popEnd, fps) >= 2;
        const sc: [number, number, Ease?][] = moves ? [[from, 0.05], [popEnd, 1, popEnd - from >= 200 ? "spring" : "out"]] : [[from, 1]];
        const rz: [number, number, Ease?][] = moves ? [[from, -40], [popEnd, 0, "out"]] : [[from, 0]];
        for (let t = from + 1000, turn = 90; t + 300 <= liveEnd - 40; t += 1000, turn += 90) {
          sc.push([t, 1], [t + 130, 0.6, "inOut"], [t + 260, 1, "inOut"]);
          rz.push([t, turn - 90], [t + 260, turn, "inOut"]);
        }
        pieces.push({
          id: `${ctx.id}:star`,
          kind: "shape",
          z: 4,
          fromMs: from,
          toMs: to,
          path: sparklePath(r, 0, 0, 0.2),
          fill: { colour: GOLD },
          stroke: { widthPx: 3 * k, colour: NAVY },
          track: withExit({ x: [[from, x]], y: [[from, y]], sx: sc, sy: sc, rz }, from, y),
        } satisfies ShapePiece);
        break;
      }
    }
    return pieces;
  },
  undefined,
  LEAD,
);

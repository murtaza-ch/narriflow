import { CAPTION_SCENE_BRAND_MIN_CONTRAST, captionColourContrast } from "@narriflow/validators";
import type { DemoScript } from "../demo";
import { clamp, type Frames } from "../ease";
import { sampleFrames } from "../frames";
import { rowsFromRoles } from "../layout";
import { type Box, mixColour, type PathCmd, type Piece, type TextPiece, type Track } from "../scene";
import { roundedRectPath } from "../shapes";
import { caps, galleryScene, letterCells, rectClip, rowsOf } from "./gallery-layout";
import type { SpeechCell } from "./speech-layout";

/**
 * Tilt (the sample's "Hype3D", `samples/templates/m68-hype3d.js`, after Motion Array "Space 3D Titles"; the Hype style owns that
 * name): loud retro-arcade slab type. Heavy slanted Lilita One caps with a hard navy outline and a slate extrusion, the whole
 * block turned a little in perspective. Ordinary words are red; the key word is lettered in violet, yellow, pink and red. Each
 * word swings in from edge-on and settles, the key word lands inside a yellow sunburst, and sparkle stars twinkle around it.
 *
 * Changes from the sample, and why (Sol's gallery 6 review, 2026-11-25, plus the owner's "fix the demos"):
 * - **The key word is readable at onset.** The sample staggered the key word's letters 38 ms apart (a 12-letter word finished
 *   338 ms after its onset, longer than most spoken words) and started every word 80 ms early. Now every letter paints on the
 *   word's spoken start, opaque, and swings as one word: all of its letters share one pivot and one 140 ms swing (32 degrees
 *   to -4 degrees to rest, with a foreshortened width that opens to a 5 % overshoot). The 45 ms stagger runs across the
 *   letters' colours instead (each letter flips from the body red to its own fill), so the lettering still rolls across the
 *   word without ever hiding one. A long or shaped word (Devanagari, Arabic, more than 12 letters) swings whole in one fill.
 *   A word too short to animate takes its rest pose at once.
 * - **A calmer perspective.** The sample's nested 900/1500 px CSS cameras are not libass's camera and bent wide rows. The
 *   block takes one shallow projected pose instead: every word's pivot is projected (12 degrees about the vertical, 7 degrees
 *   about the horizontal, a 1800 px camera, so a word's scale stays within about 4 %), the block is turned a few degrees
 *   (cycled by cue), and the swing angle is capped so a wide word's near edge never grows more than 11 %. A projection that
 *   would put two words in contact is dropped for that cue.
 * - **Depth once, behind everything.** The sample's seven slate copies and two ink underlays are three offset copies (an ink
 *   rim at full depth, slate far and slate mid, whose borders bridge the steps) under the face: 0.12 em deep (0.074 em right,
 *   0.12 em down), every copy of every word below every face. Navy keyline 0.06 em, as the sample's. The sample's CSS group
 *   drop-shadow is dropped (it is invisible on the footage this style sits on).
 * - **A burst that sits on the word.** The sample's burst was placed by the key word's measured y only, so an off-centre key
 *   word got a centred burst, and it crowded the word it explained. Ten rays (not fourteen) are centred on the key word's
 *   measured box, at 70 % opacity under the faces, grow in over 160 ms and fade in 180 ms, and are cut to the caption band
 *   instead of shrinking the words. A cue with no key word gets a lighter eight-ray burst on its last word.
 * - **Rows and words follow speech.** The sample's rows were baked into " / " breaks and its words' sizes picked by role.
 *   Rows come from the roles (words before the key word, the key word on its own row, the words after), a lone word on a row
 *   is 1.25 x (1.15 x for a key word), long words get a row of their own and break across rows at a readable size, the key
 *   word fits the column before anything else shrinks, and the whole block is fitted to the caption band (two rows at most are
 *   kept by the 16:9 fit). Rows are restacked by their ink, keyline and depth so they never touch.
 * - **Real speech.** Words paint on their spoken start (the sample started them up to 80 ms early); the sunburst's pre-roll
 *   (40 ms) is decoration; the exit (a 160 ms turn-away, shrink and fade) only runs when two painted frames fit after the
 *   reading hold, and nothing waits on the previous cue.
 * - Colours: the body face is the preset's primary, the key word's lettering cycles violet, the highlight (also the rays),
 *   the accent and the primary; the catalogue row's `readsOn` keeps a brand colour that vanishes against the navy keyline from
 *   replacing them. The violet is lighter than the sample's so it holds against dark footage.
 * - Extra recurring beats, in the sample's arcade language, on every cue: three yellow action dashes flick out of the first
 *   word's corner in whichever corner has room as it lands; the block rocks about 1.2 degrees across any hold longer than
 *   a second (a cheap rz chain, the sample's sway); and the lettering's colours roll across the key word every cue, starting
 *   from a different fill each time. Sparkles twinkle for the whole hold, four around a key word and two on the last word of
 *   a cue without one, in alternating corners.
 */

export const TILT_DEMO: DemoScript = {
  lines: [
    "this:m is:m the:m game:b changer:h@640",
    "no:b one:b tells:b you:m this:h@560",
    "keep:b it:m loud:b",
    "go:b big:b or:m go:b home:h@560",
    "wait:h@600",
  ],
  options: { rate: 205, gap: 40, cueGap: 200, tail: 640, lead: 320 },
};

const FACE = "Lilita One" as const;
const BODY = 150;
const MINOR = 92;
const HERO_MAX = 230;
const HERO_MIN = 120;
const BODY_FLOOR = 84;
const LONE_BODY = 1.25;
const LONE_HERO = 1.15;
const COLUMN = 780;
const WIDE_COLUMN = 1500;
const GAP = 52;
const SPACING = 0.012;
const SKEW = -9;
const EDGE_EM = 0.06;
const RIM_EM = 0.027;
/** One slate copy: 0.75 of the depth down, its border (0.045 em) bridging from the keyline to the rim. */
const SLATE_AT = 0.75;
const SLATE_BORD_EM = 0.045;
const DEPTH_EM = 0.12;
const DEPTH_X = 0.62;
const INK = "#11112B";
const SLATE_NEAR = "#A8B7CC";
const SLATE_FAR = "#5E6F89";
const VIOLET = "#B18CFF";
const DEFAULT_PRIMARY = "#F4172B";
const DEFAULT_HIGHLIGHT = "#FFD21F";
const DEFAULT_ACCENT = "#FF5CB6";
const SPARK = ["#C8F23A", "#FFFFFF", "#FFD21F"] as const;
const TILTS = [-3.2, -2.2, -3.8, -2.6, -3.0] as const;
const PROJECT_RY = 12;
const PROJECT_RX = 7;
const CAMERA = 1800;
const SWING_MS = 140;
const SWING_FROM = 32;
const SWING_CAP = 0.11;
const PERSPECTIVE = 326;
const SWAY_DEG = 1.2;
const SWAY_MS = 4000;
const MAX_LETTERS = 12;
const BAND_ABOVE = 430;
const BAND_BELOW = 380;
const RAY_COUNT = 10;
const RAY_ALPHA = 0.7;

const SPLITTABLE = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{N}\p{P}]+$/u;
const rad = (degrees: number) => (degrees * Math.PI) / 180;
const meets = (a: Box, b: Box, margin: number) => a.x1 < b.x2 + margin && b.x1 < a.x2 + margin && a.y1 < b.y2 + margin && b.y1 < a.y2 + margin;
const union = (boxes: readonly Box[]): Box => ({
  x1: Math.min(...boxes.map((b) => b.x1)),
  y1: Math.min(...boxes.map((b) => b.y1)),
  x2: Math.max(...boxes.map((b) => b.x2)),
  y2: Math.max(...boxes.map((b) => b.y2)),
});

/** The sample's four-point star (`M0,-1 C0.1,-0.35 ...` in a -1..1 box) at radius `r`, centred on its own (0, 0). */
export function tiltStarPath(r: number): PathCmd[] {
  const p = (x: number, y: number): [number, number] => [x * r, y * r];
  const c = (a: [number, number], b: [number, number], to: [number, number]): PathCmd => ["C", a[0], a[1], b[0], b[1], to[0], to[1]];
  return [
    ["M", ...p(0, -1)],
    c(p(0.1, -0.35), p(0.35, -0.1), p(1, 0)),
    c(p(0.35, 0.1), p(0.1, 0.35), p(0, 1)),
    c(p(-0.1, 0.35), p(-0.35, 0.1), p(-1, 0)),
    c(p(-0.35, -0.1), p(-0.1, -0.35), p(0, -1)),
    ["Z"],
  ];
}

/** The sample's sunburst: long and short rays alternating around the centre, as one drawing centred on (0, 0). */
export function tiltRaysPath(count: number, inner: number, long: number, short: number): PathCmd[] {
  const out: PathCmd[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const half = (Math.PI / count) * (i % 2 ? 0.34 : 0.5);
    const R = i % 2 ? short : long;
    const q = (angle: number, r: number): [number, number] => [Math.cos(angle) * r, Math.sin(angle) * r];
    const p = [q(a - half * 0.3, inner), q(a - half, R), q(a + half, R), q(a + half * 0.3, inner)];
    out.push(["M", ...p[0]!], ["L", ...p[1]!], ["L", ...p[2]!], ["L", ...p[3]!], ["Z"]);
  }
  return out;
}

interface Item {
  readonly cell: SpeechCell;
  readonly word: number;
  readonly part: number;
  readonly row: number;
  /** The pivot (the ink's centre) on the canvas, the turn and scale at rest. */
  readonly x: number;
  readonly y: number;
  readonly rz: number;
  readonly s: number;
  /** Everything the word draws at rest: face, keyline, depth and slant. */
  readonly box: Box;
  /** The pivot's offset from the cell's baseline, rest px. */
  readonly centre: number;
}

export const tiltProgram = galleryScene("tilt", 1290, (ctx) => {
  const { cue, to, bounds, index } = ctx.window;
  const { exit, exitAt, fps, side, input, space } = ctx;
  const pieces: Piece[] = [];
  // Brand guard: each colour is checked against the navy keyline it is actually drawn on, and falls back to the default palette.
  const keep = (colour: string, fallback: string) => (captionColourContrast(colour, INK) >= CAPTION_SCENE_BRAND_MIN_CONTRAST ? colour : fallback);
  const colours = {
    primary: keep(input.colours.primary, DEFAULT_PRIMARY),
    highlight: keep(input.colours.highlight, DEFAULT_HIGHLIGHT),
    accent: keep(input.colours.accent, DEFAULT_ACCENT),
  };
  const body = colours.primary;
  const fills = [VIOLET, colours.highlight, colours.accent, colours.primary] as const;

  const { lead, hero, tail } = rowsFromRoles(cue.words.map((word) => word.role));
  const heroed = hero.length > 0;
  const texts = cue.words.map((word) => caps(word, cue));
  const lastWord = cue.words.length - 1;

  // The caption band of the sample, at the user's position but not at the user's size (a larger size shrinks to fit it).
  const natural = space.u / input.scale;
  const anchorY = space.y(1290);
  const band = { y1: Math.max(bounds.y1 + 3, anchorY - BAND_ABOVE * natural), y2: Math.min(bounds.y2 - 3, anchorY + BAND_BELOW * natural) };
  const laned = bounds.y2 - bounds.y1 < 0.75 * 0.9 * space.canvas.height;
  // A landscape frame has the width for two rows: the column widens before anything shrinks.
  const wide = space.canvas.width > space.canvas.height;
  const column = wide ? Math.min(WIDE_COLUMN, ((bounds.x2 - bounds.x1) / space.u) * 0.8) : COLUMN;

  // Sizes. The key words share one size, as large as the column allows; a long body word shrinks before it is cut.
  const at100 = (text: string) => input.measure(text, FACE, 100 * space.u, SPACING).advance / space.u;
  const heroCapNatural = HERO_MAX * (hero.length === 1 ? LONE_HERO : 1);
  // Adjacent words keep room for both keylines, the depth and the swing's overshoot: key words are 0.3 em apart at least.
  const heroGapEm = 0.4;
  const heroWidth = hero.reduce((sum, at) => sum + at100(texts[at]!), 0) + 100 * heroGapEm * Math.max(0, hero.length - 1);
  const heroRoom = column * 0.97;
  const heroCap = laned ? Math.min(heroCapNatural, (0.3 * (bounds.y2 - bounds.y1)) / space.u) : heroCapNatural;
  let heroSize = heroed ? clamp((heroRoom * 100) / Math.max(1, heroWidth), Math.min(HERO_MIN, heroCap), heroCap) : 0;
  const bodyBase = laned ? Math.min(BODY, heroCap * 0.62) : BODY;
  const minorBase = bodyBase * (MINOR / BODY);
  const lone = (list: number[]) => list.length === 1;
  const naturalOf = (at: number) => {
    const single = lone(lead) && lead[0] === at ? LONE_BODY : lone(tail) && tail[0] === at ? LONE_BODY : 1;
    return (cue.words[at]!.role === "minor" ? minorBase : bodyBase) * single;
  };
  const bodyFit = (at: number) => clamp((column * 0.97 * 100) / Math.max(1, at100(texts[at]!)), BODY_FLOOR * (bodyBase / BODY), naturalOf(at));
  let wideScale = 1;
  const sizeOf = (at: number) => (hero.includes(at) ? heroSize : bodyFit(at)) * wideScale;

  // A word wider than the column at its smallest readable size breaks across rows, a row per piece.
  const chunkAt = (text: string, size: number): string[] => {
    if (!SPLITTABLE.test(text) || (at100(text) * size) / 100 <= column * 0.97) return [text];
    const room = (column * 0.9 * 100) / size;
    const split = (limit: number) => {
      const out: string[] = [];
      let row = "";
      for (const ch of text) {
        if (row && at100(row + ch) > limit) {
          out.push(row);
          row = "";
        }
        row += ch;
      }
      if (row) out.push(row);
      return out;
    };
    // The fewest rows that fit, then the measured widths balanced (never UNBELI / EVABL / E).
    const rows = split(room).length;
    let limit = at100(text) / rows;
    let out = split(limit);
    for (let tries = 0; tries < 40 && out.length > rows && limit < room; tries++) {
      limit = Math.min(room, limit * 1.03);
      out = split(limit);
    }
    return out.length <= rows ? out : split(room);
  };
  const chunks = cue.words.map((_, at) => chunkAt(texts[at]!, hero.length === 1 && hero[0] === at ? Math.max(sizeOf(at), Math.min(HERO_MIN, heroCap)) : sizeOf(at)));
  if (heroed && hero.length === 1 && chunks[hero[0]!]!.length > 1) {
    const widest = Math.max(...chunks[hero[0]!]!.map(at100));
    heroSize = clamp((column * 0.9 * 100) / widest, Math.min(HERO_MIN, heroCap), heroCap);
  }

  const gapPx = hero.length > 1 ? Math.max(GAP, heroGapEm * heroSize) : GAP;
  const flat: { word: number; part: number; text: string }[] = [];
  const indexes = chunks.map((list, word) => list.map((text, part) => flat.push({ word, part, text }) - 1));
  const isLong = (at: number) => (at100(texts[at]!) * sizeOf(at)) / 100 > 0.62 * column;
  const groupsOf = (list: number[]) => {
    const out: number[][] = [];
    let row: number[] = [];
    for (const at of list) {
      if (indexes[at]!.length > 1 || isLong(at)) {
        if (row.length > 0) out.push(row);
        row = [];
        out.push(indexes[at]!);
      } else row.push(indexes[at]![0]!);
    }
    if (row.length > 0) out.push(row);
    return out;
  };
  // Landscape: the whole cue on one row when it fits, else the best two consecutive rows, before the roles' three.
  const wideRows = (): number[][] | null => {
    if (!wide || chunks.some((list) => list.length > 1)) return null;
    const all = cue.words.map((_, at) => at);
    const rowWidth = (list: readonly number[]) => list.reduce((sum, at) => sum + (at100(texts[at]!) * sizeOf(at)) / 100, 0) + gapPx * (list.length - 1);
    const asCells = (list: readonly number[]) => list.map((at) => indexes[at]![0]!);
    if (rowWidth(all) <= column * 0.97) return [asCells(all)];
    let best: number[][] | null = null;
    let bestWidth = Number.POSITIVE_INFINITY;
    for (let cut = 1; cut < all.length; cut++) {
      const a = all.slice(0, cut);
      const b = all.slice(cut);
      const widest = Math.max(rowWidth(a), rowWidth(b));
      if (widest < bestWidth) {
        bestWidth = widest;
        best = [asCells(a), asCells(b)];
      }
    }
    // Two rows a little too wide are scaled to the column (down to 72 %) before the roles' three rows are used.
    const need = (column * 0.97) / bestWidth;
    if (!best || need < 0.72) return null;
    wideScale = Math.min(1, need);
    return best;
  };
  const groups = wideRows() ?? [...groupsOf(lead), ...groupsOf(hero), ...groupsOf(tail)];
  const blockTilt = TILTS[index % TILTS.length]!;

  const laidAt = (f: number) =>
    ctx.layout({
      column,
      padding: 30,
      gap: gapPx * f,
      groups,
      words: flat.map((item) => ({ text: item.text, size: sizeOf(item.word) * f, face: FACE, spacing: SPACING })),
    });

  /** The laid-out cue with rows `extra` px further apart, moved `dy`, projected with `strength` (0 = flat). */
  const arrange = (laid: ReturnType<typeof laidAt>, extra: number, dy: number, strength: number) => {
    const { cells, unit } = laid;
    const rows = rowsOf(cells).sort((a, b) => a[0]!.baseline - b[0]!.baseline);
    const origTop = Math.min(...cells.map((cell) => cell.baseline + cell.inkTop));
    const origBottom = Math.max(...cells.map((cell) => cell.baseline + cell.inkBottom));
    // Rows restacked by their ink, keyline and depth.
    let cursor = 0;
    const metas = rows.map((row, r) => {
      const size = Math.max(...row.map((cell) => cell.size));
      const above = Math.max(...row.map((cell) => -cell.inkTop)) + (EDGE_EM + RIM_EM) * size;
      const below = Math.max(...row.map((cell) => cell.inkBottom)) + (EDGE_EM + RIM_EM + DEPTH_EM) * size;
      if (r > 0) cursor += 0.02 * size + extra;
      const baseline = cursor + above;
      cursor = baseline + below;
      return { row, size, baseline, top: baseline - above, bottom: baseline + below };
    });
    const shift = (origTop + origBottom) / 2 - cursor / 2 + dy;
    for (const meta of metas) {
      meta.baseline += shift;
      meta.top += shift;
      meta.bottom += shift;
    }
    const left = Math.min(...cells.map((cell) => cell.x - cell.width / 2));
    const right = Math.max(...cells.map((cell) => cell.x + cell.width / 2));
    const bx = (left + right) / 2;
    const by = (metas[0]!.top + metas[metas.length - 1]!.bottom) / 2;
    const cam = CAMERA * unit;
    const tilt = rad(blockTilt);
    const project = (px: number, py: number) => {
      const ox = px - bx;
      const oy = py - by;
      const z = strength * (ox * Math.sin(rad(PROJECT_RY)) + oy * Math.sin(rad(PROJECT_RX)));
      const s = cam / (cam - z);
      const sx = ox * s;
      const sy = oy * s;
      return { x: bx + sx * Math.cos(tilt) - sy * Math.sin(tilt), y: by + sx * Math.sin(tilt) + sy * Math.cos(tilt), s };
    };

    const items: Item[] = metas.flatMap((meta, r) =>
      meta.row.map((cell): Item => {
        const word = flat[cell.at]!;
        const centre = (cell.inkTop + cell.inkBottom) / 2;
        const at = project(cell.x, meta.baseline + centre);
        const size = cell.size;
        const slant = Math.tan(rad(-SKEW)) * 0.5 * (cell.inkBottom - cell.inkTop);
        const reach = (EDGE_EM + RIM_EM) * size;
        const local = [
          [-cell.width / 2 - reach - slant, cell.inkTop - centre - reach],
          [cell.width / 2 + reach + DEPTH_EM * DEPTH_X * size + slant, cell.inkTop - centre - reach],
          [cell.width / 2 + reach + DEPTH_EM * DEPTH_X * size + slant, cell.inkBottom - centre + reach + DEPTH_EM * size],
          [-cell.width / 2 - reach - slant, cell.inkBottom - centre + reach + DEPTH_EM * size],
        ].map(([lx, ly]) => {
          const sx = lx! * at.s;
          const sy = ly! * at.s;
          return [at.x + sx * Math.cos(tilt) - sy * Math.sin(tilt), at.y + sx * Math.sin(tilt) + sy * Math.cos(tilt)] as const;
        });
        return {
          cell, word: word.word, part: word.part, row: r, x: at.x, y: at.y, rz: blockTilt, s: at.s, centre,
          box: { x1: Math.min(...local.map((p) => p[0])), y1: Math.min(...local.map((p) => p[1])), x2: Math.max(...local.map((p) => p[0])), y2: Math.max(...local.map((p) => p[1])) },
        };
      }),
    );
    const total = union(items.map((item) => item.box));
    // A word turns away a little as it leaves, and swings in from a lift.
    return { items, unit, x1: total.x1, x2: total.x2, y1: total.y1 - 14 * unit, y2: total.y2 };
  };

  const crowded = (items: readonly Item[]) => items.some((a, i) => items.slice(i + 1).some((b) => a.cell.at !== b.cell.at && meets(a.box, b.box, -1)));

  let f = 1;
  let laid = laidAt(f);
  let extra = 0;
  let strength = 1;
  let arranged = arrange(laid, extra, 0, strength);
  for (let tries = 0; tries < 12; tries++) {
    if (strength > 0 && crowded(arranged.items)) {
      strength = 0;
      arranged = arrange(laid, extra, 0, strength);
    }
    for (let pass = 0; pass < 16 && crowded(arranged.items); pass++) {
      extra += 5 * arranged.unit;
      arranged = arrange(laid, extra, 0, strength);
    }
    const height = arranged.y2 - arranged.y1;
    const room = band.y2 - band.y1;
    const wide = arranged.x2 - arranged.x1;
    const across = bounds.x2 - bounds.x1 - 6;
    if (height <= room + 0.5 && wide <= across + 0.5) break;
    f *= Math.min(0.95, (0.98 * room) / height, (0.98 * across) / wide);
    laid = laidAt(f);
    extra = 0;
    strength = 1;
    arranged = arrange(laid, extra, 0, strength);
  }
  const dy = arranged.y1 < band.y1 ? band.y1 - arranged.y1 : arranged.y2 > band.y2 ? band.y2 - arranged.y2 : 0;
  if (dy !== 0) arranged = arrange(laid, extra, dy, strength);
  const { items } = arranged;
  const u = arranged.unit;

  // Words: every word swings as one, from its spoken start; the key word's colours roll across its letters.
  const timing = new Map<number, ReturnType<typeof ctx.enter>>();
  const timed = (at: number) => {
    const known = timing.get(at);
    if (known) return known;
    const made = ctx.enter(cue.words[at]!, SWING_MS, 0);
    timing.set(at, made);
    return made;
  };
  const phase = (index * 2.399) % (Math.PI * 2);
  const heroFace = (k: number) => fills[(k + index) % fills.length]!;

  // How many faces each word draws, so the ids are `w3` for a whole word and `w3l0 ...` for pieces.
  // Per-letter colours are decided from the whole word before any wrapping: a long or shaped word swings whole, a wrapped
  // fragment gets one fill and the same swing as its other fragments.
  const lettered = (word: number) => hero.includes(word) && SPLITTABLE.test(texts[word]!) && [...texts[word]!].length <= MAX_LETTERS;
  const parts = items.map((item) => (lettered(item.word) ? letterCells(item.cell, input, MAX_LETTERS) : [item.cell]));
  const swingOf = new Map<number, number>();
  for (const item of items) {
    const angle = Math.min(SWING_FROM, (Math.asin(Math.min(1, (SWING_CAP * PERSPECTIVE) / Math.max(1, item.cell.width / 2))) * 180) / Math.PI);
    swingOf.set(item.word, Math.min(swingOf.get(item.word) ?? SWING_FROM, angle));
  }
  const faceCount = new Map<number, number>();
  items.forEach((item, at) => {
    faceCount.set(item.word, (faceCount.get(item.word) ?? 0) + parts[at]!.length);
  });
  const running = new Map<number, number>();
  const heroLetters = new Map<number, number>();
  items.forEach((item, at) => {
    if (hero.includes(item.word) && parts[at]!.length > 1) heroLetters.set(item.word, (heroLetters.get(item.word) ?? 0) + parts[at]!.length);
  });

  items.forEach((item, at) => {
    const { cell } = item;
    const isHero = hero.includes(item.word);
    const { from: t0, settled, motion } = timed(item.word);
    const size = cell.size;
    // The swing angle is capped so the near edge of a wide word grows no more than 11 %, and shared by a word's fragments.
    const swing = swingOf.get(item.word)!;
    const p1 = t0 + 0.6 * (settled - t0);
    const lift = isHero ? 22 * u : 0;
    const endHold = exit ? exitAt : to;
    const rz = (() => {
      if (endHold - settled < 900) return [[t0, item.rz]] as Frames;
      const fn = (t: number) => item.rz + SWAY_DEG * (Math.sin(((Math.min(t, endHold) - settled) / SWAY_MS) * Math.PI * 2 + phase) - Math.sin(phase));
      return sampleFrames(fn, [settled, endHold], 0.2, { range: [t0, endHold], wholeMs: true, simplify: true });
    })();
    // A swing too short for an overshoot settles monotonically: the overshoot and the settle never share a frame.
    const brisk = settled - t0 < 100;
    const scale = (rest: number, from: number, peak: number): Frames => {
      const frames: [number, number, ("out" | "inOut" | "in")?][] = motion ? (brisk ? [[t0, rest * from], [settled, rest, "out"]] : [[t0, rest * from], [p1, rest * peak, "out"], [settled, rest, "inOut"]]) : [[t0, rest]];
      if (exit) frames.push([exitAt, rest], [to, rest * 0.9, "in"]);
      return frames;
    };
    const base: Track = {
      x: [[t0, item.x]],
      y: motion && lift > 0 ? [[t0, item.y - lift], [settled, item.y, "outExpo"]] : [[t0, item.y]],
      rz,
      sx: scale(item.s, 0.84, 1.05),
      sy: scale(item.s, 0.9, 1.04),
      ry: [
        ...(motion ? (brisk ? ([[t0, swing], [settled, 0, "out"]] as [number, number, ("out")?][]) : ([[t0, swing], [p1, -0.125 * swing, "out"], [settled, 0, "inOut"]] as [number, number, ("out" | "inOut")?][])) : [[t0, 0] as [number, number]]),
        ...(exit ? ([[exitAt, 0], [to, -0.6 * swing, "in"]] as [number, number, ("in")?][]) : []),
      ],
      skx: [[t0, SKEW]],
    };

    // The three depth layers are drawn once per shaped word or wrapped row, behind every face; letters only draw coloured faces.
    const slateMid = mixColour(SLATE_NEAR, SLATE_FAR, 0.5);
    const depthId = `${ctx.id}:w${item.word}${chunks[item.word]!.length > 1 ? `c${item.part}` : ""}`;
    const layers = [
      { id: "d3", z: 3, depth: 1, fill: INK, bord: (EDGE_EM + RIM_EM) * size, colour: INK },
      { id: "d2", z: 4, depth: SLATE_AT, fill: slateMid, bord: SLATE_BORD_EM * size, colour: slateMid },
    ] as const;
    for (const layer of layers) {
      const whole = ctx.face(cell, t0, layer.fill, { ...base });
      const copy: TextPiece = {
        ...whole,
        id: `${depthId}${layer.id}`,
        z: layer.z,
        letterSpacingEm: SPACING,
        stroke: { widthPx: layer.bord, colour: layer.colour },
        origin: { dx: -DEPTH_EM * DEPTH_X * size * layer.depth, dy: item.centre - DEPTH_EM * size * layer.depth },
      };
      pieces.push(copy);
    }

    parts[at]!.forEach((piece) => {
      const multi = faceCount.get(item.word)! > 1;
      const number = running.get(item.word) ?? 0;
      running.set(item.word, number + 1);
      const id = multi ? `${ctx.id}:w${item.word}l${number}` : `${ctx.id}:w${item.word}`;
      const letters = heroLetters.get(item.word) ?? 0;
      const fill = isHero ? (letters > 1 ? heroFace(number) : fills[(index + 1) % fills.length]!) : body;
      const track: Track = { ...base };
      if (isHero && letters > 1 && motion) {
        // The lettering rolls across the word in 45 ms: each letter flips from the body red to its own fill.
        const step = letters > 1 ? 45 / (letters - 1) : 0;
        const start = Math.min(t0 + number * step, settled);
        // A blend between two colours that dips under 3:1 on the keyline is a hard switch on the letter's own beat instead.
        const blends = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9].every((k) => captionColourContrast(mixColour(body, fill, k), INK) >= CAPTION_SCENE_BRAND_MIN_CONTRAST);
        track.colour = number === 0 || fill === body ? [[t0, fill]] : blends ? [[t0, body], [start, body], [Math.min(start + 50, Math.max(start + 1, settled)), fill, "out"]] : [[t0, body], [start, body], [start + 0.001, fill]];
      }
      const origin = { dx: cell.x - piece.x, dy: item.centre };
      const face: TextPiece = {
        ...ctx.face(piece, t0, fill, track),
        id,
        origin,
        letterSpacingEm: SPACING,
        stroke: { widthPx: EDGE_EM * size, colour: INK },
      };
      pieces.push(face);
    });
  });

  // Decoration: the burst, the sparkles and the action dashes sit in free space around the words.
  const inside = { x1: bounds.x1 + 4 * u, x2: bounds.x2 - 4 * u, y1: bounds.y1 + 4 * u, y2: bounds.y2 - 4 * u };
  // Decorations may overlap a word's box where its glyphs leave the corner empty (depth, keyline and slant pad the box).
  const taken: Box[] = items.map((item) => {
    const pad = 0.1 * item.cell.size;
    return { x1: item.box.x1 + pad, y1: item.box.y1 + pad, x2: item.box.x2 - pad, y2: item.box.y2 - pad };
  });
  const free = (around: Box) => around.x1 >= inside.x1 && around.x2 <= inside.x2 && around.y1 >= inside.y1 && around.y2 <= inside.y2 && taken.every((box) => !meets(around, box, 3 * u));
  const target = heroed ? items.filter((item) => hero.includes(item.word)) : items.filter((item) => item.word === lastWord);
  const targetBox = union(target.map((item) => item.box));
  const targetSize = Math.max(...target.map((item) => item.cell.size));
  const targetWord = cue.words[heroed ? hero[0]! : lastWord]!;
  const targetAt = { x: (targetBox.x1 + targetBox.x2) / 2, y: (targetBox.y1 + targetBox.y2) / 2 };
  const lifeEnd = exit ? exitAt : to;

  // Sunburst: grows behind the key word, fades in 180 ms, cut to the caption band. A cue too short for that shows it at once,
  // full size, fading over the painted frames it has.
  {
    const minLife = (2 * 1000) / fps + 2;
    const b0 = Math.max(ctx.window.from, targetWord.startMs - 40);
    const count = heroed ? RAY_COUNT : 8;
    const reach = Math.min((heroed ? 1.35 : 1.15) * targetSize, Math.max(0.9 * targetSize, 0.5 * (band.y2 - band.y1)));
    const alpha = heroed ? RAY_ALPHA : 0.5;
    const path = tiltRaysPath(count, 0.4 * targetSize, reach, reach * 0.72);
    const fadeTo = Math.min(lifeEnd, targetWord.startMs + (heroed ? 380 : 300));
    const fadeFrom = Math.max(b0 + 90, Math.min(targetWord.startMs + (heroed ? 200 : 120), fadeTo - 70));
    const full = fadeTo > fadeFrom + 20 && fadeTo - b0 >= 270;
    const end = full ? fadeTo : Math.min(lifeEnd, b0 + 270);
    if (end - b0 >= minLife) {
      const grow = Math.min(b0 + 160, fadeFrom);
      const shape = ctx.shape("burst", b0, path, full
        ? {
            x: [[b0, targetAt.x]],
            y: [[b0, targetAt.y]],
            sx: [[b0, 0.35], [grow, 1.05, "outExpo"]],
            sy: [[b0, 0.35], [grow, 1.05, "outExpo"]],
            rz: [[b0, -14 * side], [fadeTo, 6 * side]],
            o: [[b0, 0], [Math.min(b0 + 70, fadeFrom), alpha, "out"], [fadeFrom, alpha], [fadeTo, 0, "in"]],
          }
        : { x: [[b0, targetAt.x]], y: [[b0, targetAt.y]], sx: [[b0, 1]], sy: [[b0, 1]], rz: [[b0, -4 * side]], o: [[b0, alpha], [end, 0, "in"]] }, colours.highlight);
      pieces.push({
        ...shape,
        toMs: end,
        clip: rectClip(b0, { x1: inside.x1, x2: inside.x2, y1: Math.max(inside.y1, band.y1), y2: Math.min(inside.y2, band.y2) }),
      });
    }
  }

  // Sparkles: four around a key word, two on the last word of a cue without one, alternating corners, twinkling all hold.
  {
    const S = targetSize;
    const mirror = index % 2 === 1;
    const corners: readonly (readonly [number, number, number])[] = heroed
      ? [[-0.08, -0.02, 0.2], [1.06, -0.1, 0.27], [0.86, 1.02, 0.17], [0.1, 1.04, 0.15]]
      : mirror
        ? [[-0.08, -0.02, 0.2], [0.86, 1.02, 0.17]]
        : [[1.06, -0.1, 0.27], [0.1, 1.04, 0.15]];
    const w = targetBox.x2 - targetBox.x1;
    const h = targetBox.y2 - targetBox.y1;
    corners.forEach(([fx, fy, size], si) => {
      const radius = Math.max(26 * u, size * S * 1.5 * 0.5);
      let placed: { x: number; y: number } | null = null;
      for (const push of [1, 1.25, 1.5]) {
        const x = targetBox.x1 + fx * w + (fx < 0.5 ? -1 : 1) * (0.4 + (push - 1)) * radius;
        const y = targetBox.y1 + fy * h + (fy < 0.5 ? -1 : 1) * (0.4 + (push - 1)) * radius;
        const around = { x1: x - radius, x2: x + radius, y1: y - radius, y2: y + radius };
        if (free(around)) {
          placed = { x, y };
          taken.push(around);
          break;
        }
      }
      if (!placed) return;
      const t0 = Math.max(ctx.window.from, Math.min(targetWord.startMs + 160 + si * 90, lifeEnd - 200));
      if (t0 < ctx.window.from || lifeEnd - t0 < 70) return;
      // A short cue shows the star at once, full size; a longer one grows it and twinkles it for the whole hold.
      const compact = lifeEnd - t0 < 200;
      const grow: [number, number, ("outBack" | "inOut")?][] = compact ? [[t0, 1]] : [[t0, 0.05], [t0 + 160, 1, "outBack"]];
      for (let n = 1, at = t0 + 160 + 360; !compact && at < lifeEnd - 80 && n < 6; n++, at += 360) grow.push([at, n % 2 ? 0.64 : 1, "inOut"]);
      const shape = ctx.shape(`spark${si}`, t0, tiltStarPath(radius), {
        x: [[t0, placed.x]],
        y: [[t0, placed.y]],
        sx: grow,
        sy: grow,
        rz: [[t0, 0], [lifeEnd, (lifeEnd - t0) * 0.03]],
      }, SPARK[(si + index) % SPARK.length]!);
      pieces.push({ ...shape, z: 7, stroke: { widthPx: 3 * u, colour: INK } });
    });
  }

  // Action dashes: three yellow strokes flick out of the first word's corner as it lands, in whichever corner has room.
  {
    const first = items.reduce((best, item) => (item.word < best.word ? item : best), items[0]!);
    const box = first.box;
    const S = first.cell.size;
    const t0 = timed(first.word).from;
    const corners = side * (index % 2 ? -1 : 1) > 0
      ? [{ x: box.x2, y: box.y1, dir: -45 }, { x: box.x1, y: box.y1, dir: -135 }, { x: box.x2, y: box.y2, dir: 45 }, { x: box.x1, y: box.y2, dir: 135 }]
      : [{ x: box.x1, y: box.y1, dir: -135 }, { x: box.x2, y: box.y1, dir: -45 }, { x: box.x1, y: box.y2, dir: 135 }, { x: box.x2, y: box.y2, dir: 45 }];
    const len = 0.17 * S;
    const thick = 0.04 * S;
    for (const corner of corners) {
      const dashes = [-26, 0, 26].map((spread, k) => {
        const a = rad(corner.dir + spread);
        const r = 0.22 * S + (k === 1 ? 0.04 * S : 0);
        return { x: corner.x + Math.cos(a) * r, y: corner.y + Math.sin(a) * r, rot: corner.dir + spread };
      });
      const around = union(dashes.map((d) => ({ x1: d.x - len / 2 - thick, x2: d.x + len / 2 + thick, y1: d.y - len / 2 - thick, y2: d.y + len / 2 + thick })));
      if (!free(around)) continue;
      taken.push(around);
      const end = Math.min(t0 + 380, lifeEnd);
      if (end - t0 < (2 * 1000) / fps + 2) break;
      // A cue too short for the flick shows the dashes at once, full size, and fades them over the frames it has.
      const compact = end - t0 < 150;
      dashes.forEach((dash, k) => {
        const at = compact ? t0 : t0 + k * 25;
        const pop: Frames = compact ? [[at, 1]] : [[at, 0.2], [Math.min(at + 110, end - 1), 1, "outBack"]];
        const shape = ctx.shape(`dash${k}`, at, roundedRectPath(-len / 2, -thick / 2, len, thick, thick / 2), {
          x: [[at, dash.x]],
          y: [[at, dash.y]],
          rz: [[at, dash.rot]],
          sx: pop,
          sy: pop,
          o: compact ? [[at, 1], [end, 0, "in"]] : [[at, 1], [Math.min(at + 200, end - 1), 1], [end, 0, "in"]],
        }, colours.highlight);
        pieces.push({ ...shape, z: 7, toMs: end, stroke: { widthPx: 2.5 * u, colour: INK } });
      });
      break;
    }
  }

  return pieces;
}, undefined, 0);

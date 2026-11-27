import { CAPTION_SCENE_BRAND_MIN_CONTRAST, captionColourContrast, captionSceneMeta } from "@narriflow/validators";
import type { DemoScript } from "../demo";
import { clamp, type Ease, ease, kf, lerp, prog } from "../ease";
import { exportFrameAtOrAfter, exportFrameTimes, paintedFrameCount } from "../frame-grid";
import { sampleFrames } from "../frames";
import { balancedRows, rowsFromRoles, rowVisualOrder } from "../layout";
import { type Box, type PathCmd, type Piece, SCENE_PIECE_BUDGET, type Shadow, type TextMeasure, type TextPiece, type Track } from "../scene";
import { ellipsePath, pathBounds } from "../shapes";
import { caps, galleryScene, letterCells } from "./gallery-layout";
import type { SpeechCell } from "./speech-layout";

/**
 * Splat (`samples/templates/m79-splat.js`, after Motion Array "Spectrum Of Soulful Strokes"): bubbly Chewy caps, every word its
 * own flat bright colour with a thick dark-violet outline and a short hard shadow, each leaning its own way and popping in whole
 * with a soft overshoot. The key word is the signature: two overlapping scalloped paint splats in two colours bloom behind it, its
 * letters pop in out of order at different sizes and settle into a slightly crooked lockup, and white line doodles boil beside the
 * splat at 8 fps. A cue with no key word gets no splat, one small white doodle at its edge.
 *
 * Changes from the sample, and why (Sol's demo reviews r1/r2 and the wave 7 brief):
 * - **Every word paints whole on its spoken start.** The sample popped body words from 30% scale 70 ms early and faded them in
 *   over 50 ms. A word now paints opaque at its onset from 55% scale, overshoots to 105% and settles in 240 ms (compressed into a
 *   short word's own frames, and a monotonic settle when an overshoot would not get four painted frames). The key word's letters
 *   all paint at its onset too (Sol r1: the late letters of INCREDIBLE read as gaps): only their pops are staggered, out of order
 *   (a seeded shuffle, not the sample's `sort(() => rnd() - 0.5)`), within 45 ms and never past 30% of a short word.
 * - **Splat follows the letters.** The front splat starts with the key word's first frame from 30% (Sol r1/r2: the paint
 *   announced the hero early); the second colour follows 60 ms later and the doodles after it.
 * - **Scallops, not ovals.** Each splat is ONE path: a core ellipse ringed by round lobes whose radius follows the splat's height,
 *   so a wide key word gets more lobes instead of stretched ones (Sol r2: INCREDIBLE's splat read as a flattened oval). The back
 *   splat's lobes sit half a lobe round from the front's, so its colour shows between the front's scallops all round the rim.
 * - **A lighter hero outline, letters apart.** The hero outline is 0.095 em (the sample's 0.1125) and its letters are tracked
 *   0.05 em, so the crooked lockup does not fuse (Sol r1 taste). Every letter's outline is drawn under every letter's face, as the
 *   sample's two layers did.
 * - **Words keep their slots and never touch.** Rows come from the roles (words before the key word, the key word, the words
 *   after) and are balanced from measured widths; each word's slot holds its outline, its lean and its overshoot, so two words'
 *   outlines never join at peak scale (Sol r2: NOT and PANIC). As in the sample, the words heard so far sit centred and the row
 *   eases outward (240 ms) into its final slots as each next word lands, so a cue's first word never waits off centre.
 * - **Fits every word.** The key word is sized so its splat fits the lane; below 100 px it breaks across rows when its script can
 *   be broken (Latin, Cyrillic, Greek, CJK), the splat then backing all its rows. A body word wider than the column shrinks to 66%,
 *   then breaks the same way. Joined scripts (Devanagari, Arabic) are never broken: they shrink. Text is composed (NFC) before it
 *   is measured and broken, and breaks fall between graphemes, so a decomposed accent wraps like its precomposed letter. A token
 *   that needs four or more rows is set as a still block on the whole lane (no overshoot, lean or squish, at most 10% over the
 *   floor, its splat capped to the lane and the band), so a 90-character CJK key word keeps its 100 px floor; past 12 rows a token
 *   is split evenly into 12 (below the floor, the text whole). Row heights and the splat's height come from the measured ink.
 * - **A budget of 150 drawn layers a cue**, shadows included: the text first (long tokens share a bounded number of rows), then the
 *   splat, the spatter and the doodles, whose boil swaps share what is left.
 * - **One-frame key words keep their splat.** A key word that paints on a single frame is drawn whole with its outline, on one
 *   still front splat named as a part of the word (`w<word>l90`, kept by the shared one-frame filter).
 * - **Small things that bite on real speech.** A key word that paints on one frame is drawn whole (its letters' outline copies
 *   would be dropped by the shared two-frame filter); spatter dots keep clear of words by more than their flick travel; every
 *   piece has its own x/y tracks, so the shared lane shift and refit move the paint and doodles with their words.
 * - **Every language.** Caps only for cased scripts; per-letter popping only for Latin, Cyrillic and Greek words of up to 12
 *   letters (anything else pops as one word with the same splat and doodles); right-to-left rows run right to left and the splat's
 *   lean and the doodles' preferred sides mirror. Glyphs Chewy lacks fall back as every caption word does.
 * - **No cue-indexed tables.** The splat looks (pink over violet, blue over pink, violet over sky) cycle by a key-word counter, the
 *   no-key-word colours by a plain-cue counter, leans, lobes, letter poses and doodle poses come from a hash of the cue and its
 *   text, and the doodle kinds rotate by counter.
 * - **Doodles in free space, events capped.** Doodles are placed round the splat (round the last word on a cue without a key
 *   word), clear of every word's painted box by 16 px, inside the safe area; a doodle with no room is left out. Each boils as
 *   static pose pieces on the export grid every 125 ms, at most 16 swaps (then it holds still), inside its own cue's window, with
 *   no swap in the exit (its last pose rides the recoil). Doodles enter from 45% of their size, so the first frame reads as the
 *   drawing, not a fleck. A key word whose rim has no room gets one compact doodle in free space round the whole block.
 * - **Exit.** The words stay opaque and shrink 6% into the block over the last 110 ms of the window while the paint and doodles
 *   recoil (Sol r1 taste: the sample's fade looked washed out); when two painted frames do not fit, nothing animates out.
 * - **Colours.** The preset's primary, highlight and accent replace the white, yellow and pink (words, the key word and the first
 *   look's splat); each must keep 3:1 against the dark outline it is drawn in, or the style's own colour is used.
 *
 * Extra recurring beats, in the sample's paint language, on every cue: paint spatter (two or three flat dots flicked off the splat's
 * rim, or off the doodle on a cue without a key word), and a jelly squish (each word squishes as the next word lands, the splat
 * squishes when the key word's letters settle and again every 1.4 s of a long hold; a lone word squishes on its own landing; a
 * squish too close to the exit moves into the last three painted frames the cue has).
 */

export const SPLAT_DEMO: DemoScript = {
  lines: [
    "wait:b this:m is:m insane:h@520",
    "no:b way:b",
    "game:b day:h@520",
    "absolutely:b not:m panic:b",
    "very:b nice:h@480",
    "incredible:h@600",
  ],
  options: { rate: 215, gap: 30, cueGap: 140, tail: 420, lead: 250 },
};

const FACE = "Chewy";
const BODY = 118;
const SOLO = 138;
const HERO = 205;
const HERO_FLOOR = 100;
const BODY_FLOOR = 0.66;
const COLUMN = 880;
const PAD = 12;
const OUTLINE = 0.105;
const HERO_OUTLINE = 0.095;
const HERO_SPACING = 0.05;
const SHADOW = 0.065;
const POP_PEAK = 1.05;
const WORD_GAP = 0.1;
const ROW_CLEAR = 0.07;
const CLEAR = 16;
const MAX_LETTERS = 12;
/** The most rows one token may break into; a longer one is split evenly into this many, below the floor. */
const MAX_TOKEN_ROWS = 12;
/** Rows from which a broken token is set as a still block (no overshoot, lean or squish). */
const STEADY_ROWS = 4;
/** Layers kept for the two or three spatter dots, which are drawn after the doodles. */
const SPATTER_RESERVE = 3;
const BOIL_MS = 125;
const MAX_BOIL = 16;
const EXIT_MS = 110;
const SQUISH = 0.04;
const SQUISH_MS = 170;
const HOLD_SQUISH_EVERY = 1400;

const INK = "#2A0C5E";
const SHADE = "#1C0646";
const SHADE_ALPHA = 0.55;
const SKY = "#52D4FF";
const VIOLET = "#8A4DFF";
const BLUE = "#2F7CFF";
const DOODLE = "#FFFFFF";

/** Scripts that may be broken between characters when a word is wider than the lane. */
const BREAKABLE = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{M}\p{N}\p{P}\p{Zs}ー々〆〤]+$/u;

type Kind = "spark" | "plus" | "squiggle" | "curl";
const KINDS: readonly Kind[] = ["spark", "plus", "squiggle", "curl"];

/** [-1, 1): a cheap deterministic hash, so a cue always looks the same. */
const rand = (seed: number, i: number): number => {
  const v = Math.sin(seed * 127.1 + i * 311.7) * 43758.5453;
  return (v - Math.floor(v)) * 2 - 1;
};
const unit = (seed: number, i: number) => (rand(seed, i) + 1) / 2;
const textSeed = (text: string) => [...text].reduce((sum, ch, i) => sum + ch.charCodeAt(0) * (i + 1), 0);
const rad = (degrees: number) => (degrees * Math.PI) / 180;
const overlaps = (a: Box, b: Box) => a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
const inflate = (box: Box, by: number): Box => ({ x1: box.x1 - by, y1: box.y1 - by, x2: box.x2 + by, y2: box.y2 + by });
const union = (boxes: readonly Box[]): Box => ({
  x1: Math.min(...boxes.map((box) => box.x1)),
  y1: Math.min(...boxes.map((box) => box.y1)),
  x2: Math.max(...boxes.map((box) => box.x2)),
  y2: Math.max(...boxes.map((box) => box.y2)),
});
/** The axis-aligned box of a `w` x `h` rectangle centred on (cx, cy) and turned by `angle` degrees. */
const turnedBox = (cx: number, cy: number, w: number, h: number, angle: number): Box => {
  const a = rad(angle);
  const hw = (Math.abs(Math.cos(a)) * w + Math.abs(Math.sin(a)) * h) / 2;
  const hh = (Math.abs(Math.sin(a)) * w + Math.abs(Math.cos(a)) * h) / 2;
  return { x1: cx - hw, y1: cy - hh, x2: cx + hw, y2: cy + hh };
};

/**
 * A path moved so its box starts at (0, 0), with the pivot (the old origin) in `origin`: libass aligns a drawing by its box, so a
 * path centred on (0, 0) would move `\pos` with every scale step and cut an event per frame (PORTING.md).
 */
function fromTopLeft(path: readonly PathCmd[]): { path: PathCmd[]; origin: { dx: number; dy: number } } {
  const { x1, y1 } = pathBounds(path);
  const moved = path.map((cmd): PathCmd => {
    if (cmd[0] === "Z") return cmd;
    if (cmd[0] === "C") return ["C", cmd[1] - x1, cmd[2] - y1, cmd[3] - x1, cmd[4] - y1, cmd[5] - x1, cmd[6] - y1];
    return [cmd[0], cmd[1] - x1, cmd[2] - y1];
  });
  return { path: moved, origin: { dx: -x1, dy: -y1 } };
}

/** A seeded Fisher-Yates shuffle of 0..n-1. */
function shuffled(n: number, seed: number): number[] {
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(unit(seed, i * 7 + 1) * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order;
}

/**
 * A scalloped splat as ONE path, centred on (0, 0), reaching about (rx, ry): a core ellipse ringed by round lobes. The lobe radius
 * follows the smaller half axis, so a wide splat gets more lobes, not stretched ones; `phase` turns the ring (in lobes).
 */
function blobPath(rx: number, ry: number, seed: number, phase: number, lobeScale = 1): PathCmd[] {
  const lobe = Math.min(rx, ry) * 0.44 * lobeScale;
  const ax = Math.max(1, rx - lobe * 0.92);
  const ay = Math.max(1, ry - lobe * 0.92);
  const perimeter = Math.PI * (3 * (ax + ay) - Math.sqrt((3 * ax + ay) * (ax + 3 * ay)));
  const n = clamp(Math.round(perimeter / (1.45 * lobe)), 6, 16);
  const path: PathCmd[] = ellipsePath(0, 0, ax + lobe * 0.42, ay + lobe * 0.42);
  for (let i = 0; i < n; i++) {
    const th = ((i + phase + 0.3 * rand(seed, i * 3)) / n) * Math.PI * 2;
    const reach = 0.97 + 0.06 * rand(seed, i * 3 + 1);
    const r = lobe * (0.86 + 0.26 * unit(seed, i * 3 + 2));
    path.push(...ellipsePath(Math.cos(th) * ax * reach, Math.sin(th) * ay * reach, r));
  }
  return path;
}

/** One pose of a doodle `size` across, centred on (0, 0): the sample's four line drawings with a seeded wobble. */
function doodlePath(kind: Kind, size: number, seed: number): PathCmd[] {
  const h = size / 2;
  let k = 0;
  const j = (v: number) => rand(seed, k++) * 0.5 * v;
  if (kind === "plus") {
    const a = h * 0.78;
    return [["M", -a + j(h * 0.2), j(h * 0.2)], ["L", a + j(h * 0.2), j(h * 0.2)], ["M", j(h * 0.2), -a + j(h * 0.2)], ["L", j(h * 0.2), a + j(h * 0.2)]];
  }
  if (kind === "spark") {
    const path: PathCmd[] = [];
    const off = unit(seed, 99) * 0.5;
    for (let i = 0; i < 7; i++) {
      const th = ((i + off) / 7) * Math.PI * 2 + j(0.18);
      const r0 = h * (0.36 + j(0.1));
      const r1 = h * (0.88 + j(0.24)) * (i % 2 ? 0.8 : 1);
      path.push(["M", Math.cos(th) * r0, Math.sin(th) * r0], ["L", Math.cos(th) * r1, Math.sin(th) * r1]);
    }
    return path;
  }
  const points: [number, number][] = [];
  if (kind === "squiggle") {
    const amp = h * (0.32 + j(0.08));
    for (let i = 0; i <= 20; i++) {
      const u = i / 20;
      points.push([-h + u * size + j(h * 0.08), Math.sin(u * Math.PI * 4.2 + j(0.3)) * amp + j(h * 0.08)]);
    }
  } else {
    for (let i = 0; i <= 24; i++) {
      const u = i / 24;
      const th = u * Math.PI * 3.3 + 0.6;
      const r = h * (0.14 + 0.86 * u) + j(h * 0.06);
      points.push([Math.cos(th) * r, Math.sin(th) * r]);
    }
  }
  return [["M", points[0]![0], points[0]![1]], ...points.slice(1).map(([x, y]) => ["L", x, y] as const)];
}

interface Part {
  readonly word: number;
  readonly part: number;
  readonly parts: number;
  readonly text: string;
  readonly size: number;
  readonly spacing: number;
  readonly m: TextMeasure;
  readonly hero: boolean;
}

interface Placed {
  readonly part: Part;
  readonly cell: SpeechCell;
  /** Pivot: the ink centre at rest. */
  readonly x: number;
  readonly y: number;
  readonly tilt: number;
  /** Painted box at rest with outline, shadow, lean and overshoot. */
  readonly box: Box;
  readonly row: number;
  readonly slot: number;
}

export const splatProgram = galleryScene("splat", 1290, (ctx) => {
  const { cue, index, from: cueFrom, to, bounds } = ctx.window;
  const { exit, exitAt, fps, side, space, input } = ctx;
  const u = space.u;
  const pieces: Piece[] = [];

  // ---- colours: the preset's primary, highlight and accent replace the white, yellow and pink, each kept at 3:1 against the
  // dark outline it is drawn in (the Studio's colour controls bypass the Brand Kit's check), else the style's own.
  const defaults = captionSceneMeta("splat").colours;
  const keep = (colour: string, fallback: string) => (captionColourContrast(colour, INK) >= CAPTION_SCENE_BRAND_MIN_CONTRAST ? colour : fallback);
  const white = keep(input.colours.primary, defaults.primary);
  const yellow = keep(input.colours.highlight, defaults.highlight);
  const pink = keep(input.colours.accent, defaults.accent);
  const looks = [
    { front: pink, back: VIOLET, face: yellow, body: [white, SKY] },
    { front: BLUE, back: pink, face: white, body: [yellow, white] },
    { front: VIOLET, back: SKY, face: yellow, body: [white, pink] },
  ] as const;
  const plainFills = [pink, white, SKY, yellow] as const;

  const { words } = cue;
  const { lead, hero: heroAt, tail } = rowsFromRoles(words.map((word) => word.role));
  const heroed = heroAt.length > 0;
  const heroWord = heroed ? heroAt[0]! : -1;
  const earlier = input.cues.slice(0, index).filter((other) => other.words.length > 0);
  const heroCount = earlier.filter((other) => other.words.some((word) => word.role === "hero")).length;
  const plainCount = earlier.length - heroCount;
  const look = looks[heroCount % looks.length]!;
  // Canonical composition first: a decomposed accent (U+0301) measures, breaks and splits like its precomposed letter.
  const texts = words.map((word) => caps(word, cue).normalize("NFC"));
  const seed = index * 7919 + textSeed(texts.join(" "));
  const direction = ctx.rtl ? "rtl" : "ltr";

  // ---- sizes: body words at the sample's size (larger on a cue without a key word); the key word at most 205 px and small
  // enough that its splat fits the lane; below the floors a breakable word breaks across rows, a joined script shrinks.
  const lane = bounds.x2 - bounds.x1 - 2 * PAD * u;
  const column = Math.min(COLUMN * u, lane);
  const bodySize = (heroed ? BODY : SOLO) * u;
  const measure = (text: string, size: number, spacing: number) => input.measure(text, FACE, size, spacing);
  /** The splat's painted half width over the hero's ink half width plus its margin: back offset, lobes, bloom and recoil. */
  const SPLAT_REACH = 1.22;
  const splatMargin = (size: number) => 0.42 * size;
  /** How far below the front splat the back colour sits: a tenth of the smaller half axis (a tall splat drops no further). */
  const backDrop = (rx: number, ry: number) => 0.1 * Math.min(rx, ry);
  const heroSizeFor = (text: string) => {
    const k = measure(text, 100, HERO_SPACING).advance / 100;
    return Math.min(HERO * u, lane / 2 / (SPLAT_REACH * (k / 2 + 0.42)));
  };
  /** The text as graphemes, so a mark with no precomposed form stays on its letter when a word is broken. */
  const graphemes = (text: string) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((g) => g.segment);
  /** The fewest even chunks of `text` whose widest fits `room` at `size` (whole graphemes, never across a space). */
  const chunks = (text: string, size: number, spacing: number, room: number): string[] => {
    const glyphs = graphemes(text);
    const split = (limit: number): string[] => {
      const out: string[] = [];
      let row = "";
      for (const ch of glyphs) {
        if (row && measure(row + ch, size, spacing).advance > limit) {
          out.push(row);
          row = "";
        }
        row += ch;
      }
      if (row) out.push(row);
      return out;
    };
    const count = split(room).length;
    let lo = 0;
    let hi = room;
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      if (split(mid).length <= count) hi = mid;
      else lo = mid;
    }
    return split(hi);
  };
  /** `count` chunks of about the same number of graphemes: the bounded wrap of a token too long for any readable layout. */
  const evenChunks = (text: string, count: number): string[] => {
    const glyphs = graphemes(text);
    const per = Math.ceil(glyphs.length / count);
    return Array.from({ length: Math.ceil(glyphs.length / per) }, (_, k) => glyphs.slice(k * per, (k + 1) * per).join(""));
  };
  // Tokens that must break share a bounded number of rows, so the text alone never takes more than about 100 of the cue's 150
  // pieces (a body row is a face and its shadow, a lettered key word three pieces a letter).
  const breakers = Math.max(1, texts.filter((text) => measure(text, bodySize, 0).advance > column).length);
  const tokenRows = clamp(Math.floor((100 - 2 * words.length - 3 * MAX_LETTERS) / (2 * breakers)), 2, MAX_TOKEN_ROWS);
  /** Rows of one long token: the fewest at the floor; past `tokenRows`, an even split at the size that fits `room`. */
  const breakToken = (text: string, floor: number, ceiling: number, spacing: number, room: number) => {
    const readable = chunks(text, floor, spacing, room);
    const bounded = readable.length > tokenRows;
    const list = bounded ? evenChunks(text, tokenRows) : readable;
    const fits = room / Math.max(...list.map((chunk) => measure(chunk, 100, spacing).advance / 100));
    // A block of four or more rows grows little past the floor: every point of size is paid for once per row in height.
    const top = list.length >= STEADY_ROWS ? Math.min(ceiling, floor * 1.1) : ceiling;
    return { list, size: bounded ? Math.min(top, fits) : clamp(fits, floor, top) };
  };
  /** Every word as row parts for rows at most `limit` wide. */
  const partsFor = (limit: number): Part[][] =>
    words.map((_, at) => {
      const text = texts[at]!;
      const isHero = at === heroWord;
      const breakable = BREAKABLE.test(text) && graphemes(text).length > 1;
      if (isHero) {
        const size = heroSizeFor(text);
        if (size >= HERO_FLOOR * u || !breakable) return [{ word: at, part: 0, parts: 1, text, size, spacing: HERO_SPACING, m: measure(text, size, HERO_SPACING), hero: true }];
        const floor = HERO_FLOOR * u;
        // Rows the splat can back with its full margin; a key word that would need more than three of them takes the whole row
        // width instead (its splat is then capped to the lane, see `stack`).
        const splatRoom = (lane / 2 / SPLAT_REACH - splatMargin(floor)) * 2;
        const backed = chunks(text, floor, HERO_SPACING, splatRoom).length <= 3;
        // A block of rows is set untracked: the spacing only keeps a lockup's popping letters apart.
        const spacing = backed ? HERO_SPACING : 0;
        const room = backed ? splatRoom : lane - (2 * HERO_OUTLINE + 0.1) * floor;
        const { list, size: broken } = breakToken(text, floor, HERO * u, spacing, room);
        const fitted = backed ? clamp(lane / 2 / (SPLAT_REACH * (Math.max(...list.map((chunk) => measure(chunk, 100, spacing).advance / 100)) / 2 + 0.42)), broken, HERO * u) : broken;
        return list.map((chunk, part) => ({ word: at, part, parts: list.length, text: chunk, size: fitted, spacing, m: measure(chunk, fitted, spacing), hero: true }));
      }
      const natural = measure(text, bodySize, 0).advance;
      const popRoom = limit / POP_PEAK - 2 * OUTLINE * bodySize;
      const size = natural > popRoom ? (bodySize * popRoom) / natural : bodySize;
      if (size >= BODY_FLOOR * bodySize || !breakable) return [{ word: at, part: 0, parts: 1, text, size, spacing: 0, m: measure(text, size, 0), hero: false }];
      // Rows that pop with an overshoot; a token that needs four or more takes them steady, on the whole row width.
      const floor = BODY_FLOOR * bodySize;
      const room = chunks(text, floor, 0, popRoom).length < STEADY_ROWS ? popRoom : limit - 2 * OUTLINE * floor;
      const { list, size: fitted } = breakToken(text, floor, bodySize, 0, room);
      return list.map((chunk, part) => ({ word: at, part, parts: list.length, text: chunk, size: fitted, spacing: 0, m: measure(chunk, fitted, 0), hero: false }));
    });
  let parts = partsFor(column);

  // Each word leans its own way, 2-5 degrees, alternating sides along the cue with a hashed size; a wide word leans less (its
  // ends would rise far and push the rows apart), a key word half as much.
  const tilts = words.map((_, at) => {
    const wide = Math.min(column, measure(texts[at]!, at === heroWord ? HERO * u : bodySize, 0).advance);
    const lean = (2 + 3 * unit(seed, at * 13 + 5)) * Math.min(1, (300 * u) / Math.max(1, wide));
    return (at % 2 === (seed & 1) ? 1 : -1) * Math.max(1.2, lean) * (at === heroWord ? 0.5 : 1);
  });
  const outlineOf = (part: Part) => (part.hero ? HERO_OUTLINE : OUTLINE) * part.size;
  /** A token broken into four or more rows is a block of text: its rows enter without overshoot, lean or squish. */
  const steady = (part: Part) => part.parts >= STEADY_ROWS;
  const tiltOf = (part: Part) => (steady(part) ? 0 : tilts[part.word]!);
  /** A part's painted box about its ink centre at rest: outline, shadow, lean and the pop's overshoot. */
  const restBox = (part: Part, cx: number, cy: number): Box => {
    const o = outlineOf(part);
    const w = part.m.advance + 2 * o + (part.hero ? 0.1 * part.size : 0);
    const h = part.m.inkBottom - part.m.inkTop + 2 * o + (part.hero ? 0.08 * part.size : 0);
    const peak = steady(part) ? 1 : POP_PEAK;
    const box = turnedBox(cx, cy, w * peak, h * peak, tiltOf(part));
    return { ...box, y2: box.y2 + SHADOW * part.size };
  };
  const slotWidth = (part: Part) => {
    const box = restBox(part, 0, 0);
    return box.x2 - box.x1;
  };

  // ---- rows: the words before the key word, the key word (each of its pieces its own row), the words after.
  interface Row {
    readonly parts: Part[];
    readonly hero: boolean;
  }
  const packRows = (limit: number): Row[] => {
    const rows: Row[] = [];
    const groups = heroed ? [lead, heroAt.slice(0, 1), heroAt.slice(1), tail] : [words.map((_, at) => at)];
    for (const group of groups) {
      let run: Part[] = [];
      const flush = () => {
        if (!run.length) return;
        const gap = WORD_GAP * bodySize;
        for (const row of balancedRows(run.map(slotWidth), gap, limit)) rows.push({ parts: row.map((at) => run[at]!), hero: false });
        run = [];
      };
      for (const at of group) {
        const list = parts[at]!;
        if (at === heroWord) {
          flush();
          for (const part of list) rows.push({ parts: [part], hero: true });
        } else if (list.length > 1) {
          flush();
          for (const part of list) rows.push({ parts: [part], hero: false });
        } else run.push(list[0]!);
      }
      flush();
    }
    return rows;
  };

  /** Rows stacked on their painted boxes; the key word's rows as one block with its splat's reach above and below. */
  const stack = (rows: readonly Row[]) => {
    const extents = rows.map((row) => {
      const boxes = row.parts.map((part) => restBox(part, 0, (part.m.inkTop + part.m.inkBottom) / 2));
      return { above: -Math.min(...boxes.map((box) => box.y1)), below: Math.max(...boxes.map((box) => box.y2)) };
    });
    const heroRows = rows.map((row, r) => (row.hero ? r : -1)).filter((r) => r >= 0);
    const baselines: number[] = [];
    let cursor = 0;
    for (const [r, row] of rows.entries()) {
      if (r > 0) {
        const previous = rows[r - 1]!;
        const sizes = [...previous.parts, ...row.parts].map((part) => part.size);
        cursor += (previous.hero && row.hero ? 0.02 : ROW_CLEAR) * Math.min(...sizes);
      }
      baselines.push(cursor + extents[r]!.above);
      cursor = baselines[r]! + extents[r]!.below;
    }
    let splat: { cy: number; rx: number; ry: number } | null = null;
    if (heroRows.length) {
      const first = heroRows[0]!;
      const last = heroRows.at(-1)!;
      const heroParts = heroRows.map((r) => rows[r]!.parts[0]!);
      const size = heroParts[0]!.size;
      const inkTop = baselines[first]! + heroParts[0]!.m.inkTop;
      const inkBottom = baselines[last]! + heroParts.at(-1)!.m.inkBottom;
      const inkW = Math.max(...heroParts.map((part) => part.m.advance));
      // A key word broken over many full-width rows keeps its splat inside the lane (its margin narrows at the sides).
      const rx = Math.min(inkW / 2 + splatMargin(size), lane / 2 / SPLAT_REACH);
      // Never taller than the band can hold with its bloom and recoil.
      const ry = Math.min((inkBottom - inkTop) / 2 + 0.4 * size, (room - backDrop(rx, room)) / 2 / 1.08);
      const cy = (inkTop + inkBottom) / 2;
      // The splat tucks behind the neighbouring rows' lower and upper edges by at most a fifth of a body line; the rows before the
      // key word move up and the rows after it move down until it does.
      const tuck = 0.2 * bodySize;
      const before = first > 0 ? baselines[first - 1]! + extents[first - 1]!.below : null;
      const after = last < rows.length - 1 ? baselines[last + 1]! - extents[last + 1]!.above : null;
      const up = before === null ? 0 : Math.max(0, before - (cy - ry + tuck));
      const down = after === null ? 0 : Math.max(0, cy + ry - tuck - after);
      for (let r = 0; r < first; r++) baselines[r] = baselines[r]! - up;
      for (let r = last + 1; r < rows.length; r++) baselines[r] = baselines[r]! + down;
      splat = { cy, rx, ry };
    }
    // The splat's reach: its bloom and recoil (8%), and below, the back colour's offset.
    const reach = splat ? splat.ry * 1.08 : 0;
    const top = Math.min(...rows.map((_, r) => baselines[r]! - extents[r]!.above), splat ? splat.cy - reach : Number.POSITIVE_INFINITY);
    const bottom = Math.max(...rows.map((_, r) => baselines[r]! + extents[r]!.below), splat ? splat.cy + reach + backDrop(splat.rx, splat.ry) : Number.NEGATIVE_INFINITY);
    return { baselines, splat, top, height: bottom - top };
  };

  // A cue too tall for its band is packed again on the whole lane before the shared fit shrinks it.
  const room = bounds.y2 - bounds.y1 - 2 * PAD * u;
  let rows = packRows(column);
  let stacked = stack(rows);
  if (stacked.height > room && lane - 60 * u > column) {
    const narrow = parts;
    parts = partsFor(lane - 60 * u);
    const wide = packRows(lane - 60 * u);
    const alt = stack(wide);
    if (alt.height < stacked.height) {
      rows = wide;
      stacked = alt;
    } else parts = narrow;
  }
  const targetY = space.y(1290);
  const top = Math.min(bounds.y2 - PAD * u - stacked.height, Math.max(bounds.y1 + PAD * u, targetY - stacked.height / 2));
  const shiftY = top - stacked.top;
  const cx = space.x(540);

  // ---- place every part: rows centred, words centred in their slots, right-to-left rows in visual order.
  const placed: Placed[] = [];
  for (const [r, row] of rows.entries()) {
    const baseline = stacked.baselines[r]! + shiftY;
    const gap = WORD_GAP * bodySize;
    const slots = row.parts.map(slotWidth);
    const width = slots.reduce((sum, w) => sum + w, 0) + gap * (row.parts.length - 1);
    let pen = clamp(cx - width / 2, bounds.x1, Math.max(bounds.x1, bounds.x2 - width));
    for (const i of rowVisualOrder(row.parts.map((part) => part.text), direction)) {
      const part = row.parts[i]!;
      const centre = pen + slots[i]! / 2;
      const mid = (part.m.inkTop + part.m.inkBottom) / 2;
      const cell: SpeechCell = { at: part.word, text: part.text, size: part.size, face: FACE, spacing: part.spacing, x: centre, baseline, width: part.m.advance, inkTop: part.m.inkTop, inkBottom: part.m.inkBottom };
      placed.push({ part, cell, x: centre, y: baseline + mid, tilt: tiltOf(part), box: restBox(part, centre, baseline + mid), row: r, slot: slots[i]! });
      pen += slots[i]! + gap;
    }
  }
  const wordBoxes = placed.map((item) => item.box);
  const block = union(wordBoxes);
  const blockMid = { x: (block.x1 + block.x2) / 2, y: (block.y1 + block.y2) / 2 };

  // ---- timing: every word paints whole on its onset; the cue's exit window; the squish beats.
  const exitFrom = Math.max(exitAt, to - EXIT_MS);
  const exitOn = exit && paintedFrameCount(exitFrom, to, fps) >= 2;
  const hold = exitOn ? exitFrom : to;
  const exitPose = (t: number) => (exitOn && t > exitFrom ? ease("in", prog(t, exitFrom, to - exitFrom)) : 0);
  const pull = (x: number, y: number, e: number) => {
    const se = 1 - 0.06 * e;
    return { x: blockMid.x + (x - blockMid.x) * se, y: blockMid.y + (y - blockMid.y) * se + 8 * u * e, s: se };
  };
  const recoil = (e: number) => (e < 0.3 ? 1 + 0.08 * (e / 0.3) : 1.08 * (1 - ((e - 0.3) / 0.7) ** 2));
  const entries = words.map((word, at) => ctx.enter(word, at === heroWord ? 300 : 240, 0));
  /** A squish that has three painted frames before the exit, or null. */
  const squishAt = (t: number, floor = cueFrom): number | null => {
    const fits = (start: number) => paintedFrameCount(start, Math.min(start + SQUISH_MS, hold), fps) >= 3;
    const start = exportFrameAtOrAfter(t, fps);
    if (fits(start)) return start;
    // Too close to the exit: the squish moves earlier, into the last frames the cue still has, never before `floor`.
    const grid = exportFrameTimes(Math.max(cueFrom, floor), hold, fps);
    const late = grid[grid.length - 3];
    return late !== undefined && late < start && fits(late) ? late : null;
  };
  const squishWindows = (starts: readonly (number | null)[]) => starts.filter((t): t is number => t !== null).map((t) => [t, Math.min(t + SQUISH_MS, hold)] as const);
  /** 1 + the squish at `t`: wider and shorter, then back. */
  const squish = (windows: readonly (readonly [number, number])[], t: number) => {
    for (const [a, b] of windows) {
      if (t > a && t < b) return SQUISH * Math.sin(Math.PI * ((t - a) / (b - a)));
    }
    return 0;
  };
  const edgesOf = (windows: readonly (readonly [number, number])[]) => windows.flatMap(([a, b]) => [a, (a + b) / 2, b]);
  const sample = (fn: (t: number) => number, edges: readonly number[], from: number, tolerance: number) =>
    sampleFrames(fn, edges, tolerance, { range: [from, to], wholeMs: true, simplify: true });

  // Each word squishes as the next word of its cue lands (a word's own pop is the next squish's cue).
  const wordSquish = words.map((_, at) => {
    const next = entries[at + 1];
    const starts: (number | null)[] = [];
    if (next && at !== heroWord && next.from > entries[at]!.settled) starts.push(squishAt(next.from));
    // A cue without a key word: its last word squishes again on a long hold.
    if (!heroed && at === words.length - 1) {
      // A lone word squishes on its own landing (compressed into the frames before the exit); a later word after a beat.
      const first = words.length === 1 ? entries[at]!.settled : entries[at]!.settled + 500;
      starts.push(squishAt(first, entries[at]!.from));
      for (let t = first + HOLD_SQUISH_EVERY; t + SQUISH_MS < hold; t += HOLD_SQUISH_EVERY) starts.push(squishAt(t));
    }
    return squishWindows(starts);
  });

  // Rows of several words keep their final slots, but the words heard so far sit centred: the row eases outward (240 ms) as
  // each next word lands, as the sample's rows did, so a cue's first word does not wait off centre for its neighbours.
  const SLIDE_MS = 240;
  const slides = new Map<number, { at: number; shift: number }[]>();
  for (const r of new Set(placed.map((item) => item.row))) {
    const members = placed.filter((item) => item.row === r && item.part.word !== heroWord);
    if (members.length < 2) continue;
    const spokenOrder = [...members].sort((a, b) => a.part.word - b.part.word);
    const rowMid = (Math.min(...members.map((m) => m.x - m.slot / 2)) + Math.max(...members.map((m) => m.x + m.slot / 2))) / 2;
    slides.set(r, spokenOrder.map((item, k) => {
      const heard = spokenOrder.slice(0, k + 1);
      const mid = (Math.min(...heard.map((m) => m.x - m.slot / 2)) + Math.max(...heard.map((m) => m.x + m.slot / 2))) / 2;
      return { at: entries[item.part.word]!.from, shift: rowMid - mid };
    }));
  }
  const slideAt = (r: number, t: number) => {
    const stops = slides.get(r);
    if (!stops) return 0;
    let shift = stops[0]!.shift;
    for (const stop of stops.slice(1)) shift = lerp(shift, stop.shift, ease("out", prog(t, stop.at, Math.min(SLIDE_MS, Math.max(1, hold - stop.at)))));
    return shift;
  };
  const slideEdges = (r: number) => (slides.get(r) ?? []).flatMap((stop) => [stop.at, Math.min(stop.at + SLIDE_MS, hold)]);

  // ---- the words ---------------------------------------------------------------------------------------------------
  const fills = words.map((_, at) => (at === heroWord ? look.face : heroed ? look.body[at % look.body.length]! : plainFills[(at + plainCount) % plainFills.length]!));
  const shadowOf = (size: number): Shadow[] => [{ dx: 0, dy: SHADOW * size, blur: 0, colour: SHADE, alpha: SHADE_ALPHA }];
  let heroSettled = -1;
  for (const item of placed) {
    const { part, cell } = item;
    const at = part.word;
    const { from, settled, motion } = entries[at]!;
    const isHero = at === heroWord;
    // A key word that paints on a single frame is drawn whole: its letters' outline copies are not faces, and the shared
    // two-frame filter would strip them, leaving bare letters on the footage.
    const letters = isHero && part.parts === 1 && paintedFrameCount(from, to, fps) >= 2 ? letterCells(cell, input, MAX_LETTERS) : [cell];
    const lettered = letters.length > 1;
    const span = Math.max(0, settled - from);
    const spread = lettered ? Math.min(45, 0.3 * span) : 0;
    const order = lettered ? shuffled(letters.length, seed + at * 31) : [0];
    const windows = wordSquish[at]!;
    letters.forEach((letter, k) => {
      const ls = seed + at * 101 + k * 17;
      const delay = lettered ? (order[k]! * spread) / Math.max(1, letters.length - 1) : 0;
      const start = from + delay;
      const frames = paintedFrameCount(start, settled, fps);
      const name: Ease = frames >= 5 && !steady(part) ? "spring" : "out";
      // A letter rests a little off: its own size, turn and height; it enters from a smaller, more turned pose.
      const rest = lettered ? { s: 1 + 0.045 * rand(ls, 1), r: 4 * rand(ls, 2), dy: 0.025 * part.size * rand(ls, 3) } : { s: 1, r: item.tilt, dy: 0 };
      const enterFrom = lettered
        ? { s: 0.6 + 0.22 * unit(ls, 4), r: rest.r + 22 * rand(ls, 5), dy: rest.dy + (0.04 + 0.08 * unit(ls, 6)) * part.size }
        : steady(part)
          ? { s: 0.8, r: 0, dy: 0.04 * part.size }
          : { s: frames >= 4 ? 0.55 : 0.72, r: item.tilt + 9 * side * (tilts[at]! >= 0 ? 1 : -1), dy: 0.05 * part.size };
      const px = lettered ? letter.x : item.x;
      const pose = (t: number) => {
        let s = rest.s;
        let r = rest.r;
        let dy = rest.dy;
        if (motion && t < settled) {
          const p = prog(t, start, Math.max(1, settled - start));
          if (!lettered && !steady(part) && frames >= 4) {
            // 55% to 105% to 100%: an overshoot keyframe, so a short word still settles exactly on its last painted frame.
            const peak = start + 0.6 * (settled - start);
            s = t < peak ? lerp(enterFrom.s, POP_PEAK, ease("out", prog(t, start, peak - start))) : lerp(POP_PEAK, 1, ease("inOut", prog(t, peak, settled - peak)));
          } else s = lerp(enterFrom.s, rest.s, ease(name, p));
          r = lerp(enterFrom.r, rest.r, ease(lettered ? name : "out", p));
          dy = lerp(enterFrom.dy, rest.dy, ease("out", Math.min(1, p * 1.6)));
        }
        const q = steady(part) ? 0 : squish(windows, t);
        const e = exitPose(t);
        const moved = pull(px + slideAt(item.row, t), item.y + dy, e);
        return { x: moved.x, y: moved.y, sx: s * (1 + q) * moved.s, sy: s * (1 - q) * moved.s, r };
      };
      const edges = [from, start, start + 0.6 * (settled - start), settled, exitFrom, to, ...edgesOf(windows), ...slideEdges(item.row)];
      const track: Track = {
        x: sample((t) => pose(t).x, edges, from, 0.25),
        y: sample((t) => pose(t).y, edges, from, 0.25),
        sx: sample((t) => pose(t).sx, edges, from, 0.002),
        sy: sample((t) => pose(t).sy, edges, from, 0.002),
        rz: sample((t) => pose(t).r, edges, from, 0.05),
        o: [[from, 1]],
      };
      const mid = (letter.inkTop + letter.inkBottom) / 2;
      const wordMid = (cell.inkTop + cell.inkBottom) / 2;
      const id = lettered || part.parts > 1 ? `${ctx.id}:w${at}l${lettered ? k : part.part}` : `${ctx.id}:w${at}`;
      const face: TextPiece = { ...ctx.face(letter, from, fills[at]!, track), id, origin: { dx: 0, dy: lettered ? wordMid : mid } };
      if (lettered) {
        // Every letter's outline (and shadow) under every letter's face, as the sample's two layers: neighbours never fuse.
        pieces.push({ ...face, id: `${id}o`, z: 5, fill: INK, stroke: { widthPx: outlineOf(part), colour: INK }, shadows: shadowOf(part.size) });
        pieces.push({ ...face, z: 6 });
      } else pieces.push({ ...face, z: 6, stroke: { widthPx: outlineOf(part), colour: INK }, shadows: shadowOf(part.size) });
      if (isHero) heroSettled = Math.max(heroSettled, settled);
    });
  }

  // ---- the piece budget: at most 150 drawn layers a cue, a piece's shadows included; the text is already in, decorations take
  // what is left (the splat and spatter first, the doodles' swaps share the rest).
  const costOf = (piece: Piece) => 1 + (piece.shadows?.length ?? 0);
  /** What is left for decorations, keeping room for the spatter dots that are drawn last. */
  const budgetLeft = () => SCENE_PIECE_BUDGET - pieces.reduce((sum, piece) => sum + costOf(piece), 0) - SPATTER_RESERVE;

  // ---- free space ---------------------------------------------------------------------------------------------------
  const area: Box = { x1: bounds.x1 + 4 * u, y1: bounds.y1 + 4 * u, x2: bounds.x2 - 4 * u, y2: bounds.y2 - 4 * u };
  const taken: Box[] = [];
  const clear = CLEAR * u;
  const free = (box: Box, pad = clear) =>
    box.x1 >= area.x1 && box.x2 <= area.x2 && box.y1 >= area.y1 && box.y2 <= area.y2 &&
    !wordBoxes.some((word) => overlaps(box, inflate(word, pad))) && !taken.some((other) => overlaps(box, inflate(other, 6 * u)));
  const spotBox = (x: number, y: number, half: number): Box => ({ x1: x - half, y1: y - half, x2: x + half, y2: y + half });
  const pace = (start: number, need: number) => paintedFrameCount(start, start + need, fps);
  /**
   * The start of a decoration wanted at `wanted`: pulled earlier when the hold would leave it fewer than `frames` painted frames,
   * never before `floor` (the word it belongs to); null when even that does not fit.
   */
  const startFor = (wanted: number, frames: number, floor: number): number | null => {
    const grid = exportFrameTimes(Math.max(cueFrom, floor), hold, fps);
    if (grid.length < frames) return null;
    return Math.min(exportFrameAtOrAfter(Math.max(wanted, floor), fps), grid[grid.length - frames]!);
  };

  // ---- the splat: two scalloped blobs behind the key word, front first, the second colour 60 ms later -----------------
  const hero = placed.filter((item) => item.part.word === heroWord);
  const dir = side * (unit(seed, 77) < 0.5 ? -1 : 1);
  let splatBox: Box | null = null;
  let splatCentre = { x: 0, y: 0, rx: 0, ry: 0 };
  if (heroed && stacked.splat && hero.length) {
    const heroInk = union(hero.map((item) => ({ x1: item.x - item.part.m.advance / 2, x2: item.x + item.part.m.advance / 2, y1: item.cell.baseline + item.part.m.inkTop, y2: item.cell.baseline + item.part.m.inkBottom })));
    const { rx, ry } = stacked.splat;
    const hx = (heroInk.x1 + heroInk.x2) / 2;
    const hy = (heroInk.y1 + heroInk.y2) / 2;
    splatCentre = { x: hx, y: hy, rx, ry };
    splatBox = { x1: hx - rx * 1.1, x2: hx + rx * 1.1, y1: hy - ry * 1.1, y2: hy + ry * 1.1 };
    const heroFrom = entries[heroWord]!.from;
    const settleAt = heroSettled > 0 ? heroSettled : entries[heroWord]!.settled;
    const holdSquish = [squishAt(settleAt, heroFrom)];
    for (let t = settleAt + HOLD_SQUISH_EVERY; t + SQUISH_MS < hold; t += HOLD_SQUISH_EVERY) holdSquish.push(squishAt(t));
    const splatWindows = squishWindows(holdSquish);
    const soft = (v: number) => (v > 1 ? 1 + (v - 1) * 0.4 : v);
    /**
     * The largest bloom turn (up to `wanted` degrees) that keeps the turned, growing splat inside 110% of its half width (and of
     * its half height when it is taller than wide): a tall splat of a many-row key word would otherwise swing past the lane.
     */
    const turnFor = (wanted: number) => {
      const fits = (deg: number) =>
        Array.from({ length: 21 }, (_, i) => i / 20).every((p) => {
          const k = lerp(0.3, 1, soft(ease("spring", p)));
          const a = rad(Math.abs(lerp(deg, 0, ease("out", p))));
          const wide = k * (rx * Math.cos(a) + ry * Math.sin(a));
          const tall = k * (ry * Math.cos(a) + rx * Math.sin(a));
          return wide <= 1.1 * rx && (ry <= rx || tall <= 1.1 * ry);
        });
      for (let deg = Math.abs(wanted); deg > 0; deg -= 1) if (fits(deg)) return Math.sign(wanted) * deg;
      return 0;
    };
    const blob = (suffix: string, z: number, colour: string, wanted: number, path: PathCmd[], x: number, y: number, want: number, lag: number) => {
      const turn = turnFor(want);
      const start = startFor(wanted, 2, heroFrom);
      if (start === null) return;
      const bloom = Math.min(340, hold - start);
      const animated = pace(start, bloom) >= 4;
      const pose = (t: number) => {
        const p = prog(t, start, bloom);
        const grow = animated ? lerp(0.3, 1, soft(ease("spring", p))) : 1;
        const q = squish(splatWindows.map(([a, b]) => [a + lag, Math.min(b + lag, hold)] as const), t);
        const e = exitPose(t);
        const moved = pull(x, y, e);
        const k = grow * moved.s * recoil(e);
        return { x: moved.x, y: moved.y, sx: k * (1 + q), sy: k * (1 - q), r: animated ? lerp(turn, 0, ease("out", p)) : 0 };
      };
      const edges = [start, start + bloom, exitFrom, to, ...edgesOf(splatWindows).map((t) => t + lag)];
      pieces.push({
        id: `${ctx.id}:${suffix}`, kind: "shape", z, fromMs: start, toMs: to, ...fromTopLeft(path),
        fill: { colour },
        track: {
          x: sample((t) => pose(t).x, edges, start, 0.25),
          y: sample((t) => pose(t).y, edges, start, 0.25),
          sx: sample((t) => pose(t).sx, edges, start, 0.002),
          sy: sample((t) => pose(t).sy, edges, start, 0.002),
          rz: sample((t) => pose(t).r, edges, start, 0.05),
        },
      });
    };
    if (paintedFrameCount(heroFrom, to, fps) < 2) {
      // A key word that paints on a single frame keeps one compact, still splat behind it on that frame. It is named as a part of
      // the word (`w<word>l90`), the one name the shared one-frame filter keeps; the second colour and the doodles are left out.
      pieces.push({
        id: `${ctx.id}:w${heroWord}l90`, kind: "shape", z: 2, fromMs: heroFrom, toMs: to, ...fromTopLeft(blobPath(rx, ry, seed + 11, 0)),
        fill: { colour: look.front }, track: { x: [[heroFrom, hx]], y: [[heroFrom, hy]] },
      });
    } else {
      blob("blobB", 1, look.back, heroFrom + 60, blobPath(rx * 0.98, ry, seed + 5, 0.5, 1.08), hx + dir * rx * 0.07, hy + backDrop(rx, ry), 18 * dir, 40);
      blob("blobF", 2, look.front, heroFrom, blobPath(rx, ry, seed + 11, 0), hx, hy, -16 * dir, 0);
    }
  }

  // ---- doodles: white line drawings in three poses swapped every 125 ms on the export grid -----------------------------
  const counterKinds = heroed ? [0, 1, 2].map((k) => KINDS[(heroCount + k) % KINDS.length]!) : [KINDS[plainCount % KINDS.length]!];
  const doodleShadow = (size: number): Shadow[] => [{ dx: 0, dy: 0.04 * size, blur: 0, colour: SHADE, alpha: SHADE_ALPHA }];
  const turnOf = (k: number) => 20 * rand(seed, 200 + k);
  const doodle = (k: number, kind: Kind, size: number, x: number, y: number, wanted: number, floor: number, share = 1) => {
    const start = startFor(wanted, 2, floor);
    if (start === null) return false;
    const popMs = Math.min(260, hold - start);
    const popping = pace(start, popMs) >= 4;
    const turn = turnOf(k);
    const pose = (t: number) => {
      const p = prog(t, start, popMs);
      const e = exitPose(t);
      const moved = pull(x, y, e);
      const grow = popping ? lerp(0.45, 1, ease("spring", p)) : 1;
      return { x: moved.x, y: moved.y, s: grow * moved.s * recoil(e) };
    };
    const edges = [start, start + popMs, exitFrom, to];
    const scale = sample((t) => pose(t).s, edges, start, 0.002);
    const track: Track = { x: sample((t) => pose(t).x, edges, start, 0.25), y: sample((t) => pose(t).y, edges, start, 0.25), sx: scale, sy: scale, rz: [[start, turn]] };
    // Swap times on the export grid, capped by the cue's piece budget, none in the exit (the last pose rides the recoil); a last
    // stretch too short to paint twice joins the one before.
    const cap = Math.min(MAX_BOIL, Math.floor(budgetLeft() / (2 * share)));
    if (cap < 1) return false;
    const swaps = [start];
    for (let j = 1; j < cap; j++) {
      const t = exportFrameAtOrAfter(start + j * BOIL_MS, fps);
      if (t >= hold) break;
      swaps.push(t);
    }
    while (swaps.length > 1 && paintedFrameCount(swaps.at(-1)!, to, fps) < 2) swaps.pop();
    const poses = posesOf(k, kind, size).map(fromTopLeft);
    swaps.forEach((t, j) => {
      pieces.push({
        id: `${ctx.id}:dd${k}p${j}`, kind: "shape", z: 3, fromMs: t, toMs: swaps[j + 1] ?? to, ...poses[(j + k) % 3]!,
        stroke: { widthPx: 0.1 * size, colour: DOODLE }, shadows: doodleShadow(size), track,
      });
    });
    return true;
  };
  const posesOf = (k: number, kind: Kind, size: number) => [0, 1, 2].map((v) => doodlePath(kind, size, seed + 300 + k * 11 + v * 5));
  /**
   * Half the width and height a doodle claims about its centre, measured as the shared bounds measure it (its three poses' box
   * plus the stroke width, turned) at its peak scale (the pop's overshoot, the exit recoil), so the cue's safe-area fit never sees
   * it reach past where it was placed.
   */
  const doodleExtent = (k: number, kind: Kind, size: number) => {
    const reach = 0.1 * size;
    const boxes = posesOf(k, kind, size).map(pathBounds);
    const x1 = Math.min(...boxes.map((b) => b.x1)) - reach;
    const x2 = Math.max(...boxes.map((b) => b.x2)) + reach;
    const y1 = Math.min(...boxes.map((b) => b.y1)) - reach;
    const y2 = Math.max(...boxes.map((b) => b.y2)) + reach;
    const a = rad(turnOf(k));
    const corners = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]].map(([x, y]) => [x! * Math.cos(a) - y! * Math.sin(a), x! * Math.sin(a) + y! * Math.cos(a)] as const);
    const peak = 1.13;
    return {
      hw: peak * Math.max(...corners.map(([x]) => Math.abs(x))),
      hh: peak * Math.max(...corners.map(([, y]) => Math.abs(y))),
    };
  };
  const extentBox = (x: number, y: number, e: { hw: number; hh: number }): Box => ({ x1: x - e.hw, y1: y - e.hh, x2: x + e.hw, y2: y + e.hh });
  const doodleSpots: { x: number; y: number; half: number }[] = [];
  if (heroed && splatBox) {
    const { x: hx, y: hy, rx, ry } = splatCentre;
    const scale = clamp(Math.min(rx, ry * 2.2) / (190 * u), 0.7, 1) * u;
    const sizes: Record<Kind, number> = { spark: 124, plus: 106, squiggle: 150, curl: 112 };
    // Upper corners and the sides first (an emoji goes over the cue's centre), mirrored for the splat's lean.
    const prefs = [-28, 208, 10, 170, -152, 32, 148, -60, 240, 90, 60, 120, -90];
    counterKinds.forEach((kind, k) => {
      // Side by side preference: at each angle on the rim first (a doodle may sit on the paint, as in the sample), then further
      // out, then a little smaller, before the next angle; pulled inside the safe area.
      const out = Array.from({ length: 6 }, (_, step) => step * 0.06 * Math.max(rx, ry));
      const tries = prefs.flatMap((deg) => [1, 0.8].flatMap((shrink) => out.map((push) => ({ deg, shrink, push }))));
      for (const { deg, shrink, push } of tries) {
        const size = sizes[kind] * scale * shrink;
        const e = doodleExtent(k, kind, size);
        const a = rad(dir > 0 ? deg : 180 - deg);
        const x = clamp(hx + Math.cos(a) * (rx * 0.94 + e.hw * 0.3 + push), area.x1 + e.hw, area.x2 - e.hw);
        const y = clamp(hy + Math.sin(a) * (ry * 0.94 + e.hh * 0.3 + push), area.y1 + e.hh, area.y2 - e.hh);
        const box = extentBox(x, y, e);
        if (!free(box)) continue;
        taken.push(box);
        if (doodle(k, kind, size, x, y, entries[heroWord]!.from + 70 + k * 90, entries[heroWord]!.from, counterKinds.length - k)) doodleSpots.push({ x, y, half: Math.max(e.hw, e.hh) });
        break;
      }
    });
  }
  /** One small doodle tucked against a corner of the last word (then the first, then any), at the first clear spot. */
  const cornerDoodle = (k: number, kind: Kind, owner: number) => {
    const size = 78 * u;
    const e = doodleExtent(k, kind, size);
    const half = Math.max(e.hw, e.hh);
    const order = [...new Set([placed.length - 1, 0, ...placed.keys()])];
    const spots: [number, number][] = [];
    for (const at of order) {
      const box = placed[at]!.box;
      const near = (x: number) => (side > 0 ? x : box.x1 + box.x2 - x);
      const off = 6 * u;
      spots.push(
        [near(box.x2 - half * 0.4), box.y1 - half - off],
        [near(box.x2 + half + off), box.y1 + half * 0.6],
        [near(box.x2 - half * 0.4), box.y2 + half + off],
        [near(box.x1 + half * 0.4), box.y1 - half - off],
        [near(box.x1 - half - off), box.y1 + half * 0.6],
      );
    }
    for (const [x, y] of spots) {
      const box = extentBox(x, y, e);
      if (!free(box, 4 * u)) continue;
      taken.push(box);
      if (doodle(k, kind, size, x, y, entries[owner]!.from + 60, entries[owner]!.from)) doodleSpots.push({ x, y, half });
      return;
    }
  };
  // A cue without a key word gets its one small doodle; a key word whose splat left no room on its rim gets one in free space
  // round the whole block.
  if (!heroed || doodleSpots.length === 0) cornerDoodle(heroed ? 3 : 0, counterKinds[0]!, heroed ? heroWord : words.length - 1);

  // ---- paint spatter: two or three flat dots flicked off the splat's rim (or off the doodle), in the cue's colours -------
  {
    const dots = heroed && splatBox ? [0.075, 0.055, 0.04] : [0.075, 0.05];
    const ref = heroed ? hero[0]!.part.size : bodySize;
    const colours = heroed ? [look.front, look.back, look.front] : [fills.at(-1)!, fills[0]!];
    const lastBox = placed.at(-1)!.box;
    const anchor = heroed && splatBox
      ? { x: splatCentre.x, y: splatCentre.y, rx: splatCentre.rx * 1.02, ry: splatCentre.ry * 1.02 }
      : doodleSpots[0]
        ? { x: doodleSpots[0].x, y: doodleSpots[0].y, rx: doodleSpots[0].half * 1.2, ry: doodleSpots[0].half * 1.2 }
        : { x: (lastBox.x1 + lastBox.x2) / 2, y: (lastBox.y1 + lastBox.y2) / 2, rx: (lastBox.x2 - lastBox.x1) * 0.72 + 14 * u, ry: (lastBox.y2 - lastBox.y1) * 0.72 + 14 * u };
    const owner = heroed ? entries[heroWord]!.from : entries[words.length - 1]!.from;
    const wanted = owner + (heroed ? 90 : 100);
    {
      const base = 360 * unit(seed, 400);
      dots.forEach((share, k) => {
        if (budgetLeft() + SPATTER_RESERVE < 1) return;
        const r = share * ref;
        // Round the anchor's rim, then a little further out.
        for (let step = 0; step < 48; step++) {
          const a = rad(base + k * 127 + (step % 16) * 23);
          const out = Math.floor(step / 16) * 18 * u;
          const x = anchor.x + Math.cos(a) * (anchor.rx + r * 1.4 + out);
          const y = anchor.y + Math.sin(a) * (anchor.ry + r * 1.4 + out);
          const box = spotBox(x, y, r * 1.6);
          // Clear of every word by more than the flick's 14 px travel, so the dot never crosses a word on its way out.
          if (!free(box, 26 * u)) continue;
          taken.push(box);
          const start = startFor(wanted + k * 45, 2, owner);
          if (start === null) break;
          const flick = Math.min(200, hold - start);
          const popping = pace(start, flick) >= 4;
          const ox = Math.cos(a) * 14 * u;
          const oy = Math.sin(a) * 14 * u;
          const pose = (t: number) => {
            const p = ease("out", prog(t, start, flick));
            const e = exitPose(t);
            const moved = pull(x - (popping ? ox * (1 - p) : 0), y - (popping ? oy * (1 - p) : 0), e);
            const grow = popping ? kf(t, [[start, 0.2], [start + 0.55 * flick, 1.15, "out"], [start + flick, 1, "inOut"]]) : 1;
            return { x: moved.x, y: moved.y, s: grow * moved.s * recoil(e) };
          };
          const edges = [start, start + 0.55 * flick, start + flick, exitFrom, to];
          const scale = sample((t) => pose(t).s, edges, start, 0.002);
          pieces.push({
            id: `${ctx.id}:dot${k}`, kind: "shape", z: 2, fromMs: start, toMs: to, path: ellipsePath(r, r, r), origin: { dx: r, dy: r },
            fill: { colour: colours[k % colours.length]! }, stroke: { widthPx: 0.35 * r, colour: INK },
            track: { x: sample((t) => pose(t).x, edges, start, 0.25), y: sample((t) => pose(t).y, edges, start, 0.25), sx: scale, sy: scale },
          });
          break;
        }
      });
    }
  }
  return pieces;
}, undefined, 0);


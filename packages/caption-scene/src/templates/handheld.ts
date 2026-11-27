import { captionTextClusters } from "@narriflow/caption-fonts/caption-block";
import { CAPTION_SCENE_BRAND_MIN_CONTRAST, captionColourContrast, captionSceneMeta } from "@narriflow/validators";
import type { DemoScript } from "../demo";
import { clamp, type Frames } from "../ease";
import { exportFrameAfter, exportFrameAtOrAfter, exportFrameAtOrBefore, exportFrameTimes, SCENE_DEFAULT_FPS } from "../frame-grid";
import type { SceneCue, SceneInput, SceneProgram } from "../input";
import { balancedRows, cueDirection, rowVisualOrder, sceneSpace } from "../layout";
import { type Box, type Clip, mixColour, type PathCmd, type Piece, type ShapePiece, type TextPiece, type Track } from "../scene";
import { rectPath, roundedRectPath } from "../shapes";
import { caps, galleryScene } from "./gallery-layout";
import { type SpeechWindow, speechLaneSpace, speechWindows } from "./speech-layout";

/**
 * Handheld (`samples/templates/m81-handheld.js`, after Motion Array "Gamer Titles II"): the caption lives in a small
 * pea-green LCD window with a dark case edge and a faint pixel grid. Dark olive pixel lettering steps in from the
 * glass's right edge in hard frames, like a handheld game's message; the key word sits on its own larger row, steps
 * down into it, leaves a faint LCD ghost of itself and is followed by a blinking block cursor. The window holds still
 * from cue to cue; each cue clears in two hard steps off the left edge, on the frame the next cue's first ink appears.
 *
 * Changes from the sample, and why:
 * - **The window follows speech.** A lit run is the stretch of cues of one lane whose spoken pauses are at most 700 ms;
 *   after a longer pause the cue clears and the glass powers off, and it opens again on the next cue's first ink frame (a
 *   one-frame half-height slit, as in the sample, only when the first row fits it). Inside a run a cue's words stay until
 *   the next cue's first ink, so the glass is never lit without a word on it. Each cue draws the window
 *   (`handheld:<cue>:lcd*`), so the conformance suite and the emoji layer see it as part of its cue; the earliest cue of a
 *   stretch that gives it at least two painted frames draws it, so a word that paints on a single frame still sits on it.
 * - **Sized per run.** The sample's 920 x 340 window held two rows; real cues have three (words before and after a key
 *   word). A run's window is as tall as its tallest cue of at most three rows, measured with the faces that really draw
 *   it (never under 340 px, never past the lane), centred on the caption position (`positionY`). A taller cue (a long
 *   token, a wrapped Devanagari cue) is an outlier: it gets a taller window for its own time only, changing in one hard
 *   step at the cue boundary with the top edge kept, then the run's height returns. The window never moves or resizes
 *   inside a cue.
 * - **Rows from the words.** The sample split a cue at its key word and fitted rows by character count. Here runs of
 *   key words and runs of other words take balanced rows by measured width (several key words are all honoured); a
 *   word wider than the column shrinks to a floor (64 px, the key word 80 px) and then breaks between glyph clusters
 *   into the fewest even pieces, one row each (Latin, Cyrillic, Greek and CJK; Devanagari, Arabic and the other joined
 *   scripts never break and shrink instead). A broken key word counts the cursor only on its last row, at the size tried,
 *   with measured pieces, and takes the fewest rows that fit at the floor. Text is composed (NFC) first, so a decomposed
 *   accent lays out like the precomposed one. Row pitch comes from each row's measured ink, so matras and Nastaliq never
 *   touch the next row. The cue takes the largest of five sizes whose rows fit the window. A cue draws at most 150 layers
 *   (shadows counted): beats go first, then the LCD shadow, never text.
 * - **Speech timing on the export grid.** A word's hard steps are planned on the render's frames: a peek of its front
 *   at the glass edge up to 100 ms before it is spoken, two more steps, and it sits in its slot on the last frame at or
 *   before its onset (the key word: a quarter-row drop and half-character slide in up to four steps, landing the same
 *   way). With no lead (a cue that follows at once) the word is simply there. The clear (two steps off the left edge)
 *   runs only after the last word has read for 150 ms and when it gets two painted frames, otherwise the cue cuts on the
 *   next cue's first frame; nothing of two cues is ever on the glass together.
 * - **No case change outside cased scripts; mirrored for right to left.** Uppercase as the sample, only for cased
 *   scripts. Right-to-left rows run right to left, words step in from the left edge and clear to the right, the cursor
 *   sits on the key word's left and the ghost is displaced the other way. Silkscreen and Pixelify draw only Latin:
 *   other scripts use the glyph-coverage fallback face at the same size, colour and LCD shadow, inside the same window.
 * - **Cheap LCD.** The window is four flat layers for the whole clip: the case (its deeper chin replaces the sample's
 *   blurred drop shadow, which would be a fifth full-size layer), the glass, the pixel grid as one drawn path of thin bars
 *   both ways, and the darker inner border as one stroked rounded rectangle.
 * - **Colours as drawn.** Both inks must keep 3:1 on the plain glass, on the grid and on the grid under the refresh band,
 *   else the style's own three colours are used; the darker inner border is derived from the glass colour.
 *
 * Extra recurring beats on every cue: a faint refresh band scans the glass in four hard steps when a cue's first word
 * lands (top to bottom and back up, alternating by counter; a short cue scans on the frames it has), and a row of status
 * pips in a free corner of the glass lights one pip per spoken word (more than six words share pips). On key-word cues the
 * ghost and the blinking cursor recur (a still cursor when the cue is too short to blink).
 *
 * Demo-review notes: the r3 taste note about Pixelify's narrow `C` is a face choice outside this port (the faces are
 * fixed); the lone first row of a cue already sits where its whole cue will sit, so nothing jumps when row two arrives.
 */

export const HANDHELD_DEMO: DemoScript = {
  lines: [
    "you:m only:b get:b one:m life:h@520",
    "so:m stop:b waiting:b",
    "press:b start:h@560",
    "it's:m not:b that:m hard:b",
    "level:h@540 up:b today:b",
    "become:b a:m legend:h@640",
  ],
  options: { rate: 205, gap: 30, cueGap: 330, tail: 300, lead: 240 },
};

const ANCHOR = 1290;
const BODY_FACE = "Pixelify Sans Bold";
const HERO_FACE = "Silkscreen Bold";
/** Sample px: a cue with no key word, words around a key word, the key word. */
const SOLO = 100;
const BODY = 88;
const HERO = 128;
/** The smallest a word is fitted to before it breaks across rows. */
const BODY_FLOOR = 64;
const HERO_FLOOR = 80;
const SCALES = [1, 0.92, 0.84, 0.76, 0.68] as const;

/** The window, sample px: width, least height, side and top padding of the text, corner radius, case edge, inner border, grid. */
const GLASS_W = 920;
const GLASS_MIN_H = 340;
const PAD_X = 60;
const PAD_Y = 52;
const RADIUS = 34;
const BEZEL = 9;
const RING = 6;
/** The case is this much deeper under the glass than round it (its chin), sample px. */
const CHIN = 12;
const GRID_PITCH = 8;
const GRID_BAR = 2;
/** The grid's and the refresh band's share of the ink over the glass (faces are checked against both, see the colour guard). */
const GRID_ALPHA = 0.12;
const SCAN_ALPHA = 0.1;

/** Gaps, em: between words, between key words, between rows (of the larger row). Cap height of the pixel faces, em. */
const GAP_BODY = 0.36;
const GAP_HERO = 0.5;
const ROW_GAP = 0.42;
const CAP = 0.62;
/** The cursor after a key word, em: gap, width. */
const CURSOR_GAP = 0.32;
const CURSOR_W = 0.52;
const BLINK = 280;

/** How long before its first word a cue's window opens, and a word's first step, ms. */
const LEAD = 100;
const HERO_LEAD = 80;
const HOLD = 150;
/** Share of a word showing at the glass edge in its first step. */
const PEEK = 0.3;
/** [ms before the spoken start, share of the travel left]. */
const BODY_STEPS = [[100, 1], [67, 0.55], [33, 0.2]] as const;
/** [ms before the spoken start, share of the drop and slide left]. */
const HERO_STEPS = [[80, 1], [50, 0.6], [20, 0.22]] as const;
const HERO_DROP = 0.3;
const HERO_SLIDE = 0.5;
const GHOST_MS = 420;
const GHOST = [0.26, 0.17, 0.08] as const;
const BRIDGE_MS = 700;
const MAX_LAYERS = 150;

const SPLITTABLE = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{M}\p{N}\p{P}\p{S}]+$/u;

const SCREEN_EDGE: Readonly<Record<string, string>> = { "#B8D18B": "#93AE66" };
const CASE = "#1A1F16";

/** A step function as keyframes: each value holds until just before the next time, then jumps. */
function steps(points: readonly (readonly [number, number])[]): Frames {
  const out: [number, number][] = [[points[0]![0], points[0]![1]]];
  for (const [at, value] of points.slice(1)) {
    const last = out.at(-1)!;
    if (value === last[1]) continue;
    if (at - 0.5 > last[0]) out.push([at - 0.5, last[1]]);
    out.push([Math.max(at, out.at(-1)![0] + 0.5), value]);
  }
  return out;
}

interface Item {
  readonly word: number;
  readonly part: number;
  readonly parts: number;
  readonly text: string;
  readonly hero: boolean;
  readonly face: TextPiece["face"];
  readonly size: number;
  readonly advance: number;
  readonly inkTop: number;
  readonly inkBottom: number;
}

interface Placed extends Item {
  readonly row: number;
  /** Centre of the advance, from the block's centre line. */
  readonly x: number;
  /** Baseline, from the block's top. */
  readonly baseline: number;
}

interface Row {
  readonly items: Placed[];
  readonly hero: boolean;
  readonly size: number;
  readonly top: number;
  readonly bottom: number;
  /** The cursor's left edge, from the block's centre line, when the row ends a key word. */
  readonly cursorX: number | null;
}

interface Block {
  readonly items: Placed[];
  readonly rows: Row[];
  readonly height: number;
}

type Measure = SceneInput["measure"];

/** A cue's rows at size factor `u` (canvas px per sample px), its widest row inside `column`, or the smallest that fits `innerH`. */
function layoutCue(cue: SceneCue, measure: Measure, u: number, column: number, innerH: number): Block {
  const rtl = cueDirection(cue) === "rtl";
  const heroed = cue.words.some((word) => word.role === "hero");
  const memo = new Map<string, { advance: number; inkTop: number; inkBottom: number }>();
  const at100 = (text: string, face: TextPiece["face"]) => {
    const key = `${face}\u0000${text}`;
    let m = memo.get(key);
    if (!m) {
      const r = measure(text, face, 100 * u, 0);
      m = { advance: r.advance / 100, inkTop: r.inkTop / 100, inkBottom: r.inkBottom / 100 };
      memo.set(key, m);
    }
    return m;
  };
  // Composed (NFC) before it is measured and broken, so a decomposed accent lays out exactly like the precomposed spelling.
  const texts = cue.words.map((word) => caps(word, cue).normalize("NFC"));

  const plan = (scale: number): Block => {
    const items: Item[] = [];
    cue.words.forEach((word, at) => {
      const hero = word.role === "hero";
      const face = hero ? HERO_FACE : BODY_FACE;
      const base = (hero ? HERO : heroed ? BODY : SOLO) * scale * u;
      const floor = (hero ? HERO_FLOOR : BODY_FLOOR) * u;
      // Width per px of size: the piece's measured advance, plus the cursor on the row that ends a key word.
      const reserve = hero ? CURSOR_GAP + CURSOR_W : 0;
      const perPx = (piece: string, last: boolean) => at100(piece, face).advance + (last ? reserve : 0);
      const text = texts[at]!;
      const item = (piece: string, part: number, parts: number, size: number): Item => {
        const m = at100(piece, face);
        return { word: at, part, parts, text: piece, hero, face, size, advance: m.advance * size, inkTop: m.inkTop * size, inkBottom: m.inkBottom * size };
      };
      if (perPx(text, true) * base <= column) {
        items.push(item(text, 0, 1, base));
        return;
      }
      const fit = column / perPx(text, true);
      const clusters = captionTextClusters(text);
      if (fit >= floor || !SPLITTABLE.test(text) || clusters.length < 2) {
        items.push(item(text, 0, 1, fit));
        return;
      }
      // The fewest pieces, cut between clusters at even widths, whose measured widths (the last with the cursor) fit at the floor.
      const prefix = clusters.map((_, c) => at100(clusters.slice(0, c + 1).join(""), face).advance);
      const full = prefix.at(-1)!;
      let parts = clusters;
      for (let k = Math.max(2, Math.ceil(((full + reserve) * floor) / column)); k <= clusters.length; k++) {
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
        const candidate = cuts.slice(1).map((end, j) => clusters.slice(cuts[j], end).join(""));
        if (candidate.every((piece, j) => perPx(piece, j === k - 1) * floor <= column)) {
          parts = candidate;
          break;
        }
      }
      const size = Math.min(base, ...parts.map((piece, j) => column / perPx(piece, j === parts.length - 1)));
      for (const [part, piece] of parts.entries()) items.push(item(piece, part, parts.length, size));
    });

    // Rows: runs of key words and runs of other words, balanced; a broken word's pieces take a row each.
    const rowsOfItems: Item[][] = [];
    let run: Item[] = [];
    const flush = () => {
      if (!run.length) return;
      const hero = run[0]!.hero;
      const size = Math.max(...run.map((item) => item.size));
      const reserve = hero ? (CURSOR_GAP + CURSOR_W) * size : 0;
      for (const row of balancedRows(run.map((item) => item.advance), (hero ? GAP_HERO : GAP_BODY) * size, column - reserve)) rowsOfItems.push(row.map((at) => run[at]!));
      run = [];
    };
    for (const item of items) {
      if (item.parts > 1) {
        flush();
        rowsOfItems.push([item]);
      } else {
        if (run.length && run[0]!.hero !== item.hero) flush();
        run.push(item);
      }
    }
    flush();

    const rows: Row[] = [];
    let y = 0;
    rowsOfItems.forEach((row, r) => {
      const hero = row[0]!.hero;
      const size = Math.max(...row.map((item) => item.size));
      const above = Math.max(CAP * size, ...row.map((item) => -item.inkTop));
      const below = Math.max(0, ...row.map((item) => item.inkBottom));
      if (r > 0) y += ROW_GAP * Math.max(size, rows[r - 1]!.size);
      const top = y;
      const baseline = top + above;
      const gap = (hero ? GAP_HERO : GAP_BODY) * size;
      const width = row.reduce((sum, item) => sum + item.advance, 0) + gap * (row.length - 1);
      // A key word's row ends in the cursor: the word stays centred unless the cursor would leave the column.
      const last = row.reduce((a, b) => (a.word > b.word || (a.word === b.word && a.part > b.part) ? a : b));
      const cursor = hero && last.part === last.parts - 1;
      const reserve = cursor ? (CURSOR_GAP + CURSOR_W) * size : 0;
      const overflow = Math.max(0, width / 2 + reserve - column / 2);
      let x = -width / 2 + (rtl ? overflow : -overflow);
      const placed: Placed[] = [];
      for (const i of rowVisualOrder(row.map((item) => item.text), rtl ? "rtl" : "ltr")) {
        const item = row[i]!;
        placed.push({ ...item, row: r, x: x + item.advance / 2, baseline });
        x += item.advance + gap;
      }
      const left = placed[0]!.x - placed[0]!.advance / 2;
      const right = placed.at(-1)!.x + placed.at(-1)!.advance / 2;
      rows.push({
        items: placed.sort((a, b) => a.word - b.word || a.part - b.part), hero, size, top, bottom: baseline + below,
        cursorX: cursor ? (rtl ? left - (CURSOR_GAP + CURSOR_W) * size : right + CURSOR_GAP * size) : null,
      });
      y = baseline + below;
    });
    return { items: rows.flatMap((row) => row.items), rows, height: y };
  };

  let block = plan(SCALES[0]);
  for (const scale of SCALES) {
    block = plan(scale);
    if (block.height <= innerH) return block;
  }
  // Taller than the window even at the smallest step: shrink until it fits (a lane on a short canvas).
  for (let tries = 0; tries < 6 && block.height > innerH; tries++) {
    u *= Math.max(0.5, (innerH / block.height) * 0.99);
    block = layoutCue(cue, measure, u, column, Number.POSITIVE_INFINITY);
  }
  return block;
}

interface Glass {
  readonly cx: number;
  readonly cy: number;
  readonly w: number;
  readonly h: number;
  readonly padX: number;
  readonly padY: number;
}

interface GlassSpan {
  readonly from: number;
  readonly to: number;
  /** The first glass of a lit run: it may power on. */
  readonly runStart: boolean;
  /** The frame the glass closes to a half-height slit with the last cue's last clear step, when it does. */
  readonly offAt: number | null;
}

interface CueSpan {
  /** The cue's words leave here: on the next cue's first painted ink inside a lit run, else at the window's end. */
  readonly textEnd: number;
  /** The two clear steps, when two painted frames fit after the last word's reading hold. */
  readonly exit: readonly [number, number] | null;
  readonly bridgedIn: boolean;
  readonly bridgedOut: boolean;
  /** The window this cue sits on (fixed for the whole cue). */
  readonly rect: Glass;
  /** The stretch of glass this cue draws, if it owns one (a cue too short for a glass of its own sits on its predecessor's). */
  readonly glass: GlassSpan | null;
}

interface Shared {
  readonly u: number;
  readonly spans: ReadonlyMap<number, CueSpan>;
}

/** A word's hard steps on the export grid: the poses before it lands ([time, share of the travel left]), its landing and its first pose. */
function wordTiming(startMs: number, hero: boolean, windowFrom: number, fps: number) {
  const from = Math.max(windowFrom, exportFrameAtOrAfter(startMs - (hero ? HERO_LEAD : LEAD), fps));
  const onset = exportFrameAtOrBefore(startMs, fps);
  const landing = onset >= from ? onset : from;
  const poses: [number, number][] = [];
  for (const [before, share] of hero ? HERO_STEPS : BODY_STEPS) {
    const at = exportFrameAtOrAfter(startMs - before, fps);
    if (at >= from && at < landing && !poses.some(([t]) => t === at)) poses.push([at, share]);
  }
  return { landing, poses, start: poses.length ? poses[0]![0] : landing };
}

/** The first export frame a cue paints ink on. */
const firstInkOf = (w: SpeechWindow, fps: number) =>
  Math.min(...w.cue.words.map((word) => exportFrameAtOrAfter(wordTiming(word.startMs, word.role === "hero", w.from, fps).start, fps)));

function prepare(input: SceneInput, fps: number): Shared {
  const space = sceneSpace(input, ANCHOR);
  const u = space.u;
  const margin = 4 + BEZEL * u;
  const maxH = (bounds: Box) => bounds.y2 - bounds.y1 - 2 * margin - CHIN * u;
  /** The window of a lane at height `height`; with `top`, that top edge is kept (as far as the lane allows). */
  const glassAt = (bounds: Box, height: number, top?: number): Glass => {
    const w = Math.max(40 * u, Math.min(GLASS_W * u, bounds.x2 - bounds.x1 - 2 * margin));
    const h = Math.max(40 * u, Math.min(height, maxH(bounds)));
    const lane = speechLaneSpace(space, bounds, ANCHOR);
    const cx = clamp(space.x(540), bounds.x1 + margin + w / 2, bounds.x2 - margin - w / 2);
    const cy = clamp(top === undefined ? lane.y(ANCHOR) : top + h / 2, bounds.y1 + margin + h / 2, bounds.y2 - margin - CHIN * u - h / 2);
    return { cx, cy, w, h, padX: Math.min(PAD_X * u, 0.065 * w), padY: Math.min(PAD_Y * u, 0.14 * h) };
  };

  // Lit runs: the shared layout's windows (the same call `galleryScene` makes), joined while the next cue of a lane follows the
  // last spoken word within 700 ms. A longer spoken pause clears the cue and powers the glass off.
  const windows = speechWindows(input, space.safe, LEAD, HOLD);
  const runs: SpeechWindow[][] = [];
  const lastRun = new Map<number, SpeechWindow[]>();
  for (const w of windows) {
    const run = lastRun.get(w.lane);
    const previous = run?.at(-1);
    if (run && previous && previous.bounds.y1 === w.bounds.y1 && previous.bounds.y2 === w.bounds.y2 && w.from >= previous.to && w.start - previous.spokenEnd <= BRIDGE_MS) run.push(w);
    else {
      const fresh = [w];
      runs.push(fresh);
      lastRun.set(w.lane, fresh);
    }
  }

  const spans = new Map<number, CueSpan>();
  for (const run of runs) {
    const bounds = run[0]!.bounds;
    const inks = run.map((w) => firstInkOf(w, fps));
    // Inside a run a cue's words stay until the next cue's first ink (never a frame of bare glass between them).
    const ends = run.map((w, k) => (k < run.length - 1 ? Math.max(w.to, inks[k + 1]!) : w.to));
    const exits = run.map((w, k) => {
      const frames = exportFrameTimes(Math.max(w.spokenEnd + HOLD, ends[k]! - 160), ends[k]!, fps);
      return frames.length >= 2 ? ([frames.at(-2)!, frames.at(-1)!] as const) : null;
    });

    // Height: the tallest cue of the run with at most three rows; a taller cue is an outlier with a taller window of its own, for
    // its own time only, its top edge where the run's is.
    const wide = glassAt(bounds, Number.POSITIVE_INFINITY);
    const column = wide.w - 2 * wide.padX;
    const blocks = run.map((w) => layoutCue(w.cue, input.measure, u, column, Number.POSITIVE_INFINITY));
    const pad = 2 * PAD_Y * u;
    const ordinary = blocks.filter((block) => block.rows.length <= 3).map((block) => block.height + pad);
    const runH = Math.min(maxH(bounds), Math.max(GLASS_MIN_H * u, ...ordinary));
    const heights = blocks.map((block) => (block.rows.length <= 3 ? runH : Math.min(maxH(bounds), Math.max(runH, block.height + pad))));

    // Stretches of glass of one height, cut at cues' first ink; one too short for two painted frames joins its neighbour (taller wins).
    const end = ends.at(-1)!;
    let stretches = run.map((_, k) => ({ first: k, from: inks[k]!, to: k < run.length - 1 ? inks[k + 1]! : end, h: heights[k]! }));
    const merge = (a: number) => {
      const [x, y] = [stretches[a]!, stretches[a + 1]!];
      stretches.splice(a, 2, { first: x.first, from: x.from, to: y.to, h: Math.max(x.h, y.h) });
    };
    for (let a = 0; a < stretches.length - 1; ) {
      if (stretches[a]!.h === stretches[a + 1]!.h) merge(a);
      else a++;
    }
    for (let a = 0; stretches.length > 1 && a < stretches.length; ) {
      if (exportFrameTimes(stretches[a]!.from, stretches[a]!.to, fps).length >= 2) a++;
      else {
        merge(a > 0 ? a - 1 : a);
        a = 0;
      }
    }
    stretches = stretches.filter((stretch) => stretch.to > stretch.from);
    const runTop = glassAt(bounds, runH).cy - runH / 2;
    run.forEach((w, k) => {
      const at = stretches.findIndex((stretch) => stretch.first <= k && (stretches[stretches.indexOf(stretch) + 1]?.first ?? run.length) > k);
      const stretch = stretches[at]!;
      const owns = stretch.first === k;
      spans.set(w.index, {
        textEnd: ends[k]!, exit: exits[k]!, bridgedIn: k > 0, bridgedOut: k < run.length - 1,
        rect: stretch.h === runH ? glassAt(bounds, runH) : glassAt(bounds, stretch.h, runTop),
        glass: owns ? { from: stretch.from, to: stretch.to, runStart: at === 0, offAt: at === stretches.length - 1 ? (exits.at(-1)?.[1] ?? null) : null } : null,
      });
    });
  }
  return { u, spans };
}

const reads = (a: string, b: string) => captionColourContrast(a, b) >= CAPTION_SCENE_BRAND_MIN_CONTRAST;

export const handheldProgram: SceneProgram = {
  build(input) {
    if (!input.cues.some((cue) => cue.words.length)) return { pieces: [] };
    const fps = input.fps ?? SCENE_DEFAULT_FPS;
    const shared = prepare(input, fps);
    const defaults = captionSceneMeta("handheld").colours;
    const c = input.colours;
    // Colours as drawn: both inks read at 3:1 on the plain glass, on the grid and on the grid under the refresh band, else the
    // style's own three colours are used.
    const backings = (primary: string, glassColour: string) => {
      const grid = mixColour(glassColour, primary, GRID_ALPHA);
      return [glassColour, grid, mixColour(grid, primary, SCAN_ALPHA)];
    };
    const brandOk = backings(c.primary, c.accent).every((backing) => reads(c.primary, backing) && reads(c.highlight, backing));
    const ink = brandOk ? c.primary : defaults.primary;
    const heroInk = brandOk ? c.highlight : defaults.highlight;
    const screen = brandOk ? c.accent : defaults.accent;
    const edge = SCREEN_EDGE[screen.toUpperCase()] ?? mixColour(screen, "#000000", 0.2);
    // Per-cue counters: cues with a key word and cues without count apart.
    const counters: number[] = [];
    let heroCues = 0;
    let plainCues = 0;
    for (const cue of input.cues) counters.push(cue.words.some((word) => word.role === "hero") ? heroCues++ : plainCues++);

    return galleryScene("handheld", ANCHOR, (ctx) => {
      const { cue, index, from: windowFrom } = ctx.window;
      const span = shared.spans.get(index);
      if (!span) return [];
      const u = shared.u;
      const rtl = ctx.rtl;
      const side = ctx.side;
      const words = cue.words;
      const { cx, cy, w: gw, h: gh, padX, padY } = span.rect;
      const column = gw - 2 * padX;
      const block = layoutCue(cue, input.measure, u, column, gh - 2 * padY);
      const top = cy - block.height / 2;
      const inner = { x1: cx - gw / 2 + RING * u, x2: cx + gw / 2 - RING * u, y1: cy - gh / 2 + RING * u, y2: cy + gh / 2 - RING * u };
      const to = span.textEnd;
      const [pose1, pose2] = span.exit ?? [to, to];
      const stop = span.exit ? pose1 : to;

      // Word timing, then power: after a pause the glass opens on the cue's first ink frame, with a one-frame half-height slit
      // when the cue's first row fits in it; the last cue of a run closes it to the same slit on its last clear step.
      const timings = new Map(block.items.map((item) => [item, wordTiming(words[item.word]!.startMs, item.hero, windowFrom, fps)] as const));
      const firstFrame = Math.min(...[...timings.values()].map((timing) => exportFrameAtOrAfter(timing.start, fps)));
      const opened = exportFrameAfter(firstFrame, fps);
      const firstRow = block.rows[0]!;
      const slitFits = top + firstRow.top >= cy - 0.25 * gh + RING * u && top + firstRow.bottom <= cy + 0.25 * gh - RING * u;
      const powerOn = span.glass !== null && span.glass.runStart && slitFits && opened < span.glass.to;
      const powerOff = span.exit !== null && !span.bridgedOut;
      const reach = gh / 2 - RING * u;
      const clipY = (sign: number): Frames => steps([
        [windowFrom, cy + sign * reach * (powerOn ? 0.5 : 1)],
        ...(powerOn ? [[opened, cy + sign * reach] as const] : []),
        ...(powerOff ? [[pose2, cy + sign * reach * 0.5] as const] : []),
      ]);
      const textClip: Clip = { x1: [[windowFrom, inner.x1]], x2: [[windowFrom, inner.x2]], y1: clipY(-1), y2: clipY(1) };

      const pieces: Piece[] = [];
      const shape = (suffix: string, z: number, from: number, until: number, path: readonly PathCmd[], track: Track, extra: Partial<ShapePiece> = {}): ShapePiece => ({
        id: `${ctx.id}:${suffix}`, kind: "shape", z, fromMs: from, toMs: until, path, track, ...extra,
      });

      // The window: case edge with its shadow, glass, grid, inner border (drawn by the cue that owns this stretch of glass).
      const glass = span.glass;
      if (glass) {
        const sy = steps([
          [glass.from, powerOn ? 0.5 : 1],
          ...(powerOn ? [[opened, 1] as const] : []),
          ...(glass.offAt !== null ? [[glass.offAt, 0.5] as const] : []),
        ]);
        const track: Track = { x: [[glass.from, cx]], y: [[glass.from, cy]], ...(sy.length > 1 ? { sy } : {}) };
        const at = (suffix: string, z: number, path: readonly PathCmd[], extra: Partial<ShapePiece>) => pieces.push(shape(suffix, z, glass.from, glass.to, path, track, extra));
        // The case: a dark edge round the glass with a deeper chin under it, so it reads as a device and stands off the
        // footage without a blurred shadow layer.
        at("lcdcase", 0, roundedRectPath(-gw / 2 - BEZEL * u, -gh / 2 - BEZEL * u, gw + 2 * BEZEL * u, gh + (2 * BEZEL + CHIN) * u, (RADIUS + BEZEL) * u), { fill: { colour: CASE } });
        at("lcd", 1, roundedRectPath(-gw / 2, -gh / 2, gw, gh, RADIUS * u), { fill: { colour: screen } });
        // The pixel grid: one drawn path of thin bars, both ways (the bars' crossings fill once, nonzero, in both renderers).
        const pitch = GRID_PITCH * u;
        const bar = GRID_BAR * u;
        const gx = gw / 2 - RING * u;
        const grid: PathCmd[] = [];
        for (let x = -gx + pitch; x < gx - bar; x += pitch) grid.push(...rectPath(x, -reach, bar, 2 * reach));
        for (let y = -reach + pitch; y < reach - bar; y += pitch) grid.push(...rectPath(-gx, y, 2 * gx, bar));
        at("lcdgrid", 2, grid, { fill: { colour: ink, alpha: GRID_ALPHA } });
        at("lcdring", 3, roundedRectPath(-gw / 2 + (RING / 2) * u, -gh / 2 + (RING / 2) * u, gw - RING * u, gh - RING * u, (RADIUS - RING / 2) * u), {
          stroke: { widthPx: RING * u, colour: edge },
        });
      }

      // Words. A word steps in from the glass edge its row's earlier words leave free (the right one, or the left one for right to
      // left), so it never passes over a word already on the glass; between earlier words on both sides it is simply there.
      const landings = new Map<string, number>();
      const shadow = (size: number) => [{ dx: 0.04 * size, dy: 0.04 * size, blur: 0, colour: ink, alpha: 0.2 }];
      for (const item of block.items) {
        const { landing, poses, start } = timings.get(item)!;
        landings.set(`${item.word}:${item.part}`, landing);
        const restX = cx + item.x;
        const baseline = top + item.baseline;
        const earlier = block.items.filter((other) => other.row === item.row && (other.word < item.word || (other.word === item.word && other.part < item.part)));
        const rightFree = earlier.every((other) => other.x < item.x);
        const leftFree = earlier.every((other) => other.x > item.x);
        const fromRight = rtl ? !leftFree && rightFree : rightFree;
        const moves = item.hero ? (fromRight ? rightFree : leftFree) : rightFree || leftFree;
        const dir = fromRight ? 1 : -1;
        // A word with no free edge keeps its pose times but holds its slot (the cue's first ink stays where the run planned it).
        const travel = !moves
          ? 0
          : item.hero
          ? HERO_SLIDE * item.size * dir
          : dir > 0
            ? inner.x2 - (restX - item.advance / 2) - PEEK * item.advance
            : -(restX + item.advance / 2 - inner.x1 - PEEK * item.advance);
        const xs: [number, number][] = [...poses.map(([t, share]) => [t, restX + share * travel] as [number, number]), [landing, restX]];
        if (span.exit) xs.push([pose1, restX - side * 0.17 * gw], [pose2, restX - side * 0.5 * gw]);
        const track: Track = {
          x: steps(xs),
          y: item.hero && moves && poses.length ? steps([...poses.map(([t, share]) => [t, baseline - share * HERO_DROP * item.size] as [number, number]), [landing, baseline]]) : [[start, baseline]],
        };
        const id = item.parts > 1 ? `${ctx.id}:w${item.word}l${item.part}` : `${ctx.id}:w${item.word}`;
        pieces.push({
          id, kind: "text", z: 6, fromMs: start, toMs: to, text: item.text, face: item.face, sizePx: item.size, letterSpacingEm: 0,
          fill: item.hero ? heroInk : ink, anchor: "baseline-center", language: cue.language, track, clip: textClip, shadows: shadow(item.size),
        });
        // The LCD ghost: a faded copy displaced up and back, behind the word, fading in three steps after the key word lands.
        if (item.hero) {
          const ghostEnd = Math.min(stop, landing + GHOST_MS);
          const fades = GHOST.map((alpha, k) => [exportFrameAtOrAfter(landing + (k * GHOST_MS) / 3, fps), alpha] as [number, number]).filter(([t], k, all) => k === 0 || t > all[k - 1]![0]);
          if (exportFrameTimes(landing, ghostEnd, fps).length >= 2) {
            pieces.push({
              id: `${id}ghost`, kind: "text", z: 5, fromMs: landing, toMs: ghostEnd, text: item.text, face: item.face, sizePx: item.size, letterSpacingEm: 0,
              fill: ink, anchor: "baseline-center", language: cue.language, clip: textClip,
              track: { x: [[landing, restX - side * 0.1 * item.size]], y: [[landing, baseline - 0.1 * item.size]], o: steps(fades) },
            });
          }
        }
      }

      // The blinking cursor after each key word's row, from its landing until the next one lands or the cue clears.
      const cursorRows = block.rows.filter((row) => row.cursorX !== null);
      const rowLanding = (row: Row) => Math.max(...row.items.map((item) => landings.get(`${item.word}:${item.part}`)!));
      cursorRows.forEach((row, k) => {
        const next = cursorRows[k + 1];
        const until = Math.min(stop, next ? rowLanding(next) : stop);
        const blinks: [number, number][] = [];
        for (let t = rowLanding(row) + 60, lit = true; t < until; t += BLINK, lit = !lit) {
          const at = exportFrameAtOrAfter(t, fps);
          // A last lit phase shorter than two frames is left dark.
          if (lit && exportFrameTimes(at, Math.min(until, at + BLINK), fps).length < 2) break;
          blinks.push([at, lit ? 1 : 0]);
        }
        // Too short to blink: a still cursor when two frames can hold it beside the key word.
        if (!blinks.length) {
          const at = exportFrameAtOrAfter(rowLanding(row), fps);
          if (exportFrameTimes(at, until, fps).length >= 2) blinks.push([at, 1]);
        }
        if (!blinks.length) return;
        const size = row.size;
        const baseline = top + row.items[0]!.baseline;
        const word = row.items.at(-1)!.word;
        const end = blinks.length > 1 && blinks.at(-1)![1] === 0 ? blinks.pop()![0] : until;
        pieces.push(shape(`w${word}cursor`, 6, blinks[0]![0], end, rectPath(0, -CAP * size, CURSOR_W * size, CAP * size), {
          x: [[blinks[0]![0], cx + row.cursorX!]], y: [[blinks[0]![0], baseline]], ...(blinks.length > 1 ? { o: steps(blinks) } : {}),
        }, { fill: { colour: heroInk } }));
      });

      // Beat: a refresh band scans the glass in four hard steps when the cue's first word lands.
      const firstLanding = Math.min(...landings.values());
      const band = Math.max(8 * u, 0.08 * (inner.y2 - inner.y1));
      const down = counters[index]! % 2 === 0;
      let scanTimes = [0, 45, 90, 135].map((d) => exportFrameAtOrAfter(firstLanding + d, fps)).filter((t, k, all) => k === 0 || t > all[k - 1]!);
      let scanEnd = exportFrameAfter(scanTimes.at(-1)!, fps);
      if (scanTimes.length < 3 || scanEnd > stop) {
        // A short cue: the same scan on the consecutive frames it has before the clear (two at least).
        const frames = exportFrameTimes(firstLanding, stop, fps);
        scanTimes = frames.slice(0, 4);
        scanEnd = frames[4] ?? stop;
      }
      if (scanTimes.length >= 2 && scanEnd <= stop) {
        const travel = inner.y2 - inner.y1 - band;
        const ys = scanTimes.map((t, k) => [t, inner.y1 + (travel * (down ? k : scanTimes.length - 1 - k)) / (scanTimes.length - 1)] as [number, number]);
        pieces.push(shape("scan", 3, scanTimes[0]!, scanEnd, rectPath(0, 0, inner.x2 - inner.x1, band), { x: [[scanTimes[0]!, inner.x1]], y: steps(ys) }, { fill: { colour: ink, alpha: SCAN_ALPHA } }));
      }

      // Beat: status pips in the glass's top corner (bottom corner when the text reaches up there), one lit per spoken word.
      const count = Math.min(words.length, 6);
      const pip = 14 * u;
      const pipGap = 8 * u;
      const pipsW = count * pip + (count - 1) * pipGap;
      const inset = { x: Math.max(RING * u + 10 * u, 0.5 * padX), y: Math.max(RING * u + 10 * u, 0.5 * padY) };
      // Each row is swept from its words to the edge they step in from, so a pip clears the whole sweep, not only the ink at rest.
      const rowBands = block.rows.map((row) => ({
        x1: rtl ? inner.x1 : Math.min(...row.items.map((item) => cx + item.x - item.advance / 2)),
        x2: rtl ? Math.max(...row.items.map((item) => cx + item.x + item.advance / 2)) : inner.x2,
        y1: top + row.top - 6 * u,
        y2: top + row.bottom + 6 * u,
      }));
      const corners = [
        { x: rtl ? cx - gw / 2 + inset.x : cx + gw / 2 - inset.x - pipsW, y: cy - gh / 2 + inset.y },
        { x: rtl ? cx + gw / 2 - inset.x - pipsW : cx - gw / 2 + inset.x, y: cy - gh / 2 + inset.y },
        { x: rtl ? cx - gw / 2 + inset.x : cx + gw / 2 - inset.x - pipsW, y: cy + gh / 2 - inset.y - pip },
        { x: rtl ? cx + gw / 2 - inset.x - pipsW : cx - gw / 2 + inset.x, y: cy + gh / 2 - inset.y - pip },
      ];
      const spot = corners.find((corner) => rowBands.every((r) => corner.x + pipsW <= r.x1 || corner.x >= r.x2 || corner.y + pip <= r.y1 || corner.y >= r.y2));
      const pipFrom = powerOn ? opened : firstFrame;
      if (spot && exportFrameTimes(pipFrom, stop, fps).length >= 2) {
        const startX = spot.x;
        const pipY = spot.y;
        for (let k = 0; k < count; k++) {
          const wordAt = Math.ceil(((k + 1) * words.length) / count) - 1;
          const lit = Math.max(pipFrom, landings.get(`${wordAt}:0`) ?? pipFrom);
          const x = startX + (rtl ? count - 1 - k : k) * (pip + pipGap);
          const o = lit > pipFrom ? steps([[pipFrom, 0.22], [lit, 0.9]]) : [[pipFrom, 0.9] as const];
          pieces.push(shape(`pip${k}`, 3, pipFrom, stop, rectPath(0, 0, pip, pip), { x: [[pipFrom, x]], y: [[pipFrom, pipY]], o }, { fill: { colour: ink } }));
        }
      }
      // At most 150 layers a cue, shadows counted: the beats go first, then the text's LCD shadow.
      const layers = (list: readonly Piece[]) => list.reduce((sum, piece) => sum + 1 + (piece.shadows?.length ?? 0) + (piece.kind === "shape" && piece.fill && piece.stroke ? 1 : 0), 0);
      let kept = pieces;
      if (layers(kept) > MAX_LAYERS) kept = kept.filter((piece) => !/:(?:scan|pip\d+|w\d+(?:ghost|cursor))$/.test(piece.id));
      if (layers(kept) > MAX_LAYERS) kept = kept.map((piece) => (piece.kind === "text" ? { ...piece, shadows: undefined } : piece));
      return kept;
    }, undefined, LEAD).build(input);
  },
};

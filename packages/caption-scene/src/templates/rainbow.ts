import type { DemoScript } from "../demo";
import { clamp, EASES, lerp, prog } from "../ease";
import { captionColourContrast } from "@narriflow/validators";
import { paintedFrameCount } from "../frame-grid";
import { sampleFrames } from "../frames";
import { rowsFromRoles } from "../layout";
import type { Box, Frames, Piece, ShapePiece, TextPiece } from "../scene";
import { polygonPath, sparklePath, starPath } from "../shapes";
import { caps, galleryScene, rowsOf } from "./gallery-layout";
import type { SpeechCell } from "./speech-layout";

/**
 * Rainbow (the sample's "Rainbow3D", `samples/templates/m67-rainbow3d.js`): candy-pastel 3D lettering. Ordinary words are fat
 * rounded white caps with a violet edge; behind each one a diagonal rainbow of six pastel bands runs down and to the right of
 * it. The key word is a yellow Lobster script with the same rainbow pouring out of it. On landing the face pops and the
 * extrusion unrolls from the face outward, band after band; hearts and stars ride beyond the end of the stripes.
 *
 * Changes from the sample, and why (Sol's gallery 6 review, 2026-11-25, and the shared gallery briefs):
 * - **All depth sits behind all faces.** The sample drew the rainbow of word one over word two. Every word's bands are painted
 *   first, every face after, so a rainbow never crosses ink. The key word's rainbow is drawn over the support words' so the
 *   key word wins the cue.
 * - **Depth is capped and unequal.** The key word keeps the six bands at 38 degrees but at most 120 px deep (the sample's 195 px
 *   crowded the row below and the top of the next word); support words take 32-48 px (a quarter of their size) and three of the
 *   bands (pink, yellow, blue), so three identical long trails no longer fight the hero. A band is one copy, on the key word
 *   and on a support word alike, each with a border that bridges the gap to the next band, so the run reads solid at a fraction
 *   of the sample's 30 copies (two copies per key-word band read a little smoother and cost a third more libass time: over the
 *   1.5x Headline budget).
 * - **Depth is cut before text shrinks.** The block (faces plus rainbow) is measured at the real fitted size; when it does not
 *   fit the caption band, the depth shortens first (down to a third), and only then does the shared fit scale the text. A long
 *   key word gets its own line; a word wider than the column at its size floor (110 px script, 96 px caps) breaks into the fewest
 *   rows that fit, cut where the measured widths balance (UNBELIEVABLE is two rows), never an orphan fragment or a false space.
 *   A lone ordinary word (minor or body) grows a quarter, as the sample grows a word alone on its row.
 * - **Readable at onset.** The sample started words 70 ms before they were spoken and popped them from 35 % scale. The face
 *   paints on its spoken start, fully opaque, popping 80 % -> 104 % -> 100 % in 110 ms (compressed into the word's own time when
 *   it is short, settling monotonically with no overshoot when three painted frames cannot fit, a static pose when two cannot);
 *   the cue window opens with no lead, so the exit keeps all its time; the bands unroll with a 10 ms stagger from the same frame.
 * - **A 8 px violet edge at 150 px type** (0.055 em) instead of the sample's 11 px, so the face is not all outline.
 * - **Two accents, not four,** 40-56 px, one heart and one star, placed beyond the outer band on a spot clear of every word and
 *   of every word's rainbow (the sample's four sat on the stripes and on neighbouring words). They cycle colours and which
 *   shape comes first by cue, tilt by a hash of the cue's text, and twinkle on a long hold.
 * - Real speech: the exit (the sample's 170 ms shrink, with the rainbow retracting) only runs when two painted frames fit after
 *   the reading hold; entrances never wait for the previous cue; nothing is indexed by cue (the sample's `breaks`, `ROW_TILT`
 *   and heart/star tables were); rows follow the cue's roles (words before the key word, the key word, words after it) and
 *   share a row only when they fit it.
 * - Every language: a word that cannot be split into letters is one piece (face, bands and all), a script the face lacks goes
 *   through the shared glyph-coverage fallback, case transforms use the cue's language, and an RTL cue mirrors the rainbow's
 *   direction, the row tilt and the pop.
 * - Extra recurring beats, on every cue, in the rainbow's own language: a white glint that runs along the upper edge of the key
 *   word's (or the last word's) rainbow as it lands (a compact static pose on a cue too short for the run) and again every 1.5 s
 *   of a long hold; the accents pop with a spring and twinkle in turn. (A breathing rainbow, the bands lengthening on a hold,
 *   was tried and dropped: it re-rasterised a dozen full-size copies every frame and cost a fifth of the style's render time.)
 * - Brand colours: white words, the key colour and the violet edge are the preset's three colours. The catalogue row's `readsOn`
 *   keeps a brand colour that vanishes against the edge out, and the program checks the pair it actually draws (face on edge,
 *   3:1) and falls back to the preset's own colours when it fails. The six bands stay the sample's pastels.
 */

export const RAINBOW_DEMO: DemoScript = {
  lines: [
    "start:b before you're:m ready:h@600",
    "small:b wins add:m up:h@520",
    "keep:b it:m simple:b",
    "post:b it:m today:h@560",
    "have:b fun:b",
  ],
  options: { rate: 215, gap: 40, cueGap: 200, tail: 660, lead: 320 },
};

const CAPS_FACE = "Fredoka Bold";
const SCRIPT_FACE = "Lobster";
const DEFAULT_FACE = "#FFFFFF";
const DEFAULT_HERO = "#FFE23F";
const DEFAULT_EDGE = "#3A1E80";
const BRAND_MIN_CONTRAST = 3;
const BODY = 150;
const MINOR = 92;
const HERO = 250;
const HERO_MIN = 110;
const BODY_MIN = 96;
const COLUMN = 820;
const GAP = 34;
const PADDING = 26;
const EDGE_EM = 0.055;
const DIR_DEG = 38;
const DIR = { x: Math.cos((DIR_DEG * Math.PI) / 180), y: Math.sin((DIR_DEG * Math.PI) / 180) };
const BANDS = ["#FF6B93", "#FFA03C", "#FFD83B", "#4FDB97", "#43B5FF", "#9B79FF"] as const;
/** A support word's short run keeps three of the six (pink, yellow, blue): the key word's six, drawn twice over, are the hero. */
const SUPPORT_BANDS = [0, 2, 4] as const;
const ACCENT_COLOURS = ["#FF6B93", "#FFD83B", "#43B5FF", "#4FDB97", "#FFA03C"] as const;
const HERO_DEPTH = 120;
const SUPPORT_DEPTH: readonly [number, number] = [32, 48];
const HERO_COPIES = 1;
const POP_MS = 110;
const BAND_STAGGER = 10;
const ROW_TILT = [-2.4, 1.6, -1.2] as const;
const REPEAT_MS = 1500;
const ACCENT_PX = [52, 44] as const;

const hash = (text: string) => {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619);
  return (h >>> 0) / 4294967296;
};

/** Words the face can draw letter by letter, and so can be broken across rows when one is wider than the column. */
const SPLITTABLE = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{N}\p{P}]+$/u;

interface Placed extends SpeechCell {
  readonly tilt: number;
  readonly py: number;
}

interface Item {
  readonly word: number;
  readonly part: number;
  readonly text: string;
  readonly hero: boolean;
  readonly size: number;
  readonly face: TextPiece["face"];
  readonly spacing: number;
}

/** The sample's heart as a polygon (24 points a lobe), `width` px across, so its bounds are its real ink. */
const heartPath = (width: number): ShapePiece["path"] => {
  const k = width / 1.7;
  const lobe = (p0: [number, number], p1: [number, number], p2: [number, number], p3: [number, number]) =>
    Array.from({ length: 12 }, (_, i) => {
      const t = (i + 1) / 12;
      const m = 1 - t;
      return [k * (m ** 3 * p0[0] + 3 * m * m * t * p1[0] + 3 * m * t * t * p2[0] + t ** 3 * p3[0]), k * (m ** 3 * p0[1] + 3 * m * m * t * p1[1] + 3 * m * t * t * p2[1] + t ** 3 * p3[1])] as [number, number];
    });
  return polygonPath([[0, 0.95 * k], ...lobe([0, 0.95], [-1.5, -0.1], [-0.8, -1.1], [0, -0.35]), ...lobe([0, -0.35], [0.8, -1.1], [1.5, -0.1], [0, 0.95])]);
};

// Words and bands paint on the spoken onset (no pre-roll), so the cue window opens with no lead: the exit keeps its time.
export const rainbowProgram = galleryScene("rainbow", 1290, (ctx) => {
  const { cue, to, bounds } = ctx.window;
  const { exit, exitAt, fps, side } = ctx;
  const c = ctx.input.colours;
  const u = ctx.space.u;
  const index = ctx.window.index;
  const seed = hash(cue.words.map((word) => word.text).join(" "));
  const tiltSign = (seed < 0.5 ? 1 : -1) * side;
  const dirX = side * DIR.x;
  // The pair that is actually drawn, a face on its violet edge, must read at 3:1; a brand colour that fails it (or an edge that
  // fails both faces) falls back to the preset's own colours.
  const reads = (face: string, edge: string) => captionColourContrast(face, edge) >= BRAND_MIN_CONTRAST;
  const edgeColour = reads(c.primary, c.accent) && reads(c.highlight, c.accent) ? c.accent : DEFAULT_EDGE;
  const plainFace = reads(c.primary, edgeColour) ? c.primary : DEFAULT_FACE;
  const heroFace = reads(c.highlight, edgeColour) ? c.highlight : DEFAULT_HERO;
  const pieces: Piece[] = [];

  const { lead, hero, tail } = rowsFromRoles(cue.words.map((word) => word.role));
  const heroed = hero.length > 0;
  const isHero = (at: number) => hero.includes(at);
  const shown = (at: number) => (isHero(at) ? cue.words[at]!.text : caps(cue.words[at]!, cue));
  const faceOf = (at: number): TextPiece["face"] => (isHero(at) ? SCRIPT_FACE : CAPS_FACE);
  const spacingOf = (at: number) => (isHero(at) || !SPLITTABLE.test(cue.words[at]!.text) ? 0 : 0.01);
  const at100 = (text: string, face: TextPiece["face"], spacing: number) => ctx.input.measure(text, face, 100 * u, spacing).advance / u;

  // Sizes: the key words share one size (as large as the column allows), every other word is the sample's size unless it
  // would not fit the column, and then it shrinks to a readable floor and breaks across rows below that.
  const heroWidth = hero.reduce((sum, at) => sum + at100(shown(at), SCRIPT_FACE, 0), 0) + (GAP * 0.9 * Math.max(0, hero.length - 1) * 100) / HERO;
  const heroSize = heroed ? clamp((COLUMN * 100) / Math.max(1, heroWidth), HERO_MIN, HERO) : 0;
  // A lone ordinary word (the sample's "have fun" one-liners) grows a quarter, as the sample grows a word alone on its row.
  const naturalOf = (at: number) => (isHero(at) ? heroSize : cue.words.length === 1 ? BODY * 1.25 : cue.words[at]!.role === "minor" ? MINOR : BODY);
  // A word wider than the column at its floor size breaks into the fewest rows that fit, cut where the measured widths balance
  // (UNBELIEVABLE is two rows, never UNBELI / EVABL / E). Fragments are separate rows: no space is ever put between them.
  const chunkAt = (text: string, face: TextPiece["face"], spacing: number, size: number): string[] => {
    const wide = (at100(text, face, spacing) * size) / 100;
    if (!SPLITTABLE.test(text) || wide <= COLUMN * 1.01) return [text];
    const chars = [...text];
    const prefix = (n: number) => (at100(chars.slice(0, n).join(""), face, spacing) * size) / 100;
    for (let rows = Math.max(2, Math.ceil(wide / (COLUMN * 0.97))); rows <= Math.min(chars.length, 8); rows++) {
      const cuts = [0];
      for (let k = 1; k < rows; k++) {
        let best = cuts[k - 1]! + 1;
        for (let n = best; n <= chars.length - (rows - k); n++) if (Math.abs(prefix(n) - (wide * k) / rows) < Math.abs(prefix(best) - (wide * k) / rows)) best = n;
        cuts.push(best);
      }
      cuts.push(chars.length);
      const parts = cuts.slice(1).map((end, k) => chars.slice(cuts[k], end).join(""));
      if (parts.every((part) => (at100(part, face, spacing) * size) / 100 <= COLUMN * 1.01)) return parts;
    }
    return chars.map((ch) => ch);
  };
  const items: Item[] = [];
  const indexes: number[][] = cue.words.map(() => []);
  cue.words.forEach((_word, at) => {
    const text = shown(at);
    const face = faceOf(at);
    const spacing = spacingOf(at);
    const natural = naturalOf(at);
    const floor = isHero(at) ? HERO_MIN : BODY_MIN;
    const fit = (COLUMN * 100) / Math.max(1, at100(text, face, spacing));
    const size = Math.max(Math.min(natural, fit), Math.min(natural, floor));
    for (const [part, piece] of chunkAt(text, face, spacing, size).entries()) {
      indexes[at]!.push(items.push({ word: at, part, text: piece, hero: isHero(at), size, face, spacing }) - 1);
    }
  });
  const chunked = (at: number) => indexes[at]!.length > 1;

  // Rows follow speech. Words before the key word, the key word, and words after it share a row when they fit the column,
  // else the key word takes its own line (a long script word never has to share). A broken word is a row per piece.
  const widthOf = (list: readonly number[]) =>
    list.reduce((sum, at) => sum + indexes[at]!.reduce((s, i) => s + (at100(items[i]!.text, items[i]!.face, items[i]!.spacing) * items[i]!.size) / 100, 0), 0) + GAP * Math.max(0, list.length - 1);
  const fits = (list: readonly number[]) => list.every((at) => !chunked(at)) && widthOf(list) <= COLUMN;
  const flow = (list: readonly number[]): number[][] => {
    const out: number[][] = [];
    let row: number[] = [];
    for (const at of list) {
      if (chunked(at)) {
        if (row.length) out.push(row);
        row = [];
        out.push(indexes[at]!);
      } else row.push(...indexes[at]!);
    }
    if (row.length) out.push(row);
    return out;
  };
  const all = cue.words.map((_, at) => at);
  let wordGroups: number[][];
  if (!heroed) wordGroups = [all];
  else if (fits(all)) wordGroups = [all];
  else if (lead.length > 0 && fits([...lead, ...hero]) && tail.length > 0) wordGroups = [[...lead, ...hero], tail];
  else if (tail.length > 0 && fits([...hero, ...tail])) wordGroups = lead.length ? [lead, [...hero, ...tail]] : [[...hero, ...tail]];
  else wordGroups = [lead, hero, tail].filter((group) => group.length > 0);
  const groups = wordGroups.flatMap(flow);

  const { cells: laid } = ctx.layout({
    column: COLUMN,
    padding: PADDING,
    gap: GAP,
    groups,
    words: items.map((item) => ({ text: item.text, size: item.size, face: item.face, spacing: item.spacing })),
  });
  const rows = rowsOf(laid).sort((a, b) => a[0]!.baseline - b[0]!.baseline);
  const rowOf = new Map<SpeechCell, number>();
  rows.forEach((row, r) => { for (const cell of row) rowOf.set(cell, r); });
  const rowCentre = rows.map((row) => (Math.min(...row.map((cell) => cell.x - cell.width / 2)) + Math.max(...row.map((cell) => cell.x + cell.width / 2))) / 2);
  const itemOf = (cell: SpeechCell) => items[cell.at]!;

  // The rainbow behind a face of this size, px at the rest pose, cut by `factor` when the block does not fit.
  const depthOf = (cell: SpeechCell, factor: number) => {
    const item = itemOf(cell);
    return (item.hero ? Math.min(HERO_DEPTH * u, cell.size * 0.48) : clamp(cell.size * 0.28, SUPPORT_DEPTH[0] * u, SUPPORT_DEPTH[1] * u)) * factor;
  };
  const edgeOf = (cell: SpeechCell) => cell.size * EDGE_EM;
  const faceBox = (cell: SpeechCell, dy = 0): Box => ({
    x1: cell.x - cell.width / 2 - edgeOf(cell), x2: cell.x + cell.width / 2 + edgeOf(cell),
    y1: cell.baseline + cell.inkTop - edgeOf(cell) + dy, y2: cell.baseline + cell.inkBottom + edgeOf(cell) + dy,
  });
  const reachBox = (cell: SpeechCell, factor: number, k = 1): Box => {
    const depth = depthOf(cell, factor) * k;
    const box = faceBox(cell);
    const dx = dirX * depth;
    const dyy = DIR.y * depth;
    return { x1: box.x1 + Math.min(0, dx), x2: box.x2 + Math.max(0, dx), y1: box.y1, y2: box.y2 + dyy };
  };
  const unionOf = (boxes: readonly Box[]): Box => ({
    x1: Math.min(...boxes.map((b) => b.x1)), x2: Math.max(...boxes.map((b) => b.x2)),
    y1: Math.min(...boxes.map((b) => b.y1)), y2: Math.max(...boxes.map((b) => b.y2)),
  });

  // Cut the depth, not the text, until the whole block (faces plus rainbow) sits in the caption band.
  const margin = 12 * u + 0.03 * Math.max(...laid.map((cell) => cell.size));
  const room = { w: bounds.x2 - bounds.x1 - 2 * margin, h: bounds.y2 - bounds.y1 - 2 * margin };
  let factor = 1;
  let block = unionOf(laid.map((cell) => reachBox(cell, factor)));
  for (let tries = 0; tries < 7 && (block.x2 - block.x1 > room.w || block.y2 - block.y1 > room.h); tries++) {
    factor *= 0.8;
    block = unionOf(laid.map((cell) => reachBox(cell, factor)));
  }
  // Centre the block, rainbow included; the layout centred the faces alone.
  const anchorY = ctx.space.y(1290);
  const wantX = ctx.space.x(540) - (block.x1 + block.x2) / 2;
  const wantY = anchorY - (block.y1 + block.y2) / 2;
  const sx = Math.min(Math.max(wantX, bounds.x1 + margin - block.x1), bounds.x2 - margin - block.x2);
  const sy = Math.min(Math.max(wantY, bounds.y1 + margin - block.y1), bounds.y2 - margin - block.y2);
  const cells: Placed[] = laid.map((cell) => {
    const r = rowOf.get(cell) ?? 0;
    const x = cell.x + sx;
    const baseline = cell.baseline + sy;
    const tilt = ROW_TILT[r % ROW_TILT.length]! * tiltSign;
    // A tilted row: each word rides the row's line as well as turning about itself.
    const py = baseline + (cell.inkTop + cell.inkBottom) / 2 + (x - (rowCentre[r]! + sx)) * Math.sin((tilt * Math.PI) / 180);
    return { ...cell, x, baseline, tilt, py };
  });

  // Everything every word's rainbow and face occupy, for placing the accents clear of all of it.
  const occupied: Box[] = cells.flatMap((cell) => [0, 0.34, 0.68, 1].map((k) => {
    const depth = depthOf(cell, factor) * k;
    const box = faceBox(cell);
    return { x1: box.x1 + dirX * depth, x2: box.x2 + dirX * depth, y1: box.y1 + DIR.y * depth, y2: box.y2 + DIR.y * depth };
  }));

  const out = (t: number) => (exit ? EASES.in(prog(t, exitAt, to - exitAt)) : 0);
  const fade = (from: number): Frames | undefined => (exit ? [[from, 1], [exitAt, 1], [to, 0, "in"]] : undefined);
  const lastAt = cue.words.length - 1;
  const markAt = heroed ? hero[0]! : lastAt;

  // Words in speaking order; the key words last, so their rainbow paints over the support words'.
  const order = cells.map((cell, i) => ({ cell, i })).sort((a, b) => Number(itemOf(a.cell).hero) - Number(itemOf(b.cell).hero) || a.cell.at - b.cell.at);
  const enterOf = new Map<number, ReturnType<typeof ctx.enter>>();
  const glints: { from: number; cell: Placed; depth: number; rz: number; wordEnd: number; settled: number }[] = [];

  for (const { cell } of order) {
    const item = itemOf(cell);
    const word = cue.words[item.word]!;
    const e = enterOf.get(item.word) ?? ctx.enter(word, POP_MS, 0);
    enterOf.set(item.word, e);
    const { from, settled, motion } = e;
    const span = Math.max(1, settled - from);
    const px = cell.x;
    const py = cell.py;
    const tilt = cell.tilt;
    const depth = depthOf(cell, factor);
    const restRz = tilt + (item.hero ? -4 * side : 0);
    const startRz = tilt + (item.hero ? -9 * side : -5 * side);
    const s0 = item.hero ? 0.72 : 0.8;
    const p = (t: number) => (motion ? clamp((t - from) / span) : 1);
    // The overshoot needs frames of its own; a shorter entrance settles monotonically.
    const bounces = paintedFrameCount(from, settled, fps) >= 3;
    const scale = (t: number) => {
      const q = p(t);
      const pop = !bounces ? lerp(s0, 1, EASES.out(q)) : q < 0.62 ? lerp(s0, 1.04, EASES.out(q / 0.62)) : lerp(1.04, 1, EASES.inOut((q - 0.62) / 0.38));
      return (motion ? pop : 1) * (1 - 0.35 * out(t));
    };
    const rise = (t: number) => (motion ? (item.hero ? 24 : 18) * u * (1 - EASES.out(p(t))) : 0);
    const rz = (t: number) => (motion ? lerp(startRz, restRz, EASES.out(p(t))) : restRz);
    const base = ctx.face(cell, from, item.hero ? heroFace : plainFace);
    const id = chunked(item.word) ? `${ctx.id}:w${item.word}l${item.part}` : `${ctx.id}:w${item.word}`;
    const origin = { dx: 0, dy: (cell.inkTop + cell.inkBottom) / 2 };
    const frames = (fn: (t: number) => number, edges: readonly number[], error: number): Frames =>
      sampleFrames(fn, [from, settled, from + span * 0.62, exitAt, to, ...edges], error, { range: [from, to], simplify: true });

    const scaleFrames = frames(scale, [], 0.01);
    const rzFrames = frames(rz, [], 0.2);

    // The rainbow, far bands first. Each band is a few copies spread over its sixth of the run.
    const copies = item.hero ? HERO_COPIES : 1;
    const bandIds: readonly number[] = item.hero ? BANDS.map((_, b) => b) : SUPPORT_BANDS;
    const steps = bandIds.length * copies;
    const bord = Math.max(2.4 * u, (depth / steps) * 0.55);
    const stagger = motion ? Math.min(BAND_STAGGER, span / 12) : 0;
    for (let n = bandIds.length - 1; n >= 0; n--) {
      const b = bandIds[n]!;
      const unroll = (t: number) => (motion ? EASES.outExpo(clamp((t - from - n * stagger) / Math.max(1, span - (bandIds.length - 1) * stagger))) : 1);
      for (let k = copies - 1; k >= 0; k--) {
        const fraction = (n * copies + k + 1) / steps;
        const reach = (t: number) => fraction * depth * unroll(t) * (1 - out(t));
        const copyId = `${ctx.id}:w${item.word}${item.part ? `l${item.part}` : ""}band${b}c${k}`;
        const piece: TextPiece = {
          ...base, id: copyId, z: item.hero ? 3 : 2, fill: BANDS[b]!, stroke: { colour: BANDS[b]!, widthPx: bord }, origin,
          track: {
            ...base.track,
            x: frames((t) => px + dirX * reach(t) * scale(t), [], 0.6),
            y: frames((t) => py + rise(t) + DIR.y * reach(t) * scale(t), [], 0.6),
            sx: scaleFrames, sy: scaleFrames, rz: rzFrames,
          },
        };
        // One soft shadow under the key word's run (the outermost copy's, low and short); a blur costs per frame, so support words take none.
        if (n === bandIds.length - 1 && k === copies - 1 && item.word === markAt) piece.shadows = [{ dx: 0, dy: 11 * u, blur: 4 * u, colour: edgeColour, alpha: 0.3 }];
        pieces.push(piece);
      }
    }

    pieces.push({
      ...base, id, z: item.hero ? 7 : 6, origin,
      stroke: { colour: edgeColour, widthPx: cell.size * EDGE_EM },
      track: { ...base.track, x: [[from, px]], y: frames((t) => py + rise(t), [], 0.6), sx: scaleFrames, sy: scaleFrames, rz: rzFrames },
    });

    if (item.word === markAt && item.part === 0) {
      glints.push({ from, cell, depth, rz: restRz, wordEnd: word.endMs, settled });
    }
  }

  // The glint: a small white sparkle running along the upper edge of the key word's rainbow, as it lands and every 1.5 s of a hold.
  for (const glint of glints) {
    const { cell } = glint;
    const startX = cell.x + side * (cell.width / 2 - 0.1 * cell.size);
    const startY = cell.baseline + cell.inkTop - edgeOf(cell) * 0.2;
    const runPx = glint.depth * 0.95;
    for (let burst = 0; burst < 3; burst++) {
      let t0 = glint.from + 150 + burst * REPEAT_MS;
      // A cue too short for the glint's usual start gets it at once, as a compact pose, so it still paints on ordinary speech.
      if (burst === 0 && paintedFrameCount(t0, Math.min(exitAt, t0 + 330), fps) < 3) t0 = glint.from;
      const t1 = Math.min(burst === 0 ? exitAt : to, t0 + 330);
      if (burst > 0 && t0 + 330 > exitAt) break;
      if (paintedFrameCount(t0, t1, fps) < 2) continue;
      const compact = paintedFrameCount(t0, t1, fps) < 4;
      const r = clamp(cell.size * 0.1, 14 * u, 24 * u);
      const track = {
        x: [[t0, startX], [t1, startX + dirX * runPx, "inOut"]] as Frames,
        y: [[t0, startY], [t1, startY + DIR.y * runPx, "inOut"]] as Frames,
        sx: compact ? ([[t0, 1]] as Frames) : ([[t0, 0.2], [(t0 + t1) / 2, 1, "out"], [t1, 0.2, "in"]] as Frames),
        sy: compact ? ([[t0, 1]] as Frames) : ([[t0, 0.2], [(t0 + t1) / 2, 1, "out"], [t1, 0.2, "in"]] as Frames),
        rz: [[t0, 0], [t1, 90]] as Frames,
        o: [[t0, compact ? 1 : 0], [t0 + 40, 1], [t1 - 60, 1], [t1, 0, "in"]] as Frames,
      };
      pieces.push({ ...ctx.shape(`glint${burst}`, t0, sparklePath(r), track, "#FFFFFF"), toMs: t1, z: 4 });
    }
  }

  // Two accents beyond the outer band: a heart and a star, on whichever spot touches no word and no rainbow.
  const anchorCell = cells.find((cell) => itemOf(cell).word === markAt && itemOf(cell).part === 0) ?? cells[cells.length - 1]!;
  const anchorEnter = enterOf.get(markAt) ?? ctx.enter(cue.words[markAt]!, POP_MS, 0);
  const placed: { x: number; y: number; r: number }[] = [];
  const spots = (cell: Placed, r: number) => {
    const depth = depthOf(cell, factor);
    const end = { x: cell.x + dirX * depth, y: cell.py + DIR.y * depth };
    const box = faceBox(cell);
    const farBox = { x1: box.x1 + dirX * depth, x2: box.x2 + dirX * depth, y1: box.y1 + DIR.y * depth, y2: box.y2 + DIR.y * depth };
    const gap = r + 10 * u;
    const outerX = side > 0 ? farBox.x2 + gap : farBox.x1 - gap;
    const nearX = side > 0 ? box.x1 - gap : box.x2 + gap;
    return [
      { x: outerX, y: (farBox.y1 + farBox.y2) / 2 }, { x: outerX, y: farBox.y1 - 0.2 * r }, { x: outerX, y: farBox.y2 - r },
      { x: (farBox.x1 + farBox.x2) / 2, y: farBox.y2 + gap }, { x: end.x, y: farBox.y2 + gap },
      { x: nearX, y: box.y1 - 0.3 * r }, { x: (box.x1 + box.x2) / 2, y: box.y1 - gap },
      { x: (box.x1 + box.x2) / 2 + side * cell.width * 0.28, y: box.y2 + depth * DIR.y * 0.55 + gap },
    ];
  };
  const hits = (x: number, y: number, r: number) => {
    let area = 0;
    // The accent's reach is its radius plus its twinkle and tilt; a word's box is widened by the row tilt and the pop.
    const reachR = r * 1.3;
    const slack = 9 * u;
    for (const box of occupied) {
      const dx = Math.min(x + reachR, box.x2 + slack) - Math.max(x - reachR, box.x1 - slack);
      const dyy = Math.min(y + reachR, box.y2 + slack) - Math.max(y - reachR, box.y1 - slack);
      if (dx > 0 && dyy > 0) area += dx * dyy;
    }
    for (const spot of placed) {
      const d = Math.hypot(x - spot.x, y - spot.y);
      if (d < r + spot.r + 6 * u) area += (r + spot.r) ** 2;
    }
    const out1 = Math.max(0, bounds.x1 + 4 * u - (x - r), x + r - (bounds.x2 - 4 * u), bounds.y1 + 4 * u - (y - r), y + r - (bounds.y2 - 4 * u));
    return area + out1 * 4000;
  };
  const accents = [0, 1].map((k) => {
    const shape = (index + k) % 2 === 0 ? "heart" : "star";
    const size = ACCENT_PX[k]! * u;
    const r = size / 2;
    const host = k === 0 ? anchorCell : cells[0]!;
    const start = (k === 0 ? 0 : 1) * 0.0;
    const pool = [...spots(host, r), ...(k === 1 ? spots(anchorCell, r) : [])];
    const pick = pool.map((spot, i) => ({ ...spot, score: hits(spot.x, spot.y, r) + i * 3 + (((i + index + k) * 7) % 5) * 0.6 })).reduce((best, spot) => (spot.score < best.score ? spot : best));
    placed.push({ x: pick.x, y: pick.y, r });
    return { shape, size, r, x: pick.x, y: pick.y, k, start };
  });
  accents.forEach((accent, k) => {
    const wordStart = cue.words[markAt]!.startMs;
    const roomAfter = paintedFrameCount(anchorEnter.from, exitAt, fps);
    const pop = anchorEnter.from + (k === 0 ? 70 : 150);
    const a0 = roomAfter >= 6 && paintedFrameCount(pop, to, fps) >= 4 ? pop : anchorEnter.from;
    const motion = a0 > anchorEnter.from || anchorEnter.motion;
    const landed = motion ? Math.min(a0 + 190, exitAt) : a0;
    const rot = (k === 0 ? -1 : 1) * (10 + 8 * hash(`${index}:${k}:${wordStart}`)) * side;
    const colour = ACCENT_COLOURS[(index + k * 2) % ACCENT_COLOURS.length]!;
    const twinkle = (t: number) => {
      if (landed >= exitAt - 400) return 1;
      const period = REPEAT_MS;
      const t1 = t - landed - 300 - k * (period / 2);
      if (t1 < 0) return 1;
      const phase = (t1 % period) / period;
      return 1 + 0.16 * Math.sin(Math.PI * Math.min(1, phase * 2.5)) ** 2 * (phase < 0.4 ? 1 : 0);
    };
    const edges: number[] = [];
    for (let t = landed + 300 + k * (REPEAT_MS / 2); t < exitAt; t += REPEAT_MS / 4) edges.push(t);
    const sc = (t: number) => (motion ? EASES.spring(clamp((t - a0) / Math.max(1, landed - a0))) : 1) * twinkle(t) * (1 - 0.6 * out(t));
    const path = accent.shape === "heart" ? heartPath(accent.size) : starPath(5, accent.r, accent.r * 0.46);
    const scale = sampleFrames((t) => Math.max(0.001, sc(t)), [a0, landed, exitAt, to, ...edges], 0.004, { range: [a0, to], simplify: true });
    const piece = ctx.shape(`accent${k}`, a0, path, {
      x: [[a0, accent.x]], y: [[a0, accent.y + (accent.shape === "heart" ? 0 : 0.06 * accent.r)]], sx: scale, sy: scale,
      rz: motion ? [[a0, rot - 50 * side], [landed, rot, "out"]] : [[a0, rot]],
      ...(exit ? { o: fade(a0) } : {}),
    }, colour);
    pieces.push({ ...piece, z: 5, stroke: { colour: "#FFFFFF", widthPx: Math.max(3 * u, accent.size * 0.06) } });
  });

  return pieces;
}, undefined, 0);

import type { DemoScript } from "../demo";
import { clamp, EASES, prog } from "../ease";
import { exportFrameAtOrBefore, paintedFrameCount } from "../frame-grid";
import { sampleFrames } from "../frames";
import type { SceneWord } from "../input";
import { rowsFromRoles } from "../layout";
import { mixColour, type Piece, type TextPiece, type Track } from "../scene";
import { ellipsePath } from "../shapes";
import { galleryScene, letterCells } from "./gallery-layout";
import type { SpeechCell } from "./speech-layout";

/**
 * Ripple (`samples/templates/m62-ripple.js`): bold rounded lyric type. Ordinary words rise softly into the line (the
 * newest glows pale cyan, then cools to white). When the key word is spoken a wave runs through its letters left to
 * right, 40 ms apart: each letter bobs up, swells a little and flashes cyan at the crest, then cools to the key colour.
 *
 * Changes from the sample, and why:
 * - **No row of dots** (owner, 2026-11-25). The flat dots under the key word, and the dot ripple under the last word of a
 *   key-less cue, are gone. The letter wave and the cyan-to-pink flash stay as the sample has them.
 * - The wave is the letters' own, so it never breaks shaping: a word in a script that cannot be split into letters
 *   (Devanagari, Arabic, Urdu, Bengali, Thai ...) or one longer than 18 letters is one piece that bobs and flashes as a
 *   whole with the same curve. Every letter's track is sampled from the one damped sine, so the wave is smooth.
 * - Reading order. The sample drew every ordinary word first and the key word under them; real cues put the key word
 *   anywhere, so rows follow speech (words before it, the key word alone, words after it) with a gap above the key word
 *   that is as tall as its crest, so a rising letter never touches the row above.
 * - Short key words. The 40 ms stagger and the 60 ms fade compress into the word's own time (a 100 ms key word is whole
 *   and opaque by its last painted frame); the wave itself keeps ringing out on its own 760 ms curve.
 * - Fit. The key word is fitted to the 880 px column (never past 236 px, never under 100 px), body and key sizes are
 *   sample sizes, and the lane shrink of the shared layout keeps everything inside the safe area at every aspect ratio.
 * - Real speech. The rise compresses to the word's spoken time, the exit (190 ms fade and 26 px drop) only runs when two
 *   painted frames fit after the reading hold, and nothing is cue-indexed (the sample's demo lines are the only table).
 * - Extra recurring beats, in the wave's own language, on every cue: concentric water rings that spread under the cue's
 *   last row, entirely below its ink so no arc runs behind a glyph, from the key word's wave on and every 1.5 s of a long
 *   hold (a window too short to animate them holds one compact ring); the
 *   wave reaching the words before the key word, which swell once after it, left to right; and in a cue with no key word
 *   the last word rides a small wave of its own (the sample's dot ripple, minus the dots).
 * - Brand colours: white words, the key colour and the cyan crest are the preset's three colours; the catalogue row's
 *   `readsOn` keeps a brand colour that vanishes on dark footage from replacing them.
 */

export const RIPPLE_DEMO: DemoScript = {
  lines: [
    "feel:b the:m wave:h@600",
    "it:m+450 carries:b you:b",
    "every:b little:b thing:b is:m gonna:m be:m alright:h@760",
    "just:m+450 breathe:b",
    "and:m let:b it:m flow:h@620",
  ],
  options: { rate: 275, cueGap: 150, tail: 820, lead: 380 },
};

const FACE = "Fredoka Bold";
const SPACING = 0.005;
const COLUMN = 880;
const BODY_HERO_CUE = 92;
const BODY_PLAIN_CUE = 124;
const MINOR_SCALE = 0.84;
const HERO_MAX = 236;
const HERO_MIN = 100;
const STAGGER = 40;
const WAVE_MS = 760;
const RISE_MS = 520;
const RISE_PX = 44;
const DROP_PX = 26;
const AMP_PX = 62;
const RING_MS = 820;
const RING_EVERY = 1500;
/** Where the letters scale from: this far above the baseline, in em. */
const PIVOT = 0.34;
const MINOR_TINT = "#9FB0CC";

/** Rises first, then rings out (the sample's `crest`). */
const crest = (p: number) => Math.sin(3 * Math.PI * p) * Math.exp(-3.4 * p);

const hash = (text: string) => {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619);
  return (h >>> 0) / 4294967296;
};

/** Words the face can draw letter by letter, and so can be broken across rows when one is wider than the column. */
const SPLITTABLE = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{N}\p{P}]+$/u;

/** The caption band of the sample (y 860..1650 of 1920, moving with the anchor), above and below the anchor line. */
const BAND_ABOVE = 1290 - 860;
const BAND_BELOW = 1650 - 1290;
const LANE_HERO_SHARE = 0.22;

interface Placed extends SpeechCell {
  readonly word: number;
  readonly part: number;
}

export const rippleProgram = galleryScene("ripple", 1290, (ctx) => {
  const { cue, from: cueFrom, to, bounds } = ctx.window;
  const { exit, exitAt, fps } = ctx;
  const c = ctx.input.colours;
  const space = ctx.space;
  const pieces: Piece[] = [];

  const { lead, hero, tail } = rowsFromRoles(cue.words.map((word) => word.role));
  const heroed = hero.length > 0;
  const naturalBody = heroed ? BODY_HERO_CUE : BODY_PLAIN_CUE;
  const waveAt = heroed ? hero[hero.length - 1]! : cue.words.length - 1;

  // The caption band: the sample's, at the user's position but not at the user's size (a larger size shrinks to fit it).
  const natural = space.u / ctx.input.scale;
  const anchorY = space.y(1290);
  const band = { y1: Math.max(bounds.y1 + 3, anchorY - BAND_ABOVE * natural), y2: Math.min(bounds.y2 - 3, anchorY + BAND_BELOW * natural) };

  // The key words share one size: as large as the column allows, never past the sample's cap. A lane shared with another
  // speaker keeps it to a share of the lane, so two speakers' key words come out alike.
  const at100 = (text: string) => ctx.input.measure(text, FACE, 100 * space.u, SPACING).advance / space.u;
  const laned = bounds.y2 - bounds.y1 < 0.75 * 0.9 * space.canvas.height;
  const heroMax = laned ? Math.min(HERO_MAX, (LANE_HERO_SHARE * (bounds.y2 - bounds.y1)) / space.u) : HERO_MAX;
  const heroWidth = hero.reduce((sum, at) => sum + at100(cue.words[at]!.text), 0) + 26 * Math.max(0, hero.length - 1);
  const heroFit = (COLUMN / Math.max(1, heroWidth)) * 100;
  // In a shared lane the words around the key word shrink with it, so the key word stays the largest piece of its cue.
  const body = laned ? Math.min(naturalBody, heroMax / 1.15) : naturalBody;
  let heroSize = heroed ? clamp(heroFit, Math.min(HERO_MIN, heroMax), heroMax) : 0;

  // A word wider than the column at a readable size breaks across rows, a row per piece, instead of shrinking to nothing.
  const chunkAt = (text: string, size: number): string[] => {
    if (!SPLITTABLE.test(text) || (at100(text) * size) / 100 <= COLUMN) return [text];
    const room = (COLUMN * 0.97 * 100) / size;
    const out: string[] = [];
    let row = "";
    for (const ch of text) {
      if (row && at100(row + ch) > room) {
        out.push(row);
        row = "";
      }
      row += ch;
    }
    if (row) out.push(row);
    return out;
  };
  const sizeOf = (at: number) => (hero.includes(at) ? heroSize : cue.words[at]!.role === "minor" ? body * MINOR_SCALE : body);
  const chunks = cue.words.map((word, at) => chunkAt(word.text, hero.length === 1 && hero[0] === at ? Math.max(sizeOf(at), Math.min(HERO_MIN, heroMax)) : sizeOf(at)));
  if (heroed && hero.length === 1 && chunks[hero[0]!]!.length > 1) {
    const widest = Math.max(...chunks[hero[0]!]!.map(at100));
    heroSize = clamp((COLUMN * 0.97 * 100) / widest, Math.min(HERO_MIN, heroMax), heroMax);
  }

  const flat: { word: number; part: number; text: string }[] = [];
  const indexes = chunks.map((texts, word) => texts.map((text, part) => flat.push({ word, part, text }) - 1));
  const groupsOf = (list: number[]) => {
    const out: number[][] = [];
    let row: number[] = [];
    for (const at of list) {
      if (indexes[at]!.length > 1) {
        if (row.length > 0) out.push(row);
        row = [];
        out.push(indexes[at]!);
      } else row.push(indexes[at]![0]!);
    }
    if (row.length > 0) out.push(row);
    return out;
  };
  const groups = [...groupsOf(lead), ...groupsOf(hero), ...groupsOf(tail)];

  const out = (t: number) => (exit ? EASES.in(prog(t, exitAt, to - exitAt)) : 0);
  const fresh = mixColour(c.accent, c.primary, 0.35);
  const minor = mixColour(c.primary, MINOR_TINT, 0.58);
  type Kind = "plain" | "mini" | "hero";
  const kindOf = (at: number): Kind => (hero.includes(at) ? "hero" : !heroed && at === waveAt ? "mini" : "plain");
  const ampOf = (cell: Placed, unit: number) => {
    const kind = kindOf(cell.word);
    return kind === "hero" ? Math.min(AMP_PX * unit, 0.26 * cell.size) : kind === "mini" ? 0.13 * cell.size : 0;
  };

  /** The cue laid out at size factor `f` and moved `dy`: its cells, its ring, and the vertical extent of everything it paints. */
  const arrange = (f: number, dy: number) => {
    const { cells: laid, unit: laidUnit } = ctx.layout({
      column: COLUMN,
      padding: 24,
      gap: body * 0.26 * f,
      groups,
      words: flat.map((item) => ({ text: item.text, size: sizeOf(item.word) * f, face: FACE, spacing: SPACING })),
    });
    const placed: Placed[] = laid.map((cell) => ({ ...cell, word: flat[cell.at]!.word, part: flat[cell.at]!.part }));
    const unit = laidUnit;
    const keyCell = heroed ? placed.find((cell) => cell.word === hero[0] && cell.part === 0)! : null;
    // Room above the key word for its crest: rows above it move up, it and the rows below move down, by half the gap each.
    const needed = keyCell && lead.length > 0 ? ampOf(keyCell, unit) * 0.6 : 0;
    const cells: Placed[] = placed.map((cell) => ({
      ...cell,
      baseline: cell.baseline + dy + (needed === 0 || !keyCell ? 0 : cell.baseline < keyCell.baseline - 1 ? -needed / 2 : needed / 2),
    }));

    // The rings sit entirely below the cue's last row of ink, its dip included, so no arc runs behind or through a glyph.
    const bottom = Math.max(...cells.map((cell) => cell.baseline));
    const lastRow = cells.filter((cell) => cell.baseline > bottom - 1);
    const rowLeft = Math.min(...lastRow.map((cell) => cell.x - cell.width / 2));
    const rowRight = Math.max(...lastRow.map((cell) => cell.x + cell.width / 2));
    const rowSize = Math.max(...lastRow.map((cell) => cell.size));
    const rowInk = Math.max(...lastRow.map((cell) => cell.inkBottom));
    const cx = (rowLeft + rowRight) / 2;
    const radius = Math.max(40 * unit, Math.min(Math.max((rowRight - rowLeft) * 0.72, 150 * unit), cx - bounds.x1 - 8 - 5 * unit, bounds.x2 - cx - 8 - 5 * unit));
    let flatness = Math.min(radius * 0.15, 0.2 * rowSize);
    const dip = 0.2 * Math.max(...lastRow.map((cell) => ampOf(cell, unit)));
    const cy = Math.min(bottom + rowInk + dip + 6 * unit + flatness, bounds.y2 - 8 - 5 * unit - flatness);
    flatness = Math.max(2, Math.min(flatness, bounds.y2 - 8 - 5 * unit - (bottom + rowInk)));

    let y1 = Number.POSITIVE_INFINITY;
    let y2 = Number.NEGATIVE_INFINITY;
    for (const cell of cells) {
      const kind = kindOf(cell.word);
      const amp = ampOf(cell, unit);
      const swell = kind === "plain" && lead.includes(cell.word) ? Math.min(10 * unit, 0.09 * cell.size) : 0;
      y1 = Math.min(y1, cell.baseline + cell.inkTop - Math.max(amp, swell) - (kind === "plain" ? 0 : 0.12 * cell.size));
      // A word rises in from below and every word drops on its exit, so the bottom reaches that far under its rest line.
      y2 = Math.max(y2, cell.baseline + cell.inkBottom + 0.2 * amp + 5 * unit + Math.max(kind === "hero" ? 0 : RISE_PX * unit, exit ? DROP_PX * unit : 0));
    }
    y2 = Math.max(y2, cy + flatness + 2.5 * unit);
    return { cells, unit, cx, cy, radius, flatness, y1, y2 };
  };

  let f = 1;
  let arranged = arrange(f, 0);
  for (let tries = 0; tries < 8; tries++) {
    const height = arranged.y2 - arranged.y1;
    const room = band.y2 - band.y1;
    if (height <= room + 0.5) break;
    f *= Math.min(0.95, (0.98 * room) / height);
    arranged = arrange(f, 0);
  }
  const dy = arranged.y1 < band.y1 ? band.y1 - arranged.y1 : arranged.y2 > band.y2 ? band.y2 - arranged.y2 : 0;
  if (dy !== 0) arranged = arrange(f, dy);
  const { cells, unit } = arranged;
  const shadows = [{ dx: 0, dy: 5 * unit, blur: 9 * unit, colour: c.shadow, alpha: 0.6 }];

  // The key word's wave reaches the words before it: they ride a small swell of their own, left to right.
  const heroWord = heroed ? cue.words[hero[0]!]! : null;
  const swellBase = heroWord ? Math.max(cueFrom, heroWord.startMs - 80) + 120 : 0;

  const speak = (word: SceneWord, at: number, wordCells: readonly Placed[]) => {
    const kind = kindOf(at);
    const first = wordCells[0]!;
    // Heroes wave letter by letter; a word broken across rows waves row by row; every other word moves whole.
    const parts: readonly SpeechCell[] = wordCells.length > 1 ? wordCells : kind === "hero" ? letterCells(first, ctx.input) : [first];
    const n = parts.length;
    const start = Math.max(cueFrom, word.startMs - (kind === "hero" ? 80 : 70));
    const last = exportFrameAtOrBefore(word.endMs - 1, fps);
    const avail = Math.max(0, last - start);
    // The fade and the stagger fit inside the word's own time: its last letter is opaque by its last painted frame.
    const ramp = clamp(avail * 0.4, 1, 65);
    const stagger = n > 1 ? clamp((avail - ramp) / (n - 1), 0, STAGGER) : 0;
    const onset = start >= word.startMs - 2 ? 0.5 : 0;
    const bump = kind === "hero" ? 0.1 : kind === "mini" ? 0.06 : 0;
    const flash = c.accent;
    const settle = kind === "hero" ? c.highlight : c.primary;
    const swellAt = swellBase + lead.indexOf(at) * 60;
    const swell = kind === "plain" && lead.includes(at) && word.startMs + 150 <= swellAt ? Math.min(10 * unit, 0.09 * first.size) : 0;
    const restFill = kind === "plain" ? (word.role === "minor" ? minor : fresh) : settle;

    parts.forEach((part, i) => {
      const ti = start + i * stagger;
      if (ti >= to - 1) return;
      const amp = ampOf({ ...part, word: at, part: i }, unit);
      const pivot = part.baseline - PIVOT * part.size;
      const settled = Math.max(ti, Math.min(ti + RISE_MS, last));
      const rises = kind !== "hero" && paintedFrameCount(ti, settled, fps) >= 2;
      const wave = (t: number) => clamp((t - ti) / WAVE_MS);
      const y = (t: number) =>
        pivot + (rises ? RISE_PX * unit * (1 - EASES.outExpo(prog(t, ti, settled - ti))) : 0) - amp * crest(wave(t)) - swell * crest(clamp((t - swellAt) / WAVE_MS)) + DROP_PX * unit * out(t);
      const scale = (t: number) => 1 + bump * Math.max(0, crest(wave(t)));
      const alpha = (t: number) => (onset + (1 - onset) * clamp((t - ti) / ramp)) * (1 - out(t));
      const edges = [ti, ti + ramp, settled, ti + WAVE_MS / 3, ti + (2 * WAVE_MS) / 3, ti + WAVE_MS, exitAt, to, ...(swell > 0 ? [swellAt, swellAt + WAVE_MS / 3, swellAt + (2 * WAVE_MS) / 3, swellAt + WAVE_MS] : [])];
      const frames = (fn: (t: number) => number, error: number) => sampleFrames(fn, edges, error, { range: [ti, to], simplify: true });
      const track: Track = { y: frames(y, 0.15), o: frames(alpha, 0.004) };
      if (bump > 0) {
        const s = frames(scale, 0.003);
        track.sx = s;
        track.sy = s;
      }
      if (kind === "plain") {
        if (word.role !== "minor") track.colour = [[ti, fresh], [Math.max(ti + 1, word.startMs + RISE_MS), c.primary, "out"]];
      } else {
        track.colour = [[ti, flash], [ti + WAVE_MS / 1.2, settle, "out"]];
      }
      const id = n > 1 ? `${ctx.id}:w${at}l${i}` : `${ctx.id}:w${at}`;
      const face: TextPiece = { ...ctx.face(part, ti, restFill, track), id, origin: { dx: 0, dy: -PIVOT * part.size }, shadows };
      pieces.push(face);
    });
  };

  cue.words.forEach((word, at) => {
    speak(word, at, cells.filter((cell) => cell.word === at).sort((a, b) => a.part - b.part));
  });

  // Water rings spread under the word the wave crosses, again every 1.5 s of a long hold. A window too short to animate
  // them holds one compact ring instead.
  const waveWord = cue.words[waveAt]!;
  const seed = hash(cue.words.map((word) => word.text).join(" "));
  const ringsPer = seed < 0.5 ? 2 : 3;
  const { cx, cy, radius, flatness } = arranged;
  const ringStart = Math.max(cueFrom, waveWord.startMs - 80);
  for (let burst = 0; burst < 3; burst++) {
    for (let k = 0; k < ringsPer; k++) {
      const t0 = ringStart + burst * RING_EVERY + k * 170;
      const t1 = Math.min(to, t0 + RING_MS);
      if (t0 + 400 > exitAt && burst > 0) continue;
      const painted = paintedFrameCount(t0, t1, fps);
      if (painted < 2) continue;
      const compact = painted < 6;
      const edges = [t0, t0 + 60, t1, exitAt];
      const frames = (fn: (t: number) => number, error: number) => sampleFrames(fn, edges, error, { range: [t0, t1], simplify: true });
      const grow = (t: number) => (compact ? 0.7 : 0.1 + 0.9 * EASES.out(prog(t, t0, RING_MS)));
      const alpha = (t: number) => (compact ? 0.6 : 0.8 * (0.3 + 0.7 * clamp((t - t0) / 60)) * (1 - prog(t, t0 + 60, RING_MS - 60))) * (1 - out(t));
      const ring = ctx.shape(`ring${burst}-${k}`, t0, ellipsePath(0, 0, radius, flatness), {
        x: [[t0, cx]], y: [[t0, cy]], sx: frames(grow, 0.003), sy: frames(grow, 0.003), o: frames(alpha, 0.004),
      });
      pieces.push({ ...ring, toMs: t1, stroke: { widthPx: 5 * unit, colour: c.accent } });
    }
  }
  return pieces;
});

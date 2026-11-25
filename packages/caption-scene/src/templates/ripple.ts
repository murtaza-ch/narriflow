import type { DemoScript } from "../demo";
import { clamp, EASES, prog } from "../ease";
import { exportFrameAtOrBefore, paintedFrameCount } from "../frame-grid";
import { sampleFrames } from "../frames";
import type { SceneWord } from "../input";
import { rowsFromRoles } from "../layout";
import { mixColour, type Piece, type TextPiece, type Track } from "../scene";
import { ellipsePath } from "../shapes";
import { galleryScene, letterCells, rectClip } from "./gallery-layout";
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
 * - Extra recurring beats, in the wave's own language, on every cue: concentric water rings that spread under the key
 *   word (under the last word of a cue with no key word) as the wave crosses it, repeated every 1.5 s of a long hold; the
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

type Kind = "plain" | "mini" | "hero";

export const rippleProgram = galleryScene("ripple", 1290, (ctx) => {
  const { cue, from: cueFrom, to, bounds } = ctx.window;
  const { exit, exitAt, fps } = ctx;
  const c = ctx.input.colours;
  const space = ctx.space;
  const pieces: Piece[] = [];

  const { lead, hero, tail } = rowsFromRoles(cue.words.map((word) => word.role));
  const heroed = hero.length > 0;
  const body = heroed ? BODY_HERO_CUE : BODY_PLAIN_CUE;
  const waveAt = heroed ? hero[hero.length - 1]! : cue.words.length - 1;

  // The key words share one size: as large as the column allows, never past the sample's cap.
  const at100 = (text: string) => ctx.input.measure(text, FACE, 100 * space.u, SPACING).advance / space.u;
  const heroWidth = hero.reduce((sum, at) => sum + at100(cue.words[at]!.text), 0) + 26 * Math.max(0, hero.length - 1);
  const heroSize = heroed ? clamp((COLUMN / Math.max(1, heroWidth)) * 100, HERO_MIN, HERO_MAX) : 0;
  const sizeOf = (at: number) => (hero.includes(at) ? heroSize : cue.words[at]!.role === "minor" ? body * MINOR_SCALE : body);

  const { cells: laidOut, unit } = ctx.layout({
    column: COLUMN,
    padding: 24,
    gap: body * 0.26,
    groups: [lead, hero, tail].filter((group) => group.length > 0),
    words: cue.words.map((word, at) => ({ text: word.text, size: sizeOf(at), face: FACE, spacing: SPACING })),
  });

  // Room above the key word for its crest: rows above it move up, it and the rows below move down, by half the gap each.
  const cellOf = (at: number) => laidOut.find((cell) => cell.at === at)!;
  const crestPx = (cell: SpeechCell) => Math.min(AMP_PX * unit, 0.26 * cell.size);
  const keyCell = heroed ? cellOf(hero[0]!) : null;
  const needed = keyCell && lead.length > 0 ? crestPx(keyCell) * 0.6 : 0;
  const cells = laidOut.map((cell) => {
    if (needed === 0 || !keyCell) return cell;
    return { ...cell, baseline: cell.baseline + (cell.baseline < keyCell.baseline - 1 ? -needed / 2 : needed / 2) };
  });

  const out = (t: number) => (exit ? EASES.in(prog(t, exitAt, to - exitAt)) : 0);
  const shadows = [{ dx: 0, dy: 5 * unit, blur: 9 * unit, colour: c.shadow, alpha: 0.6 }];
  const fresh = mixColour(c.accent, c.primary, 0.35);
  const minor = mixColour(c.primary, MINOR_TINT, 0.58);

  // The key word's wave reaches the words before it: they ride a small swell of their own, left to right.
  const heroWord = heroed ? cue.words[hero[0]!]! : null;
  const swellBase = heroWord ? Math.max(cueFrom, heroWord.startMs - 80) + 120 : 0;

  const speak = (word: SceneWord, cell: SpeechCell, kind: Kind) => {
    const parts = kind === "plain" ? [cell] : letterCells(cell, ctx.input);
    const n = parts.length;
    const start = Math.max(cueFrom, word.startMs - (kind === "hero" ? 80 : 70));
    const last = exportFrameAtOrBefore(word.endMs - 1, fps);
    const avail = Math.max(0, last - start);
    // The fade and the stagger fit inside the word's own time: its last letter is opaque by its last painted frame.
    const ramp = clamp(avail * 0.4, 1, 65);
    const stagger = n > 1 ? clamp((avail - ramp) / (n - 1), 0, STAGGER) : 0;
    const onset = start >= word.startMs - 2 ? 0.5 : 0;
    const amp = kind === "hero" ? crestPx(cell) : kind === "mini" ? 0.13 * cell.size : 0;
    const bump = kind === "hero" ? 0.1 : kind === "mini" ? 0.06 : 0;
    const flash = c.accent;
    const settle = kind === "hero" ? c.highlight : c.primary;
    const swellAt = swellBase + lead.indexOf(cell.at) * 60;
    const swell = kind === "plain" && lead.includes(cell.at) && word.startMs + 150 <= swellAt ? Math.min(10 * unit, 0.09 * cell.size) : 0;
    const restFill = kind === "plain" ? (word.role === "minor" ? minor : fresh) : settle;

    parts.forEach((part, i) => {
      const ti = start + i * stagger;
      if (ti >= to - 1) return;
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
      const id = n > 1 ? `${ctx.id}:w${cell.at}l${i}` : `${ctx.id}:w${cell.at}`;
      const face: TextPiece = { ...ctx.face(part, ti, restFill, track), id, origin: { dx: 0, dy: -PIVOT * part.size }, shadows };
      pieces.push(face);

    });
  };

  for (const cell of cells) {
    const word = cue.words[cell.at]!;
    const kind: Kind = hero.includes(cell.at) ? "hero" : !heroed && cell.at === waveAt ? "mini" : "plain";
    speak(word, cell, kind);
  }

  // Water rings spread under the word the wave crosses, again every 1.5 s of a long hold.
  const waveCell = cells.find((cell) => cell.at === waveAt)!;
  const waveWord = cue.words[waveAt]!;
  const seed = hash(cue.words.map((word) => word.text).join(" "));
  const ringsPer = seed < 0.5 ? 2 : 3;
  const cx = waveCell.x;
  const radius = Math.max(40 * unit, Math.min(Math.max(waveCell.width * 0.72, 150 * unit), cx - bounds.x1 - 6, bounds.x2 - cx - 6));
  const flat = radius * 0.15;
  const cy = Math.min(waveCell.baseline + 0.2 * waveCell.size, bounds.y2 - 4 - flat);
  // The rings run behind the words after the key word, never through them: those rows are cut out of the ring.
  const tailCells = cells.filter((cell) => tail.includes(cell.at));
  const tailBox = tailCells.length
    ? {
        x1: Math.min(...tailCells.map((cell) => cell.x - cell.width / 2)) - 6 * unit,
        x2: Math.max(...tailCells.map((cell) => cell.x + cell.width / 2)) + 6 * unit,
        y1: Math.min(...tailCells.map((cell) => cell.baseline + cell.inkTop)) - 4 * unit,
        y2: Math.max(...tailCells.map((cell) => cell.baseline + cell.inkBottom)) + 4 * unit,
      }
    : null;
  const ringStart = Math.max(cueFrom, waveWord.startMs);
  for (let burst = 0; burst < 3; burst++) {
    for (let k = 0; k < ringsPer; k++) {
      const t0 = ringStart + burst * RING_EVERY + k * 170;
      const t1 = Math.min(to, t0 + RING_MS);
      if (t0 + 400 > exitAt && burst > 0) continue;
      if (paintedFrameCount(t0, t1, fps) < 2) continue;
      const edges = [t0, t0 + 60, t1, exitAt];
      const frames = (fn: (t: number) => number, error: number) => sampleFrames(fn, edges, error, { range: [t0, t1], simplify: true });
      const grow = (t: number) => 0.1 + 0.9 * EASES.out(prog(t, t0, RING_MS));
      const alpha = (t: number) => 0.8 * clamp((t - t0) / 60) * (1 - prog(t, t0 + 60, RING_MS - 60)) * (1 - out(t));
      const ring = ctx.shape(`ring${burst}-${k}`, t0, ellipsePath(0, 0, radius, flat), {
        x: [[t0, cx]], y: [[t0, cy]], sx: frames(grow, 0.003), sy: frames(grow, 0.003), o: frames(alpha, 0.004),
      });
      pieces.push({ ...ring, toMs: t1, stroke: { widthPx: 5 * unit, colour: c.accent }, ...(tailBox ? { clip: { ...rectClip(t0, tailBox), inverse: true } } : {}) });
    }
  }
  return pieces;
});

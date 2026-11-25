import type { DemoScript } from "../demo";
import { EASES, type Frames, clamp, prog } from "../ease";
import { exportFrameAtOrBefore, sceneSampleRate } from "../frame-grid";
import { sampleFrames } from "../frames";
import type { SceneProgram } from "../input";
import type { Clip, Piece, TextPiece } from "../scene";
import { mixColour } from "../scene";
import { caps, galleryScene } from "./gallery-layout";
import type { SpeechCell } from "./speech-layout";

/**
 * Blinds (`samples/templates/m59-blinds.js`, gallery 5): every word opens like venetian blinds. Six vertical slats, each a clipped
 * copy of the word, sweep open one after another along the reading direction, the key word in hot pink with a white flash as the
 * last slat lands; at the end of a line the slats close again, the other way round. Once a word is open only one plain copy of it
 * is left on screen.
 *
 * Changes from the sample, and why:
 * - **Rows come from the words.** The sample sizes a cue by its role (330 px alone, 168 with no key word, 124 body and up to 250
 *   for the key word, the key word on its own row) and fits the key word by character count. Here a run of key words and each run
 *   of other words are laid out by their measured widths: the key row is fitted to 820 px with a floor, a word wider than the
 *   column shrinks alone, and a word that would fall below half its size (the 45-letter word of the long-word demo) is broken into
 *   rows of equal pieces, each opened with the same blinds, at a readable size. Languages that shape (Devanagari, Arabic) are never
 *   split: a slat is a clip, so every script opens the same way, mirrored for right-to-left cues (slats open right to left and
 *   close left to right).
 * - **Real speech.** The reveal is locked to the word: it starts 60 ms before the word (never earlier than the cue's window gives)
 *   and is finished one frame before the spoken end, the stagger squeezed with it (a word too short for two painted
 *   frames of every slat is drawn open at once). The slats are only ever slices of their own word, each handed over to the plain
 *   face the moment it is open. Nothing closes before the last word's spoken
 *   end plus 150 ms; the close takes whatever time the next cue leaves and is a cut when it leaves less than three frames.
 * - **The face is one piece, and no line is drawn.** The word's readable face is a single piece from its first frame: its clip is
 *   the first slat while it opens, then every slat that is open whole (a finished slat is absorbed into the face, so no slat edge
 *   is ever painted inside an open part of the word, in the Studio's DOM painter as in the export), the whole word at rest, and
 *   the first slat again as the blinds close (the sample's tail where the last 12 % of a slat is finished at once is kept). The
 *   other five slats are one piece each that opens its part of the word until the face takes it over, is invisible (empty clip,
 *   opacity 0) while the word rests, and closes it again, so no slat is ever drawn over a readable word and a nine-word cue
 *   costs about 111 of its 150 pieces and shadow layers. The style draws nothing but words: no rule, bars or underline.
 * - **Shared lanes and the band.** Two overlapping speakers scale to a share of their lane, so both captions come out alike; the
 *   whole block is fitted into the sample's caption band (y 860..1650 around the anchor, at the natural size), so a long word broken
 *   over several rows never fills the frame. A broken word is cut between whole letters (graphemes), never between a letter and
 *   its combining mark.
 * - **Colours go through the brand map.** Body words are the primary colour, the key word the highlight, the outline the accent
 *   (the guard checks both against it).
 * - **Shadow.** The sample's 0.05 em / 0.16 em soft shadow is one blurred copy (sigma 0.08 em) per slat; the stroke is half the
 *   sample's CSS stroke (CSS strokes are centred, `\bord` is not).
 */

export const BLINDS_DEMO: DemoScript = {
  lines: [
    "nobody:b cares:b about:b your:m excuses:h@560",
    "they:m care:b about:m results:h@580",
    "so:m stop:b talking:b",
    "start:b doing:h@500",
    "now:b@560",
  ],
  options: { rate: 245, cueGap: 160, lead: 380, tail: 720, gap: 30 },
};

const FACE: TextPiece["face"] = "Anton";
const ANCHOR = 1290;
const SLATS = 6;
/** Sample px. */
const BODY = 124;
const NO_HERO = 168;
const SOLO = 330;
const HERO = 250;
const COLUMN = 900;
const HERO_COLUMN = 820;
const WORD_COLUMN = 880;
/** The caption band of the sample (y 860..1650 of 1920, moving with the anchor). */
const BAND_ABOVE = ANCHOR - 860;
const BAND_BELOW = 1650 - ANCHOR;
/** A typical tall block (a lead row or two, the key row, a tail row), sample px: a shared lane scales sizes to fit it. */
const LANE_BLOCK = 843;
const GAP = 42;
const PAD = 6;
const TRACKING = 0.012;
const LEAD = 60;
const STAGGER = 24;
const OPEN = 150;
/** The sample finishes the last 12 % of a slat at once: a slat is open at this share of its time. */
const FULL_AT = 1 - (1 - 1 / 1.14) ** (1 / 5);
const FULL_MS = (SLATS - 1) * STAGGER + FULL_AT * OPEN;
const EXIT_WORD = 18;
const EXIT_SLAT = 16;
const EXIT_SLAT_MAX = 90;
const MIN_FRAMES = 2.3;
const FLASH_MS = 470;
const SIMPLE = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Common}\p{Script=Inherited}]+$/u;
const PICTO = /\p{Extended_Pictographic}/u;
const WHITE = "#FFFFFF";

interface Unit {
  /** Index of the spoken word. */
  readonly word: number;
  /** The piece of a broken word, or null for a whole word. */
  readonly part: number | null;
  readonly parts: number;
  readonly text: string;
  /** Sample px. */
  readonly size: number;
  readonly nominal: number;
  readonly hero: boolean;
  readonly spacing: number;
}

const sampled = (fn: (t: number) => number, from: number, to: number, edges: readonly number[]): Frames =>
  to - from < 1 ? [[from, fn(from)]] : sampleFrames(fn, edges, 0.25, { range: [from, to], wholeMs: true });

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemes = (text: string): string[] => [...SEGMENTER.segment(text)].map((part) => part.segment);

/** The pieces of a word broken into `n` runs of equal length, never between a letter and its combining marks. */
function breakInto(text: string, n: number): string[] {
  const letters = graphemes(text);
  const size = Math.ceil(letters.length / n);
  return Array.from({ length: Math.ceil(letters.length / size) }, (_, at) => letters.slice(at * size, (at + 1) * size).join(""));
}

export const blindsProgram: SceneProgram = galleryScene("blinds", ANCHOR, (ctx) => {
  const { input, window, id, rtl, fps, space, exit: exitCapable, exitAt } = ctx;
  const { cue, to } = window;
  const frame = 1000 / sceneSampleRate(fps);
  const u = space.u;
  const hasHero = cue.words.some((word) => word.role === "hero");
  const solo = cue.words.length === 1;
  const accent = input.colours.accent;
  const heroColour = input.colours.highlight;
  const bodyColour = input.colours.primary;
  const bounds = window.bounds;

  // Two speakers share the height: sizes scale to a share of the lane, not to their own rows, so both captions come out alike.
  const laned = bounds.y2 - bounds.y1 < 0.75 * 0.9 * space.canvas.height;
  const lane = laned ? Math.min(1, (bounds.y2 - bounds.y1) / (u * LANE_BLOCK)) : 1;
  // The caption band: the sample's, at the user's position but not at the user's size (a larger size shrinks to fit it).
  const natural = u / input.scale;
  const anchorY = space.y(ANCHOR);
  const band = { y1: Math.max(bounds.y1 + 3, anchorY - BAND_ABOVE * natural), y2: Math.min(bounds.y2 - 3, anchorY + BAND_BELOW * natural) };

  const adv = (text: string, size: number, spacing: number) => input.measure(text, FACE, size * u, spacing).advance / u;
  const texts = cue.words.map((word) => caps(word, cue));
  const spacingOf = (at: number) => (SIMPLE.test(texts[at]!) && !PICTO.test(texts[at]!) ? TRACKING : 0);

  /** The cue's rows at fit factor `f`: runs of key words and of the other words; a word too wide for its run is shrunk alone, or broken at a readable size. */
  const arrange = (f: number) => {
    const sc = lane * f;
    const body = (hasHero ? BODY : NO_HERO) * sc;
    const units: Unit[] = [];
    const groups: number[][] = [];
    let run: number[] = [];
    const flush = () => {
      if (run.length === 0) return;
      const hero = cue.words[run[0]!]!.role === "hero";
      const nominal = solo ? SOLO * sc : hero ? HERO * sc : body;
      let size = nominal;
      if (hero && !solo) {
        const total = run.reduce((sum, at) => sum + adv(texts[at]!, nominal, spacingOf(at)), 0) + GAP * (run.length - 1);
        size = clamp(nominal * Math.min(1, HERO_COLUMN / total), Math.max(0.62 * nominal, 100 * sc), nominal);
      }
      let group: number[] = [];
      for (const at of run) {
        const text = texts[at]!;
        const track = spacingOf(at);
        const wide = adv(text, size, track);
        const floor = Math.max(0.5 * nominal, 80 * sc);
        let wordSize = size * Math.min(1, WORD_COLUMN / wide);
        if (wordSize < floor && SIMPLE.test(text) && graphemes(text).length > 3) {
          let n = Math.max(2, Math.ceil((wide * floor) / (size * WORD_COLUMN)));
          let parts = breakInto(text, n);
          for (let tries = 0; tries < 12; tries++) {
            const widest = Math.max(...parts.map((part) => adv(part, size, track)));
            wordSize = size * Math.min(1, WORD_COLUMN / widest);
            if (wordSize >= floor || n >= graphemes(text).length) break;
            parts = breakInto(text, ++n);
          }
          if (group.length) groups.push(group);
          group = [];
          parts.forEach((part, p) => {
            groups.push([units.length]);
            units.push({ word: at, part: p, parts: parts.length, text: part, size: wordSize, nominal, hero, spacing: track });
          });
          continue;
        }
        group.push(units.length);
        units.push({ word: at, part: null, parts: 1, text, size: wordSize, nominal, hero, spacing: track });
      }
      if (group.length) groups.push(group);
      run = [];
    };
    cue.words.forEach((word, at) => {
      if (run.length && (cue.words[run[0]!]!.role === "hero") !== (word.role === "hero")) flush();
      run.push(at);
    });
    flush();
    const laidOut = ctx.layout({
      column: COLUMN, gap: GAP, padding: 14, groups,
      words: units.map((unit) => ({ text: unit.text, size: unit.size, face: FACE, spacing: unit.spacing })),
    });
    // The engine centres the rows' boxes, which keep 0.27 em under the last baseline; the sample centres the ink, so the block moves down by half of that.
    const lowest = Math.max(...laidOut.cells.map((cell) => cell.baseline));
    const lastSize = Math.max(...laidOut.cells.filter((cell) => cell.baseline === lowest).map((cell) => cell.size));
    const moved = laidOut.cells.map((cell) => ({ ...cell, baseline: cell.baseline + 0.135 * lastSize }));
    // What the cue draws vertically: the ink of every row.
    const top = Math.min(...moved.map((cell) => cell.baseline + Math.min(cell.inkTop, -0.86 * cell.size)));
    const bottom = Math.max(...moved.map((cell) => cell.baseline + Math.max(cell.inkBottom, 0)));
    return { units, cells: moved, top, bottom };
  };

  // Fit the block into the caption band: shrink it when it is too tall (a long word broken over five rows), shift it when it only sits off-centre.
  let fit = 1;
  let arranged = arrange(fit);
  for (let tries = 0; tries < 8; tries++) {
    const height = arranged.bottom - arranged.top;
    const room = band.y2 - band.y1;
    if (height <= room + 0.5) break;
    fit *= Math.min(0.95, (0.98 * room) / height);
    arranged = arrange(fit);
  }
  const dy = arranged.top < band.y1 ? band.y1 - arranged.top : arranged.bottom > band.y2 ? band.y2 - arranged.bottom : 0;
  const units = arranged.units;
  const cells = arranged.cells.map((cell) => ({ ...cell, baseline: cell.baseline + dy }));
  const byUnit = new Map<number, SpeechCell>(cells.map((cell) => [cell.at, cell]));

  // The close: every unit's slats shrink right to left, the first unit first, once the last word has been read.
  const avail = to - exitAt;
  const close = exitCapable && avail >= 3.2 * frame;
  const stagger = (units.length - 1) * EXIT_WORD + (SLATS - 1) * EXIT_SLAT;
  const closeMs = clamp(avail - stagger, MIN_FRAMES * frame, EXIT_SLAT_MAX);
  const squeeze = Math.min(1, Math.max(0, avail - closeMs) / Math.max(1, stagger));
  const unitExit = (at: number) => Math.ceil(exitAt + at * EXIT_WORD * squeeze);
  const slatClose = (at: number, slat: number) => unitExit(at) + (SLATS - 1 - slat) * EXIT_SLAT * squeeze;
  const slatGone = (at: number, slat: number) => Math.ceil(slatClose(at, slat) + closeMs);

  const pieces: Piece[] = [];

  units.forEach((unit, at) => {
    const cell = byUnit.get(at)!;
    const word = cue.words[unit.word]!;
    const r = cell.size / unit.size;
    const pad = PAD * r;
    const overlap = r;
    const ext = 0.32 * cell.size;
    const L = cell.x - cell.width / 2 - pad;
    const R = cell.x + cell.width / 2 + pad;
    const sw = (R - L) / SLATS;
    const y1 = cell.baseline + Math.min(cell.inkTop, -0.86 * cell.size) - 0.35 * cell.size;
    const y2 = cell.baseline + Math.max(cell.inkBottom, 0.1 * cell.size) + 0.35 * cell.size;
    const isHero = unit.hero;
    const fill = isHero ? heroColour : bodyColour;

    // The reveal: locked to the word, finished by its last frame before the spoken end. Pieces of a broken word follow one another.
    const enter = ctx.enter(word, FULL_MS, LEAD);
    const offset = unit.part === null || unit.parts < 2 ? 0 : Math.round(((enter.settled - enter.from) * 0.4 * unit.part) / unit.parts);
    const from = Math.min(enter.settled, enter.from + offset);
    // The word is whole one frame before its spoken end, not on the last frame before it: whoever looks a moment before the end sees all of it.
    const settled = Math.max(from, Math.round(Math.min(enter.settled, exportFrameAtOrBefore(word.endMs - 1 - frame, fps))));
    const W = settled - from;
    const animated = W >= MIN_FRAMES * frame;
    const lead = word.startMs - from;
    const k = Math.min(1, W / FULL_MS);
    const st = animated ? Math.min(STAGGER * k, Math.max(0, W - MIN_FRAMES * frame) / (SLATS - 1)) : 0;
    const D = Math.max(1, W - (SLATS - 1) * st);
    const slatStart = (i: number) => from + i * st;
    // A word with no lead still paints a sliver on its first frame.
    const p0 = lead < frame ? 0.2 : 0;

    const leading = (i: number) => (rtl ? SLATS - 1 - i : i);
    const segLeft = (i: number) => L + leading(i) * sw;
    const range = (i: number, pv: number): readonly [number, number] => {
      if (pv <= 0.003) return [0, 0];
      const half = ((1 - pv) * sw) / 2;
      const ov = overlap * Math.min(1, pv * 4);
      let a = segLeft(i) + half - ov;
      let b = segLeft(i) + sw - half + ov;
      if (i === 0) {
        if (rtl) b += ext * pv;
        else a -= ext * pv;
      }
      if (i === SLATS - 1) {
        if (rtl) a -= ext * pv;
        else b += ext * pv;
      }
      return [a, b];
    };
    const open = (i: number, t: number) => {
      const p = Math.min(1, 1.14 * EASES.outQuint(prog(t, slatStart(i), D / FULL_AT)));
      return i === 0 ? Math.min(1, p0 + (1 - p0) * p) : p;
    };
    const closing = (i: number, t: number) => (close ? 1 - prog(t, slatClose(at, i), closeMs) ** 2 : 1);
    const pvOf = (i: number, t: number) => (animated ? Math.min(open(i, t), closing(i, t)) : closing(i, t));
    const doneAt = animated ? settled : from;
    const closeFrom = close ? unitExit(at) : to;
    const goneAt = (i: number) => (close ? Math.min(to, slatGone(at, i)) : to);
    const full: readonly [number, number] = [L - ext, R + ext];

    const colourFrames = (): TextPiece["track"]["colour"] => {
      if (!isHero) return undefined;
      const end = Math.min(doneAt + FLASH_MS, close ? closeFrom : Number.POSITIVE_INFINITY);
      if (end - doneAt < 3 * frame) return undefined;
      const peak = doneAt + (end - doneAt) * 0.23;
      return [[from, heroColour], [doneAt, heroColour], [peak, mixColour(heroColour, WHITE, 1), "out"], [end, heroColour, "out"]];
    };

    const stroke = { widthPx: 0.025 * cell.size, colour: accent };
    const shadows = [{ dx: 0, dy: 0.05 * cell.size, blur: 0.08 * cell.size, colour: input.colours.shadow, alpha: 0.55 }];
    const name = unit.part === null ? `${id}:w${unit.word}` : `${id}:w${unit.word}l${unit.part}`;
    const piece = (suffix: string, fromMs: number, toMs: number, clip: Clip, colour?: TextPiece["track"]["colour"]): TextPiece => ({
      id: `${name}${suffix}`, kind: "text", z: 6, fromMs, toMs, text: cell.text, face: FACE, sizePx: cell.size, letterSpacingEm: cell.spacing, fill,
      stroke, shadows, anchor: "baseline-center", language: cue.language,
      track: { x: [[fromMs, cell.x]], y: [[fromMs, cell.baseline]], ...(colour ? { colour } : {}) }, clip,
    });
    const clipOf = (x1: Frames, x2: Frames, start: number): Clip => ({ x1, x2, y1: [[start, y1]], y2: [[start, y2]] });

    // The face: the first slat while it opens, then the slats that are open whole (a finished slat is absorbed, so no slat edge is
    // ever painted inside an open part of the word), the whole word at rest, and the first slat again as the blinds close.
    const faceEnd = close ? Math.min(to, slatGone(at, 0)) : to;
    const fullAt = (i: number) => Math.round(slatStart(i) + D);
    const edgesIn = [from, ...Array.from({ length: SLATS }, (_, i) => slatStart(i)), doneAt];
    const edgesOut = [closeFrom, ...Array.from({ length: SLATS }, (_, i) => slatClose(at, i)), faceEnd];
    /** `fn` smooth between the cuts and free to jump at one: each stretch is sampled alone, the jump is a one-ms segment. */
    const stepped = (fn: (t: number) => number, cuts: readonly number[], edges: readonly number[]): [number, number][] => {
      const out: [number, number][] = [];
      for (let c = 0; c + 1 < cuts.length; c++) {
        const a = cuts[c]!;
        const b = cuts[c + 1]! - 1;
        for (const [t, v] of sampled(fn, a, Math.max(a, b), edges.filter((edge) => edge > a && edge < b))) out.push([t, v]);
      }
      return out;
    };
    const whole = (i: number): readonly [number, number] => range(i, 1);
    const faceRange = (t: number): readonly [number, number] => {
      let done = 0;
      while (done < SLATS && t >= fullAt(done)) done++;
      if (done === 0) return range(0, pvOf(0, t));
      if (done >= SLATS) return full;
      let lo = Number.POSITIVE_INFINITY;
      let hi = Number.NEGATIVE_INFINITY;
      for (let i = 0; i < done; i++) {
        lo = Math.min(lo, whole(i)[0]);
        hi = Math.max(hi, whole(i)[1]);
      }
      return [lo, hi];
    };
    const faceSide = (side: 0 | 1): Frames => {
      const frames: [number, number][] = [];
      if (animated) {
        const cuts = [...new Set([from, ...Array.from({ length: SLATS - 1 }, (_, i) => fullAt(i)).filter((t) => t > from && t < doneAt), doneAt])].sort((x, y) => x - y);
        frames.push(...stepped((t) => faceRange(t)[side], cuts, edgesIn));
        frames.push([Math.max(frames.at(-1)![0] + 1, doneAt), full[side]]);
      } else frames.push([from, full[side]]);
      if (close) {
        const last = frames.at(-1)![0];
        if (closeFrom - 1 > last) frames.push([closeFrom - 1, full[side]]);
        const start = Math.max(frames.at(-1)![0] + 1, closeFrom);
        frames.push(...sampled((t) => range(0, pvOf(0, t))[side], start, faceEnd, edgesOut).map(([t, v]) => [t, v] as [number, number]));
      }
      return frames;
    };
    pieces.push(piece("", from, faceEnd, clipOf(faceSide(0), faceSide(1), from), colourFrames()));

    // The other five slats: one piece each that opens its part of the word until the face takes it over, is invisible (empty clip,
    // opacity 0) while the plain face is on, and closes it again (a piece costs its shadow layer too, and a cue may draw 150 of them).
    for (let i = 1; i < SLATS; i++) {
      if (!animated && !close) continue;
      const start = animated ? Math.floor(slatStart(i)) : closeFrom;
      const handOver = animated ? fullAt(i) : closeFrom;
      const stop = close ? goneAt(i) : handOver;
      if (stop <= start) continue;
      const side = (which: 0 | 1): Frames => {
        const frames: [number, number][] = [];
        const pick = (t: number) => range(i, pvOf(i, t))[which];
        if (animated) frames.push(...sampled(pick, start, Math.max(start, handOver - 1), edgesIn).map(([t, v]) => [t, v] as [number, number]));
        if (animated && close) {
          frames.push([Math.max(frames.at(-1)![0] + 1, handOver), 0]);
          if (closeFrom - 1 > frames.at(-1)![0]) frames.push([closeFrom - 1, 0]);
        }
        if (close) {
          const from2 = Math.max(frames.length ? frames.at(-1)![0] + 1 : start, closeFrom);
          frames.push(...sampled(pick, from2, stop, edgesOut).map(([t, v]) => [t, v] as [number, number]));
        }
        return frames;
      };
      const made = piece(`s${i}`, start, stop, clipOf(side(0), side(1), start));
      if (animated && close) {
        const gone: Frames = [[start, 1], [Math.max(start + 1, handOver - 1), 1], [Math.max(start + 2, handOver), 0]];
        const back: Frames = closeFrom - 1 > gone.at(-1)![0] ? [[closeFrom - 1, 0], [closeFrom, 1]] : [[gone.at(-1)![0] + 1, 1]];
        made.track = { ...made.track, o: [...gone, ...back] };
      }
      pieces.push(made);
    }
  });

  return pieces;
});

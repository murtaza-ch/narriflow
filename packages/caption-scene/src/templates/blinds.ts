import type { DemoScript } from "../demo";
import { EASES, type Frames, clamp, prog } from "../ease";
import { sceneSampleRate } from "../frame-grid";
import { sampleFrames } from "../frames";
import type { SceneProgram } from "../input";
import type { Clip, Piece, ShapePiece, TextPiece } from "../scene";
import { mixColour } from "../scene";
import { rectPath } from "../shapes";
import { caps, galleryScene, rowBounds, rowsOf } from "./gallery-layout";
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
 *   and is finished by its last frame before the spoken end, the stagger squeezed with it (a word too short for two painted
 *   frames of every slat is drawn open at once). The slats are only ever slices of their own word and live until the word is
 *   open, at which point the sixth slat hands over to the plain copy in one frame. Nothing closes before the last word's spoken
 *   end plus 150 ms; the close takes whatever time the next cue leaves and is a cut when it leaves less than three frames.
 * - **The face is one piece.** The word's readable face is a single piece from its first frame: its clip is the first slat while
 *   the others open, the whole word afterwards and the first slat again as the blinds close (the sample's tail where the last 12 %
 *   of a slat is finished at once is kept). The other five slats are one piece each (opening and closing in one, with an empty
 *   clip in between), so no slat is ever drawn over a readable word and a nine-word cue costs 111 of its 150 pieces and shadow layers.
 * - **Shared lanes and the band.** Two overlapping speakers scale to a share of their lane, so both captions come out alike; the
 *   whole block is fitted into the sample's caption band (y 860..1650 around the anchor, at the natural size), so a long word broken
 *   over several rows never fills the frame. Rows keep room beside them for the jambs. A broken word is cut between whole letters
 *   (graphemes), never between a letter and its combining mark.
 * - **Colours go through the brand map.** Body words are the primary colour, the key word the highlight, the outline the accent
 *   (the guard checks both against it).
 * - **Shadow.** The sample's 0.05 em / 0.16 em soft shadow is one blurred copy (sigma 0.08 em) per slat; the stroke is half the
 *   sample's CSS stroke (CSS strokes are centred, `\bord` is not).
 *
 * Extra recurring beats (cheap shapes, behind the type, in the blinds' own language):
 * - rule: a thin bar under the last row that opens along the reading direction with the line and wipes away with the close; it
 *   cycles full width / a short stub at the leading end / at the trailing end by a per-cue counter and a seeded width;
 * - jambs: two upright bars flanking the key row (the first row when there is no key word) that rise from their centre as the
 *   row lands and shrink as it closes; they cycle pair / leading only / trailing only and tall / short, and are dropped when the
 *   safe area leaves no room beside the row.
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
const WORD_COLUMN = 860;
/** Room kept beside the widest row for the jambs, sample px. */
const JAMB_ROOM = 46;
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

const seeded = (text: string, salt: number) => {
  let h = 2166136261 ^ salt;
  for (let at = 0; at < text.length; at++) {
    h ^= text.charCodeAt(at);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10007) / 10007;
};

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
  const { cue, to, index: cueIndex } = window;
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
      column: COLUMN, gap: GAP, padding: 14 + JAMB_ROOM, groups,
      words: units.map((unit) => ({ text: unit.text, size: unit.size, face: FACE, spacing: unit.spacing })),
    });
    // The engine centres the rows' boxes, which keep 0.27 em under the last baseline; the sample centres the ink, so the block moves down by half of that.
    const lowest = Math.max(...laidOut.cells.map((cell) => cell.baseline));
    const lastSize = Math.max(...laidOut.cells.filter((cell) => cell.baseline === lowest).map((cell) => cell.size));
    const moved = laidOut.cells.map((cell) => ({ ...cell, baseline: cell.baseline + 0.135 * lastSize }));
    // What the cue draws vertically: the ink of every row and the rule under the last.
    const top = Math.min(...moved.map((cell) => cell.baseline + Math.min(cell.inkTop, -0.86 * cell.size)));
    const bottom = Math.max(...moved.map((cell) => cell.baseline + Math.max(cell.inkBottom, 0))) + 0.17 * lastSize;
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
  const rows = rowsOf(cells);

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
  const reveals: { from: number; settled: number; animated: boolean }[] = [];

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
    const settled = enter.settled;
    const W = settled - from;
    const animated = W >= MIN_FRAMES * frame;
    reveals.push({ from, settled, animated });
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

    // The face: the first slat while the others open, the whole word between, the first slat again as the blinds close.
    const faceEnd = close ? Math.min(to, slatGone(at, 0)) : to;
    const edgesIn = [from, ...Array.from({ length: SLATS }, (_, i) => slatStart(i)), doneAt];
    const edgesOut = [closeFrom, ...Array.from({ length: SLATS }, (_, i) => slatClose(at, i)), faceEnd];
    const faceSide = (side: 0 | 1): Frames => {
      const pick = (t: number) => range(0, pvOf(0, t))[side];
      const frames: [number, number][] = [];
      if (animated) frames.push(...sampled(pick, from, doneAt - 1, edgesIn).map(([t, v]) => [t, v] as [number, number]));
      const hold = Math.max(from, frames.at(-1)?.[0] ?? from);
      if (animated) frames.push([Math.max(hold + 1, doneAt), full[side]]);
      else frames.push([from, full[side]]);
      if (close) {
        const last = frames.at(-1)![0];
        if (closeFrom - 1 > last) frames.push([closeFrom - 1, full[side]]);
        const start = Math.max(frames.at(-1)![0] + 1, closeFrom);
        frames.push(...sampled(pick, start, faceEnd, edgesOut).map(([t, v]) => [t, v] as [number, number]));
      }
      return frames;
    };
    pieces.push(piece("", from, faceEnd, clipOf(faceSide(0), faceSide(1), from), colourFrames()));

    // The other five slats: one piece each that opens the word, holds an empty clip while the plain face is on, and closes it
    // (a piece costs its shadow layer too, and a cue may draw 150 of them).
    for (let i = 1; i < SLATS; i++) {
      const start = animated ? Math.floor(slatStart(i)) : closeFrom;
      const stop = close ? goneAt(i) : doneAt;
      if (!animated && !close) continue;
      if (stop <= start) continue;
      const empty = (): [number, number][] => [];
      const side = (which: 0 | 1): Frames => {
        const frames: [number, number][] = empty();
        const pick = (t: number) => range(i, pvOf(i, t))[which];
        if (animated) frames.push(...sampled(pick, start, Math.max(start, doneAt - 1), edgesIn).map(([t, v]) => [t, v] as [number, number]));
        if (animated && close) {
          frames.push([Math.max(frames.at(-1)![0] + 1, doneAt), 0]);
          if (closeFrom - 1 > frames.at(-1)![0]) frames.push([closeFrom - 1, 0]);
        }
        if (close) {
          const from2 = Math.max(frames.length ? frames.at(-1)![0] + 1 : start, closeFrom);
          frames.push(...sampled(pick, from2, stop, edgesOut).map(([t, v]) => [t, v] as [number, number]));
        }
        return frames;
      };
      pieces.push(piece(`s${i}`, start, stop, clipOf(side(0), side(1), start)));
    }
  });

  // Extra beats. The rule under the last row and the jambs beside the key row sit behind the type.
  const ordinal = input.cues.slice(0, cueIndex).filter((other) => other.words.some((word) => word.role === "hero") === hasHero).length;
  const key = hasHero ? heroColour : ordinal % 2 === 0 ? heroColour : bodyColour;
  const rowFrom = (row: readonly SpeechCell[]) => Math.min(...row.map((cell) => reveals[cell.at]!.from));
  const unitsEnd = Math.max(...units.map((_, at) => (close ? Math.min(to, slatGone(at, 0)) : to)));
  const wipeEnd = close ? unitsEnd : to;
  const barSeed = seeded(cue.words.map((word) => word.text).join(" "), cueIndex);

  const lastRow = rows.at(-1)!;
  const lastBox = rowBounds(lastRow);
  const lastRowSize = Math.max(...lastRow.map((cell) => cell.size));
  const ruleW = Math.max(1, lastBox.x2 - lastBox.x1);
  const variant = ordinal % 3;
  const width = variant === 0 ? ruleW : ruleW * (0.34 + 0.16 * barSeed);
  const flushTrailing = variant === 0 ? false : (variant === 1) === rtl;
  const left = flushTrailing ? lastBox.x2 - width : lastBox.x1;
  const ruleH = Math.max(3, 0.045 * lastRowSize);
  const ruleTop = Math.max(...lastRow.map((cell) => cell.baseline + Math.max(0, cell.inkBottom))) + 0.05 * lastRowSize + 0.025 * lastRowSize + 0.04 * lastRowSize;
  const ruleFrom = Math.round(rowFrom(lastRow));
  const ruleEnd = wipeEnd;
  if (ruleEnd - ruleFrom > frame) {
    const grow = Math.min(240, (close ? exitAt : to) - ruleFrom);
    const animated = grow >= MIN_FRAMES * frame;
    const reveal = (t: number) => (animated ? 0.08 + 0.92 * EASES.outExpo(prog(t, ruleFrom, grow)) : 1);
    const wipeLen = close ? Math.max(MIN_FRAMES * frame, Math.min(ruleEnd - exitAt, stagger * squeeze + closeMs)) : 0;
    const wipe = (t: number) => (close ? EASES.inOut(prog(t, exitAt, wipeLen)) : 0);
    const x1 = (t: number) => (rtl ? left + width - width * reveal(t) : left + width * wipe(t));
    const x2 = (t: number) => (rtl ? left + width - width * wipe(t) : left + width * reveal(t));
    const edges = [ruleFrom, ruleFrom + grow, exitAt, exitAt + wipeLen];
    pieces.push({
      id: `${id}:rule`, kind: "shape", z: 2, fromMs: ruleFrom, toMs: ruleEnd, track: { x: [[ruleFrom, left]], y: [[ruleFrom, ruleTop]] },
      clip: { x1: sampled(x1, ruleFrom, ruleEnd, edges), x2: sampled(x2, ruleFrom, ruleEnd, edges), y1: [[ruleFrom, ruleTop - 2]], y2: [[ruleFrom, ruleTop + ruleH + 2]] },
      path: rectPath(0, 0, width, ruleH), fill: { colour: key },
    } satisfies ShapePiece);
  }

  const keyRow = rows.find((row) => row.some((cell) => units[cell.at]!.hero && cue.words[units[cell.at]!.word]!.role === "hero")) ?? rows[0]!;
  const keyBox = rowBounds(keyRow);
  const keySize = Math.max(...keyRow.map((cell) => cell.size));
  const jambW = Math.max(3, 0.05 * keySize);
  const jambGap = 0.12 * keySize + PAD * u;
  const tightGap = 0.04 * keySize + 0.5 * PAD * u;
  const tall = (hasHero ? ordinal : ordinal + 1) % 2 === 0;
  const jambH = (keyBox.y2 - keyBox.y1) * (tall ? 0.96 : 0.6);
  const jambY = (keyBox.y1 + keyBox.y2) / 2;
  const jambVariant = (hasHero ? ordinal : ordinal + 1) % 3;
  const margin = 4 * u;
  const jambFrom = Math.round(rowFrom(keyRow));
  const jambEnd = wipeEnd;
  const sides: { side: -1 | 1; x: number }[] = [
    { side: -1, x: keyBox.x1 - jambGap - jambW / 2 },
    { side: 1, x: keyBox.x2 + jambGap + jambW / 2 },
  ];
  const wanted = sides.filter(({ side }) => jambVariant === 0 || (jambVariant === 1) === (side * (rtl ? -1 : 1) < 0));
  if (jambEnd - jambFrom > frame) {
    wanted.forEach(({ side, x: roomy }, at) => {
      // Beside the row at the usual gap, or at a tight one when the safe area leaves less room.
      const tight = side < 0 ? keyBox.x1 - tightGap - jambW / 2 : keyBox.x2 + tightGap + jambW / 2;
      const fits = (x: number) => x - jambW / 2 >= bounds.x1 + margin && x + jambW / 2 <= bounds.x2 - margin;
      const x = fits(roomy) ? roomy : tight;
      if (!fits(x)) return;
      const pop = Math.min(220, (close ? exitAt : to) - jambFrom);
      const animated = pop >= MIN_FRAMES * frame;
      const sy: [number, number, ("outBack" | "in")?][] = animated ? [[jambFrom, 0.05], [jambFrom + pop, 1, "outBack"]] : [[jambFrom, 1]];
      if (close) {
        const shrink = Math.max(MIN_FRAMES * frame, Math.min(jambEnd - exitAt, closeMs + EXIT_WORD * squeeze));
        sy.push([Math.max(sy.at(-1)![0] + 1, exitAt), 1], [Math.min(jambEnd, exitAt + shrink), 0.02, "in"]);
      }
      pieces.push({
        id: `${id}:jamb${at}`, kind: "shape", z: 2, fromMs: jambFrom, toMs: jambEnd,
        track: { x: [[jambFrom, x]], y: [[jambFrom, jambY]], sy, ...(close ? { o: [[jambFrom, 1], [Math.max(jambFrom + 1, exitAt), 1], [Math.max(jambFrom + 2, Math.min(jambEnd, exitAt + Math.max(MIN_FRAMES * frame, Math.min(jambEnd - exitAt, closeMs + EXIT_WORD * squeeze)))), 0, "in"]] as Frames } : {}) },
        path: rectPath(-jambW / 2, -jambH / 2, jambW, jambH), fill: { colour: key }, stroke: { widthPx: Math.max(1.5, 0.012 * keySize), colour: accent },
      } satisfies ShapePiece);
    });
  }
  return pieces;
});

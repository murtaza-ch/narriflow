import { CAPTION_SCENE_BRAND_MIN_CONTRAST, captionColourContrast, captionSceneMeta, toCaptionLowerCase } from "@narriflow/validators";
import type { DemoScript } from "../demo";
import { clamp, EASES, type Frames, kf, lerp, prog } from "../ease";
import { exportFrameAtOrAfter, exportFrameAtOrBefore, exportFrameTimes, paintedFrameCount } from "../frame-grid";
import type { SceneCue, SceneWord } from "../input";
import type { Box, Clip, PathCmd, Piece, ShapePiece, TextPiece } from "../scene";
import { ellipsePath, rectPath, roundedRectPath } from "../shapes";
import { galleryScene, rowBounds, rowsOf } from "./gallery-layout";
import type { SpeechCell } from "./speech-layout";

/**
 * Pen Tool (`samples/templates/m84-pentool.js`): heavy white words typed as pale grey preview letters a beat early, then
 * turned solid white letter by letter from the spoken start, a thin caret riding the typing edge. The key word is the
 * signature: a fountain-nib pen cursor plants a square anchor, draws a bezier curve with its handles through the free band
 * above or below the caption, drops a second anchor and pins a tilted `#hashtag` chip (the key word) to it.
 *
 * Changes from the sample, and why:
 * - **One face, one width (owner).** Sora ExtraBold for the words and the chip; the sample's wide Archivo and its per-word
 *   width switch are gone. Sora is about 14% narrower than Archivo at 125% width, so the body stays at the sample's 92 px,
 *   the key word 1.1x, tracking -0.012 em (simple scripts only), and the column is 880 px inside the 5% safe area. The
 *   owner's "stop waiting for" running off the right edge cannot happen: every word is fitted to the column first (a word
 *   wider than it shrinks to a 59 px floor, then breaks into the fewest even rows; joined scripts never break), rows are
 *   balanced from measured widths, and the whole cue is laid out at the largest of four scales that packs it into two rows.
 * - **Typing on the export frame grid.** The grey preview and the white face are two copies of each word under rectangular
 *   clips stepped on painted frames, so libass and the Studio show the same letters on the same frame. The last grey letter
 *   lands 40 ms before the spoken start (never more than 100 ms early); the white pass starts on the spoken start and is
 *   whole by the word's last frame (a 70 ms word too). When there is no time for a preview (continuous speech hands a cue
 *   no lead), the grey word appears whole at the onset and the white pass still types over it, so every glyph reads on the
 *   onset frame. When the white pass would have fewer than two painted frames, the white word lands whole.
 * - **Every language.** Letter-by-letter typing for Latin, Cyrillic, Greek, CJK and Hangul (by grapheme, so accents stay on
 *   their letters); joined and complex scripts (Devanagari, Arabic, Urdu, Thai …) type a whole word at a time; RTL rows run
 *   right to left and the caret sits at a whole word's reading end. The chip text is `#` plus the key word lower-cased for
 *   cased scripts and as spoken otherwise, its edge punctuation and apostrophes dropped. Sora draws no Devanagari, Arabic
 *   or CJK: those go through the glyph fallback face, measured as drawn, and rows, chips and paths take their size from
 *   that measured ink.
 * - **The pen decoration recurs on every key-word cue** and alternates: chip colour cycles coral / lime / lilac by key-word
 *   counter, the curve alternates between the sample's arc and a flatter swoop, its sweep and tilt jitter by a seeded hash,
 *   and on one-row cues the decoration alternates above and below. It sits on the side of the block that the key word's row
 *   touches (above for a first-row key word, below for a last-row one), so the chip is never over a word, and it shrinks
 *   its amplitude (then the chip) to the room the band has on this canvas instead of leaving it. The chip hangs toward the
 *   side with room and the curve comes from the other. The chip is pinned on the spoken key word, never before it, so the
 *   tag never gives the word away; a key word at the start of a cue lets the pen keep drawing into the word's own time.
 *   Short cues get a compact static pose (curve, anchors, chip) instead of the full draw.
 * - **No-hero cues** keep the sample's lighter motion (typing and caret) and the two new beats below.
 * - **Cue handoff.** The window logic is the shared gallery one (lanes per speaker, reading holds, incoming lead shrinks
 *   first); the exit is the sample's short fade with a small drop, only when two painted frames fit after the reading hold.
 * - **Colours as received.** Face, chips and caret keep 3:1 against the ink they sit on (else the style's own colour); the
 *   grey preview is the accent slot, kept if it reads on the ink outline.
 * - **Cost.** No blur: the sample's soft shadows are one hard ink drop copy per word and one under the chip.
 *
 * Extra recurring beats (in the design-tool language of the sample): **selection handles**, four small square handles that
 * snap to the corners of the text block as each cue starts typing (two, on the free side, on key-word cues) and fade once
 * the first word is white; and a **closing path**, a straight segment with a square anchor at each end that wipes in under
 * (or over, away from the pen decoration) the cue's last row as its last word turns white, and stays until the exit.
 */

export const PENTOOL_DEMO: DemoScript = {
  lines: [
    "stop:b waiting:b for:m motivation:h@520",
    "talent:b is:m overrated:b",
    "do:b the:m boring:h@460 things:b every:b day:b",
    "trust:b the:m process:h@460",
    "beat:b procrastination:h@640 today:b",
    "no:b excuses:b",
  ],
  options: { rate: 200, gap: 26, cueGap: 110, tail: 480, lead: 330 },
};

const FACE = "Sora ExtraBold" as const;
const ANCHOR = 1290;
const BODY = 92;
const HERO_EM = 1.1;
const COLUMN = 880;
const GAP = 24;
const PAD = 40;
const SPACING = -0.012;
/** Smaller scales tried when a cue would stack three rows or more. */
const SCALES = [0.92, 0.85, 0.78] as const;
const BODY_FLOOR = BODY * 0.64;
/** How early a cue's window opens before its first word (the conformance limit is 100). */
const LEAD = 96;
const GREY_LEAD = 40;
const PREVIEW_MAX = 100;

const INK = "#15121F";
const WHITE = "#FFFFFF";
const LIME = "#C8F23A";
const LILAC = "#BBA6FF";

const CHIP_FONT = 40;
const CHIP_FONT_FLOOR = 30;
/** A key word longer than this gets the path and anchors but no chip: its tag would be too small to read. */
const CHIP_MAX_LETTERS = 18;
const CHIP_H = 66;
const CHIP_PAD = 26;
const PIN_GAP = 20;
const PEN_AWAY = 24;

/** Scripts typed letter by letter; everything else types a whole word at a time. They can also break across rows. */
const TYPED = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{N}\p{P}\p{S}\p{M}]+$/u;
const TRACKED = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{N}\p{P}\p{S}\p{M}]+$/u;
const CJK = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{P}\p{N}]+$/u;
const CASED = /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Armenian}]/u;
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemes = (text: string) => [...GRAPHEMES.segment(text)].map((part) => part.segment);

type Key = [number, number, ("out" | "in" | "inOut" | "spring" | "outExpo" | "outBack")?];

/** A track that holds each value until the next frame time (steps planned on painted frames). */
function stepped(points: readonly (readonly [number, number])[]): Frames {
  const out: Key[] = [];
  for (const [t, v] of points) {
    const last = out.at(-1);
    if (last && last[1] === v) continue;
    if (last && t - 1 > last[0]) out.push([t - 1, last[1]]);
    out.push([t, v]);
  }
  return out.length ? out : [[0, 0]];
}

function cueSeed(cue: SceneCue): number {
  let hash = cue.index + 1;
  for (const word of cue.words) for (const char of word.text) hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619);
  return (hash >>> 0) / 2 ** 32;
}

const hasHero = (cue: SceneCue) => cue.words.some((word) => word.role === "hero");

export function pentoolChipLabel(word: SceneWord, language: string | null): string {
  const bare = word.text.replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, "").replace(/['’ʼ]/gu, "") || word.text;
  return `#${CASED.test(bare) ? toCaptionLowerCase(bare, language) : bare}`;
}

/** The pen nib, tip at (0, 0), body up; the sample's 90 x 100 drawing at 1.5x. */
function penBody(s: number): PathCmd[] {
  const p = (x: number, y: number) => [x * s, y * s] as const;
  return [
    ["M", ...p(0, 0)], ["L", ...p(-15, -27)], ["L", ...p(-10, -48)], ["L", ...p(10, -48)], ["L", ...p(15, -27)], ["Z"],
    ...roundedRectPath(-13 * s, -76 * s, 26 * s, 24 * s, 5 * s),
  ];
}

function penDetail(s: number): PathCmd[] {
  return [...rectPath(-1.7 * s, -23 * s, 3.4 * s, 18 * s), ...ellipsePath(0, -29 * s, 3.6 * s)];
}

const squarePath = (cx: number, cy: number, size: number): PathCmd[] => rectPath(cx - size / 2, cy - size / 2, size, size);

interface Fragment {
  readonly cell: SpeechCell;
  readonly part: number;
  /** Letter range of the word this fragment draws. */
  readonly from: number;
  readonly to: number;
  /** Clip edge after each of its letters, canvas px from its left edge (index 0 = nothing). */
  readonly edges: number[];
}

interface WordPlan {
  readonly at: number;
  readonly word: SceneWord;
  readonly hero: boolean;
  readonly typed: boolean;
  readonly fragments: Fragment[];
  readonly n: number;
  /** First grey frame, grey letter step (0: whole), white start and the frame the white word is whole. */
  greyFrom: number;
  g0: number;
  gs: number;
  onset: number;
  wStart: number;
  wd: number;
  whole: number;
  typing: boolean;
}

export const pentoolProgram = galleryScene("pentool", ANCHOR, (ctx) => {
  const { cue, index, to, bounds } = ctx.window;
  const { exit, exitAt, fps, space, rtl } = ctx;
  const c = ctx.input.colours;
  const { words } = cue;
  const pieces: Piece[] = [];
  const frame = 1000 / fps;
  const decoLimit = exit ? exitAt : to;
  /** An opacity track that also takes the cue's exit fade. */
  const withExit = (frames: Key[]): Key[] => (exit && exitAt > frames.at(-1)![0] ? [...frames, [exitAt, frames.at(-1)![1]], [to, 0, "in"]] : frames);

  // Colours as drawn: everything sits on the dark ink, so each keeps 3:1 against it or falls back to the style's own.
  const defaults = captionSceneMeta("pentool").colours;
  const reads = (colour: string) => captionColourContrast(colour, INK) >= CAPTION_SCENE_BRAND_MIN_CONTRAST;
  const faceFill = reads(c.primary) ? c.primary : WHITE;
  const preview = reads(c.accent) ? c.accent : defaults.accent;
  const chips = [reads(c.highlight) ? c.highlight : defaults.highlight, LIME, LILAC];

  // Counters over the whole clip, so the variants keep cycling however many cues there are.
  const earlier = ctx.input.cues.slice(0, index).filter((other) => other.words.length > 0);
  const heroed = hasHero(cue);
  const ordinal = earlier.filter((other) => hasHero(other) === heroed).length;
  const seed = cueSeed(cue);
  const accent = heroed ? chips[ordinal % chips.length]! : LILAC;

  // ---- layout: fit each word to the column, break the ones that cannot fit at the floor, pack into two rows ----------
  const spacingOf = (text: string) => (TRACKED.test(text) ? SPACING : 0);
  const at100 = (text: string) => ctx.input.measure(text, FACE, 100 * space.u, spacingOf(text)).advance / space.u;
  const chunkAt = (text: string, size: number): string[] => {
    const letters = graphemes(text);
    const split = (room: number): string[] => {
      const out: string[] = [];
      let row = "";
      for (const ch of letters) {
        if (row && at100(row + ch) > room) {
          out.push(row);
          row = "";
        }
        row += ch;
      }
      if (row) out.push(row);
      return out;
    };
    const room = (COLUMN * 0.97 * 100) / size;
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
  const arrange = (scale: number) => {
    const flat: { word: number; part: number; text: string; size: number }[] = [];
    const indexes = words.map((word, at) => {
      const base = BODY * (word.role === "hero" ? HERO_EM : 1) * scale;
      const natural = (at100(word.text) * base) / 100;
      const fitted = natural > COLUMN ? (base * COLUMN) / natural : base;
      // CJK wraps anywhere, so a long run wraps at its own size; other words shrink to the floor before they break.
      const cjk = CJK.test(word.text);
      if (natural <= COLUMN || (!cjk && fitted >= BODY_FLOOR) || !TYPED.test(word.text)) return [flat.push({ word: at, part: 0, text: word.text, size: fitted }) - 1];
      const chunks = chunkAt(word.text, cjk ? base : BODY_FLOOR);
      const widest = Math.max(...chunks.map((chunk) => at100(chunk)));
      const size = clamp((COLUMN * 0.97 * 100) / widest, BODY_FLOOR, Math.max(BODY_FLOOR, base));
      return chunks.map((text, part) => flat.push({ word: at, part, text, size }) - 1);
    });
    const groups: number[][] = [];
    let run: number[] = [];
    for (const list of indexes) {
      if (list.length > 1) {
        if (run.length) groups.push(run);
        run = [];
        for (const at of list) groups.push([at]);
      } else run.push(list[0]!);
    }
    if (run.length) groups.push(run);
    const { cells, unit } = ctx.layout({
      column: COLUMN, padding: PAD, gap: GAP, groups,
      words: flat.map((item) => ({ text: item.text, size: item.size, face: FACE, spacing: spacingOf(item.text) })),
    });
    return { flat, indexes, cells, u: unit, rows: rowsOf(cells) };
  };
  let plan = arrange(1);
  for (const scale of SCALES) {
    if (plan.rows.length <= 2) break;
    const next = arrange(scale);
    if (next.rows.length < plan.rows.length) plan = next;
  }
  const { flat, indexes, cells, u, rows } = plan;
  const rowOf = (cell: SpeechCell) => rows.findIndex((row) => row.includes(cell));

  // ---- typing schedule ---------------------------------------------------------------------------------------------
  const plans: WordPlan[] = [];
  let previousGrey = Number.NEGATIVE_INFINITY;
  for (const [at, word] of words.entries()) {
    const typed = !rtl && TYPED.test(word.text);
    let letterCount = 0;
    const fragments = indexes[at]!.map((flatAt, part) => {
      const cell = cells.find((item) => item.at === flatAt)!;
      const letters = typed ? graphemes(flat[flatAt]!.text) : [flat[flatAt]!.text];
      const edges = [0];
      let prefix = "";
      for (const letter of letters) {
        prefix += letter;
        edges.push(letters.length === 1 || prefix.length === flat[flatAt]!.text.length ? cell.width : ctx.input.measure(prefix, FACE, cell.size, cell.spacing).advance);
      }
      const fragment = { cell, part, from: letterCount, to: letterCount + letters.length, edges };
      letterCount += letters.length;
      return fragment;
    });
    const n = letterCount;
    const start = word.startMs;
    const onset = exportFrameAtOrAfter(Math.max(start, ctx.window.from), fps);
    const lastFrame = Math.max(onset, exportFrameAtOrBefore(word.endMs - 1, fps));
    // Grey preview: the last letter lands GREY_LEAD before the spoken start, never more than PREVIEW_MAX early, after the
    // previous word's preview, never before the cue's window opens.
    const floor = Math.max(ctx.window.from, previousGrey + 16, start - PREVIEW_MAX);
    const lastG = start - GREY_LEAD;
    let g0: number;
    let gs = 0;
    if (typed && n > 1 && lastG > floor) {
      gs = clamp((lastG - floor) / (n - 1), 6, 34);
      g0 = Math.max(floor, lastG - (n - 1) * gs);
      gs = Math.min(gs, (start - g0) / Math.max(1, n - 1));
    } else {
      g0 = clamp(Math.max(floor, start - 70), ctx.window.from, onset);
    }
    previousGrey = gs > 0 ? g0 + (n - 1) * gs : g0;
    const greyFrom = exportFrameAtOrAfter(g0, fps);
    const wStart = onset - 20;
    let wd = clamp(n * 30, 120, Math.min(300, 0.8 * (word.endMs - start)));
    wd = Math.min(wd, lastFrame - wStart);
    const kW = (t: number) => Math.ceil(n * clamp((t - wStart) / Math.max(1, wd)) - 1e-6);
    let whole = exportFrameTimes(onset, lastFrame + 1, fps).find((t) => kW(t) >= n) ?? onset;
    // The white pass types only when the grey word under it paints on at least two frames before it is whole.
    const typing = typed && n > 1 && whole > onset && paintedFrameCount(greyFrom, whole, fps) >= 2;
    if (!typing) whole = onset;
    plans.push({ at, word, hero: word.role === "hero", typed, fragments, n, greyFrom, g0, gs, onset, wStart, wd, whole, typing });
  }
  const kGrey = (plan: WordPlan, t: number) => (t < plan.g0 ? 0 : plan.gs <= 0 ? plan.n : Math.min(plan.n, Math.floor((t - plan.g0) / plan.gs + 1e-6) + 1));
  const kWhite = (plan: WordPlan, t: number) => (t < plan.onset ? 0 : !plan.typing || t >= plan.whole ? plan.n : Math.max(1, Math.ceil(plan.n * clamp((t - plan.wStart) / Math.max(1, plan.wd)) - 1e-6)));

  // ---- the hero pop -------------------------------------------------------------------------------------------------
  const popOf = (plan: WordPlan): Key[] | null => {
    if (!plan.hero) return null;
    const width = Math.max(...plan.fragments.map((fragment) => fragment.cell.width));
    const peak = 1 + Math.min(0.07, (14 * u) / Math.max(1, width));
    const lastFrame = exportFrameAtOrBefore(plan.word.endMs - 1, fps);
    const rise = Math.min(90, Math.max(0, lastFrame - plan.onset));
    if (paintedFrameCount(plan.onset, plan.onset + 380, fps) < 3 || rise < frame) return null;
    return [[plan.onset, 1], [plan.onset + rise, peak, "out"], [plan.onset + 380, 1, "inOut"]];
  };

  // ---- words: grey preview copies and the white faces --------------------------------------------------------------
  for (const plan of plans) {
    const pop = popOf(plan);
    const scaleAt = (t: number) => (pop ? kf(t, pop) : 1);
    for (const fragment of plan.fragments) {
      const { cell } = fragment;
      const left = cell.x - cell.width / 2;
      const mid = -0.3 * cell.size;
      const pivotY = cell.baseline + mid;
      const generous = { x1: left - cell.size, x2: left + cell.width + cell.size, y1: cell.baseline - 2 * cell.size, y2: cell.baseline + 1.4 * cell.size };
      const edgeAt = (k: number, t: number) => {
        const local = clamp(k - fragment.from, 0, fragment.to - fragment.from);
        if (local >= fragment.to - fragment.from) return generous.x2;
        const x = left + fragment.edges[local]! + 0.02 * cell.size;
        return cell.x + (x - cell.x) * scaleAt(t);
      };
      const clipOf = (from: number, until: number, count: (t: number) => number): Clip | undefined => {
        const times = exportFrameTimes(from, until, fps);
        if (times.every((t) => count(t) >= fragment.to)) return { ...rectClipOf(from, generous) };
        const points = times.map((t) => [t, edgeAt(count(t), t)] as const);
        points.push([until, generous.x2]);
        return { x1: [[from, generous.x1]], y1: [[from, generous.y1]], y2: [[from, generous.y2]], x2: stepped(points) };
      };
      const firstFrame = (from: number, until: number, count: (t: number) => number) =>
        exportFrameTimes(from, until, fps).find((t) => count(t) > fragment.from);
      const id = plan.fragments.length > 1 ? `${ctx.id}:w${plan.at}l${fragment.part}` : `${ctx.id}:w${plan.at}`;
      const sizeTrack = pop ? { sx: pop, sy: pop } : {};
      const stroke = { widthPx: 0.035 * cell.size, colour: INK, alpha: 0.85 };

      // The grey preview: typed before the word is spoken, kept under the white pass until the white word is whole.
      const greyUntil = plan.typing ? plan.whole : plan.onset;
      const greyStart = firstFrame(plan.greyFrom, greyUntil, (t) => kGrey(plan, t));
      if (greyStart !== undefined && paintedFrameCount(greyStart, greyUntil, fps) >= 2) {
        const greyCount = (t: number) => kGrey(plan, t);
        pieces.push({
          id: `${ctx.id}:w${plan.at}g${fragment.part}`, kind: "text", z: 4, fromMs: greyStart, toMs: greyUntil,
          text: cell.text, face: cell.face, sizePx: cell.size, letterSpacingEm: cell.spacing, fill: preview,
          anchor: "baseline-center", language: cue.language, stroke,
          shadows: [{ dx: 0, dy: 0.05 * cell.size, blur: 0, colour: INK, alpha: 0.5 }],
          origin: { dx: 0, dy: mid },
          track: { x: [[greyStart, cell.x]], y: [[greyStart, pivotY]], ...sizeTrack },
          ...(plan.typed ? { clip: clipOf(greyStart, greyUntil, greyCount) } : {}),
        } satisfies TextPiece);
      }

      // The white face: from the spoken start, letter by letter while the grey word is under it.
      const whiteCount = (t: number) => kWhite(plan, t);
      const from = fragment.part === 0 ? plan.onset : (firstFrame(plan.onset, to, whiteCount) ?? plan.onset);
      const face = ctx.face(cell, from, faceFill, {
        y: ctx.drift(from, pivotY, 0, from, 10 * u),
        ...sizeTrack,
      });
      pieces.push({
        ...face, id, stroke, origin: { dx: 0, dy: mid },
        shadows: [{ dx: 0, dy: 0.055 * cell.size, blur: 0, colour: INK, alpha: 0.95 }],
        ...(plan.typing ? { clip: clipOf(from, plan.whole, whiteCount) } : {}),
      });
    }
  }

  // ---- the caret: rides the grey typing edge, leaves once the cue is white -----------------------------------------
  const caretFrom = Math.min(...plans.map((plan) => plan.greyFrom));
  const lastPlan = plans.at(-1)!;
  const caretEnd = Math.min(decoLimit, Math.max(lastPlan.whole, lastPlan.onset) + 160);
  const caretW = 7 * u;
  const caretH = 0.8 * BODY * u;
  const caretAt = (t: number) => {
    let head: WordPlan | null = null;
    for (const plan of plans) if (plan.greyFrom <= t && kGrey(plan, t) > 0) head = plan;
    if (!head) return null;
    const k = kGrey(head, t);
    const fragment = head.fragments.find((item) => k <= item.to) ?? head.fragments.at(-1)!;
    const { cell } = fragment;
    const left = cell.x - cell.width / 2;
    const x = head.typed ? left + fragment.edges[clamp(k - fragment.from, 0, fragment.edges.length - 1)]! + 6 * u : rtl ? left - 6 * u - caretW : left + cell.width + 6 * u;
    return { x, y: cell.baseline - 0.76 * cell.size };
  };
  const caretTimes = exportFrameTimes(caretFrom, caretEnd, fps).filter((t) => caretAt(t));
  if (caretTimes.length >= 2) {
    const first = caretTimes[0]!;
    const poses = caretTimes.map((t) => ({ t, ...caretAt(t)! }));
    const fadeFrom = Math.max(first, caretEnd - 120);
    pieces.push({
      ...ctx.shape("caret", first, roundedRectPath(0, 0, caretW, caretH, 2 * u), {
        x: stepped(poses.map((pose) => [pose.t, pose.x])),
        y: stepped(poses.map((pose) => [pose.t, pose.y])),
        o: [[fadeFrom, 1], [caretEnd, 0, "in"]],
      }, accent),
      z: 5, toMs: caretEnd, stroke: { widthPx: 4 * u, colour: INK },
    });
  }

  // ---- block geometry ----------------------------------------------------------------------------------------------
  const block = rowBounds(cells);
  const heroPlan = plans.find((plan) => plan.hero) ?? null;
  const heroRow = heroPlan ? rowOf(heroPlan.fragments[0]!.cell) : -1;
  let decoSide: "above" | "below" | null = null;
  if (heroPlan) {
    if (rows.length === 1) decoSide = ordinal % 2 === 0 ? "above" : "below";
    else decoSide = heroRow === rows.length - 1 ? "below" : "above";
  }

  // ---- the hero decoration: anchors, handles, curve, pen and chip --------------------------------------------------
  if (heroPlan) {
    const heroBox = rowBounds(heroPlan.fragments.map((fragment) => fragment.cell));
    const label = pentoolChipLabel(heroPlan.word, cue.language);
    const variant = ordinal % 2;
    const amp = variant === 0 ? [118, 168, 92] : [74, 150, 54];
    const jitter = 0.9 + 0.2 * seed;
    const tiltMag = 5.5 + 2 * ((seed * 7) % 1);
    const margin = 8 * u;

    // The room on each side of the block, and how much of the decoration fits in it.
    const sideFit = (side: "above" | "below") => {
      const by = side === "above" ? block.y1 - 36 * u : block.y2 + 34 * u;
      const room = side === "above" ? by - (bounds.y1 + margin) : bounds.y2 - margin - by;
      // The handles reach the control points; their round ends and keylines add 14 px.
      const k = (room - 14 * u) / (amp[1]! * jitter * u);
      const chipNeed = (10 + CHIP_H) * u + 0.12 * 260 * u;
      return { side, by, room, k: clamp(k, 0, 1), cs: clamp(room / chipNeed, 0, 1) };
    };
    const preferred = sideFit(decoSide!);
    const other = sideFit(decoSide === "above" ? "below" : "above");
    const score = (side: ReturnType<typeof sideFit>) => Math.min(side.k, side.cs);
    const fit = score(preferred) >= 0.6 || score(other) <= score(preferred) ? preferred : other;
    decoSide = fit.side;
    const k = Math.max(0.15, fit.k);
    const cs = Math.max(0.55, fit.cs);
    const vs = decoSide === "above" ? -1 : 1;
    const by = fit.by;

    // The chip: label size fitted to the room beside the pin.
    const chipH = CHIP_H * u * cs;
    let fontPx = CHIP_FONT * u * cs;
    const labelWidth = (px: number) => ctx.input.measure(label, FACE, px, spacingOf(label)).advance;
    const chipWidth = (px: number) => labelWidth(px) + 2 * CHIP_PAD * u * cs;
    let bx = clamp((heroBox.x1 + heroBox.x2) / 2 - 20 * u, heroBox.x1 + 12 * u, heroBox.x2 - 12 * u);
    const roomRight = () => bounds.x2 - margin - (bx + PIN_GAP * u);
    const roomLeft = () => bx - PIN_GAP * u - (bounds.x1 + margin);
    const penReach = 118 * u * cs;
    const curveRoomLeft = () => bx - bounds.x1 - penReach;
    const curveRoomRight = () => bounds.x2 - bx - penReach;
    let hangRight: boolean;
    if (roomRight() >= chipWidth(fontPx) && curveRoomLeft() >= 160 * u) hangRight = true;
    else if (roomLeft() >= chipWidth(fontPx) && curveRoomRight() >= 160 * u) hangRight = false;
    else hangRight = roomRight() >= roomLeft();
    const room = hangRight ? roomRight() : roomLeft();
    if (chipWidth(fontPx) > room) fontPx = Math.max(CHIP_FONT_FLOOR * u * cs, fontPx * (room - 2 * CHIP_PAD * u * cs) / Math.max(1, labelWidth(fontPx)));
    const showChip = graphemes(label).length <= CHIP_MAX_LETTERS + 1 && chipWidth(fontPx) <= Math.max(room, (bounds.x2 - bounds.x1) - 2 * margin);
    const chipW = chipWidth(fontPx);
    if (showChip && chipW > room) bx = hangRight ? bounds.x2 - margin - PIN_GAP * u - chipW : bounds.x1 + margin + PIN_GAP * u + chipW;
    const sgn = hangRight ? -1 : 1;
    const L = clamp(Math.min(390 * u, (hangRight ? curveRoomLeft() : curveRoomRight())) * jitter, 60 * u, 390 * u);
    const P0 = { x: bx + sgn * L, y: by + vs * amp[0]! * k * jitter * u };
    const P1 = { x: bx + sgn * L * 0.64, y: by + vs * amp[1]! * k * jitter * u };
    const P2 = { x: bx + sgn * L * 0.3, y: by + vs * amp[2]! * k * jitter * u };
    const P3 = { x: bx, y: by };
    const bez = (t: number) => {
      const m = 1 - t;
      return {
        x: m * m * m * P0.x + 3 * m * m * t * P1.x + 3 * m * t * t * P2.x + t * t * t * P3.x,
        y: m * m * m * P0.y + 3 * m * m * t * P1.y + 3 * m * t * t * P2.y + t * t * t * P3.y,
      };
    };

    // Timeline: the pen drops onto A, draws the curve, clicks B just before the spoken key word, the chip is pinned on it.
    const hs = exportFrameAtOrAfter(heroPlan.word.startMs, fps);
    const td0 = Math.max(ctx.window.from, hs - 30 - 640);
    let arrive = Math.max(hs - 30, td0 + 110 + 200);
    let tA = td0 + 70;
    let drawFrom = td0 + 110;
    let leaveFrom = arrive + 60;
    let leaveTo = arrive + 360;
    const full = leaveTo <= decoLimit && paintedFrameCount(drawFrom, arrive, fps) >= 4;
    if (!full && decoLimit - td0 > 330) {
      // Compress the draw into the time this cue has.
      const s = (decoLimit - td0) / (leaveTo - td0);
      tA = td0 + 70 * s;
      drawFrom = td0 + 110 * s;
      arrive = td0 + (arrive - td0) * s;
      leaveFrom = td0 + (leaveFrom - td0) * s;
      leaveTo = decoLimit;
    }
    const animated = paintedFrameCount(drawFrom, arrive, fps) >= 3 && leaveTo <= decoLimit;
    const staticFrom = Math.max(ctx.window.from, Math.min(hs, decoLimit - 2 * frame));
    const deco = (suffix: string, z: number, from: number, path: readonly PathCmd[], fill: string | undefined, extra: Partial<ShapePiece> = {}, track: ShapePiece["track"] = {}): void => {
      if (paintedFrameCount(from, to, fps) < 2) return;
      pieces.push({ ...ctx.shape(suffix, from, path, track, fill), z, ...extra });
    };
    const handlePath = (a: { x: number; y: number }, b: { x: number; y: number }): PathCmd[] => [["M", a.x, a.y], ["L", b.x, b.y], ...ellipsePath(b.x, b.y, 6 * u * cs)];
    const wipeOf = (from: number, until: number): Clip => {
      const x = (t: number) => bez(EASES.inOut(prog(t, drawFrom, arrive - drawFrom))).x;
      const times = exportFrameTimes(from, until, fps);
      const far = sgn < 0 ? bounds.x1 - 40 * u : bounds.x2 + 40 * u;
      const near = (t: number) => (t >= arrive ? P3.x - sgn * 30 * u : x(t));
      const steps = stepped([...times.map((t) => [t, near(t)] as const), [arrive, P3.x - sgn * 30 * u]]);
      return sgn < 0
        ? { x1: [[from, far]], x2: steps, y1: [[from, bounds.y1]], y2: [[from, bounds.y2]] }
        : { x1: steps, x2: [[from, far]], y1: [[from, bounds.y1]], y2: [[from, bounds.y2]] };
    };
    const curvePath: PathCmd[] = [["M", P0.x, P0.y], ["C", P1.x, P1.y, P2.x, P2.y, P3.x, P3.y]];
    const anchorSize = 15 * u * cs;
    const handleFrom = animated ? tA : staticFrom;
    const bFrom = animated ? arrive - 40 : staticFrom;
    const curveFrom = animated ? exportFrameAtOrAfter(drawFrom + 1, fps) : staticFrom;
    const curveClip = animated ? { clip: wipeOf(curveFrom, arrive) } : {};
    deco("curvek", 7, curveFrom, curvePath, undefined, { stroke: { widthPx: 9 * u * cs, colour: INK, alpha: 0.6 }, ...curveClip });
    deco("curve", 7, curveFrom, curvePath, undefined, { stroke: { widthPx: 4 * u * cs, colour: WHITE }, ...curveClip });
    const pop = (from: number, dur: number): Key[] => (animated ? [[from, 0.2], [from + dur, 1, "spring"]] : [[from, 1]]);
    for (const [suffix, a, b, from] of [["handleA", P0, P1, handleFrom], ["handleB", P3, P2, bFrom]] as const) {
      const fade = withExit(animated ? [[from, 0], [from + 180, 1, "out"]] : [[from, 1]]);
      const path = handlePath(a, b);
      deco(`${suffix}k`, 7, from, path, INK, { stroke: { widthPx: 6.5 * u * cs, colour: INK, alpha: 0.6 } }, { o: fade });
      deco(suffix, 7, from, path, WHITE, { stroke: { widthPx: 2.6 * u * cs, colour: WHITE } }, { o: fade });
    }
    for (const [suffix, point, from, dur] of [["anchorA", P0, handleFrom, 260], ["anchorB", P3, bFrom, 280]] as const) {
      const scale = pop(from, dur);
      deco(suffix, 8, from, squarePath(0, 0, anchorSize), WHITE, { stroke: { widthPx: 4 * u * cs, colour: INK } }, { x: [[from, point.x]], y: [[from, point.y]], sx: scale, sy: scale });
    }

    // The chip, its pinned corner on the anchor, tilted about that corner.
    if (showChip && label.length > 1) {
      const pinAt = animated ? Math.max(hs, exportFrameAtOrAfter(arrive - 20, fps)) : staticFrom;
      const cornerX = hangRight ? bx + PIN_GAP * u : bx - PIN_GAP * u;
      const cornerY = by + vs * 10 * u * cs;
      const tilt = vs * (hangRight ? 1 : -1) * tiltMag;
      const local = { x1: hangRight ? 0 : -chipW, x2: hangRight ? chipW : 0, y1: vs < 0 ? -chipH : 0, y2: vs < 0 ? 0 : chipH };
      const springing = animated && paintedFrameCount(pinAt, Math.min(decoLimit, pinAt + 460), fps) >= 4;
      const end = Math.min(decoLimit, pinAt + 460);
      const sc: Key[] = springing ? [[pinAt, 0.35], [end, 1, "spring"]] : [[pinAt, 1]];
      const rz: Key[] = springing ? [[pinAt, tilt * 2.8], [end, tilt, "spring"]] : [[pinAt, tilt]];
      const lift: Key[] = springing ? [[pinAt, cornerY - vs * 22 * u], [Math.min(end, pinAt + 200), cornerY, "outExpo"]] : [[pinAt, cornerY]];
      const shown: Key[] = springing ? [[pinAt, 0.6], [pinAt + 70, 1]] : [[pinAt, 1]];
      const track = { x: [[pinAt, cornerX]] as Key[], y: lift, sx: sc, sy: sc, rz, o: withExit(shown) };
      if (paintedFrameCount(pinAt, to, fps) >= 2) {
        pieces.push({
          ...ctx.shape("chip", pinAt, roundedRectPath(local.x1, local.y1, chipW, chipH, 15 * u * cs), track, accent),
          z: 8, shadows: [{ dx: 0, dy: 6 * u * cs, blur: 0, colour: INK, alpha: 0.9 }],
        });
        const ink = ctx.input.measure(label, FACE, fontPx, spacingOf(label));
        const centreX = (local.x1 + local.x2) / 2;
        const baseline = (local.y1 + local.y2) / 2 - (ink.inkTop + ink.inkBottom) / 2;
        pieces.push({
          id: `${ctx.id}:chiptext`, kind: "text", z: 9, fromMs: pinAt, toMs: to,
          text: label, face: FACE, sizePx: fontPx, letterSpacingEm: spacingOf(label), fill: INK,
          anchor: "baseline-center", language: cue.language,
          origin: { dx: -centreX, dy: -baseline }, track,
        } satisfies TextPiece);
      }
    }

    // The pen: drops onto A, follows the curve tip, clicks at B, swings away from the chip and lifts off.
    if (animated) {
      const penFrom = exportFrameAtOrAfter(td0 + 45, fps);
      const times = exportFrameTimes(penFrom, leaveTo, fps);
      const poses = times.map((t) => {
        const p = EASES.inOut(prog(t, drawFrom, arrive - drawFrom));
        const tip = t < arrive ? bez(p) : P3;
        const ti = t < arrive ? p : 1;
        const a = bez(Math.max(0, ti - 0.05));
        const b = bez(Math.min(1, ti + 0.05));
        const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const back = { x: -(b.x - a.x) / len, y: -(b.y - a.y) / len };
        const appear = EASES.out(prog(t, td0 + 45, 90));
        const leave = EASES.inOut(prog(t, leaveFrom, leaveTo - leaveFrom));
        const click = t < arrive - 30 ? 1 : t < arrive + 30 ? lerp(1, 0.84, EASES.out(prog(t, arrive - 30, 60))) : lerp(0.84, 1, EASES.out(prog(t, arrive + 30, 120)));
        const away = EASES.inOut(prog(t, arrive - 220, 220)) * PEN_AWAY;
        // The body leans along the curve but never more than 45 degrees from pointing away from the text.
        const raw = (Math.atan2(back.x, -back.y) * 180) / Math.PI - vs * sgn * away;
        const away0 = vs < 0 ? 0 : 180;
        const angle = away0 + clamp(((raw - away0 + 540) % 360) - 180, -45, 45);
        return {
          t,
          x: tip.x + leave * back.x * 110 * u * k,
          y: tip.y + leave * back.y * 110 * u * k + (1 - appear) * 40 * u * vs * k,
          rz: angle,
          s: click * lerp(0.85, 1, appear),
          o: appear * Math.max(0, 1 - 1.7 * leave),
        };
      });
      const gone = poses.findIndex((pose) => pose.o <= 0 && pose.t > arrive);
      if (gone >= 0) poses.length = gone + 1;
      const penTo = gone >= 0 ? poses[gone]!.t + 1 : leaveTo;
      if (poses.length >= 2) {
        const key = (pick: (pose: (typeof poses)[number]) => number): Key[] => poses.map((pose) => [pose.t, pick(pose)]);
        const track = { x: key((p) => p.x), y: key((p) => p.y), rz: key((p) => p.rz), sx: key((p) => p.s), sy: key((p) => p.s), o: key((p) => p.o) };
        const scale = 1.5 * u * cs;
        pieces.push({ ...ctx.shape("pen", penFrom, penBody(scale), track, WHITE), z: 10, toMs: penTo, stroke: { widthPx: 4.5 * u * cs, colour: INK } });
        pieces.push({ ...ctx.shape("pennib", penFrom, penDetail(scale), track, INK), z: 11, toMs: penTo });
      }
    }
  }

  // ---- extra beat: selection handles at the block's corners as the cue starts typing --------------------------------
  {
    const first = plans[0]!;
    const from = caretFrom;
    const until = Math.min(decoLimit, Math.max(first.whole, first.onset) + 260, from + 640);
    if (paintedFrameCount(from, until, fps) >= 2) {
      const size = 12 * u;
      const ox = 20 * u;
      const oy = 16 * u;
      const corners: [string, number, number][] = [];
      for (const y of [block.y1 - oy, block.y2 + oy]) {
        const top = y < block.y1;
        if (decoSide === "above" && top) continue;
        if (decoSide === "below" && !top) continue;
        corners.push([top ? "TL" : "BL", block.x1 - ox, y], [top ? "TR" : "BR", block.x2 + ox, y]);
      }
      const snap = paintedFrameCount(from, Math.min(until, from + 120), fps) >= 3;
      const fadeFrom = Math.max(from + frame, until - 140);
      const scale: Key[] = snap ? [[from, 0.4], [from + 120, 1, "outBack"]] : [[from, 1]];
      for (const [name, x, y] of corners) {
        pieces.push({
          ...ctx.shape(`handle${name}`, from, squarePath(0, 0, size), { x: [[from, x]], y: [[from, y]], sx: scale, sy: scale, o: [[from, 1], [fadeFrom, 1], [until, 0, "in"]] }, WHITE),
          z: 3, toMs: until, stroke: { widthPx: 3 * u, colour: INK },
        });
      }
    }
  }

  // ---- extra beat: a closing path segment along the last row (or the first, away from the pen decoration) ----------
  {
    const side = decoSide === "below" ? "above" : "below";
    const row = side === "below" ? rows.at(-1)! : rows[0]!;
    const box = rowBounds(row);
    const y = side === "below" ? box.y2 + 16 * u : box.y1 - 16 * u;
    const last = plans.at(-1)!;
    const lastOnset = last.onset;
    let from = Math.max(lastOnset, last.whole);
    if (paintedFrameCount(from, decoLimit, fps) < 4) from = Math.max(lastOnset, exportFrameAtOrBefore(decoLimit - 3 * frame, fps));
    const frames = paintedFrameCount(from, decoLimit, fps);
    if (frames >= 2) {
      const thick = 5 * u;
      const anchor = 11 * u;
      const path = [...rectPath(box.x1, y - thick / 2, box.x2 - box.x1, thick), ...squarePath(box.x1, y, anchor), ...squarePath(box.x2, y, anchor)];
      const wipe = Math.min(200, (decoLimit - from) * 0.5);
      const moving = paintedFrameCount(from, from + wipe, fps) >= 3;
      const reach = { x1: box.x1 - anchor, x2: box.x2 + anchor };
      const span: Key[] = rtl ? [[from, reach.x2], [from + wipe, reach.x1, "out"]] : [[from, reach.x1], [from + wipe, reach.x2, "out"]];
      // The clip leaves room for the exit's small drop, which the path rides with the words.
      const top = y - anchor;
      const bottom = y + anchor + 12 * u;
      const clip: Clip = moving
        ? rtl
          ? { x1: span, x2: [[from, reach.x2]], y1: [[from, top]], y2: [[from, bottom]] }
          : { x1: [[from, reach.x1]], x2: span, y1: [[from, top]], y2: [[from, bottom]] }
        : rectClipOf(from, { x1: reach.x1, x2: reach.x2, y1: top, y2: bottom });
      pieces.push({ ...ctx.shape("path", from, path, { y: ctx.drift(from, 0, 0, from, 10 * u) }, WHITE), z: 3, clip, stroke: { widthPx: 2.5 * u, colour: INK, alpha: 0.85 } });
    }
  }
  return pieces;
}, undefined, LEAD);

function rectClipOf(at: number, box: Box): Clip {
  return { x1: [[at, box.x1]], x2: [[at, box.x2]], y1: [[at, box.y1]], y2: [[at, box.y2]] };
}


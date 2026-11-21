import type { DemoScript } from "../demo";
import { type Frames, EASES, clamp, lerp, prog } from "../ease";
import type { SceneCue, SceneInput, SceneProgram } from "../input";
import { balancedRows, clampToSafeArea, cueDirection, rowVisualOrder, sceneSpace } from "../layout";
import type { CaptionFontName } from "@narriflow/validators";
import { type ColourFrames, type Piece, type ShapePiece, type TextPiece, mixColour } from "../scene";
import { ellipsePath } from "../shapes";
import { sampleFrames } from "../frames";

/**
 * Aura (`samples/templates/44-aura.js`): dark plum words drift into focus on three soft orbs of pink, periwinkle and
 * peach light that sit behind the caption, drift, swell with each word and draw together behind the hero.
 *
 * Geometry is the sample's, read from its layout in Chrome (`.scratch/motion-captions/tools/probe-sample.ts`): support
 * words Inter Tight Medium 58 px (74 px in a cue without a hero, two rows by count), the hero Instrument Serif Regular
 * 210 px fitted to 760 px, rows 1.22 em apart, words 0.27 em apart; a word's baseline is 0.862 em (Inter Tight) and
 * 0.838 em (Instrument Serif) below the top of its `line-height: 1` box.
 *
 * What changed from the sample, and why:
 * - **The orbs are one piece each per stretch of speech** (a "group": cues less than 600 ms apart), not a fixed trio for the
 *   whole clip: they fade in at the group's first word and out at its last, so a long silence shows no floating light.
 * - **No jump at a cue change.** The sample reads the new cue's layout the instant it starts, so an orb that had gathered
 *   behind a hero snaps back to the old layout's position (up to 0.42 of its distance). Here the layout glides from where the
 *   orb is, the gather is added on top of it, and nothing is ever read by cue index.
 * - **Layouts cycle.** The sample puts pink upper left, periwinkle right, peach low. Here the three positions rotate through the
 *   three orbs by a per-cue counter (hero cues and cues without a hero count apart; a hash of the cue mirrors every other
 *   one), so the orbs travel to a new place on every cue.
 * - **The aura fits any cue.** The sample's orb size comes from the block's width and height only; here it grows until the orbs'
 *   blurred cores cover every word's ink box (`auraCoverage`, 0.9 with the drift's reach to spare), so a nine-word cue, a 16:9
 *   frame or a user's larger text size never ends with ink on the dark edge.
 * - **A cue without a hero** also gathers the orbs a little (0.16 of the hero's pull) behind its last word.
 * - **Real speech timing.** A word needs 160 ms on screen after it lands: its focus is shortened (never below 150 ms) when the cue
 *   ends soon after it, and the cue's exit waits for the last word, but never past the cue's end (a cue that ends sooner than that shortens its hold). The sample's 300 ms `cueGap` is not assumed.
 * - **Letter spacing** (0.08 em to rest) is animated in four steps (a piece per step); only for scripts where spacing
 *   separates letters harmlessly. Arabic, Urdu, the Indic scripts, Thai, Khmer and CJK just focus (blur and opacity).
 * - **Case**: lower case only for Latin, Greek and Cyrillic words (with the cue's language: Turkish keeps its dotless i).
 * - **Rows fit.** The sample's rows are 1080 px and never wrap: a word wider than the safe width shrinks the cue, a row wider
 *   than it wraps evenly into more rows, and the hero's offsets from its neighbours widen when its ink is taller than
 *   Instrument Serif's (a fallback face for a script it cannot draw).
 * - **Blur cost.** libass blends a blurred disc's whole bitmap every frame, moving or not (measured: a still orb costs the same), so
 *   cost goes with bitmap area and sigma. The sample's 600/540/470 px orbs at sigma 70 rendered at 2.4x Headline (12x in libass alone);
 *   here they are 480/432/376 px at sigma 25 (a solid core of d/2 - 1.3 sigma is 207 px against the sample's 209) and each is cut to a
 *   rectangle 2.6 sigma past its disc, where the blur is under 1/255. Stacked translucent discs were tried and cost more (one layer
 *   costs as much as a blurred one). Edges are crisper than the sample's.
 */

export const AURA_DEMO: DemoScript = {
  lines: [
    "you:m don't:b have:b to:m rush",
    "healing:b takes:b time:h@720",
    "be:m gentle:h@740 with:m yourself:b",
    "just:b breathe:h@820",
  ],
  options: { rate: 340, gap: 40, cueGap: 300, lead: 450, tail: 900 },
};

const CX = 540;
const CENTER_Y = 1290;
const BODY = 58;
const SOLO = 74;
const HERO = 210;
const HERO_FIT = 760;
/** Gaussian sigma of an orb's blur, sample px (the sample's 70 costs 2.4x Headline; see the header). */
const BLUR = 25;
const BODY_FACE = "Inter Tight Medium" as const;
const HERO_FACE = "Instrument Serif Regular" as const;
const REST_LS = { body: -0.008, hero: -0.012 } as const;
const BASELINE = { body: 0.862, hero: 0.838 } as const;
const WORD_GAP = 0.27;
const ROW_PITCH = 1.22;
const ORB_C = "#FFC27A";
const ORBS = [
  { d: 480, phase: 0, dir: 1, period: 8800 },
  { d: 432, phase: 2.1, dir: -1, period: 7400 },
  { d: 376, phase: 4, dir: 1, period: 6400 },
] as const;

const LEAD = 150;
const FOCUS = 420;
const FOCUS_MIN = 150;
const READ = 160;
const EXIT_BEFORE = 200;
const EXIT = 140;
const EXIT_MIN = 60;
const EXIT_LATEST = 80;
const HIDE_AFTER_FADE = 20;
const SPACE_FROM = 0.08;
/** Where each letter-spacing step starts, as a share of the focus: the piece then holds `out(middle of the step)`. */
const STEPS = [0, 0.18, 0.4, 0.68] as const;
/** Cues this far apart (cue end to next start) are separate stretches of speech: the orbs leave in between. */
const GROUP_GAP_MS = 600;
const MOVE_AT = 250;
const MOVE_MS = 750;
const GATHER = { in: 140, ms: 420, relax: 650, after: 60 } as const;
const COVER = 0.9;
const MAX_SCALE = 2.2;
const DRIFT = 26;

/** The three places an orb takes in a cue (share of the block's width and height from its centre). */
const SLOTS = [
  { fx: -0.24, fy: -0.1 },
  { fx: 0.26, fy: 0.04 },
  { fx: 0.02, fy: 0.32 },
] as const;
/** Which slot orb i takes in arrangement k: the sample's (pink upper left, periwinkle right, peach low), then two rotations. */
const ARRANGEMENTS = [
  [0, 1, 2],
  [1, 2, 0],
  [2, 0, 1],
] as const;

const SIMPLE_SPACING = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{N}\p{P}\p{S}\p{M}']+$/u;
const CASED = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{N}\p{P}\p{S}\p{M}\p{Z}']+$/u;

/** `text-transform: lowercase` for the scripts that have case; any other text is left alone. */
export function auraLower(text: string, language: string | null): string {
  if (!CASED.test(text)) return text;
  try {
    return text.toLocaleLowerCase(language ?? undefined);
  } catch {
    return text.toLowerCase();
  }
}

/** Letters may be spaced out (and back) without a break in the writing. */
export function auraSpacesLetters(text: string): boolean {
  return SIMPLE_SPACING.test(text);
}

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return sign * (1 - poly * Math.exp(-a * a));
}

export interface AuraDisc {
  readonly x: number;
  readonly y: number;
  /** Radius of the flat disc before the blur, px. */
  readonly r: number;
}

/** How much of a point is lit by the blurred orbs: each is a disc blurred with a Gaussian of `sigma` (its edge profile), laid over the others. */
export function auraCoverage(discs: readonly AuraDisc[], sigma: number, px: number, py: number): number {
  let dark = 1;
  for (const disc of discs) dark *= 1 - 0.5 * (1 + erf((disc.r - Math.hypot(px - disc.x, py - disc.y)) / (sigma * Math.SQRT2)));
  return 1 - dark;
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

interface WordBox {
  readonly index: number;
  readonly text: string;
  readonly face: CaptionFontName;
  readonly size: number;
  readonly restLs: number;
  readonly spaced: boolean;
  /** Centre of the word's slot and its baseline, canvas px. */
  cx: number;
  baseline: number;
  /** The row's centre line. */
  cy: number;
  readonly halfWidth: number;
  readonly hero: boolean;
}

interface CueGeometry {
  readonly cue: SceneCue;
  readonly number: number;
  readonly words: WordBox[];
  readonly heroAt: number;
  /** The hero row's centre line, canvas px (null without a hero). */
  heroCy: number | null;
  /** Bounds of the ink for fitting the aura, canvas px. */
  box: { cx: number; cy: number; w: number; h: number };
}

function buildGeometry(cue: SceneCue, number: number, input: SceneInput): CueGeometry {
  const space = sceneSpace(input, CENTER_Y);
  const { u } = space;
  const rtl = cueDirection(cue) === "rtl";
  // Rows wrap a little inside the safe width: while a word focuses its letters are spaced out, up to 0.08 em.
  const safeWidth = 0.9 * space.canvas.width;
  const maxRow = 0.94 * safeWidth;
  const ox = space.x(CX);
  const heroAt = cue.words.findIndex((word) => word.role === "hero");
  const lowered = cue.words.map((word) => auraLower(word.text, cue.language));
  const advance = (at: number, face: CaptionFontName, size: number, ls: number) => input.measure(lowered[at]!, face, size, ls).advance + ls * size;
  /** A word's widest moment: letters spaced out at the start of its focus (never more than the safe width). */
  const widest = (at: number, face: CaptionFontName, size: number, ls: number) => advance(at, face, size, auraSpacesLetters(lowered[at]!) ? SPACE_FROM : ls);

  // Rows of word indices at one size; a row's words in the order the viewer reads them from the left.
  const rowsOf = (indices: readonly number[], size: number, force?: number[][]) => {
    const widths = indices.map((at) => advance(at, BODY_FACE, size, REST_LS.body));
    const gap = WORD_GAP * size;
    if (force) return force.map((row) => row.map((k) => indices[k]!));
    return balancedRows(widths, gap, maxRow).map((row) => row.map((k) => indices[k]!));
  };
  const words: WordBox[] = [];
  const place = (row: readonly number[], size: number, cy: number, hero: boolean) => {
    const face = hero ? HERO_FACE : BODY_FACE;
    const ls = hero ? REST_LS.hero : REST_LS.body;
    const order = rowVisualOrder(row.map((at) => lowered[at]!), rtl ? "rtl" : "ltr").map((k) => row[k]!);
    const widths = order.map((at) => advance(at, face, size, ls));
    const gap = WORD_GAP * size;
    const total = widths.reduce((sum, w) => sum + w, 0) + gap * (order.length - 1);
    let left = ox - total / 2;
    const baseline = cy - size / 2 + (hero ? BASELINE.hero : BASELINE.body) * size;
    order.forEach((at, k) => {
      words.push({ index: at, text: lowered[at]!, face, size, restLs: ls, spaced: auraSpacesLetters(lowered[at]!), cx: left + widths[k]! / 2, baseline, cy, halfWidth: widths[k]! / 2, hero });
      left += widths[k]! + gap;
    });
  };

  let heroCy: number | null = null;
  if (heroAt < 0) {
    const all = cue.words.map((_, at) => at);
    const natural = (size: number) => all.map((at) => advance(at, BODY_FACE, size, REST_LS.body));
    let size = SOLO * u;
    // A word wider than a row can't wrap: the cue shrinks until it fits.
    const widestWord = Math.max(...all.map((at) => widest(at, BODY_FACE, size, REST_LS.body)));
    if (widestWord > safeWidth) size *= safeWidth / widestWord;
    const split = Math.ceil(all.length / 2);
    let rows = [all.slice(0, split), all.slice(split)].filter((row) => row.length > 0);
    const widths = natural(size);
    const rowWidth = (row: number[]) => row.reduce((sum, at) => sum + widths[at]!, 0) + WORD_GAP * size * (row.length - 1);
    if (rows.some((row) => rowWidth(row) > maxRow)) rows = rowsOf(all, size);
    const pitch = size * ROW_PITCH;
    const y0 = space.y(CENTER_Y) - ((rows.length - 1) * pitch) / 2;
    rows.forEach((row, ri) => {
      place(row, size, y0 + ri * pitch, false);
    });
  } else {
    const heroText = lowered[heroAt]!;
    const probe = input.measure(heroText, HERO_FACE, HERO * u, REST_LS.hero);
    const probeWidth = probe.advance + REST_LS.hero * HERO * u;
    const probeWide = widest(heroAt, HERO_FACE, HERO * u, REST_LS.hero);
    let F = Math.min(HERO, (HERO * (HERO_FIT * u)) / probeWidth);
    F = Math.min(F, (HERO * safeWidth) / probeWide);
    const lead = cue.words.slice(0, heroAt).map((_, at) => at);
    const tail = cue.words.slice(heroAt + 1).map((_, at) => heroAt + 1 + at);
    let body = BODY * u;
    const widestBody = Math.max(0, ...[...lead, ...tail].map((at) => widest(at, BODY_FACE, body, REST_LS.body)));
    if (widestBody > safeWidth) body *= safeWidth / widestBody;
    const leadRows = rowsOf(lead, body);
    const tailRows = rowsOf(tail, body);
    const heroInk = input.measure(heroText, HERO_FACE, F * u, REST_LS.hero);
    // Offsets from the hero's centre line, canvas px (y down). The sample's -(F/2 + 18) and F/2 + 30 are tuned to Instrument Serif;
    // the ink of the hero (a taller fallback face) can push them out.
    const heroBase = (-F / 2 + BASELINE.hero * F) * u;
    const inkTop = heroBase + heroInk.inkTop;
    const inkBottom = heroBase + heroInk.inkBottom;
    const bodyBase = (BASELINE.body - 0.5) * body;
    const rowInk = (row: readonly number[]) => {
      const m = row.map((at) => input.measure(lowered[at]!, BODY_FACE, body, REST_LS.body));
      return { top: Math.min(...m.map((x) => x.inkTop)), bottom: Math.max(...m.map((x) => x.inkBottom)) };
    };
    const pitch = body * ROW_PITCH;
    let leadCy0 = -(F * 0.5 + 18) * u;
    if (leadRows.length > 0) {
      const last = leadRows[leadRows.length - 1]!;
      leadCy0 = Math.min(leadCy0, inkTop - 4 * u - rowInk(last).bottom - bodyBase);
    }
    let tailCy0 = (F * 0.5 + 30) * u;
    if (tailRows.length > 0) tailCy0 = Math.max(tailCy0, inkBottom + 4 * u - rowInk(tailRows[0]!).top - bodyBase);
    // Rows nearest the hero first: lead rows stack upward, tail rows downward.
    const leadTop = leadRows.length > 0 ? leadCy0 - (leadRows.length - 1) * pitch - body / 2 : -F * 0.36 * u;
    const tailBottom = tailRows.length > 0 ? tailCy0 + (tailRows.length - 1) * pitch + body / 2 : F * 0.4 * u;
    heroCy = space.y(CENTER_Y) - (leadTop + tailBottom) / 2;
    leadRows.forEach((row, j) => {
      place(row, body, heroCy! + leadCy0 - (leadRows.length - 1 - j) * pitch, false);
    });
    // The first lead row (reading order) is the highest; `leadRows[last]` is the one beside the hero.
    place([heroAt], F * u, heroCy, true);
    tailRows.forEach((row, j) => {
      place(row, body, heroCy! + tailCy0 + j * pitch, false);
    });
  }

  let x0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  for (const word of words) {
    x0 = Math.min(x0, word.cx - word.halfWidth);
    x1 = Math.max(x1, word.cx + word.halfWidth);
  }
  const rowsByY = [...words].sort((a, b) => a.cy - b.cy);
  const first = rowsByY[0]!;
  const last = rowsByY[rowsByY.length - 1]!;
  const y0 = first.cy - first.size * 0.42;
  const y1 = last.cy + last.size * 0.42;
  return { cue, number, words, heroAt, heroCy, box: { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 } };
}

interface Timing {
  /** When each word's focus starts and how long it takes (parallel to the geometry's words). */
  readonly from: number[];
  readonly focus: number[];
  readonly exitFrom: number;
  readonly fadeEnd: number;
  readonly hide: number;
}

/** The cue's schedule: focus per word, then an exit that waits until the last word has been readable for `READ` ms. */
export function auraTiming(cue: SceneCue, order: readonly number[]): Timing {
  let exitFrom = cue.endMs - EXIT_BEFORE;
  const from = order.map((at) => cue.words[at]!.startMs - LEAD);
  const focus = from.map((a) => clamp(exitFrom - READ - a, FOCUS_MIN, FOCUS));
  const lands = Math.max(...from.map((a, k) => a + focus[k]!));
  // The exit waits for the last word to be readable, but it is over by the cue's end (the next cue's text takes its place).
  exitFrom = Math.min(Math.max(exitFrom, lands + READ), cue.endMs - EXIT_LATEST);
  const fadeEnd = Math.min(Math.max(cue.endMs - EXIT_BEFORE + EXIT, exitFrom + EXIT_MIN), cue.endMs - 20);
  return { from, focus, exitFrom, fadeEnd, hide: Math.min(fadeEnd + HIDE_AFTER_FADE, cue.endMs) };
}

function textPieces(g: CueGeometry, input: SceneInput): TextPiece[] {
  const { cue, number } = g;
  const timing = auraTiming(cue, g.words.map((word) => word.index));
  const pieces: TextPiece[] = [];
  const z = 10 + number * 2;
  g.words.forEach((word, k) => {
    const a = timing.from[k]!;
    const F = timing.focus[k]!;
    const land = a + F;
    const blurAt = (t: number) => 14 * (1 - EASES.out(prog(t, a, F)));
    const opacityAt = (t: number) => EASES.out(prog(t, a, F));
    const steps = word.spaced ? STEPS : ([0] as const);
    steps.forEach((share, step) => {
      const t0 = a + share * F;
      const last = step === steps.length - 1;
      const t1 = last ? timing.hide : a + steps[step + 1]! * F;
      const mid = last ? 1 : (share + steps[step + 1]!) / 2;
      const space = word.spaced ? lerp(SPACE_FROM, word.restLs, EASES.out(mid)) : word.restLs;
      // The focus curve over this piece's share of it (one exact eased segment when the word is a single piece).
      const focusing = (fn: (t: number) => number, tol: number): Frames =>
        steps.length === 1 ? [[a, fn(a)], [land, fn(land), "out"]] : sampleFrames(fn, [], tol, { range: [t0, Math.min(t1, land)] });
      const leaving = (rest: number, to: number): Frames => [...(timing.exitFrom > land ? ([[timing.exitFrom, rest]] as const) : []), [timing.fadeEnd, to, "out"]];
      const track = (fn: (t: number) => number, tol: number, rest: number, to: number): Frames => {
        if (t0 >= land) return [[t0, rest], ...leaving(rest, to)];
        return last ? [...focusing(fn, tol), ...leaving(rest, to)] : focusing(fn, tol);
      };
      pieces.push({
        id: `aura:${number}:w${word.index}${steps.length > 1 ? `s${step}` : ""}`,
        kind: "text",
        z,
        fromMs: t0,
        toMs: t1,
        track: { x: [[t0, word.cx]], y: [[t0, word.baseline]], o: track(opacityAt, 0.004, 1, 0), blur: track(blurAt, 0.05, 0, 10) },
        text: word.text,
        face: word.face,
        sizePx: word.size,
        letterSpacingEm: space,
        fill: input.colours.primary,
        anchor: "baseline-center",
        language: cue.language,
      });
    });
  });
  return pieces;
}

interface OrbState {
  x: number;
  y: number;
  s: number;
}

/** One cue's resting layout of the three orbs, fitted so the blurred cores cover every word. */
function orbLayout(g: CueGeometry, arrangement: number, mirror: boolean, u: number): OrbState[] {
  const { box } = g;
  const sigma = BLUR * u;
  const k = clamp((box.w / u + 330) / 1000, 0.82, 1.1);
  const kh = clamp((box.h / u + 260) / 600, 0.85, 1.1);
  const s0 = Math.max(k, kh);
  const slots = ARRANGEMENTS[arrangement]!.map((slot) => SLOTS[slot]!);
  const place = (s: number): OrbState[] =>
    slots.map((slot, i) => ({
      x: box.cx + (mirror ? -slot.fx : slot.fx) * box.w,
      y: box.cy + slot.fy * box.h,
      s: i === 2 ? s * 0.96 : s,
    }));
  // The points that have to be lit: each word's ink box corners and edge middles.
  const points: [number, number][] = [];
  for (const word of g.words) {
    const top = word.baseline - 0.72 * word.size;
    const bottom = word.baseline + 0.22 * word.size;
    const left = word.cx - word.halfWidth;
    const right = word.cx + word.halfWidth;
    for (const px of [left, word.cx, right]) for (const py of [top, bottom]) points.push([px, py]);
  }
  const lit = (orbs: OrbState[]) => {
    const discs = orbs.map((orb, i) => ({ x: orb.x, y: orb.y, r: (ORBS[i]!.d / 2) * u * orb.s - DRIFT * u }));
    return points.every(([px, py]) => auraCoverage(discs, sigma, px, py) >= COVER);
  };
  let s = s0;
  while (s < MAX_SCALE && !lit(place(s))) s += 0.04;
  return place(Math.min(s, MAX_SCALE));
}

interface Group {
  readonly geometries: CueGeometry[];
}

/** Cues that follow one another (less than `GROUP_GAP_MS` between one's end and the next's start) share their orbs. */
function groupsOf(geometries: readonly CueGeometry[]): Group[] {
  const groups: Group[] = [];
  for (const g of geometries) {
    const group = groups[groups.length - 1];
    const previous = group?.geometries[group.geometries.length - 1];
    if (group && previous && g.cue.startMs - previous.cue.endMs <= GROUP_GAP_MS) group.geometries.push(g);
    else groups.push({ geometries: [g] });
  }
  return groups;
}

const shiftFrames = (frames: Frames, by: number): Frames => frames.map((f) => (f[2] === undefined ? [f[0], f[1] + by] : [f[0], f[1] + by, f[2]])) as unknown as Frames;

function orbPieces(group: Group, layouts: ReadonlyMap<number, OrbState[]>, centreX: Map<number, number>, groupNumber: number, input: SceneInput): ShapePiece[] {
  const { u } = sceneSpace(input, CENTER_Y);
  const cues = group.geometries;
  const firstCue = cues[0]!.cue;
  const lastCue = cues[cues.length - 1]!.cue;
  const from = firstCue.startMs - 200;
  const outroFrom = lastCue.endMs - 200;
  const to = outroFrom + 380;
  const intro = (t: number) => EASES.out(prog(t, from, 400));
  const outro = (t: number) => EASES.inOut(prog(t, outroFrom, 380));

  // --- the resting layout: each cue glides from where the orbs were to its own, starting 250 ms before its first word ---
  const windows = cues.map((g) => g.cue.startMs - MOVE_AT);
  const resting = cues.map((g) => layouts.get(g.number)!);
  const startOf: OrbState[][] = [resting[0]!];
  const mix = (a: OrbState[], b: OrbState[], p: number): OrbState[] => a.map((orb, i) => ({ x: lerp(orb.x, b[i]!.x, p), y: lerp(orb.y, b[i]!.y, p), s: lerp(orb.s, b[i]!.s, p) }));
  for (let c = 1; c < cues.length; c++) startOf.push(mix(startOf[c - 1]!, resting[c - 1]!, EASES.inOut(prog(windows[c]!, windows[c - 1]!, MOVE_MS))));
  const layoutAt = (t: number): OrbState[] => {
    let lo = 0;
    let hi = cues.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (windows[mid]! <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo === 0 ? resting[0]! : mix(startOf[lo]!, resting[lo]!, EASES.inOut(prog(t, windows[lo]!, MOVE_MS)));
  };

  // --- the pulls: a hero draws the orbs behind it (and warms the biggest); other cues pull a little behind their last word ---
  interface Pull {
    readonly start: number;
    readonly end: number;
    readonly strength: number;
    readonly x: number;
    readonly y: number;
    readonly warm: boolean;
  }
  const pulls: Pull[] = cues.map((g) => {
    const hero = g.heroAt >= 0 ? g.cue.words[g.heroAt]! : null;
    const focus = hero ?? g.cue.words[g.cue.words.length - 1]!;
    return {
      start: focus.startMs,
      end: focus.endMs,
      strength: hero ? 0.42 : 0.16,
      x: centreX.get(g.number)!,
      y: g.heroCy ?? g.box.cy,
      warm: hero !== null,
    };
  });
  const pullAt = (p: Pull, t: number) => {
    const relax = 1 - EASES.inOut(prog(t, p.end + GATHER.after, GATHER.relax));
    return { gather: EASES.inOut(prog(t, p.start - GATHER.in, GATHER.ms)) * relax, warm: p.warm ? EASES.inOut(prog(t, p.start, Math.max(1, p.end - p.start))) * relax : 0 };
  };

  // --- swell: each spoken word breathes the orb nearest it, 1 to 1.1 to 1 over 420 ms ---
  interface Swell {
    readonly start: number;
    readonly orb: number;
  }
  const swells: Swell[] = [];
  for (const g of cues) {
    const layout = layouts.get(g.number)!;
    for (const word of g.words) {
      let best = 0;
      let bestD = Number.POSITIVE_INFINITY;
      layout.forEach((orb, i) => {
        const d = Math.hypot(orb.x - word.cx, orb.y - word.cy);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      swells.push({ start: g.cue.words[word.index]!.startMs, orb: best });
    }
  }
  swells.sort((a, b) => a.start - b.start);
  const swellAt = (orb: number, t: number) => {
    let lo = 0;
    let hi = swells.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (swells[mid]!.start < t - FOCUS) lo = mid + 1;
      else hi = mid;
    }
    let out = 0;
    for (let k = lo; k < swells.length && swells[k]!.start <= t; k++) if (swells[k]!.orb === orb) out = Math.max(out, Math.sin((Math.PI * (t - swells[k]!.start)) / FOCUS));
    return out;
  };

  const drift = (i: number, t: number) => {
    const o = ORBS[i]!;
    const w = (2 * Math.PI * t) / o.period;
    return { x: DRIFT * u * Math.sin(o.dir * w + o.phase), y: (i === 2 ? 14 * Math.sin(2 * w + o.phase) : 22 * Math.cos(o.dir * w + o.phase)) * u };
  };
  const stateAt = (i: number, t: number) => {
    const layout = layoutAt(t)[i]!;
    const d = drift(i, t);
    let x = layout.x + d.x;
    let y = layout.y + d.y;
    for (const pull of pulls) {
      if (t < pull.start - GATHER.in || t > pull.end + GATHER.after + GATHER.relax) continue;
      const { gather } = pullAt(pull, t);
      const k = pull.strength * gather;
      x = lerp(x, pull.x, k);
      y = lerp(y, pull.y + (i === 2 ? 40 * u : 0), k);
    }
    const s = layout.s * (1 + 0.1 * swellAt(i, t)) * lerp(0.82, 1, intro(t));
    return { x, y, s };
  };
  const warmAt = (t: number) => {
    let warm = 0;
    for (const pull of pulls) if (pull.warm && t >= pull.start && t <= pull.end + GATHER.after + GATHER.relax) warm = Math.max(warm, pullAt(pull, t).warm);
    return warm;
  };

  // The times the curves bend at, plus a grid for the drift's sine.
  const edges = new Set<number>([from, to, from + 400, outroFrom]);
  for (let t = from; t < to; t += 500) edges.add(t);
  for (const w of windows) {
    edges.add(w);
    edges.add(w + MOVE_MS);
  }
  for (const pull of pulls) for (const t of [pull.start - GATHER.in, pull.start - GATHER.in + GATHER.ms, pull.start, pull.end, pull.end + GATHER.after, pull.end + GATHER.after + GATHER.relax]) edges.add(t);
  for (const swell of swells) {
    edges.add(swell.start);
    edges.add(swell.start + FOCUS);
  }
  const sorted = [...edges].filter((t) => t >= from && t <= to).sort((a, b) => a - b);

  const colours = [input.colours.highlight, input.colours.accent, ORB_C];
  const pieces: ShapePiece[] = [];
  ORBS.forEach((orb, i) => {
    const r = (orb.d / 2) * u;
    const opacity: Frames =
      from + 400 <= outroFrom
        ? [[from, 0], [from + 400, 1, "out"], [outroFrom, 1], [to, 0, "inOut"]]
        : sampleFrames((t) => intro(t) * (1 - outro(t)), [from, from + 400, outroFrom, to].sort((a, b) => a - b), 0.004);
    let colour: ColourFrames | undefined;
    if (i === 0) {
      const warmEdges = pulls.filter((p) => p.warm).flatMap((p) => [p.start, p.end, p.end + GATHER.after, p.end + GATHER.after + GATHER.relax]);
      if (warmEdges.length > 0) {
        const times = new Set<number>([from]);
        for (const pull of pulls) {
          if (!pull.warm) continue;
          for (let t = pull.start - 40; t <= pull.end + GATHER.after + GATHER.relax + 40; t += 40) times.add(Math.max(from, Math.min(to, t)));
        }
        const list = [...times].sort((a, b) => a - b);
        colour = list.map((t) => [t, mixColour(colours[0]!, ORB_C, 0.85 * warmAt(t))] as const);
      }
    }
    const x = sampleFrames((t) => stateAt(i, t).x, sorted, 0.5);
    const y = sampleFrames((t) => stateAt(i, t).y, sorted, 0.5);
    const scale = sampleFrames((t) => stateAt(i, t).s, sorted, 0.005);
    // libass blends the whole bitmap of a blurred disc every frame: cut it to where the blur is still visible (under 1/255 beyond 2.6 sigma).
    const reach = r * Math.max(...scale.map((frame) => frame[1])) + 2.6 * BLUR * u;
    pieces.push({
      id: `aura:orb${groupNumber}:${i}`,
      kind: "shape",
      z: 0,
      fromMs: from,
      toMs: to,
      bleed: true,
      clip: { x1: shiftFrames(x, -reach), x2: shiftFrames(x, reach), y1: shiftFrames(y, -reach), y2: shiftFrames(y, reach) },
      track: { x, y, sx: scale, sy: scale, o: opacity, blur: [[from, BLUR * u]], ...(colour ? { colour } : {}) },
      origin: { dx: r, dy: r },
      path: ellipsePath(r, r, r),
      fill: { colour: colours[i]! },
    });
  });
  return pieces;
}

export const auraProgram: SceneProgram = {
  build(input) {
    const space = sceneSpace(input, CENTER_Y);
    const pieces: Piece[] = [];
    const geometries: CueGeometry[] = [];
    const layouts = new Map<number, OrbState[]>();
    const centreX = new Map<number, number>();
    let heroCount = 0;
    let soloCount = 0;
    input.cues.forEach((cue, number) => {
      if (cue.words.length === 0) return;
      const g = buildGeometry(cue, number, input);
      const text = textPieces(g, input);
      const shifted = clampToSafeArea(text, space.safe, input.measure);
      const dx = shifted.length > 0 ? shifted[0]!.track.x![0]![1] - text[0]!.track.x![0]![1] : 0;
      const dy = shifted.length > 0 ? shifted[0]!.track.y![0]![1] - text[0]!.track.y![0]![1] : 0;
      for (const word of g.words) {
        word.cx += dx;
        word.baseline += dy;
        word.cy += dy;
      }
      g.box.cx += dx;
      g.box.cy += dy;
      if (g.heroCy !== null) g.heroCy += dy;
      pieces.push(...shifted);
      const hero = g.heroAt >= 0;
      const counter = hero ? heroCount++ : soloCount++;
      const arrangement = (counter + (hero ? 0 : 1)) % ARRANGEMENTS.length;
      const mirror = (hash(`${cue.index}:${cue.words[0]!.text}`) & 1) === 1;
      layouts.set(number, orbLayout(g, arrangement, mirror, space.u));
      centreX.set(number, space.x(CX) + dx);
      geometries.push(g);
    });
    groupsOf(geometries).forEach((group, number) => {
      pieces.push(...orbPieces(group, layouts, centreX, number, input));
    });
    return { pieces };
  },
};

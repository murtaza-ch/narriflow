import type { DemoScript } from "../demo";
import { type Frames, EASES, clamp, kf, lerp, prog } from "../ease";
import { sampleFrames } from "../frames";
import type { SceneCue, SceneInput, SceneProgram } from "../input";
import { clampToSafeArea, cueDirection, fitScale, greedyRows, rowVisualOrder, sceneSpace } from "../layout";
import type { Piece, TextPiece } from "../scene";

/**
 * Stretch (`samples/templates/m07-stretch.js`): a small heavy line types on word by word, then the hero word springs
 * up out of the floor, squashed flat and wide, stretching to full height with a little overshoot and shoving the line
 * above it out of the way. On exit everything squashes back into the floor.
 *
 * Geometry is the sample's, read in Chrome (`.scratch/motion-captions/tools/probe-sample.ts`): Dela Gothic One, the line
 * 66 px (84 px without a hero), centred words that wrap inside a 920 px zone, 0.26 em between words and 0.08 em between
 * rows; the hero at most 270 px, fitted to 880 px, its `line-height: 0.86` box pivoting at 88 % of its height; the line
 * rides 22 px above the hero's cap line on the hero's current height; the finished block is centred on y 1290.
 *
 * Changes from the sample, and why:
 *  - Words after the hero were dropped (the sample keeps `slice(0, heroAt)` only), which breaks "only spoken words" on
 *    real cues whose hero is not last. They are a second small line under the hero's floor, popping in as they are
 *    spoken and leaving with the block.
 *  - Real speech has about 60 ms between cues, not the demo's 170: the exit never starts before the last word has
 *    landed and been readable for 150 ms (the line's pop lands 120 ms after its word's start, the hero's spring 160 ms
 *    after its own), and it shortens (40 ms at least, 190 ms at most) rather than cutting a word. It always ends when
 *    the next cue starts, so two cues never share the screen.
 *  - Rows and the hero fit: a word wider than the zone shrinks the line to fit; the hero keeps 1.6 x the line's size
 *    over the line it sits on (the sample's hero fit had no floor, so a 15 letter word came out as small as the line).
 *  - Uppercase and the 0.01 em letter spacing apply to cased scripts only; Arabic, Urdu, Devanagari, CJK and the like are
 *    set as typed, whole words, so shaping and joins survive. Right-to-left rows read from the right.
 *  - The hero leans by a few degrees (alternating side, a hash of the cue for the size) while it springs, so a long clip
 *    does not repeat one entrance. The sample has no such variant; it is the one recurring variation of a text-only look.
 *  - The shadow's 22 px blur is a smaller one (a sigma of at most 7 px): libass pays for blurred bitmap area every frame.
 *
 * The sample has no idle motion, so a long hold stays still.
 */

export const STRETCH_DEMO: DemoScript = {
  lines: [
    "I:m spent:b three:b years:b being:m QUIET:h@560",
    "posting:b nothing:b+60",
    "then:m one:b video:b went:b VIRAL:h@560",
    "so:m here's:m my:m advice:b",
    "just:m START:h@600",
  ],
  options: { rate: 255, cueGap: 170, tail: 700 },
};

const CX = 540;
const CENTER_Y = 1290;
const LINE = 66;
const LINE_SOLO = 84;
const HERO_MAX = 270;
const HERO_FIT = 880;
const ZONE = 920;
const GAP = 22;
const FACE = "Dela Gothic One" as const;
const LINE_LS = 0.01;
const HERO_LS = -0.01;
const COLUMN_GAP_EM = 0.26;
const ROW_GAP_EM = 0.08;
const HERO_LINE_HEIGHT = 0.86;
const HERO_PIVOT = 0.88;
/** The hero stays at least this much bigger than the line above it, so a long word still reads as the hero. */
const HERO_OVER_LINE = 1.6;
/** Dela Gothic One's hhea ascent and descent (em): Chrome rounds each to whole px and centres the line box on them. */
const ASCENT_EM = 1.16;
const DESCENT_EM = 0.288;
const POP_MS = 170;
const POP_RISE = 16;
const POP_FROM = 0.9;
const WORD_LEAD_MS = 50;
const HERO_LEAD_MS = 80;
const EXIT_MS = 190;
const EXIT_MIN_MS = 40;
/** A word is readable this long after it has landed before the exit may squash it. */
const HOLD_MS = 150;
const LINE_LANDS_MS = POP_MS - WORD_LEAD_MS;
const HERO_LANDS_MS = 160;
const MIN_SCALE = 0.02;
const SHADOW_SIGMA_MAX = 7;

/** The hero's spring in the sample's `kf` frames, by time since its word started. */
const SPRING_Y: Frames = [[-HERO_LEAD_MS, 0.1], [160, 1.08, "out"], [290, 0.97, "inOut"], [400, 1, "inOut"]];
const SPRING_X: Frames = [[-HERO_LEAD_MS, 1.12], [160, 0.97, "out"], [290, 1.01, "inOut"], [400, 1, "inOut"]];
const SPRING_END = 400;

/** The sample's hero spring: `sy` squashed flat and `sx` wide at first, then overshoot and settle. */
export function stretchSpring(sinceMs: number): { sy: number; sx: number } {
  return { sy: kf(sinceMs, SPRING_Y), sx: kf(sinceMs, SPRING_X) };
}

/** Cased scripts only: everything else (Arabic, Indic, CJK ...) is set as typed. */
const CASED = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{N}\p{P}\p{S}\p{Z}\p{M}]+$/u;
export function stretchText(text: string, language: string | null | undefined): { text: string; cased: boolean } {
  if (!CASED.test(text)) return { text, cased: false };
  try {
    return { text: text.toLocaleUpperCase(language ?? undefined), cased: true };
  } catch {
    return { text: text.toUpperCase(), cased: true };
  }
}

/** A stable 0..1 from a cue's index and text: the variation of a lean, never `Math.random`. */
export function stretchHash(index: number, text: string): number {
  let h = 2166136261 ^ index;
  for (let at = 0; at < text.length; at++) h = Math.imul(h ^ text.charCodeAt(at), 16777619);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

/** Chrome's baseline in a box of height `lineHeight` set in the face at `size`: ascent and descent round to whole px. */
function baselineOf(size: number, lineHeight: number): number {
  const ascent = Math.round(ASCENT_EM * size);
  const descent = Math.round(DESCENT_EM * size);
  return ascent + (lineHeight - ascent - descent) / 2;
}

interface Placed {
  readonly index: number;
  readonly text: string;
  readonly width: number;
  readonly ls: number;
  /** Left edge, canvas px. */
  left: number;
  /** Top of the row, relative to the line's top, canvas px. */
  top: number;
}

interface Line {
  readonly words: Placed[];
  readonly size: number;
  /** The widest row, canvas px. */
  readonly widest: number;
  readonly height: number;
}

function buildCue(cue: SceneCue, cueNumber: number, heroNumber: number, input: SceneInput): Piece[] {
  const space = sceneSpace(input, CENTER_Y);
  const { u } = space;
  const rtl = cueDirection(cue) === "rtl";
  const heroAt = cue.words.findIndex((word) => word.role === "hero");
  const hero = heroAt >= 0 ? cue.words[heroAt]! : null;
  const lead = cue.words.map((_, at) => at).filter((at) => (hero ? at < heroAt : true));
  const tail = hero ? cue.words.map((_, at) => at).filter((at) => at > heroAt) : [];
  const band = cueNumber * 8;
  const zone = space.px(ZONE);
  const ox = space.x(CX);

  // --- the hero: fitted to 880 px, then held at least 1.6 x the line; the line shrinks first for a very long word ---
  let heroSize = 0;
  let heroBox = 0;
  let heroText = "";
  let lineSize = hero ? LINE : LINE_SOLO;
  if (hero) {
    const shaped = stretchText(hero.text, cue.language);
    heroText = shaped.text;
    const ls = shaped.cased ? HERO_LS : 0;
    const boxAt = (size: number) => input.measure(heroText, FACE, size, ls).advance + ls * size;
    const natural = boxAt(HERO_MAX * u);
    // The spring starts 1.12 x wide: the safe width bounds the widest moment, not the rest size.
    const fit = Math.min(space.px(HERO_FIT), ((space.safe.x2 - space.safe.x1) / SPRING_X[0]![1]) * 0.995);
    heroSize = Math.min(HERO_MAX * u, HERO_MAX * u * fitScale(natural, fit));
    heroBox = boxAt(heroSize);
    lineSize = Math.min(LINE, heroSize / u / HERO_OVER_LINE);
  }

  // --- a line of small words: centred, greedy rows inside the zone, a word wider than the zone shrinks the line ---
  const makeLine = (indices: readonly number[], nominal: number): Line | null => {
    if (indices.length === 0) return null;
    const widthsAt = (size: number) =>
      indices.map((at) => {
        const shaped = stretchText(cue.words[at]!.text, cue.language);
        const ls = shaped.cased ? LINE_LS : 0;
        return { text: shaped.text, ls, width: input.measure(shaped.text, FACE, size, ls).advance + ls * size };
      });
    let size = nominal * u;
    let measured = widthsAt(size);
    const widest = Math.max(...measured.map((m) => m.width));
    if (widest > zone) {
      size *= fitScale(widest, zone) * 0.995;
      measured = widthsAt(size);
    }
    const colGap = COLUMN_GAP_EM * size;
    const rows = greedyRows(measured.map((m) => m.width), colGap, zone);
    const rowGap = ROW_GAP_EM * size;
    const words: Placed[] = [];
    rows.forEach((row, rowAt) => {
      const order = rowVisualOrder(row.map((at) => cue.words[indices[at]!]!.text), rtl ? "rtl" : "ltr").map((at) => row[at]!);
      const total = order.reduce((sum, at) => sum + measured[at]!.width, 0) + colGap * (order.length - 1);
      let x = ox - total / 2;
      for (const at of order) {
        words.push({ index: indices[at]!, text: measured[at]!.text, width: measured[at]!.width, ls: measured[at]!.ls, left: x, top: rowAt * (size + rowGap) });
        x += measured[at]!.width + colGap;
      }
    });
    const rowMax = Math.max(...rows.map((row) => row.reduce((sum, at) => sum + measured[at]!.width, 0) + colGap * (row.length - 1)));
    return { words, size, widest: rowMax, height: Math.round(rows.length * size + (rows.length - 1) * rowGap) };
  };
  const leadLine = makeLine(lead, lineSize);
  const tailLine = makeLine(tail, lineSize);

  // --- the block, centred on the anchor line: the floor is where the hero's baseline box ends ---
  const heroH = hero ? Math.round(HERO_LINE_HEIGHT * heroSize) : 0;
  const leadH = leadLine?.height ?? 0;
  const tailH = tailLine?.height ?? 0;
  const gap = GAP * u;
  const total = leadH + (hero ? (leadH ? gap : 0) + heroH + (tailH ? gap : 0) + tailH : 0);
  const blockTop = space.y(CENTER_Y) - total / 2;
  const floor = hero ? blockTop + leadH + (leadH ? gap : 0) + heroH : blockTop + leadH;

  // --- the exit: after the last word has been readable HOLD_MS, over what is left of the cue (40 to 190 ms), done when the next cue starts ---
  const lastLand = Math.max(
    ...cue.words.map((word, at) => (at === heroAt ? word.startMs + HERO_LANDS_MS : word.startMs + LINE_LANDS_MS)),
  );
  const exitFrom = clamp(lastLand + HOLD_MS, cue.endMs - EXIT_MS, cue.endMs - EXIT_MIN_MS);
  const exitDur = cue.endMs - exitFrom;
  const exitEnd = cue.endMs;
  const out = (t: number) => EASES.in(prog(t, exitFrom, exitDur));

  /** The sample's `0 6k 22k` and `0 2k 4k` text shadows for `k` = size / 70 (line) or / 110 (hero); a blur radius is twice the sigma. */
  const shadowsFor = (k: number) => [
    { dx: 0, dy: 6 * k * u, blur: Math.min(SHADOW_SIGMA_MAX * u, 11 * k * u), colour: input.colours.shadow, alpha: 0.62 },
    { dx: 0, dy: 2 * k * u, blur: 2 * k * u, colour: "#000000", alpha: 0.45 },
  ];

  const pieces: Piece[] = [];
  const heroStart = hero ? hero.startMs : 0;
  const heroOn = heroStart - HERO_LEAD_MS;

  // The hero's own y scale and x scale at t: the spring times the squash of the exit (the sample's `y`, `x`).
  const heroY = (t: number) => (t >= heroOn ? stretchSpring(t - heroStart).sy : 0) * (1 - out(t));
  const heroX = (t: number) => lerp(t >= heroOn ? stretchSpring(t - heroStart).sx : 1.12, 1.1, out(t));
  // Where the line's bottom edge is: it rides on the hero's current height (the sample's `lineBottom`).
  const lineBottom = (t: number) => floor - 0.12 * heroH - HERO_PIVOT * heroH * heroY(t) - (leadH ? gap * clamp(heroY(t)) : 0);

  /** `fn` as frames from `from` to `to`, split at the edges where a window of the cue starts or ends. */
  const sampled = (fn: (t: number) => number, from: number, to: number, edges: readonly number[], tolerance: number): Frames => {
    const inside = [from, to, ...edges.filter((edge) => edge > from && edge < to)];
    return sampleFrames(fn, inside, tolerance, { wholeMs: true, simplify: true });
  };
  const heroEdges = hero ? [heroOn - 1, heroOn, heroStart + 160, heroStart + 290, heroStart + SPRING_END, exitFrom, exitEnd] : [exitFrom, exitEnd];

  // --- the words of a line: a pop (rise 16 px and scale .9 to 1, 170 ms outExpo) inside the line's own transform ---
  const placeLine = (line: Line, kind: "lead" | "tail") => {
    // The line's pivot is its bottom centre (lead) or top centre (tail); a word's offset from it is constant.
    const pivotRel = kind === "lead" ? line.height : 0;
    const baseline = baselineOf(line.size / u, line.size / u) * u;
    const shadows = shadowsFor(line.size / u / 70);
    for (const word of line.words) {
      const spoken = cue.words[word.index]!;
      const centreRel = word.top + line.size / 2;
      const popAt = spoken.startMs - WORD_LEAD_MS;
      const from = popAt;
      const delta = centreRel - pivotRel;
      const rise = (t: number) => (1 - EASES.outExpo(prog(t, popAt, POP_MS))) * POP_RISE * u;
      const pop = (t: number) => lerp(POP_FROM, 1, EASES.outExpo(prog(t, popAt, POP_MS)));
      // The line's own scale: the hero cue squashes the line (to 15 %) and fades it, a cue without a hero squashes it flat.
      const lineSy = (t: number) => (hero ? Math.max(0.001, 1 - out(t) * 0.85) : Math.max(0.001, 1 - out(t)));
      const lineSx = (t: number) => (hero ? 1 : lerp(1, Math.max(1, Math.min(1.18, (space.safe.x2 - space.safe.x1) / line.widest)), out(t)));
      const pivotY = (t: number) => (kind === "lead" ? (hero ? lineBottom(t) : floor) : floor + gap);
      const edges = [...heroEdges, popAt, popAt + POP_MS];
      const moves = kind === "lead" && hero !== null;
      const track: TextPiece["track"] = {
        x: hero ? [[from, word.left + word.width / 2]] : sampled((t) => ox + lineSx(t) * (word.left + word.width / 2 - ox), from, exitEnd, edges, 0.25),
        y: sampled((t) => pivotY(t) + Math.max(MIN_SCALE, lineSy(t)) * (delta + rise(t)), from, exitEnd, moves ? edges : [popAt, popAt + POP_MS, exitFrom, exitEnd], 0.25),
        sx: sampled((t) => lineSx(t) * pop(t), from, exitEnd, [popAt + POP_MS, exitFrom, exitEnd], 0.003),
        sy: sampled((t) => Math.max(MIN_SCALE, lineSy(t)) * pop(t), from, exitEnd, [popAt + POP_MS, exitFrom, exitEnd], 0.003),
        ...(hero ? { o: [[exitFrom, 1], [exitEnd, 0, "in"]] as Frames } : {}),
      };
      pieces.push({
        id: `stretch:${cueNumber}:w${word.index}`,
        kind: "text",
        z: band + 2,
        fromMs: from,
        toMs: exitEnd,
        track,
        origin: { dx: word.width / 2, dy: line.size / 2 - baseline },
        text: word.text,
        face: FACE,
        sizePx: line.size,
        letterSpacingEm: word.ls,
        fill: input.colours.primary,
        shadows,
        anchor: "baseline-left",
        language: cue.language,
      });
    }
  };
  if (leadLine) placeLine(leadLine, "lead");
  if (tailLine) placeLine(tailLine, "tail");

  // --- the hero: one piece pivoting at 88 % of its box, springing from flat and wide ---
  if (hero) {
    const heroTop = floor - heroH;
    const pivotY = heroTop + HERO_PIVOT * heroH;
    const baseline = heroTop + baselineOf(heroSize / u, HERO_LINE_HEIGHT * heroSize / u) * u;
    const shaped = stretchText(hero.text, cue.language);
    const lean = (heroNumber % 2 === 0 ? 1 : -1) * (2.4 + 2.2 * stretchHash(cue.index, hero.text));
    const leanAt = (t: number) => kf(t - heroStart, [[-HERO_LEAD_MS, lean], [160, -0.4 * lean, "out"], [290, 0.15 * lean, "inOut"], [SPRING_END, 0, "inOut"]]) * (1 - out(t));
    const from = heroOn;
    const apart = exitFrom >= heroStart + SPRING_END;
    const scaleY: Frames = apart
      ? [...SPRING_Y.map(([at, value, name]) => [heroStart + at, value, name] as const), [exitFrom, 1], [exitEnd, MIN_SCALE, "in"]]
      : sampled((t) => Math.max(MIN_SCALE, heroY(t)), from, exitEnd, heroEdges, 0.004);
    const scaleX: Frames = apart
      ? [...SPRING_X.map(([at, value, name]) => [heroStart + at, value, name] as const), [exitFrom, 1], [exitEnd, 1.1, "in"]]
      : sampled(heroX, from, exitEnd, heroEdges, 0.002);
    pieces.push({
      id: `stretch:${cueNumber}:hero`,
      kind: "text",
      z: band + 3,
      fromMs: from,
      toMs: exitEnd,
      track: {
        x: [[from, ox]],
        y: [[from, pivotY]],
        sx: scaleX,
        sy: scaleY,
        skx: sampled(leanAt, from, Math.min(exitEnd, heroStart + SPRING_END + 1), heroEdges, 0.05),
      },
      origin: { dx: heroBox / 2, dy: pivotY - baseline },
      text: shaped.text,
      face: FACE,
      sizePx: heroSize,
      letterSpacingEm: shaped.cased ? HERO_LS : 0,
      fill: input.colours.highlight,
      shadows: shadowsFor(heroSize / u / 110),
      anchor: "baseline-left",
      language: cue.language,
    });
  }
  return clampToSafeArea(pieces, space.safe, input.measure);
}

export const stretchProgram: SceneProgram = {
  build(input) {
    let heroes = 0;
    return {
      pieces: input.cues.flatMap((cue, number) => {
        if (cue.words.length === 0) return [];
        const hasHero = cue.words.some((word) => word.role === "hero");
        return buildCue(cue, number, hasHero ? heroes++ : heroes, input);
      }),
    };
  },
};

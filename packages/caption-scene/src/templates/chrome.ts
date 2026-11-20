import type { DemoScript } from "../demo";
import { type Frames, EASES, prog } from "../ease";
import type { SceneCue, SceneInput, SceneProgram } from "../input";
import { clampToSafeArea, cueDirection, fitScale, greedyRows, rowVisualOrder, rowWidth, sceneSpace } from "../layout";
import type { Clip, Piece, ShapePiece, TextPiece } from "../scene";
import { ellipsePath, sparklePath } from "../shapes";
import { sampleFrames } from "../frames";

/**
 * Chrome (`samples/templates/23-chrome.js`): Y2K liquid chrome. The hero is a sheared chrome badge (a
 * hard-banded sky/horizon gradient with a navy rim and a blue glow) that slams in from big and blurred,
 * catches a travelling glint and throws one four-point sparkle off its corner. Support words are small,
 * wide and quiet.
 *
 * Geometry is the sample's, read from its layout in Chrome (`.scratch/motion-captions/tools/probe-sample.ts`):
 * a support row is a wrapping flex row (900 px, 0.3 em gaps) of 1.18 em lines whose baseline sits 50 px
 * (52 px) / 61 px (64 px) below the box top; the hero's box is exactly its cap height (0.75 em) with the
 * baseline on its bottom edge; rows stack with 30 px between a support row and the badge and 4 px under
 * the badge, and the block is centred on y 1290.
 *
 * The chrome fill is a stack of the same word, one text piece per colour band, each cut by a canvas
 * clip to its band of the cap box (CSS paints the gradient only inside the box, so the clip is the box
 * too). The badge lands with one `outExpo` pose (scale 1.7 to 1, blur 16 to 0), so the clips follow
 * that pose: every clip edge is the pivot plus the scale times the edge's rest offset, one `outExpo`
 * segment. The glint is two white copies seen through vertical stripes that stay fixed on the canvas.
 */

export const CHROME_DEMO: DemoScript = {
  lines: [
    "okay:m this:m one's:b different",
    "it's:m giving:b iconic:h@580 energy",
    "only:m 300:b made",
    "gone:h@620",
    "don't:b sleep:h@560 on:m it",
  ],
  options: { rate: 265, lead: 320, cueGap: 170, tail: 700 },
};

const ANCHOR_LINE = 1290;
const HERO_FACE = "Unbounded Black" as const;
const SUPPORT_FACE = "Unbounded Medium" as const;
const LETTER_SPACING = -0.01;
/** The cap height of Unbounded (em), the hero box's height. */
const CAP = 0.75;
const HERO_SIZE = 190;
/** Widest the sheared hero may be, in sample px (86 % of the sample's width). */
const HERO_FIT = 0.86 * 1080;
const SHEAR = -8;
const SUPPORT = 52;
const PLAIN = 64;
/** Baseline of a support line box below its top, sample px (probe: 50 at 52, 61 at 64). */
const SUPPORT_BASELINE: Readonly<Record<number, number>> = { [SUPPORT]: 50, [PLAIN]: 61 };
const SUPPORT_LINE = 1.18;
const SUPPORT_MAX_ROW = 900;
const SUPPORT_GAP = 0.3;
const HERO_GAP = 30;
const HERO_BELOW = 4;
const BAND = 46;
const RISE = 24;

const RIM = "#0A1636";
const SHINE = "#FFFFFF";
/** Hard bands, top to bottom, as percent of the cap box (the sample's own). */
const CHROME: readonly (readonly [number, string])[] = [
  [0, "#FFFFFF"],
  [16, "#F1F6FF"],
  [30, "#DCE8FA"],
  [42, "#BCD3F3"],
  [50, "#F7FBFF"],
  [54, "#0A1530"],
  [64, "#17305F"],
  [74, "#2F5A97"],
  [84, "#7FA8DC"],
  [92, "#E4F0FF"],
];
/** Each glint stripe: width, opacity and how far behind the head it trails (px). */
const GLINTS = [
  { w: BAND, o: 0.85, lag: 0 },
  { w: 10, o: 0.75, lag: BAND + 14 },
] as const;
/** The sample's two text shadows (14 px / 3 px blur) as one: a second layer is a second blurred raster per frame. */
const SHADOWS = [{ dy: 3, blur: 7, alpha: 0.7 }] as const;
/** The glow's blur, em of the hero (the sample's 0.13 costs a raster 1.3x Headline's whole frame; see the budget note). */
const GLOW_BLUR_EM = 0.07;
const GLOW_ALPHA = 1;
/** The hero's landing: scale 1.7 to 1 and blur 16 to 0 over 260 ms. */
const LAND = { from: -80, dur: 260, scale: 1.7, blur: 16 } as const;

const TAN_SHEAR = Math.tan((-SHEAR * Math.PI) / 180);

/** The sample's hero fit: its size at which the sheared word is `HERO_FIT` wide, at most `HERO_SIZE`. */
function heroSizeFor(text: string, input: SceneInput, u: number, maxWidth: number): number {
  const m = input.measure(text, HERO_FACE, 100, LETTER_SPACING);
  const w100 = m.advance + LETTER_SPACING * 100 + TAN_SHEAR * CAP * 100;
  return Math.min(HERO_SIZE * u, (Math.min(HERO_FIT * u, maxWidth) * 100) / w100);
}

interface SupportWord {
  readonly index: number;
  readonly text: string;
  readonly boxWidth: number;
  left: number;
}

interface SupportRows {
  readonly rows: readonly (readonly SupportWord[])[];
  readonly size: number;
  readonly sampleSize: number;
  /** The size before any shrink: which probe baseline applies. */
  readonly nominal: number;
  readonly lineHeight: number;
  /** Height of the whole stack of lines. */
  readonly height: number;
}

function buildCue(cue: SceneCue, input: SceneInput, cueNumber: number): Piece[] {
  const space = sceneSpace(input, ANCHOR_LINE);
  const { u } = space;
  const direction = cueDirection(cue);
  const heroAt = cue.words.findIndex((word) => word.role === "hero");
  const cx = space.x(540);
  const toMs = cue.endMs - 40;
  const colours = input.colours;

  const supportOf = (indices: readonly number[], nominal: number): SupportRows | null => {
    if (indices.length === 0) return null;
    const maxRow = SUPPORT_MAX_ROW * u;
    const texts = indices.map((index) => cue.words[index]!.text.toLowerCase());
    const widths = (sampleSize: number) => texts.map((text) => input.measure(text, SUPPORT_FACE, sampleSize * u, LETTER_SPACING).advance + LETTER_SPACING * sampleSize * u);
    // A word wider than a row shrinks the whole stack (the sample never meets one).
    const sampleSize = nominal * fitScale(Math.max(...widths(nominal)), maxRow);
    const size = sampleSize * u;
    const gap = Math.round(sampleSize * SUPPORT_GAP) * u;
    const boxWidths = widths(sampleSize);
    const words: SupportWord[] = indices.map((index, at) => ({ index, text: texts[at]!, boxWidth: boxWidths[at]!, left: 0 }));
    const lines = greedyRows(words.map((word) => word.boxWidth), gap, maxRow);
    const rows = lines.map((line) => {
      const ordered = rowVisualOrder(line.map((at) => words[at]!.text), direction).map((at) => line[at]!);
      const width = rowWidth(words.map((word) => word.boxWidth), ordered, gap);
      let x = cx - width / 2;
      return ordered.map((at) => {
        const word = words[at]!;
        word.left = x;
        x += word.boxWidth + gap;
        return word;
      });
    });
    const lineHeight = SUPPORT_LINE * size;
    return { rows, size, sampleSize, nominal, lineHeight, height: rows.length * lineHeight };
  };

  const lead = supportOf(heroAt < 0 ? cue.words.map((_, index) => index) : cue.words.slice(0, heroAt).map((_, index) => index), heroAt < 0 ? PLAIN : SUPPORT);
  const tail = heroAt < 0 ? null : supportOf(cue.words.slice(heroAt + 1).map((_, index) => heroAt + 1 + index), SUPPORT);

  const heroText = heroAt < 0 ? "" : cue.words[heroAt]!.text.toUpperCase();
  const heroSize = heroAt < 0 ? 0 : heroSizeFor(heroText, input, u, 0.9 * space.canvas.width);
  const capH = CAP * heroSize;
  // The badge's box is the cap box; a script whose ink reaches well past it (Arabic, Devanagari, a comma's tail)
  // gets the ink box instead, so the chrome covers all of it.
  const ink = heroAt < 0 ? null : input.measure(heroText, HERO_FACE, heroSize, LETTER_SPACING);
  const reach = 0.06 * capH;
  const boxUp = ink && -ink.inkTop > capH + reach ? -ink.inkTop : capH;
  const boxDown = ink && ink.inkBottom > reach ? ink.inkBottom : 0;
  const boxH = boxUp + boxDown;
  const heroWidth = heroAt < 0 ? 0 : input.measure(heroText, HERO_FACE, heroSize, LETTER_SPACING).advance + LETTER_SPACING * heroSize;

  // Stack the block like the sample's flex column and centre it on the anchor line.
  let cursor = 0;
  const leadTop = cursor;
  if (lead) cursor += lead.height;
  let heroTop = 0;
  if (heroAt >= 0) {
    if (lead) cursor += HERO_GAP * u;
    heroTop = cursor;
    cursor += boxH + HERO_BELOW * u;
  }
  const tailTop = tail ? cursor + HERO_GAP * u : 0;
  if (tail) cursor += HERO_GAP * u + tail.height;
  const blockTop = space.y(ANCHOR_LINE) - cursor / 2;

  const pieces: Piece[] = [];

  /** A support word: it rises 24 px and fades in over 220 ms; a plain cue's last word gets the glint too. */
  const addSupport = (rows: SupportRows, top: number, z: number, glintLast: boolean) => {
    const baseline = (SUPPORT_BASELINE[rows.nominal] ?? 0.9615 * rows.nominal) * (rows.sampleSize / rows.nominal);
    rows.rows.forEach((row, rowAt) => {
      const rowTop = blockTop + top + rowAt * rows.lineHeight;
      for (const word of row) {
        const spoken = cue.words[word.index]!;
        const from = spoken.startMs - 70;
        const y = rowTop + baseline * u;
        const last = glintLast && word.index === cue.words.length - 1;
        const opacity = (t: number) => Math.min(1, EASES.out(prog(t, from, 220)) * 1.6);
        pieces.push({
          id: `chrome:${cueNumber}:w${word.index}`,
          kind: "text",
          z,
          fromMs: from,
          toMs,
          track: {
            x: [[from, word.left]],
            y: [[from, y + RISE * u], [from + 220, y, "out"]],
            o: sampleFrames(opacity, [from, from + 220], 0.02),
          },
          text: word.text,
          face: SUPPORT_FACE,
          sizePx: rows.size,
          letterSpacingEm: LETTER_SPACING,
          fill: last ? colours.highlight : colours.primary,
          shadows: SHADOWS.map((shadow) => ({ dx: 0, dy: shadow.dy * u, blur: shadow.blur * u, colour: colours.shadow, alpha: shadow.alpha })),
          anchor: "baseline-left",
          language: cue.language,
        });
        if (last) {
          const start = spoken.startMs + 150;
          const end = Math.min(start + 560, toMs);
          if (end > start) GLINTS.forEach((glint, at) => {
            pieces.push({
              id: `chrome:${cueNumber}:glint${at}`,
              kind: "text",
              z: z + 1,
              fromMs: start,
              toMs: end,
              track: { x: [[from, word.left]], y: [[from, y]], o: [[from, glint.o]] },
              clip: sweepClip(start, 560, word.left, word.boxWidth, 4 * u, glint, rowTop - 0.4 * rows.lineHeight, rowTop + 1.4 * rows.lineHeight, u),
              text: word.text,
              face: SUPPORT_FACE,
              sizePx: rows.size,
              letterSpacingEm: LETTER_SPACING,
              fill: SHINE,
              anchor: "baseline-left",
              language: cue.language,
            });
          });
        }
      }
    });
  };

  if (heroAt < 0) {
    if (lead) addSupport(lead, leadTop, 4, true);
    return clampToSafeArea(pieces, space.safe, input.measure);
  }

  if (lead) addSupport(lead, leadTop, 1, false);

  const hero = cue.words[heroAt]!;
  const start = hero.startMs;
  const landFrom = start + LAND.from;
  const landTo = landFrom + LAND.dur;
  const heroLeft = cx - heroWidth / 2;
  const badgeTop = blockTop + heroTop;
  const pivotY = badgeTop + boxH / 2;
  const lean = TAN_SHEAR * boxH * 0.5;
  // Chrome snaps the box's baseline to whole sample px (probe: 142 for a 142.5 px cap box).
  const baselineY = badgeTop + (boxUp === capH ? Math.floor(capH / u) * u : boxUp);
  const origin = { dx: heroWidth / 2, dy: boxH / 2 - (baselineY - badgeTop) };
  const landEnd = Math.min(landTo, toMs);
  const scaleFrames: Frames = [[landFrom, LAND.scale], [landTo, 1, "outExpo"]];
  const landPose = { x: [[landFrom, cx]] as Frames, y: [[landFrom, pivotY]] as Frames, sx: scaleFrames, sy: scaleFrames, skx: [[landFrom, SHEAR]] as Frames };
  const restPose = { x: [[landEnd, cx]] as Frames, y: [[landEnd, pivotY]] as Frames, skx: [[landEnd, SHEAR]] as Frames };
  const heroText0 = {
    kind: "text" as const,
    origin,
    text: heroText,
    face: HERO_FACE,
    sizePx: heroSize,
    letterSpacingEm: LETTER_SPACING,
    fill: SHINE,
    anchor: "baseline-left" as const,
    language: cue.language,
  };
  const fade = (to: number): Frames => [[landFrom, 0], [start + 10, to]];
  const landBlur: Frames = [[landFrom, LAND.blur], [landTo, 0, "outExpo"]];
  const glowSigma = heroSize * GLOW_BLUR_EM;
  // The glow's own blur and the badge's landing blur add in quadrature, as nested CSS filters do.
  const glowBlur = sampleFrames((t) => Math.hypot(glowSigma, LAND.blur * (1 - EASES.outExpo(prog(t, landFrom, LAND.dur)))), [landFrom, landTo], 0.2);

  /**
   * One layer of the badge as two pieces: the landing (scale 1.7 to 1, blurred, `bleed` since it runs far past
   * the safe area for 260 ms) and the rest, which is what the safe-area shift and the selection box follow.
   */
  const badgeLayer = (id: string, z: number, look: Partial<TextPiece>, landing: { o: Frames; blur: Frames; clip?: Clip }, rest: { o?: Frames; blur?: Frames; clip?: Clip }) => {
    pieces.push({ ...heroText0, ...look, id: `chrome:${cueNumber}:${id}`, z, fromMs: landFrom, toMs: landEnd, bleed: true, track: { ...landPose, o: landing.o, blur: landing.blur }, ...(landing.clip ? { clip: landing.clip } : {}) });
    if (landEnd < toMs) pieces.push({ ...heroText0, ...look, id: `chrome:${cueNumber}:${id}r`, z, fromMs: landEnd, toMs, track: { ...restPose, ...(rest.o ? { o: rest.o } : {}), ...(rest.blur ? { blur: rest.blur } : {}) }, ...(rest.clip ? { clip: rest.clip } : {}) });
  };
  badgeLayer("glow", 2, { fill: colours.accent }, { o: fade(GLOW_ALPHA), blur: glowBlur }, { o: [[landEnd, GLOW_ALPHA]], blur: [[landEnd, glowSigma]] });

  // The chrome: one clipped copy per band, each wearing the navy rim (the sample's separate rim layer costs a
  // full-size raster per frame in libass; clipped to its band it costs a slice). The first band's clip reaches up
  // and the last band's down so the rim is complete above and below the glyphs. Every clip edge rides the
  // landing's scale about the pivot.
  const rim = heroSize * 0.025;
  const extentX = heroWidth / 2 + lean + 8 * u + rim;
  const edgeReach = rim + 0.03 * heroSize;
  CHROME.forEach(([at, colour], index) => {
    const next = index + 1 < CHROME.length ? CHROME[index + 1]![0] : 100;
    const top = badgeTop + (boxH * at) / 100 - pivotY - (index === 0 ? edgeReach : 0);
    const bottom = badgeTop + (boxH * next) / 100 - pivotY + (next === 100 ? edgeReach : 0);
    const edge = (rest: number, centre: number): Frames => [[landFrom, centre + LAND.scale * rest], [landTo, centre + rest, "outExpo"]];
    const fixed = (rest: number, centre: number): Frames => [[landEnd, centre + rest]];
    badgeLayer(
      `band${index}`,
      4,
      { fill: colour, stroke: { widthPx: rim, colour: RIM } },
      { o: fade(1), blur: landBlur, clip: { x1: edge(-extentX, cx), x2: edge(extentX, cx), y1: edge(top, pivotY), y2: edge(bottom, pivotY) } },
      { clip: { x1: fixed(-extentX, cx), x2: fixed(extentX, cx), y1: fixed(top, pivotY), y2: fixed(bottom, pivotY) } },
    );
  });

  // The glint: two white stripes sweeping left to right over the landed badge (its last 70 ms of landing are
  // within 0.5 % of rest, so the stripes use the rest pose throughout).
  const sweepStart = start + 110;
  const sweepEnd = Math.min(sweepStart + 440, toMs);
  if (sweepEnd > sweepStart) {
    GLINTS.forEach((glint, at) => {
      pieces.push({
        ...heroText0,
        id: `chrome:${cueNumber}:glint${at}`,
        z: 5,
        fromMs: sweepStart,
        toMs: sweepEnd,
        track: { x: [[sweepStart, cx]], y: [[sweepStart, pivotY]], skx: [[sweepStart, SHEAR]], o: [[sweepStart, glint.o]] },
        clip: sweepClip(sweepStart, 440, heroLeft, heroWidth, lean + 6 * u, glint, badgeTop - 0.4 * boxH, badgeTop + 1.4 * boxH, u),
      });
    });
  }

  // The sparkle: a four-point star at the top-right corner, scale 0 to 1 to 0 with a 90 degree turn.
  const sparkleStart = start + 330;
  const sparkleDur = 520;
  const sparkleEnd = Math.min(sparkleStart + sparkleDur - 8, toMs);
  const sparkleSize = Math.max(70 * u, capH * 0.62);
  const starX = heroLeft + heroWidth + lean - sparkleSize * 0.2;
  const starY = badgeTop - sparkleSize * 0.28;
  const popAt = sparkleStart + sparkleDur * 0.42;
  const k: Frames = [[sparkleStart, 0], [popAt, 1, "outBack"], [sparkleStart + sparkleDur, 0, "in"]];
  const sparkleTrack = { x: [[sparkleStart, starX]] as Frames, y: [[sparkleStart, starY]] as Frames, sx: k, sy: k, rz: [[sparkleStart, 0], [sparkleStart + sparkleDur, 90]] as Frames };
  const sparkle = (id: string, path: ShapePiece["path"], o: Frames | undefined): ShapePiece => ({
    id: `chrome:${cueNumber}:${id}`,
    kind: "shape",
    z: 6,
    // A decoration that hangs off the badge's corner for half a second: it neither shifts the cue nor sizes its selection box.
    bleed: true,
    fromMs: sparkleStart + 8,
    toMs: sparkleEnd,
    track: { ...sparkleTrack, ...(o ? { o } : {}) },
    path,
    fill: { colour: SHINE },
  });
  if (sparkleEnd > sparkleStart + 8) {
    pieces.push(sparkle("star", sparklePath(sparkleSize / 2), undefined));
    pieces.push(sparkle("spark", ellipsePath(0, 0, 0.16 * (sparkleSize / 2)), [[sparkleStart, 0], [popAt, 0.9, "outBack"], [sparkleStart + sparkleDur, 0, "in"]]));
  }

  if (tail) addSupport(tail, tailTop, 7, false);
  return clampToSafeArea(pieces, space.safe, input.measure);
}

/**
 * The stripe of one glint as a clip: `head` runs from `-overhang - BAND` to the far edge plus the trail
 * and 12 px over `dur` ms, `inOut`; a stripe is the head minus its lag, `w` wide. x runs from the box's
 * left (canvas x), y is the box padded by 40 % each way.
 */
function sweepClip(start: number, dur: number, left: number, width: number, overhang: number, glint: (typeof GLINTS)[number], top: number, bottom: number, u: number): Clip {
  const lagMax = GLINTS[GLINTS.length - 1]!.lag * u;
  const head0 = -overhang - BAND * u;
  const head1 = head0 + (width + 2 * overhang + BAND * u + lagMax + 12 * u);
  const x1: Frames = [[start, left + head0 - glint.lag * u], [start + dur, left + head1 - glint.lag * u, "inOut"]];
  const x2: Frames = [[start, left + head0 - glint.lag * u + glint.w * u], [start + dur, left + head1 - glint.lag * u + glint.w * u, "inOut"]];
  return { x1, x2, y1: [[start, top]], y2: [[start, bottom]] };
}

export const chromeProgram: SceneProgram = {
  build(input) {
    return { pieces: input.cues.flatMap((cue, number) => buildCue(cue, input, number)) };
  },
};

/** Used by the tests: the sample's hero scale and blur at `t` for a hero spoken at `startMs`. */
export function chromeLanding(t: number, startMs: number): { scale: number; blur: number; opacity: number } {
  const land = EASES.outExpo(prog(t, startMs + LAND.from, LAND.dur));
  return { scale: LAND.scale - (LAND.scale - 1) * land, blur: LAND.blur * (1 - land), opacity: prog(t, startMs + LAND.from, 90) };
}

/** Used by the tests: the sample's support-word rise (px) and opacity at `t` for a word spoken at `startMs`. */
export function chromeSupport(t: number, startMs: number): { rise: number; opacity: number } {
  const p = EASES.out(prog(t, startMs - 70, 220));
  return { rise: (1 - p) * RISE, opacity: Math.min(1, p * 1.6) };
}

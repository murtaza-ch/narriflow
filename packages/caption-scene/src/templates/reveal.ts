import type { DemoScript } from "../demo";
import { type Frames, prog, EASES } from "../ease";
import type { SceneInput, SceneProgram, SceneCue } from "../input";
import { balancedRows, clampToSafeArea, cueDirection, fitScale, rowsFromRoles, rowVisualOrder, rowWidth, sceneSpace } from "../layout";
import type { Piece, TextPiece } from "../scene";
import { sampleFrames } from "../frames";

/**
 * Reveal (`samples/templates/10-reveal.js`): every word rises out of an invisible slit and the cue leaves
 * the same way it came. The hero is a big italic serif. The sample's hairline under the lead row is left
 * out (owner's call): the rows stack without it.
 *
 * Geometry is the sample's, read from its layout in Chrome (`.scratch/motion-captions/tools/probe-sample.ts`):
 * a word's slit is its box padded 0.12 em at the sides, 0.1 em above and 0.2 em (hero 0.32 em)
 * below; a row is 1.3 em tall (hero 1.42 em) with a 0.24 em gap between words; the hero row sits 18 px
 * up and takes 56 px less below. The block is centred on
 * the anchor line (y 1300). Baselines sit 0.862 em (Inter Tight) and 0.839 em (Instrument Serif)
 * below the top of a `line-height: 1` box.
 */

export const REVEAL_DEMO: DemoScript = {
  lines: ["most:m people:b think:b", "it's:m all:m about:m talent:h@520", "it's:m really:b about:m", "showing:b up:b every:m day:h@560"],
};

const ANCHOR_LINE = 1300;
const BODY = 72;
const HERO = 236;
const PLAIN = 96;
const EXIT = 190;
const SHADOWS = [
  { dx: 0, dy: 4, blur: 9, alpha: 0.55 },
  { dx: 0, dy: 1, blur: 1.5, alpha: 0.5 },
] as const;
const BODY_FACE = "Inter Tight SemiBold" as const;
const HERO_FACE = "Instrument Serif" as const;
const BASELINE = { body: 0.862, hero: 0.839 } as const;
const LETTER_SPACING = { body: -0.015, hero: -0.02 } as const;
const HERO_MARGIN = { top: -18, bottom: -56 } as const;
const SLIT = { side: 0.12, above: 0.1, below: 0.2, belowHero: 0.32 } as const;
const GAP_EM = 0.24;
/** Widest a row may be before it wraps, share of the canvas width (the safe area). */
const MAX_ROW_SHARE = 0.9;

interface RowWord {
  /** Index in the cue's words. */
  readonly index: number;
  readonly boxWidth: number;
  /** Advance without the trailing letter spacing, px. */
  readonly advance: number;
}

function buildCue(cue: SceneCue, input: SceneInput, cueNumber: number): Piece[] {
  const space = sceneSpace(input, ANCHOR_LINE);
  const { u } = space;
  const direction = cueDirection(cue);
  const { lead, hero, tail } = rowsFromRoles(cue.words.map((word) => word.role));
  const hasHero = hero.length > 0;
  const bodySize = (hasHero ? BODY : PLAIN) * u;
  const heroSize = HERO * u;
  const maxRow = MAX_ROW_SHARE * space.canvas.width;

  const measureWord = (index: number, face: typeof BODY_FACE | typeof HERO_FACE, size: number, ls: number): RowWord => {
    const m = input.measure(cue.words[index]!.text, face, size, ls);
    // CSS puts the letter spacing after every character, the last included: that is the box the sample lays out.
    return { index, advance: m.advance, boxWidth: m.advance + ls * size };
  };

  // A row of words laid out as the sample's flex row: gap 0.24 em, centred on the anchor's x.
  interface Row {
    readonly size: number;
    readonly hero: boolean;
    readonly items: readonly (RowWord & { readonly left: number })[];
    readonly height: number;
    readonly marginTop: number;
    readonly marginBottom: number;
    top: number;
  }
  const makeRows = (indices: readonly number[], isHero: boolean, nominal: number): Row[] => {
    if (indices.length === 0) return [];
    const face = isHero ? HERO_FACE : BODY_FACE;
    const ls = isHero ? LETTER_SPACING.hero : LETTER_SPACING.body;
    let size = nominal;
    let words = indices.map((index) => measureWord(index, face, size, ls));
    const gapOf = (s: number) => GAP_EM * s;
    // A row that cannot wrap (the hero) shrinks to fit; body rows wrap evenly, and shrink only for a word wider than a row.
    // The slit reaches 0.12 em past each side of a word, so that is part of the width to fit.
    const natural = (isHero ? rowWidth(words.map((word) => word.boxWidth), indices.map((_, at) => at), gapOf(size)) : Math.max(...words.map((word) => word.boxWidth))) + 2 * SLIT.side * size;
    const scale = fitScale(natural, maxRow);
    if (scale < 1) {
      size = nominal * scale;
      words = indices.map((index) => measureWord(index, face, size, ls));
    }
    const gap = gapOf(size);
    const lines = isHero ? [words.map((_, at) => at)] : balancedRows(words.map((word) => word.boxWidth), gap, maxRow);
    return lines.map((line) => {
      const ordered = rowVisualOrder(line.map((at) => cue.words[words[at]!.index]!.text), direction).map((at) => line[at]!);
      const width = rowWidth(words.map((word) => word.boxWidth), ordered, gap);
      let x = space.x(540) - width / 2;
      const items = ordered.map((at) => {
        const item = { ...words[at]!, left: x };
        x += words[at]!.boxWidth + gap;
        return item;
      });
      return {
        size,
        hero: isHero,
        items,
        height: size * (1 + SLIT.above + (isHero ? SLIT.belowHero : SLIT.below)),
        marginTop: isHero ? HERO_MARGIN.top * u : 0,
        marginBottom: isHero ? HERO_MARGIN.bottom * u : 0,
        top: 0,
      };
    });
  };

  const leadRows = makeRows(hasHero ? lead : lead, false, bodySize);
  const heroRows = makeRows(hero, true, heroSize);
  const tailRows = makeRows(tail, false, bodySize);
  const ordered: Row[] = [...leadRows, ...heroRows, ...tailRows];

  // Stack the rows like the sample's flex column.
  let cursor = 0;
  for (const row of ordered) {
    cursor += row.marginTop;
    row.top = cursor;
    cursor += row.height + row.marginBottom;
  }
  const blockTop = space.y(ANCHOR_LINE) - cursor / 2;

  const fromMs = cue.startMs - 80;
  const toMs = cue.endMs;
  const exitFrom = cue.endMs - EXIT;
  const pieces: Piece[] = [];

  for (const row of ordered) {
    const rowTop = blockTop + row.top;
    const heroRow = row.hero;
    for (const item of row.items) {
      const word = cue.words[item.index]!;
      const inkTop = rowTop + row.size * SLIT.above;
      const baselineY = inkTop + row.size * (heroRow ? BASELINE.hero : BASELINE.body);
      const centreX = item.left + item.boxWidth / 2;
      const centreY = inkTop + row.size / 2;
      const enterFrom = word.startMs - 70;
      const enterDur = heroRow ? 620 : 480;
      const enterEnd = enterFrom + enterDur;
      // translateY in percent of the ink's own height: 150 % below the slit, then 150 % above it on the way out.
      const rise = (t: number) => ((1 - EASES.outExpo(prog(t, enterFrom, enterDur))) * 150 - EASES.in(prog(t, exitFrom, EXIT)) * 150) / 100;
      const y: Frames = enterEnd <= exitFrom
        ? [[fromMs, centreY + row.size * 1.5], [enterFrom, centreY + row.size * 1.5], [enterEnd, centreY, "outExpo"], [exitFrom, centreY], [toMs, centreY - row.size * 1.5, "in"]]
        : sampleFrames((t) => centreY + rise(t) * row.size, [fromMs, enterFrom, enterEnd, exitFrom, toMs], 0.05);
      const track: TextPiece["track"] = { x: [[fromMs, centreX]], y };
      if (heroRow) {
        track.rz = enterEnd <= toMs
          ? [[fromMs, 5], [enterFrom, 5], [enterEnd, 0, "outExpo"]]
          : sampleFrames((t) => (1 - EASES.outExpo(prog(t, enterFrom, enterDur))) * 5, [fromMs, enterFrom, enterEnd, toMs], 0.05);
      }
      const clip = {
        x1: [[fromMs, item.left - row.size * SLIT.side]] as Frames,
        x2: [[fromMs, item.left + item.boxWidth + row.size * SLIT.side]] as Frames,
        y1: [[fromMs, rowTop]] as Frames,
        y2: [[fromMs, rowTop + row.height]] as Frames,
      };
      pieces.push({
        id: `reveal:${cueNumber}:w${item.index}`,
        kind: "text",
        z: 2,
        fromMs,
        toMs,
        track,
        clip,
        origin: { dx: item.boxWidth / 2, dy: row.size / 2 - (baselineY - inkTop) },
        text: word.text,
        face: heroRow ? HERO_FACE : BODY_FACE,
        sizePx: row.size,
        letterSpacingEm: heroRow ? LETTER_SPACING.hero : LETTER_SPACING.body,
        fill: heroRow ? input.colours.highlight : input.colours.primary,
        shadows: SHADOWS.map((shadow) => ({ dx: shadow.dx * u, dy: shadow.dy * u, blur: shadow.blur * u, colour: input.colours.shadow, alpha: shadow.alpha })),
        anchor: "baseline-left",
        language: cue.language,
      });
    }
  }

  return clampToSafeArea(pieces, space.safe, input.measure);
}

export const revealProgram: SceneProgram = {
  build(input) {
    return { pieces: input.cues.flatMap((cue, number) => buildCue(cue, input, number)) };
  },
};

/** Used by the tests: the sample's y offset (percent of ink height) of a word at `t`. */
export function revealRisePercent(t: number, wordStartMs: number, hero: boolean, cueEndMs: number): number {
  const enter = EASES.outExpo(prog(t, wordStartMs - 70, hero ? 620 : 480));
  const out = EASES.in(prog(t, cueEndMs - EXIT, EXIT));
  return (1 - enter) * 150 - out * 150;
}

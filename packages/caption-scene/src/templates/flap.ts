import type { DemoScript } from "../demo";
import { type Frames, EASES, clamp, prog } from "../ease";
import type { SceneCue, SceneInput, SceneProgram } from "../input";
import { clampToSafeArea, cueDirection, fitScale, greedyRows, rowVisualOrder, rowWidth, sceneSpace } from "../layout";
import { type Piece, SCENE_PERSPECTIVE_PX, type ShapePiece, type TextPiece, mixColour } from "../scene";
import { polygonPath, roundedRectPath } from "../shapes";
import { sampleFrames } from "../frames";

/**
 * Flap (`samples/templates/32-flap.js`): a split-flap departure board. A cue's cards stand blank and
 * each flaps to its word on the spoken beat: the top half changes at once, the bottom flap swings
 * down about the split line. The hero is an amber card that clatters twice. At the end of the cue
 * the cards flip back to blank one after another.
 *
 * Geometry is the sample's, read from its layout in Chrome: a card is its word plus 0.46 em wide
 * (rounded to px) and 1.62 cap heights tall, radius 10, centred caps on a 2 px black split line, in
 * centred rows with a 10 px gap, the block centred on y 1290. The bottom flap is a copy of the
 * bottom half and of the word clipped to it, turning about the split line (`flapPose`).
 *
 * Real speech leaves no gap between cues (the sample has 330 ms), so a board never leaves before its last
 * word has landed and been readable for `READ` ms: the next board waits, a card with no room to flip back
 * holds its word until the board cuts, and a word whose board is late starts its flap as the board appears
 * (a hero's blank clatter only when it still fits).
 */

export const FLAP_DEMO: DemoScript = {
  lines: [
    "i:m booked:b a:m flight:b to:m",
    "tokyo:h@680+160",
    "for:m only:b $340:h@700 return:b",
    "set:b a:m price:b alert:h@620 and:m wait",
  ],
  options: { cueGap: 330, tail: 700, lead: 420 },
};

const FACE = "Oswald" as const;
const ANCHOR_LINE = 1290;
const BODY = 92;
const HERO = 156;
const GAP = 10;
const RADIUS = 10;
const LETTER_SPACING = 0.02;
/** Card width is the word's width plus this many em. */
const PAD_EM = 0.46;
/** Card height is this many cap heights. */
const HEIGHT_CAPS = 1.62;
const MAX_ROW = 920;
const FLAP = 220;
const BLANK_FLAP = 130;
const EARLY = 70;
const EXIT_FLAP = 80;
const EXIT_WINDOW = 180;
/** A card shows its landed word at least this long before it flips back to blank. */
const READ = 150;
const BOARD_IN = 110;
const BOARD_FROM = 0.96;
const SHADOW = { alpha: 0.6, sigma: 5 } as const;
const SPLIT = "#000000";
/** `perspective()` of the sample's flap. */
const SAMPLE_PERSPECTIVE_PX = 1100;
const DARK_INK = "#17130A";
/** How far toward white a face is lightened for its top half and for a falling flap (the sample's `#1B1D22` and `#3A3E46` over `#16181C`, `#FFB712` and `#FFD36A` over `#FFB000`). */
const TONE = { body: { top: 0.023, flash: 0.165 }, hero: { top: 0.08, flash: 0.43 } } as const;
const HIGHLIGHT_ALPHA = { body: 0.13, hero: 0.38 } as const;
/** The bottom half darkens by up to this much while a flap falls over it. */
const SHADE = 0.35;
const SHADE_STEPS = 10;

/**
 * The flap's pose at `t`: the sample turns it `rotateX(90 * (1 - out(p)))` under `perspective(1100px)`;
 * the renderers' camera is 326 px away, so the turn is a scale `sy` and an angle `rx` (degrees) chosen
 * so that every point lands where the sample's does: `sy cos(rx) = cos(a)` keeps the projected height
 * and `sy sin(rx) = (326 / 1100) sin(a)` the same foreshortening of its far edge (a trapezoid wider
 * at the bottom, as in the sample), for the sample's angle `a`.
 */
function flapPose(t: number, from: number, dur: number): { sy: number; rx: number } {
  const a = (Math.PI / 2) * (1 - EASES.out(prog(t, from, dur)));
  const depth = (SCENE_PERSPECTIVE_PX / SAMPLE_PERSPECTIVE_PX) * Math.sin(a);
  return { sy: Math.hypot(Math.cos(a), depth), rx: (Math.atan2(depth, Math.cos(a)) * 180) / Math.PI };
}

/** A flap swing: a window of `dur` ms from `from`, cut short at `until` when the board's exit takes over. */
interface Swing {
  readonly from: number;
  readonly dur: number;
  readonly until: number;
  /** What falls: the hero's blank clatter, the word, or the blank flap of the exit. */
  readonly kind: "blank" | "word" | "exit";
}

interface Card {
  readonly index: number;
  readonly hero: boolean;
  readonly text: string;
  readonly size: number;
  readonly boxWidth: number;
  readonly width: number;
  readonly height: number;
  readonly cap: number;
  left: number;
  top: number;
}

const luminance = (hex: string) => (0.299 * Number.parseInt(hex.slice(1, 3), 16) + 0.587 * Number.parseInt(hex.slice(3, 5), 16) + 0.114 * Number.parseInt(hex.slice(5, 7), 16)) / 255;

function buildCue(cue: SceneCue, cueNumber: number, boardIn: number, visEnd: number, input: SceneInput): Piece[] {
  const space = sceneSpace(input, ANCHOR_LINE);
  const { u } = space;
  const direction = cueDirection(cue);
  const maxRow = MAX_ROW * u;
  const face = { body: input.colours.accent, hero: input.colours.highlight };
  const ink = { body: input.colours.primary, hero: luminance(input.colours.highlight) > 0.4 ? DARK_INK : input.colours.primary };

  // The sample's rows: the words before the first hero, the hero alone, the rest (a later hero keeps its size).
  const indices = cue.words.map((_, at) => at);
  const first = cue.words.findIndex((word) => word.role === "hero");
  const groups = first < 0 ? [indices] : [indices.slice(0, first), [first], indices.slice(first + 1)];
  const measureCard = (at: number, hero: boolean, nominal: number, shrink: number): Card => {
    const size = nominal * shrink;
    const text = cue.words[at]!.text.toUpperCase();
    const ls = LETTER_SPACING;
    const boxWidth = input.measure(text, FACE, size, ls).advance + ls * size;
    const cap = -input.measure("H", FACE, size, 0).inkTop;
    return { index: at, hero, text, size, boxWidth, width: Math.round(boxWidth + PAD_EM * size), height: Math.round(cap * HEIGHT_CAPS), cap, left: 0, top: 0 };
  };

  interface Row {
    readonly cards: Card[];
    readonly height: number;
    top: number;
  }
  const rows: Row[] = [];
  for (const group of groups) {
    if (group.length === 0) continue;
    const natural = group.map((at) => measureCard(at, cue.words[at]!.role === "hero", cue.words[at]!.role === "hero" ? HERO * u : BODY * u, 1));
    // A flex row wraps greedily; a card wider than the row shrinks the whole group to fit.
    const shrink = fitScale(Math.max(...natural.map((card) => card.width)), maxRow);
    const cards = shrink < 1 ? group.map((at) => measureCard(at, cue.words[at]!.role === "hero", cue.words[at]!.role === "hero" ? HERO * u : BODY * u, shrink)) : natural;
    const gap = GAP * u;
    for (const line of greedyRows(cards.map((card) => card.width), gap, maxRow)) {
      const ordered = rowVisualOrder(line.map((at) => cards[at]!.text), direction).map((at) => cards[line[at]!]!);
      rows.push({ cards: ordered, height: Math.max(...ordered.map((card) => card.height)), top: 0 });
    }
  }
  const gap = GAP * u;
  const total = rows.reduce((sum, row) => sum + row.height, 0) + gap * (rows.length - 1);
  let cursor = space.y(ANCHOR_LINE) - total / 2;
  for (const row of rows) {
    row.top = cursor;
    cursor += row.height + gap;
    let x = space.x(540) - rowWidth(row.cards.map((card) => card.width), row.cards.map((_, at) => at), gap) / 2;
    for (const card of row.cards) {
      card.left = x;
      card.top = row.top + (row.height - card.height) / 2;
      x += card.width + gap;
    }
  }

  // --- the board: it settles in over BOARD_IN, scaling 0.96 -> 1 about its centre while it fades in ---
  const centre = { x: space.x(540), y: space.y(ANCHOR_LINE) };
  const settleEnd = boardIn + BOARD_IN;
  const boardScale = (t: number) => BOARD_FROM + (1 - BOARD_FROM) * EASES.outExpo(prog(t, boardIn, BOARD_IN));
  const boardOpacity = (t: number) => clamp(EASES.outExpo(prog(t, boardIn, BOARD_IN)) * 1.6);
  /** A canvas coordinate that scales about the board's centre: eased natively when the piece starts with the board. */
  const settle = (rest: number, about: number, from: number): Frames => {
    if (from >= settleEnd) return [[from, rest]];
    if (from <= boardIn) return [[from, rest + (BOARD_FROM - 1) * (rest - about)], [settleEnd, rest, "outExpo"]];
    return sampleFrames((t) => rest + (boardScale(t) - 1) * (rest - about), [from, settleEnd], 0.05);
  };
  const board = (from: number, x: number, y: number): Pick<TextPiece["track"], "x" | "y" | "sx" | "sy" | "o"> => {
    const track: Pick<TextPiece["track"], "x" | "y" | "sx" | "sy" | "o"> = { x: settle(x, centre.x, from), y: settle(y, centre.y, from) };
    if (from < settleEnd) {
      const scale = sampleFrames(boardScale, [from, settleEnd], 0.002);
      track.sx = scale;
      track.sy = scale;
      track.o = sampleFrames(boardOpacity, [from, settleEnd], 0.02);
    }
    return track;
  };
  /** A canvas-fixed rectangle that scales with the board. */
  const clipOf = (from: number, x1: number, y1: number, x2: number, y2: number) => ({
    x1: settle(x1, centre.x, from),
    y1: settle(y1, centre.y, from),
    x2: settle(x2, centre.x, from),
    y2: settle(y2, centre.y, from),
  });

  const pieces: Piece[] = [];
  const stagger = Math.min(25, (EXIT_WINDOW - EXIT_FLAP - 20) / Math.max(1, cue.words.length - 1));
  // The board stays up until its last word has landed and been read (`build`). Its cards flip back to blank after that,
  // or, when the next board leaves no room for the last card's flip, all hold their words until the board cuts.
  const flipsBack = Math.max(...cue.words.map((word) => flapClock(word, boardIn))) + FLAP + READ <= visEnd - EXIT_FLAP;

  for (const row of rows) {
    for (const card of row.cards) {
      const word = cue.words[card.index]!;
      const kind = card.hero ? "hero" : "body";
      const cardFace = face[kind];
      const topFace = mixColour(cardFace, "#FFFFFF", TONE[kind].top);
      const flash = mixColour(cardFace, "#FFFFFF", TONE[kind].flash);
      const half = card.height / 2;
      const cx = card.left + card.width / 2;
      const splitY = card.top + half;
      const radius = RADIUS * u;
      const id = (part: string) => `flap:${cueNumber}:c${card.index}:${part}`;

      // The sample's clock for this card, or the board's entry when the board is late (`flapClock`).
      const s = flapClock(word, boardIn);
      // The sample's exit slot, once the word has been read.
      const exitAt = flipsBack ? Math.min(Math.max(visEnd - EXIT_WINDOW + card.index * stagger, s + FLAP + READ), visEnd - EXIT_FLAP) : visEnd;
      const swings: Swing[] = [];
      if (card.hero && s - BLANK_FLAP - 20 >= boardIn) swings.push({ from: s - BLANK_FLAP - 20, dur: BLANK_FLAP, until: s - 20, kind: "blank" });
      swings.push({ from: s, dur: FLAP, until: s + FLAP, kind: "word" });
      if (flipsBack) swings.push({ from: exitAt, dur: EXIT_FLAP, until: exitAt + EXIT_FLAP, kind: "exit" });
      const topWindow = { from: s, to: exitAt };
      const bottomWindow = { from: s + FLAP, to: flipsBack ? exitAt + EXIT_FLAP : visEnd };

      const textLeft = card.left + (card.width - card.boxWidth) / 2;
      const baselineY = splitY + card.cap / 2;
      const clipTop = { x1: card.left, y1: card.top, x2: card.left + card.width, y2: splitY };
      const clipBottom = { x1: card.left, y1: splitY, x2: card.left + card.width, y2: card.top + card.height };
      const textPiece = (part: string, window: { from: number; to: number }, rect: typeof clipTop): TextPiece => ({
        id: id(part),
        kind: "text",
        z: 3,
        fromMs: window.from,
        toMs: window.to,
        track: board(window.from, textLeft, baselineY),
        clip: clipOf(window.from, rect.x1, rect.y1, rect.x2, rect.y2),
        text: card.text,
        face: FACE,
        sizePx: card.size,
        letterSpacingEm: LETTER_SPACING,
        fill: ink[kind],
        anchor: "baseline-left",
        language: cue.language,
      });
      const shape = (part: string, z: number, path: ShapePiece["path"], fill: ShapePiece["fill"], from: number, to: number): ShapePiece => ({
        id: id(part),
        kind: "shape",
        z,
        fromMs: from,
        toMs: to,
        track: board(from, cx, splitY),
        path,
        fill,
      });

      // The card: a full face in the top half's tone with the box shadow, the bottom half over it, the 2 px highlight and the split line.
      // The box shadow, as a blurred strip under the card: libass blends every bitmap whole, so a card-sized
      // blur (the sample's `0 10px 22px`) costs 3x Headline per frame; the strip is the part that shows.
      const strip = shape("shadow", 0, roundedRectPath(-card.width / 2 + 2 * u, half - 6 * u, card.width - 4 * u, 14 * u, 4 * u), { colour: input.colours.shadow, alpha: SHADOW.alpha }, boardIn, visEnd);
      pieces.push({ ...strip, track: { ...strip.track, blur: [[boardIn, SHADOW.sigma * u]] } });
      pieces.push(shape("card", 1, roundedRectPath(-card.width / 2, -half, card.width, card.height, radius), { colour: topFace }, boardIn, visEnd));

      // The bottom half darkens while a flap falls over it (`0.35 * sin(pi * min(1, 1.1 p))`).
      const shade: [number, string][] = [[boardIn, cardFace]];
      for (const swing of swings) {
        const full = swing.dur / 1.1;
        for (let step = 0; step <= SHADE_STEPS; step++) {
          const at = swing.from + (full * step) / SHADE_STEPS;
          if (at > swing.until) break;
          shade.push([at, mixColour(cardFace, "#000000", SHADE * Math.sin((Math.PI * step) / SHADE_STEPS))]);
        }
        if (swing.until < swing.from + full) {
          const p = (swing.until - swing.from) / swing.dur;
          shade.push([swing.until - 1, mixColour(cardFace, "#000000", SHADE * Math.sin(Math.PI * clamp(1.1 * p)))]);
        }
      }
      const colour: [number, string][] = [];
      for (const frame of shade) {
        const previous = colour[colour.length - 1];
        if (!previous || frame[0] > previous[0]) colour.push(frame);
        else if (frame[1] !== previous[1]) colour.push([previous[0] + 1, frame[1]]);
      }
      const bottom = shape("lower", 2, roundedRectPath(-card.width / 2, 0, card.width, half, [0, 0, radius, radius]), { colour: cardFace }, boardIn, visEnd);
      pieces.push({ ...bottom, track: { ...bottom.track, colour } });

      const highlight = card.hero ? HIGHLIGHT_ALPHA.hero : HIGHLIGHT_ALPHA.body;
      const inset = radius * 0.6;
      pieces.push(
        shape(
          "light",
          3,
          polygonPath([[-card.width / 2 + radius, -half], [card.width / 2 - radius, -half], [card.width / 2 - inset, -half + 1.2 * u], [card.width / 2 - inset, -half + 2 * u], [-card.width / 2 + inset, -half + 2 * u], [-card.width / 2 + inset, -half + 1.2 * u]]),
          { colour: "#FFFFFF", alpha: highlight },
          boardIn,
          visEnd,
        ),
      );

      pieces.push(textPiece("top", topWindow, clipTop), textPiece("bottom", bottomWindow, clipBottom));

      // The flaps: the bottom half (and the word's lower half on it) swinging down about the split line.
      for (const swing of swings) {
        if (swing.until <= swing.from) continue;
        const edges = [swing.from, swing.until, ...(swing.from < settleEnd && settleEnd < swing.until ? [settleEnd] : [])];
        const sy = sampleFrames((t) => flapPose(t, swing.from, swing.dur).sy * (swing.from < settleEnd ? boardScale(t) : 1), edges, 0.004);
        const rx = sampleFrames((t) => flapPose(t, swing.from, swing.dur).rx, edges, 0.25);
        const flapShape = shape(`flap-${swing.kind}`, 4, roundedRectPath(-card.width / 2, 0, card.width, half, [0, 0, radius, radius]), { colour: flash }, swing.from, swing.until);
        pieces.push({
          ...flapShape,
          track: { ...flapShape.track, sy, rx, colour: [[swing.from, flash], [swing.from + 0.8 * swing.dur, cardFace, "out"]] },
        });
        if (swing.kind === "word") {
          const flapText = textPiece("flap-text", { from: swing.from, to: swing.until }, clipBottom);
          pieces.push({
            ...flapText,
            z: 5,
            track: { ...flapText.track, ...board(swing.from, cx, splitY), sy, rx },
            origin: { dx: cx - textLeft, dy: splitY - baselineY },
          });
        }
      }

      // The split line with its two hinge notches, one outline.
      const w = card.width / 2;
      const notch = 4 * u;
      pieces.push(
        shape(
          "split",
          6,
          polygonPath([[-w, -5 * u], [-w + notch, -5 * u], [-w + notch, -u], [w - notch, -u], [w - notch, -5 * u], [w, -5 * u], [w, 5 * u], [w - notch, 5 * u], [w - notch, u], [-w + notch, u], [-w + notch, 5 * u], [-w, 5 * u]]),
          { colour: SPLIT },
          boardIn,
          visEnd,
        ),
      );
    }
  }
  return clampToSafeArea(pieces, space.safe, input.measure);
}

/** When a word's flap starts: `EARLY` before it is spoken, or as its board appears if the board is later than that. */
const flapClock = (word: SceneCue["words"][number], boardIn: number) => Math.max(word.startMs - EARLY, boardIn);

export const flapProgram: SceneProgram = {
  build(input) {
    // Each board enters just before its first flap and leaves as the next one enters, or at its cue's end (the last word
    // plus the scene cue tail) when the next cue is a long pause away: a board is not held through silence. It never
    // leaves before its last word has landed and been read; the next board enters after it.
    const planned = input.cues.map((cue) => {
      const first = cue.words[0];
      return first ? first.startMs - EARLY - (first.role === "hero" ? BLANK_FLAP + 20 : 0) - BOARD_IN : Number.POSITIVE_INFINITY;
    });
    const pieces: Piece[] = [];
    let previousEnd = Number.NEGATIVE_INFINITY;
    input.cues.forEach((cue, number) => {
      if (cue.words.length === 0) return;
      const boardIn = Math.max(planned[number]!, previousEnd);
      const landed = Math.max(...cue.words.map((word) => flapClock(word, boardIn))) + FLAP;
      const visEnd = Math.max(Math.min(planned[number + 1] ?? Number.POSITIVE_INFINITY, cue.endMs), landed + READ);
      pieces.push(...buildCue(cue, number, boardIn, visEnd, input));
      previousEnd = visEnd;
    });
    return { pieces };
  },
};

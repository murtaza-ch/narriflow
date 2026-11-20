import type { DemoScript } from "../demo";
import { LYRICS_BREAK_MS, pauseAfterMs } from "../detect";
import { EASES, type Frames, clamp, lerp, prog } from "../ease";
import type { SceneCue, SceneInput, SceneProgram } from "../input";
import { clampToSafeArea, cueDirection, fitScale, greedyRows, rowVisualOrder, rowWidth, sceneSpace, shiftPiece } from "../layout";
import type { Piece, ShapePiece, TextPiece } from "../scene";
import { ellipsePath } from "../shapes";
import { sampleFrames } from "../frames";

/**
 * Lyrics (`samples/templates/20-lyrics.js`): the lyric view of a music app. The cue before and the cue
 * after stay on screen, soft, dim and blurred; the current cue's words fill as they are spoken (a
 * bright wipe with a feathered edge, the hero in the highlight colour with a glow); a pause longer
 * than 700 ms shows three breathing dots in the current slot.
 *
 * Geometry is the sample's, read from its layout in Chrome (`.scratch/motion-captions/tools/probe-sample.ts`):
 * a cue is a flex row wrap at x 96, 880 wide, words 0.24 em apart (22 px), lines 1.1 em tall; the current cue's
 * top edge never moves (y 1226); neighbours are the same text scaled 0.8 from the left edge, 34 px away.
 *
 * Model. The sample moves whole cues (`translate` + `scale` about the cue's top-left corner) and gives
 * every word four stacked layers (the dim base, a hero glow, a half-bright feather and the fill). Here each
 * layer is a piece whose pivot is its own baseline-left anchor: the cue's pose (y, scale, opacity, blur)
 * is sampled into that piece's tracks, composed with the word's own 4 px lift and the wipe's clip.
 *
 * Burn-in economies that change no pixel anyone can see: a shadowed piece is clipped to its ink plus the reach past which its
 * shadows are under one 8-bit step; a move that is within 0.3 % of its end lands on it (so the rest is a plain `\\pos`, not a
 * drift the burn-in carries for seconds); a piece is not drawn while it is under 3 % visible.
 *
 * Deviations from the sample (both only where it misbehaves): a cue change that starts before the previous
 * move finished continues from where the stack is (the sample jumps to the previous layout); a right-to-left
 * cue is flush right and scales from its right edge.
 */

export const LYRICS_DEMO: DemoScript = {
  lines: [
    "so:m I:m quit:b my:m job:b",
    "with:m literally:b zero:h@460 savings",
    "everyone:b said:b I:m was:m crazy:h@520",
    "honestly?@520+1080",
    "best:h@440 decision:b I've:m ever:b made",
  ],
  options: { rate: 240, lead: 300, tail: 520 },
};

/** The sample's y of the current cue's top edge: the reading position never moves. */
const CUR_TOP = 1226;
const LEFT = 96;
const WIDTH = 880;
const SIZE = 92;
const LINE = 1.1;
const GAP = 34;
const DIM_SCALE = 0.8;
const DIM_O = 0.3;
const DIM_BLUR = 3;
const UNSPOKEN = 0.38;
const MOVE = 450;
const LEAD = 120;
const FEATHER = 20;
const FACE = "Inter Tight Bold" as const;
const LETTER_SPACING = -0.022;
const COLUMN_GAP_EM = 0.24;
const LIFT = 4;
const DOT = 34;
const DOT_GAP = DOT * 0.85;
const DOT_PAD = 6;
/** Where the dots scale from (the middle dot's left edge), px from the cue's left edge. */
const DOT_ORIGIN_X = DOT_PAD + DOT * 1.85;
const SHADOWS = [
  { dx: 0, dy: 2, blur: 9, alpha: 0.55 },
  { dx: 0, dy: 1, blur: 1.5, alpha: 0.45 },
] as const;
const GLOWS = [
  { dx: 0, dy: 0, blur: 13, alpha: 0.95 },
  { dx: 0, dy: 0, blur: 30, alpha: 0.55 },
] as const;
/**
 * A move that has come within `SETTLE` of its end lands on it. outExpo is asymptotic: left alone, the last half pixel
 * of a move is a drift the burn-in carries as a running `\\move` and `\\t` for as long as the line then rests (a second or
 * more), and libass redraws an event whose tags change on every frame instead of reusing its bitmap.
 */
const SETTLE = 0.003;
const settled = (p: number): number => (p >= 1 - SETTLE - 1e-9 ? 1 : p);
/** The same for the cubic-out of the word lift and the glow ramp, a progress of 0.8 and over. */
const settledOut = (x: number): number => (x >= 0.8 ? 1 : EASES.out(x));
const TOLERANCE = { px: 0.3, scale: 0.002, alpha: 0.01, blur: 0.1 } as const;
const Z = { base: 1, glow: 2, feather: 3, fill: 4, dots: 5 } as const;

/** `sampleFrames` over `[from, to]` with collinear frames dropped: a constant is one frame. */
const sampled = (fn: (t: number) => number, edges: readonly number[], from: number, to: number, tolerance: number): Frames => sampleFrames(fn, edges, tolerance, { range: [from, to], simplify: true });

/** Distance in sigmas past which a unit Gaussian's tail is under `p` (Abramowitz and Stegun 26.2.23). */
function tailSigmas(p: number): number {
  if (p >= 0.5) return 0;
  const t = Math.sqrt(-2 * Math.log(p));
  return t - (2.515517 + 0.802853 * t + 0.010328 * t * t) / (1 + 1.432788 * t + 0.189269 * t * t + 0.001308 * t ** 3);
}

/** A shadow whose strength drops under 1/255 of a full channel is not seen: its tail is clipped. */
const INVISIBLE = 1 / 255;

/**
 * How far a list of shadows reaches past the glyphs, in canvas px, while the piece is drawn at `alpha`: the distance at which a
 * shadow's Gaussian tail (its strength times the piece's) is under one 8-bit step, plus its offset. A burned-in blur costs as
 * much as the area it covers, and a dimmed line's soft shadows are faint a short way out.
 */
function reach(list: readonly { dx: number; dy: number; blur: number; alpha: number }[] | undefined, alpha: number): number {
  if (!list) return 0;
  return Math.max(0, ...list.map((shadow) => tailSigmas(INVISIBLE / Math.max(INVISIBLE, shadow.alpha * alpha)) * shadow.blur + Math.abs(shadow.dx) + Math.abs(shadow.dy)));
}

/**
 * The part of `[from, to]` in which `alpha` reaches `VISIBLE`: a piece fading in from nothing or out to nothing
 * costs events for the length of the move while nothing can be seen. Null when it never shows.
 */
const VISIBLE = 0.03;
function visibleSpan(alpha: (t: number) => number, from: number, to: number): [number, number] | null {
  let first = Number.NaN;
  let last = Number.NaN;
  for (let t = from; t <= to; t += 8) {
    if (alpha(t) >= VISIBLE) {
      if (Number.isNaN(first)) first = t;
      last = t;
    }
  }
  if (Number.isNaN(first)) return null;
  // One step of margin each side, never outside the window.
  const a = Math.max(from, first - 8);
  const b = Math.min(to, last + 8);
  return b - a >= 1 ? [a, b] : null;
}

interface Pose {
  readonly y: number;
  readonly s: number;
  readonly o: number;
  readonly blur: number;
  readonly act: number;
}
const mix = (a: Pose, b: Pose, p: number): Pose => ({ y: lerp(a.y, b.y, p), s: lerp(a.s, b.s, p), o: lerp(a.o, b.o, p), blur: lerp(a.blur, b.blur, p), act: lerp(a.act, b.act, p) });

interface Row {
  /** Word indices, in the order the viewer reads them from the left edge. */
  readonly words: readonly number[];
  readonly width: number;
}

interface CueItem {
  readonly kind: "cue";
  readonly cue: SceneCue;
  readonly order: number;
  /** Canvas px of the cue's own size. */
  readonly size: number;
  readonly rows: readonly Row[];
  /** The cue's height at its own scale, canvas px (the sample's `offsetHeight`, whole sample px). */
  readonly h: number;
  /** Left edge of each word at rest, canvas px, and its box width (advance plus the trailing letter spacing). */
  readonly left: readonly number[];
  readonly box: readonly number[];
  /** Baseline of each word below the cue's top, at the cue's own scale. */
  readonly baseline: readonly number[];
  readonly rtl: boolean;
}

interface DotsItem {
  readonly kind: "dots";
  readonly after: number;
  readonly from: number;
  readonly to: number;
  readonly h: number;
}

type Item = CueItem | DotsItem;

interface State {
  readonly at: number;
  readonly prev: CueItem | null;
  readonly cur: Item;
  readonly next: CueItem | null;
}

export const lyricsProgram: SceneProgram = {
  build(input) {
    return { pieces: buildLyrics(input) };
  },
};

function buildLyrics(input: SceneInput): Piece[] {
  const { cues } = input;
  if (cues.length === 0) return [];
  const space = sceneSpace(input, CUR_TOP);
  const { u } = space;
  const curTop = space.y(CUR_TOP);
  const gap = GAP * u;
  const maxWidth = WIDTH * u;
  const left = space.x(LEFT);
  const right = left + maxWidth;
  const duration = cues[cues.length - 1]!.endMs + 250;

  // ---- cue blocks: flex wrap, as the sample lays them out
  const cueItems = cues.map((cue, index): CueItem => {
    const direction = cueDirection(cue);
    const rtl = direction === "rtl";
    const natural = SIZE * u;
    const widest = Math.max(...cue.words.map((word) => input.measure(word.text, FACE, natural, LETTER_SPACING).advance));
    // A word wider than a row shrinks the whole cue; the sample never meets one.
    const size = natural * fitScale(widest, maxWidth);
    const columnGap = COLUMN_GAP_EM * size;
    const box = cue.words.map((word) => {
      const m = input.measure(word.text, FACE, size, LETTER_SPACING);
      // CSS adds the letter spacing after every character, the last included: that is the box the sample lays out.
      return m.advance + LETTER_SPACING * size;
    });
    const rows = greedyRows(box, columnGap, maxWidth).map((line): Row => {
      const visual = rowVisualOrder(line.map((at) => cue.words[at]!.text), direction).map((at) => line[at]!);
      return { words: visual, width: rowWidth(box, visual, columnGap) };
    });
    const metrics = input.measure("Hx", FACE, size, LETTER_SPACING);
    const lineHeight = LINE * size;
    const firstBaseline = (lineHeight - (metrics.ascent + metrics.descent)) / 2 + metrics.ascent;
    const wordLeft = new Array<number>(cue.words.length).fill(0);
    const baseline = new Array<number>(cue.words.length).fill(0);
    rows.forEach((row, rowIndex) => {
      let x = rtl ? right - row.width : left;
      for (const at of row.words) {
        wordLeft[at] = x;
        baseline[at] = rowIndex * lineHeight + firstBaseline;
        x += box[at]! + columnGap;
      }
    });
    return { kind: "cue", cue, order: index, size, rows, h: (Math.round((rows.length * LINE * size) / u) || 1) * u, left: wordLeft, box, baseline, rtl };
  });

  // ---- the breath dots of every long pause
  const dotsItems: DotsItem[] = [];
  const states: State[] = [];
  cueItems.forEach((item, index) => {
    const last = item.cue.words[item.cue.words.length - 1]!;
    states.push({ at: index === 0 ? Number.NEGATIVE_INFINITY : item.cue.startMs - LEAD, prev: cueItems[index - 1] ?? null, cur: item, next: cueItems[index + 1] ?? null });
    const nextCue = cueItems[index + 1];
    if (nextCue && pauseAfterMs(cues, index) > LYRICS_BREAK_MS) {
      const dots: DotsItem = { kind: "dots", after: index, from: last.endMs + 160, to: nextCue.cue.startMs - LEAD, h: Math.round(SIZE * LINE) * u };
      dotsItems.push(dots);
      states.push({ at: dots.from, prev: item, cur: dots, next: nextCue });
    }
  });
  // The sample assumes the states are in time order; a cue that starts before the previous state is read as one tick after it.
  for (let at = 1; at < states.length; at++) {
    const state = states[at]!;
    const before = states[at - 1]!.at;
    if (state.at <= before) states[at] = { ...state, at: before + 1 };
  }

  // ---- layout of every item in every state (the sample's `layout`)
  const layout = (state: State): Map<Item, Pose> => {
    const map = new Map<Item, Pose>();
    const { cur } = state;
    map.set(cur, { y: curTop, s: 1, o: 1, blur: 0, act: 1 });
    const prevY = state.prev ? curTop - gap - state.prev.h * DIM_SCALE : curTop - gap;
    const nextY = curTop + cur.h + gap;
    if (state.prev) map.set(state.prev, { y: prevY, s: DIM_SCALE, o: DIM_O, blur: DIM_BLUR * u, act: 0 });
    if (state.next) map.set(state.next, { y: nextY, s: DIM_SCALE, o: DIM_O, blur: DIM_BLUR * u, act: 0 });
    const nextBottom = state.next ? nextY + state.next.h * DIM_SCALE : nextY;
    const curOrder = cur.kind === "cue" ? cur.order : state.next!.order - 0.5;
    for (const item of cueItems) {
      if (map.has(item)) continue;
      if (item.order < curOrder) map.set(item, { y: prevY - gap - item.h * DIM_SCALE - 30 * u, s: DIM_SCALE * 0.94, o: 0, blur: 9 * u, act: 0 });
      else map.set(item, { y: nextBottom + gap + 30 * u, s: DIM_SCALE * 0.94, o: 0, blur: 9 * u, act: 0 });
    }
    for (const dots of dotsItems) if (!map.has(dots)) map.set(dots, { y: curTop, s: 0, o: 0, blur: 0, act: 0 });
    return map;
  };
  const layouts = states.map(layout);

  // The pose of an item at `t`: it travels from where it was when the state began to the state's layout.
  const poseStart = new Map<Item, Pose[]>();
  const poseIn = (item: Item, k: number, t: number): Pose => {
    const starts = poseStart.get(item)!;
    return mix(starts[k]!, layouts[k]!.get(item)!, settled(EASES.outExpo(prog(t, states[k]!.at, MOVE))));
  };
  for (const item of [...cueItems, ...dotsItems]) {
    const starts: Pose[] = [layouts[0]!.get(item)!];
    poseStart.set(item, starts);
    for (let k = 1; k < states.length; k++) starts.push(poseIn(item, k - 1, states[k]!.at));
  }
  // The last state that has begun by `t` (states are in time order): a binary search, because every sampled
  // track asks, and a scan makes a 3-minute clip's build quadratic in its cues.
  const stateAt = (t: number) => {
    let low = 0;
    let high = states.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (t >= states[middle]!.at) low = middle;
      else high = middle - 1;
    }
    return low;
  };
  const pose = (item: Item, t: number): Pose => {
    const k = stateAt(t);
    return k === 0 ? layouts[0]!.get(item)! : poseIn(item, k, t);
  };
  const settleAt = (-Math.log2(SETTLE) / 10) * MOVE;
  const moveEdges = states.slice(1).flatMap((state) => [state.at, state.at + settleAt, state.at + MOVE]);
  const rootO = (t: number) => Math.min(prog(t, 0, 280), 1 - prog(t, duration - 320, 320));
  const rootEdges = [0, 280, duration - 320, duration];

  /** The window in which an item is part of the stack: from the first state that shows it until its last move finishes. */
  const window = (item: Item): [number, number] => {
    const shows = (state: State) => state.cur === item || state.prev === item || state.next === item;
    const first = states.findIndex(shows);
    let lastShown = -1;
    states.forEach((state, k) => {
      if (shows(state)) lastShown = k;
    });
    const gone = states[lastShown + 1];
    // One ms after the move starts: the piece is at its far pose with no opacity before that, and the safe-area shift samples from its first ms.
    return [first === 0 ? 0 : Math.max(0, states[first]!.at + 1), gone ? gone.at + MOVE : duration];
  };

  const pieces: Piece[] = [];
  const groups: Piece[][] = [];

  for (const item of cueItems) {
    const { cue, size, rtl } = item;
    const [from, to] = window(item);
    const origin = rtl ? right : left;
    const shadows = (list: readonly { dx: number; dy: number; blur: number; alpha: number }[], colour: string) =>
      list.map((shadow) => ({ dx: shadow.dx * u, dy: shadow.dy * u, blur: shadow.blur * u, colour, alpha: shadow.alpha }));
    const shadowed = shadows(SHADOWS, input.colours.shadow);
    const group: Piece[] = [];
    const sOf = (t: number) => pose(item, t).s;
    const baseAlpha = (t: number) => lerp(1, UNSPOKEN, pose(item, t).act);
    /** One text run: a word, with every track the cue's pose gives it. */
    const make = (spec: {
      readonly id: string;
      readonly layer: keyof typeof Z;
      readonly text: string;
      readonly restLeft: number;
      readonly baseline: number;
      readonly lift: (t: number) => number;
      readonly from: number;
      readonly to: number;
      readonly fill: string;
      readonly opacity: (t: number) => number;
      readonly shadows?: TextPiece["shadows"];
      /** The wipe: the fill's edge in px from the left of the run, as a function of time. */
      readonly wipe?: (t: number) => number;
      readonly edges: readonly number[];
    }): TextPiece | null => {
      const alpha = (t: number) => rootO(t) * pose(item, t).o * spec.opacity(t);
      const span = visibleSpan(alpha, spec.from, spec.to);
      if (!span) return null;
      const [a, b] = span;
      const edges = [...moveEdges, ...rootEdges, ...spec.edges];
      const track = (fn: (t: number) => number, tolerance: number) => sampled(fn, edges, a, b, tolerance);
      const xAt = (t: number) => origin + sOf(t) * (spec.restLeft - origin);
      const yAt = (t: number) => pose(item, t).y + sOf(t) * (spec.baseline + spec.lift(t));
      const m = input.measure(spec.text, FACE, size, LETTER_SPACING);
      const w = m.advance + LETTER_SPACING * size;
      const piece: TextPiece = {
        id: spec.id,
        kind: "text",
        z: Z[spec.layer],
        fromMs: a,
        toMs: b,
        track: {
          x: track(xAt, TOLERANCE.px),
          y: track(yAt, TOLERANCE.px),
          sx: track(sOf, TOLERANCE.scale),
          sy: track(sOf, TOLERANCE.scale),
          blur: track((t) => pose(item, t).blur * sOf(t), TOLERANCE.blur),
          o: track(alpha, TOLERANCE.alpha),
        },
        text: spec.text,
        face: FACE,
        sizePx: size,
        letterSpacingEm: LETTER_SPACING,
        fill: spec.fill,
        ...(spec.shadows ? { shadows: spec.shadows } : {}),
        anchor: "baseline-left",
        language: cue.language,
      };
      // A blurred layer is as costly to burn in as the area it covers: clip each shadowed piece to its ink plus the reach
      // beyond which its shadows are under one 8-bit step. Nothing visible changes.
      const shadowed = spec.shadows !== undefined;
      const padAt = (t: number) => reach(spec.shadows, alpha(t));
      if (!spec.wipe && !shadowed) return piece;
      const wipe = spec.wipe;
      const wide = (value: number): Frames => [[a, value]];
      // The wipe's edge in canvas px: the run's edge at `wipe(t)` px from its left, carried by the cue's move.
      // A right-to-left run fills from its right edge (where it starts); a left-to-right one from its left.
      const edge = wipe ? track((t) => origin + sOf(t) * ((rtl ? spec.restLeft + w - Math.min(w, wipe(t)) : spec.restLeft + Math.min(w, wipe(t))) - origin), TOLERANCE.px) : null;
      // The sample clips a layer to its box (-10 % to the left, 30 % above and below): wide enough never to cut a glyph.
      return {
        ...piece,
        clip: {
          x1: rtl && edge ? edge : shadowed ? track((t) => xAt(t) - padAt(t), TOLERANCE.px) : wide(0),
          x2: !rtl && edge ? edge : shadowed ? track((t) => xAt(t) + sOf(t) * w + padAt(t), TOLERANCE.px) : wide(space.canvas.width),
          y1: shadowed ? track((t) => yAt(t) + sOf(t) * m.inkTop - padAt(t), TOLERANCE.px) : wide(0),
          y2: shadowed ? track((t) => yAt(t) + sOf(t) * m.inkBottom + padAt(t), TOLERANCE.px) : wide(space.canvas.height),
        },
      };
    };
    const push = (piece: TextPiece | null) => {
      if (piece) group.push(piece);
    };

    cue.words.forEach((word, at) => {
      const hero = word.role === "hero";
      const fillColour = hero ? input.colours.highlight : input.colours.primary;
      const startMs = word.startMs;
      const dur = Math.max(1, word.endMs - word.startMs);
      const lift = (t: number) => -LIFT * u * settledOut(prog(t, startMs, 260));
      const w = item.box[at]!;
      const common = { restLeft: item.left[at]!, baseline: item.baseline[at]!, lift, text: word.text, edges: [startMs, startMs + 0.8 * 260, startMs + 260, word.endMs, word.endMs - 120, word.endMs - 120 + 0.8 * 420, word.endMs + 300] };
      // Before it is spoken a word is its dim base (white, shadowed); once its fill is complete the base is gone.
      push(make({ ...common, id: `lyrics:${cue.index}:w${at}:base`, layer: "base", from, to: Math.min(to, word.endMs), fill: input.colours.primary, opacity: baseAlpha, shadows: shadowed }));
      // The fill's edge is `-FEATHER` px at the word's start and the word's width at its end; it is invisible until it is past 0.
      const edge = (t: number) => lerp(-FEATHER, w, clamp((t - startMs) / dur));
      push(make({ ...common, id: `lyrics:${cue.index}:w${at}:feather`, layer: "feather", from: Math.max(from, startMs), to: Math.min(to, word.endMs), fill: fillColour, opacity: () => 0.5, wipe: (t) => edge(t) + FEATHER }));
      const fillFrom = Math.max(from, startMs + (dur * FEATHER) / (w + FEATHER));
      push(make({ ...common, id: `lyrics:${cue.index}:w${at}:fill`, layer: "fill", from: fillFrom, to, fill: fillColour, opacity: () => 1, ...(hero ? {} : { shadows: shadowed }), wipe: edge }));
      if (hero) {
        const glowAlpha = (t: number) => 0.85 * settledOut(prog(t, word.endMs - 120, 420));
        push(
          make({ ...common, id: `lyrics:${cue.index}:w${at}:glow`, layer: "glow", from: Math.max(from, word.endMs - 120), to, fill: input.colours.highlight, opacity: glowAlpha, shadows: shadows(GLOWS, input.colours.highlight) }),
        );
      }
    });
    groups.push(group);
  }

  // The stack is one object: a cue that must move into the safe area moves the whole scene by the same amount
  // (it never splits the previous, current and next line). A scene that fits the way the sample does is not moved.
  const shifts = groups.map((group) => {
    const moved = clampToSafeArea(group, space.safe, input.measure);
    return group.length > 0 ? moved[0]!.track.y![0]![1] - group[0]!.track.y![0]![1] : 0;
  });
  const up = Math.min(0, ...shifts);
  const down = Math.max(0, ...shifts);
  const dy = -up >= down ? up : down;
  for (const group of groups) pieces.push(...(dy === 0 ? group : group.map((piece) => shiftPiece(piece, 0, dy))));

  for (const dots of dotsItems) {
    const drawn = dotPieces(dots, input, { states, pose, rootO, moveEdges, rootEdges, window, left, right, rtl: cueItems[dots.after + 1]?.rtl ?? false, u, duration });
    pieces.push(...(dy === 0 ? drawn : drawn.map((piece) => shiftPiece(piece, 0, dy))));
  }
  return pieces;
}

interface DotContext {
  readonly states: readonly State[];
  readonly pose: (item: Item, t: number) => Pose;
  readonly rootO: (t: number) => number;
  readonly moveEdges: readonly number[];
  readonly rootEdges: readonly number[];
  readonly window: (item: Item) => [number, number];
  readonly left: number;
  readonly right: number;
  readonly rtl: boolean;
  readonly u: number;
  readonly duration: number;
}

/** The three dots of a long pause: they swell one after another for the length of the pause. */
function dotPieces(dots: DotsItem, input: SceneInput, context: DotContext): ShapePiece[] {
  const { u, pose, rootO } = context;
  const [from, to] = context.window(dots);
  const span = dots.to - dots.from - 260;
  const step = span / 3;
  const swell = (t: number) => {
    const p = prog(t, dots.to - 280, 240);
    return 1 + 0.14 * EASES.out(p);
  };
  const stackX = context.rtl ? context.right : context.left;
  const direction = context.rtl ? -1 : 1;
  const originX = DOT_ORIGIN_X * u;
  const originY = dots.h / 2;
  const out: ShapePiece[] = [];
  for (let index = 0; index < 3; index++) {
    const a = dots.from + 160 + index * step;
    const centre = (DOT_PAD + index * (DOT + DOT_GAP) + DOT / 2) * u;
    const fill = (t: number) => EASES.inOut(prog(t, a, step));
    const pop = (t: number) => lyricsDotPop(t, a, step);
    const edges = [...context.moveEdges, ...context.rootEdges, dots.to - 280, dots.to - 40, a, a + step * 0.55, a + step];
    const track = (fn: (t: number) => number, tolerance: number) => sampled(fn, edges, from, to, tolerance);
    const bigS = (t: number) => pose(dots, t).s * swell(t);
    out.push({
      id: `lyrics:${dots.after}:dot${index}`,
      kind: "shape",
      z: Z.dots,
      fromMs: from,
      toMs: to,
      track: {
        x: track((t) => stackX + direction * (originX + bigS(t) * (centre - originX)), TOLERANCE.px),
        y: track((t) => pose(dots, t).y + originY, TOLERANCE.px),
        sx: track((t) => bigS(t) * pop(t), TOLERANCE.scale),
        sy: track((t) => bigS(t) * pop(t), TOLERANCE.scale),
        o: track((t) => rootO(t) * clamp(pose(dots, t).o) * lerp(0.4, 1, fill(t)), TOLERANCE.alpha),
      },
      path: ellipsePath(0, 0, (DOT / 2) * u),
      fill: { colour: input.colours.primary },
      shadows: [{ dx: 0, dy: 2 * u, blur: 6 * u, colour: input.colours.shadow, alpha: 0.5 }],
    });
  }
  return out;
}

/** Used by the tests: the sample's pop scale of a dot that starts filling at `a` over `step` ms. */
export function lyricsDotPop(t: number, a: number, step: number): number {
  if (t <= a) return 0.82;
  if (t <= a + step * 0.55) return lerp(0.82, 1.16, EASES.out((t - a) / (step * 0.55)));
  return lerp(1.16, 1, EASES.inOut(clamp((t - a - step * 0.55) / (step * 0.45))));
}

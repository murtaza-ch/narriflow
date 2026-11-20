import type { DemoScript } from "../demo";
import { type Frames, EASES, clamp, prog } from "../ease";
import type { SceneCue, SceneInput, SceneProgram } from "../input";
import { balancedRows, clampToSafeArea, cueDirection, fitScale, rowVisualOrder, rowWidth, sceneSpace } from "../layout";
import type { PathCmd, Piece, ShapePiece } from "../scene";
import { ellipsePath, roundedRectPath } from "../shapes";

/**
 * Dialogue (`samples/templates/31-dialogue.js`): the conversation as a chat thread. The first speaker
 * seen sits on the left in grey, any other on the right in the accent colour. A cue pops in as a bubble
 * from its tail corner and its words light up as they are spoken; the bubble before it steps back
 * (lifts, shrinks to 0.94, dims its words to 0.6) and the one before that fades out upward. A pause of
 * more than 500 ms before a cue shows that speaker typing. The hero word gets a marker block that wipes in.
 *
 * Geometry is the sample's, read from its layout in Chrome (`.scratch/motion-captions/tools/probe-sample.ts`):
 * the newest bubble's bottom edge is the anchor line (y 1560), A's left edge sits at x 84 and B's right
 * edge at x 996; a bubble is its longest balanced row plus 40 px of padding each side (26 above, 30
 * below), rows are 1.2 em apart and the last baseline is 14.59 px above the bottom padding at 58 px.
 *
 * Every piece of a bubble (body, tail, marks, words) shares one pivot, the bubble's bottom corner on
 * its side, so one pose (position, scale) carries the whole bubble exactly as the sample's wrapper
 * transform does; the poses are sums and products of eased windows, so they are sampled into
 * keyframes (`sampleFrames`) rather than written as one eased segment.
 */

export const DIALOGUE_DEMO: DemoScript = {
  lines: [
    "A> So:m I:m quit:h@470 my:m job:b today.",
    "B> Wait,@320 for:m real?",
    "B> With:m no:m backup:h@480 plan?",
    "A> Honestly?+900 Best:h@450 decision:b ever.",
    "B> Tell:m me:m everything!:h@560",
  ],
  options: { lead: 250, tail: 650, rate: 250, cueGap: 120 },
};

const ANCHOR_LINE = 1560; // the newest bubble's bottom edge
const EDGE = 84; // A's left edge at x 84, B's right edge at x 1080 - 84
const GAP = 16;
const FS = 58;
const PAD_X = 40;
const PAD_TOP = 26;
const PAD_BOTTOM = 30;
const RADIUS = 44;
const TAIL_R = 12; // the corner the tail grows from
const LINE_EM = 1.2;
const LETTER_SPACING = -0.012;
/** The last baseline sits this far above the bottom padding, em (14.59 px at 58 px, read off the probe). */
const BASELINE_EM = 14.59 / 58;
/** The marker block spans the span's content area: this far above and below the baseline, em. */
const MARK_ABOVE_EM = 53.21 / 58;
const MARK_BELOW_EM = 13.99 / 58;
const MARK = { side: 7, radius: 10 } as const;
const MAX_CONTENT = 680; // a bubble is at most 760 wide, border box
/** The widest word a bubble holds: the bubble (and its tail) must stay inside the safe area while it overshoots to 1.048x as it pops. */
const MAX_WORD = 900 - 2 * PAD_X - 1;
const TYPING = { width: 176, height: 112, dot: 20, hop: 11, cycle: 900, stagger: 150, hopShare: 0.42 } as const;
const POP = 380;
const MOVE = 320;
const TAIL_FADE = 160;
const CLEAR = 200;
const A_FILL = "#F2F2F4";
const A_DOT = "#8E8E93";
const B_TEXT = "#FFFFFF";
const B_DOT = { colour: "#FFFFFF", alpha: 0.78 } as const;
const B_MARK = { colour: "#FFFFFF", alpha: 0.25 } as const;
const SHADOWS = [
  { dy: 14, blur: 13, alpha: 0.2 },
  { dy: 2, blur: 2.5, alpha: 0.12 },
] as const;
const BODY_FACE = "Inter SemiBold" as const;
const HERO_FACE = "Inter" as const; // ExtraBold, weight 800
/** The silence that shows the next speaker typing, ms. */
const TYPING_PAUSE_MS = 500;
/** How long before its cue the typing bubble appears at most, ms: a long silence is not a long typing. */
const TYPING_MAX_MS = 2000;
/** A silence longer than this ends the thread: the bubbles clear and the next cue starts a fresh one, ms. */
export const THREAD_BREAK_MS = 3000;

type Side = "A" | "B";
type Fn = (t: number) => number;

/**
 * Piecewise-linear keyframes of several functions on one shared grid. `edges` are where any window
 * starts or ends (kinks); between two of them a segment is split at its middle until every function
 * is within its tolerance of the straight line at the segment's quarter points. A function that never
 * moves comes back as one frame.
 */
function sampleFrames<K extends string>(fns: Record<K, Fn>, tolerance: Record<K, number>, edges: readonly number[]): Record<K, Frames> {
  const sorted = [...new Set(edges)].sort((a, b) => a - b);
  const keys = Object.keys(fns) as K[];
  const times: number[] = [sorted[0]!];
  const split = (a: number, b: number, depth: number) => {
    const at = (u: number) => a + (b - a) * u;
    const off = keys.some((key) => [0.25, 0.5, 0.75].some((u) => Math.abs(fns[key](at(u)) - (fns[key](a) + (fns[key](b) - fns[key](a)) * u)) > tolerance[key]));
    if (depth < 14 && b - a > 4 && off) {
      split(a, at(0.5), depth + 1);
      split(at(0.5), b, depth + 1);
    } else times.push(b);
  };
  for (let at = 1; at < sorted.length; at++) split(sorted[at - 1]!, sorted[at]!, 0);
  const out = {} as Record<K, Frames>;
  for (const key of keys) {
    const values = times.map((t) => fns[key](t));
    out[key] = values.every((value) => Math.abs(value - values[0]!) < 1e-6) ? [[times[0]!, values[0]!]] : (times.map((t, at) => [t, values[at]!]) as unknown as Frames);
  }
  return out;
}

/** The sample's `popPose`: a bubble grows from its tail corner, rising 40 px. */
const popPose = (t: number, at: number, u: number) => {
  const p = prog(t, at, POP);
  return { s: 0.6 + 0.4 * EASES.spring(p), y: 40 * u * (1 - EASES.outExpo(p)), o: clamp(p / 0.22) };
};

interface BubbleLayout {
  readonly size: number;
  readonly width: number;
  readonly height: number;
  readonly rows: readonly { readonly baseline: number; readonly items: readonly { readonly index: number; readonly left: number; readonly box: number }[] }[];
}

/** The bubble as the sample's `inline-block` lays it out: balanced rows of at most 680 px, hugged by its longest row. */
function layoutBubble(cue: SceneCue, input: SceneInput, u: number): BubbleLayout {
  const faceOf = (index: number) => (cue.words[index]!.role === "hero" ? HERO_FACE : BODY_FACE);
  const boxes = (size: number) => cue.words.map((word, index) => input.measure(word.text, faceOf(index), size, LETTER_SPACING).advance + LETTER_SPACING * size);
  let size = FS * u;
  let widths = boxes(size);
  // A word that would push the bubble past the other speaker's edge shrinks the whole bubble's text.
  const fit = fitScale(Math.max(...widths), MAX_WORD * u);
  if (fit < 1) {
    size *= fit;
    widths = boxes(size);
  }
  const spaceAdvance = input.measure(" ", BODY_FACE, size, LETTER_SPACING).advance;
  const space = (spaceAdvance > 0 ? spaceAdvance : 0.24 * size) + LETTER_SPACING * size;
  const lines = balancedRows(widths, space, MAX_CONTENT * u);
  const direction = cueDirection(cue);
  const ordered = lines.map((line) => rowVisualOrder(line.map((index) => cue.words[index]!.text), direction).map((at) => line[at]!));
  const longest = Math.max(...ordered.map((line) => rowWidth(widths, line, space)));
  const width = Math.ceil(2 * PAD_X * u + longest + u);
  const lineHeight = LINE_EM * size;
  const height = (PAD_TOP + PAD_BOTTOM) * u + lines.length * lineHeight;
  const rows = ordered.map((line, row) => {
    const rowW = rowWidth(widths, line, space);
    // A right-to-left row starts at the right padding edge, as an inline row of that direction does.
    let x = direction === "rtl" ? width - PAD_X * u - rowW : PAD_X * u;
    return {
      baseline: -(PAD_BOTTOM * u + BASELINE_EM * size + (lines.length - 1 - row) * lineHeight),
      items: line.map((index) => {
        const item = { index, left: x, box: widths[index]! };
        x += widths[index]! + space;
        return item;
      }),
    };
  });
  return { size, width, height, rows };
}

/** The sample's tail glyph (a 38 x 40 svg path, its tip curling out of the bubble's bottom corner) relative to that corner. */
function tailPath(side: Side, u: number): PathCmd[] {
  const point = (px: number, py: number): [number, number] => [(side === "A" ? px - 15 : 15 - px) * u, (py - 40) * u];
  const m = (px: number, py: number): PathCmd => ["M", ...point(px, py)];
  const l = (px: number, py: number): PathCmd => ["L", ...point(px, py)];
  const c = (x1: number, y1: number, x2: number, y2: number, x: number, y: number): PathCmd => ["C", ...point(x1, y1), ...point(x2, y2), ...point(x, y)];
  // `Q0 40 1.6 38.6` from (3, 40) as a cubic.
  return [m(15, 0), l(38, 0), l(38, 40), l(3, 40), c(1, 40, 0.6667, 39.5333, 1.6, 38.6), c(9, 33, 15, 27, 15, 14), ["Z"]];
}

interface Slot {
  readonly number: number;
  readonly cue: SceneCue;
  readonly side: Side;
  readonly layout: BubbleLayout;
  /** The bubble appears at the cue's start less 60 ms. */
  readonly at: number;
  /** When this slot first pushes the older bubbles: its typing bubble if it has one, else its own. */
  readonly arrival: number;
  readonly typing: { readonly from: number; readonly until: number } | null;
  /** When the tail goes: the next bubble of the same side arrives (Infinity: this is the newest of its side). */
  tailUntil: number;
}

interface Run {
  readonly slots: Slot[];
  /** When the thread is gone: the last cue's end. */
  readonly end: number;
}

const lastWordEnd = (cue: SceneCue) => cue.words[cue.words.length - 1]!.endMs;

/** The bubbles of a cue, as the sample's scene lays them out (positions are relative to the bubble's bottom corner). */
function buildBubble(slot: Slot, run: Run, index: number, input: SceneInput, space: ReturnType<typeof sceneSpace>): Piece[] {
  const { u } = space;
  const { cue, side, layout, at } = slot;
  const left = side === "A";
  const cornerX = space.x(left ? EDGE : 1080 - EDGE);
  const cornerY = space.y(ANCHOR_LINE);
  const newer = run.slots.slice(index + 1);
  const clearAt = run.end - CLEAR;
  const clear = (t: number) => EASES.in(prog(t, clearAt, CLEAR));

  const goneAt = newer.length >= 2 ? newer[1]!.arrival + MOVE : Number.POSITIVE_INFINITY;
  const toMs = Math.min(run.end, goneAt);
  // A bubble that arrives after this one is gone pushes it by exactly nothing (its eased arrival is still 0), so the sum over
  // the whole thread's newer bubbles, evaluated at every sampled time, only needs the few that arrive before then.
  const pushers = newer.filter((other) => other.arrival < toMs);

  /** How far newer bubbles have pushed this one up, and how old it is (sum of their arrivals). */
  const stack = (t: number) => {
    let lift = 0;
    let age = 0;
    for (const other of pushers) {
      const a = EASES.outExpo(prog(t, other.arrival, MOVE));
      age += a;
      lift += other.typing
        ? (TYPING.height * u + GAP * u) * a + (other.layout.height - TYPING.height * u) * EASES.outExpo(prog(t, other.at, MOVE))
        : (other.layout.height + GAP * u) * a;
    }
    const step = clamp(age);
    const gone = clamp(age - 1);
    return { lift: lift + 70 * u * gone, step, gone };
  };

  const windowEdges = (from: number, to: number, extra: readonly number[] = []) => {
    const edges = [from, to, at, at + POP * 0.22, at + POP, clearAt, run.end, ...extra];
    for (const other of newer) edges.push(other.arrival, other.arrival + MOVE, other.at, other.at + MOVE);
    return edges.filter((edge) => edge >= from && edge <= to);
  };

  // The wrapper's pose: the sample's `translateY(pop.y - lift) scale(pop.s * (1 - 0.06 * step))`, then the thread's clear.
  const wrapY: Fn = (t) => {
    const { lift } = stack(t);
    return cornerY + popPose(t, at, u).y - lift + 24 * u * clear(t);
  };
  const wrapScale: Fn = (t) => popPose(t, at, u).s * (1 - 0.06 * stack(t).step);
  const wrapOpacity: Fn = (t) => (t < at ? 0 : (slot.typing ? 1 : popPose(t, at, u).o) * (1 - stack(t).gone) * (1 - clear(t)));
  const poseFrames = sampleFrames({ y: wrapY, s: wrapScale }, { y: 0.15 * u, s: 0.0004 }, windowEdges(at, toMs));
  const common = { fromMs: at, toMs, track: { x: [[at, cornerX]] as Frames, y: poseFrames.y, sx: poseFrames.s, sy: poseFrames.s } };
  const opacityOf = (fn: Fn, extra: readonly number[] = []): Frames => sampleFrames({ o: fn }, { o: 0.003 }, windowEdges(at, toMs, extra)).o;
  const withOpacity = (fn: Fn, extra?: readonly number[]) => ({ ...common, track: { ...common.track, o: opacityOf(fn, extra) } });

  const zBase = slot.number * 8;
  const fill = left ? A_FILL : input.colours.accent;
  const shadows = SHADOWS.map((shadow) => ({ dx: 0, dy: shadow.dy * u, blur: shadow.blur * u, colour: input.colours.shadow, alpha: shadow.alpha }));
  const id = (part: string) => `dialogue:${slot.number}:${part}`;
  const pieces: Piece[] = [];

  if (slot.typing) pieces.push(...buildTyping(slot, input, space, stack));

  const body: ShapePiece = {
    id: id("body"),
    kind: "shape",
    z: zBase + 2,
    ...withOpacity(wrapOpacity),
    path: roundedRectPath(left ? 0 : -layout.width, -layout.height, layout.width, layout.height, left ? [RADIUS * u, RADIUS * u, RADIUS * u, TAIL_R * u] : [RADIUS * u, RADIUS * u, TAIL_R * u, RADIUS * u]),
    fill: { colour: fill },
    shadows,
  };
  const tailFade: Fn = (t) => (slot.tailUntil === Number.POSITIVE_INFINITY ? 1 : 1 - prog(t, slot.tailUntil, TAIL_FADE));
  const tail: ShapePiece = {
    id: id("tail"),
    kind: "shape",
    z: zBase + 3,
    ...withOpacity((t) => wrapOpacity(t) * tailFade(t), [slot.tailUntil, slot.tailUntil + TAIL_FADE]),
    path: tailPath(side, u),
    fill: { colour: fill },
  };
  pieces.push(body, tail);

  const dim: Fn = (t) => 1 - 0.4 * stack(t).step;
  for (const row of layout.rows) {
    for (const item of row.items) {
      const word = cue.words[item.index]!;
      const hero = word.role === "hero";
      const x = (left ? 0 : -layout.width) + item.left;
      const wordFade: Fn = (t) => 0.3 + 0.7 * prog(t, word.startMs - 60, 120);
      const wordOpacity: Fn = (t) => wordFade(t) * dim(t) * wrapOpacity(t);
      const wordEdges = [word.startMs - 60, word.startMs + 60];
      if (hero) {
        // The marker block sits behind the word and wipes in left to right over the word's duration (at least 220 ms).
        const markX = x - MARK.side * u;
        const markW = item.box + 2 * MARK.side * u;
        const markTop = row.baseline - MARK_ABOVE_EM * layout.size;
        const markBottom = row.baseline + MARK_BELOW_EM * layout.size;
        const wipeFrom = word.startMs - 20;
        const wipeDur = Math.max(220, word.endMs - word.startMs);
        const wipe: Fn = (t) => EASES.out(prog(t, wipeFrom, wipeDur));
        const markEdges = [...wordEdges, wipeFrom, wipeFrom + wipeDur];
        const clipFns = {
          x1: (t: number) => cornerX + wrapScale(t) * markX,
          x2: (t: number) => cornerX + wrapScale(t) * (markX + wipe(t) * markW),
          y1: (t: number) => wrapY(t) + wrapScale(t) * markTop,
          y2: (t: number) => wrapY(t) + wrapScale(t) * markBottom,
        };
        const clip = sampleFrames(clipFns, { x1: 0.15 * u, x2: 0.15 * u, y1: 0.15 * u, y2: 0.15 * u }, windowEdges(at, toMs, markEdges));
        const colour = left ? { colour: input.colours.highlight } : B_MARK;
        pieces.push({
          id: id(`mark${item.index}`),
          kind: "shape",
          z: zBase + 4,
          ...withOpacity(wordOpacity, markEdges),
          clip,
          path: roundedRectPath(markX, markTop, markW, markBottom - markTop, MARK.radius * u),
          fill: colour,
        });
      }
      pieces.push({
        id: id(`w${item.index}`),
        kind: "text",
        z: zBase + 5,
        ...withOpacity(wordOpacity, wordEdges),
        origin: { dx: -x, dy: -row.baseline },
        text: word.text,
        face: hero ? HERO_FACE : BODY_FACE,
        sizePx: layout.size,
        letterSpacingEm: LETTER_SPACING,
        fill: left ? input.colours.primary : B_TEXT,
        anchor: "baseline-left",
        language: cue.language,
      });
    }
  }
  return pieces;
}

/** The typing bubble of a slot: it pops in when the pause begins and gives way to the real bubble as that grows over it. */
function buildTyping(slot: Slot, input: SceneInput, space: ReturnType<typeof sceneSpace>, stack: (t: number) => { lift: number }): Piece[] {
  const { u } = space;
  const typing = slot.typing!;
  const { side } = slot;
  const left = side === "A";
  const cornerX = space.x(left ? EDGE : 1080 - EDGE);
  const cornerY = space.y(ANCHOR_LINE);
  const width = TYPING.width * u;
  const height = TYPING.height * u;
  const zBase = slot.number * 8;
  const fill = left ? A_FILL : input.colours.accent;
  const id = (part: string) => `dialogue:${slot.number}:ty-${part}`;
  const { from, until } = typing;
  const edges = (extra: readonly number[] = []) => [from, until, from + POP * 0.22, from + POP, ...extra].filter((edge) => edge >= from && edge <= until);
  const y: Fn = (t) => cornerY + popPose(t, from, u).y - stack(t).lift;
  const s: Fn = (t) => popPose(t, from, u).s;
  const pose = sampleFrames({ y, s }, { y: 0.15 * u, s: 0.0004 }, edges());
  const base = { fromMs: from, toMs: until };
  const track = { x: [[from, cornerX]] as Frames, y: pose.y, sx: pose.s, sy: pose.s };
  const opacity = sampleFrames({ o: (t) => popPose(t, from, u).o }, { o: 0.003 }, edges()).o;
  const shadows = SHADOWS.map((shadow) => ({ dx: 0, dy: shadow.dy * u, blur: shadow.blur * u, colour: input.colours.shadow, alpha: shadow.alpha }));
  const pieces: Piece[] = [
    {
      id: id("body"),
      kind: "shape",
      z: zBase,
      ...base,
      track: { ...track, o: opacity },
      path: roundedRectPath(left ? 0 : -width, -height, width, height, left ? [RADIUS * u, RADIUS * u, RADIUS * u, TAIL_R * u] : [RADIUS * u, RADIUS * u, TAIL_R * u, RADIUS * u]),
      fill: { colour: fill },
      shadows,
    },
    { id: id("tail"), kind: "shape", z: zBase, ...base, track: { ...track, o: opacity }, path: tailPath(side, u), fill: { colour: fill } },
  ];
  // Each dot hops in turn: a 900 ms cycle, 150 ms apart, the rest of the cycle still.
  const bump = (t: number, k: number) => {
    const phase = ((((t - from - k * TYPING.stagger) % TYPING.cycle) + TYPING.cycle) % TYPING.cycle) / TYPING.cycle;
    return phase < TYPING.hopShare ? Math.sin((Math.PI * phase) / TYPING.hopShare) : 0;
  };
  const hopEdges = (k: number) => {
    const out: number[] = [];
    for (let start = from + k * TYPING.stagger - TYPING.cycle; start < until; start += TYPING.cycle) out.push(start, start + TYPING.cycle * TYPING.hopShare);
    return out;
  };
  const dotColour = left ? { colour: A_DOT } : B_DOT;
  for (const k of [0, 1, 2]) {
    const centreX = (left ? 0 : -width) + (45 + TYPING.dot / 2 + k * (TYPING.dot + 13)) * u;
    const dotEdges = edges(hopEdges(k));
    const frames = sampleFrames(
      { y: (t) => y(t) - s(t) * TYPING.hop * u * bump(t, k), o: (t) => popPose(t, from, u).o * (0.5 + 0.5 * bump(t, k)) },
      { y: 0.15 * u, o: 0.003 },
      dotEdges,
    );
    pieces.push({
      id: id(`dot${k}`),
      kind: "shape",
      z: zBase + 1,
      ...base,
      track: { x: track.x, y: frames.y, sx: track.sx, sy: track.sy, o: frames.o },
      path: ellipsePath(centreX, -height / 2, (TYPING.dot / 2) * u),
      fill: dotColour,
    });
  }
  return pieces;
}

function buildScene(input: SceneInput): Piece[] {
  const { cues } = input;
  if (cues.length === 0) return [];
  const space = sceneSpace(input, ANCHOR_LINE);
  // The first speaker seen sits on side A; anyone else on side B; unknown speakers on A.
  const first = cues.find((cue) => cue.speaker !== null)?.speaker ?? null;
  const sideOf = (cue: SceneCue): Side => (cue.speaker === null || cue.speaker === first ? "A" : "B");

  const slots: Slot[] = cues.map((cue, number) => {
    const previousEnd = number > 0 ? lastWordEnd(cues[number - 1]!) : 0;
    const typing = cue.startMs - previousEnd > TYPING_PAUSE_MS ? { from: Math.max(previousEnd + 140, cue.startMs - TYPING_MAX_MS), until: cue.startMs + 40 } : null;
    const at = cue.startMs - 60;
    return { number, cue, side: sideOf(cue), layout: layoutBubble(cue, input, space.u), at, arrival: typing ? typing.from : at, typing, tailUntil: Number.POSITIVE_INFINITY };
  });
  // In a run of bubbles from one side only the newest keeps its tail, as in a real chat.
  slots.forEach((slot, number) => {
    const next = slots[number + 1];
    if (next && next.side === slot.side) slot.tailUntil = next.at;
  });

  // A thread is a run of cues with no long silence between them; the last cue of a run clears it.
  const runs: Run[] = [];
  let current: Slot[] = [];
  slots.forEach((slot, number) => {
    const previous = cues[number - 1];
    if (previous && slot.cue.startMs - lastWordEnd(previous) > THREAD_BREAK_MS) {
      runs.push({ slots: current, end: current[current.length - 1]!.cue.endMs });
      current = [];
    }
    current.push(slot);
  });
  runs.push({ slots: current, end: current[current.length - 1]!.cue.endMs });
  // A thread that breaks must not keep a tail fade or an arrival that points into the next one.
  for (const run of runs) {
    const lastSlot = run.slots[run.slots.length - 1]!;
    if (lastSlot.tailUntil !== Number.POSITIVE_INFINITY && slots[lastSlot.number + 1] && !run.slots.includes(slots[lastSlot.number + 1]!)) lastSlot.tailUntil = Number.POSITIVE_INFINITY;
  }

  const pieces: Piece[] = [];
  for (const run of runs) {
    run.slots.forEach((slot, index) => {
      pieces.push(...clampToSafeArea(buildBubble(slot, run, index, input, space), space.safe, input.measure));
    });
  }
  return pieces;
}

export const dialogueProgram: SceneProgram = {
  build(input) {
    return { pieces: buildScene(input) };
  },
};

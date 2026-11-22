import type { DemoScript } from "../demo";
import { detectList, type ListDetection, type ListEvent } from "../detect";
import { EASES, type Frames, clamp, kf, lerp, prog } from "../ease";
import type { SceneCue, SceneInput, SceneProgram } from "../input";
import { cueDirection, greedyRows, rowVisualOrder, sceneSpace, shiftPiece } from "../layout";
import type { Piece, ShapePiece, TextPiece } from "../scene";
import { arcPath, centredRect, ellipsePath, roundedRectPath } from "../shapes";
import { sampleFrames } from "../frames";

/**
 * Index (`samples/templates/53-index.js`): when the speaker counts points ("three mistakes ... first,
 * ... second, ... so"), a numbered dial docks on the left end of an ink caption card. Its ring has one
 * segment per point and fills as the list advances; when the list closes ("so") the dial leaves.
 * The list state comes from `detectList` over the words.
 *
 * Everything is the sample's numbers in its 1080 x 1920 frame (this file works in "sample px" and maps
 * to the canvas at the end). Chrome's flow is recomputed from `measure()`: the caption is a flex row
 * wrap (column gap 17, row gap 2, max width 692, baselines aligned, line-height 1.12) whose baseline sits
 * 59/64 (body) and 76/83 (hero) of the font size under its box top, the block is centred on y 1290 with
 * its height rounded to a whole px (`offsetHeight`), and the dial's numerals sit at the baselines the
 * sample's own layout gives (+11 and +17 under the dial's centre).
 *
 * The sample's one card is an element whose rect (left, right, top, bottom) morphs from cue to cue and
 * grows to the right as each word arrives, wiped on and off by `clip-path: inset(... round 32px)`. A
 * Scene piece scales rectangles only, so the card is two overlapping bands and four corner discs placed
 * from the same rect function (corners stay round while the rect morphs); the shadow is one blurred
 * rounded rect that keeps the sample's unclipped width.
 *
 * Beyond the sample: a card belongs to a run of cues (a pause longer than `RUN_GAP_MS` past a cue's end
 * closes it as the loop's end does in the sample and a new run opens it); a total outside 2..10 is ignored
 * (the ring would be unreadable); and a clip with no list at all is a plain card. The vertical accent line is omitted
 * at the owner's request.
 */

export const INDEX_DEMO: DemoScript = {
  lines: [
    "three:b mistakes:h killing:b your:m channel",
    "first,:b no:b hook:h@460",
    "second,:b you:m post:b then:m vanish",
    "finally,:b you:m quit:h too:m early",
    "so:m start:b today:h@520",
  ],
  options: { rate: 265, lead: 420 },
};

// ─── The sample's numbers (px of its 1080 x 1920 frame) ─────────────────────
const S = 64;
const HERO = 83; // Math.round(S * 1.3)
const Y_C = 1290;
const DISC_R = 76;
const RING_R = 60;
const RING_W = 6;
const BADGE_R = 46;
const DIAL_X = 80 + DISC_R;
const TEXT_X = DIAL_X + DISC_R + 30;
const PAD_R = 46;
const PAD_Y = 30;
const TEXT_MAX = 1000 - PAD_R - TEXT_X;
const OPEN_LEFT = DIAL_X;
const CLOSED_LEFT = TEXT_X - 54;
const CARD_RADIUS = 32;
const COL_GAP = Math.round(S * 0.27);
const ROW_GAP = 2;
const LINE_EM = 1.12;
const BASELINE = { body: 59 / 64, hero: 76 / 83 } as const;
const LETTER_SPACING = { body: -0.022, hero: -0.035 } as const;
const POP_LEAD = 80;
const GAP_DEG = 16;
const RING_TODO_ALPHA = 0.22;
const MINOR_ALPHA = 0.66;
const SHADOW_ALPHA = 0.3;
const SHADOW_SIGMA = 16;
const SHADOW_DY = 10;
/**
 * A silence this long between a cue's last word and the next cue's first closes the card (the sample's loop end) and the
 * next cue opens a new one. A real cue stays 650 ms past its last word (`SCENE_CUE_TAIL_MS`), so the card sits empty for
 * 400 ms at most before it wipes off.
 */
const RUN_PAUSE_MS = 650 + 400;
const MIN_TOTAL = 2;
const MAX_TOTAL = 10;

const BODY_FACE = "Inter SemiBold" as const;
const HERO_FACE = "Inter" as const;
const NUMBER_FACE = "Unbounded" as const;
const SLASH_FACE = "Inter" as const;

const rounded = (value: number) => Math.round(value);

/** `sampleFrames` on whole milliseconds: a one-millisecond segment is a jump. */
const sampled = (fn: (t: number) => number, edges: readonly number[], tolerance: number): Frames => sampleFrames(fn, edges, tolerance, { wholeMs: true });

/** The edges of `all` that fall inside `[from, to]`, with both ends. */
const within = (all: readonly number[], from: number, to: number) => [from, ...all.filter((edge) => edge > from && edge < to), to];

/** Keyframes moved by a constant, eases kept. */
const offsetFrames = (frames: Frames, by: number): Frames => frames.map((frame) => (frame[2] === undefined ? [frame[0], frame[1] + by] : [frame[0], frame[1] + by, frame[2]])) as unknown as Frames;

/** Opacity of a word: in over 110 ms from `enterAt`, out over `outDur` ms from `exitAt`. */
function fadeFrames(from: number, to: number, enterAt: number, exitAt: number, outDur: number): Frames {
  const enterEnd = enterAt + 110;
  if (enterEnd <= exitAt && enterAt >= from && exitAt + outDur <= to) {
    return [[from, 0], [enterAt, 0], [enterEnd, 1], [exitAt, 1], [exitAt + outDur, 0, "in"]];
  }
  const fn = (t: number) => prog(t, enterAt, 110) * (1 - EASES.in(prog(t, exitAt, outDur)));
  return sampled(fn, within([enterAt, enterEnd, exitAt, exitAt + outDur], from, to), 0.01);
}

// ─── Layout of one cue's words, in sample px ────────────────────────────────

interface Item {
  readonly index: number;
  readonly text: string;
  readonly hero: boolean;
  readonly ordinal: boolean;
  readonly size: number;
  readonly letterSpacingEm: number;
  /** CSS box width: advance plus the trailing letter spacing. */
  readonly boxW: number;
  /** Left of the box in the page, sample px. */
  readonly left: number;
  readonly baseline: number;
  /** Top of the item's line box. */
  readonly top: number;
  readonly boxH: number;
}

interface Block {
  readonly cue: SceneCue;
  readonly number: number;
  readonly items: readonly Item[];
  readonly listOpen: boolean;
  readonly rect: { readonly l: number; readonly r: number; readonly t: number; readonly b: number };
  /** The card's right edge as each word has arrived: the running maximum of the words' right edges. */
  readonly rights: readonly number[];
}

function layoutBlock(cue: SceneCue, number: number, input: SceneInput, u: number, listOpen: boolean, ordinals: ReadonlySet<number>): Block {
  const direction = cueDirection(cue);
  const sizeOf = (hero: boolean, scale: number) => (hero ? HERO : S) * scale;
  const widthOf = (text: string, hero: boolean, scale: number) => {
    const size = sizeOf(hero, scale);
    const ls = hero ? LETTER_SPACING.hero : LETTER_SPACING.body;
    return input.measure(text, hero ? HERO_FACE : BODY_FACE, size * u, ls).advance / u + ls * size;
  };
  // A word wider than the text column shrinks the whole cue (the sample's flex row would overflow).
  const widest = Math.max(...cue.words.map((word) => widthOf(word.text, word.role === "hero", 1)));
  const scale = widest > TEXT_MAX ? TEXT_MAX / widest : 1;
  const gap = COL_GAP * scale;
  const widths = cue.words.map((word) => widthOf(word.text, word.role === "hero", scale));
  const rows = greedyRows(widths, gap, TEXT_MAX);

  const placed = rows.map((row) => {
    const ordered = rowVisualOrder(row.map((at) => cue.words[at]!.text), direction).map((at) => row[at]!);
    let x = 0;
    const lefts = new Map<number, number>();
    for (const at of ordered) {
      lefts.set(at, x);
      x += widths[at]! + gap;
    }
    const ascent = Math.max(...row.map((at) => sizeOf(cue.words[at]!.role === "hero", scale) * (cue.words[at]!.role === "hero" ? BASELINE.hero : BASELINE.body)));
    const descent = Math.max(
      ...row.map((at) => {
        const hero = cue.words[at]!.role === "hero";
        const size = sizeOf(hero, scale);
        return LINE_EM * size - size * (hero ? BASELINE.hero : BASELINE.body);
      }),
    );
    return { row, lefts, width: x - gap, ascent, height: ascent + descent };
  });
  const blockWidth = Math.max(...placed.map((row) => row.width));
  const exactHeight = placed.reduce((sum, row) => sum + row.height, 0) + ROW_GAP * scale * (placed.length - 1);
  const h = Math.round(exactHeight);
  let rowTop = Y_C - h / 2;
  const items: Item[] = [];
  for (const row of placed) {
    // A right-to-left row sits against the right edge of the block.
    const shift = direction === "rtl" ? blockWidth - row.width : 0;
    for (const at of row.row) {
      const word = cue.words[at]!;
      const hero = word.role === "hero";
      const size = sizeOf(hero, scale);
      const baseline = rowTop + row.ascent;
      items[at] = {
        index: at,
        text: word.text,
        hero,
        ordinal: ordinals.has(at),
        size,
        letterSpacingEm: hero ? LETTER_SPACING.hero : LETTER_SPACING.body,
        boxW: widths[at]!,
        left: TEXT_X + row.lefts.get(at)! + shift,
        baseline,
        top: baseline - size * (hero ? BASELINE.hero : BASELINE.body),
        boxH: LINE_EM * size,
      };
    }
    rowTop += row.height + ROW_GAP * scale;
  }
  let reach = Number.NEGATIVE_INFINITY;
  const rights = items.map((item) => (reach = Math.max(reach, item.left + item.boxW + PAD_R)));
  const rect = {
    l: listOpen ? OPEN_LEFT : CLOSED_LEFT,
    r: TEXT_X + (reach - PAD_R - TEXT_X) + PAD_R,
    t: Math.min(Y_C - h / 2 - PAD_Y, listOpen ? Y_C - DISC_R : Number.POSITIVE_INFINITY),
    b: Math.max(Y_C + h / 2 + PAD_Y, listOpen ? Y_C + DISC_R : Number.NEGATIVE_INFINITY),
  };
  return { cue, number, items, listOpen, rect, rights };
}

// ─── The card of a run of cues, as a function of time ───────────────────────

interface Run {
  readonly blocks: readonly Block[];
  readonly startMs: number;
  readonly endMs: number;
}

interface CardState {
  readonly l: number;
  readonly r: number;
  readonly t: number;
  readonly b: number;
  /** Share of the card shown by the wipe (0..1). */
  readonly reveal: number;
}

const rectLerp = (a: Block["rect"], b: Block["rect"], p: number) => ({ l: lerp(a.l, b.l, p), r: lerp(a.r, b.r, p), t: lerp(a.t, b.t, p), b: lerp(a.b, b.b, p) });

function cardState(run: Run, t: number): CardState {
  const { blocks } = run;
  let at = blocks.findIndex((block) => t < block.cue.endMs);
  if (at < 0) at = blocks.length - 1;
  const current = blocks[at]!;
  // The card grows to the right as each word arrives instead of waiting at full width.
  let reach = current.rights[0]!;
  for (let index = 1; index < current.items.length; index++) {
    const grow = EASES.outExpo(prog(t, current.cue.words[index]!.startMs - 90, 300));
    if (grow > 0) reach = lerp(current.rights[index - 1]!, current.rights[index]!, grow);
  }
  let rect = { ...current.rect, r: reach };
  if (at > 0) {
    const morph = EASES.outExpo(prog(t, current.cue.startMs - 110, 320));
    rect = rectLerp(blocks[at - 1]!.rect, rect, morph);
  }
  const open = EASES.outExpo(prog(t, run.startMs - 300, 380));
  const close = EASES.in(prog(t, run.endMs - 190, 190));
  return { ...rect, reveal: open * (1 - close) };
}

/** Where the sample's windows start and end: the places the card's function is not smooth. */
function runEdges(run: Run): number[] {
  const edges = [run.startMs - 300, run.startMs + 80, run.endMs - 190, run.endMs];
  run.blocks.forEach((block, at) => {
    if (at > 0) edges.push(block.cue.startMs - 110, block.cue.startMs + 210, block.cue.startMs - 1, block.cue.startMs);
    edges.push(block.cue.endMs - 1, block.cue.endMs);
    block.cue.words.forEach((word, index) => {
      if (index > 0) edges.push(word.startMs - 90, word.startMs + 210);
    });
  });
  return edges.map(rounded);
}

// ─── The program ────────────────────────────────────────────────────────────

interface Dial {
  readonly events: readonly ListEvent[];
  readonly total: number;
  readonly fromMs: number;
  readonly toMs: number;
  readonly edges: readonly number[];
  /** The dial's scale at `t`: the sample's `scaleAfter` of the latest event. */
  scale(t: number): number;
}

function makeDial(detection: ListDetection, input: SceneInput, sceneEnd: number): Dial | null {
  const total = detection.total;
  if (total === null || detection.events.length === 0) return null;
  const { events } = detection;
  const wordEnd = (event: ListEvent) => input.cues[event.cue]!.words[event.word]!.endMs;
  const scaleAfter = (i: number, t: number): number => {
    const event = events[i]!;
    const t0 = event.atMs - POP_LEAD;
    if (event.type === "end") return lerp(i > 0 ? scaleAfter(i - 1, t0) : 1, 0, EASES.in(prog(t, t0, 170)));
    const settle = Math.max(t0 + 260, wordEnd(event) + 420);
    const from = event.type === "total" ? 0.5 : i > 0 ? scaleAfter(i - 1, t0) : 0.5;
    return kf(t, [[t0, from], [t0 + 140, 1.1, "out"], [t0 + 230, 1, "in"], [settle, 1], [settle + 320, 0.86, "out"]]);
  };
  const latest = (t: number) => {
    let found = -1;
    events.forEach((event, i) => {
      if (t >= event.atMs - POP_LEAD) found = i;
    });
    return found;
  };
  const end = events.find((event) => event.type === "end");
  const fromMs = events[0]!.atMs - POP_LEAD;
  const toMs = end ? end.atMs - POP_LEAD + 170 : sceneEnd;
  const edges: number[] = [fromMs, toMs];
  events.forEach((event, i) => {
    const t0 = event.atMs - POP_LEAD;
    edges.push(t0, t0 + 1);
    if (event.type === "end") edges.push(t0 + 170);
    else {
      const settle = Math.max(t0 + 260, wordEnd(event) + 420);
      edges.push(t0 + 120, t0 + 140, t0 + 180, t0 + 220, t0 + 230, t0 + 260, settle, settle + 320);
    }
    if (i === 0) edges.push(t0 + 200);
  });
  const firstTotal = events.find((event) => event.type === "total")!;
  for (let k = 0; k < total; k++) edges.push(firstTotal.atMs - 20 + k * 70, firstTotal.atMs - 20 + k * 70 + 260);
  return {
    events,
    total,
    fromMs,
    toMs,
    edges: edges.map(rounded),
    scale: (t) => {
      const i = latest(t);
      return i < 0 ? 0 : Math.max(0, scaleAfter(i, t));
    },
  };
}

/** The sample's detector, with a total outside 2..10 taken as no list (a ring of 40 segments is not a ring). */
function detectIndexList(cues: readonly SceneCue[]): ListDetection {
  const detection = detectList(cues);
  if (detection.total !== null && (detection.total < MIN_TOTAL || detection.total > MAX_TOTAL)) {
    return { events: [], total: null, listOpen: cues.map(() => false) };
  }
  return detection;
}

function build(input: SceneInput) {
  const cues = input.cues;
  if (cues.length === 0) return { pieces: [] as Piece[] };
  const space = sceneSpace(input, Y_C);
  const u = space.u;
  const X = space.x;
  const Y = space.y;
  const { colours } = input;
  const card = colours.accent;
  const detection = detectIndexList(cues);
  const sceneEnd = Math.max(...cues.map((cue) => cue.endMs));
  const dial = makeDial(detection, input, sceneEnd);
  const ordinals = new Map<number, Set<number>>();
  for (const event of detection.events) {
    if (event.type !== "item") continue;
    if (!ordinals.has(event.cue)) ordinals.set(event.cue, new Set());
    ordinals.get(event.cue)!.add(event.word);
  }
  const blocks = cues.map((cue, at) => layoutBlock(cue, at, input, u, detection.listOpen[at] === true, ordinals.get(at) ?? new Set()));

  // Runs: cues the card stays on (the sample's loop is one run).
  const runs: Run[] = [];
  for (const block of blocks) {
    const last = runs[runs.length - 1];
    const before = last ? last.blocks[last.blocks.length - 1]!.cue : null;
    if (last && before && block.cue.startMs - before.words[before.words.length - 1]!.endMs < RUN_PAUSE_MS) {
      runs[runs.length - 1] = { blocks: [...last.blocks, block], startMs: last.startMs, endMs: block.cue.endMs };
    } else runs.push({ blocks: [block], startMs: block.cue.startMs, endMs: block.cue.endMs });
  }

  const pieces: Piece[] = [];
  const tolPx = 0.3 * u;

  // ── Cards and shadows, one set per run ──
  runs.forEach((run) => {
    const first = run.blocks[0]!.number;
    const edges = runEdges(run);
    const state = (t: number) => cardState(run, t);
    const widest = Math.max(...run.blocks.map((block) => block.rect.r - block.rect.l));
    const tallest = Math.max(...run.blocks.map((block) => block.rect.b - block.rect.t));
    const radius = CARD_RADIUS;
    const minWidth = 2 * radius;
    const visibleWidth = (t: number) => {
      const s = state(t);
      return s.reveal * (s.r - s.l);
    };
    // The wipe is a shape only from the moment it is wider than its two corners to the moment it is not.
    let fromMs = Math.floor(run.startMs - 300);
    while (fromMs < run.endMs && visibleWidth(fromMs) < minWidth) fromMs++;
    let toMs = Math.ceil(run.endMs);
    while (toMs > fromMs && visibleWidth(toMs - 1) < minWidth) toMs--;
    if (toMs <= fromMs) return;
    const e = within(edges, fromMs, toMs);
    const rectAt = (t: number) => {
      const s = state(t);
      const width = Math.max(minWidth, s.reveal * (s.r - s.l));
      return { l: s.l, r: s.l + width, t: s.t, b: s.b };
    };
    const cx = (t: number) => X((rectAt(t).l + rectAt(t).r) / 2);
    const cy = (t: number) => Y((rectAt(t).t + rectAt(t).b) / 2);
    const bandW = widest - 2 * radius + 4;
    const bandH = tallest - 2 * radius + 4;
    const cardPiece = (id: string, path: ShapePiece["path"], track: ShapePiece["track"]): ShapePiece => ({
      id: `index:${first}:card:${id}`,
      kind: "shape",
      z: 2,
      fromMs,
      toMs,
      track,
      path,
      fill: { colour: card },
    });
    // Two bands (overlapping their corners by 2 px so no seam shows) and four discs make the rounded rect.
    pieces.push(
      cardPiece("a", centredRect(bandW * u, tallest * u), {
        x: sampled(cx, e, tolPx),
        y: sampled((t) => Y((rectAt(t).t + rectAt(t).b) / 2), e, tolPx),
        sx: sampled((t) => ((rectAt(t).r - rectAt(t).l - 2 * radius + 4) * u) / (bandW * u), e, 0.002),
        sy: sampled((t) => (rectAt(t).b - rectAt(t).t) / tallest, e, 0.002),
      }),
      cardPiece("b", centredRect(widest * u, (tallest - 2 * radius + 4) * u), {
        x: sampled(cx, e, tolPx),
        y: sampled(cy, e, tolPx),
        sx: sampled((t) => (rectAt(t).r - rectAt(t).l) / widest, e, 0.002),
        sy: sampled((t) => (rectAt(t).b - rectAt(t).t - 2 * radius + 4) / bandH, e, 0.002),
      }),
    );
    for (const [name, right, bottom] of [["tl", false, false], ["tr", true, false], ["bl", false, true], ["br", true, true]] as const) {
      pieces.push(
        cardPiece(name, ellipsePath(0, 0, radius * u), {
          x: sampled((t) => X(right ? rectAt(t).r - radius : rectAt(t).l + radius), e, tolPx),
          y: sampled((t) => Y(bottom ? rectAt(t).b - radius : rectAt(t).t + radius), e, tolPx),
        }),
      );
    }
    // The shadow keeps the sample's unclipped width and fades with the wipe.
    const shadowFrom = Math.floor(run.startMs - 300);
    const se = within(edges, shadowFrom, toMs);
    pieces.push({
      id: `index:${first}:card:shadow`,
      kind: "shape",
      z: 1,
      fromMs: shadowFrom,
      toMs,
      track: {
        x: sampled((t) => X((state(t).l + state(t).r) / 2), se, tolPx),
        y: sampled((t) => Y((state(t).t + state(t).b) / 2 + SHADOW_DY), se, tolPx),
        sx: sampled((t) => (state(t).r - state(t).l) / widest, se, 0.002),
        sy: sampled((t) => (state(t).b - state(t).t) / tallest, se, 0.002),
        o: sampled((t) => SHADOW_ALPHA * state(t).reveal, se, 0.004),
        blur: [[shadowFrom, SHADOW_SIGMA * u]],
      },
      path: roundedRectPath((-widest * u) / 2, (-tallest * u) / 2, widest * u, tallest * u, radius * u),
      fill: { colour: colours.shadow },
    });
  });

  // ── The dial ──
  if (dial) {
    const { events, total, fromMs, toMs } = dial;
    const totalEvent = events.find((event) => event.type === "total")!;
    const cx = X(DIAL_X);
    const cy = Y(Y_C);
    const de = (from: number, to: number) => within(dial.edges, from, to);
    // The dial slides in over 200 ms from one body size to the left, starting with the total (the first event).
    const slideStart = totalEvent.atMs - POP_LEAD;
    const slideAt = (t: number) => (1 - EASES.out(prog(t, slideStart, 200))) * -S;
    const xTrack: Frames = [[fromMs, cx - S * u], [slideStart + 200, cx, "out"]];
    const scaleTrack = (from: number, to: number, extra: (t: number) => number = () => 1) => sampled((t) => dial.scale(t) * extra(t), de(from, to), 0.004);
    const disc = scaleTrack(fromMs, toMs);
    const shape = (id: string, z: number, path: ShapePiece["path"], track: ShapePiece["track"], paint: Pick<ShapePiece, "fill" | "stroke">, from = fromMs): void => {
      pieces.push({ id: `index:dial:${id}`, kind: "shape", z, fromMs: from, toMs, track, path, ...paint });
    };

    // A blurred disc 10 px under the dial, at 30 % while the dial is at full size.
    shape(
      "shadow",
      1,
      ellipsePath(0, 0, DISC_R * u),
      {
        x: xTrack,
        y: sampled((t) => cy + SHADOW_DY * dial.scale(t) * u, de(fromMs, toMs), tolPx),
        sx: disc,
        sy: disc,
        o: sampled((t) => SHADOW_ALPHA * clamp(dial.scale(t)), de(fromMs, toMs), 0.004),
        blur: [[fromMs, SHADOW_SIGMA * u]],
      },
      { fill: { colour: colours.shadow } },
    );
    shape("disc", 4, ellipsePath(0, 0, DISC_R * u), { x: xTrack, y: [[fromMs, cy]], sx: disc, sy: disc }, { fill: { colour: card } });

    // Ring: segments pop in with the total and each lights at its item (a bright copy fades in over the dim one:
    // 0.22 + 0.78 * lit, the sample's `lerp(0.22, 1, lit)`).
    const span = 360 / total;
    for (let k = 0; k < total; k++) {
      const appearAt = totalEvent.atMs - 20 + k * 70;
      const item = events.find((event) => event.type === "item" && event.n === k + 1);
      const popAt = item ? item.atMs - POP_LEAD : null;
      const pop = (t: number) => (popAt === null ? 1 : kf(t, [[popAt, 1], [popAt + 1, 1.15], [popAt + 180, 1, "out"]]));
      const segFrom = Math.max(fromMs, appearAt + 1);
      if (segFrom >= toMs) continue;
      const scales = scaleTrack(segFrom, toMs, (t) => EASES.outBack(prog(t, appearAt, 260)) * pop(t));
      const path = arcPath(0, 0, RING_R * u, k * span + GAP_DEG / 2 - 90, (k + 1) * span - GAP_DEG / 2 - 90);
      const track = { x: xTrack, y: [[segFrom, cy]] as Frames, sx: scales, sy: scales };
      shape(`ring${k}todo`, 5, path, track, { stroke: { widthPx: RING_W * u, colour: colours.primary, alpha: RING_TODO_ALPHA } }, segFrom);
      if (item) shape(`ring${k}done`, 6, path, { ...track, o: [[segFrom, 0], [popAt!, 0], [popAt! + 120, 1]] }, { stroke: { widthPx: RING_W * u, colour: colours.primary, alpha: 1 } }, segFrom);
    }
    shape("badge", 7, ellipsePath(0, 0, BADGE_R * u), { x: xTrack, y: [[fromMs, cy]], sx: disc, sy: disc }, { fill: { colour: colours.highlight } });

    // Numerals: the total first, then each item as "n/T". The old one leaves upward as the new one rises into the
    // badge box; both live inside a clip that is the badge box (it scales and slides with the dial).
    const rolling = events.filter((event) => event.type !== "end");
    rolling.forEach((event, k) => {
      const next = rolling[k + 1];
      const t0 = event.atMs - POP_LEAD;
      const from = Math.max(fromMs, t0);
      const to = next ? Math.min(toMs, next.atMs - POP_LEAD + 220) : toMs;
      if (from >= to) return;
      const roll = (t: number) => {
        const inP = event.type === "total" ? 1 : EASES.out(prog(t, t0, 220));
        const outP = next ? EASES.out(prog(t, next.atMs - POP_LEAD, 220)) : 0;
        return (1 - inP) * 86 - outP * 86;
      };
      const edges = [...dial.edges, t0, t0 + 220, ...(next ? [next.atMs - POP_LEAD, next.atMs - POP_LEAD + 220] : [])];
      const ne = within(edges, from, to);
      const yTrack = sampled((t) => cy + dial.scale(t) * roll(t) * u, ne, tolPx);
      const sTrack = sampled((t) => dial.scale(t), ne, 0.004);
      const half = (t: number) => BADGE_R * u * dial.scale(t);
      const slideX = (t: number) => cx + slideAt(t) * u;
      const clip = {
        x1: sampled((t) => slideX(t) - half(t), ne, tolPx),
        x2: sampled((t) => slideX(t) + half(t), ne, tolPx),
        y1: sampled((t) => cy - half(t), ne, tolPx),
        y2: sampled((t) => cy + half(t), ne, tolPx),
      };
      const isTotal = event.type === "total";
      const digit = isTotal ? total : (event as Extract<ListEvent, { type: "item" }>).n;
      const digitSize = isTotal ? 50 : 44;
      const digitLs = -0.04;
      const digitW = input.measure(String(digit), NUMBER_FACE, digitSize * u, digitLs).advance / u + digitLs * digitSize;
      const slash = `/${total}`;
      const slashSize = 25;
      const slashLs = -0.02;
      const slashW = input.measure(slash, SLASH_FACE, slashSize * u, slashLs).advance / u + slashLs * slashSize;
      const rowW = isTotal ? digitW : digitW + 3 + slashW;
      const baselineOff = isTotal ? 17 : 11;
      const text = (id: string, value: string, face: TextPiece["face"], size: number, ls: number, offX: number, alpha: number) =>
        pieces.push({
          id: `index:dial:num${k}${id}`,
          kind: "text",
          z: 8,
          fromMs: from,
          toMs: to,
          track: { x: xTrack, y: yTrack, sx: sTrack, sy: sTrack },
          clip,
          origin: { dx: -offX * u, dy: -baselineOff * u },
          text: value,
          face,
          sizePx: size * u,
          letterSpacingEm: ls,
          fill: card,
          ...(alpha < 1 ? { fillAlpha: alpha } : {}),
          anchor: "baseline-left",
          language: null,
        });
      text("d", String(digit), NUMBER_FACE, digitSize, digitLs, -rowW / 2, 1);
      if (!isTotal) text("s", slash, SLASH_FACE, slashSize, slashLs, -rowW / 2 + digitW + 3, 0.7);
    });
  }

  // ── Words ──
  const lastOfRun = new Set(runs.map((run) => run.blocks[run.blocks.length - 1]!.number));
  for (const block of blocks) {
    const { cue } = block;
    const fromMs = cue.startMs - 90;
    const toMs = cue.endMs;
    const final = lastOfRun.has(block.number);
    const exitAt = cue.endMs - (final ? 200 : 190);
    const exitDur = final ? 110 : 120;
    for (const item of block.items) {
      const word = cue.words[item.index]!;
      const enterAt = word.startMs - 80;
      const left = X(item.left);
      const baseline = Y(item.baseline);
      const slide = (S * 0.25 * u);
      const x: Frames = [[fromMs, left + slide], [enterAt, left + slide], [enterAt + 260, left, "outExpo"]];
      const y: Frames = exitAt > fromMs ? [[fromMs, baseline], [exitAt, baseline], [exitAt + exitDur, baseline - 10 * u, "in"]] : [[fromMs, baseline]];
      const o = fadeFrames(fromMs, toMs, enterAt, exitAt, exitDur);
      // Minor words are the primary colour at 66 % (the sample's `rgba(255,255,255,0.66)`).
      const minorAlpha = word.role === "minor" && !item.ordinal && !item.hero ? MINOR_ALPHA : 1;
      const fill = item.ordinal ? colours.highlight : colours.primary;
      const base = `index:${block.number}:w${item.index}`;
      if (item.hero) {
        // Highlighter wipes left to right (an `out` ease on a straight line); the letters it has covered turn ink.
        const barLeft = left - 0.09 * item.size * u;
        const barRight = left + (item.boxW + 0.09 * item.size) * u;
        const barTop = Y(item.top) + 0.16 * item.size * u;
        const barBottom = Y(item.top) + (item.boxH - 0.06 * item.size) * u;
        const pad = HERO * 0.07;
        const spanPx = (item.boxW + pad * 2) * u;
        const wipeAt = word.startMs + 30;
        const wipe = (from: number, to: number): Frames => [[fromMs, from], [wipeAt, from], [wipeAt + 200, to, "out"]];
        const barW = barRight - barLeft;
        const barH = barBottom - barTop;
        pieces.push({
          id: `${base}:bar`,
          kind: "shape",
          z: 10,
          fromMs,
          toMs,
          track: { x: offsetFrames(x, (barLeft + barRight) / 2 - left), y: offsetFrames(y, (barTop + barBottom) / 2 - baseline), o },
          path: roundedRectPath(-barW / 2, -barH / 2, barW, barH, 0.1 * item.size * u),
          fill: { colour: colours.highlight },
          clip: { x1: [[fromMs, barLeft - 24 * u]], x2: wipe(barRight - spanPx, barRight), y1: [[fromMs, barTop - 30 * u]], y2: [[fromMs, barBottom + 30 * u]] },
        });
        pieces.push(textPiece(`${base}`, 11, item, word.text, fill, 1, { x, y, o }, cue, u));
        pieces.push({
          ...textPiece(`${base}:ink`, 12, item, word.text, card, 1, { x, y, o }, cue, u),
          clip: {
            x1: [[fromMs, left - 0.2 * item.size * u]],
            x2: wipe(left - pad * u, left + (item.boxW + pad) * u),
            y1: [[fromMs, Y(item.top) - 40 * u]],
            y2: [[fromMs, Y(item.top) + (item.boxH + 40) * u]],
          },
        });
      } else {
        pieces.push(textPiece(base, 11, item, word.text, fill, minorAlpha, { x, y, o }, cue, u));
      }
    }
  }

  // ── Into the safe area: one shift for everything (the dial and the card stay where they are relative to each other) ──
  const lefts = blocks.map((block) => block.rect.l);
  const rights = blocks.map((block) => block.rect.r);
  const tops = blocks.map((block) => block.rect.t);
  const bottoms = blocks.map((block) => block.rect.b);
  if (dial) {
    lefts.push(DIAL_X - DISC_R * 1.1);
    tops.push(Y_C - DISC_R * 1.1);
    bottoms.push(Y_C + DISC_R * 1.1);
  }
  const extent = { x1: X(Math.min(...lefts)), x2: X(Math.max(...rights)), y1: Y(Math.min(...tops)), y2: Y(Math.max(...bottoms)) };
  const axis = (low: number, high: number, safeLow: number, safeHigh: number) => {
    if (high - low >= safeHigh - safeLow) return (safeLow + safeHigh) / 2 - (low + high) / 2;
    if (low < safeLow) return safeLow - low;
    if (high > safeHigh) return safeHigh - high;
    return 0;
  };
  const dx = axis(extent.x1, extent.x2, space.safe.x1, space.safe.x2);
  const dy = axis(extent.y1, extent.y2, space.safe.y1, space.safe.y2);
  return { pieces: dx === 0 && dy === 0 ? pieces : pieces.map((piece) => shiftPiece(piece, dx, dy)) };
}

function textPiece(id: string, z: number, item: Item, text: string, fill: string, fillAlpha: number, track: { x: Frames; y: Frames; o: Frames }, cue: SceneCue, u: number): TextPiece {
  return {
    id,
    kind: "text",
    z,
    fromMs: cue.startMs - 90,
    toMs: cue.endMs,
    track,
    text,
    face: item.hero ? HERO_FACE : BODY_FACE,
    sizePx: item.size * u,
    letterSpacingEm: item.letterSpacingEm,
    fill,
    ...(fillAlpha < 1 ? { fillAlpha } : {}),
    anchor: "baseline-left",
    language: cue.language,
  };
}

export const indexProgram: SceneProgram = { build };

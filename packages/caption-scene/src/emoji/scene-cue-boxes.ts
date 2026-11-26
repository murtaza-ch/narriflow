import { type CaptionPreset, captionSceneMeta } from "@narriflow/validators";
import { SCENE_CUE_MIN_LAST_WORD_MS } from "../cues";
import { kf } from "../ease";
import type { SceneCue } from "../input";
import { livePieceIndexes } from "../piece-index";
import { type Box, type CaptionScene, type Measure, type Piece, pieceBounds, sceneBoundsAt, sceneBoundsOver } from "../scene";
import { unionBox } from "./box";
import type { CaptionEmojiCueBox, CaptionEmojiObstacle } from "./cue-box";
import { captionEmojiCueDirection } from "./style";

/**
 * Cue boxes of a built Scene Style (spec D4). A piece belongs to cue `n` when its id's second
 * segment is `n` (`lyrics:3:w0`); pieces such as `index:dial:*`, `chronicle:tl:*` or `aura:orb0:*`
 * belong to no cue. The reference box is the union of the cue's own non-bleed pieces at one time,
 * `t* = min(lastPaint - 50, lastWordStart + 350)`, when the cue is whole and not yet leaving: a
 * union over the emoji's window would take in neighbours and exits. A cue with only bleed pieces
 * (Ticker's hero-only cue) takes their box, cut to the canvas.
 *
 * Obstacles at a time are the live boxes of the cue's own non-bleed pieces, of pieces that belong
 * to no cue, and of other cues' pieces: their shapes at opacity 0.5 or more, their text at 0.1 or
 * more (Lyrics draws its neighbour lines as faint as 0.15, dim but read). Text is an obstacle even
 * when it bleeds (a marquee word is still a word); bleed shapes (bands, tapes) are not, so an emoji
 * may sit on a band as any sticker would. Decorations (shapes with no text on them) and echoes (a flash
 * under 150 ms of text the cue draws far longer) are soft: covered only when no slot clear of them
 * is left.
 */

/** How long before its first word a template may start to draw a cue, ms (the conformance suite's lead). */
const SCENE_CUE_LEAD_MS = 100;
const OTHER_CUE_SHAPE_OPACITY = 0.5;
const OTHER_CUE_TEXT_OPACITY = 0.1;
/** Text that flashes for less than this, ms, while its cue draws the same text far longer, is an echo (Cascade's beats). */
const FLASH_MS = 150;
/** How long before its last paint the reference box is sampled at the latest, ms. */
const SAMPLE_BEFORE_END_MS = 50;
/** The step back in time when nothing of a cue is drawn at its sample time, ms. */
const SAMPLE_STEP_MS = 20;
/** How long after its last word starts the reference box is sampled at the latest, ms. */
const SAMPLE_AFTER_LAST_WORD_MS = 350;

function cueOf(piece: Piece): number | null {
  const segment = piece.id.split(":", 2)[1];
  return segment !== undefined && /^\d+$/.test(segment) ? Number(segment) : null;
}

const opacityAt = (piece: Piece, ms: number) => (piece.track.o ? kf(ms, piece.track.o) : 1);

/**
 * When a piece paints: its window, narrowed to its opacity track's first and last segments that
 * are not all zero (a word that fades out by 1630 of a window that runs to 1700 stops at 1630).
 * Null when it never paints.
 */
function paintSpan(piece: Piece): readonly [number, number] | null {
  const o = piece.track.o;
  if (!o || o.length === 0) return [piece.fromMs, piece.toMs];
  const first = o.findIndex((frame) => frame[1] > 0);
  if (first < 0) return null;
  let last = o.length - 1;
  while (o[last]![1] <= 0) last--;
  const from = first === 0 ? piece.fromMs : Math.max(piece.fromMs, o[first - 1]![0]);
  const to = last === o.length - 1 ? piece.toMs : Math.min(piece.toMs, o[last + 1]![0]);
  return to > from ? [from, to] : null;
}

export interface SceneCueBoxOptions {
  readonly measure: Measure;
  readonly canvas: { readonly width: number; readonly height: number };
  /** The scene's body text size, px (the style's `bodyPx` times the user's size scale). */
  readonly bodyPx: number;
  /** The cue's direction, from its words and language. */
  readonly direction: (cue: SceneCue) => "ltr" | "rtl";
}

export function sceneCueBoxes(scene: CaptionScene, cues: readonly SceneCue[], options: SceneCueBoxOptions): CaptionEmojiCueBox[] {
  const { measure, canvas } = options;
  const own = new Map<number, Piece[]>();
  const shared: Piece[] = [];
  for (const piece of scene.pieces) {
    const cue = cueOf(piece);
    if (cue === null) {
      if (piece.kind === "text" || !piece.bleed) shared.push(piece);
      continue;
    }
    const list = own.get(cue);
    if (list) list.push(piece);
    else own.set(cue, [piece]);
  }
  const solid = new Map<number, Piece[]>();
  for (const [cue, pieces] of own) solid.set(cue, pieces.filter((piece) => piece.kind === "text" || !piece.bleed));
  // One array of the obstacles every cue shares at a time, so the piece index is built once.
  const everyCue = scene.pieces.filter((piece) => cueOf(piece) !== null && (piece.kind === "text" || !piece.bleed));
  const plateCandidates = [...shared, ...everyCue];

  // When each cue paints as itself: from its first paint, but not before it is about to be spoken (a stack shows the next cue,
  // dimmed, long before), to its last paint.
  const starts = new Map(cues.map((cue) => [cue.index, cue.startMs - SCENE_CUE_LEAD_MS]));
  const spoken = new Map(cues.map((cue) => [cue.index, cue.startMs]));
  const spans = new Map<number, { fromMs: number; toMs: number }>();
  for (const [index, pieces] of own) {
    let fromMs = Number.POSITIVE_INFINITY;
    let toMs = Number.NEGATIVE_INFINITY;
    for (const piece of pieces) {
      const span = paintSpan(piece);
      if (!span) continue;
      fromMs = Math.min(fromMs, span[0]);
      toMs = Math.max(toMs, span[1]);
    }
    fromMs = Math.max(fromMs, starts.get(index) ?? fromMs);
    // A cue is spoken on one side of an inserted scene (the plan splits a cue at one), and so is its emoji: a stack's pieces
    // that resume after the scene, or show a cue before it, do not carry the emoji across.
    const spokenMs = spoken.get(index) ?? fromMs;
    for (const window of scene.insertedScenes ?? []) {
      if (window.toMs <= fromMs || window.fromMs >= toMs) continue;
      if (window.toMs <= spokenMs) fromMs = window.toMs;
      else toMs = Math.min(toMs, window.fromMs);
    }
    if (toMs > fromMs) spans.set(index, { fromMs, toMs });
  }

  const echoes = new Set<Piece>();
  for (const pieces of own.values()) {
    const longest = new Map<string, number>();
    for (const piece of pieces) if (piece.kind === "text") longest.set(piece.text, Math.max(longest.get(piece.text) ?? 0, piece.toMs - piece.fromMs));
    for (const piece of pieces) {
      const life = piece.toMs - piece.fromMs;
      if (piece.kind === "text" && life < FLASH_MS && (longest.get(piece.text) ?? 0) >= 3 * life) echoes.add(piece);
    }
  }

  const boxes: CaptionEmojiCueBox[] = [];
  for (const [at, cue] of cues.entries()) {
    const pieces = own.get(cue.index);
    const span = spans.get(cue.index);
    if (!pieces || !span) continue;
    const { fromMs } = span;
    const lastWord = cue.words[cue.words.length - 1];
    const lastWordMs = lastWord?.startMs ?? cue.startMs;
    // A stack keeps a cue on screen, dimmed, under the cues after it: its emoji belongs to it while it is spoken, and gives way
    // when the next cue starts to paint (never before its own last word has read for a moment). Not `SceneCue.endMs`: a queue
    // (Flap) paints a fast cue only after the one before it has flipped away, past the next cue's start.
    const nextPaint = spans.get(cues[at + 1]?.index ?? -1)?.fromMs ?? Number.POSITIVE_INFINITY;
    const toMs = Math.min(span.toMs, Math.max(nextPaint, lastWordMs + SCENE_CUE_MIN_LAST_WORD_MS));
    if (toMs <= fromMs) continue;
    const ownSolid = pieces.filter((piece) => !piece.bleed);
    // The sample time, moved earlier while nothing of the cue is drawn then (a card mid-flip, a word between fades).
    let sampleMs = Math.max(fromMs, Math.min(toMs - SAMPLE_BEFORE_END_MS, lastWordMs + SAMPLE_AFTER_LAST_WORD_MS));
    let box = sceneBoundsAt(ownSolid, sampleMs, measure);
    for (let earlier = sampleMs - SAMPLE_STEP_MS; !box && earlier >= fromMs; earlier -= SAMPLE_STEP_MS) {
      box = sceneBoundsAt(ownSolid, earlier, measure);
      if (box) sampleMs = earlier;
    }
    if (!box) {
      // Only bleed pieces (Ticker's hero runs across the frame): the stretch of the canvas they cross while the cue paints.
      const bled = sceneBoundsOver(pieces.map((piece) => ({ ...piece, bleed: false })), sampleTimes(fromMs, toMs), measure);
      box = bled ? cut(bled, canvas) : null;
    }
    if (!box) continue;
    const textBox = box;
    box = withPlate(box, sampleMs, cue.index, plateCandidates, measure);
    const tiltDeg = textTilt(ownSolid.length > 0 ? ownSolid : pieces, sampleMs);
    const row = lastRow(pieces, sampleMs, measure) ?? textBox;
    // Written on a plate, the row's reading end is the plate's edge.
    const endBox = box === textBox ? row : { x1: box.x1, y1: row.y1, x2: box.x2, y2: row.y2 };
    const mine = solid.get(cue.index) ?? [];
    const cache = new Map<number, readonly CaptionEmojiObstacle[]>();
    const obstacles = (atMs: number): readonly CaptionEmojiObstacle[] => {
      const found = cache.get(atMs);
      if (found) return found;
      const texts: Box[] = [];
      const flashes: Box[] = [];
      const shapes: Box[] = [];
      const add = (piece: Piece) => {
        const bounds = pieceBounds(piece, atMs, measure);
        if (!bounds) return;
        if (piece.kind === "shape") shapes.push(bounds);
        else (echoes.has(piece) ? flashes : texts).push(bounds);
      };
      for (const at of livePieceIndexes(mine, atMs)) add(mine[at]!);
      for (const at of livePieceIndexes(shared, atMs)) add(shared[at]!);
      for (const at of livePieceIndexes(everyCue, atMs)) {
        const piece = everyCue[at]!;
        if (cueOf(piece) !== cue.index && opacityAt(piece, atMs) >= (piece.kind === "text" ? OTHER_CUE_TEXT_OPACITY : OTHER_CUE_SHAPE_OPACITY)) add(piece);
      }
      // A shape with text written on it is a plate; any other shape (a ray, a streak, a spark) is a decoration, and a short
      // flash of text the cue draws far longer elsewhere is an echo: an emoji covers those only when no clean slot is left.
      const live: CaptionEmojiObstacle[] = [...texts, ...flashes.map((box) => ({ ...box, soft: true }))];
      const holds = (shape: Box) => texts.some((text) => {
        const x = (text.x1 + text.x2) / 2;
        const y = (text.y1 + text.y2) / 2;
        return x > shape.x1 && x < shape.x2 && y > shape.y1 && y < shape.y2;
      });
      const plates = shapes.filter(holds);
      for (const shape of shapes) {
        // A plate's own edge (Receipt's torn paper, a card's shadow) is part of the plate.
        const plate = plates.includes(shape) || plates.some((other) => overlaps(shape, other));
        live.push(plate ? shape : { ...shape, soft: true });
      }
      cache.set(atMs, live);
      return live;
    };
    boxes.push({ cueIndex: cue.index, box, endBox, fromMs, toMs, bodyPx: options.bodyPx, tiltDeg, direction: options.direction(cue), obstacles });
  }
  return boxes;
}

/**
 * The cue's last row of text at `ms`, where a `beside-end` emoji sits: the text pieces whose middle
 * is within half a text height of the lowest one's.
 */
function lastRow(pieces: readonly Piece[], ms: number, measure: Measure): Box | null {
  const texts = pieces.flatMap((piece) => {
    if (piece.kind !== "text" || opacityAt(piece, ms) < OTHER_CUE_TEXT_OPACITY) return [];
    const box = pieceBounds(piece, ms, measure);
    return box ? [box] : [];
  });
  if (texts.length === 0) return null;
  const middle = (box: Box) => (box.y1 + box.y2) / 2;
  const lowest = texts.reduce((low, box) => (middle(box) > middle(low) ? box : low));
  const reach = (lowest.y2 - lowest.y1) / 2;
  return unionBox(texts.filter((box) => middle(lowest) - middle(box) <= reach));
}

/** How much of the cue's box a piece of another cue (or of none) must cover to count as the plate the cue is written on. */
const PLATE_COVER = 0.9;

/**
 * The cue's box grown by the plate it is written on when that plate belongs to another cue or to
 * none: Index writes every cue on cue 0's card, Receipt on cue 0's paper. The emoji then sits off
 * the plate, not on it next to the words.
 */
function withPlate(box: Box, ms: number, cueIndex: number, pieces: readonly Piece[], measure: Measure): Box {
  const area = (box.x2 - box.x1) * (box.y2 - box.y1);
  if (area <= 0) return box;
  let grown = box;
  for (const at of livePieceIndexes(pieces, ms)) {
    const piece = pieces[at]!;
    if (piece.kind !== "shape" || !piece.fill || cueOf(piece) === cueIndex || opacityAt(piece, ms) < OTHER_CUE_SHAPE_OPACITY) continue;
    const plate = pieceBounds(piece, ms, measure);
    if (!plate) continue;
    const w = Math.min(plate.x2, box.x2) - Math.max(plate.x1, box.x1);
    const h = Math.min(plate.y2, box.y2) - Math.max(plate.y1, box.y1);
    if (w <= 0 || h <= 0 || (w * h) / area < PLATE_COVER) continue;
    grown = unionBox([grown, plate])!;
  }
  return grown;
}

const overlaps = (a: Box, b: Box) => a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;

function sampleTimes(fromMs: number, toMs: number): number[] {
  const times: number[] = [];
  for (let t = fromMs; t < toMs; t += SAMPLE_STEP_MS) times.push(t);
  return times;
}

function cut(box: Box, canvas: { readonly width: number; readonly height: number }): Box | null {
  const out = { x1: Math.max(0, box.x1), y1: Math.max(0, box.y1), x2: Math.min(canvas.width, box.x2), y2: Math.min(canvas.height, box.y2) };
  return out.x2 > out.x1 && out.y2 > out.y1 ? out : null;
}

/** The cue's own tilt: the median Z turn of its text pieces at `ms`, 0 when it has none. */
function textTilt(pieces: readonly Piece[], ms: number): number {
  const turns = pieces.filter((piece) => piece.kind === "text" && ms >= piece.fromMs && ms < piece.toMs).map((piece) => (piece.track.rz ? kf(ms, piece.track.rz) : 0)).sort((a, b) => a - b);
  if (turns.length === 0) return 0;
  return turns[Math.floor(turns.length / 2)]!;
}

/**
 * The cue boxes of a built Scene Style, as both renderers read them: from the cues and measurement
 * the scene was built with, the body size the style's `bodyPx` times the input's size scale, each
 * cue's direction from its words and language.
 */
export function captionSceneEmojiCueBoxes(
  scene: CaptionScene,
  input: { readonly preset: Pick<CaptionPreset, "scene">; readonly cues: readonly SceneCue[]; readonly canvas: { readonly width: number; readonly height: number }; readonly scale: number },
  measure: Measure,
): CaptionEmojiCueBox[] {
  if (!input.preset.scene) return [];
  return sceneCueBoxes(scene, input.cues, {
    measure,
    canvas: input.canvas,
    bodyPx: captionSceneMeta(input.preset.scene).bodyPx * input.scale,
    direction: (cue) => captionEmojiCueDirection(cue.words, cue.language),
  });
}

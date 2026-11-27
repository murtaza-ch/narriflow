import type { CaptionEmojiArt } from "@narriflow/caption-emoji/art";
import { type CaptionSceneName, captionEmojiPalette, captionEmojiTemplateColours, captionSceneEmojiSlot, captionSceneMeta, getCaptionPresetById } from "@narriflow/validators";
import { kf } from "../ease";
import { exportFrameTimes } from "../frame-grid";
import type { SceneCue } from "../input";
import { livePieceIndexes } from "../piece-index";
import { buildCaptionScene, sceneInputFromPreset } from "../registry";
import { type Box, type CaptionScene, type Measure, type Piece, type ShapePiece, type TextPiece, pieceBounds } from "../scene";
import type { CaptionEmojiCueBox } from "./cue-box";
import { type CaptionEmojiLayerStyle, type CaptionEmojiOutcome, placeCaptionEmojis } from "./layer";
import { CAPTION_EMOJI_MAX_GAP, CAPTION_EMOJI_POP_FALLBACK_GAP, safeArea } from "./placement";
import { CAPTION_EMOJI_POP_MS } from "./timing";
import { sceneCueBoxes } from "./scene-cue-boxes";

/**
 * The placement run the emoji tests and the contact sheets share: a Scene Style built over cues,
 * one emoji on every cue (its hero, else its middle word), placed by the emoji layer, then checked
 * independently of the placement code.
 */

const RTL_LANGUAGES = new Set(["ar", "ur", "fa", "he"]);

export const PLACEMENT_EMOJI_IDS = ["flame", "heart-eyes", "rocket", "party", "hundred", "bulb", "money-bag", "thumbs-up", "sparkles", "brain", "clapping-hands", "star-struck", "laugh-tears", "crown"] as const;

export interface PlacementRun {
  readonly pieces: readonly Piece[];
  readonly cueBoxes: readonly CaptionEmojiCueBox[];
  readonly outcomes: readonly CaptionEmojiOutcome[];
  /**
   * Emoji pieces whose drawn box meets a live word face, or leaves the safe area; and emojis further than
   * `CAPTION_EMOJI_MAX_GAP` of their height from the nearest text of their cue that reads on their first painted frame (and
   * not placed by the fallback, see `fallbacks`).
   */
  readonly problems: readonly string[];
  /** Each placed emoji's gap to that text, as a fraction of its height. */
  readonly gaps: readonly number[];
  /**
   * Emojis placed by the fallback (`CAPTION_EMOJI_POP_FALLBACK_GAP`): over `CAPTION_EMOJI_MAX_GAP` from the text on their
   * first frame, within it of the text that reads by the end of their pop. Further than either is a problem.
   */
  readonly fallbacks: number;
}

/** What an emoji piece draws, without the corner moves that size its shared box. */
export function emojiInkBounds(piece: ShapePiece, ms: number, measure: Measure): Box | null {
  return pieceBounds({ ...piece, path: piece.path.slice(2) }, ms, measure);
}

const meets = (a: Box, b: Box) => a.x1 + 0.5 < b.x2 && b.x1 + 0.5 < a.x2 && a.y1 + 0.5 < b.y2 && b.y1 + 0.5 < a.y2;

/**
 * How far past `CAPTION_EMOJI_MAX_GAP` a measured gap may be: placement keeps the gap from the emoji's turned ink box,
 * which holds its drawn paths a little loosely, so the drawn ink can sit up to a few hundredths of its height further.
 */
const GAP_TOLERANCE = 0.03;

/**
 * A Scene Style built over cues with what its emoji layer is given besides the emojis: its cue boxes, the anchor's height,
 * and the style at a Size choice (`size`, 1 by default).
 */
export function placementScene(input: {
  readonly name: CaptionSceneName;
  /** The caption's height, percent of the frame (the preset's `positionY`); the style's own by default. */
  readonly positionY?: number;
  readonly cues: readonly SceneCue[];
  readonly canvas: { readonly width: number; readonly height: number };
  readonly measure: Measure;
  readonly fps?: number;
}): { readonly scene: CaptionScene; readonly cueBoxes: readonly CaptionEmojiCueBox[]; readonly anchorYPct: number; readonly style: (size?: number, sticker?: boolean) => CaptionEmojiLayerStyle } {
  const { name, cues, canvas, measure } = input;
  const named = getCaptionPresetById(name)!.preset;
  const preset = input.positionY === undefined ? named : { ...named, positionY: input.positionY };
  const sceneInput = sceneInputFromPreset(preset, { cues, canvas, measure, fps: input.fps ?? 30 });
  const scene = buildCaptionScene(name, sceneInput);
  const cueBoxes = sceneCueBoxes(scene, cues, {
    measure,
    canvas,
    bodyPx: captionSceneMeta(name).bodyPx * sceneInput.scale,
    direction: (cue) => (RTL_LANGUAGES.has(cue.language ?? "") ? "rtl" : "ltr"),
  });
  const colours = captionEmojiTemplateColours(preset);
  const style = (size = 1, sticker = true): CaptionEmojiLayerStyle => ({ palette: captionEmojiPalette(colours), size, position: "auto", sticker, shadowColour: colours.shadow, slot: captionSceneEmojiSlot(name) });
  return { scene, cueBoxes, anchorYPct: sceneInput.anchor.yPct, style };
}

export function placementRun(input: {
  readonly name: CaptionSceneName;
  /** The caption's height, percent of the frame (the preset's `positionY`); the style's own by default. */
  readonly positionY?: number;
  readonly cues: readonly SceneCue[];
  readonly canvas: { readonly width: number; readonly height: number };
  readonly measure: Measure;
  readonly art: ReadonlyMap<string, CaptionEmojiArt>;
  readonly fps?: number;
  readonly sticker?: boolean;
  /** The emojis given to the cues in turn; `PLACEMENT_EMOJI_IDS` by default. */
  readonly emojis?: readonly { readonly id: string; readonly tone?: number }[];
  /**
   * Each cue's emoji on a word of its own choosing, or null for none (a contact sheet's hand map of emojis that fit
   * their words); replaces `emojis` and the hero-or-middle anchor.
   */
  readonly emojiFor?: (cue: SceneCue) => { readonly id: string; readonly tone?: number; readonly atMs: number } | null;
}): PlacementRun {
  const { cues, canvas, measure } = input;
  const fps = input.fps ?? 30;
  const { scene, cueBoxes, anchorYPct, style } = placementScene(input);
  const emojis = cues.flatMap((cue, at) => {
    if (input.emojiFor) {
      const chosen = input.emojiFor(cue);
      return chosen ? [{ cueIndex: cue.index, ...chosen }] : [];
    }
    const word = cue.words.find((candidate) => candidate.role === "hero") ?? cue.words[Math.floor((cue.words.length - 1) / 2)]!;
    const pick = input.emojis ? input.emojis[at % input.emojis.length]! : { id: PLACEMENT_EMOJI_IDS[at % PLACEMENT_EMOJI_IDS.length]! };
    return [{ cueIndex: cue.index, ...pick, atMs: word.startMs }];
  });
  const outcomes = placeCaptionEmojis({ cueBoxes, emojis, art: input.art, style: style(1, input.sticker ?? true), canvas, anchorYPct, fps });
  const problems: string[] = [];
  const gaps: number[] = [];
  let fallbacks = 0;
  const safe = safeArea(canvas);
  // Word faces: text of a cue, less echoes (a flash under 150 ms of text the cue draws at least three times as long), and text
  // that belongs to no cue (Index's dial labels, Chronicle's timeline).
  const cueOf = (piece: Piece) => (/^\d+$/.test(piece.id.split(":")[1] ?? "") ? piece.id.split(":")[1]! : null);
  const texts = scene.pieces.filter((piece): piece is TextPiece => piece.kind === "text");
  const life = (piece: Piece) => piece.toMs - piece.fromMs;
  const faces = texts.filter((piece) => {
    const cue = cueOf(piece);
    return cue === null || life(piece) >= 150 || !texts.some((other) => cueOf(other) === cue && other.text === piece.text && life(other) >= 3 * life(piece));
  });
  const opacity = (piece: Piece, t: number) => (piece.track.o ? kf(t, piece.track.o) : 1);
  for (const outcome of outcomes) {
    if (!outcome.placed) continue;
    const piece = outcome.pieces[0]!;
    // Closeness: the emoji at rest, after its pop, against its cue's text that reads on the emoji's first painted frame
    // (bleed text cut to the canvas; the first frame of its pop that shows some when none reads yet) and any plate that text
    // is written on (a shape of any cue, or none, holding a text's centre).
    const cueId = String(outcome.emoji.cueIndex);
    const shown: Box[] = [];
    const overPop: Box[] = [];
    for (const t of exportFrameTimes(piece.fromMs, piece.fromMs + CAPTION_EMOJI_POP_MS, fps)) {
      const live = scene.pieces.filter((each) => t >= each.fromMs && t < each.toMs);
      const words = live.flatMap((each) => {
        if (each.kind !== "text" || cueOf(each) !== cueId || opacity(each, t) < 0.1) return [];
        const box = pieceBounds(each, t, measure);
        return box ? [{ x1: Math.max(0, box.x1), y1: Math.max(0, box.y1), x2: Math.min(canvas.width, box.x2), y2: Math.min(canvas.height, box.y2) }] : [];
      });
      const plates = live.flatMap((each) => {
        if (each.kind !== "shape" || each.bleed || opacity(each, t) < 0.5) return [];
        const box = pieceBounds(each, t, measure);
        const holds = (word: Box) => (word.x1 + word.x2) / 2 > box!.x1 && (word.x1 + word.x2) / 2 < box!.x2 && (word.y1 + word.y2) / 2 > box!.y1 && (word.y1 + word.y2) / 2 < box!.y2;
        return box && words.some(holds) ? [box] : [];
      });
      if (shown.length === 0) shown.push(...words, ...plates);
      overPop.push(...words, ...plates);
    }
    const restMs = Math.min(piece.fromMs + CAPTION_EMOJI_POP_MS, piece.toMs - 1);
    const rest = outcome.pieces.flatMap((part) => emojiInkBounds(part, restMs, measure) ?? []);
    if (shown.length > 0 && rest.length > 0) {
      const ink = { x1: Math.min(...rest.map((b) => b.x1)), y1: Math.min(...rest.map((b) => b.y1)), x2: Math.max(...rest.map((b) => b.x2)), y2: Math.max(...rest.map((b) => b.y2)) };
      const height = ink.y2 - ink.y1;
      const gapTo = (boxes: readonly Box[]) => Math.min(...boxes.map((box) => Math.hypot(Math.max(0, box.x1 - ink.x2, ink.x1 - box.x2), Math.max(0, box.y1 - ink.y2, ink.y1 - box.y2)))) / height;
      const gap = gapTo(shown);
      gaps.push(gap);
      if (gap > CAPTION_EMOJI_MAX_GAP + GAP_TOLERANCE) {
        if (gap <= CAPTION_EMOJI_POP_FALLBACK_GAP + GAP_TOLERANCE && gapTo(overPop) <= CAPTION_EMOJI_MAX_GAP + GAP_TOLERANCE) fallbacks += 1;
        else problems.push(`${piece.id} is ${gap.toFixed(2)} of its height from its cue's text at ${piece.fromMs}`);
      }
    }
    for (const t of exportFrameTimes(piece.fromMs, piece.toMs, fps)) {
      for (const part of outcome.pieces) {
        const ink = emojiInkBounds(part, t, measure);
        if (!ink) continue;
        if (ink.x1 < safe.x1 - 0.5 || ink.y1 < safe.y1 - 0.5 || ink.x2 > safe.x2 + 0.5 || ink.y2 > safe.y2 + 0.5) problems.push(`${part.id} leaves the safe area at ${t}`);
        for (const at of livePieceIndexes(faces, t)) {
          const face = faces[at]!;
          // Text at 0.1 or more reads (Lyrics dims its neighbour lines to 0.15 and keeps them).
          if (face.track.o && kf(t, face.track.o) < 0.1) continue;
          const box = pieceBounds(face, t, measure);
          if (box && meets(ink, box)) problems.push(`${part.id} meets ${face.id} at ${t}`);
        }
      }
    }
  }
  return { pieces: scene.pieces, cueBoxes, outcomes, problems, gaps, fallbacks };
}

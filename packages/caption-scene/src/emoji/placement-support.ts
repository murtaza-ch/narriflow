import type { CaptionEmojiArt } from "@narriflow/caption-emoji/art";
import { type CaptionSceneName, captionEmojiPalette, captionEmojiTemplateColours, captionSceneEmojiSlot, captionSceneMeta, getCaptionPresetById } from "@narriflow/validators";
import { kf } from "../ease";
import { exportFrameTimes } from "../frame-grid";
import type { SceneCue } from "../input";
import { livePieceIndexes } from "../piece-index";
import { buildCaptionScene, sceneInputFromPreset } from "../registry";
import { type Box, type Measure, type Piece, type ShapePiece, type TextPiece, pieceBounds } from "../scene";
import type { CaptionEmojiCueBox } from "./cue-box";
import { type CaptionEmojiOutcome, placeCaptionEmojis } from "./layer";
import { safeArea } from "./placement";
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
  /** Emoji pieces whose drawn box meets a live word face, or leaves the safe area. */
  readonly problems: readonly string[];
}

/** What an emoji piece draws, without the corner moves that size its shared box. */
export function emojiInkBounds(piece: ShapePiece, ms: number, measure: Measure): Box | null {
  return pieceBounds({ ...piece, path: piece.path.slice(2) }, ms, measure);
}

const meets = (a: Box, b: Box) => a.x1 + 0.5 < b.x2 && b.x1 + 0.5 < a.x2 && a.y1 + 0.5 < b.y2 && b.y1 + 0.5 < a.y2;

export function placementRun(input: {
  readonly name: CaptionSceneName;
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
  const { name, cues, canvas, measure } = input;
  const preset = getCaptionPresetById(name)!.preset;
  const fps = input.fps ?? 30;
  const sceneInput = sceneInputFromPreset(preset, { cues, canvas, measure, fps });
  const scene = buildCaptionScene(name, sceneInput);
  const cueBoxes = sceneCueBoxes(scene, cues, {
    measure,
    canvas,
    bodyPx: captionSceneMeta(name).bodyPx * sceneInput.scale,
    direction: (cue) => (RTL_LANGUAGES.has(cue.language ?? "") ? "rtl" : "ltr"),
  });
  const emojis = cues.flatMap((cue, at) => {
    if (input.emojiFor) {
      const chosen = input.emojiFor(cue);
      return chosen ? [{ cueIndex: cue.index, ...chosen }] : [];
    }
    const word = cue.words.find((candidate) => candidate.role === "hero") ?? cue.words[Math.floor((cue.words.length - 1) / 2)]!;
    const pick = input.emojis ? input.emojis[at % input.emojis.length]! : { id: PLACEMENT_EMOJI_IDS[at % PLACEMENT_EMOJI_IDS.length]! };
    return [{ cueIndex: cue.index, ...pick, atMs: word.startMs }];
  });
  const colours = captionEmojiTemplateColours(preset);
  const outcomes = placeCaptionEmojis({
    cueBoxes,
    emojis,
    art: input.art,
    style: { palette: captionEmojiPalette(colours), size: 1, position: "auto", sticker: input.sticker ?? true, shadowColour: colours.shadow, slot: captionSceneEmojiSlot(name) },
    canvas,
    anchorYPct: sceneInput.anchor.yPct,
    fps,
  });
  const problems: string[] = [];
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
  for (const outcome of outcomes) {
    if (!outcome.placed) continue;
    const piece = outcome.pieces[0]!;
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
  return { pieces: scene.pieces, cueBoxes, outcomes, problems };
}

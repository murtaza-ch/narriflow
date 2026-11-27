import { captionWordLineBoxEm } from "@narriflow/caption-fonts/fallback-line-boxes";
import { type CaptionEmojiCueBox, captionBlockCueBox, classicLineCueBox } from "@narriflow/caption-scene";
import type { CompositionCaptionVisualLayer } from "@narriflow/composition-plan";
import { CAPTION_FIT_WIDTH_FRACTION, hasSpaceBefore } from "@narriflow/validators";
import { type CaptionOwnScript, captionFaceDraws } from "@/app/caption-script-fonts";
import type { CaptionBlockPaint } from "../caption-block-painter";

/**
 * The Studio's measurements for the cue boxes of the two one-cue caption paths. The boxes themselves
 * are the shared definitions the export uses (`classicLineCueBox`, `captionBlockCueBox`).
 */

type CueLayer = Pick<CompositionCaptionVisualLayer, "cueIndex" | "anchor" | "activeRange" | "preset" | "words" | "language" | "destination">;

/** A classic line's advance width as the browser laid it out: offset width, display px, before the line's fit and tilt. */
export interface ClassicLineSize {
  readonly width: number;
  /** Display px per canvas px the line was laid out at. */
  readonly scale: number;
}

/** The face that draws a classic line's letters: its Win metrics, and the scripts it covers besides Latin. */
export interface ClassicLineFace {
  readonly ascent: number;
  readonly descent: number;
  readonly ownScripts?: readonly CaptionOwnScript[];
}

/**
 * A classic line's line box, em, as libass lays it out: the tallest ascent and deepest descent among
 * the faces that draw its words, and the requested face when the line has a space. The faces are
 * chosen as the burn-in's glyph planner chooses them (`captionWordLineBoxEm`). Not the browser's
 * `line-height: normal` box: the script faces carry their own hhea metrics there (Noto Nastaliq Urdu
 * is about 0.8 em shorter than its Win box).
 */
export function classicLineBoxEm(words: readonly { readonly text: string; readonly spaceBefore?: boolean }[], face: ClassicLineFace, language: string | null): number {
  const requested = { ascentEm: face.ascent, descentEm: face.descent };
  const draws = (cluster: string) => captionFaceDraws(cluster, face.ownScripts ?? []);
  let ascentEm = 0;
  let descentEm = 0;
  words.forEach((word, index) => {
    const spaced = index > 0 && hasSpaceBefore(words[index - 1]!.text, { word: word.text, ...(word.spaceBefore === undefined ? {} : { spaceBefore: word.spaceBefore }) });
    for (const box of spaced ? [requested, captionWordLineBoxEm(word.text, requested, language, draws)] : [captionWordLineBoxEm(word.text, requested, language, draws)]) {
      ascentEm = Math.max(ascentEm, box.ascentEm);
      descentEm = Math.max(descentEm, box.descentEm);
    }
  });
  return words.length === 0 ? face.ascent + face.descent : ascentEm + descentEm;
}

/**
 * A classic line's box: the advance width the browser laid out (divided by the display scale and
 * the preset's size into em), the line box of the faces that draw it, and the overlay's fit
 * (`CaptionCue`'s, which is the burn-in's).
 */
export function classicLineEmojiCueBox(layer: CueLayer, line: ClassicLineSize, face: ClassicLineFace): CaptionEmojiCueBox | null {
  if (line.scale <= 0 || line.width <= 0) return null;
  const { preset } = layer;
  const canvas = { width: layer.destination.width, height: layer.destination.height };
  const stroke = preset.outlineWidth + (preset.outerOutlineWidth ?? 0);
  const naturalWidth = line.width / line.scale;
  const fit = Math.min(1, (CAPTION_FIT_WIDTH_FRACTION * canvas.width) / (naturalWidth + 2 * stroke));
  return classicLineCueBox(layer, { widthEm: naturalWidth / preset.fontSize, heightEm: classicLineBoxEm(layer.words, face, layer.language), px: preset.fontSize * fit }, canvas);
}

/** A Dynamic Style cue's box from the block layout its painter drew. */
export function blockEmojiCueBox(paint: CaptionBlockPaint, cueIndex: number): CaptionEmojiCueBox | null {
  return captionBlockCueBox({ ...paint.cue, cueIndex }, paint.layout, paint.words.map((word) => word.measured));
}

/**
 * A one-cue source key: the box, its timing and, for a Caption Block, what reads when (`shownParts`: each word's onset
 * decides the text an emoji is kept close to) are the whole of what the layer reads of the cue.
 */
export function oneCueSourceKey(box: CaptionEmojiCueBox): string {
  const shown = box.shownParts?.map((part) => [part.box.x1, part.box.y1, part.box.x2, part.box.y2, part.fromMs]) ?? null;
  return JSON.stringify(["cue", box.cueIndex, box.box.x1, box.box.y1, box.box.x2, box.box.y2, box.fromMs, box.toMs, box.bodyPx, box.tiltDeg, box.direction, shown]);
}

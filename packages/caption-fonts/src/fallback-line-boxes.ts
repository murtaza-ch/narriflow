import { captionGraphemes } from "./graphemes";
import { CAPTION_FALLBACK_LINE_BOXES } from "./fallback-line-boxes-data";
import { isCaptionIgnorableCodePoint } from "./glyph-coverage";
import { orderCaptionFallbackFaces } from "./locale-precedence";

/**
 * The line box of the face that draws a word, in the browser (spec 5.6, scale origin).
 *
 * libass anchors an `\an5` event, and scales it, about the middle of its line box: the tallest
 * Win ascent and deepest Win descent among the faces that draw the word. The worker reads them
 * off its glyph plan (apps/media/src/caption-block-geometry.ts). The Studio cannot ask a browser
 * which face drew a glyph, so this repeats the planner's choice from pinned data:
 *
 *   requested face -> script faces (the cue language's own first) -> symbols -> monochrome emoji
 *
 * A letter goes to the first face that has it: the requested face when it draws the cluster
 * (`requestedDraws`), else the first fallback face whose unicode-range holds it, the very
 * ranges the browser walks. A neutral cluster (space, punctuation, digit) stays in the face
 * before it when that face has it, as in the planner. Pure, no filesystem: it runs in the Studio.
 */

export interface CaptionFallbackLineBox {
  readonly file: string;
  readonly role: "script" | "symbols" | "monochrome-emoji";
  /** Win ascent and descent per em (`fontFileMetricsEm`). */
  readonly ascentEm: number;
  readonly descentEm: number;
  /** The face's `unicode-range` in apps/web/app/caption-script-fonts.css, inclusive. */
  readonly ranges: readonly (readonly [number, number])[];
  /** The spaces, punctuation and digits its cmap draws, inclusive. */
  readonly neutral: readonly (readonly [number, number])[];
  /** Draws a script the default face covers, in the style of these languages. */
  readonly languages?: readonly string[];
}

export interface CaptionLineBoxEm {
  readonly ascentEm: number;
  readonly descentEm: number;
}

const NEUTRAL = /^[\p{Z}\p{P}\p{N}]$/u;
/** Characters a Latin face draws: Latin, and the Common or Inherited punctuation, digits and marks it shares. */
const LATIN_FACE_CHARACTER = /^[\p{Script_Extensions=Latin}\p{Script_Extensions=Common}\p{Script_Extensions=Inherited}]$/u;
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;

const inRanges = (ranges: readonly (readonly [number, number])[], codePoint: number): boolean => ranges.some(([from, to]) => codePoint >= from && codePoint <= to);

const SCRIPT_BOXES = CAPTION_FALLBACK_LINE_BOXES.filter((box) => box.role === "script");
const SYMBOLS_BOX = CAPTION_FALLBACK_LINE_BOXES.find((box) => box.role === "symbols")!;
const EMOJI_BOX = CAPTION_FALLBACK_LINE_BOXES.find((box) => box.role === "monochrome-emoji")!;

/**
 * Line box of `text` drawn after `requested`, in em: the largest ascent and descent among the
 * faces that draw its clusters. A word the requested face draws whole gets `requested` back.
 * `requestedDraws(cluster)` says whether the requested face has a letter cluster (Latin, plus the
 * scripts the face covers); neutral clusters it has are judged here.
 */
export function captionWordLineBoxEm(
  text: string,
  requested: CaptionLineBoxEm,
  language: string | null | undefined,
  requestedDraws: (cluster: string) => boolean,
): CaptionLineBoxEm {
  let current: CaptionLineBoxEm & Partial<Pick<CaptionFallbackLineBox, "neutral">> = requested;
  let ascentEm = 0;
  let descentEm = 0;
  let drawn = false;
  const draw = (box: typeof current) => {
    current = box;
    ascentEm = Math.max(ascentEm, box.ascentEm);
    descentEm = Math.max(descentEm, box.descentEm);
    drawn = true;
  };
  for (const cluster of captionGraphemes(text)) {
    const mandatory = [...cluster].filter((character) => !isCaptionIgnorableCodePoint(character.codePointAt(0)!));
    if (mandatory.length === 0) continue;
    const neutral = mandatory.every((character) => NEUTRAL.test(character));
    const emoji = EMOJI_PRESENTATION.test(cluster) || cluster.includes("️") || cluster.includes("⃣");
    const has = (box: CaptionFallbackLineBox) => mandatory.every((character) => inRanges(box.ranges, character.codePointAt(0)!));
    if (!emoji && neutral && current !== requested && current.neutral && mandatory.every((character) => inRanges(current.neutral!, character.codePointAt(0)!))) {
      draw(current);
      continue;
    }
    const requestedHas = !emoji && (neutral ? mandatory.every((character) => LATIN_FACE_CHARACTER.test(character)) : requestedDraws(cluster));
    if (requestedHas) {
      draw(requested);
      continue;
    }
    const order = emoji ? [EMOJI_BOX, SYMBOLS_BOX] : [...orderCaptionFallbackFaces(SCRIPT_BOXES, language, cluster), SYMBOLS_BOX, EMOJI_BOX];
    const face = order.find(has);
    if (face) draw(face);
    // No face draws it: the planner leaves the code point out of the text, so it adds nothing.
  }
  return drawn ? { ascentEm, descentEm } : requested;
}

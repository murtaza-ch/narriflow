import { layoutCaptionLine } from "@narriflow/caption-fonts";
import { type CaptionBlockLayout, layoutCaptionBlock, type MeasuredWord } from "@narriflow/caption-fonts/caption-block";
import type { CompositionCaptionBlock, CompositionCaptionVisualLayer } from "@narriflow/composition-plan";
import {
  type CaptionFontFace,
  type CaptionRoleLook,
  captionDynamicStyle,
  captionRoleLook,
  languageDirection,
  textDirection,
} from "@narriflow/validators";
import type { CaptionFace, CaptionGlyphPlanner, PlannedCluster } from "./caption-glyphs";

/**
 * Caption Block measurement for the worker (spec 5.6, ADR 0020): every word
 * is shaped alone with HarfBuzz in its role's face and letter spacing, and
 * the shared `layoutCaptionBlock` turns those measurements into canvas
 * positions. caption-ass.ts paints each word where this says.
 */

/** A font slot of a Dynamic Style: the face its events name and the planner choosing fallback faces. */
export interface CaptionBlockSlot {
  readonly face: CaptionFontFace;
  readonly glyphs: CaptionGlyphPlanner;
}

/** One block word, measured alone, with what its events need. */
export interface CaptionBlockWord {
  /** Display text (`block.texts`), as drawn. */
  readonly text: string;
  readonly look: CaptionRoleLook;
  readonly slot: CaptionBlockSlot;
  readonly clusters: readonly PlannedCluster[];
  /** Faces drawing the word, in text order (one entry per run of the same face). */
  readonly parts: readonly { readonly text: string; readonly face: CaptionFace; readonly spaced: boolean }[];
  readonly measured: MeasuredWord;
  /** Middle of the box libass anchors an event holding only this word by, in em from its left edge (`layoutCaptionLine`). */
  readonly bboxCenterEm: number;
  /** Largest win ascent and descent among the word's faces: libass's line box for an event holding only this word. */
  readonly ascentEm: number;
  readonly descentEm: number;
}

export interface CaptionBlockGeometry {
  readonly layout: CaptionBlockLayout;
  readonly words: readonly CaptionBlockWord[];
}

/** Text libass would draw: braces and backslashes would open override blocks (caption-ass.ts strips them the same way). */
const assDrawnText = (text: string) => text.replace(/[{}\\]/g, "");

function wordParts(clusters: readonly PlannedCluster[]): CaptionBlockWord["parts"] {
  const parts: { text: string; face: CaptionFace; spaced: boolean }[] = [];
  for (const part of clusters.flatMap((cluster) => cluster.parts)) {
    const text = assDrawnText(part.text);
    const last = parts[parts.length - 1];
    if (last && last.face === part.face && last.spaced === part.spaced) last.text += text;
    else if (text) parts.push({ text, face: part.face, spaced: part.spaced });
  }
  return parts;
}

/**
 * Measures every word of a block cue and lays the block out. Throws
 * `CaptionShapingError` when HarfBuzz cannot shape one of the faces; the
 * caller then renders the cue as the classic line (typed degradation).
 */
export function measureCaptionBlock(input: {
  readonly cue: CompositionCaptionVisualLayer & { readonly block: CompositionCaptionBlock };
  readonly canvas: { readonly width: number; readonly height: number };
  readonly slots: Readonly<Record<"text" | "hero", CaptionBlockSlot>>;
}): CaptionBlockGeometry {
  const { cue, canvas, slots } = input;
  const { block, preset } = cue;
  const style = captionDynamicStyle(block.style);
  const words = block.texts.map((text, index): CaptionBlockWord => {
    const look = captionRoleLook(preset, style, block.roles[index]!, block.seed);
    const slot = slots[look.font];
    const clusters = slot.glyphs.plan(text);
    const parts = wordParts(clusters);
    const line = layoutCaptionLine(
      [{ parts: parts.map((part) => ({ text: part.text, fontPath: part.face.path, spaced: part.spaced, inked: true })), gap: null, gapExtraEm: 0 }],
      look.letterSpacing,
      textDirection(text, "ltr"),
    );
    // `layoutCaptionLine` counts libass's spacing after every cluster; the layout's advance excludes the trailing one.
    const trailing = parts[parts.length - 1]?.spaced ? look.letterSpacing : 0;
    const faces = parts.length > 0 ? parts.map((part) => part.face) : [slot.glyphs.requested];
    const ascentEm = Math.max(...faces.map((face) => face.ascentEm));
    const descentEm = Math.max(...faces.map((face) => face.descentEm));
    return {
      text,
      look,
      slot,
      clusters,
      parts,
      // The line box middle: libass anchors (and scales) an `\an5` event holding only this word there.
      measured: { advanceEm: line.widthEm - trailing, inkTopEm: line.inkTopEm, inkBottomEm: line.inkBottomEm, boxMiddleEm: (ascentEm - descentEm) / 2 },
      bboxCenterEm: line.bboxCenterEm,
      ascentEm,
      descentEm,
    };
  });
  const layout = layoutCaptionBlock({
    block,
    preset,
    style,
    words: cue.words,
    measured: words.map((word) => word.measured),
    canvas,
    anchor: cue.anchor,
    direction: textDirection(block.texts.join(" "), languageDirection(cue.language)),
    cueEndSec: cue.activeRange.endSec,
  });
  return { layout, words };
}

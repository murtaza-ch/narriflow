import { captionClusterOffsets, layoutCaptionLine } from "@narriflow/caption-fonts";
import {
  CAPTION_RTL_MARK,
  type CaptionBlockLayout,
  captionBlockCurve,
  captionBlockDirection,
  captionTextClusters,
  captionWordDirection,
  layoutCaptionBlock,
  type MeasuredWord,
} from "@narriflow/caption-fonts/caption-block";
import type { CompositionCaptionBlock, CompositionCaptionVisualLayer } from "@narriflow/composition-plan";
import {
  type CaptionFontFace,
  type CaptionRoleLook,
  captionDynamicStyle,
  captionRoleLook,
} from "@narriflow/validators";
import type { CaptionFace, CaptionGlyphPlanner, PlannedCluster, PlannedPart } from "./caption-glyphs";

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
  /** `captionWordDirection`: the direction the word is measured and drawn in. */
  readonly direction: "ltr" | "rtl";
  /** Planned clusters as the events draw them: an RTL word's start with `CAPTION_RTL_MARK`. */
  readonly clusters: readonly PlannedCluster[];
  /** Faces drawing the word (its mark included), in text order (one entry per run of the same face). */
  readonly parts: readonly { readonly text: string; readonly face: CaptionFace; readonly spaced: boolean }[];
  readonly measured: MeasuredWord;
  /** Middle of the box libass anchors an event holding only this word by, in em from its left edge (`layoutCaptionLine`). */
  readonly bboxCenterEm: number;
  /** Largest win ascent and descent among the word's faces: libass's line box for an event holding only this word. */
  readonly ascentEm: number;
  readonly descentEm: number;
  /** A curved word's glyph clusters (`captionTextClusters`), each drawn as its own events; null on straight rows. */
  readonly arcClusters: readonly CaptionBlockCluster[] | null;
}

/** One glyph cluster of a curved word: what its events draw and how libass anchors them. */
export interface CaptionBlockCluster {
  readonly text: string;
  /** The cluster's planned faces, cut from the word's plan, as one planned cluster for the event text. */
  readonly planned: PlannedCluster;
  /** Advance drawn alone, em, and the middle of the box libass anchors an event holding only it by, em from its left edge. */
  readonly advanceEm: number;
  readonly bboxCenterEm: number;
  /** Largest win ascent and descent among the cluster's faces: libass's line box for its events. */
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
 * A word's plan cut into its glyph clusters (`captionTextClusters`). A cluster never spans two
 * graphemes (a grapheme keeps its marks), so most clusters take one planned grapheme whole; a
 * grapheme holding several clusters (Hangul jamo) is cut at their offsets, or, when the planner
 * dropped part of it, goes whole to its first cluster.
 */
function plannedClusters(text: string, planned: readonly PlannedCluster[]): PlannedCluster[] {
  const texts = captionTextClusters(text);
  const parts: PlannedPart[][] = texts.map(() => []);
  const bounds: [number, number][] = [];
  let offset = 0;
  for (const cluster of texts) {
    bounds.push([offset, offset + cluster.length]);
    offset += cluster.length;
  }
  offset = 0;
  for (const grapheme of planned) {
    const start = offset;
    const end = offset + grapheme.text.length;
    offset = end;
    const inside = bounds.flatMap(([from, to], index) => (from < end && to > start ? [index] : []));
    if (inside.length === 0) continue;
    const whole = grapheme.parts.map((part) => part.text).join("") === grapheme.text;
    if (inside.length === 1 || !whole) {
      parts[inside[0]!]!.push(...grapheme.parts);
      continue;
    }
    for (const index of inside) {
      let at = start;
      for (const part of grapheme.parts) {
        const from = Math.max(bounds[index]![0], at);
        const to = Math.min(bounds[index]![1], at + part.text.length);
        if (from < to) parts[index]!.push({ ...part, text: part.text.slice(from - at, to - at) });
        at += part.text.length;
      }
    }
  }
  return texts.map((cluster, index) => ({ text: cluster, parts: parts[index]! }));
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
  const direction = captionBlockDirection(block.texts, cue.language);
  // Curved rows (spec 5.11): every word of the cue is also measured cluster by cluster.
  const curved = captionBlockCurve({ preset, style, texts: block.texts, language: cue.language }) !== 0;
  const words = block.texts.map((text, index): CaptionBlockWord => {
    const look = captionRoleLook(preset, style, block.roles[index]!, block.seed, text);
    const slot = slots[look.font];
    const planned = slot.glyphs.plan(text);
    // An RTL word's events start with U+200F, so libass orders neutral characters as the Studio
    // does (`captionWordDirection`). The mark is planned in a face that has it (one of the word's
    // own faces when it can be), and measured with the word, so the line box below includes it.
    const wordDirection = captionWordDirection(text, direction);
    const markFace = wordDirection === "rtl"
      ? slot.glyphs.markFace(CAPTION_RTL_MARK, wordParts(planned).map((part) => part.face))
      : null;
    const clusters: readonly PlannedCluster[] = markFace
      ? [{ text: CAPTION_RTL_MARK, parts: [{ text: CAPTION_RTL_MARK, face: markFace, spaced: false }] }, ...planned]
      : planned;
    const parts = wordParts(clusters);
    const line = layoutCaptionLine(
      [{ parts: parts.map((part) => ({ text: part.text, fontPath: part.face.path, spaced: part.spaced, inked: true })), gap: null, gapExtraEm: 0 }],
      look.letterSpacing,
      wordDirection,
    );
    // `layoutCaptionLine` counts libass's spacing after every cluster; the layout's advance excludes the trailing one.
    const trailing = parts[parts.length - 1]?.spaced ? look.letterSpacing : 0;
    const faces = parts.length > 0 ? parts.map((part) => part.face) : [slot.glyphs.requested];
    const ascentEm = Math.max(...faces.map((face) => face.ascentEm));
    const descentEm = Math.max(...faces.map((face) => face.descentEm));
    const arcClusters = curved ? curvedClusters(text, planned, look.letterSpacing, slot) : null;
    return {
      text,
      look,
      slot,
      direction: wordDirection,
      clusters,
      parts,
      // The line box middle: libass anchors (and scales) an `\an5` event holding only this word there.
      measured: {
        advanceEm: line.widthEm - trailing,
        inkTopEm: line.inkTopEm,
        inkBottomEm: line.inkBottomEm,
        boxMiddleEm: (ascentEm - descentEm) / 2,
        ...(arcClusters ? { clusters: arcClusters.map((cluster) => ({ startEm: cluster.startEm, advanceEm: cluster.advanceEm })) } : {}),
      },
      bboxCenterEm: line.bboxCenterEm,
      ascentEm,
      descentEm,
      arcClusters,
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
    direction,
    cueEndSec: cue.activeRange.endSec,
    language: cue.language,
  });
  return { layout, words };
}

/** A curved word's clusters, cut from its plan and placed with HarfBuzz (`captionClusterOffsets`). */
function curvedClusters(
  text: string,
  planned: readonly PlannedCluster[],
  letterSpacingEm: number,
  slot: CaptionBlockSlot,
): (CaptionBlockCluster & { readonly startEm: number })[] {
  const clusters = plannedClusters(text, planned);
  const lineParts = clusters.map((cluster) =>
    wordParts([cluster]).map((part) => ({ text: part.text, fontPath: part.face.path, spaced: part.spaced, inked: true })));
  const offsets = captionClusterOffsets(lineParts, letterSpacingEm);
  return clusters.map((cluster, index) => {
    const faces = wordParts([cluster]).map((part) => part.face);
    const drawn = faces.length > 0 ? faces : [slot.glyphs.requested];
    return {
      text: cluster.text,
      planned: cluster,
      startEm: offsets[index]!.startEm,
      advanceEm: offsets[index]!.advanceEm,
      bboxCenterEm: offsets[index]!.bboxCenterEm,
      ascentEm: Math.max(...drawn.map((face) => face.ascentEm)),
      descentEm: Math.max(...drawn.map((face) => face.descentEm)),
    };
  });
}

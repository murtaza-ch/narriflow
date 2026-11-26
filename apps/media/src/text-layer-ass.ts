import { layoutTextLayer, TEXT_LAYER_Z_BAND } from "@narriflow/caption-scene";
import type { ClipCompositionPlan, CompositionTextVisualLayer } from "@narriflow/composition-plan";
import { DEFAULT_CAPTION_PRESET, type FrameRate } from "@narriflow/validators";
import type { AssEvent } from "./ass-format";
import { assScript } from "./caption-ass";
import type { CaptionGlyphNotice } from "./caption-glyphs";
import { SceneMeasurer, sceneEvents } from "./caption-scene-ass";

/**
 * Text Layer burn-in (title-text spec section 5). Each layer of a target is laid out by the shared
 * builder (`layoutTextLayer`) from HarfBuzz measurement and written with the Scene Style writer into
 * one ASS script, burned by one `ass=` stage under the captions. The Studio paints the same pieces.
 */

/** A code point left out of a Text Layer because no pinned face draws it. */
export interface TextLayerOmittedGlyph {
  readonly layerId: string;
  readonly codePoint: string;
}

export interface TextLayerTrack {
  /** The script; empty when the target has no Text Layers. A script whose glyphs were all omitted is still a script. */
  readonly ass: string;
  readonly notices: CaptionGlyphNotice[];
  readonly omitted: TextLayerOmittedGlyph[];
}

/** The ASS script of a target's Text Layers, in document order (a later layer draws over an earlier one). */
export function renderTextLayerTrack(input: {
  readonly layers: readonly CompositionTextVisualLayer[];
  readonly canvas: { readonly width: number; readonly height: number };
  /** Code points to leave out (libass reported no glyph for them). */
  readonly omitCodePoints?: ReadonlySet<number>;
  /** The exact rate of the frames the `ass` filter sees: events start and end on them (default 30/1). */
  readonly frameRate?: FrameRate;
}): TextLayerTrack {
  if (input.layers.length === 0) return { ass: "", notices: [], omitted: [] };
  const forced = input.omitCodePoints ?? new Set<number>();
  const frameRate = input.frameRate ?? { numerator: 30, denominator: 1 };
  const events: AssEvent[] = [];
  const notices = new Map<string, CaptionGlyphNotice>();
  const omitted: TextLayerOmittedGlyph[] = [];
  input.layers.forEach((layer, index) => {
    // One measurer per layer, so an omitted code point is reported by the layer it was left out of.
    // A layer's paragraph direction comes from its own text (no caption language).
    const report = { notices, omitted: new Map<string, { codePoint: string; cueIndex: number }>() };
    const measurer = new SceneMeasurer(report, forced, null, true);
    // Whole microseconds: 0.7 s is 700.0000000000001 ms in floating point, which would miss the 700 ms frame,
    // while a start 0.4 ms after a frame must not be rounded back onto it.
    const ms = (sec: number) => Math.round(sec * 1_000_000) / 1000;
    const window = { fromMs: ms(layer.activeRange.startSec), toMs: ms(layer.activeRange.endSec) };
    const { pieces } = layoutTextLayer(layer.value, input.canvas, measurer.measure, window, index * TEXT_LAYER_Z_BAND);
    // z bands rise with the index, so appending keeps the script in paint order.
    events.push(...sceneEvents({ pieces }, measurer, { canvas: input.canvas, frameRate }));
    for (const glyph of report.omitted.values()) omitted.push({ layerId: layer.value.id, codePoint: glyph.codePoint });
  });
  return { ass: assScript(events, input.canvas, DEFAULT_CAPTION_PRESET), notices: [...notices.values()], omitted };
}

/** The Text Layer track of one plan target, on frames of `frameRate` (`compositionFrameRate`). */
export function compileCompositionPlanTextLayers(plan: ClipCompositionPlan, targetId: string, omitCodePoints?: ReadonlySet<number>, frameRate?: FrameRate): TextLayerTrack {
  const target = plan.targets.find((candidate) => candidate.id === targetId);
  if (!target) throw new Error("clip_composition_target_missing");
  return renderTextLayerTrack({
    layers: target.visualLayers.filter((layer): layer is CompositionTextVisualLayer => layer.kind === "text"),
    canvas: target.canvas,
    ...(omitCodePoints ? { omitCodePoints } : {}),
    ...(frameRate ? { frameRate } : {}),
  });
}

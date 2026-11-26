import { DEFAULT_TEXT_SHADOW, DEFAULT_TITLE_STYLE, type StudioTextLayer, TEXT_LAYER_STYLE_PRESETS, studioTextLayerSchema } from "@narriflow/validators";

/**
 * The fixed Text Layer samples the parity checks draw: the worker's contact sheet
 * (`apps/media/scripts/text-layer-sheet.ts`, the real export path) and the Studio's prototype page
 * (the real painter) draw these same layers, so the two can be laid side by side. Every layer lasts
 * the whole frame; each sample is drawn on its own frame at 1080 x 1920 and at 1920 x 1080.
 */
export interface TextLayerSample {
  readonly id: string;
  readonly label: string;
  readonly layers: readonly StudioTextLayer[];
}

const layer = (id: string, text: string, style: Partial<StudioTextLayer["style"]> = {}, place: Partial<Pick<StudioTextLayer, "positionX" | "positionY" | "widthPct" | "role">> = {}): StudioTextLayer =>
  studioTextLayerSchema.parse({ id, role: "title", text, positionY: 40, ...place, style: { ...DEFAULT_TITLE_STYLE, ...style } });

const sample = (id: string, label: string, ...layers: StudioTextLayer[]): TextLayerSample => ({ id, label, layers });

const TITLE = "How I grew my channel to 1M subscribers";

export const TEXT_LAYER_SAMPLES: readonly TextLayerSample[] = [
  ...TEXT_LAYER_STYLE_PRESETS.map((preset) => sample(`preset-${preset.id}`, preset.name, layer("title", TITLE, preset.style))),
  sample("box-line", "Line boxes", layer("title", TITLE, { background: { color: "#FFFFFF", opacity: 1, corners: "rounded", display: "line" } })),
  sample("box-block", "Block box", layer("title", TITLE, { background: { color: "#FFFFFF", opacity: 1, corners: "rounded", display: "block" } })),
  sample("line-boxes-translucent", "Line boxes, 60% black", layer("title", "A long first line here\nshort\nand a longer last line", { color: "#FFFFFF", background: { color: "#000000", opacity: 0.6, corners: "rounded", display: "line" } })),
  sample("block-translucent-shadow", "Block box 60% with shadow", layer("title", TITLE, { color: "#FFFFFF", shadow: DEFAULT_TEXT_SHADOW, background: { color: "#000000", opacity: 0.6, corners: "rounded", display: "block" } })),
  sample("corners-square", "Square corners", layer("title", TITLE, { background: { color: "#FFFFFF", opacity: 1, corners: "square", display: "line" } })),
  sample("align-left", "Align left", layer("title", TITLE, { align: "left" })),
  sample("align-center", "Align centre", layer("title", TITLE, { align: "center" })),
  sample("align-right", "Align right", layer("title", TITLE, { align: "right" })),
  sample("faux-bold", "Faux bold (Anton)", layer("title", TITLE, { font: "Anton", bold: true, background: null, color: "#FFFFFF", stroke: { color: "#000000", width: 4 } })),
  sample("shear-italic", "Shear italic (Inter)", layer("title", TITLE, { italic: true })),
  sample("real-italic", "Real italic (Inter Tight)", layer("title", TITLE, { font: "Inter Tight", italic: true })),
  sample("underline", "Underline", layer("title", TITLE, { underline: true, background: null, color: "#FFFFFF", stroke: { color: "#000000", width: 3 } })),
  sample("stroke-shadow", "Stroke and shadow", layer("title", TITLE, { background: null, color: "#FFFFFF", stroke: { color: "#000000", width: 5 }, shadow: DEFAULT_TEXT_SHADOW })),
  sample("three-lines", "Three lines", layer("title", "Three lines\nof a stacked\ntitle", {})),
  sample("overlong-word", "Overlong word", layer("title", "Supercalifragilisticexpialidocious words", { fontSize: 72 }, { widthPct: 60 })),
  sample("uppercase", "Uppercase", layer("title", TITLE, { textCase: "uppercase" })),
  sample("braces", "Braces and backslash", layer("title", "Literal {braces} and a back\\slash \\N", {})),
  sample("urdu-english", "Urdu and English", layer("title", "یہ ہے the best جواب for you", {})),
  sample("emoji", "Typed emoji", layer("title", "Big news 🎉 today 🔥", {})),
  sample(
    "overlap",
    "Two overlapping layers",
    layer("title", "First layer under", { background: { color: "#111111", opacity: 1, corners: "rounded", display: "line" }, color: "#FFFFFF" }, { positionY: 38 }),
    layer("body", "Second layer on top", {}, { positionY: 43, role: "body" }),
  ),
];

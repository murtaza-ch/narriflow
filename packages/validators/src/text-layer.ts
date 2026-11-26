import { z } from "zod";
import type { CaptionFontName } from "./caption-font";
import { brandFontReferenceSchema } from "./timed-edits";

/**
 * Text Layers (`studioEdits.textLayers`): a title or body text drawn over the clip for a stretch of
 * its edited timeline. A layer is a static Caption Scene (`layoutTextLayer` in
 * `@narriflow/caption-scene`), painted by the Studio and burned by the worker from the same pieces.
 *
 * Old stored layers must keep parsing (a clip whose document fails to parse is unreadable): both
 * schemas are plain objects that strip unknown keys, every field has a default, and no key of the
 * old flat shape (`fontName`, `fontSize`, `outlineWidth`, ...) is reused, so an old layer loads with
 * its text, timing and position in the default body style.
 */

const hexColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

/** Longest text a layer may hold. */
export const TEXT_LAYER_MAX_CHARS = 280;

/** Longest automatic title (cut at a word boundary, grapheme-safe). */
export const TITLE_TEXT_MAX_CHARS = 120;

/** A family's faces: the upright face it draws by default, and its heavier and italic faces when it has them. */
export interface TextLayerFontFamilyFaces {
  readonly regular: CaptionFontName;
  /** A heavier face than `regular`. Without one, bold is a fill-coloured outline. */
  readonly bold?: CaptionFontName;
  /** An italic face at `regular`'s weight. Without one, italic is a shear. */
  readonly italic?: CaptionFontName;
  /** An italic face at `bold`'s weight. */
  readonly boldItalic?: CaptionFontName;
}

/**
 * The fonts a Text Layer offers: families of the vendored caption faces (template-only faces
 * included), so the Studio and the export draw the same files. A family's `regular` is its
 * lightest vendored face, which for some families is already heavy (only those weights ship).
 */
export const TEXT_LAYER_FONTS = {
  Inter: { regular: "Inter Regular", bold: "Inter" },
  "Inter Tight": { regular: "Inter Tight Medium", italic: "Inter Tight Medium Italic", bold: "Inter Tight ExtraBold", boldItalic: "Inter Tight ExtraBold Italic" },
  Montserrat: { regular: "Montserrat ExtraBold", bold: "Montserrat" },
  Poppins: { regular: "Poppins" },
  Roboto: { regular: "Roboto" },
  "Open Sans": { regular: "Open Sans" },
  "DM Sans": { regular: "DM Sans Bold", bold: "DM Sans Black" },
  Manrope: { regular: "Manrope Bold", bold: "Manrope ExtraBold" },
  "Plus Jakarta Sans": { regular: "Plus Jakarta Sans Bold", bold: "Plus Jakarta Sans ExtraBold" },
  Rubik: { regular: "Rubik ExtraBold", bold: "Rubik Black" },
  "Space Grotesk": { regular: "Space Grotesk Bold" },
  "Archivo Expanded": { regular: "Archivo Expanded ExtraBold", italic: "Archivo Expanded ExtraBold Italic", bold: "Archivo Expanded Black", boldItalic: "Archivo Expanded Black Italic" },
  "Archivo Black": { regular: "Archivo Black" },
  Unbounded: { regular: "Unbounded Medium", bold: "Unbounded" },
  "Bricolage Grotesque": { regular: "Bricolage Grotesque" },
  Oswald: { regular: "Oswald" },
  "Barlow Condensed": { regular: "Barlow Condensed Medium", bold: "Barlow Condensed Bold" },
  Anton: { regular: "Anton" },
  "Bebas Neue": { regular: "Bebas Neue" },
  "Big Shoulders Display": { regular: "Big Shoulders Display Black" },
  Fredoka: { regular: "Fredoka SemiBold", bold: "Fredoka Bold" },
  "Lilita One": { regular: "Lilita One" },
  "Luckiest Guy": { regular: "Luckiest Guy" },
  "Titan One": { regular: "Titan One" },
  Righteous: { regular: "Righteous" },
  "Dela Gothic One": { regular: "Dela Gothic One" },
  "Chakra Petch": { regular: "Chakra Petch" },
  "Space Mono": { regular: "Space Mono Regular", bold: "Space Mono Bold" },
  "JetBrains Mono": { regular: "JetBrains Mono Medium", bold: "JetBrains Mono Bold" },
  "Courier Prime": { regular: "Courier Prime" },
  "DM Serif Display": { regular: "DM Serif Display", italic: "DM Serif Display Italic" },
  "Instrument Serif": { regular: "Instrument Serif Regular", italic: "Instrument Serif" },
  "Playfair Display": { regular: "Playfair Display Bold", italic: "Playfair Display Bold Italic" },
  Newsreader: { regular: "Newsreader Medium", bold: "Newsreader SemiBold", boldItalic: "Newsreader SemiBold Italic" },
  "Abril Fatface": { regular: "Abril Fatface" },
  "Alfa Slab One": { regular: "Alfa Slab One" },
  Caprasimo: { regular: "Caprasimo" },
  Shrikhand: { regular: "Shrikhand" },
  Lobster: { regular: "Lobster" },
  Pacifico: { regular: "Pacifico" },
  "Permanent Marker": { regular: "Permanent Marker" },
  "Caveat Brush": { regular: "Caveat Brush" },
} as const satisfies Record<string, TextLayerFontFamilyFaces>;

export type TextLayerFontFamily = keyof typeof TEXT_LAYER_FONTS;

export const TEXT_LAYER_FONT_FAMILIES = Object.keys(TEXT_LAYER_FONTS) as [TextLayerFontFamily, ...TextLayerFontFamily[]];

export const TEXT_LAYER_ROLES = ["title", "body"] as const;
export type TextLayerRole = (typeof TEXT_LAYER_ROLES)[number];

export const textLayerStrokeSchema = z.object({
  color: hexColorSchema,
  width: z.number().min(0.5).max(16),
});

export const textLayerShadowSchema = z.object({
  color: hexColorSchema,
  opacity: z.number().min(0).max(1),
  blur: z.number().min(0).max(40),
  offsetX: z.number().min(-60).max(60),
  offsetY: z.number().min(-60).max(60),
});

export const textLayerBackgroundSchema = z.object({
  color: hexColorSchema,
  opacity: z.number().min(0).max(1),
  corners: z.enum(["rounded", "square"]),
  /** `line`: one box hugging each line. `block`: one box around all lines. */
  display: z.enum(["line", "block"]),
});

/**
 * How a Text Layer looks. Sizes, stroke width, shadow blur and offsets are in units of
 * `min(canvasWidth, canvasHeight) / 1080`. Defaults are the body look: white, bold, black stroke.
 */
export const textLayerStyleSchema = z.object({
  font: z.enum(TEXT_LAYER_FONT_FAMILIES).default("Inter"),
  /** An uploaded brand font; wins over `font` when it can be resolved. */
  fontAsset: brandFontReferenceSchema.nullable().default(null),
  fontSize: z.number().min(8).max(240).default(48),
  bold: z.boolean().default(true),
  italic: z.boolean().default(false),
  underline: z.boolean().default(false),
  /** Drawn case; the typed text is never rewritten. */
  textCase: z.enum(["none", "uppercase"]).default("none"),
  align: z.enum(["left", "center", "right"]).default("center"),
  /** Line pitch as a multiple of `fontSize`. */
  lineHeight: z.number().min(0.8).max(2.5).default(1.2),
  color: hexColorSchema.default("#FFFFFF"),
  stroke: textLayerStrokeSchema.nullable().default(() => ({ color: "#000000", width: 3 })),
  shadow: textLayerShadowSchema.nullable().default(null),
  background: textLayerBackgroundSchema.nullable().default(null),
});

export type TextLayerStyle = z.infer<typeof textLayerStyleSchema>;
export type TextLayerStroke = z.infer<typeof textLayerStrokeSchema>;
export type TextLayerShadow = z.infer<typeof textLayerShadowSchema>;
export type TextLayerBackground = z.infer<typeof textLayerBackgroundSchema>;

/** What an effect is set to when it is switched on. */
export const DEFAULT_TEXT_STROKE: TextLayerStroke = { color: "#000000", width: 4 };
export const DEFAULT_TEXT_SHADOW: TextLayerShadow = { color: "#000000", opacity: 0.6, blur: 8, offsetX: 0, offsetY: 4 };
export const DEFAULT_TEXT_BACKGROUND: TextLayerBackground = { color: "#FFFFFF", opacity: 1, corners: "rounded", display: "line" };

/** The default title: bold black text on white rounded boxes, one per line. */
export const DEFAULT_TITLE_STYLE: TextLayerStyle = textLayerStyleSchema.parse({
  font: "Inter",
  fontSize: 48,
  bold: true,
  color: "#000000",
  stroke: null,
  shadow: null,
  background: DEFAULT_TEXT_BACKGROUND,
});

/** One of the Text panel's recommended styles. */
export interface TextLayerStylePreset {
  readonly id: string;
  readonly name: string;
  readonly style: TextLayerStyle;
}

const preset = (id: string, name: string, style: Partial<TextLayerStyle>): TextLayerStylePreset => ({ id, name, style: textLayerStyleSchema.parse(style) });

/** The six recommended styles of the Text panel's Presets tab. */
export const TEXT_LAYER_STYLE_PRESETS: readonly TextLayerStylePreset[] = [
  preset("white-on-black", "White on black", { font: "Inter", bold: true, color: "#FFFFFF", stroke: null, background: { color: "#000000", opacity: 1, corners: "rounded", display: "line" } }),
  preset("black-on-white", "Black on white", DEFAULT_TITLE_STYLE),
  preset("yellow-punch", "Yellow punch", { font: "Archivo Expanded", bold: true, italic: true, color: "#FFE135", stroke: { color: "#000000", width: 8 }, background: null }),
  preset("teal-on-cream", "Teal on cream", { font: "DM Sans", bold: true, color: "#0F766E", stroke: null, background: { color: "#FFF4D6", opacity: 1, corners: "square", display: "block" } }),
  preset("serif-italic", "Serif italic", { font: "Playfair Display", bold: true, italic: true, color: "#000000", stroke: null, background: null }),
  preset("blue-serif", "Blue serif", { font: "Playfair Display", bold: true, color: "#1D4ED8", stroke: { color: "#FFFFFF", width: 4 }, background: null }),
];

/** Degrees a shear italic leans to the right. */
const TEXT_LAYER_SHEAR_DEG = 12;

/**
 * The one place the bold and italic toggles become a face. Bold takes the family's heavier face
 * when it has one, else `fauxBold` (the layout draws a fill-coloured outline). Italic takes the
 * family's italic face at the resolved weight when it has one, else `shearDeg` (lean to the right).
 */
export function resolveTextLayerFace(style: Pick<TextLayerStyle, "font" | "bold" | "italic">): { face: CaptionFontName; fauxBold: boolean; shearDeg: number } {
  const family: TextLayerFontFamilyFaces = TEXT_LAYER_FONTS[style.font] ?? TEXT_LAYER_FONTS.Inter;
  const heavy = style.bold && family.bold !== undefined;
  const upright = heavy ? family.bold! : family.regular;
  const italic = style.italic ? (heavy ? family.boldItalic : family.italic) : undefined;
  return {
    face: italic ?? upright,
    fauxBold: style.bold && !heavy,
    shearDeg: style.italic && italic === undefined ? TEXT_LAYER_SHEAR_DEG : 0,
  };
}

/**
 * A Text Layer. `startSec`/`endSec` are edited-timeline seconds (start inclusive, end exclusive;
 * absent or null end = until the clip ends). `positionX`/`positionY` place the centre of the
 * layer's frame and `widthPct` is its wrap width, percentages of the canvas.
 */
export const studioTextLayerSchema = z
  .object({
    id: z.string().min(1).max(80),
    role: z.enum(TEXT_LAYER_ROLES).default("body"),
    text: z.string().trim().min(1).max(TEXT_LAYER_MAX_CHARS),
    startSec: z.number().min(0).default(0),
    endSec: z.number().min(0).nullable().optional(),
    positionX: z.number().min(0).max(100).default(50),
    positionY: z.number().min(0).max(100).default(12),
    widthPct: z.number().min(10).max(100).default(86),
    style: textLayerStyleSchema.prefault({}),
  })
  .refine(
    (layer) => layer.endSec == null || layer.endSec > layer.startSec,
    { message: "endSec must be greater than startSec" },
  );

export type StudioTextLayer = z.infer<typeof studioTextLayerSchema>;

/** The first title layer of a clip (the UI keeps one; the schema does not enforce it). */
export function findTitleLayer<T extends Pick<StudioTextLayer, "role">>(layers: readonly T[]): T | undefined {
  return layers.find((layer) => layer.role === "title");
}

/**
 * A brand template's title settings: whether new clips get their AI title drawn, for how long
 * (seconds from the start; null = the whole clip), where, and in which style.
 */
export const brandTitleSchema = z.object({
  enabled: z.boolean().default(true),
  durationSec: z.number().min(1).max(600).nullable().default(5),
  positionX: z.number().min(0).max(100).default(50),
  positionY: z.number().min(0).max(100).default(12),
  widthPct: z.number().min(10).max(100).default(86),
  /** A whole style; a partial stored style is filled from the default title style (not the body defaults). */
  style: z.preprocess((value) => (value === undefined ? DEFAULT_TITLE_STYLE : typeof value === "object" && value !== null ? { ...DEFAULT_TITLE_STYLE, ...value } : value), textLayerStyleSchema),
});

export type BrandTitle = z.infer<typeof brandTitleSchema>;

/** The built-in title settings: on, 5 seconds, the default title style. */
export const DEFAULT_BRAND_TITLE: BrandTitle = brandTitleSchema.parse({});

/** A template's title settings; null (none stored) is the built-in default. */
export function brandTitleOrDefault(title: BrandTitle | null | undefined): BrandTitle {
  return title ?? DEFAULT_BRAND_TITLE;
}

/** The Apply-to-all `title` patch: everything about a title but its words. */
export const textLayerTitlePatchSchema = z.strictObject({
  style: textLayerStyleSchema,
  positionX: z.number().min(0).max(100),
  positionY: z.number().min(0).max(100),
  widthPct: z.number().min(10).max(100),
  startSec: z.number().min(0),
  endSec: z.number().min(0).nullable(),
}).refine(
  (patch) => patch.endSec == null || patch.endSec > patch.startSec,
  { message: "endSec must be greater than startSec" },
);

export type TextLayerTitlePatch = z.infer<typeof textLayerTitlePatchSchema>;

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * `text` on one line, cut to at most `maxChars` UTF-16 units: at the last word boundary that fits,
 * else at the last whole grapheme that fits. Empty when the text is blank.
 */
export function cutTitleText(text: string, maxChars = TITLE_TEXT_MAX_CHARS): string {
  const line = text.replace(/\s+/gu, " ").trim();
  if (line.length <= maxChars) return line;
  let end = 0;
  for (const { segment, index } of graphemeSegmenter.segment(line)) {
    if (index + segment.length > maxChars) break;
    end = index + segment.length;
  }
  const head = line.slice(0, end);
  // The cut falls between words when the next character is a space; otherwise back off to the last space.
  if (line[end] === " ") return head.trimEnd();
  const space = head.lastIndexOf(" ");
  return (space > 0 ? head.slice(0, space) : head).trimEnd();
}

/**
 * A title layer for a clip: the words (the clip's title, else its hook text) cut to
 * `TITLE_TEXT_MAX_CHARS`, the title settings' placement and style, from 0 for `durationSec`
 * clamped to the clip's edited duration (null = until the clip ends). Null when there are no
 * usable words or the clip has no duration. `enabled` is the caller's decision.
 */
export function titleTextLayer(input: {
  readonly text: string | null | undefined;
  readonly settings: BrandTitle;
  readonly editedDurationSec: number;
  readonly id?: string;
}): StudioTextLayer | null {
  const text = cutTitleText(input.text ?? "");
  if (text.length === 0 || !(input.editedDurationSec > 0)) return null;
  const { settings } = input;
  return {
    id: input.id ?? "title",
    role: "title",
    text,
    startSec: 0,
    endSec: settings.durationSec === null ? null : Math.min(settings.durationSec, input.editedDurationSec),
    positionX: settings.positionX,
    positionY: settings.positionY,
    widthPct: settings.widthPct,
    style: settings.style,
  };
}

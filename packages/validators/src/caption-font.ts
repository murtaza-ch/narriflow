/**
 * The caption font catalog. Each entry is ONE static face vendored in
 * packages/caption-fonts/fonts. Studio preview loads the same file through
 * next/font/local and the worker hands the directory to libass, so a caption
 * renders with byte-identical glyphs in both places.
 *
 * `ascent` / `descent` are the face's OS/2 winAscent / winDescent divided by
 * unitsPerEm. libass sizes text so that ascent + descent equals the ASS font
 * size and centres lines on that box; the preview overrides the browser's
 * metrics to the same values (`ascent-override` / `descent-override`), so a
 * caption line box is the same height and has the same baseline in both
 * renderers. `capHeight` (the "H" glyph top, per em) anchors pills and plates
 * vertically. packages/caption-fonts verifies these numbers against the files.
 */
export interface CaptionFontFace {
  /** Picker label and the value stored in `CaptionPreset.fontName`. */
  readonly name: string;
  /** File name in packages/caption-fonts/fonts. */
  readonly file: string;
  /** Full font name (name table ID 4) that libass matches. */
  readonly assName: string;
  readonly weight: number;
  readonly style: "normal" | "italic";
  readonly ascent: number;
  readonly descent: number;
  readonly capHeight: number;
  /**
   * Drawn only by a Scene Style's template (ADR 0021), never offered as a classic caption font:
   * the Studio's font chips and the brand kit's font list leave it out. A preset that names it
   * still parses and renders (the Scene Style presets' own `fontName`s are such faces).
   */
  readonly templateOnly?: true;
}

export const CAPTION_FONT_FACES = [
  { name: "Anton", file: "Anton-Regular.ttf", assName: "Anton Regular", weight: 400, style: "normal", ascent: 1.4043, descent: 0.3291, capHeight: 0.8594 },
  { name: "Archivo Black", file: "ArchivoBlack-Regular.ttf", assName: "Archivo Black Regular", weight: 400, style: "normal", ascent: 1.035, descent: 0.312, capHeight: 0.688 },
  { name: "Bebas Neue", file: "BebasNeue-Regular.ttf", assName: "Bebas Neue Regular", weight: 400, style: "normal", ascent: 0.95, descent: 0.35, capHeight: 0.7 },
  { name: "Bricolage Grotesque", file: "BricolageGrotesque-ExtraBold.ttf", assName: "Bricolage Grotesque 96pt ExtraBold", weight: 800, style: "normal", ascent: 1.16, descent: 0.4, capHeight: 0.66 },
  { name: "Chakra Petch", file: "ChakraPetch-Bold.ttf", assName: "Chakra Petch Bold", weight: 700, style: "normal", ascent: 1.248, descent: 0.566, capHeight: 0.7 },
  { name: "Courier Prime", file: "CourierPrime-Bold.ttf", assName: "Courier Prime Bold", weight: 700, style: "normal", ascent: 0.9277, descent: 0.3906, capHeight: 0.5796 },
  { name: "Caprasimo", file: "Caprasimo-Regular.ttf", assName: "Caprasimo Regular", weight: 400, style: "normal", ascent: 0.918, descent: 0.229, capHeight: 0.6758 },
  { name: "Caveat Brush", file: "CaveatBrush-Regular.ttf", assName: "Caveat Brush", weight: 400, style: "normal", ascent: 0.96, descent: 0.3, capHeight: 0.6605, templateOnly: true },
  { name: "Dela Gothic One", file: "DelaGothicOne-Regular.ttf", assName: "Dela Gothic One Regular", weight: 400, style: "normal", ascent: 1.16, descent: 0.288, capHeight: 0.726 },
  { name: "DM Serif Display", file: "DMSerifDisplay-Regular.ttf", assName: "DM Serif Display Regular", weight: 400, style: "normal", ascent: 1.036, descent: 0.335, capHeight: 0.66 },
  { name: "Instrument Serif", file: "InstrumentSerif-Italic.ttf", assName: "Instrument Serif Italic", weight: 400, style: "italic", ascent: 0.99, descent: 0.31, capHeight: 0.72 },
  { name: "Inter", file: "Inter-ExtraBold.ttf", assName: "Inter 28pt ExtraBold", weight: 800, style: "normal", ascent: 1.1079, descent: 0.3223, capHeight: 0.7275 },
  { name: "Inter Regular", file: "Inter-Regular.ttf", assName: "Inter 28pt Regular", weight: 400, style: "normal", ascent: 1.1079, descent: 0.3223, capHeight: 0.7275 },
  { name: "Inter SemiBold", file: "Inter-SemiBold.ttf", assName: "Inter 28pt SemiBold", weight: 600, style: "normal", ascent: 1.1079, descent: 0.3223, capHeight: 0.7275 },
  { name: "Inter Tight SemiBold", file: "InterTight-SemiBold.ttf", assName: "Inter Tight SemiBold", weight: 600, style: "normal", ascent: 1.105, descent: 0.3193, capHeight: 0.7275, templateOnly: true },
  { name: "Inter Tight Bold", file: "InterTight-Bold.ttf", assName: "Inter Tight Bold", weight: 700, style: "normal", ascent: 1.105, descent: 0.3193, capHeight: 0.7275, templateOnly: true },
  { name: "Inter Tight ExtraBold", file: "InterTight-ExtraBold.ttf", assName: "Inter Tight ExtraBold", weight: 800, style: "normal", ascent: 1.105, descent: 0.3193, capHeight: 0.7275, templateOnly: true },
  { name: "JetBrains Mono Medium", file: "JetBrainsMono-Medium.ttf", assName: "JetBrains Mono Medium", weight: 500, style: "normal", ascent: 1.02, descent: 0.3, capHeight: 0.73, templateOnly: true },
  { name: "JetBrains Mono Bold", file: "JetBrainsMono-Bold.ttf", assName: "JetBrains Mono Bold", weight: 700, style: "normal", ascent: 1.02, descent: 0.3, capHeight: 0.73, templateOnly: true },
  { name: "Lilita One", file: "LilitaOne-Regular.ttf", assName: "Lilita One", weight: 400, style: "normal", ascent: 0.923, descent: 0.22, capHeight: 0.701 },
  { name: "Luckiest Guy", file: "LuckiestGuy-Regular.ttf", assName: "Luckiest Guy Regular", weight: 400, style: "normal", ascent: 0.9795, descent: 0.2461, capHeight: 0.7021 },
  { name: "Montserrat", file: "Montserrat-Black.ttf", assName: "Montserrat Black", weight: 900, style: "normal", ascent: 1.109, descent: 0.453, capHeight: 0.7 },
  { name: "Open Sans", file: "OpenSans-Bold.ttf", assName: "Open Sans Bold", weight: 700, style: "normal", ascent: 1.124, descent: 0.3179, capHeight: 0.7139 },
  { name: "Permanent Marker", file: "PermanentMarker-Regular.ttf", assName: "Permanent Marker Regular", weight: 400, style: "normal", ascent: 1.1094, descent: 0.3174, capHeight: 0.7402, templateOnly: true },
  { name: "Oswald", file: "Oswald-Bold.ttf", assName: "Oswald Bold", weight: 700, style: "normal", ascent: 1.325, descent: 0.377, capHeight: 0.81 },
  { name: "Poppins", file: "Poppins-ExtraBold.ttf", assName: "Poppins ExtraBold", weight: 800, style: "normal", ascent: 1.135, descent: 0.627, capHeight: 0.705 },
  { name: "Righteous", file: "Righteous-Regular.ttf", assName: "Righteous", weight: 400, style: "normal", ascent: 0.9849, descent: 0.2568, capHeight: 0.7002 },
  { name: "Roboto", file: "Roboto-Bold.ttf", assName: "Roboto Bold", weight: 700, style: "normal", ascent: 0.9502, descent: 0.25, capHeight: 0.7109 },
  { name: "Titan One", file: "TitanOne-Regular.ttf", assName: "Titan One", weight: 400, style: "normal", ascent: 0.97, descent: 0.175, capHeight: 0.71 },
  { name: "Unbounded", file: "Unbounded-ExtraBold.ttf", assName: "Unbounded ExtraBold", weight: 800, style: "normal", ascent: 1.262, descent: 0.286, capHeight: 0.75 },
  { name: "Unbounded Medium", file: "Unbounded-Medium.ttf", assName: "Unbounded Medium", weight: 500, style: "normal", ascent: 1.262, descent: 0.286, capHeight: 0.75, templateOnly: true },
  { name: "Unbounded Black", file: "Unbounded-Black.ttf", assName: "Unbounded Black", weight: 900, style: "normal", ascent: 1.262, descent: 0.286, capHeight: 0.75, templateOnly: true },
  { name: "Inter Tight Medium", file: "InterTight-Medium.ttf", assName: "Inter Tight Medium", weight: 500, style: "normal", ascent: 1.105, descent: 0.3193, capHeight: 0.7275, templateOnly: true },
  { name: "Inter Tight Regular", file: "InterTight-Regular.ttf", assName: "Inter Tight Regular", weight: 400, style: "normal", ascent: 1.105, descent: 0.3193, capHeight: 0.7275, templateOnly: true },
  { name: "Instrument Serif Regular", file: "InstrumentSerif-Regular.ttf", assName: "Instrument Serif Regular", weight: 400, style: "normal", ascent: 0.99, descent: 0.31, capHeight: 0.72, templateOnly: true },
  { name: "Archivo Expanded ExtraBold", file: "Archivo-ExpandedExtraBold.ttf", assName: "Archivo Expanded ExtraBold", weight: 800, style: "normal", ascent: 1.1, descent: 0.41, capHeight: 0.688, templateOnly: true },
  { name: "Archivo Expanded ExtraBold Italic", file: "Archivo-ExpandedExtraBoldItalic.ttf", assName: "Archivo Expanded ExtraBold Italic", weight: 800, style: "italic", ascent: 1.1, descent: 0.41, capHeight: 0.688, templateOnly: true },
  { name: "Archivo Expanded Black", file: "Archivo-ExpandedBlack.ttf", assName: "Archivo Expanded Black", weight: 900, style: "normal", ascent: 1.1, descent: 0.41, capHeight: 0.688, templateOnly: true },
  { name: "Archivo Expanded Black Italic", file: "Archivo-ExpandedBlackItalic.ttf", assName: "Archivo Expanded Black Italic", weight: 900, style: "italic", ascent: 1.1, descent: 0.41, capHeight: 0.688, templateOnly: true },
  { name: "Archivo ExtraBold Italic", file: "Archivo-ExtraBoldItalic.ttf", assName: "Archivo ExtraBold Italic", weight: 800, style: "italic", ascent: 1.1, descent: 0.41, capHeight: 0.687, templateOnly: true },
  { name: "Rubik Black", file: "Rubik-Black.ttf", assName: "Rubik Black", weight: 900, style: "normal", ascent: 1.066, descent: 0.466, capHeight: 0.7, templateOnly: true },
  { name: "Yesteryear", file: "Yesteryear-Regular.ttf", assName: "Yesteryear", weight: 400, style: "normal", ascent: 0.9771, descent: 0.4902, capHeight: 0.772, templateOnly: true },
  { name: "Big Shoulders Display Black", file: "BigShouldersDisplay-Black.ttf", assName: "Big Shoulders Display Black", weight: 900, style: "normal", ascent: 1.307, descent: 0.365, capHeight: 0.8, templateOnly: true },
  { name: "Shrikhand", file: "Shrikhand-Regular.ttf", assName: "Shrikhand Regular", weight: 400, style: "normal", ascent: 1.026, descent: 0.432, capHeight: 0.666, templateOnly: true },
  { name: "Barlow Condensed Black Italic", file: "BarlowCondensed-BlackItalic.ttf", assName: "Barlow Condensed Black Italic", weight: 900, style: "italic", ascent: 1.075, descent: 0.274, capHeight: 0.7, templateOnly: true },
  { name: "Lexend Exa Light", file: "LexendExa-Light.ttf", assName: "Lexend Exa Light", weight: 300, style: "normal", ascent: 1.2, descent: 0.39, capHeight: 0.7, templateOnly: true },
  { name: "Chango", file: "Chango-Regular.ttf", assName: "Chango Regular", weight: 400, style: "normal", ascent: 0.995, descent: 0.216, capHeight: 0.701, templateOnly: true },
  { name: "Alfa Slab One", file: "AlfaSlabOne-Regular.ttf", assName: "Alfa Slab One Regular", weight: 400, style: "normal", ascent: 1.238, descent: 0.327, capHeight: 0.778, templateOnly: true },
  { name: "Abril Fatface", file: "AbrilFatface-Regular.ttf", assName: "Abril Fatface", weight: 400, style: "normal", ascent: 1.058, descent: 0.291, capHeight: 0.7, templateOnly: true },
  { name: "Montserrat ExtraBold", file: "Montserrat-ExtraBold.ttf", assName: "Montserrat ExtraBold", weight: 800, style: "normal", ascent: 1.109, descent: 0.453, capHeight: 0.7, templateOnly: true },
  { name: "Rubik ExtraBold", file: "Rubik-ExtraBold.ttf", assName: "Rubik ExtraBold", weight: 800, style: "normal", ascent: 1.066, descent: 0.466, capHeight: 0.7, templateOnly: true },
  { name: "DM Serif Display Italic", file: "DMSerifDisplay-Italic.ttf", assName: "DM Serif Display Italic", weight: 400, style: "italic", ascent: 1.036, descent: 0.335, capHeight: 0.66, templateOnly: true },
  { name: "Inter Tight Light", file: "InterTight-Light.ttf", assName: "Inter Tight Light", weight: 300, style: "normal", ascent: 1.105, descent: 0.3193, capHeight: 0.7275, templateOnly: true },
  { name: "Inter Tight Light Italic", file: "InterTight-LightItalic.ttf", assName: "Inter Tight Light Italic", weight: 300, style: "italic", ascent: 1.105, descent: 0.3193, capHeight: 0.7275, templateOnly: true },
  { name: "Inter Tight Medium Italic", file: "InterTight-MediumItalic.ttf", assName: "Inter Tight Medium Italic", weight: 500, style: "italic", ascent: 1.105, descent: 0.3193, capHeight: 0.7275, templateOnly: true },
  { name: "Inter Tight ExtraBold Italic", file: "InterTight-ExtraBoldItalic.ttf", assName: "Inter Tight ExtraBold Italic", weight: 800, style: "italic", ascent: 1.105, descent: 0.3193, capHeight: 0.7275, templateOnly: true },
  { name: "Barlow Condensed Medium", file: "BarlowCondensed-Medium.ttf", assName: "Barlow Condensed Medium", weight: 500, style: "normal", ascent: 1.075, descent: 0.274, capHeight: 0.7, templateOnly: true },
  { name: "Barlow Condensed Bold", file: "BarlowCondensed-Bold.ttf", assName: "Barlow Condensed Bold", weight: 700, style: "normal", ascent: 1.075, descent: 0.274, capHeight: 0.7, templateOnly: true },
  { name: "Barlow Condensed ExtraBold Italic", file: "BarlowCondensed-ExtraBoldItalic.ttf", assName: "Barlow Condensed ExtraBold Italic", weight: 800, style: "italic", ascent: 1.075, descent: 0.274, capHeight: 0.7, templateOnly: true },
  { name: "Playfair Display Bold", file: "PlayfairDisplay-Bold.ttf", assName: "Playfair Display Bold", weight: 700, style: "normal", ascent: 1.159, descent: 0.251, capHeight: 0.708, templateOnly: true },
  { name: "Playfair Display Bold Italic", file: "PlayfairDisplay-BoldItalic.ttf", assName: "Playfair Display Bold Italic", weight: 700, style: "italic", ascent: 1.159, descent: 0.251, capHeight: 0.708, templateOnly: true },
  { name: "Space Grotesk Bold", file: "SpaceGrotesk-Bold.ttf", assName: "Space Grotesk Bold", weight: 700, style: "normal", ascent: 1.15, descent: 0.292, capHeight: 0.7, templateOnly: true },
  { name: "DM Sans Bold", file: "DMSans-Bold.ttf", assName: "DM Sans 14pt Bold", weight: 700, style: "normal", ascent: 1.012, descent: 0.31, capHeight: 0.7, templateOnly: true },
  { name: "DM Sans Black", file: "DMSans-Black.ttf", assName: "DM Sans 14pt Black", weight: 900, style: "normal", ascent: 1.012, descent: 0.31, capHeight: 0.7, templateOnly: true },
  { name: "Manrope Bold", file: "Manrope-Bold.ttf", assName: "Manrope Bold", weight: 700, style: "normal", ascent: 1.066, descent: 0.3, capHeight: 0.72, templateOnly: true },
  { name: "Manrope ExtraBold", file: "Manrope-ExtraBold.ttf", assName: "Manrope ExtraBold", weight: 800, style: "normal", ascent: 1.066, descent: 0.3, capHeight: 0.72, templateOnly: true },
  { name: "Space Mono Bold", file: "SpaceMono-Bold.ttf", assName: "Space Mono Bold", weight: 700, style: "normal", ascent: 1.12, descent: 0.361, capHeight: 0.7, templateOnly: true },
  { name: "Silkscreen Bold", file: "Silkscreen-Bold.ttf", assName: "Silkscreen Bold", weight: 700, style: "normal", ascent: 1.0, descent: 0.25, capHeight: 0.625, templateOnly: true },
  { name: "Bagel Fat One", file: "BagelFatOne-Regular.ttf", assName: "Bagel Fat One Regular", weight: 400, style: "normal", ascent: 1.16, descent: 0.288, capHeight: 0.734, templateOnly: true },
  { name: "Space Mono Regular", file: "SpaceMono-Regular.ttf", assName: "Space Mono Regular", weight: 400, style: "normal", ascent: 1.12, descent: 0.361, capHeight: 0.7, templateOnly: true },
  { name: "Newsreader Medium", file: "Newsreader-Medium.ttf", assName: "Newsreader Medium", weight: 500, style: "normal", ascent: 1.163, descent: 0.2655, capHeight: 0.715, templateOnly: true },
  { name: "Newsreader SemiBold", file: "Newsreader-SemiBold.ttf", assName: "Newsreader SemiBold", weight: 600, style: "normal", ascent: 1.163, descent: 0.2655, capHeight: 0.715, templateOnly: true },
  { name: "Newsreader SemiBold Italic", file: "Newsreader-SemiBoldItalic.ttf", assName: "Newsreader SemiBold Italic", weight: 600, style: "italic", ascent: 1.163, descent: 0.2655, capHeight: 0.715, templateOnly: true },
  { name: "Plus Jakarta Sans Bold", file: "PlusJakartaSans-Bold.ttf", assName: "Plus Jakarta Sans Bold", weight: 700, style: "normal", ascent: 1.296, descent: 0.356, capHeight: 0.745, templateOnly: true },
  { name: "Plus Jakarta Sans ExtraBold", file: "PlusJakartaSans-ExtraBold.ttf", assName: "Plus Jakarta Sans ExtraBold", weight: 800, style: "normal", ascent: 1.296, descent: 0.356, capHeight: 0.745, templateOnly: true },
  { name: "Fredoka SemiBold", file: "Fredoka-SemiBold.ttf", assName: "Fredoka SemiBold", weight: 600, style: "normal", ascent: 0.999, descent: 0.252, capHeight: 0.69, templateOnly: true },
  { name: "Fredoka Bold", file: "Fredoka-Bold.ttf", assName: "Fredoka Bold", weight: 700, style: "normal", ascent: 0.999, descent: 0.252, capHeight: 0.691, templateOnly: true },
  { name: "Pixelify Sans Bold", file: "PixelifySans-Bold.ttf", assName: "Pixelify Sans Bold", weight: 700, style: "normal", ascent: 0.922, descent: 0.289, capHeight: 0.638, templateOnly: true },
  { name: "Londrina Solid Black", file: "LondrinaSolid-Black.ttf", assName: "Londrina Solid Black", weight: 900, style: "normal", ascent: 0.941, descent: 0.215, capHeight: 0.712, templateOnly: true },
  { name: "Lobster", file: "Lobster-Regular.ttf", assName: "Lobster Regular", weight: 400, style: "normal", ascent: 1.0, descent: 0.49, capHeight: 0.75, templateOnly: true },
  { name: "Oleo Script Bold", file: "OleoScript-Bold.ttf", assName: "Oleo Script Bold", weight: 700, style: "normal", ascent: 1.004, descent: 0.379, capHeight: 0.71, templateOnly: true },
  { name: "Racing Sans One", file: "RacingSansOne-Regular.ttf", assName: "Racing Sans One", weight: 400, style: "normal", ascent: 0.976, descent: 0.284, capHeight: 0.635, templateOnly: true },
  { name: "Orbitron Black", file: "Orbitron-Black.ttf", assName: "Orbitron Black", weight: 900, style: "normal", ascent: 1.011, descent: 0.243, capHeight: 0.72, templateOnly: true },
  { name: "Pacifico", file: "Pacifico-Regular.ttf", assName: "Pacifico Regular", weight: 400, style: "normal", ascent: 1.478, descent: 0.457, capHeight: 0.877, templateOnly: true },
  { name: "Kaushan Script", file: "KaushanScript-Regular.ttf", assName: "Kaushan Script", weight: 400, style: "normal", ascent: 1.084, descent: 0.367, capHeight: 0.742, templateOnly: true },
  { name: "Chewy", file: "Chewy-Regular.ttf", assName: "Chewy Regular", weight: 400, style: "normal", ascent: 0.9795, descent: 0.3027, capHeight: 0.7344, templateOnly: true },
  { name: "Caveat Bold", file: "Caveat-Bold.ttf", assName: "Caveat Bold", weight: 700, style: "normal", ascent: 0.974, descent: 0.315, capHeight: 0.7195, templateOnly: true },
  { name: "Bangers", file: "Bangers-Regular.ttf", assName: "Bangers Regular", weight: 400, style: "normal", ascent: 1.401, descent: 0.356, capHeight: 0.74, templateOnly: true },
  { name: "Knewave", file: "Knewave-Regular.ttf", assName: "Knewave", weight: 400, style: "normal", ascent: 1.169, descent: 0.385, capHeight: 0.786, templateOnly: true },
  { name: "Gabarito ExtraBold", file: "Gabarito-ExtraBold.ttf", assName: "Gabarito ExtraBold", weight: 800, style: "normal", ascent: 0.998, descent: 0.295, capHeight: 0.681, templateOnly: true },
  { name: "Sora ExtraBold", file: "Sora-ExtraBold.ttf", assName: "Sora ExtraBold", weight: 800, style: "normal", ascent: 1.22, descent: 0.32, capHeight: 0.73, templateOnly: true },
] as const satisfies readonly CaptionFontFace[];

export type CaptionFontName = (typeof CAPTION_FONT_FACES)[number]["name"];

export const CAPTION_FONT_NAMES = CAPTION_FONT_FACES.map((face) => face.name) as [
  CaptionFontName,
  ...CaptionFontName[],
];

/** The faces offered as classic caption fonts: every face but the template-only ones. */
export const CAPTION_PICKER_FONT_NAMES = CAPTION_FONT_FACES.filter((face) => !("templateOnly" in face)).map((face) => face.name) as [
  CaptionFontName,
  ...CaptionFontName[],
];

export function captionFontFace(name: CaptionFontName): CaptionFontFace {
  const face = CAPTION_FONT_FACES.find((candidate) => candidate.name === name);
  if (!face) throw new Error(`Unknown caption font ${name}`);
  return face;
}

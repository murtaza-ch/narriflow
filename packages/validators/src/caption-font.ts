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
}

export const CAPTION_FONT_FACES = [
  { name: "Anton", file: "Anton-Regular.ttf", assName: "Anton Regular", weight: 400, style: "normal", ascent: 1.4043, descent: 0.3291, capHeight: 0.8594 },
  { name: "Archivo Black", file: "ArchivoBlack-Regular.ttf", assName: "Archivo Black Regular", weight: 400, style: "normal", ascent: 1.035, descent: 0.312, capHeight: 0.688 },
  { name: "Bebas Neue", file: "BebasNeue-Regular.ttf", assName: "Bebas Neue Regular", weight: 400, style: "normal", ascent: 0.95, descent: 0.35, capHeight: 0.7 },
  { name: "Bricolage Grotesque", file: "BricolageGrotesque-ExtraBold.ttf", assName: "Bricolage Grotesque 96pt ExtraBold", weight: 800, style: "normal", ascent: 1.16, descent: 0.4, capHeight: 0.66 },
  { name: "Chakra Petch", file: "ChakraPetch-Bold.ttf", assName: "Chakra Petch Bold", weight: 700, style: "normal", ascent: 1.248, descent: 0.566, capHeight: 0.7 },
  { name: "Courier Prime", file: "CourierPrime-Bold.ttf", assName: "Courier Prime Bold", weight: 700, style: "normal", ascent: 0.9277, descent: 0.3906, capHeight: 0.5796 },
  { name: "Dela Gothic One", file: "DelaGothicOne-Regular.ttf", assName: "Dela Gothic One Regular", weight: 400, style: "normal", ascent: 1.16, descent: 0.288, capHeight: 0.726 },
  { name: "Instrument Serif", file: "InstrumentSerif-Italic.ttf", assName: "Instrument Serif Italic", weight: 400, style: "italic", ascent: 0.99, descent: 0.31, capHeight: 0.72 },
  { name: "Inter", file: "Inter-ExtraBold.ttf", assName: "Inter 28pt ExtraBold", weight: 800, style: "normal", ascent: 1.1079, descent: 0.3223, capHeight: 0.7275 },
  { name: "Inter SemiBold", file: "Inter-SemiBold.ttf", assName: "Inter 28pt SemiBold", weight: 600, style: "normal", ascent: 1.1079, descent: 0.3223, capHeight: 0.7275 },
  { name: "Lilita One", file: "LilitaOne-Regular.ttf", assName: "Lilita One", weight: 400, style: "normal", ascent: 0.923, descent: 0.22, capHeight: 0.701 },
  { name: "Luckiest Guy", file: "LuckiestGuy-Regular.ttf", assName: "Luckiest Guy Regular", weight: 400, style: "normal", ascent: 0.9795, descent: 0.2461, capHeight: 0.7021 },
  { name: "Montserrat", file: "Montserrat-Black.ttf", assName: "Montserrat Black", weight: 900, style: "normal", ascent: 1.109, descent: 0.453, capHeight: 0.7 },
  { name: "Open Sans", file: "OpenSans-Bold.ttf", assName: "Open Sans Bold", weight: 700, style: "normal", ascent: 1.124, descent: 0.3179, capHeight: 0.7139 },
  { name: "Oswald", file: "Oswald-Bold.ttf", assName: "Oswald Bold", weight: 700, style: "normal", ascent: 1.325, descent: 0.377, capHeight: 0.81 },
  { name: "Poppins", file: "Poppins-ExtraBold.ttf", assName: "Poppins ExtraBold", weight: 800, style: "normal", ascent: 1.135, descent: 0.627, capHeight: 0.705 },
  { name: "Righteous", file: "Righteous-Regular.ttf", assName: "Righteous", weight: 400, style: "normal", ascent: 0.9849, descent: 0.2568, capHeight: 0.7002 },
  { name: "Roboto", file: "Roboto-Bold.ttf", assName: "Roboto Bold", weight: 700, style: "normal", ascent: 0.9502, descent: 0.25, capHeight: 0.7109 },
  { name: "Titan One", file: "TitanOne-Regular.ttf", assName: "Titan One", weight: 400, style: "normal", ascent: 0.97, descent: 0.175, capHeight: 0.71 },
  { name: "Unbounded", file: "Unbounded-ExtraBold.ttf", assName: "Unbounded ExtraBold", weight: 800, style: "normal", ascent: 1.262, descent: 0.286, capHeight: 0.75 },
] as const satisfies readonly CaptionFontFace[];

export type CaptionFontName = (typeof CAPTION_FONT_FACES)[number]["name"];

export const CAPTION_FONT_NAMES = CAPTION_FONT_FACES.map((face) => face.name) as [
  CaptionFontName,
  ...CaptionFontName[],
];

export function captionFontFace(name: CaptionFontName): CaptionFontFace {
  const face = CAPTION_FONT_FACES.find((candidate) => candidate.name === name);
  if (!face) throw new Error(`Unknown caption font ${name}`);
  return face;
}

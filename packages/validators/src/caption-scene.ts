import type { CaptionFontName } from "./caption-font";

/**
 * Scene Styles (ADR 0021, `.scratch/motion-captions/spec.md`): caption looks drawn by a program
 * that builds a Caption Scene across a clip's cues. This file is the data side that the preset
 * catalogue, the plan and the panel read without importing the programs themselves
 * (`@narriflow/caption-scene` holds those). Every number here is the sample's own.
 */

export const CAPTION_SCENE_NAMES = [
  "lyrics",
  "dialogue",
  "dossier",
  "hollow",
  "signal",
  "track",
  "bulletin",
  "ticker",
  "flap",
  "index",
  "punchline",
  "doodle",
  "velocity",
  "wordform",
  "chrome",
  "reveal",
  "spine",
  "boom",
  "aura",
  "wonky",
  "verified",
  "cursor",
  "premiere",
  "tape",
  "beat",
  "stretch",
  "hype",
  "wallpaper",
  "slice",
  "arthouse",
  "heft",
  "popup",
] as const;

export type CaptionSceneName = (typeof CAPTION_SCENE_NAMES)[number];

/** The three colour slots of a preset that a Scene Style reads. */
export type CaptionSceneColourSlot = "primaryColor" | "highlightColor" | "accentColor";

/**
 * Where one brand colour goes in a Scene Style: the preset slot that takes it, and what that slot's colour is drawn on or under.
 * A slot a style draws as ink on a fixed plate (Dialogue's dark text on its light bubble, Dossier's ink on its paper) is
 * never a target, and a slot that is a plate under fixed ink or over a plate (Bulletin's hero plate under white text, Dossier's
 * stamp on its paper) takes the brand colour only when it reads against that (`readsOn`, contrast of at least 3:1 with every entry):
 * a white brand on a white-ink plate would otherwise draw invisible text.
 */
export interface CaptionSceneBrandTarget {
  readonly slot: CaptionSceneColourSlot;
  /** `#RRGGBB` constants or slots of the same preset that the brand colour is drawn against. */
  readonly readsOn?: readonly (string | CaptionSceneColourSlot)[];
}

/** Which slots the brand template's two colours colour: its primary (text, the main colour) and its secondary (the accent or highlight). */
export interface CaptionSceneBrand {
  readonly primary: CaptionSceneBrandTarget | null;
  readonly secondary: CaptionSceneBrandTarget | null;
}

export interface CaptionSceneMeta {
  /** Picker label. */
  readonly name: string;
  /** The sample's body size in px of its 1080 x 1920 frame; the preset's `fontSize` over this is the user's size scale. */
  readonly bodyPx: number;
  /** The sample's anchor line, px from the top of its 1920 px frame: the preset's `positionY` puts this line. */
  readonly anchorLineY: number;
  /** Words per cue, from the sample's cue lengths. */
  readonly wordsPerCue: number;
  /** "never": the template draws no hero, so the scorer assigns none. */
  readonly emphasis: "auto" | "never";
  /** Brand-swappable colours as the sample names them. `highlight` is the hero or tape colour, `accent` the third. */
  readonly colours: { readonly primary: string; readonly highlight: string; readonly accent: string };
  /** What the brand template's colours colour in this style: never ink on a fixed plate, see `CaptionSceneBrandTarget`. */
  readonly brand: CaptionSceneBrand;
  /** The face the picker shows for the preset (the template draws its own). */
  readonly fontName: CaptionFontName;
  /** The still the sample was judged on. */
  readonly backdrop: "dark" | "bright" | "busy";
}

export const CAPTION_SCENES: Readonly<Record<CaptionSceneName, CaptionSceneMeta>> = {
  lyrics: { name: "Lyrics", bodyPx: 92, anchorLineY: 1226, wordsPerCue: 5, emphasis: "auto", colours: { primary: "#FFFFFF", highlight: "#A5EBC5", accent: "#A5EBC5" }, brand: { primary: { slot: "primaryColor" }, secondary: { slot: "highlightColor" } }, fontName: "Inter Tight Bold", backdrop: "dark" },
  dialogue: { name: "Dialogue", bodyPx: 58, anchorLineY: 1560, wordsPerCue: 5, emphasis: "auto", colours: { primary: "#111111", highlight: "#FFE14A", accent: "#2F6BFF" }, brand: { primary: { slot: "accentColor", readsOn: ["#FFFFFF"] }, secondary: { slot: "highlightColor", readsOn: ["primaryColor"] } }, fontName: "Inter SemiBold", backdrop: "bright" },
  dossier: { name: "Dossier", bodyPx: 72, anchorLineY: 1300, wordsPerCue: 4, emphasis: "auto", colours: { primary: "#111111", highlight: "#D7263D", accent: "#F4EFE6" }, brand: { primary: null, secondary: { slot: "highlightColor", readsOn: ["accentColor"] } }, fontName: "Courier Prime", backdrop: "bright" },
  hollow: { name: "Hollow", bodyPx: 124, anchorLineY: 1268, wordsPerCue: 3, emphasis: "auto", colours: { primary: "#FFFFFF", highlight: "#D7FF3E", accent: "#D7FF3E" }, brand: { primary: { slot: "primaryColor" }, secondary: { slot: "highlightColor" } }, fontName: "Anton", backdrop: "busy" },
  signal: { name: "Signal", bodyPx: 52, anchorLineY: 1290, wordsPerCue: 4, emphasis: "auto", colours: { primary: "#D8FFE9", highlight: "#FFFFFF", accent: "#39FF9C" }, brand: { primary: { slot: "primaryColor" }, secondary: { slot: "accentColor" } }, fontName: "JetBrains Mono Medium", backdrop: "dark" },
  track: { name: "Track", bodyPx: 84, anchorLineY: 1290, wordsPerCue: 4, emphasis: "auto", colours: { primary: "#F5F7FA", highlight: "#6CF0FF", accent: "#FFFFFF" }, brand: { primary: { slot: "primaryColor" }, secondary: { slot: "highlightColor" } }, fontName: "Inter SemiBold", backdrop: "busy" },
  bulletin: { name: "Bulletin", bodyPx: 60, anchorLineY: 1320, wordsPerCue: 5, emphasis: "auto", colours: { primary: "#FFFFFF", highlight: "#FF4B2B", accent: "#141519" }, brand: { primary: { slot: "primaryColor", readsOn: ["accentColor"] }, secondary: { slot: "highlightColor", readsOn: ["#FFFFFF"] } }, fontName: "Inter Tight Bold", backdrop: "bright" },
  ticker: { name: "Ticker", bodyPx: 66, anchorLineY: 1300, wordsPerCue: 4, emphasis: "auto", colours: { primary: "#FFFFFF", highlight: "#FFD400", accent: "#0A0A0A" }, brand: { primary: { slot: "primaryColor" }, secondary: { slot: "highlightColor", readsOn: ["accentColor"] } }, fontName: "Archivo Black", backdrop: "busy" },
  flap: { name: "Flap", bodyPx: 92, anchorLineY: 1290, wordsPerCue: 3, emphasis: "auto", colours: { primary: "#F4F1E6", highlight: "#FFB000", accent: "#16181C" }, brand: { primary: { slot: "primaryColor", readsOn: ["accentColor"] }, secondary: { slot: "highlightColor" } }, fontName: "Oswald", backdrop: "dark" },
  index: { name: "Index", bodyPx: 64, anchorLineY: 1290, wordsPerCue: 4, emphasis: "auto", colours: { primary: "#FFFFFF", highlight: "#B9F227", accent: "#0E0E10" }, brand: { primary: { slot: "primaryColor", readsOn: ["accentColor"] }, secondary: { slot: "highlightColor", readsOn: ["accentColor"] } }, fontName: "Inter", backdrop: "bright" },
  punchline: { name: "Punchline", bodyPx: 80, anchorLineY: 1290, wordsPerCue: 4, emphasis: "auto", colours: { primary: "#FFFFFF", highlight: "#FF4FA3", accent: "#FFD400" }, brand: { primary: { slot: "primaryColor" }, secondary: { slot: "highlightColor" } }, fontName: "Lilita One", backdrop: "busy" },
  doodle: { name: "Doodle", bodyPx: 100, anchorLineY: 1290, wordsPerCue: 4, emphasis: "auto", colours: { primary: "#FFFFFF", highlight: "#FFF36B", accent: "#FFFFFF" }, brand: { primary: { slot: "primaryColor" }, secondary: { slot: "highlightColor" } }, fontName: "Caveat Brush", backdrop: "dark" },
  velocity: { name: "Velocity", bodyPx: 96, anchorLineY: 1290, wordsPerCue: 4, emphasis: "auto", colours: { primary: "#FFFFFF", highlight: "#FF4D1A", accent: "#0B0B0B" }, brand: { primary: { slot: "primaryColor" }, secondary: { slot: "highlightColor", readsOn: ["accentColor"] } }, fontName: "Anton", backdrop: "busy" },
  wordform: { name: "Wordform", bodyPx: 64, anchorLineY: 1330, wordsPerCue: 4, emphasis: "auto", colours: { primary: "#FFFFFF", highlight: "#FFC9A8", accent: "#FFFFFF" }, brand: { primary: { slot: "primaryColor" }, secondary: { slot: "highlightColor" } }, fontName: "Bricolage Grotesque", backdrop: "dark" },
  chrome: { name: "Chrome", bodyPx: 52, anchorLineY: 1290, wordsPerCue: 4, emphasis: "auto", colours: { primary: "#FFFFFF", highlight: "#B4CEF2", accent: "#2F6BFF" }, brand: { primary: { slot: "primaryColor" }, secondary: { slot: "accentColor" } }, fontName: "Unbounded Black", backdrop: "dark" },
  spine: { name: "Spine", bodyPx: 58, anchorLineY: 1290, wordsPerCue: 4, emphasis: "auto", colours: { primary: "#0E0E0E", highlight: "#FF3B1F", accent: "#FFFFFF" }, brand: { primary: null, secondary: { slot: "highlightColor", readsOn: ["#141414"] } }, fontName: "Archivo Black", backdrop: "bright" },
  boom: { name: "Boom", bodyPx: 86, anchorLineY: 1290, wordsPerCue: 4, emphasis: "auto", colours: { primary: "#FFFFFF", highlight: "#FFE600", accent: "#FF3D7F" }, brand: { primary: { slot: "primaryColor", readsOn: ["#000000"] }, secondary: { slot: "highlightColor", readsOn: ["#000000"] } }, fontName: "Luckiest Guy", backdrop: "busy" },
  aura: { name: "Aura", bodyPx: 72, anchorLineY: 1290, wordsPerCue: 4, emphasis: "auto", colours: { primary: "#FFFFFF", highlight: "#FFE600", accent: "#FFFFFF" }, brand: { primary: { slot: "primaryColor" }, secondary: { slot: "highlightColor" } }, fontName: "Inter Tight Medium", backdrop: "dark" },
  wonky: { name: "Wonky", bodyPx: 72, anchorLineY: 1290, wordsPerCue: 4, emphasis: "auto", colours: { primary: "#FFFFFF", highlight: "#FFE600", accent: "#FFFFFF" }, brand: { primary: { slot: "primaryColor" }, secondary: { slot: "highlightColor" } }, fontName: "Rubik Black", backdrop: "busy" },
  verified: { name: "Verified", bodyPx: 72, anchorLineY: 1290, wordsPerCue: 4, emphasis: "auto", colours: { primary: "#FFFFFF", highlight: "#FFE600", accent: "#FFFFFF" }, brand: { primary: { slot: "primaryColor" }, secondary: { slot: "highlightColor" } }, fontName: "Archivo Expanded Black Italic", backdrop: "dark" },
  cursor: { name: "Cursor", bodyPx: 72, anchorLineY: 1290, wordsPerCue: 4, emphasis: "auto", colours: { primary: "#FFFFFF", highlight: "#FFE600", accent: "#FFFFFF" }, brand: { primary: { slot: "primaryColor" }, secondary: { slot: "highlightColor" } }, fontName: "Inter Tight ExtraBold", backdrop: "bright" },
  premiere: { name: "Premiere", bodyPx: 72, anchorLineY: 1290, wordsPerCue: 4, emphasis: "auto", colours: { primary: "#FFFFFF", highlight: "#FFE600", accent: "#FFFFFF" }, brand: { primary: { slot: "primaryColor" }, secondary: { slot: "highlightColor" } }, fontName: "Anton", backdrop: "dark" },
  tape: { name: "Tape", bodyPx: 72, anchorLineY: 1290, wordsPerCue: 4, emphasis: "auto", colours: { primary: "#FFFFFF", highlight: "#FFE600", accent: "#FFFFFF" }, brand: { primary: { slot: "primaryColor" }, secondary: { slot: "highlightColor" } }, fontName: "Archivo Expanded Black", backdrop: "dark" },
  beat: { name: "Beat", bodyPx: 72, anchorLineY: 1290, wordsPerCue: 4, emphasis: "auto", colours: { primary: "#FFFFFF", highlight: "#FFE600", accent: "#FFFFFF" }, brand: { primary: { slot: "primaryColor" }, secondary: { slot: "highlightColor" } }, fontName: "Archivo Black", backdrop: "busy" },
  stretch: { name: "Stretch", bodyPx: 72, anchorLineY: 1290, wordsPerCue: 4, emphasis: "auto", colours: { primary: "#FFFFFF", highlight: "#FFE600", accent: "#FFFFFF" }, brand: { primary: { slot: "primaryColor" }, secondary: { slot: "highlightColor" } }, fontName: "Dela Gothic One", backdrop: "busy" },
  hype: { name: "Hype", bodyPx: 72, anchorLineY: 1290, wordsPerCue: 4, emphasis: "auto", colours: { primary: "#FFFFFF", highlight: "#FFE600", accent: "#FFFFFF" }, brand: { primary: { slot: "primaryColor" }, secondary: { slot: "highlightColor" } }, fontName: "Barlow Condensed Black Italic", backdrop: "bright" },
  wallpaper: { name: "Wallpaper", bodyPx: 72, anchorLineY: 1290, wordsPerCue: 4, emphasis: "auto", colours: { primary: "#FFFFFF", highlight: "#FFE600", accent: "#FFFFFF" }, brand: { primary: { slot: "primaryColor" }, secondary: { slot: "highlightColor" } }, fontName: "Archivo Expanded ExtraBold", backdrop: "dark" },
  slice: { name: "Slice", bodyPx: 72, anchorLineY: 1290, wordsPerCue: 4, emphasis: "auto", colours: { primary: "#FFFFFF", highlight: "#FFE600", accent: "#FFFFFF" }, brand: { primary: { slot: "primaryColor" }, secondary: { slot: "highlightColor" } }, fontName: "Inter Tight ExtraBold", backdrop: "busy" },
  arthouse: { name: "Arthouse", bodyPx: 72, anchorLineY: 1290, wordsPerCue: 4, emphasis: "auto", colours: { primary: "#FFFFFF", highlight: "#FFE600", accent: "#FFFFFF" }, brand: { primary: { slot: "primaryColor" }, secondary: { slot: "highlightColor" } }, fontName: "Big Shoulders Display Black", backdrop: "dark" },
  heft: { name: "Heft", bodyPx: 72, anchorLineY: 1290, wordsPerCue: 4, emphasis: "auto", colours: { primary: "#FFFFFF", highlight: "#FFE600", accent: "#FFFFFF" }, brand: { primary: { slot: "primaryColor" }, secondary: { slot: "highlightColor" } }, fontName: "Unbounded Black", backdrop: "dark" },
  popup: { name: "Popup", bodyPx: 72, anchorLineY: 1290, wordsPerCue: 4, emphasis: "auto", colours: { primary: "#FFFFFF", highlight: "#FFE600", accent: "#FFFFFF" }, brand: { primary: { slot: "primaryColor" }, secondary: { slot: "highlightColor" } }, fontName: "Chango", backdrop: "bright" },
  reveal: { name: "Reveal", bodyPx: 72, anchorLineY: 1300, wordsPerCue: 4, emphasis: "auto", colours: { primary: "#FFFFFF", highlight: "#FFE9A8", accent: "#FFFFFF" }, brand: { primary: { slot: "primaryColor" }, secondary: { slot: "highlightColor" } }, fontName: "Inter Tight SemiBold", backdrop: "dark" },
};

export function captionSceneMeta(name: CaptionSceneName): CaptionSceneMeta {
  return CAPTION_SCENES[name];
}

/** Default `positionY` (percent of frame height) of a Scene Style: its sample's anchor line. */
export function captionSceneDefaultPositionY(name: CaptionSceneName): number {
  return Math.round((CAPTION_SCENES[name].anchorLineY / 1920) * 10_000) / 100;
}

const channelOf = (hex: string, at: number) => Number.parseInt(hex.slice(1 + 2 * at, 3 + 2 * at), 16) / 255;
const linear = (value: number) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);

/** WCAG relative luminance of `#RRGGBB`. */
function relativeLuminance(hex: string): number {
  return 0.2126 * linear(channelOf(hex, 0)) + 0.7152 * linear(channelOf(hex, 1)) + 0.0722 * linear(channelOf(hex, 2));
}

/** WCAG contrast ratio of two `#RRGGBB` colours, 1 to 21. */
export function captionColourContrast(a: string, b: string): number {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

/** The least contrast a brand colour keeps against what it is drawn on. */
export const CAPTION_SCENE_BRAND_MIN_CONTRAST = 3;

/**
 * The preset's colours with a brand template's two colours put where `CaptionSceneMeta.brand` says. A target whose
 * colour would not read against its `readsOn` keeps the preset's own.
 */
export function applyBrandColorsToScene(
  name: CaptionSceneName,
  preset: { readonly primaryColor: string; readonly highlightColor: string; readonly accentColor?: string | undefined },
  brand: { readonly primaryColor: string; readonly secondaryColor: string },
): Partial<Record<CaptionSceneColourSlot, string>> {
  const meta = CAPTION_SCENES[name];
  const slotColour = (slot: CaptionSceneColourSlot) => (slot === "primaryColor" ? preset.primaryColor : slot === "highlightColor" ? preset.highlightColor : (preset.accentColor ?? meta.colours.accent));
  const result: Partial<Record<CaptionSceneColourSlot, string>> = {};
  for (const [target, colour] of [[meta.brand.primary, brand.primaryColor], [meta.brand.secondary, brand.secondaryColor]] as const) {
    if (!target) continue;
    const readable = (target.readsOn ?? []).every((against) => captionColourContrast(colour, against.startsWith("#") ? against : slotColour(against as CaptionSceneColourSlot)) >= CAPTION_SCENE_BRAND_MIN_CONTRAST);
    if (readable) result[target.slot] = colour;
  }
  return result;
}

/** The brand colours a Scene Style preset implies, the inverse of `applyBrandColorsToScene`: its slots, or the preset's text and highlight colours for a role the style leaves out. */
export function brandColorsFromScene(
  name: CaptionSceneName,
  preset: { readonly primaryColor: string; readonly highlightColor: string; readonly accentColor?: string | undefined },
): { primaryColor: string; secondaryColor: string } {
  const { brand, colours } = CAPTION_SCENES[name];
  const slotColour = (slot: CaptionSceneColourSlot) => (slot === "primaryColor" ? preset.primaryColor : slot === "highlightColor" ? preset.highlightColor : (preset.accentColor ?? colours.accent));
  return {
    primaryColor: brand.primary ? slotColour(brand.primary.slot) : preset.primaryColor,
    secondaryColor: brand.secondary ? slotColour(brand.secondary.slot) : preset.highlightColor,
  };
}

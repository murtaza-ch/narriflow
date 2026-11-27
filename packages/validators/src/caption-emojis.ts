import { z } from "zod";
import { captionDynamicStyle } from "./caption-dynamic";
import { captionWordKeySchema } from "./caption-emphasis";
import type { CaptionPreset } from "./caption-preset";
import { captionSceneMeta } from "./caption-scene";

// Caption Emojis: Narriflow's own emoji art placed on caption cues by Word Key.
// Pure code shared by the browser, the Worker and the media executor. The
// catalog lives in `@narriflow/caption-emoji`; this module never imports it,
// so an id the catalog does not know is stored and then dropped by renderers.

/** Stored emojis per clip, at most. */
export const CAPTION_EMOJI_LIMIT = 500;

/** The longest word text an entry stores (`CaptionEmojiRef.word`). */
export const CAPTION_EMOJI_WORD_MAX_LENGTH = 200;

/** A skin tone: 0 is the pack's default yellow, 1 to 5 the Unicode skin tones, light to dark. */
export const captionEmojiToneSchema = z.number().int().min(0).max(5);

/**
 * One placed emoji: the catalog id, the skin tone a person chose for it in the picker, and the
 * text of the word it was placed on. `tone` is written only by a hand pick (0 keeps the default
 * yellow); without it the emoji takes the preset's `emojiTone` (`captionEmojiDrawnTone`), so the
 * AI's emojis follow the Skin tone setting and never guess a person's skin. With `word`, the entry
 * draws only on a word with that text (`captionWordComparable`), so a line rewrite never moves it
 * onto another word; an entry without it attaches by time alone.
 */
export const captionEmojiRefSchema = z.strictObject({
  id: z.string().min(1).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  tone: captionEmojiToneSchema.optional(),
  word: z.string().min(1).max(CAPTION_EMOJI_WORD_MAX_LENGTH).optional(),
});
export type CaptionEmojiRef = z.infer<typeof captionEmojiRefSchema>;

/** `ref` placed on a word with this transcript text: the entry every writer stores. A text the schema cannot hold is left out. */
export function captionEmojiRefOnWord(ref: CaptionEmojiRef, text: string): CaptionEmojiRef {
  const { word: _previous, ...rest } = ref;
  return text.length >= 1 && text.length <= CAPTION_EMOJI_WORD_MAX_LENGTH ? { ...rest, word: text } : rest;
}

/**
 * The tone an emoji is drawn in: its own (chosen by hand), else the preset's Skin tone, else the
 * default yellow. Designs without skin ignore the tone.
 */
export function captionEmojiDrawnTone(ref: Pick<CaptionEmojiRef, "tone">, preset: Pick<CaptionPreset, "emojiTone">): number {
  return ref.tone ?? preset.emojiTone ?? 0;
}

/** Emojis by Word Key (a word's source start in whole milliseconds). Entries whose word is gone are kept and draw nothing. */
export const captionEmojisSchema = z
  .record(captionWordKeySchema, captionEmojiRefSchema)
  .refine((emojis) => Object.keys(emojis).length <= CAPTION_EMOJI_LIMIT, {
    message: `at most ${CAPTION_EMOJI_LIMIT} caption emojis`,
  });
export type CaptionEmojis = z.infer<typeof captionEmojisSchema>;

const hexColourSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

/** The art's three palette roles: `a` body, `b` accent rim, `c` detail. */
export const captionEmojiPaletteSchema = z.strictObject({
  a: hexColourSchema,
  b: hexColourSchema,
  c: hexColourSchema,
});
export type CaptionEmojiPalette = z.infer<typeof captionEmojiPaletteSchema>;

/** The owner's prototype palettes, offered next to Match template and Custom. */
export const CAPTION_EMOJI_PALETTES = [
  { id: "bubblegum", name: "Bubblegum", palette: { a: "#ffe45c", b: "#ff4f9a", c: "#ffffff" } },
  { id: "jelly", name: "Jelly", palette: { a: "#a3ff12", b: "#7c3aed", c: "#ffffff" } },
  { id: "candy", name: "Candy", palette: { a: "#ffd23f", b: "#ffffff", c: "#ff5fa2" } },
  { id: "retro", name: "Retro", palette: { a: "#59f0d2", b: "#1a1a1a", c: "#fff3d6" } },
] as const satisfies readonly { id: string; name: string; palette: CaptionEmojiPalette }[];

/** The art's fixed ink (outlines, eyes, mouths); never recoloured. */
export const CAPTION_EMOJI_INK = "#271e35";

/** `emojiSize` choices: multiples of the default emoji size. */
export const CAPTION_EMOJI_SIZES = [0.8, 1, 1.25] as const;
export const captionEmojiSizeSchema = z.literal(CAPTION_EMOJI_SIZES);
export type CaptionEmojiSize = z.infer<typeof captionEmojiSizeSchema>;

/** Where an emoji sits against its cue. Auto is above, or below when the caption sits in the top 30%. */
export const captionEmojiPositionSchema = z.enum(["auto", "above", "below"]);
export type CaptionEmojiPosition = z.infer<typeof captionEmojiPositionSchema>;

// ─── Palette ────────────────────────────────────────────────────────────────
//
// Separation is the Euclidean distance in OKLab (ΔEok, 0 = identical, about 1 =
// black against white). Contrast ratio cannot be the metric: the owner's own
// Bubblegum puts a yellow body on white detail, a ratio of 1.2 that reads well
// because the hues differ. The owner's four palettes measure a–ink ≥ 0.63,
// a–c ≥ 0.17 and b–a ≥ 0.20, so the thresholds below hold all four with room.

/** Least ΔEok between the body `a` and the ink, so outlines and faces stay readable on the body. */
export const CAPTION_EMOJI_MIN_BODY_INK = 0.3;
/** Least ΔEok between the body `a` and the detail `c`. */
export const CAPTION_EMOJI_MIN_BODY_DETAIL = 0.12;
/**
 * Least ΔEok between the detail `c` and the ink: eye whites, teeth and shines are `c` with ink
 * pupils and lines on them, so dark caption text as the detail turns eyes into black discs. Dark
 * text measures 0.04 to 0.10 from the ink; every other template's text 0.43 or more.
 */
export const CAPTION_EMOJI_MIN_DETAIL_INK = 0.3;
/** The detail when the template's text is too close to the ink: the pack's own white. */
const DETAIL_FALLBACK = "#ffffff";
/** Least ΔEok between the rim `b` and the body `a`. */
export const CAPTION_EMOJI_MIN_RIM_BODY = 0.12;
/**
 * Least ΔEok between the rim `b` and the detail `c`, and between `b` and the sticker's white outline:
 * a rim at white (any white-text template's accent) merges with the outline it touches and reads as
 * a white blob around the body.
 */
export const CAPTION_EMOJI_MIN_RIM_APART = 0.12;
/** The sticker outline's colour, drawn around every emoji with the sticker look. */
export const CAPTION_EMOJI_STICKER_WHITE = "#FFFFFF";
/**
 * Least OKLCH chroma of the body: under it (a grey, a silver, a washed-out pastel) the emoji stops
 * reading as an emoji. The owner's bodies measure 0.135 (Retro's teal) to 0.246 (Jelly's lime).
 */
export const CAPTION_EMOJI_MIN_BODY_CHROMA = 0.07;
/** Least ΔEok between the body and the sticker's white outline: a cream body merges with it. Yellow bodies sit at 0.16 to 0.21. */
export const CAPTION_EMOJI_MIN_BODY_WHITE = 0.12;

/** Bodies tried, in order, when neither the highlight nor the accent separates: three far-apart hues from the owner's palettes. */
const BODY_FALLBACKS = ["#ffe45c", "#59f0d2", "#ff4f9a"] as const;

/*
 * A derived rim is a shade of the body, the way illustrators shade, in OKLCH:
 * - darker: lightness down by the first of `RIM_DARKER` that separates (then up by `RIM_LIGHTER`
 *   when a dark detail leaves no room below);
 * - at least as saturated: chroma × 1.15, and at least 0.12, then cut to the sRGB gamut at that
 *   lightness and hue (a dark teal holds less chroma than its body);
 * - hue turned halfway to a target, at most 35°: warm bodies (hue 330° to 115°: pinks, reds,
 *   oranges, yellows) toward red at 25°, cool ones toward blue-violet at 285°. A yellow body (98°)
 *   gets an orange rim (about 63°), a lime one (121°) a green, a cyan one a blue.
 */
const RIM_DARKER = [0.18, 0.24, 0.3, 0.36] as const;
const RIM_LIGHTER = [0.16, 0.22] as const;
const RIM_CHROMA_GAIN = 1.15;
const RIM_MIN_CHROMA = 0.12;
const RIM_MAX_HUE_TURN = 35;
const RIM_WARM_HUE = 25;
const RIM_COOL_HUE = 285;

type Rgb = readonly [number, number, number];

function hexRgb(hex: string): Rgb {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function rgbHex(rgb: Rgb): string {
  return `#${rgb.map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
}

function encode(channel: number): number {
  const value = Math.min(1, Math.max(0, channel));
  return (value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055) * 255;
}

function linear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** OKLab (Björn Ottosson, 2020) of an sRGB hex colour. */
function oklab(hex: string): Rgb {
  const [r, g, b] = hexRgb(hex).map(linear) as unknown as Rgb;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Linear sRGB of an OKLab colour (Ottosson's inverse). */
function oklabLinear([lightness, a, b]: Rgb): Rgb {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** OKLCH of a hex colour: lightness, chroma, hue in degrees. */
export function captionEmojiColourLch(hex: string): { readonly l: number; readonly c: number; readonly h: number } {
  const [l, a, b] = oklab(hex);
  return { l, c: Math.hypot(a, b), h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 };
}

/** The hex colour at an OKLCH point, its chroma cut to the sRGB gamut at that lightness and hue. */
function oklchHex(l: number, c: number, h: number): string {
  const angle = (h * Math.PI) / 180;
  const at = (chroma: number) => oklabLinear([l, chroma * Math.cos(angle), chroma * Math.sin(angle)]);
  const inside = (rgb: Rgb) => rgb.every((channel) => channel >= -1e-4 && channel <= 1 + 1e-4);
  let chroma = c;
  if (!inside(at(chroma))) {
    let lo = 0;
    let hi = chroma;
    for (let step = 0; step < 24; step++) {
      const mid = (lo + hi) / 2;
      if (inside(at(mid))) lo = mid;
      else hi = mid;
    }
    chroma = lo;
  }
  return rgbHex(at(chroma).map(encode) as unknown as Rgb);
}

/** The body's shade `dl` lighter (negative: darker), as the rim rule above derives it. */
function rimShade(body: string, dl: number): string {
  const { l, c, h } = captionEmojiColourLch(body);
  const target = h >= 330 || h < 115 ? RIM_WARM_HUE : RIM_COOL_HUE;
  const toward = ((target - h + 540) % 360) - 180;
  const hue = h + Math.sign(toward) * Math.min(RIM_MAX_HUE_TURN, Math.abs(toward) / 2);
  return oklchHex(Math.min(1, Math.max(0, l + dl)), Math.max(c * RIM_CHROMA_GAIN, RIM_MIN_CHROMA), (hue + 360) % 360);
}

/** ΔEok between two hex colours. */
export function captionEmojiColourDistance(left: string, right: string): number {
  const [l1, a1, b1] = oklab(left);
  const [l2, a2, b2] = oklab(right);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/** The template colours a palette is built from, as a Scene Style resolves them (`sceneInputFromPreset`). */
export interface CaptionEmojiTemplateColours {
  readonly primary: string;
  readonly highlight: string;
  readonly accent: string;
  readonly shadow: string;
}

/**
 * A preset's template colours, the one rule for every preset kind so the worker and the Studio
 * agree. A Scene Style resolves them as `sceneInputFromPreset` does (its sample's accent when the
 * preset has none); a Dynamic Style's accent is its slot colour; a classic preset has no accent of
 * its own and uses its highlight.
 */
export function captionEmojiTemplateColours(
  preset: Pick<CaptionPreset, "scene" | "dynamic" | "primaryColor" | "highlightColor" | "accentColor" | "shadowColor">,
): CaptionEmojiTemplateColours {
  const accent = preset.scene
    ? (preset.accentColor ?? captionSceneMeta(preset.scene).colours.accent)
    : preset.dynamic
      ? (preset.accentColor ?? captionDynamicStyle(preset.dynamic).accentColor ?? preset.highlightColor)
      : (preset.accentColor ?? preset.highlightColor);
  return { primary: preset.primaryColor, highlight: preset.highlightColor, accent, shadow: preset.shadowColor };
}

/**
 * The emoji palette that matches a template: body `a` = highlight, rim `b` =
 * accent, detail `c` = primary (white when the primary is too close to the
 * ink). A body too close to the detail, the ink or the sticker's white, or with
 * too little colour, becomes the accent, else the first fallback that passes; a rim too close to the body, the detail or the
 * sticker's white outline is derived from the body as a clean shade of it (the
 * rim rule above). Deterministic; returns lower-case hex. The owner's named
 * palettes and a preset's own palette never pass through here
 * (`resolveCaptionEmojiPalette`).
 */
export function captionEmojiPalette(colours: CaptionEmojiTemplateColours): CaptionEmojiPalette {
  const primary = colours.primary.toLowerCase();
  const c = captionEmojiColourDistance(primary, CAPTION_EMOJI_INK) >= CAPTION_EMOJI_MIN_DETAIL_INK ? primary : DETAIL_FALLBACK;
  const separates = (body: string) =>
    captionEmojiColourDistance(body, CAPTION_EMOJI_INK) >= CAPTION_EMOJI_MIN_BODY_INK &&
    captionEmojiColourDistance(body, c) >= CAPTION_EMOJI_MIN_BODY_DETAIL &&
    captionEmojiColourDistance(body, CAPTION_EMOJI_STICKER_WHITE) >= CAPTION_EMOJI_MIN_BODY_WHITE &&
    captionEmojiColourLch(body).c >= CAPTION_EMOJI_MIN_BODY_CHROMA;
  const bodies = [colours.highlight.toLowerCase(), colours.accent.toLowerCase(), ...BODY_FALLBACKS];
  const a = bodies.find(separates) ??
    // Unreachable for any `c` (the fallbacks are far apart), kept so the result is always defined.
    [...BODY_FALLBACKS].sort((left, right) => captionEmojiColourDistance(right, c) - captionEmojiColourDistance(left, c))[0]!;
  return { a, b: captionEmojiRim(a, c, colours.accent), c };
}

/** The template's accent as the rim when it separates from the body, the detail and the sticker's white, else a shade of the body. */
function captionEmojiRim(a: string, c: string, accentColour: string): string {
  const rimSeparates = (rim: string) =>
    captionEmojiColourDistance(rim, a) >= CAPTION_EMOJI_MIN_RIM_BODY &&
    captionEmojiColourDistance(rim, c) >= CAPTION_EMOJI_MIN_RIM_APART &&
    captionEmojiColourDistance(rim, CAPTION_EMOJI_STICKER_WHITE) >= CAPTION_EMOJI_MIN_RIM_APART;
  const accent = accentColour.toLowerCase();
  if (rimSeparates(accent)) return accent;
  const shades = [...RIM_DARKER.map((step) => rimShade(a, -step)), ...RIM_LIGHTER.map((step) => rimShade(a, step))];
  // Unreachable for the catalog (tested), kept so the result is always defined: the ink separates from any passing body.
  return shades.find(rimSeparates) ?? CAPTION_EMOJI_INK;
}

/** The preset's own palette when it has one (a named palette or Custom), else the template's. Every design takes it, faces included. */
export function resolveCaptionEmojiPalette(
  preset: Pick<CaptionPreset, "emojiPalette">,
  colours: CaptionEmojiTemplateColours,
): CaptionEmojiPalette {
  return preset.emojiPalette ?? captionEmojiPalette(colours);
}

// ─── Density ────────────────────────────────────────────────────────────────

/** Least edited-time gap between two AI emojis, in seconds, per density. */
export const CAPTION_EMOJI_DENSITIES = { light: 5, balanced: 2.5, expressive: 1.5 } as const;
export const captionEmojiDensitySchema = z.enum(["light", "balanced", "expressive"]);
export type CaptionEmojiDensity = z.infer<typeof captionEmojiDensitySchema>;
export const DEFAULT_CAPTION_EMOJI_DENSITY: CaptionEmojiDensity = "balanced";

/**
 * The least strength a pick needs per density: Light keeps only picks that picture their word
 * itself (3), Balanced and Expressive also those that picture what their phrase says (2).
 * Strength 1 ("only related") never reaches here: acceptance drops it. Light has fewer emojis
 * from this gate and its wider gap; Expressive differs from Balanced by its gap only.
 */
export const CAPTION_EMOJI_DENSITY_MIN_STRENGTH = { light: 3, balanced: 2, expressive: 2 } as const satisfies Record<CaptionEmojiDensity, number>;

/**
 * The same emoji id does not repeat within this many seconds of edited time. At 10 s a 75 s clip
 * showed the same phone four times (ticket 23), each pick defensible, together repetitive.
 */
export const CAPTION_EMOJI_REPEAT_GAP_SEC = 20;

/** One AI suggestion: a Word Key, the emoji, and a strength 1 (weak) to 3 (strong). */
export interface CaptionEmojiPick {
  readonly key: string;
  readonly ref: CaptionEmojiRef;
  readonly strength: number;
}

/** A kept word of the clip: its Word Key and its start in edited time. */
export interface CaptionEmojiPickWord {
  readonly key: string;
  readonly editedStartSec: number;
}

/**
 * The picks a clip keeps at `density`. Picks on a word the clip does not keep,
 * and picks under the density's strength (`CAPTION_EMOJI_DENSITY_MIN_STRENGTH`),
 * are dropped. Acceptance keeps several picks a sentence, so this is the only
 * spacing rule. Strongest first and earliest on a tie, a pick is taken when no
 * taken pick is within the density's gap and no taken pick of the same id is
 * within `CAPTION_EMOJI_REPEAT_GAP_SEC`. The opening (hook) pick has no other privilege: it wins only a
 * tie, because it is the earliest; a weaker pick never displaces a stronger
 * one. At most `CAPTION_EMOJI_LIMIT` are kept.
 */
export function selectCaptionEmojiPicks(
  picks: readonly CaptionEmojiPick[],
  words: readonly CaptionEmojiPickWord[],
  density: CaptionEmojiDensity,
): Record<string, CaptionEmojiRef> {
  const startByKey = new Map(words.map((word) => [word.key, word.editedStartSec]));
  const minStrength = CAPTION_EMOJI_DENSITY_MIN_STRENGTH[density];
  const candidates = picks
    .flatMap((pick) => {
      const atSec = startByKey.get(pick.key);
      return atSec === undefined || pick.strength < minStrength ? [] : [{ ...pick, atSec }];
    })
    .sort((left, right) => right.strength - left.strength || left.atSec - right.atSec || Number(left.key) - Number(right.key));
  const gapSec = CAPTION_EMOJI_DENSITIES[density];
  const taken: (typeof candidates)[number][] = [];
  for (const pick of candidates) {
    if (taken.length === CAPTION_EMOJI_LIMIT) break;
    const conflicts = taken.some((other) => {
      const apart = Math.abs(other.atSec - pick.atSec);
      return apart < gapSec || (other.ref.id === pick.ref.id && apart < CAPTION_EMOJI_REPEAT_GAP_SEC);
    });
    if (!conflicts) taken.push(pick);
  }
  taken.sort((left, right) => left.atSec - right.atSec);
  return Object.fromEntries(taken.map((pick) => [pick.key, { ...pick.ref }]));
}

// ─── Anchors ────────────────────────────────────────────────────────────────

/**
 * A caption word's text as captions compare it: NFKC, lower case, letters, digits and marks only.
 * Styles change case and punctuation, so "Party!" and "party" are the same word; combining marks
 * stay, so Devanagari and Arabic words that differ only in a vowel sign stay different.
 */
export function captionWordComparable(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase("und").replace(/[^\p{L}\p{N}\p{M}]/gu, "");
}

/** An entry may move to a word at most this far from its Word Key, in source milliseconds. */
export const CAPTION_EMOJI_ANCHOR_TOLERANCE_MS = 400;

/** A word an entry can anchor to: every word of the transcript, cut or not, with its utterance's source span. */
export interface CaptionEmojiAnchorWord {
  readonly key: string;
  /** The word's transcript text; absent where there is no word to check (an untimed utterance). */
  readonly text?: string;
  readonly sourceStartSec: number;
  readonly utteranceIndex: number;
  readonly utteranceStartSec: number;
  readonly utteranceEndSec: number;
}

/**
 * The word each stored entry belongs to, as an index into `words`. An entry
 * takes the word with its exact key, else the word whose source start is
 * nearest within 400 ms; when the key falls inside utterance spans, only the
 * words of those utterances count (all of them when speakers overlap), so an
 * entry never jumps to the next line. An entry that stores its `word` takes
 * only a word with that text (`captionWordComparable`), its exact key's word
 * included: an emoji illustrates its word and never re-attaches to another.
 * Two entries on one word: the nearer keeps it, the smaller key on a tie.
 * Entries with no word are absent. Pass cut and censored words too and skip
 * them after resolving, so an emoji on a removed word disappears instead of
 * moving.
 */
export function resolveCaptionEmojiAnchors(
  entries: Readonly<Record<string, Pick<CaptionEmojiRef, "word">>>,
  words: readonly CaptionEmojiAnchorWord[],
): Map<string, number> {
  const byKey = new Map<string, number>();
  words.forEach((word, index) => {
    if (!byKey.has(word.key)) byKey.set(word.key, index);
  });
  const owner = new Map<number, { key: string; distanceMs: number }>();
  for (const [key, entry] of Object.entries(entries)) {
    const keyMs = Number(key);
    if (!Number.isFinite(keyMs)) continue;
    const wanted = entry.word === undefined ? null : captionWordComparable(entry.word);
    const sameWord = (word: CaptionEmojiAnchorWord) => wanted === null || word.text === undefined || captionWordComparable(word.text) === wanted;
    let index = byKey.get(key);
    let distanceMs = 0;
    if (index !== undefined && !sameWord(words[index]!)) index = undefined;
    if (index === undefined) {
      const keySec = keyMs / 1000;
      const holding = new Set(words.filter((word) => keySec >= word.utteranceStartSec && keySec <= word.utteranceEndSec).map((word) => word.utteranceIndex));
      distanceMs = CAPTION_EMOJI_ANCHOR_TOLERANCE_MS + 1;
      for (const [candidate, word] of words.entries()) {
        if ((holding.size > 0 && !holding.has(word.utteranceIndex)) || !sameWord(word)) continue;
        const distance = Math.abs(Math.round(word.sourceStartSec * 1000) - keyMs);
        if (distance < distanceMs) {
          index = candidate;
          distanceMs = distance;
        }
      }
      if (index === undefined) continue;
    }
    const current = owner.get(index);
    if (current && (current.distanceMs < distanceMs || (current.distanceMs === distanceMs && Number(current.key) < keyMs))) continue;
    owner.set(index, { key, distanceMs });
  }
  return new Map([...owner].map(([index, entry]) => [entry.key, index]));
}

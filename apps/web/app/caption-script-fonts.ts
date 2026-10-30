/**
 * The browser's glyph fallback chain behind every caption face, in the order
 * the worker's glyph planner tries them (packages/caption-fonts
 * fallback-fonts.ts, apps/worker/src/caption-glyphs.ts):
 *
 *   requested face -> the face for the cue's language -> script faces
 *   -> Noto Sans Symbols 2 -> Noto Emoji
 *
 * The faces themselves are @font-face rules in caption-script-fonts.css. Each
 * carries a unicode-range, so a browser downloads one only when a character in
 * that range gets past the faces before it. caption-script-fonts.test.ts holds
 * this table to the worker's.
 */

import { captionShapingSensitivity, isShapingSensitiveText } from "@narriflow/caption-fonts/locale-precedence";
import { captionGraphemes } from "@narriflow/caption-fonts/emoji";

export interface CaptionScriptFace {
  /** The @font-face family: `family` in packages/caption-fonts/script-fonts.manifest.json. */
  readonly family: string;
  /** Vendored file name; the test matches it to the worker's fallback list. */
  readonly file: string;
  /** Complex and cursive scripts take no letter spacing and are never split letter by letter. */
  readonly letterSpacing: "preserved" | "disabled";
  /** Draws a script the chain's default face already covers, in the style of these languages. */
  readonly languages?: readonly string[];
}

export const CAPTION_SCRIPT_FACES: readonly CaptionScriptFace[] = [
  { family: "Noto Sans", file: "NotoSans-Regular.ttf", letterSpacing: "preserved" },
  { family: "Noto Sans Arabic", file: "NotoSansArabic-Regular.ttf", letterSpacing: "disabled" },
  { family: "Noto Sans Hebrew", file: "NotoSansHebrew-Regular.ttf", letterSpacing: "disabled" },
  { family: "Noto Sans Devanagari", file: "NotoSansDevanagari-Regular.ttf", letterSpacing: "disabled" },
  { family: "Noto Sans Thai", file: "NotoSansThai-Regular.ttf", letterSpacing: "disabled" },
  { family: "Noto Sans Armenian", file: "NotoSansArmenian-Regular.ttf", letterSpacing: "preserved" },
  { family: "Noto Sans Bengali", file: "NotoSansBengali-Regular.ttf", letterSpacing: "disabled" },
  { family: "Noto Sans Gurmukhi", file: "NotoSansGurmukhi-Regular.ttf", letterSpacing: "disabled" },
  { family: "Noto Sans Gujarati", file: "NotoSansGujarati-Regular.ttf", letterSpacing: "disabled" },
  { family: "Noto Sans Oriya", file: "NotoSansOriya-Regular.ttf", letterSpacing: "disabled" },
  { family: "Noto Sans Tamil", file: "NotoSansTamil-Regular.ttf", letterSpacing: "disabled" },
  { family: "Noto Sans Telugu", file: "NotoSansTelugu-Regular.ttf", letterSpacing: "disabled" },
  { family: "Noto Sans Kannada", file: "NotoSansKannada-Regular.ttf", letterSpacing: "disabled" },
  { family: "Noto Sans Malayalam", file: "NotoSansMalayalam-Regular.ttf", letterSpacing: "disabled" },
  { family: "Noto Sans Sinhala", file: "NotoSansSinhala-Regular.ttf", letterSpacing: "disabled" },
  { family: "Noto Sans Lao", file: "NotoSansLao-Regular.ttf", letterSpacing: "disabled" },
  { family: "Noto Sans Khmer", file: "NotoSansKhmer-Regular.ttf", letterSpacing: "disabled" },
  { family: "Noto Sans Myanmar", file: "NotoSansMyanmar-Regular.ttf", letterSpacing: "disabled" },
  { family: "Noto Sans Georgian", file: "NotoSansGeorgian-Regular.ttf", letterSpacing: "preserved" },
  { family: "Noto Sans Ethiopic", file: "NotoSansEthiopic-Regular.ttf", letterSpacing: "preserved" },
  { family: "Noto Sans SC", file: "NotoSansSC-Regular.otf", letterSpacing: "preserved" },
  { family: "Noto Sans KR", file: "NotoSansKR-Regular.otf", letterSpacing: "preserved" },
  { family: "Noto Sans JP", file: "NotoSansJP-Regular.otf", letterSpacing: "preserved", languages: ["ja"] },
  { family: "Noto Sans TC", file: "NotoSansTC-Regular.otf", letterSpacing: "preserved", languages: ["yue"] },
  { family: "Noto Nastaliq Urdu", file: "NotoNastaliqUrdu-Regular.ttf", letterSpacing: "disabled", languages: ["ur"] },
];

/** Drawn after every script face, as in the worker: symbols, then monochrome emoji. */
export const CAPTION_SYMBOL_FAMILIES = ["Noto Sans Symbols 2", "Noto Emoji"] as const;

/**
 * Fallback families for text in `language`: the language's own face first,
 * then the default faces in chain order. A language-aware face is skipped for
 * other languages (the default face before it always wins, as in the worker).
 */
export function captionFallbackFamilies(language?: string | null): string[] {
  const own = CAPTION_SCRIPT_FACES.filter((face) => language && face.languages?.includes(language));
  const defaults = CAPTION_SCRIPT_FACES.filter((face) => !face.languages);
  return [...own, ...defaults].map((face) => face.family).concat(CAPTION_SYMBOL_FAMILIES);
}

/** The CSS `font-family` for a caption face: the face, then its fallbacks for `language`. */
export function captionFontStack(face: string, language?: string | null): string {
  return [face, ...captionFallbackFamilies(language).map((family) => `"${family}"`), "sans-serif"].join(", ");
}

// Joining and complex scripts take no letter spacing and reveal word by word:
// the worker's own rule (captionShapingSensitivity), so preview and burn-in agree.

/** True when any character of `text` is in a script that takes no letter spacing. */
export function hasUnspacedScript(text: string): boolean {
  return isShapingSensitiveText(text);
}

/**
 * Splits text into runs that take the cue's letter spacing and runs that must
 * not: the same per-face `\fsp0` the burn-in applies. Ordinary text is one run.
 */
export function captionLetterSpacingRuns(text: string): { text: string; spaced: boolean }[] {
  const runs: { text: string; spaced: boolean }[] = [];
  for (const char of text) {
    // Digits, punctuation, spaces and marks take the run they sit in.
    const sensitivity = captionShapingSensitivity(char);
    const spaced =
      sensitivity === "sensitive"
        ? false
        : sensitivity === "neutral" && runs.length > 0
          ? runs[runs.length - 1]!.spaced
          : true;
    const last = runs[runs.length - 1];
    if (last && last.spaced === spaced) last.text += char;
    else runs.push({ text: char, spaced });
  }
  return runs;
}

// ─── Pill and plate extent ──────────────────────────────────────────────────

/**
 * Room left below fallback-face ink that hangs under the baseline. The same
 * number as CAPTION_INK_MARGIN_EM in apps/worker/src/caption-ass.ts, which
 * caption-script-fonts.test.ts holds this to.
 */
export const CAPTION_INK_MARGIN_EM = 0.06;

/** Highest ink above and deepest ink below the baseline, in em; both 0 for no ink. */
export interface CaptionInkEm {
  readonly topEm: number;
  readonly bottomEm: number;
}

export const NO_CAPTION_INK: CaptionInkEm = { topEm: 0, bottomEm: 0 };

/**
 * Vertical extent of a pill or plate around the baseline, as the burn-in
 * draws it (decorationSpan in apps/worker/src/caption-ass.ts): padding above
 * the cap height and below the baseline, grown to the ink of fallback-face
 * glyphs that stand taller or hang lower. A pill takes its word's ink, a plate
 * the whole line's. Without fallback ink this is the catalog metrics exactly.
 */
export function captionDecorationExtentEm(
  capHeightEm: number,
  pad: { readonly padTopEm: number; readonly padBottomEm: number },
  ink: CaptionInkEm,
): { aboveBaselineEm: number; belowBaselineEm: number } {
  return {
    aboveBaselineEm: Math.max(capHeightEm, ink.topEm) + pad.padTopEm,
    belowBaselineEm: Math.max(pad.padBottomEm, ink.bottomEm + CAPTION_INK_MARGIN_EM),
  };
}

/**
 * The runs of `text` the requested face does not draw (the burn-in's `inked`
 * parts: a different face draws them): neighbouring clusters stay together so
 * marks shape with their base.
 */
export function captionFallbackRuns(text: string, drawnByRequested: (cluster: string) => boolean): string[] {
  const runs: string[] = [];
  let open = false;
  for (const cluster of captionGraphemes(text)) {
    if (drawnByRequested(cluster)) {
      open = false;
    } else if (open) {
      runs[runs.length - 1] += cluster;
    } else {
      runs.push(cluster);
      open = true;
    }
  }
  return runs;
}

/** Ink of the fallback-drawn runs of `text`: the highest and the deepest among them. */
export function captionFallbackInkEm(
  text: string,
  drawnByRequested: (cluster: string) => boolean,
  measureRun: (run: string) => CaptionInkEm,
): CaptionInkEm {
  let topEm = 0;
  let bottomEm = 0;
  for (const run of captionFallbackRuns(text, drawnByRequested)) {
    const ink = measureRun(run);
    topEm = Math.max(topEm, ink.topEm);
    bottomEm = Math.max(bottomEm, ink.bottomEm);
  }
  return topEm === 0 && bottomEm === 0 ? NO_CAPTION_INK : { topEm, bottomEm };
}

const MEASURE_PX = 100;
let measureContext: CanvasRenderingContext2D | null = null;
const inkCache = new Map<string, CaptionInkEm>();

function canvasContext(): CanvasRenderingContext2D | null {
  if (!measureContext && typeof document !== "undefined") measureContext = document.createElement("canvas").getContext("2d");
  return measureContext;
}

/** Scripts beyond Latin that a catalog face draws itself, as `fontFileCovers` reports them (caption-script-fonts.test.ts holds the table to the files). */
export type CaptionOwnScript = "Cyrillic" | "Greek";

export const CAPTION_FACE_OWN_SCRIPTS: Readonly<Record<string, readonly CaptionOwnScript[]>> = {
  Inter: ["Cyrillic", "Greek"],
  "Inter SemiBold": ["Cyrillic", "Greek"],
  "Open Sans": ["Cyrillic", "Greek"],
  Roboto: ["Cyrillic", "Greek"],
  Montserrat: ["Cyrillic"],
  Oswald: ["Cyrillic"],
  Unbounded: ["Cyrillic"],
};

const LATIN_RE = /^[\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]*$/u;
const OWN_SCRIPT_RE: Record<CaptionOwnScript, RegExp> = {
  Cyrillic: /\p{Script=Cyrillic}/u,
  Greek: /\p{Script=Greek}/u,
};

/**
 * Whether the requested face draws a cluster: Latin, digits and punctuation
 * always, and the extra scripts the face covers. Any other script goes to the
 * fallback chain, as in the burn-in's glyph planner. A brand font is taken for
 * a Latin face, since its coverage is not known here.
 */
export function captionFaceDraws(cluster: string, ownScripts: readonly CaptionOwnScript[] = []): boolean {
  if (LATIN_RE.test(cluster)) return true;
  const stripped = ownScripts.reduce((rest, script) => rest.replace(new RegExp(OWN_SCRIPT_RE[script].source, "gu"), ""), cluster);
  return LATIN_RE.test(stripped);
}

/**
 * True when `cluster` adds no ink to the extent: the requested face draws it
 * and it is not shaping-sensitive. Everything else counts, as the burn-in's
 * `inked` parts do: text a fallback face draws, and Arabic, Indic and the like
 * in any face, an uploaded one included. A brand font's coverage is not known
 * here, so its other non-Latin clusters count as fallback text.
 */
function addsNoInk(cluster: string, ownScripts: readonly CaptionOwnScript[]): boolean {
  return captionFaceDraws(cluster, ownScripts) && captionShapingSensitivity(cluster) !== "sensitive";
}

/**
 * Whether every face of the stack that may draw `run` has loaded. A lazy script
 * face (Noto Nastaliq Urdu) starts out missing, and Canvas then measures the
 * glyphs in whatever stands in for it; such a reading must not be kept.
 */
function stackLoaded(prefix: string, families: readonly string[], run: string): boolean {
  return families.every((family) => document.fonts.check(`${prefix} ${family}`, run));
}

/**
 * Measures, in the browser, the ink the burn-in counts for a word: the shaped
 * glyphs of the faces other than the requested one, and of shaping-sensitive
 * scripts in any face. `requestedFamily` is the face's resolved CSS family;
 * until it has loaded the stack cannot be measured, so the catalog metrics
 * stand. A run is cached only once every face of the stack that covers it has
 * loaded; before that it is measured again on each call, and the caller calls
 * again when fonts arrive (`loadingdone`).
 */
export function measureCaptionFallbackInkEm(
  text: string,
  face: {
    readonly requestedFamily: string;
    readonly weight: number;
    readonly style: string;
    readonly language?: string | null;
    readonly ownScripts?: readonly CaptionOwnScript[];
  },
): CaptionInkEm {
  const context = canvasContext();
  if (!context || text.length === 0) return NO_CAPTION_INK;
  const prefix = `${face.style} ${face.weight} ${MEASURE_PX}px`;
  if (!document.fonts?.check(`${prefix} ${face.requestedFamily}`)) return NO_CAPTION_INK;
  const stack = captionFontStack(face.requestedFamily, face.language);
  const families = [face.requestedFamily, ...captionFallbackFamilies(face.language).map((family) => `"${family}"`)];
  const measureRun = (run: string): CaptionInkEm => {
    const key = `${prefix} ${stack}\0${run}`;
    const cached = inkCache.get(key);
    if (cached) return cached;
    context.font = `${prefix} ${stack}`;
    const metrics = context.measureText(run);
    const ink = {
      topEm: Math.max(0, metrics.actualBoundingBoxAscent) / MEASURE_PX,
      bottomEm: Math.max(0, metrics.actualBoundingBoxDescent) / MEASURE_PX,
    };
    if (stackLoaded(prefix, families, run)) {
      if (inkCache.size > 5000) inkCache.clear();
      inkCache.set(key, ink);
    }
    return ink;
  };
  return captionFallbackInkEm(text, (cluster) => addsNoInk(cluster, face.ownScripts ?? []), measureRun);
}

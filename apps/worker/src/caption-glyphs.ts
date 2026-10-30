import {
  CAPTION_FALLBACK_FONTS,
  captionFallbackFontPath,
  captionFontFilePath,
  captionCodePointLabel,
  captionGraphemes,
  fontFileCovers,
  fontFileMetricsEm,
  isCaptionEmojiCluster,
  orderCaptionFallbackFaces,
} from "@narriflow/caption-fonts";
import type { CaptionFontFace } from "@narriflow/validators";

/**
 * Glyph coverage for caption text. libass asks the host for a fallback font
 * whenever the caption face lacks a glyph, so which fallback an export used
 * depended on the machine (macOS drew boxes for CJK, Linux used whatever Noto
 * was installed). The planner here chooses the face itself, from vendored
 * files only, and the ASS text switches fonts with explicit `\fn` runs:
 *
 *   requested face -> saved built-in face -> pinned Noto script face
 *   -> Noto Sans Symbols 2 -> monochrome Noto Emoji
 *
 * The script faces are tried in catalog order except that the cue's language
 * moves its own face first for the runs it leads (ja -> Noto Sans JP for Han
 * and kana, yue -> Noto Sans TC for Han, ur -> Noto Nastaliq Urdu for Arabic
 * script; `orderCaptionFallbackFaces`, shared with the Studio). A requested or
 * saved face that covers the glyphs always wins over them.
 *
 * Emoji-presentation clusters skip straight to the last two. A code point no
 * face covers is left out of the burned text (only that code point, never the
 * cue) and reported as `caption_glyph_omitted`; a symbol or emoji drawn by the
 * last two faces is reported as `glyph_fallback_used`.
 */

export type CaptionFaceRole = "requested" | "saved" | "script" | "symbols" | "monochrome-emoji";

export interface CaptionFace {
  /** Name libass matches in the fonts directory. */
  readonly assName: string;
  readonly path: string;
  /** Win ascent + descent per em: the ASS font size that draws one em. */
  readonly lineHeightEm: number;
  /** Win ascent and descent per em: libass lays a line out with the largest of each among its faces. */
  readonly ascentEm: number;
  readonly descentEm: number;
  readonly role: CaptionFaceRole;
  /** `disabled`: draw this face with `\fsp0` (cursive and complex scripts). */
  readonly letterSpacing?: "preserved" | "disabled";
}

export interface CaptionGlyphNotice {
  readonly code: "glyph_fallback_used";
  readonly cluster: string;
  readonly font: string;
  /** The cluster is a ZWJ, skin-tone or flag sequence drawn as separate monochrome pictures. */
  readonly sequenceSplit: boolean;
}

/** A code point left out of the burned text because no pinned face draws it. */
export interface OmittedGlyph {
  readonly codePoint: string;
  readonly cueIndex: number;
}

/** A plan emoji the atlas and the monochrome face cannot draw; its overlay is skipped. */
export interface SkippedEmoji {
  readonly emoji: string;
  readonly cueIndex: number;
}

export interface UnavailableGlyph {
  readonly cluster: string;
  readonly codePoints: readonly string[];
}

/** Permanent: libass still reports a missing glyph after the render was redone without it. */
export class CaptionGlyphUnavailableError extends Error {
  readonly code = "caption_glyph_unavailable";
  readonly disposition = "permanent" as const;
  constructor(readonly glyphs: readonly UnavailableGlyph[]) {
    super(
      `No pinned caption face has a glyph for ${glyphs
        .slice(0, 5)
        .map((glyph) => glyph.codePoints.join(" "))
        .join(", ")}${glyphs.length > 5 ? ` and ${glyphs.length - 5} more` : ""}`,
    );
  }
}

export function catalogCaptionFace(face: CaptionFontFace, role: "requested" | "saved"): CaptionFace {
  return { assName: face.assName, path: captionFontFilePath(face.file), lineHeightEm: face.ascent + face.descent, ascentEm: face.ascent, descentEm: face.descent, role };
}

/** The face of an uploaded brand font, read from the saved file's metrics. */
export function brandCaptionFace(face: CaptionFontFace, path: string): CaptionFace {
  return { assName: face.assName, path, lineHeightEm: face.ascent + face.descent, ascentEm: face.ascent, descentEm: face.descent, role: "requested" };
}

const FALLBACK_FACES: readonly (CaptionFace & { readonly languages?: readonly string[] })[] = CAPTION_FALLBACK_FONTS.map((font) => {
  const path = captionFallbackFontPath(font);
  const { ascentEm, descentEm } = fontFileMetricsEm(path);
  return {
    assName: font.assName,
    path,
    lineHeightEm: ascentEm + descentEm,
    ascentEm,
    descentEm,
    role: font.role,
    letterSpacing: font.letterSpacing,
    ...("languages" in font ? { languages: font.languages } : {}),
  };
});
const SCRIPT_FACES = FALLBACK_FACES.filter((face) => face.role === "script");
const SYMBOLS_FACE = FALLBACK_FACES.find((face) => face.role === "symbols")!;
const EMOJI_FACE = FALLBACK_FACES.find((face) => face.role === "monochrome-emoji")!;

/** Code point ranges that draw nothing and ride with the glyph before them. */
const IGNORABLE_RANGES: readonly (readonly [number, number])[] = [
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xe0020, 0xe007f],
];
const isIgnorable = (character: string): boolean => {
  const codePoint = character.codePointAt(0)!;
  return IGNORABLE_RANGES.some(([from, to]) => codePoint >= from && codePoint <= to);
};
const NEUTRAL = /^[\p{Z}\p{P}\p{N}]$/u;
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;
/** Clusters that ask for emoji presentation: default-emoji code points, U+FE0F or keycaps. */
const emojiPresentation = (cluster: string): boolean =>
  EMOJI_PRESENTATION.test(cluster) || cluster.includes("\ufe0f") || cluster.includes("\u20e3");

export interface PlannedPart {
  readonly text: string;
  readonly face: CaptionFace;
}

/** One user-perceived character and the face(s) that draw it. */
export interface PlannedCluster {
  readonly text: string;
  readonly parts: readonly PlannedPart[];
}

export class CaptionGlyphPlanner {
  private readonly leading: readonly CaptionFace[];
  private readonly plans = new Map<string, PlannedCluster[]>();

  constructor(
    readonly requested: CaptionFace,
    saved: CaptionFace | null,
    private readonly report: { notices: Map<string, CaptionGlyphNotice>; omitted: Map<string, OmittedGlyph> },
    private readonly cueIndex: number,
    /** Code points to leave out regardless (libass reported them after a render). */
    private readonly forcedOmissions: ReadonlySet<number> = new Set(),
    /** The cue's effective caption language: picks the language-aware face for a script run. */
    private readonly language: string | null = null,
  ) {
    this.leading = [requested, ...(saved ? [saved] : [])];
  }

  /** Planned clusters of `text`, memoized: every layer of a cue plans the same words. */
  plan(text: string): PlannedCluster[] {
    const cached = this.plans.get(text);
    if (cached) return cached;
    let current: CaptionFace = this.requested;
    const clusters = captionGraphemes(text).map((cluster) => {
      const parts = this.partsFor(cluster, current);
      current = parts[parts.length - 1]?.face ?? current;
      return { text: cluster, parts };
    });
    this.plans.set(text, clusters);
    return clusters;
  }

  private partsFor(cluster: string, current: CaptionFace): PlannedPart[] {
    const mandatory = [...cluster].filter((character) => !isIgnorable(character));
    if (mandatory.length === 0) return [{ text: cluster, face: current }];
    const emoji = emojiPresentation(cluster);
    const forced = mandatory.some((character) => this.forcedOmissions.has(character.codePointAt(0)!));
    const whole = forced ? null : this.faceCovering(mandatory.join(""), emoji, current);
    if (whole) return [this.note(cluster, whole)];
    // No face draws the cluster in one piece: draw it code point by code point,
    // leaving out only the code points nothing draws.
    const parts: PlannedPart[] = [];
    let previous = current;
    let pending = "";
    for (const character of cluster) {
      if (isIgnorable(character)) {
        pending += character;
        continue;
      }
      const codePoint = character.codePointAt(0)!;
      const face = this.forcedOmissions.has(codePoint) ? null : this.faceCovering(character, emoji, previous);
      if (!face) {
        const label = captionCodePointLabel(codePoint);
        this.report.omitted.set(`${this.cueIndex}:${label}`, { codePoint: label, cueIndex: this.cueIndex });
      } else {
        parts.push(this.note(pending + character, face, cluster));
        previous = face;
      }
      pending = "";
    }
    if (pending && parts.length > 0) {
      const last = parts[parts.length - 1]!;
      parts[parts.length - 1] = { text: last.text + pending, face: last.face };
    }
    return parts;
  }

  private faceCovering(text: string, emoji: boolean, current: CaptionFace): CaptionFace | null {
    const neutral = [...text].every((character) => NEUTRAL.test(character));
    if (neutral && fontFileCovers(current.path, text)) return current;
    const order = emoji ? [EMOJI_FACE, SYMBOLS_FACE] : [...this.leading, ...orderCaptionFallbackFaces(SCRIPT_FACES, this.language, text), SYMBOLS_FACE, EMOJI_FACE];
    return order.find((face) => fontFileCovers(face.path, text)) ?? null;
  }

  private note(text: string, face: CaptionFace, whole = text): PlannedPart {
    if (face.role === "symbols" || face.role === "monochrome-emoji") {
      const sequenceSplit = isCaptionEmojiCluster(whole) && [...whole].filter((character) => !isIgnorable(character)).length > 1;
      this.report.notices.set(`${face.assName}\0${whole}`, {
        code: "glyph_fallback_used",
        cluster: whole,
        font: face.assName,
        sequenceSplit,
      });
    }
    return { text, face };
  }
}

/** The monochrome emoji face and its coverage check, for plan emoji the atlas lacks. */
export function monochromeEmojiFace(): CaptionFace {
  return EMOJI_FACE;
}

// ---------------------------------------------------------------------------
// ffmpeg diagnostics
// ---------------------------------------------------------------------------

/** libass and drawtext lines worth keeping from an encode's stderr. */
export const CAPTION_RENDER_DIAGNOSTIC_PATTERN =
  /fontselect: failed to find any fallback|Glyph 0x[0-9a-f]+ not found|Error opening font|Parsed_drawtext[^\]]*\].*(?:error|fail|cannot|could not|unable|invalid|not found)|Failed to open font|Cannot find a valid font|Could not (?:load|open) font/i;

export interface CaptionRenderDiagnostics {
  /** No face, vendored or host, had the glyph (libass drew a box). Permanent. */
  readonly missingGlyphs: readonly string[];
  /** libass asked the host for a font: the render is correct only on this machine. */
  readonly hostFallbacks: readonly string[];
  /** drawtext/libass could not open or parse a font or text. */
  readonly parseErrors: readonly string[];
}

/** Sort captured encode stderr lines, which matter even when ffmpeg exits zero. */
export function classifyCaptionRenderDiagnostics(lines: readonly string[]): CaptionRenderDiagnostics {
  const missingGlyphs: string[] = [];
  const hostFallbacks: string[] = [];
  const parseErrors: string[] = [];
  for (const line of lines) {
    if (/fontselect: failed to find any fallback/i.test(line)) missingGlyphs.push(line);
    else if (/Glyph 0x[0-9a-f]+ not found/i.test(line)) hostFallbacks.push(line);
    else if (CAPTION_RENDER_DIAGNOSTIC_PATTERN.test(line)) parseErrors.push(line);
  }
  return { missingGlyphs, hostFallbacks, parseErrors };
}

/** The permanent failure for diagnostics that prove an unrenderable glyph, or null. */
export function captionRenderDiagnosticsFailure(diagnostics: CaptionRenderDiagnostics): CaptionGlyphUnavailableError | null {
  const codePoints = new Set<string>();
  for (const line of [...diagnostics.missingGlyphs, ...diagnostics.parseErrors]) {
    const match = /glyph (0x[0-9a-f]+)/i.exec(line);
    if (match) codePoints.add(captionCodePointLabel(Number.parseInt(match[1]!, 16)));
  }
  if (diagnostics.missingGlyphs.length === 0) return null;
  return new CaptionGlyphUnavailableError(
    [...codePoints].map((codePoint) => ({ cluster: codePoint, codePoints: [codePoint] })),
  );
}

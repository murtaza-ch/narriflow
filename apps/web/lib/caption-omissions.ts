import { captionCodePointLabel, captionUndrawableCodePoints } from "@narriflow/caption-fonts/glyph-coverage";
import { deriveCaptionCues } from "@narriflow/composition-plan";
import type { ClipRenderCaptionDiagnostics, EditorDocument } from "@narriflow/validators";

/** One character the burn-in cannot draw, shown as its code points (`U+1F1FA`). */
export interface CaptionOmission {
  readonly label: string;
}

export interface CaptionOmissionNote {
  readonly count: number;
  readonly omissions: readonly CaptionOmission[];
}

/**
 * What a finished render left out of its captions, or null when it left
 * nothing out. A skipped emoji lists every code point of its sequence.
 */
export function captionOmissionNote(diagnostics: ClipRenderCaptionDiagnostics | null | undefined): CaptionOmissionNote | null {
  if (!diagnostics) return null;
  const labels = new Set<string>([
    ...diagnostics.omittedCodePoints,
    ...diagnostics.skippedEmoji.map((emoji) => [...emoji].map((character) => captionCodePointLabel(character.codePointAt(0)!)).join(" ")),
  ]);
  if (labels.size === 0) return null;
  return { count: labels.size, omissions: [...labels].map((label) => ({ label })) };
}

/**
 * Characters the export would burn into the captions but cannot draw. It reads
 * the same cues the export draws (`deriveCaptionCues`: cuts, masks, text
 * treatment), so text that does not survive the edit is never reported, and
 * checks them against the pinned fallback chain's coverage. An uploaded caption
 * font tries the character first and may draw it, so the Studio makes no claim
 * for one; the finished render reports what was really left out.
 */
export function studioCaptionOmissionNote(document: EditorDocument): CaptionOmissionNote | null {
  if (document.captionPreset.visible === false || document.captionPreset.fontAsset) return null;
  const labels = captionUndrawableCodePoints(deriveCaptionCues(document).map((cue) => cue.text).join("\n"));
  return labels.length === 0 ? null : { count: labels.length, omissions: labels.map((label) => ({ label })) };
}

const plural = (count: number) => (count === 1 ? "1 character" : `${count} characters`);

/** The clip row's one line, about a render that already happened. */
export const renderedOmissionSummary = (count: number) => `${plural(count)} couldn't be shown`;

/** The Studio's one line, before anything is exported. */
export const editingOmissionSummary = (count: number) =>
  `${plural(count)} can't be shown in exported captions and will be left out.`;

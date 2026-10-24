import { deriveCaptionCues, formatSubtitles, type SubtitleFormat } from "@narriflow/composition-plan";
import { resolveClipRenderTiming, type EditorDocument } from "@narriflow/validators";
import { decodeFrozenClipEditorDocument } from "./clip-editor-document-persistence";

export interface ClipExportSubtitleFile {
  format: SubtitleFormat;
  fileName: string;
  content: string;
}

/** A clip's Clip Editor Document with the bounds and transcript slice an
 * export render uses. Burn-in, subtitle files, and timeline exports all start
 * here, so none of them can disagree about where the clip begins and ends.
 * `clip` is a stored clip or a frozen render snapshot. */
export function resolveRenderedClipDocument(clip: unknown, sourceDurationSec: number | null): EditorDocument {
  const document = decodeFrozenClipEditorDocument(clip, sourceDurationSec);
  const llmModel = typeof (clip as { llmModel?: unknown } | null)?.llmModel === "string"
    ? (clip as { llmModel: string }).llmModel
    : null;
  const timing = resolveClipRenderTiming({
    llmModel,
    startSec: document.clipStartSec,
    endSec: document.clipEndSec,
    utterances: document.transcriptSlice,
  });
  return { ...document, clipStartSec: timing.startSec, clipEndSec: timing.endSec, transcriptSlice: timing.transcriptSlice };
}

/** Subtitles for one export, generated on demand from its frozen render
 * snapshot with the same timing and cue derivation as burned-in captions.
 * Captions turned off for burn-in still yield subtitles. Nothing is stored. */
export function clipExportSubtitleFiles(
  frozenSnapshot: unknown,
  sourceDurationSec: number | null,
  baseFileName: string,
): ClipExportSubtitleFile[] {
  const cues = deriveCaptionCues(resolveRenderedClipDocument(frozenSnapshot, sourceDurationSec), { ignoreVisibility: true });
  return (["srt", "vtt"] as const).map((format) => ({ format, fileName: `${baseFileName}.${format}`, content: formatSubtitles(cues, format) }));
}

import { deriveCaptionCues, formatSubtitles, type SubtitleFormat } from "@narriflow/composition-plan";
import { resolveClipRenderTiming } from "@narriflow/validators";
import { decodeClipEditorDocumentFromStorage } from "./clip-editor-document-persistence";

export interface ClipExportSubtitleFile {
  format: SubtitleFormat;
  fileName: string;
  content: string;
}

/** Subtitles for one export, generated on demand from its frozen render
 * snapshot with the same timing and cue derivation as burned-in captions.
 * Captions turned off for burn-in still yield subtitles. Nothing is stored. */
export function clipExportSubtitleFiles(
  frozenSnapshot: unknown,
  sourceDurationSec: number | null,
  baseFileName: string,
): ClipExportSubtitleFile[] {
  const document = decodeClipEditorDocumentFromStorage(frozenSnapshot, sourceDurationSec);
  const llmModel = typeof (frozenSnapshot as { llmModel?: unknown } | null)?.llmModel === "string"
    ? (frozenSnapshot as { llmModel: string }).llmModel
    : null;
  const timing = resolveClipRenderTiming({
    llmModel,
    startSec: document.clipStartSec,
    endSec: document.clipEndSec,
    utterances: document.transcriptSlice,
  });
  const cues = deriveCaptionCues(
    { ...document, clipStartSec: timing.startSec, clipEndSec: timing.endSec, transcriptSlice: timing.transcriptSlice },
    { ignoreVisibility: true },
  );
  return (["srt", "vtt"] as const).map((format) => ({ format, fileName: `${baseFileName}.${format}`, content: formatSubtitles(cues, format) }));
}

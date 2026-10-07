import { describe, expect, test } from "bun:test";
import { captionPresetSchema, editorDocumentSchema, studioEditsSchema } from "@narriflow/validators";
import { encodeClipEditorDocumentForStorage } from "./clip-editor-document-persistence";
import { clipExportSubtitleFiles } from "./clip-export-subtitles";

function frozen(preset: Record<string, unknown>, llmModel = "gpt-test") {
  const document = editorDocumentSchema.parse({
    version: 1, clipStartSec: 10, clipEndSec: 22,
    captionPreset: captionPresetSchema.parse({ textTransform: "none", wordsPerCue: 2, ...preset }),
    transcriptSlice: [{ index: 0, speaker: 0, speakerLabel: "Speaker 1", confidence: 0.9, startSec: 10.5, endSec: 12.5, text: "Frozen words only",
      words: [{ word: "Frozen", startSec: 10.5, endSec: 11, confidence: 0.9 }, { word: "words", startSec: 11.1, endSec: 11.6, confidence: 0.9 }, { word: "only", startSec: 12, endSec: 12.5, confidence: 0.9 }] }],
    studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }),
    brollUrl: null, deletedRanges: [],
  });
  return { ...encodeClipEditorDocumentForStorage(document, 600), llmModel };
}

describe("export subtitle files", () => {
  test("derive SRT and VTT from the frozen snapshot in clip time", () => {
    expect(clipExportSubtitleFiles(frozen({}), 600, "talk-9x16-v3")).toEqual([
      { format: "srt", fileName: "talk-9x16-v3.srt", content: "1\n00:00:00,500 --> 00:00:01,600\nFrozen words\n\n2\n00:00:02,000 --> 00:00:02,500\nonly\n\n" },
      { format: "vtt", fileName: "talk-9x16-v3.vtt", content: "WEBVTT\n\n00:00:00.500 --> 00:00:01.600\nFrozen words\n\n00:00:02.000 --> 00:00:02.500\nonly\n\n" },
    ]);
  });
  test("captions hidden for burn-in still produce the same subtitles", () => {
    expect(clipExportSubtitleFiles(frozen({ visible: false }), 600, "talk")).toEqual(clipExportSubtitleFiles(frozen({}), 600, "talk"));
  });
  test("caption-only snapshots keep their full window", () => {
    const [srt] = clipExportSubtitleFiles(frozen({}, "caption-only"), 600, "talk");
    expect(srt!.content.startsWith("1\n00:00:00,500 --> ")).toBe(true);
  });
  test("a malformed snapshot is refused rather than read from a newer revision", () => {
    expect(() => clipExportSubtitleFiles({ llmModel: "x" }, 600, "talk")).toThrow();
  });
});

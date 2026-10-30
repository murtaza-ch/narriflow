import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deriveCaptionCues } from "@narriflow/composition-plan";
import {
  captionPresetSchema,
  editorDocumentSchema,
  normalizeTranscriptSliceForClip,
  studioEditsSchema,
  type TranscriptUtterance,
} from "@narriflow/validators";
import { normalizeElevenLabsTranscript } from "./transcript.service";

const options = { allowEmpty: false, providerJobId: "tx_1", providerRequestId: "req_1", durationSeconds: 188.4 };

/** Real Scribe v2 results, through normalization and slicing, into caption cues. */
function utterancesOf(name: string): TranscriptUtterance[] {
  const payload = JSON.parse(readFileSync(join(import.meta.dir, "test-fixtures/scribe", name), "utf8"));
  return normalizeElevenLabsTranscript(payload, options).utterances;
}

function cuesFor(
  utterances: TranscriptUtterance[],
  clip: { startSec: number; endSec: number },
  opts: { punctuation?: boolean; deletedRanges?: { startSec: number; endSec: number }[] } = {},
) {
  const document = editorDocumentSchema.parse({
    version: 1, clipStartSec: clip.startSec, clipEndSec: clip.endSec,
    captionPreset: captionPresetSchema.parse({ textTransform: "none", wordsPerCue: 3, punctuation: opts.punctuation ?? true }),
    transcriptSlice: normalizeTranscriptSliceForClip(utterances, clip.startSec, clip.endSec),
    studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }),
    brollUrl: null, deletedRanges: opts.deletedRanges ?? [],
  });
  return deriveCaptionCues(document);
}

const joined = (cues: { text: string }[]) => cues.map((cue) => cue.text).join("");

describe("zero-duration tokens reach caption cues", () => {
  test("Chinese: 、 and 。 survive with punctuation on and drop when it is off", () => {
    const utterances = utterancesOf("zh-per-character.json");
    const on = joined(cuesFor(utterances, { startSec: 0, endSec: 6 }));
    expect(on).toContain("姿势、呼吸练习、念语和视觉形象被唤醒。");
    const off = joined(cuesFor(utterances, { startSec: 0, endSec: 6 }, { punctuation: false }));
    expect(off).toContain("姿势呼吸练习念语和视觉形象被唤醒");
    expect(off).not.toMatch(/[、。]/);
  });

  test("Japanese: 。 and 、 survive with punctuation on", () => {
    const utterances = utterancesOf("ja-per-character.json");
    const text = joined(cuesFor(utterances, { startSec: 0, endSec: 10 }));
    expect(text).toContain("ました。");
    expect(text).toContain("EMOによると、");
    expect(joined(cuesFor(utterances, { startSec: 0, endSec: 10 }, { punctuation: false }))).not.toMatch(/[、。]/);
  });

  test("cue timing follows the neighbours: points never stretch a cue backwards or past the next word", () => {
    const cues = cuesFor(utterancesOf("zh-per-character.json"), { startSec: 0, endSec: 6 });
    for (const [index, cue] of cues.entries()) {
      expect(cue.endSec).toBeGreaterThan(cue.startSec);
      if (index > 0) expect(cue.startSec).toBeGreaterThanOrEqual(cues[index - 1]!.startSec);
    }
    expect(cues[0]!.startSec).toBe(0);
  });

  test("a punctuation point exactly at a cut boundary follows start <= t < end", () => {
    const utterances = utterancesOf("zh-per-character.json");
    // 、 sits at 0.28. A cut starting there removes it (like the next kept word's
    // predecessor boundary); a cut ending there keeps it.
    const cutStart = joined(cuesFor(utterances, { startSec: 0, endSec: 6 }, { deletedRanges: [{ startSec: 0.28, endSec: 0.7 }] }));
    expect(cutStart.startsWith("姿势呼吸")).toBe(true);
    const cutEnd = joined(cuesFor(utterances, { startSec: 0, endSec: 6 }, { deletedRanges: [{ startSec: 0.1, endSec: 0.28 }] }));
    expect(cutEnd.startsWith("姿、呼吸")).toBe(true);
  });

  test("a clip ending exactly at a point drops it; one starting there keeps it", () => {
    const utterances = utterancesOf("zh-per-character.json");
    expect(joined(cuesFor(utterances, { startSec: 0, endSec: 0.28 }))).toBe("姿势");
    expect(joined(cuesFor(utterances, { startSec: 0.28, endSec: 1 }))).toBe("、呼吸");
  });

  test("a zero-duration lexical token is kept as a word", () => {
    const utterance: TranscriptUtterance = {
      index: 0, speaker: 0, speakerLabel: "Speaker 1", confidence: 0.9, startSec: 0, endSec: 0.6,
      text: "今天好",
      words: [
        { word: "今", startSec: 0, endSec: 0.2, confidence: 0.9 },
        { word: "天", startSec: 0.2, endSec: 0.2, confidence: 0.9 },
        { word: "好", startSec: 0.2, endSec: 0.6, confidence: 0.9 },
      ],
    };
    const cues = cuesFor([utterance], { startSec: 0, endSec: 2 });
    expect(cues.map((cue) => cue.text)).toEqual(["今天好"]);
  });
});

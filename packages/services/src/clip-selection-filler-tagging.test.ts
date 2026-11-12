import { expect, test } from "bun:test";
import { contentPackSchema, DEFAULT_CAPTION_PRESET, fillerWordKey, studioEditsSchema, type ClipSelectionInput, type FillerTaggingOutcome, type TranscriptUtterance } from "@narriflow/validators";
import { decodeClipSelectionInput, encodeClipSelectionInput } from "./clip-selection-input";
import { tagSelectionFillers, type ClipSelectionFillerTagger } from "./clip-selection-preparation";

const parent = { id: "00000000-0000-4000-8000-000000000001", projectId: "00000000-0000-4000-8000-000000000002", generation: 1, deploymentEpoch: 1, inputHash: "a".repeat(64) };
const utterance = (index: number, startSec: number, endSec: number): TranscriptUtterance => ({ index, speaker: 0, speakerLabel: "S1", startSec, endSec, text: "Also äh wir", confidence: null,
  words: [{ word: "Also", startSec, endSec: startSec + 0.3, confidence: null }, { word: "äh", startSec: startSec + 0.4, endSec: startSec + 0.6, confidence: null },
    { word: "wir", startSec: startSec + 0.7, endSec, confidence: null }] });
const utterances = [utterance(0, 0, 5), utterance(1, 100, 105), utterance(2, 200, 205)];

function input(over: { removeFillerWords?: boolean; languageCode?: string | null; processing?: [number | null, number | null] } = {}): ClipSelectionInput {
  const [processingStartSec, processingEndSec] = over.processing ?? [null, null];
  return { version: 1, parent, transcript: { id: "00000000-0000-4000-8000-000000000003", generation: 1, attemptId: null, contentHash: "b".repeat(64), sourceRevision: 1, sourceAudioId: null, sourceAudioBindingHash: null },
    planning: { projectTitle: "t", contentPack: contentPackSchema.parse({ outputTypes: ["short_clip"], clipCountTarget: 3, clipDurationSecTarget: 45, platformPlaybookVersion: "platform-playbook-v1",
      removeFillerWords: over.removeFillerWords ?? true, processingStartSec, processingEndSec }),
      sourceDurationSec: 300, sourceProbeDurationSec: 300, utterances, fullText: "x", speakerCount: 1, sourceLanguageCode: over.languageCode === undefined ? "de" : over.languageCode, audienceDataLine: null },
    editor: { captionPreset: DEFAULT_CAPTION_PRESET, studioEdits: studioEditsSchema.parse({}), sourceDurationSec: 300, wholeSource: false,
      cleanup: { removeSilences: false, removeFillerWords: over.removeFillerWords ?? true, quietRanges: null, languageCode: over.languageCode === undefined ? "de" : over.languageCode, aiFillers: null } },
    provider: { model: "gpt-5.4-mini", reasoningEffort: "medium", maxOutputTokens: 32000 }, systemPrompt: "p", responseSchemaHash: "c".repeat(64) };
}

const outcome = (keys: string[]): FillerTaggingOutcome => ({ contract: { models: [{ model: "gpt-5.6-luna", reasoningEffort: "low" }, { model: "gpt-5.4", reasoningEffort: "none" }],
  promptSha256: "d".repeat(64), schemaSha256: "e".repeat(64), maxOutputTokens: 4000 }, chunks: 1, tagged: 1, failed: 0, skipped: 0, unsafe: 0, tokensUsed: 10, overflow: false, keys });

function recording(reply: () => Promise<unknown>) {
  const calls: { utterances: TranscriptUtterance[]; languageCode: string; deadline: number }[] = [];
  const tagger: ClipSelectionFillerTagger = { tag: async (u, languageCode, deadline) => { calls.push({ utterances: u, languageCode, deadline }); return reply() as Promise<FillerTaggingOutcome>; } };
  return { tagger, calls };
}

test("tags only when filler removal is on and the language has no built-in list", async () => {
  for (const over of [{ removeFillerWords: false }, { languageCode: null }, { languageCode: "en" }, { languageCode: "en-US" }, { languageCode: "EN" }]) {
    const { tagger, calls } = recording(async () => outcome([]));
    expect(await tagSelectionFillers(input(over), tagger, 1)).toBeNull();
    expect(calls).toHaveLength(0);
  }
  expect(await tagSelectionFillers(input(), undefined, 1)).toBeNull();
});

test("sends only the processing range, the language and the deadline", async () => {
  const { tagger, calls } = recording(async () => outcome([]));
  await tagSelectionFillers(input({ processing: [90, 150] }), tagger, 12_345);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.utterances.map((u) => u.index)).toEqual([1]);
  expect(calls[0]!).toMatchObject({ languageCode: "de", deadline: 12_345 });
  const all = recording(async () => outcome([]));
  await tagSelectionFillers(input(), all.tagger, 1);
  expect(all.calls[0]!.utterances).toHaveLength(3);
  const none = recording(async () => outcome([]));
  expect(await tagSelectionFillers(input({ processing: [10, 20] }), none.tagger, 1)).toBeNull();
  expect(none.calls).toHaveLength(0);
});

test("a throwing tagger or an outcome that does not fit the capsule freezes nothing", async () => {
  expect(await tagSelectionFillers(input(), recording(async () => { throw new Error("boom"); }).tagger, 1)).toBeNull();
  for (const bad of [null, {}, { ...outcome([]), keys: ["x".repeat(201)] }, { ...outcome([]), extra: 1 }, { ...outcome([]), tokensUsed: -1 }]) {
    expect(await tagSelectionFillers(input(), recording(async () => bad).tagger, 1)).toBeNull();
  }
});

test("frozen tags round-trip through the capsule bytes, so the final hash check sees the same input", async () => {
  const key = fillerWordKey(0, utterances[0]!.words[1]!);
  const frozen = await tagSelectionFillers(input(), recording(async () => outcome([key])).tagger, 1);
  expect(frozen?.keys).toEqual([key]);
  const base = input();
  const withTags: ClipSelectionInput = { ...base, editor: { ...base.editor, cleanup: { ...base.editor.cleanup, aiFillers: frozen } } };
  const first = await encodeClipSelectionInput(withTags), again = await encodeClipSelectionInput(structuredClone(withTags));
  expect(again.sha256).toBe(first.sha256);
  expect((await encodeClipSelectionInput(base)).sha256).not.toBe(first.sha256);
  expect(await decodeClipSelectionInput(first.bytes, first, parent)).toEqual(withTags);
});

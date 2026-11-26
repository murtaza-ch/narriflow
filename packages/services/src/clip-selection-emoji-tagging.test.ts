import { expect, test } from "bun:test";
import { contentPackSchema, DEFAULT_CAPTION_PRESET, studioEditsSchema, type CaptionEmojiPick, type ClipSelectionInput, type FillerTaggingOutcome, type TranscriptUtterance } from "@narriflow/validators";
import { clipSelectionBytesHash, decodeClipSelectionInput, encodeClipSelectionInput } from "./clip-selection-input";
import { fitSelectionTags, tagSelectionEmojis, type ClipSelectionEmojiTagger } from "./clip-selection-preparation";

const parent = { id: "00000000-0000-4000-8000-000000000001", projectId: "00000000-0000-4000-8000-000000000002", generation: 1, deploymentEpoch: 1, inputHash: "a".repeat(64) };
const utterance = (index: number, startSec: number): TranscriptUtterance => ({ index, speaker: 0, speakerLabel: "S1", startSec, endSec: startSec + 2, text: "so funny", confidence: null,
  words: [{ word: "so", startSec, endSec: startSec + 0.3, confidence: null }, { word: "funny", startSec: startSec + 0.4, endSec: startSec + 2, confidence: null }] });
const utterances = [utterance(0, 0), utterance(1, 100), utterance(2, 200)];

function input(over: { addEmojis?: boolean; processing?: [number | null, number | null] } = {}): ClipSelectionInput {
  const [processingStartSec, processingEndSec] = over.processing ?? [null, null];
  return { version: 1, parent, transcript: { id: "00000000-0000-4000-8000-000000000003", generation: 1, attemptId: null, contentHash: "b".repeat(64), sourceRevision: 1, sourceAudioId: null, sourceAudioBindingHash: null },
    planning: { projectTitle: "Lisbon weekend", contentPack: contentPackSchema.parse({ outputTypes: ["short_clip"], clipCountTarget: 3, clipDurationSecTarget: 45, platformPlaybookVersion: "platform-playbook-v1",
      addEmojis: over.addEmojis ?? true, processingStartSec, processingEndSec }),
      sourceDurationSec: 300, sourceProbeDurationSec: 300, utterances, fullText: "x", speakerCount: 1, sourceLanguageCode: "ur", audienceDataLine: null },
    editor: { captionPreset: DEFAULT_CAPTION_PRESET, studioEdits: studioEditsSchema.parse({}), sourceDurationSec: 300, wholeSource: false,
      cleanup: { removeSilences: false, removeFillerWords: false, quietRanges: null, languageCode: "ur", aiFillers: null }, emojiPicks: null },
    provider: { model: "gpt-6-luna", reasoningEffort: "medium", maxOutputTokens: 32000 }, systemPrompt: "p", responseSchemaHash: "c".repeat(64) };
}

const pick = (key: string, strength = 2): CaptionEmojiPick => ({ key, ref: { id: "laugh-tears" }, strength });
function recording(reply: () => Promise<unknown>) {
  const calls: Parameters<ClipSelectionEmojiTagger["tag"]>[0][] = [];
  const tagger: ClipSelectionEmojiTagger = { tag: async (request) => { calls.push(request); return reply() as ReturnType<ClipSelectionEmojiTagger["tag"]>; } };
  return { tagger, calls };
}
const outcome = (picks: unknown) => ({ picks, chunks: 1, tagged: 1, failed: 0, skipped: 0, tokensUsed: 10 });

test("tags only when the pack adds emojis", async () => {
  const off = recording(async () => outcome([pick("400")]));
  expect(await tagSelectionEmojis(input({ addEmojis: false }), off.tagger, 1)).toBeNull();
  expect(off.calls).toHaveLength(0);
  expect(await tagSelectionEmojis(input(), undefined, 1)).toBeNull();
});

test("sends the processing range's utterances, the language, the title and the shared deadline", async () => {
  const { tagger, calls } = recording(async () => outcome([pick("100400")]));
  expect(await tagSelectionEmojis(input({ processing: [90, 150] }), tagger, 12_345)).toEqual([pick("100400")]);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.utterances.map((u) => u.index)).toEqual([1]);
  expect(calls[0]!).toMatchObject({ languageCode: "ur", title: "Lisbon weekend", deadline: 12_345 });
  const none = recording(async () => outcome([]));
  expect(await tagSelectionEmojis(input({ processing: [10, 20] }), none.tagger, 1)).toBeNull();
  expect(none.calls).toHaveLength(0);
});

test("a throwing tagger or picks that do not fit the capsule freeze nothing", async () => {
  expect(await tagSelectionEmojis(input(), recording(async () => { throw new Error("boom"); }).tagger, 1)).toBeNull();
  for (const bad of [[{ ...pick("1"), extra: 1 }], [pick("1.5")], [{ ...pick("1"), strength: 4 }], "x"]) {
    expect(await tagSelectionEmojis(input(), recording(async () => outcome(bad)).tagger, 1)).toBeNull();
  }
});

test("frozen picks round-trip through the capsule bytes, so the final hash check sees the same input", async () => {
  const frozen = await tagSelectionEmojis(input(), recording(async () => outcome([pick("400", 3), pick("100400")])).tagger, 1);
  const base = input();
  const withPicks: ClipSelectionInput = { ...base, editor: { ...base.editor, emojiPicks: frozen } };
  const first = await encodeClipSelectionInput(withPicks), again = await encodeClipSelectionInput(structuredClone(withPicks));
  expect(again.sha256).toBe(first.sha256);
  expect((await encodeClipSelectionInput(base)).sha256).not.toBe(first.sha256);
  expect(await decodeClipSelectionInput(first.bytes, first, parent)).toEqual(withPicks);
});

test("a capsule stored before emoji picks existed decodes with no picks instead of failing finalization", async () => {
  const base = input();
  const { emojiPicks: _picks, ...storedEditor } = base.editor;
  const stored = await encodeClipSelectionInput({ ...base, editor: { ...base.editor, emojiPicks: null } });
  const old = JSON.parse(new TextDecoder().decode(stored.bytes));
  delete old.editor.emojiPicks;
  expect(Object.keys(old.editor).sort()).toEqual(Object.keys(storedEditor).sort());
  const bytes = new TextEncoder().encode(JSON.stringify(old));
  const decoded = await decodeClipSelectionInput(bytes, { sha256: await clipSelectionBytesHash(bytes), byteLength: bytes.byteLength }, parent);
  expect(decoded.editor.emojiPicks).toBeNull();
  // Restore re-encodes with defaults filled in, so an old capsule's hash does not match: no selection may be in flight at deploy.
  expect((await encodeClipSelectionInput(decoded)).sha256).not.toBe(await clipSelectionBytesHash(bytes));
});

test("the size fit drops emoji picks first, then filler tags, and rethrows when nothing fits", async () => {
  const fillers = { keys: ["k"] } as unknown as FillerTaggingOutcome, picks = [pick("400")];
  const withTags = (aiFillers: FillerTaggingOutcome | null, emojiPicks: CaptionEmojiPick[] | null) => ({ aiFillers, emojiPicks }) as unknown as ClipSelectionInput;
  const tried: string[] = [];
  const limit = (fits: (value: { aiFillers: unknown; emojiPicks: unknown }) => boolean) => async (value: ClipSelectionInput) => {
    const tags = value as unknown as { aiFillers: unknown; emojiPicks: unknown };
    tried.push(`${tags.aiFillers ? "F" : "-"}${tags.emojiPicks ? "E" : "-"}`);
    if (!fits(tags)) throw new Error("Selection object byte limit exceeded");
    return { bytes: new Uint8Array([1]), sha256: "d".repeat(64), byteLength: 1 };
  };
  expect(await fitSelectionTags(withTags, fillers, picks, limit((tags) => tags.emojiPicks === null))).toMatchObject({ aiFillers: fillers, emojiPicks: null });
  expect(tried).toEqual(["FE", "F-"]);
  tried.length = 0;
  expect(await fitSelectionTags(withTags, fillers, picks, limit((tags) => tags.aiFillers === null))).toMatchObject({ aiFillers: null, emojiPicks: null });
  expect(tried).toEqual(["FE", "F-", "--"]);
  tried.length = 0;
  expect(await fitSelectionTags(withTags, null, picks, limit(() => true))).toMatchObject({ aiFillers: null, emojiPicks: picks });
  expect(tried).toEqual(["-E"]);
  tried.length = 0;
  await expect(fitSelectionTags(withTags, null, null, limit(() => false))).rejects.toThrow("byte limit");
  expect(tried).toEqual(["--"]);
});

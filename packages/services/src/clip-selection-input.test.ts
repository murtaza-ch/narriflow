import { expect, test } from "bun:test";
import { contentPackSchema, DEFAULT_CAPTION_PRESET, studioEditsSchema } from "@narriflow/validators";
import { encodeClipSelectionInput, decodeClipSelectionInput, encodeClipSelectionResult, decodeClipSelectionResult } from "./clip-selection-input";

const parent = { id: "00000000-0000-4000-8000-000000000001", projectId: "00000000-0000-4000-8000-000000000002", generation: 1, deploymentEpoch: 1, inputHash: "a".repeat(64) };
const capsule = () => ({ version: 1 as const, parent, transcript: { id: "00000000-0000-4000-8000-000000000003", generation: 1, attemptId: null, contentHash: "b".repeat(64), sourceRevision: 1, sourceAudioId: null, sourceAudioBindingHash: null },
  planning: { projectTitle: "Frozen title", contentPack: contentPackSchema.parse({ outputTypes: ["short_clip"], clipCountTarget: 3, clipDurationSecTarget: 45, platformPlaybookVersion: "platform-playbook-v1" }),
    sourceDurationSec: 3600, sourceProbeDurationSec: 3600, utterances: [], fullText: "private transcript", speakerCount: 1, sourceLanguageCode: "en", audienceDataLine: "Frozen audience data" },
  editor: { captionPreset: DEFAULT_CAPTION_PRESET, studioEdits: studioEditsSchema.parse({}), sourceDurationSec: 3600, wholeSource: false },
  provider: { model: "gpt-5.4-mini", reasoningEffort: "medium", maxOutputTokens: 32000 }, systemPrompt: "Frozen system prompt", responseSchemaHash: "c".repeat(64) });
test("private selection input canonical bytes bind the frozen Transcript, settings, guidance and editor seed", async () => {
  const input = await encodeClipSelectionInput(capsule());
  expect(input.byteLength).toBe(input.bytes.byteLength);
  expect(await decodeClipSelectionInput(input.bytes, { sha256: input.sha256, byteLength: input.byteLength }, parent)).toEqual(capsule());
  const changed = input.bytes.slice(); changed[changed.length - 2] = 32;
  await expect(decodeClipSelectionInput(changed, input, parent)).rejects.toThrow("checksum");
  await expect(decodeClipSelectionInput(input.bytes, input, { ...parent, generation: 2 })).rejects.toThrow("lineage");
  const reordered = { ...capsule(), editor: { ...capsule().editor }, parent: { inputHash: parent.inputHash, deploymentEpoch: 1, generation: 1, projectId: parent.projectId, id: parent.id } };
  expect((await encodeClipSelectionInput(reordered)).sha256).toBe(input.sha256);
});
test("window results salvage valid raw candidates and retain oversized optional cue evidence for the existing degradation policy", async () => {
  const binding = { parentId: parent.id, parentGeneration: 1, selectionHash: "d".repeat(64), windowIndex: 1 };
  const clip = { title: "A story", start_time: 1800, end_time: 1845, hook_text: "A hook", payoff_text: "A payoff", reasoning: "A complete story", category: "story", platform_fit: ["tiktok"],
    hook_strength: 80, emotional_intensity: 80, story_completeness_score: 95, broll_cues: Array.from({ length: 30 }, (_, index) => ({ at_sec: index, query: "A query", reason: "A reason" })) };
  const encoded = await encodeClipSelectionResult(binding, JSON.stringify({ clips: [{ title: "Invalid" }, clip] }), { tokensUsed: 123, providerRequestId: "req_test" });
  const decoded = await decodeClipSelectionResult(encoded.bytes, encoded, binding);
  expect(decoded.clips).toHaveLength(1);
  expect(decoded.clips[0]!.broll_cues).toHaveLength(30);
  expect(decoded).toMatchObject({ tokensUsed: 123, providerRequestId: "req_test", windowIndex: 1 });
  await expect(decodeClipSelectionResult(encoded.bytes, encoded, { ...binding, windowIndex: 0 })).rejects.toThrow("lineage");
});

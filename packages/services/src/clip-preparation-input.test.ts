import { expect, test } from "bun:test";
import documents from "../../../apps/media/src/__fixtures__/render-golden/documents.json";
import { clipPreparationBinding, encodeClipPreparationInput, decodeClipPreparationInput, encodeClipPreparationResult, decodeClipPreparationResult } from "./clip-preparation-input";
import { clipPreparationInputSchema, type ClipPreparationInput } from "@narriflow/validators/clip-preparation";

async function frozen(): Promise<ClipPreparationInput> {
  const input = {
    version: 1 as const, kind: "prepare_clip" as const,
    preparationId: "02fd9a96-e78d-455f-a676-3b3909a1589a", projectId: "36b818df-487f-4429-ab59-53be156ab532", clipId: "0e282bd8-a3b4-4422-bafb-ae4f68d59ac6",
    sourceRevision: 1, editorRevision: 3, toolchainFingerprint: "a".repeat(64), engineHash: "b".repeat(64),
    source: { storageKey: "execution/1/source/object", etag: '"source"', byteLength: 1000, sha256: "c".repeat(64) },
    sourceProbe: { durationSec: 20, video: null, audio: null, facts: { format: { name: "fixture", startTimeSec: 0, durationSec: 20, sizeBytes: 1000, bitRate: null }, attachedPictureCount: 0, videos: [], audios: [] } },
    document: documents.cases["solo-auto-vertical"].document, wholeSource: false, llmModel: "fixture",
  };
  return clipPreparationInputSchema.parse({ ...input, bindingHash: await clipPreparationBinding(input as ClipPreparationInput) });
}

test("frozen preparation survives JSONB property order and rejects stale bytes or editor evidence", async () => {
  const input = await frozen();
  const encoded = await encodeClipPreparationInput(input);
  const reference = { storageKey: "projects/frozen/input.json", etag: '"input"', byteLength: encoded.byteLength, sha256: encoded.sha256 };
  expect(await decodeClipPreparationInput(encoded.bytes, reference)).toEqual(input);
  const reordered = Object.fromEntries(Object.entries(input).reverse()) as ClipPreparationInput;
  expect((await encodeClipPreparationInput(reordered)).sha256).toBe(encoded.sha256);
  await expect(decodeClipPreparationInput(new Uint8Array([...encoded.bytes, 32]), reference)).rejects.toThrow("clip_preparation_input_invalid");
  await expect(encodeClipPreparationInput({ ...input, editorRevision: 4 })).rejects.toThrow("clip_preparation_binding_invalid");
  await expect(encodeClipPreparationInput({ ...input, source: { ...input.source, etag: '"changed"' } })).rejects.toThrow("clip_preparation_binding_invalid");
});

test("sealed preparation outcome preserves optional peaks degradation and rejects mixed artifact identities", async () => {
  const result = { version: 1 as const, preparationId: "02fd9a96-e78d-455f-a676-3b3909a1589a", bindingHash: "a".repeat(64),
    preview: { artifactId: "1926d146-807b-4e55-8ef6-0ac87f95bea2", startSec: 16, durationSec: 48 },
    peaks: { state: "unavailable" as const, reason: "peaks_unavailable" as const }, layout: { automatic: { state: "failed" as const, reason: "analysis_unavailable" as const }, screen: null, split: null } };
  const encoded = await encodeClipPreparationResult(result);
  expect(await decodeClipPreparationResult(encoded.bytes, { storageKey: "execution/preparation/layout", etag: '"layout"', byteLength: encoded.byteLength, sha256: encoded.sha256 })).toEqual(result);
  await expect(encodeClipPreparationResult({ ...result, peaks: { state: "ready", artifactId: result.preview.artifactId } })).rejects.toThrow();
});

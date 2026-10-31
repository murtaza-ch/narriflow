import { expect, test } from "bun:test";
import documents from "../../../apps/media/src/__fixtures__/render-golden/documents.json";
import { clipPreparationBinding } from "./clip-preparation-input";
import { clipPreparationEngineHash } from "./clip-preparation-policy";
import { encodeRenderExecutionInput, decodeRenderExecutionInput } from "./render-execution-input";
import { renderExecutionInputSchema } from "@narriflow/validators/render-execution";

test("render capsule binds completed source observations, exact objects and frozen export members", async () => {
  const id = () => crypto.randomUUID(), object = { storageKey: "execution/source", etag: '"frozen"', byteLength: 100, sha256: "a".repeat(64) };
  const raw = { version: 1 as const, kind: "prepare_clip" as const, preparationId: id(), projectId: id(), clipId: id(), sourceRevision: 1, editorRevision: 4,
    toolchainFingerprint: "b".repeat(64), engineHash: await clipPreparationEngineHash("b".repeat(64)), source: object,
    sourceProbe: { durationSec: 20, video: null, audio: null, facts: { format: { name: "fixture", startTimeSec: 0, durationSec: 20, sizeBytes: 100, bitRate: null }, attachedPictureCount: 0, videos: [], audios: [] } },
    document: documents.cases["solo-auto-vertical"].document, wholeSource: false, llmModel: "fixture" };
  const preparation = { ...raw, bindingHash: await clipPreparationBinding(raw) };
  const input = renderExecutionInputSchema.parse({ version: 1, kind: "render_group", watermark: true, groupId: id(), workflowRunId: id(), workSetGeneration: id(), preparation,
    prepared: { preview: object, result: { version: 1, preparationId: raw.preparationId, bindingHash: preparation.bindingHash,
      preview: { artifactId: id(), startSec: 0, durationSec: 8 }, peaks: { state: "unavailable", reason: "no_audio" }, layout: { automatic: { state: "failed", reason: "analysis_unavailable" }, screen: null, split: null } } },
    workspace: { id: id(), ownerUserId: id(), pricingTier: "free" }, captionLanguage: null, brandSnapshot: null,
    clip: { index: 0, title: null, hookText: "frozen", category: "hook", brollCues: null },
    variants: [{ renderId: id(), aspectRatio: "ratio_9_16", resolution: "720p", exportVariantId: id(), export: { id: id(), watermark: true } }],
    assets: { visuals: [], fonts: [], audio: [], logo: null }, autoBroll: { configured: false, request: null, resolved: [] } });
  const encoded = await encodeRenderExecutionInput(input), reference = { ...object, byteLength: encoded.byteLength, sha256: encoded.sha256 };
  expect(await decodeRenderExecutionInput(encoded.bytes, reference)).toEqual(input);
  const reordered = Object.fromEntries(Object.entries(input).reverse()) as typeof input;
  expect((await encodeRenderExecutionInput(reordered)).sha256).toBe(encoded.sha256);
  await expect(encodeRenderExecutionInput({ ...input, prepared: { ...input.prepared, result: { ...input.prepared.result, bindingHash: "c".repeat(64) } } })).rejects.toThrow();
  await expect(decodeRenderExecutionInput(encoded.bytes, { ...reference, sha256: "c".repeat(64) })).rejects.toThrow("render_input_invalid");
  expect(renderExecutionInputSchema.safeParse({ ...input, variants: [...input.variants, input.variants[0]] }).success).toBe(false);
});

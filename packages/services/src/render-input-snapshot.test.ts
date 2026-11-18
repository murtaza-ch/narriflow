import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";
import documents from "../../../apps/media/src/__fixtures__/render-golden/documents.json";
import { editorDocumentSchema } from "@narriflow/validators";
import type { ExecutionDispatchReference } from "@narriflow/validators/execution";
import { clipPreparationBinding } from "./clip-preparation-input";
import { clipPreparationEngineHash } from "./clip-preparation-policy";
import type { ReadyClipPreparation } from "./clip-preparation";
import { dubbingArtifactBindingHash } from "./dubbing-policy";
import { createRenderInputSnapshot } from "./render-input-snapshot";

const id = () => crypto.randomUUID();
const object = { storageKey: "execution/source", etag: '"frozen"', byteLength: 100, sha256: "a".repeat(64) };
const requestHash = "d".repeat(64);

/** The rows a render group of one export reads, as plain data behind the transaction. */
async function harness(options: { dub: boolean; dubOverrides?: Record<string, unknown> }) {
  const ids = { project: id(), workspace: id(), clip: id(), run: id(), group: id(), render: id(), exported: id(), variant: id(), dub: id(), audio: id(), timing: id() };
  const raw = { version: 1 as const, kind: "prepare_clip" as const, preparationId: id(), projectId: ids.project, clipId: ids.clip, sourceRevision: 1, editorRevision: 4,
    toolchainFingerprint: "b".repeat(64), engineHash: await clipPreparationEngineHash("b".repeat(64)), source: object,
    sourceProbe: { durationSec: 20, video: null, audio: null, facts: { format: { name: "fixture", startTimeSec: 0, durationSec: 20, sizeBytes: 100, bitRate: null }, attachedPictureCount: 0, videos: [], audios: [] } },
    document: editorDocumentSchema.parse(documents.cases["solo-auto-vertical"].document), wholeSource: false, llmModel: "fixture" };
  const preparation = { ...raw, bindingHash: await clipPreparationBinding(raw) };
  const ready = { preparationId: raw.preparationId, bindingHash: preparation.bindingHash, preview: object, result: { version: 1, preparationId: raw.preparationId, bindingHash: preparation.bindingHash,
    preview: { artifactId: id(), startSec: 0, durationSec: 8 }, peaks: { state: "unavailable", reason: "no_audio" }, layout: { automatic: { state: "failed", reason: "analysis_unavailable" }, screen: null, split: null } } } as unknown as ReadyClipPreparation;
  const reference = { dispatchId: id(), deploymentEpoch: 1, kind: "modal_execution", subject: { kind: "render_group", id: ids.group }, generation: 1, inputHash: "e".repeat(64) } as ExecutionDispatchReference;
  const project = { id: ids.project, workspaceId: ids.workspace, sourceRevision: 1, sourceStorageKey: object.storageKey, brandSnapshot: null, languageCode: "en", transcript: { languageCode: "en" },
    workspace: { id: ids.workspace, ownerUserId: id(), personalOwnerUserId: null, pricingTier: "free" } };
  const group = { id: ids.group, generation: 1, deploymentEpoch: 1, preparationId: raw.preparationId, clipId: ids.clip, workflowRunId: ids.run, workSetGeneration: id(),
    exportIdentity: JSON.stringify(["automatic", ids.exported, 4, 1, true]), members: [{ clipRenderId: ids.render, invalidatedAt: null }], workflowRun: { project } };
  const render = { id: ids.render, aspectRatio: "ratio_9_16", resolution: "720p", exportVariantId: ids.variant, exportVariant: { exportId: ids.exported, watermark: true },
    clipSnapshot: { index: 0, title: null, hookText: "frozen", category: "hook", brollCues: null } };
  const dubRow = { id: ids.dub, projectId: ids.project, clipId: ids.clip, status: "completed", targetLanguageCode: "ur", requestHash, editorRevision: 4,
    audioStorageKey: "execution/1/attempt/owner/audio", audioArtifactId: ids.audio, timingArtifactId: ids.timing, ...options.dubOverrides };
  const artifacts = [
    { id: ids.audio, role: "dub_mix", bindingHash: await dubbingArtifactBindingHash(requestHash, "audio"), storageKey: "execution/1/attempt/owner/audio", contentType: "audio/mpeg",
      byteLength: 90_000n, checksumSha256: "b".repeat(64), etag: '"audio"', committedAt: new Date() },
    { id: ids.timing, role: "probe", bindingHash: await dubbingArtifactBindingHash(requestHash, "timing"), storageKey: "execution/1/attempt/owner/timing", contentType: "application/json",
      byteLength: 900n, checksumSha256: "c".repeat(64), etag: '"timing"', committedAt: new Date() },
  ];
  const reads: string[] = [];
  const tx = {
    renderGroup: { findUniqueOrThrow: async () => group },
    clipRender: { findMany: async () => [render] },
    clipExport: { findMany: async () => [{ dubId: options.dub ? ids.dub : null }] },
    clipDub: { findUnique: async () => { reads.push("dub"); return dubRow; } },
    executionArtifact: { findMany: async () => { reads.push("artifacts"); return artifacts; } },
    clip: { findFirst: async () => ({ index: 0, title: null, hookText: "live", category: "hook", brollCues: null }) },
  };
  const database = { $transaction: async (work: (value: unknown) => unknown) => work(tx) } as unknown as PrismaClient;
  const timing = { version: 1, kind: "dubbing_checkpoint", dubId: ids.dub, requestHash, stage: "timing", segments: [
    { startSec: 0.2, endSec: 1, tempo: 1, words: [{ text: "ہیلو", spaceBefore: false, startSec: 0.2, endSec: 0.6 }, { text: "دنیا", spaceBefore: true, startSec: 0.6, endSec: 1 }] }] };
  const headed: string[] = [], jsonRead: Array<{ artifactId: string; role: string; byteLength: bigint }> = [];
  const snapshot = createRenderInputSnapshot(database, {
    object: async key => { headed.push(key); return { storageKey: key, etag: '"audio"', byteLength: 90_000, sha256: "b".repeat(64) }; },
    readArtifactJson: async artifact => { jsonRead.push({ artifactId: artifact.artifactId, role: artifact.role, byteLength: artifact.byteLength }); return timing; },
    pexelsConfigured: false, searchStock: async () => { throw Error("no stock"); },
  });
  return { ids, reads, headed, jsonRead, run: () => snapshot(reference, preparation, ready) };
}

describe("a render group's frozen input", () => {
  test("a dub's export carries the committed narration and its caption words", async () => {
    const { ids, headed, jsonRead, run } = await harness({ dub: true });
    const input = await run();
    expect(input.dub).toEqual({
      audio: { name: "dub_audio", object: { storageKey: "execution/1/attempt/owner/audio", etag: '"audio"', byteLength: 90_000, sha256: "b".repeat(64) } },
      language: "ur",
      segments: [[{ text: "ہیلو", spaceBefore: false, startSec: 0.2, endSec: 0.6 }, { text: "دنیا", spaceBefore: true, startSec: 0.6, endSec: 1 }]],
    });
    // The captions are the dub's language, not the transcript's.
    expect(input.captionLanguage).toBe("ur");
    expect(headed).toEqual(["execution/1/attempt/owner/audio"]);
    expect(jsonRead).toEqual([{ artifactId: ids.timing, role: "probe", byteLength: 900n }]);
  });

  test("an ordinary export reads no dub and keeps the transcript's language", async () => {
    const { reads, headed, jsonRead, run } = await harness({ dub: false });
    const input = await run();
    expect(input.dub).toBeNull();
    expect(input.captionLanguage).toBe("en");
    expect(reads).toEqual([]);
    expect(headed).toEqual([]);
    expect(jsonRead).toEqual([]);
  });

  test.each([
    ["a dub of another revision", { editorRevision: 5 }],
    ["a dub that is not complete", { status: "processing" }],
    ["a dub without audio", { audioArtifactId: null }],
  ])("%s does not render", async (_name, dubOverrides) => {
    const { run } = await harness({ dub: true, dubOverrides });
    await expect(run()).rejects.toThrow("render_input_invalid");
  });
});

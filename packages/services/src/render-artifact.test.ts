import { expect, test } from "bun:test";
import { encodeRenderVariantFailure, decodeRenderVariantFailure, prepareRenderArtifact, renderArtifactBindingHash } from "./render-artifact";
import { renderGroupOutcomeSchema } from "@narriflow/validators/render-execution";

test("a sealed variant failure carries only a bounded current binding and preserves its disposition", async () => {
  const failure = { version: 1 as const, kind: "failed" as const, renderId: "1926d146-807b-4e55-8ef6-0ac87f95bea2",
    bindingHash: "a".repeat(64), errorCode: "caption_glyph_unavailable", disposition: "permanent" as const };
  const encoded = await encodeRenderVariantFailure(failure);
  expect(encoded.byteLength).toBeLessThan(1024);
  expect(await decodeRenderVariantFailure(encoded.bytes, { byteLength: encoded.byteLength, sha256: encoded.sha256 })).toEqual(failure);
  await expect(decodeRenderVariantFailure(encoded.bytes, { byteLength: encoded.byteLength, sha256: "b".repeat(64) })).rejects.toThrow("render_artifact_invalid");
  await expect(encodeRenderVariantFailure({ ...failure, errorCode: "https://private-url.invalid/secret" })).rejects.toThrow();
  await expect(encodeRenderVariantFailure({ ...failure, captions: "private text" } as any)).rejects.toThrow();
});

test("group acknowledgement counts distinguish unsettled retries from terminal results", () => {
  expect(renderGroupOutcomeSchema.parse({ status: "queued", requested: 3, succeeded: 1, failed: 1, superseded: 0 }).status).toBe("queued");
  expect(renderGroupOutcomeSchema.parse({ status: "partial", requested: 3, succeeded: 2, failed: 1, superseded: 0 }).status).toBe("partial");
  for (const value of [
    { status: "partial", requested: 3, succeeded: 2, failed: 0, superseded: 0 },
    { status: "completed", requested: 3, succeeded: 2, failed: 1, superseded: 0 },
    { status: "queued", requested: 3, succeeded: 3, failed: 0, superseded: 0 },
    { status: "failed", requested: 5, succeeded: 0, failed: 5, superseded: 0 },
  ]) expect(renderGroupOutcomeSchema.safeParse(value).success).toBe(false);
});

test("failure preparation reads only the exact assigned object and rejects foreign members before publication", async () => {
  const renderId = crypto.randomUUID(), inputHash = "a".repeat(64);
  const bindingHash = await renderArtifactBindingHash({ inputHash, renderId, role: "render_outcome" });
  const failure = { version: 1 as const, kind: "failed" as const, renderId, bindingHash, errorCode: "render_encode_failed", disposition: "retryable" as const };
  const encoded = await encodeRenderVariantFailure(failure);
  const artifact = { artifactId: crypto.randomUUID(), role: "render_outcome" as const, storageKey: "execution/assigned/failure.json", contentType: "application/json", byteLength: BigInt(encoded.byteLength), etag: '"assigned"', sha256: encoded.sha256, bindingHash };
  const reported = { ...artifact, byteLength: encoded.byteLength };
  let reads = 0;
  const read = async (reference: { storageKey: string; etag: string; byteLength: number; sha256: string }, limit: number) => {
    reads++; expect(reference).toEqual({ storageKey: artifact.storageKey, etag: artifact.etag, byteLength: encoded.byteLength, sha256: encoded.sha256 });
    expect(limit).toBe(65536); return encoded.bytes;
  };
  expect(await prepareRenderArtifact(artifact, reported, { inputHash, memberIds: [renderId], read })).toMatchObject({ renderId, failure });
  await expect(prepareRenderArtifact(artifact, reported, { inputHash, memberIds: [crypto.randomUUID()], read })).rejects.toThrow("render_artifact_invalid");
  await expect(prepareRenderArtifact({ ...artifact, byteLength: 65537n }, reported, { inputHash, memberIds: [renderId], read })).rejects.toThrow("render_artifact_invalid");
  expect(reads).toBe(2);
});

test("successful render credits are derived only from used IDs in the immutable stock plan", async () => {
  const renderId = crypto.randomUUID(), inputHash = "a".repeat(64);
  const bindingHash = await renderArtifactBindingHash({ inputHash, renderId, role: "render_variant" });
  const artifact = { artifactId: crypto.randomUUID(), role: "render_variant" as const, storageKey: "execution/assigned/video.mp4", contentType: "video/mp4", byteLength: 1024n, etag: '"assigned"', sha256: "b".repeat(64), bindingHash };
  const stockCredits = [{ pexelsId: 72, authorName: "Author", authorUrl: null, pageUrl: "https://www.pexels.com/video/72/" }];
  const reported = { ...artifact, byteLength: 1024, renderVariant: { renderId, durationSec: 4, usedStockIds: [72] } };
  const read = async (): Promise<Uint8Array> => { throw new Error("Media bytes must never be read into the Worker"); };
  expect(await prepareRenderArtifact(artifact, reported, { inputHash, memberIds: [renderId], stockCredits, read })).toMatchObject({ brollCredits: stockCredits });
  await expect(prepareRenderArtifact(artifact, { ...reported, renderVariant: { ...reported.renderVariant, usedStockIds: [73] } }, { inputHash, memberIds: [renderId], stockCredits, read })).rejects.toThrow("render_artifact_invalid");
});

import { expect, test } from "bun:test";
import { encodeRenderVariantFailure, decodeRenderVariantFailure } from "./render-artifact";

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

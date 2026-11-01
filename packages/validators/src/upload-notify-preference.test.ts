import { expect, test } from "bun:test";
import { openUploadSessionSchema } from "./upload";
import { openUploadRequestSchema } from "./rest-api";
import { buildGenerationContext } from "./integration";
const id = "11111111-1111-4111-8111-111111111111";
test("Upload Session and public REST admission accept only a top-level boolean notification preference", () => {
  const direct = { clientIdempotencyKey: id, title: "Quiet", source: { fileName: "source.mp4", sizeBytes: 2048, contentType: "video/mp4", browserFingerprint: "fixture" }, generationContext: buildGenerationContext() };
  expect(openUploadSessionSchema.parse({ ...direct, notifyOnComplete: false }).notifyOnComplete).toBe(false);
  expect(openUploadSessionSchema.safeParse({ ...direct, notifyOnComplete: "false" }).success).toBe(false);
  expect(openUploadSessionSchema.safeParse({ ...direct, generationContext: { ...direct.generationContext, notifyOnComplete: false } }).success).toBe(false);
  const rest = { file: { name: "source.mp4", sizeBytes: 2048, contentType: "video/mp4" }, notifyOnComplete: false };
  expect(openUploadRequestSchema.parse(rest).notifyOnComplete).toBe(false);
});

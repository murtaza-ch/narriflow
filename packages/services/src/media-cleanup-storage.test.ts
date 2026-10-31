import { expect, test } from "bun:test";
import { AbortMultipartUploadCommand, DeleteObjectCommand, ListMultipartUploadsCommand, type S3Client } from "@aws-sdk/client-s3";
import { createMediaCleanupStorage } from "./media-cleanup-storage";

const config = { accountId: "a".repeat(32), bucket: "private", accessKeyId: "fixture", secretAccessKey: "fixture" };
test("exact-key cleanup drains only that destination's MPUs before acknowledged DELETE", async () => {
  const key = `execution/1/clip_preparation/${crypto.randomUUID()}/1/${crypto.randomUUID()}/${crypto.randomUUID()}/clip_preview/test.mp4`;
  const calls: unknown[] = [];
  const storage = createMediaCleanupStorage(config, { client: { async send(command: unknown, options: { abortSignal: AbortSignal }) {
    calls.push(command); expect(options.abortSignal).toBeInstanceOf(AbortSignal);
    if (command instanceof ListMultipartUploadsCommand) { expect(command.input.Prefix).toBe(key); expect(command.input.MaxUploads).toBe(9); return { Uploads: [{ Key: key, UploadId: "known" }, { Key: `${key}.unrelated`, UploadId: "other" }], IsTruncated: false }; }
    if (command instanceof AbortMultipartUploadCommand) { expect(command.input.Key).toBe(key); expect(command.input.UploadId).toBe("known"); return {}; }
    if (command instanceof DeleteObjectCommand) { expect(command.input).toEqual({ Bucket: "private", Key: key }); return { $metadata: { httpStatusCode: 204 } }; }
    throw new Error("unexpected");
  } } as unknown as S3Client });
  await storage.deleteExact(key, { signal: new AbortController().signal });
  expect(calls).toHaveLength(3);
  await expect(storage.deleteExact("../outside", { signal: new AbortController().signal })).rejects.toMatchObject({ code: "cleanup_storage_key_invalid" });
  expect(calls).toHaveLength(3);
});
test("unknown DELETE acceptance and truncated MPU inventory cannot complete cleanup", async () => {
  for (const truncated of [true, false]) {
    let deletes = 0;
    const storage = createMediaCleanupStorage(config, { client: { async send(command: unknown) {
      if (command instanceof ListMultipartUploadsCommand) return { Uploads: [], IsTruncated: truncated };
      if (command instanceof DeleteObjectCommand) { deletes++; throw new Error("lost HTTP response"); }
      throw new Error("unexpected");
    } } as unknown as S3Client });
    await expect(storage.deleteExact("projects/known/key.mp4", { signal: new AbortController().signal })).rejects.toMatchObject({ code: "cleanup_storage_unconfirmed" });
    expect(deletes).toBe(truncated ? 0 : 1);
  }
});

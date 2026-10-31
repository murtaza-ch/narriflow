import { expect, test } from "bun:test";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { createClipSelectionStorage } from "./clip-selection-storage";
import { clipSelectionBytesHash } from "./clip-selection-input";

const config = { accountId: "a".repeat(32), bucket: "private", accessKeyId: "fixture", secretAccessKey: "fixture" };
test("selection objects use conditional writes, measured HEAD and exact bounded If-Match reads", async () => {
  const bytes = new TextEncoder().encode('{"frozen":true}'), sha256 = await clipSelectionBytesHash(bytes);
  const key = `projects/${crypto.randomUUID()}/selection/${crypto.randomUUID()}/${sha256}.json`;
  let stored = false, puts = 0, reads = 0;
  const client = { async send(command: unknown) {
    if (command instanceof PutObjectCommand) {
      puts++; expect(command.input.IfNoneMatch).toBe("*"); expect(command.input.Metadata?.["selection-sha256"]).toBe(sha256);
      if (stored) throw { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } };
      stored = true; return { ETag: '"sealed"' };
    }
    if (command instanceof GetObjectCommand) {
      reads++; expect(command.input.IfMatch).toBe('"sealed"'); expect(command.input.Range).toBe(`bytes=0-${bytes.length - 1}`);
    }
    if (command instanceof HeadObjectCommand || command instanceof GetObjectCommand) return { ETag: '"sealed"', ContentLength: bytes.length, ContentType: "application/json", Metadata: { "selection-sha256": sha256 },
      Body: { transformToWebStream: () => new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) } };
    throw new Error("Unexpected storage command");
  } } as unknown as S3Client;
  const storage = createClipSelectionStorage(config, { client });
  expect(await storage.write(key, bytes)).toEqual({ etag: '"sealed"', byteLength: bytes.length, sha256 });
  expect(await storage.write(key, bytes)).toEqual({ etag: '"sealed"', byteLength: bytes.length, sha256 });
  expect(puts).toBe(2); expect(reads).toBe(1);
  expect(await storage.read({ storageKey: key, etag: '"sealed"', byteLength: bytes.length, sha256 })).toEqual(bytes);
  await expect(storage.read({ storageKey: "outside/input.json", etag: '"sealed"', byteLength: bytes.length, sha256 })).rejects.toThrow("reference");
  expect(reads).toBe(2);
});
test("a changed body or overlong stream cannot be accepted even when its reported HEAD length and checksum match", async () => {
  const bytes = new TextEncoder().encode('{"frozen":true}'), sha256 = await clipSelectionBytesHash(bytes);
  const key = `execution/1/clip_selection_window/${crypto.randomUUID()}/1/${crypto.randomUUID()}/${crypto.randomUUID()}/selection_window/${sha256}.json`;
  for (const oversized of [false, true]) {
    let cancelled = false;
    const client = { async send() { return { ETag: '"sealed"', ContentLength: bytes.length, ContentType: "application/json", Metadata: { "selection-sha256": sha256 },
      Body: { transformToWebStream: () => new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(bytes.length + (oversized ? 1 : 0))); if (!oversized) controller.close(); }, cancel() { cancelled = true; } }) } }; } } as unknown as S3Client;
    const storage = createClipSelectionStorage(config, { client });
    await expect(storage.read({ storageKey: key, etag: '"sealed"', byteLength: bytes.length, sha256 })).rejects.toThrow("changed");
    expect(cancelled).toBe(oversized);
  }
});

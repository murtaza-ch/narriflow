import { expect, test } from "bun:test";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { createPrivateJsonStorage } from "./private-json-storage";

const config = { accountId: "a".repeat(32), bucket: "private", accessKeyId: "fixture", secretAccessKey: "fixture" };
// Independent SHA-256 vector for the exact two UTF-8 bytes '{}'.
const sha256 = "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";
test("private capsules reconcile a lost PUT acknowledgement and preserve conditional immutable identity", async () => {
  const bytes = new TextEncoder().encode("{}");
  const key = `projects/${crypto.randomUUID()}/preparations/${crypto.randomUUID()}/${crypto.randomUUID()}.json`;
  let stored = false, puts = 0, reads = 0;
  const client = { async send(command: unknown) {
    if (command instanceof PutObjectCommand) {
      puts++;
      expect(command.input.IfNoneMatch).toBe("*");
      expect(command.input.Metadata?.["execution-input-sha256"]).toBe(sha256);
      if (stored) throw { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } };
      stored = true;
      throw new Error("lost PUT acknowledgement");
    }
    if (command instanceof GetObjectCommand) {
      reads++;
      expect(command.input.IfMatch).toBe('"sealed"');
      expect(command.input.Range).toBe("bytes=0-1");
    }
    if (command instanceof HeadObjectCommand || command instanceof GetObjectCommand) return { ETag: '"sealed"', ContentLength: 2, ContentType: "application/json", Metadata: { "execution-input-sha256": sha256 },
      Body: { transformToWebStream: () => new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) } };
    throw new Error("Unexpected command");
  } } as unknown as S3Client;
  const storage = createPrivateJsonStorage(config, { client });
  const expected = { etag: '"sealed"', byteLength: 2, sha256 };
  expect(await storage.write(key, bytes)).toEqual(expected);
  expect(await storage.write(key, bytes)).toEqual(expected);
  expect(await storage.read({ storageKey: key, ...expected })).toEqual(bytes);
  expect(puts).toBe(2);
  expect(reads).toBe(3);
  await expect(storage.write("outside/input.json", bytes)).rejects.toMatchObject({ code: "execution_input_reference_invalid" });
  expect(puts).toBe(2);
});
test("a capsule with changed bytes or an oversized stream is rejected and the stream is cancelled", async () => {
  const key = `projects/${crypto.randomUUID()}/render-groups/${crypto.randomUUID()}/${crypto.randomUUID()}.json`;
  for (const extra of [0, 1]) {
    let cancelled = false;
    const client = { async send() { return { ETag: '"sealed"', ContentLength: 2, ContentType: "application/json", Metadata: { "execution-input-sha256": sha256 },
      Body: { transformToWebStream: () => new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2 + extra)); if (!extra) controller.close(); }, cancel() { cancelled = true; } }) } }; } } as unknown as S3Client;
    const storage = createPrivateJsonStorage(config, { client });
    await expect(storage.read({ storageKey: key, etag: '"sealed"', byteLength: 2, sha256 })).rejects.toMatchObject({ code: "execution_input_changed" });
    expect(cancelled).toBe(extra === 1);
  }
});

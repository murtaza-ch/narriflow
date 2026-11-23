import { expect, mock, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";
import type { ActorScope } from "./actor-scope";
import { decodeUploadThumbnail, saveUploadThumbnail, uploadThumbnailKey } from "./upload-thumbnail";

// Real static WebP frame (2x2, lossless), not a MIME-only fake.
const frame = "UklGRhwAAABXRUJQVlA4TA8AAAAvAUAAAAcQ/Y/+ByKi/wEA";
const scope = { workspaceId: "workspace", actorUserId: "actor" } as ActorScope;
function store(poster: string | null | undefined) {
  return { uploadSession: { findFirst: mock(async (_input: unknown) => poster === undefined ? null : { thumbnailStorageKey: poster }), updateMany: mock(async (_input: unknown) => ({ count: 1 })) } };
}

test("accepts bounded static WebP and rejects truncated, oversized, animated or disguised payloads", () => {
  expect(decodeUploadThumbnail(frame)).not.toBeNull();
  for (const value of [frame.slice(0, -4), Buffer.from("<svg/>").toString("base64"), "A".repeat(350000)]) expect(decodeUploadThumbnail(value)).toBeNull();
  const animated = Buffer.from(frame, "base64"); animated.write("ANIM", 12); expect(decodeUploadThumbnail(animated.toString("base64"))).toBeNull();
  const wide = Buffer.from(frame, "base64"); wide.writeUInt32LE(2000, 21); expect(decodeUploadThumbnail(wide.toString("base64"))).toBeNull();
});

test("the selected poster is stored before ingest, scoped to its actor and live session", async () => {
  const db = store(null);
  const put = mock(async () => ({ key: "unused" }));
  await saveUploadThumbnail(db as unknown as Pick<PrismaClient, "uploadSession">, scope, "session", frame, put);
  expect(db.uploadSession.findFirst.mock.calls[0]![0]).toMatchObject({ where: { id: "session", workspaceId: "workspace", actorUserId: "actor", status: { in: expect.arrayContaining(["uploading"]) } } });
  expect(put).toHaveBeenCalledWith(expect.objectContaining({ key: uploadThumbnailKey("session"), contentType: "image/webp", ifNoneMatch: "*" }));
  expect(db.uploadSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { thumbnailStorageKey: uploadThumbnailKey("session") } }));
});

test("missing sessions and existing posters cannot write images", async () => {
  const put = mock(async () => ({ key: "unused" }));
  for (const poster of [undefined, "already-saved"]) await saveUploadThumbnail(store(poster) as unknown as Pick<PrismaClient, "uploadSession">, scope, "session", frame, put);
  expect(put).not.toHaveBeenCalled();
});

test("a lost PUT response can recover the immutable image without replacing it", async () => {
  const db = store(null);
  await saveUploadThumbnail(db as unknown as Pick<PrismaClient, "uploadSession">, scope, "session", frame, async () => { throw { $metadata: { httpStatusCode: 412 } }; });
  expect(db.uploadSession.updateMany).toHaveBeenCalledTimes(1);
});

test("accepts the color-profile chunk used by browser canvas WebP encoders", () => {
  const original = Buffer.from(frame, "base64");
  const extended = Buffer.from("565038580a0000002000000001000001000049434350020000000100", "hex");
  const image = Buffer.concat([original.subarray(0, 12), extended, original.subarray(12)]);
  image.writeUInt32LE(image.length - 8, 4);
  expect(decodeUploadThumbnail(image.toString("base64"))).not.toBeNull();
  extended[8] = 0x22; // Animation flag.
  const animated = Buffer.concat([image.subarray(0,12), extended, original.subarray(12)]);
  expect(decodeUploadThumbnail(animated.toString("base64"))).toBeNull();
});

import { accessibleProjectWhere } from "./project-access";
import type { Prisma, PrismaClient } from "@prisma/client";
import { SOURCE_THUMBNAIL_MAX_BYTES } from "@narriflow/validators/source-thumbnail";
import type { ActorScope } from "./actor-scope";
import { putObjectBytes } from "./r2-storage";

/** Known even after an interrupted write, so termination and retention can clean it. */
export function uploadThumbnailKey(sessionId: string) {
  return `upload-sessions/${sessionId}/thumbnail.webp`;
}

/** Accept only bounded, static WebP containers emitted by the canvas encoder.
 * Pixels are untrusted optional decoration; no SVG, EXIF or animation is served. Canvas color profiles are retained. */
export function decodeUploadThumbnail(encoded: string): Uint8Array | null {
  if (encoded.length > Math.ceil(SOURCE_THUMBNAIL_MAX_BYTES / 3) * 4) return null;
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length < 30 || bytes.length > SOURCE_THUMBNAIL_MAX_BYTES || bytes.toString("base64") !== encoded) return null;
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP" || bytes.readUInt32LE(4) + 8 !== bytes.length) return null;
  let width = 0, height = 0, frames = 0;
  for (let offset = 12; offset < bytes.length;) {
    if (offset + 8 > bytes.length) return null;
    const kind = bytes.toString("ascii", offset, offset + 4), length = bytes.readUInt32LE(offset + 4), start = offset + 8;
    const next = start + length + (length % 2);
    if (next > bytes.length) return null;
    if (kind === "VP8 ") {
      if (length < 10 || bytes.readUIntBE(start + 3, 3) !== 0x9d012a) return null;
      width = bytes.readUInt16LE(start + 6) & 0x3fff; height = bytes.readUInt16LE(start + 8) & 0x3fff; frames++;
    } else if (kind === "VP8L") {
      if (length < 5 || bytes[start] !== 0x2f) return null;
      const bits = bytes.readUInt32LE(start + 1);
      width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1; frames++;
    } else if (kind === "VP8X") {
      // Extended static image with alpha is allowed, animation/EXIF are not.
      if (length !== 10 || (bytes[start]! & ~0x30) !== 0) return null;
      if (bytes.readUIntLE(start + 4, 3) + 1 > 960 || bytes.readUIntLE(start + 7, 3) + 1 > 540) return null;
    } else if (kind === "ICCP") {
      if (length > 4096) return null;
    } else if (kind !== "ALPH") return null;
    offset = next;
  }
  return frames === 1 && width > 0 && width <= 960 && height > 0 && height <= 540 ? bytes : null;
}

/** Save before finalization hands off the source. The deterministic, write-once
 * key never has a browser PUT grant. Failed preview work cannot reject intake. */
export async function saveUploadThumbnail(
  database: Pick<PrismaClient, "uploadSession">,
  scope: ActorScope,
  sessionId: string,
  encoded: string,
  put: typeof putObjectBytes = putObjectBytes,
) {
  const bytes = decodeUploadThumbnail(encoded);
  if (!bytes) return;
  const now = new Date();
  const where: Prisma.UploadSessionWhereInput = { id: sessionId, workspaceId: scope.workspaceId, actorUserId: scope.actorUserId, status: { in: ["uploading", "finalizing", "reconciling", "queued_for_ingest"] }, hardExpiresAt: { gt: now },
    OR: [{ ingestJob: { is: null } }, { ingestJob: { is: { project: { is: accessibleProjectWhere(now) } } } }],
  };
  const session = await database.uploadSession.findFirst({ where, select: { thumbnailStorageKey: true } });
  if (!session || session.thumbnailStorageKey) return;
  const key = uploadThumbnailKey(sessionId);
  try {
    await put({ key, bytes, contentType: "image/webp", ifNoneMatch: "*", signal: AbortSignal.timeout(5000) });
  } catch (error) {
    // A concurrent finalize or a response lost after PUT left the same immutable image.
    if (!(typeof error === "object" && error !== null && "$metadata" in error && (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 412)) throw error;
  }
  await database.uploadSession.updateMany({ where: { ...where, thumbnailStorageKey: null }, data: { thumbnailStorageKey: key } });
}

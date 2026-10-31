// Private to the retiring Bun worker. Never import from the Worker or media image.
import { open, readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, GetObjectCommand, PutObjectCommand, S3Client, UploadPartCommand } from "@aws-sdk/client-s3";
import { readServiceEnvironment } from "@narriflow/services/runtime-environment";
import { r2FileTransferControl, sanitizeObjectMetadata, isExactMissingMultipartUploadError } from "@narriflow/services/r2-storage";
const { getClient, getR2Config, projectStorageDeadline } = r2FileTransferControl;

/** Ceiling for the single-PUT path, whose body is held in memory. Anything
 *  larger goes multipart — see the comment in putFileFromPath for why a
 *  streamed single PUT is not an option against R2. 16 MB comfortably covers
 *  preview proxies (~1-3 MB) and dub audio without risking the worker's heap. */
const BUFFERED_PUT_MAX_BYTES = 16 * 1024 * 1024;
/** Cleanup of a failed multipart upload gets its own clock: it must outlive a
 *  cancelled caller signal, but a stalled abort may never hold the caller past
 *  this grace. An unconfirmed abort leaves an orphan for the maintenance reaper. */
const MULTIPART_ABORT_CLEANUP_DEADLINE_MS = 5_000;
/** Thrown by {@link readFilePart} when the file has fewer bytes available
 *  than the requested `[start, end)` range (e.g. it was truncated by a
 *  concurrent writer between the caller's `stat()` and this read). The
 *  caller already declared the *original* `ContentLength` to S3/R2 for this
 *  part — silently uploading a shorter body than that would either hang the
 *  request or land a truncated, corrupted part, so this must be a hard
 *  failure rather than a silently-truncated buffer. */
export class ShortReadError extends Error {
  readonly filePath: string;
  readonly expectedBytes: number;
  readonly actualBytes: number;

  constructor(filePath: string, expectedBytes: number, actualBytes: number) {
    super(
      `Short read on ${filePath}: expected ${expectedBytes} bytes but only ` +
        `${actualBytes} were available (premature EOF)`,
    );
    this.name = "ShortReadError";
    this.filePath = filePath;
    this.expectedBytes = expectedBytes;
    this.actualBytes = actualBytes;
  }
}

/** Reads `[start, end)` of a file into a Buffer. Used for multipart parts,
 *  which must be buffered rather than streamed (see putFileFromPath).
 *  Exported for testing; not part of this package's public surface. */
export async function readFilePart(
  filePath: string,
  start: number,
  end: number,
): Promise<Buffer> {
  const handle = await open(filePath, "r");
  try {
    const expectedBytes = end - start;
    const buffer = Buffer.allocUnsafe(expectedBytes);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        start + offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== expectedBytes) {
      throw new ShortReadError(filePath, expectedBytes, offset);
    }
    return buffer;
  } finally {
    await handle.close();
  }
}
/** Parts are buffered in memory (see readFilePart), so this is deliberately
 *  smaller than it was when parts were streamed. 16 MB still allows a ~160 GB
 *  object within S3's 10,000-part limit, far above the 5 GB upload cap. */
const MULTIPART_PART_SIZE_BYTES = 16 * 1024 * 1024;

/** How many parts putFileFromPath uploads at once. Bounds memory at
 *  concurrency × MULTIPART_PART_SIZE_BYTES, since only in-flight parts are
 *  read into memory (see the pool loop below). Clamped to [1, 16] so a bad
 *  env value can't accidentally serialize uploads or blow the heap. */
function getMultipartConcurrency() {
  const raw = Number(readServiceEnvironment().R2_MULTIPART_CONCURRENCY);
  if (!Number.isFinite(raw)) {
    return 4;
  }
  return Math.min(16, Math.max(1, Math.floor(raw)));
}

/**
 * Aborts a failed multipart upload without ever blocking or replacing the
 * original failure. Independent of the caller's signal (which is usually the
 * reason we are here) and bounded by its own deadline; both a rejected and a
 * stalled abort are reported as an orphan candidate instead of thrown.
 */
async function abortMultipartUploadBestEffort(params: {
  client: S3Client;
  bucket: string;
  key: string;
  uploadId: string;
}): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reportOrphan = (reason: string) => {
    console.warn(
      JSON.stringify({
        level: "warn",
        message: "r2_multipart_abort_unconfirmed",
        key: params.key,
        uploadId: params.uploadId,
        reason,
      }),
    );
  };
  const stalled = new Promise<"stalled">((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("stalled");
    }, MULTIPART_ABORT_CLEANUP_DEADLINE_MS);
  });
  const attempt = params.client
    .send(
      new AbortMultipartUploadCommand({
        Bucket: params.bucket,
        Key: params.key,
        UploadId: params.uploadId,
      }),
      { abortSignal: controller.signal },
    )
    .then(
      () => "aborted" as const,
      (error: unknown) =>
        isExactMissingMultipartUploadError(error)
          ? ("aborted" as const)
          : ("failed" as const),
    );
  try {
    const outcome = await Promise.race([attempt, stalled]);
    if (outcome !== "aborted") reportOrphan(outcome);
  } finally {
    clearTimeout(timer);
  }
}

export async function putFileFromPath(params: {
  key: string;
  filePath: string;
  contentType?: string;
  metadata?: Record<string, string>;
  signal?: AbortSignal;
}) {
  params.signal?.throwIfAborted();
  await projectStorageDeadline(params.key);
  const client = getClient();
  const { bucket } = getR2Config();
  const fileInfo = await stat(params.filePath);
  const metadata = sanitizeObjectMetadata(params.metadata);

  // Small files go up as a single PUT with the body fully in memory. Streaming
  // a Node ReadStream here fails against R2 with "You did not provide the
  // number of bytes specified by the Content-Length HTTP header" — the SDK
  // wraps streamed payloads in aws-chunked framing for its default integrity
  // checksum, which R2 does not accept, and because a consumed stream cannot be
  // replayed the SDK's retry masks the real error ("non-retryable streaming
  // request"). Reproduced with a 1.5 MB file; a 15-byte file happens to slip
  // through, which is why this stayed hidden. Anything above the buffer ceiling
  // uses the multipart path below, which sends per-part buffers and works.
  if (fileInfo.size <= BUFFERED_PUT_MAX_BYTES) {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: params.key,
        Body: await readFile(params.filePath),
        ContentLength: fileInfo.size,
        ContentType: params.contentType,
        Metadata: metadata,
      }),
      { abortSignal: params.signal },
    );
  } else {
    const created = await client.send(
      new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: params.key,
        ContentType: params.contentType,
        Metadata: metadata,
      }),
      { abortSignal: params.signal },
    );
    const uploadId = created.UploadId;
    if (!uploadId) {
      throw new Error("R2 multipart upload did not return upload id");
    }

    try {
      const parts: Array<{ ETag: string; PartNumber: number }> = [];
      const partCount = Math.ceil(
        fileInfo.size / MULTIPART_PART_SIZE_BYTES,
      );

      // Upload parts with bounded concurrency instead of one at a time: a
      // sequential loop turns a 2GB source (128 parts) into 128 serial round
      // trips. `nextPartNumber` is shared across the pool's workers so each
      // worker pulls the next unclaimed part instead of a static slice, which
      // keeps all slots busy even if individual parts take different times.
      // Memory stays bounded at concurrency × part size because a worker only
      // reads its part's bytes (readFilePart) once its slot is free, never all
      // parts up front.
      let nextPartNumber = 1;
      let firstError: unknown = null;
      let aborted = false;
      // The first failed part cancels its siblings' in-flight requests, so a
      // stalled sibling cannot hold the failure (or the abort cleanup) hostage.
      const partFailure = new AbortController();
      const partSignal = params.signal
        ? AbortSignal.any([params.signal, partFailure.signal])
        : partFailure.signal;

      const worker = async () => {
        for (;;) {
          if (aborted) {
            return;
          }
          const partNumber = nextPartNumber;
          if (partNumber > partCount) {
            return;
          }
          nextPartNumber += 1;

          const start = (partNumber - 1) * MULTIPART_PART_SIZE_BYTES;
          const end = Math.min(
            start + MULTIPART_PART_SIZE_BYTES,
            fileInfo.size,
          );

          try {
            partSignal.throwIfAborted();
            // Read the part fully into memory rather than streaming it, for the
            // same reason as the single-PUT path above: a streamed body makes the
            // SDK use aws-chunked framing that R2 rejects, and the failure surfaces
            // as "The socket connection was closed unexpectedly" — which is exactly
            // how link imports were dying in production. Reproduced with a 20 MB
            // upload and fixed by buffering. Part size is kept small enough that
            // one part in memory is cheap.
            const body = await readFilePart(params.filePath, start, end);

            const uploaded = await client.send(
              new UploadPartCommand({
                Bucket: bucket,
                Key: params.key,
                UploadId: uploadId,
                PartNumber: partNumber,
                Body: body,
                ContentLength: end - start,
              }),
              { abortSignal: partSignal },
            );
            if (!uploaded.ETag) {
              throw new Error("R2 multipart part did not return an etag");
            }
            parts.push({ ETag: uploaded.ETag, PartNumber: partNumber });
          } catch (error) {
            // Stop this worker and every other one from claiming new parts and
            // cancel in-flight siblings; they are still awaited via
            // Promise.allSettled below, so their promises never reject unhandled.
            aborted = true;
            if (!firstError) {
              firstError = error;
            }
            partFailure.abort();
            return;
          }
        }
      };

      const concurrency = Math.min(getMultipartConcurrency(), partCount || 1);
      await Promise.allSettled(
        Array.from({ length: concurrency }, () => worker()),
      );

      if (firstError) {
        throw firstError;
      }

      // Workers complete out of order, so the parts array reflects completion
      // order, not part order — CompleteMultipartUpload requires ascending
      // PartNumber.
      parts.sort((left, right) => left.PartNumber - right.PartNumber);

      await client.send(
        new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: params.key,
          UploadId: uploadId,
          MultipartUpload: { Parts: parts },
        }),
        { abortSignal: params.signal },
      );
    } catch (error) {
      await abortMultipartUploadBestEffort({
        client,
        bucket,
        key: params.key,
        uploadId,
      });
      throw error;
    }
  }

  return {
    key: params.key,
    fileName: basename(params.filePath),
  };
}

export async function downloadObjectToFile(params: {
  key: string;
  filePath: string;
  signal?: AbortSignal;
}) {
  params.signal?.throwIfAborted();
  await projectStorageDeadline(params.key);
  const client = getClient();
  const { bucket } = getR2Config();

  const response = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: params.key,
    }),
    { abortSignal: params.signal },
  );

  if (!response.Body) {
    throw new Error(`R2 object body missing for key: ${params.key}`);
  }

  const body = response.Body as {
    transformToWebStream?: () => ReadableStream<Uint8Array>;
  };

  if (!body.transformToWebStream) {
    throw new Error("R2 response body cannot be streamed");
  }

  const { pipeline } = await import("node:stream/promises");
  const { createWriteStream } = await import("node:fs");
  const { Readable } = await import("node:stream");

  await pipeline(
    Readable.fromWeb(
      body.transformToWebStream() as unknown as import("node:stream/web").ReadableStream,
    ),
    createWriteStream(params.filePath),
    { signal: params.signal },
  );

  return {
    key: params.key,
    contentType: response.ContentType ?? null,
  };
}


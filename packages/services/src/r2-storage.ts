import { open, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListPartsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getPrismaClient } from "@narriflow/db/client";

const SIGNED_URL_TTL_SECONDS = 60 * 60;
/** Ceiling for the single-PUT path, whose body is held in memory. Anything
 *  larger goes multipart — see the comment in putFileFromPath for why a
 *  streamed single PUT is not an option against R2. 16 MB comfortably covers
 *  preview proxies (~1-3 MB) and dub audio without risking the worker's heap. */
const BUFFERED_PUT_MAX_BYTES = 16 * 1024 * 1024;
const OBJECT_METADATA_TOTAL_MAX_BYTES = 2 * 1024;
const OBJECT_METADATA_VALUE_MAX_BYTES = 384;
const OBJECT_METADATA_KEY_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,127}$/;

const PROJECT_KEY_PATTERN = /^projects\/([0-9a-f-]{36})\//i;

export class ProjectStorageUnavailableError extends Error {
  constructor() {
    super("Project storage is no longer available");
    this.name = "ProjectStorageUnavailableError";
  }
}

export class InvalidObjectMetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidObjectMetadataError";
  }
}

function metadataByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * S3-compatible object metadata is transported as `x-amz-meta-*` HTTP
 * headers. Node rejects Unicode/control characters before the request is
 * sent, and S3 limits the complete user-metadata section to 2 KiB. Keep
 * already-safe ASCII readable, base64url-encode other short UTF-8 values,
 * and reduce unusually long diagnostic values to a stable hash. Metadata is
 * optional observability data, so it must never make a valid media upload
 * impossible merely because a title, filename, or redacted URL is Unicode.
 */
export function sanitizeObjectMetadata(
  metadata?: Record<string, string>,
): Record<string, string> | undefined {
  if (!metadata) return undefined;

  const safe: Record<string, string> = {};
  let totalBytes = 0;

  for (const [rawKey, rawValue] of Object.entries(metadata)) {
    const key = rawKey.toLowerCase();
    if (!OBJECT_METADATA_KEY_PATTERN.test(key)) {
      throw new InvalidObjectMetadataError(
        `Object metadata key is not S3 header-safe: ${rawKey}`,
      );
    }

    let value = rawValue;
    if (!/^[\x20-\x7e]*$/.test(value)) {
      value = `b64:${Buffer.from(value, "utf8").toString("base64url")}`;
    }
    if (metadataByteLength(value) > OBJECT_METADATA_VALUE_MAX_BYTES) {
      value = `sha256:${createHash("sha256").update(rawValue).digest("hex")}`;
    }

    totalBytes += metadataByteLength(key) + metadataByteLength(value);
    if (totalBytes > OBJECT_METADATA_TOTAL_MAX_BYTES) {
      throw new InvalidObjectMetadataError(
        "Object metadata exceeds the S3 2 KiB user-metadata limit",
      );
    }
    safe[key] = value;
  }

  return safe;
}

function projectIdFromStorageKey(key: string): string | null {
  return PROJECT_KEY_PATTERN.exec(key)?.[1] ?? null;
}

async function projectStorageDeadline(key: string): Promise<Date | null | undefined> {
  const projectId = projectIdFromStorageKey(key);
  const prisma = getPrismaClient();
  if (!projectId || !prisma) return undefined;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { expiresAt: true, purgeStartedAt: true },
  });
  if (
    !project ||
    project.purgeStartedAt ||
    (project.expiresAt && project.expiresAt.getTime() <= Date.now())
  ) {
    throw new ProjectStorageUnavailableError();
  }
  return project.expiresAt;
}

async function clampProjectTtl(key: string, requestedSeconds: number): Promise<number> {
  const deadline = await projectStorageDeadline(key);
  if (!deadline) return requestedSeconds;
  const remainingSeconds = Math.floor((deadline.getTime() - Date.now()) / 1000);
  if (remainingSeconds < 1) throw new ProjectStorageUnavailableError();
  return Math.max(1, Math.min(requestedSeconds, remainingSeconds));
}

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
  const raw = Number(process.env.R2_MULTIPART_CONCURRENCY);
  if (!Number.isFinite(raw)) {
    return 4;
  }
  return Math.min(16, Math.max(1, Math.floor(raw)));
}

function getRequiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getR2Config() {
  return {
    accountId: getRequiredEnv("R2_ACCOUNT_ID"),
    accessKeyId: getRequiredEnv("R2_ACCESS_KEY_ID"),
    secretAccessKey: getRequiredEnv("R2_SECRET_ACCESS_KEY"),
    bucket: getRequiredEnv("R2_BUCKET"),
  };
}

let r2Client: S3Client | null = null;

function getClient() {
  if (r2Client) {
    return r2Client;
  }

  const { accountId, accessKeyId, secretAccessKey } = getR2Config();

  r2Client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
    // The SDK's default ("WHEN_SUPPORTED") attaches a request checksum to
    // every request whose operation supports one — including PutObject/
    // UploadPart — by wrapping the body in `aws-chunked` trailer framing.
    // R2 rejects that framing outright, which is the actual root cause behind
    // both errors this file used to hit when streaming a body ("You did not
    // provide the number of bytes specified by the Content-Length HTTP
    // header" on single PUT; "The socket connection was closed unexpectedly"
    // on multipart). "WHEN_REQUIRED" only computes a checksum when the
    // operation mandates one (S3/R2's PutObject and UploadPart do not), so
    // the body goes out exactly as given — no forced chunked framing.
    // Verified against the real bucket at 1.5 MB and 50 MB with this set:
    // see the streaming-vs-buffering decision below and the worker's
    // clip-preview verification report for the measurements.
    requestChecksumCalculation: "WHEN_REQUIRED",
  });

  return r2Client;
}

export function isR2Configured() {
  return Boolean(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET,
  );
}

export async function createMultipartUpload(params: {
  key: string;
  contentType: string;
  metadata?: Record<string, string>;
}) {
  await projectStorageDeadline(params.key);
  const client = getClient();
  const { bucket } = getR2Config();

  const response = await client.send(
    new CreateMultipartUploadCommand({
      Bucket: bucket,
      Key: params.key,
      ContentType: params.contentType,
      Metadata: sanitizeObjectMetadata(params.metadata),
    }),
  );

  if (!response.UploadId) {
    throw new Error("R2 multipart upload did not return upload id");
  }

  return { uploadId: response.UploadId };
}

export async function presignMultipartPartUrls(params: {
  key: string;
  uploadId: string;
  partNumbers: number[];
  expiresIn?: number;
}) {
  const client = getClient();
  const { bucket } = getR2Config();
  const expiresIn = await clampProjectTtl(
    params.key,
    params.expiresIn ?? SIGNED_URL_TTL_SECONDS,
  );

  const uploadUrls = await Promise.all(
    params.partNumbers.map(async (partNumber) => {
      const url = await getSignedUrl(
        client,
        new UploadPartCommand({
          Bucket: bucket,
          Key: params.key,
          PartNumber: partNumber,
          UploadId: params.uploadId,
        }),
        {
          expiresIn,
        },
      );

      return {
        partNumber,
        url,
      };
    }),
  );

  return uploadUrls;
}

export async function listUploadedParts(params: {
  key: string;
  uploadId: string;
}) {
  await projectStorageDeadline(params.key);
  const client = getClient();
  const { bucket } = getR2Config();

  const parts: Array<{ partNumber: number; etag: string }> = [];
  let partNumberMarker: string | undefined;
  let hasMoreParts = true;
  while (hasMoreParts) {
    const response = await client.send(
      new ListPartsCommand({
        Bucket: bucket,
        Key: params.key,
        UploadId: params.uploadId,
        PartNumberMarker: partNumberMarker,
      }),
    );
    parts.push(
      ...(response.Parts ?? [])
        .map((part) => ({
          partNumber: part.PartNumber ?? 0,
          etag: part.ETag ?? "",
        }))
        .filter((part) => part.partNumber > 0 && part.etag),
    );
    hasMoreParts = response.IsTruncated === true;
    if (!hasMoreParts) break;
    partNumberMarker = response.NextPartNumberMarker;
    if (!partNumberMarker) {
      throw new Error("R2 truncated multipart part inventory without a marker");
    }
  }
  return parts;
}

export async function listExactKeyMultipartUploads(params: { key: string }) {
  const client = getClient();
  const { bucket } = getR2Config();
  const uploads: Array<{ uploadId: string; initiatedAt: Date | null }> = [];
  let keyMarker: string | undefined;
  let uploadIdMarker: string | undefined;
  let hasMoreUploads = true;

  while (hasMoreUploads) {
    const response = await client.send(
      new ListMultipartUploadsCommand({
        Bucket: bucket,
        Prefix: params.key,
        KeyMarker: keyMarker,
        UploadIdMarker: uploadIdMarker,
      }),
    );
    for (const upload of response.Uploads ?? []) {
      if (upload.Key !== params.key) continue;
      const uploadId = upload.UploadId;
      if (!uploadId || uploadId.length > 2_048) {
        throw new Error("R2 returned a malformed multipart upload identity");
      }
      uploads.push({
        uploadId,
        initiatedAt: upload.Initiated ?? null,
      });
    }
    hasMoreUploads = response.IsTruncated === true;
    if (!hasMoreUploads) break;
    keyMarker = response.NextKeyMarker;
    uploadIdMarker = response.NextUploadIdMarker;
    if (!keyMarker) {
      throw new Error("R2 truncated multipart upload inventory without a marker");
    }
  }

  return uploads;
}

export async function completeMultipartUpload(params: {
  key: string;
  uploadId: string;
  etags: Array<{ partNumber: number; etag: string }>;
}) {
  await projectStorageDeadline(params.key);
  const client = getClient();
  const { bucket } = getR2Config();

  await client.send(
    new CompleteMultipartUploadCommand({
      Bucket: bucket,
      Key: params.key,
      UploadId: params.uploadId,
      MultipartUpload: {
        Parts: params.etags
          .slice()
          .sort((left, right) => left.partNumber - right.partNumber)
          .map((part) => ({
            PartNumber: part.partNumber,
            ETag: part.etag,
          })),
      },
    }),
  );
}

export async function abortMultipartUpload(params: {
  key: string;
  uploadId: string;
}) {
  const client = getClient();
  const { bucket } = getR2Config();

  await client.send(
    new AbortMultipartUploadCommand({
      Bucket: bucket,
      Key: params.key,
      UploadId: params.uploadId,
    }),
  );
}

export async function headObject(key: string) {
  await projectStorageDeadline(key);
  const client = getClient();
  const { bucket } = getR2Config();

  const response = await client.send(
    new HeadObjectCommand({
      Bucket: bucket,
      Key: key,
    }),
  );

  return {
    contentType: response.ContentType ?? null,
    sizeBytes: response.ContentLength ?? null,
    etag: response.ETag ?? null,
    metadata: response.Metadata ?? {},
  };
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
            params.signal?.throwIfAborted();
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
              { abortSignal: params.signal },
            );
            if (!uploaded.ETag) {
              throw new Error("R2 multipart part did not return an etag");
            }
            parts.push({ ETag: uploaded.ETag, PartNumber: partNumber });
          } catch (error) {
            // Stop this worker and every other one from claiming new parts;
            // in-flight parts on other workers are left to finish (awaited via
            // Promise.allSettled below) rather than abandoned, so their
            // promises never reject unhandled.
            aborted = true;
            if (!firstError) {
              firstError = error;
            }
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
      await client
        .send(
          new AbortMultipartUploadCommand({
            Bucket: bucket,
            Key: params.key,
            UploadId: uploadId,
          }),
        )
        .catch(() => undefined);
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

/** Reads a deliberately small JSON object directly from R2. This is used for
 * metadata artifacts such as waveform peaks that browsers cannot reliably
 * fetch from a private bucket without bucket-level CORS configuration. The
 * hard byte ceiling protects the web process from a corrupt or replaced key.
 */
export async function getJsonObject(params: {
  key: string;
  maxBytes?: number;
}): Promise<unknown> {
  await projectStorageDeadline(params.key);
  const client = getClient();
  const { bucket } = getR2Config();
  const maxBytes = Math.max(1, Math.min(1024 * 1024, params.maxBytes ?? 256 * 1024));
  const response = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: params.key }),
  );
  if (!response.Body) {
    throw new Error(`R2 object body missing for key: ${params.key}`);
  }
  if (response.ContentLength !== undefined && response.ContentLength > maxBytes) {
    throw new Error(`R2 JSON object exceeds ${maxBytes} bytes: ${params.key}`);
  }
  const body = response.Body as { transformToString?: () => Promise<string> };
  if (!body.transformToString) {
    throw new Error("R2 response body cannot be converted to text");
  }
  const text = await body.transformToString();
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new Error(`R2 JSON object exceeds ${maxBytes} bytes: ${params.key}`);
  }
  return JSON.parse(text) as unknown;
}

export async function presignDownloadUrl(params: {
  key: string;
  expiresIn?: number;
  fileName?: string;
}): Promise<string> {
  const client = getClient();
  const { bucket } = getR2Config();
  const expiresIn = await clampProjectTtl(
    params.key,
    params.expiresIn ?? SIGNED_URL_TTL_SECONDS,
  );

  return getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: bucket,
      Key: params.key,
      ...(params.fileName && {
        ResponseContentDisposition: buildAttachmentContentDisposition(
          params.fileName,
        ),
      }),
    }),
    { expiresIn },
  );
}

/**
 * Builds an injection-safe attachment header with both an ASCII fallback and
 * an RFC 5987 UTF-8 filename. This value is signed into the GetObject query,
 * so R2 controls downloads even when the object URL is cross-origin.
 */
export function buildAttachmentContentDisposition(fileName: string): string {
  const leaf = fileName.split(/[\\/]/).at(-1) ?? "download";
  const normalizedLeaf = Array.from(leaf.normalize("NFKC"), (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f || '"\\;:*?<>|'.includes(character)
      ? "-"
      : character;
  }).join("");
  const unicodeName =
    normalizedLeaf
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 180) || "download";
  const asciiCandidate = unicodeName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7e]/g, "")
    .trim();
  const asciiName =
    (asciiCandidate && asciiCandidate !== ".mp4"
      ? asciiCandidate
      : `download${unicodeName.toLowerCase().endsWith(".mp4") ? ".mp4" : ""}`
    ).slice(0, 180);
  const encodedName = encodeURIComponent(unicodeName).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`;
}

export async function presignSingleUploadUrl(params: {
  key: string;
  contentType: string;
  expiresIn?: number;
}): Promise<string> {
  const client = getClient();
  const { bucket } = getR2Config();
  const expiresIn = await clampProjectTtl(
    params.key,
    params.expiresIn ?? SIGNED_URL_TTL_SECONDS,
  );

  return getSignedUrl(
    client,
    new PutObjectCommand({
      Bucket: bucket,
      Key: params.key,
      ContentType: params.contentType,
    }),
    { expiresIn },
  );
}

/**
 * Builds the `CopySource` value for {@link copyObject}: a bucket-qualified,
 * URL-encoded path. Keys contain slashes (and may contain characters that must
 * be escaped), so each segment is encoded individually and the separators are
 * left alone. Exported for tests — an over-encoded separator silently copies
 * from a key that doesn't exist.
 */
export function buildCopySource(bucket: string, key: string): string {
  return `${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * Server-side copy of one object to a new key, entirely inside the bucket —
 * no download/upload round trip through this process.
 *
 * This is what makes "Duplicate clip" instant: a duplicated clip needs its own
 * copy of the rendered MP4 and the preview proxy, and re-rendering would cost
 * a worker job and plan capacity for a byte-identical file. Two rows must never
 * share one key, because deleting either clip (or purging its project) deletes
 * the object by key and would leave the other pointing at nothing.
 *
 * Single-part CopyObject caps at 5 GB, which no clip render or 540p proxy comes
 * near — the source is what gets large, and the source is never copied here.
 */
export async function copyObject(params: {
  sourceKey: string;
  destinationKey: string;
}) {
  await projectStorageDeadline(params.sourceKey);
  await projectStorageDeadline(params.destinationKey);
  const client = getClient();
  const { bucket } = getR2Config();

  await client.send(
    new CopyObjectCommand({
      Bucket: bucket,
      CopySource: buildCopySource(bucket, params.sourceKey),
      Key: params.destinationKey,
    }),
  );

  return { key: params.destinationKey };
}

export async function deleteObject(
  key: string,
  options?: { signal?: AbortSignal },
) {
  options?.signal?.throwIfAborted();
  const client = getClient();
  const { bucket } = getR2Config();

  await client.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
    }),
    { abortSignal: options?.signal },
  );

  return { key };
}

export interface R2ObjectSummary {
  key: string;
  sizeBytes: number;
  lastModified?: Date | null;
}

export function classifyR2StorageError(error: unknown): string {
  if (!error || typeof error !== "object") return "storage_operation_failed";
  const name = "name" in error && typeof error.name === "string" ? error.name : "";
  const status =
    "$metadata" in error &&
    error.$metadata &&
    typeof error.$metadata === "object" &&
    "httpStatusCode" in error.$metadata &&
    typeof error.$metadata.httpStatusCode === "number"
      ? error.$metadata.httpStatusCode
      : null;
  if (status === 403 || /accessdenied|forbidden/i.test(name)) {
    return "storage_access_denied";
  }
  if (status === 404 || /nosuchkey|notfound/i.test(name)) {
    return "storage_object_missing";
  }
  if (name === "AbortError") return "storage_operation_cancelled";
  return "storage_operation_failed";
}

/** Lists one bounded prefix page. Purge callers repeatedly request the first
 * page after deleting it, which avoids continuation-token skips while the
 * listing is being mutated. */
export async function listObjectsByPrefix(
  prefix: string,
  limit = 1000,
): Promise<R2ObjectSummary[]> {
  return (await listObjectPageByPrefix(prefix, limit)).objects;
}

export async function listObjectPageByPrefix(
  prefix: string,
  limit = 1000,
  continuationToken?: string,
  options?: { signal?: AbortSignal },
): Promise<{
  objects: R2ObjectSummary[];
  nextContinuationToken: string | null;
}> {
  options?.signal?.throwIfAborted();
  const client = getClient();
  const { bucket } = getR2Config();
  const response = await client.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      MaxKeys: Math.max(1, Math.min(1000, Math.floor(limit))),
      ContinuationToken: continuationToken,
    }),
    { abortSignal: options?.signal },
  );
  return {
    objects: (response.Contents ?? []).flatMap((object) =>
      object.Key
        ? [{
            key: object.Key,
            sizeBytes: Number(object.Size ?? 0),
            lastModified: object.LastModified ?? null,
          }]
        : [],
    ),
    nextContinuationToken: response.NextContinuationToken ?? null,
  };
}

export async function deleteObjects(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  if (keys.length > 1000) {
    throw new Error("R2 batch deletion cannot exceed 1,000 keys");
  }
  const client = getClient();
  const { bucket } = getR2Config();
  const response = await client.send(
    new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: {
        Quiet: true,
        Objects: keys.map((Key) => ({ Key })),
      },
    }),
  );
  if ((response.Errors?.length ?? 0) > 0) {
    throw new Error(
      `R2 batch deletion failed for ${response.Errors!.length} object(s)`,
    );
  }
}

export async function putJson(params: {
  key: string;
  value: unknown;
  metadata?: Record<string, string>;
}) {
  await projectStorageDeadline(params.key);
  const client = getClient();
  const { bucket } = getR2Config();

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: params.key,
      Body: JSON.stringify(params.value, null, 2),
      ContentType: "application/json",
      Metadata: sanitizeObjectMetadata(params.metadata),
    }),
  );

  return { key: params.key };
}

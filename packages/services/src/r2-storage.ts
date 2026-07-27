import { open, readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const SIGNED_URL_TTL_SECONDS = 60 * 60;
/** Ceiling for the single-PUT path, whose body is held in memory. Anything
 *  larger goes multipart — see the comment in putFileFromPath for why a
 *  streamed single PUT is not an option against R2. 16 MB comfortably covers
 *  preview proxies (~1-3 MB) and dub audio without risking the worker's heap. */
const BUFFERED_PUT_MAX_BYTES = 16 * 1024 * 1024;

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
  const client = getClient();
  const { bucket } = getR2Config();

  const response = await client.send(
    new CreateMultipartUploadCommand({
      Bucket: bucket,
      Key: params.key,
      ContentType: params.contentType,
      Metadata: params.metadata,
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
}) {
  const client = getClient();
  const { bucket } = getR2Config();

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
          expiresIn: SIGNED_URL_TTL_SECONDS,
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
  const client = getClient();
  const { bucket } = getR2Config();

  const response = await client.send(
    new ListPartsCommand({
      Bucket: bucket,
      Key: params.key,
      UploadId: params.uploadId,
    }),
  );

  return (response.Parts ?? [])
    .map((part) => ({
      partNumber: part.PartNumber ?? 0,
      etag: part.ETag ?? "",
    }))
    .filter((part) => part.partNumber > 0 && part.etag);
}

export async function completeMultipartUpload(params: {
  key: string;
  uploadId: string;
  etags: Array<{ partNumber: number; etag: string }>;
}) {
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
  };
}

export async function putFileFromPath(params: {
  key: string;
  filePath: string;
  contentType?: string;
  metadata?: Record<string, string>;
}) {
  const client = getClient();
  const { bucket } = getR2Config();
  const fileInfo = await stat(params.filePath);

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
        Metadata: params.metadata,
      }),
    );
  } else {
    const created = await client.send(
      new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: params.key,
        ContentType: params.contentType,
        Metadata: params.metadata,
      }),
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

      for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
        const start = (partNumber - 1) * MULTIPART_PART_SIZE_BYTES;
        const end = Math.min(
          start + MULTIPART_PART_SIZE_BYTES,
          fileInfo.size,
        );
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
        );
        if (!uploaded.ETag) {
          throw new Error("R2 multipart part did not return an etag");
        }
        parts.push({ ETag: uploaded.ETag, PartNumber: partNumber });
      }

      await client.send(
        new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: params.key,
          UploadId: uploadId,
          MultipartUpload: { Parts: parts },
        }),
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
}) {
  const client = getClient();
  const { bucket } = getR2Config();

  const response = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: params.key,
    }),
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
  );

  return {
    key: params.key,
    contentType: response.ContentType ?? null,
  };
}

export async function presignDownloadUrl(params: {
  key: string;
  expiresIn?: number;
  fileName?: string;
}): Promise<string> {
  const client = getClient();
  const { bucket } = getR2Config();

  return getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: bucket,
      Key: params.key,
      ...(params.fileName && {
        ResponseContentDisposition: `attachment; filename="${params.fileName}"`,
      }),
    }),
    { expiresIn: params.expiresIn ?? 3600 },
  );
}

export async function presignSingleUploadUrl(params: {
  key: string;
  contentType: string;
  expiresIn?: number;
}): Promise<string> {
  const client = getClient();
  const { bucket } = getR2Config();

  return getSignedUrl(
    client,
    new PutObjectCommand({
      Bucket: bucket,
      Key: params.key,
      ContentType: params.contentType,
    }),
    { expiresIn: params.expiresIn ?? SIGNED_URL_TTL_SECONDS },
  );
}

export async function deleteObject(key: string) {
  const client = getClient();
  const { bucket } = getR2Config();

  await client.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
    }),
  );

  return { key };
}

export async function putJson(params: {
  key: string;
  value: unknown;
  metadata?: Record<string, string>;
}) {
  const client = getClient();
  const { bucket } = getR2Config();

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: params.key,
      Body: JSON.stringify(params.value, null, 2),
      ContentType: "application/json",
      Metadata: params.metadata,
    }),
  );

  return { key: params.key };
}

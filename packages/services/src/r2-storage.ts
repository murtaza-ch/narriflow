import { readServiceEnvironment } from "./runtime-environment";
import { createHash } from "node:crypto";
import { createR2Client } from "./r2-client";
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
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getPrismaClient } from "@narriflow/db/client";

const SIGNED_URL_TTL_SECONDS = 60 * 60;
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

export class InvalidMultipartUploadIdentityError extends Error {
  constructor() {
    super("R2 returned a malformed multipart upload identity");
    this.name = "InvalidMultipartUploadIdentityError";
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

function getRequiredEnv(name: string) {
  const value = readServiceEnvironment()[name]?.trim();
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

function getClient() {
  const { accountId, accessKeyId, secretAccessKey } = getR2Config();
  return createR2Client({ accountId, accessKeyId, secretAccessKey });
}

export function isR2Configured() {
  return Boolean(
    readServiceEnvironment().R2_ACCOUNT_ID &&
    readServiceEnvironment().R2_ACCESS_KEY_ID &&
    readServiceEnvironment().R2_SECRET_ACCESS_KEY &&
    readServiceEnvironment().R2_BUCKET,
  );
}

export async function createMultipartUpload(params: {
  key: string;
  contentType: string;
  metadata?: Record<string, string>;
  signal?: AbortSignal;
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
    { abortSignal: params.signal },
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
  signal?: AbortSignal;
  onProviderCall?: () => void;
  pageSize?: number;
}) {
  await projectStorageDeadline(params.key);
  const client = getClient();
  const { bucket } = getR2Config();

  return collectUploadedParts(async ({ partNumberMarker }) => {
    params.onProviderCall?.();
    return client.send(
      new ListPartsCommand({
        Bucket: bucket,
        Key: params.key,
        UploadId: params.uploadId,
        PartNumberMarker: partNumberMarker,
        MaxParts: params.pageSize,
      }),
      { abortSignal: params.signal },
    );
  });
}

interface MultipartPartInventoryPage {
  Parts?: Array<{ PartNumber?: number; ETag?: string }>;
  IsTruncated?: boolean;
  NextPartNumberMarker?: string;
}

export async function collectUploadedParts(
  fetchPage: (markers: {
    partNumberMarker?: string;
  }) => Promise<MultipartPartInventoryPage>,
) {
  const parts: Array<{ partNumber: number; etag: string }> = [];
  let partNumberMarker: string | undefined;
  let hasMoreParts = true;
  while (hasMoreParts) {
    const response = await fetchPage({ partNumberMarker });
    parts.push(
      ...(response.Parts ?? []).map((part) => ({
        partNumber: part.PartNumber ?? 0,
        etag: part.ETag ?? "",
      })),
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

interface MultipartUploadInventoryPage {
  Uploads?: Array<{
    Key?: string;
    UploadId?: string;
    Initiated?: Date;
  }>;
  IsTruncated?: boolean;
  NextKeyMarker?: string;
  NextUploadIdMarker?: string;
}

export async function collectExactKeyMultipartUploads(
  key: string,
  fetchPage: (markers: {
    keyMarker?: string;
    uploadIdMarker?: string;
  }) => Promise<MultipartUploadInventoryPage>,
) {
  const uploads: Array<{ uploadId: string; initiatedAt: Date | null }> = [];
  let keyMarker: string | undefined;
  let uploadIdMarker: string | undefined;
  let hasMoreUploads = true;

  while (hasMoreUploads) {
    const response = await fetchPage({ keyMarker, uploadIdMarker });
    for (const upload of response.Uploads ?? []) {
      if (upload.Key !== key) continue;
      const uploadId = upload.UploadId;
      if (!uploadId || uploadId.length > 2_048) {
        throw new InvalidMultipartUploadIdentityError();
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

export async function listExactKeyMultipartUploads(params: {
  key: string;
  signal?: AbortSignal;
  onProviderCall?: () => void;
}) {
  const client = getClient();
  const { bucket } = getR2Config();
  return collectExactKeyMultipartUploads(
    params.key,
    async ({ keyMarker, uploadIdMarker }) => {
      params.onProviderCall?.();
      return client.send(
        new ListMultipartUploadsCommand({
          Bucket: bucket,
          Prefix: params.key,
          KeyMarker: keyMarker,
          UploadIdMarker: uploadIdMarker,
        }),
        { abortSignal: params.signal },
      );
    },
  );
}

export async function completeMultipartUpload(params: {
  key: string;
  uploadId: string;
  etags: Array<{ partNumber: number; etag: string }>;
  signal?: AbortSignal;
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
    { abortSignal: params.signal },
  );
}

export async function abortMultipartUpload(params: {
  key: string;
  uploadId: string;
  signal?: AbortSignal;
}) {
  const client = getClient();
  const { bucket } = getR2Config();

  try {
    await client.send(
      new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: params.key,
        UploadId: params.uploadId,
      }),
      { abortSignal: params.signal },
    );
  } catch (error) {
    if (!isExactMissingMultipartUploadError(error)) throw error;
  }
}

export function isExactMissingMultipartUploadError(error: unknown) {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { name?: unknown; code?: unknown; Code?: unknown };
  return [candidate.name, candidate.code, candidate.Code].includes(
    "NoSuchUpload",
  );
}

export async function headObject(key: string, options?: { signal?: AbortSignal }) {
  await projectStorageDeadline(key);
  const client = getClient();
  const { bucket } = getR2Config();

  const response = await client.send(
    new HeadObjectCommand({
      Bucket: bucket,
      Key: key,
    }),
    { abortSignal: options?.signal },
  );

  return {
    contentType: response.ContentType ?? null,
    sizeBytes: response.ContentLength ?? null,
    etag: response.ETag ?? null,
    metadata: response.Metadata ?? {},
  };
}

export async function readObjectBytes(
  key: string,
  maxBytes: number,
  options?: { signal?: AbortSignal },
): Promise<Buffer> {
  await projectStorageDeadline(key);
  const client = getClient();
  const { bucket } = getR2Config();
  const response = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { abortSignal: options?.signal },
  );
  if (!response.Body) throw new Error("R2 object body is missing");
  if ((response.ContentLength ?? 0) > maxBytes) {
    throw new Error("R2 object exceeds the bounded read limit");
  }
  const body = response.Body as { transformToByteArray?: () => Promise<Uint8Array> };
  if (!body.transformToByteArray) throw new Error("R2 object body cannot be buffered");
  const bytes = Buffer.from(await body.transformToByteArray());
  if (bytes.byteLength > maxBytes) throw new Error("R2 object exceeds the bounded read limit");
  return bytes;
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
  /** Copy only if the source still has this ETag; otherwise the provider
   * rejects the request with 412 PreconditionFailed. */
  sourceIfMatch?: string;
  signal?: AbortSignal;
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
      ...(params.sourceIfMatch ? { CopySourceIfMatch: params.sourceIfMatch } : {}),
    }),
    { abortSignal: params.signal },
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
  if (status === 412 || /preconditionfailed/i.test(name)) {
    return "storage_precondition_failed";
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
  signal?: AbortSignal;
}) {
  params.signal?.throwIfAborted();
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
    { abortSignal: params.signal },
  );

  return { key: params.key };
}

export async function putObjectBytes(params: {
  key: string;
  bytes: Uint8Array;
  contentType: string;
  metadata?: Record<string, string>;
  signal?: AbortSignal;
  ifNoneMatch?: "*";
}) {
  params.signal?.throwIfAborted();
  await projectStorageDeadline(params.key);
  const client = getClient();
  const { bucket } = getR2Config();
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: params.key,
      Body: params.bytes,
      ContentLength: params.bytes.byteLength,
      ContentType: params.contentType,
      IfNoneMatch: params.ifNoneMatch,
      Metadata: sanitizeObjectMetadata(params.metadata),
    }),
    { abortSignal: params.signal },
  );
  return { key: params.key };
}



/** Exact assigned object, independently measured bytes; descriptor fields never authorize another key. */
export async function readAssignedArtifactJson(artifact: import("./executor-domain-control").ExecutorArtifactCommit, maxBytes: number): Promise<unknown> {
  if (artifact.contentType !== "application/json" || maxBytes < 1 || maxBytes > (artifact.role === "outbound_receipt" ? 4 * 1024 * 1024 : 65536) || artifact.byteLength > BigInt(maxBytes)) throw new Error("execution_artifact_invalid");
  const { bucket } = getR2Config();
  const result = await getClient().send(new GetObjectCommand({ Bucket: bucket, Key: artifact.storageKey, IfMatch: artifact.etag, Range: `bytes=0-${maxBytes}` }));
  if (!result.Body || result.ETag !== artifact.etag || BigInt(result.ContentLength ?? -1) !== artifact.byteLength || result.ContentType !== artifact.contentType ||
    result.Metadata?.["execution-artifact-id"] !== artifact.artifactId || result.Metadata?.["execution-binding-hash"] !== artifact.bindingHash) {
    (result.Body as { destroy?: () => void } | undefined)?.destroy?.();
    throw new Error("execution_artifact_invalid");
  }
  const stream = result.Body as AsyncIterable<Uint8Array>;
  const parts: Uint8Array[] = []; let length = 0;
  for await (const part of stream) { length += part.byteLength; if (length > maxBytes) throw new Error("execution_artifact_invalid"); parts.push(part); }
  const bytes = Buffer.concat(parts);
  if (BigInt(length) !== artifact.byteLength || createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) throw new Error("execution_artifact_invalid");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

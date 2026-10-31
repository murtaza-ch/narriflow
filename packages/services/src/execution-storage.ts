import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CopyObjectCommand,
  CreateMultipartUploadCommand, GetObjectCommand, HeadObjectCommand,
  ListMultipartUploadsCommand, ListPartsCommand, S3Client, UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { FetchHttpHandler } from "@smithy/fetch-http-handler";
import { MAX_CONDITIONAL_COPY_SIZE_BYTES, MAX_UPLOAD_SIZE_BYTES } from "@narriflow/validators";

export const EXECUTION_PART_SIZE_BYTES = 16 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

export class ExecutionStorageError extends Error {
  constructor(readonly code: "storage_configuration_invalid" | "storage_assignment_invalid" | "storage_grant_expired" |
    "storage_object_missing" | "storage_upload_missing" | "storage_source_changed" | "storage_provider_failed" |
    "storage_parts_invalid" | "storage_part_checksum_unavailable" | "storage_completion_unconfirmed") {
    super(code); this.name = "ExecutionStorageError";
  }
}

export interface ExecutionStorageConfig { accountId: string; bucket: string; accessKeyId: string; secretAccessKey: string }
export interface ExecutionStorageObject {
  artifactId: string;
  storageKey: string;
  bindingHash: string;
  contentType: string;
  byteLength: number;
}
export interface ExecutionPinSource { storageKey: string; etag: string; byteLength: number }
export interface ExecutionMultipartAssignment extends ExecutionStorageObject { uploadId: string; partSizeBytes: number }
export interface ExecutionPartReceipt { partNumber: number; etag: string; checksumSha256: string; checksumMd5: string }
export interface ExecutionStorageGrant { url: string; headers: Record<string, string>; expiresAt: Date }
export interface ExecutionStoredObject { key: string; etag: string; byteLength: number; contentType: string }
export interface ExecutionGrantWindow { leaseExpiresAt: Date; operationDeadlineAt: Date }

function key(value: string) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9/_.-]{0,1023}$/.test(value) &&
    !value.split("/").some(segment => segment === "" || segment === "." || segment === "..");
}
function etag(value: unknown): value is string { return typeof value === "string" && /^[\x21-\x7e]{1,160}$/.test(value); }
function checksum(value: unknown, byteLength = 32): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  try { const decoded = atob(value); return decoded.length === byteLength && btoa(decoded) === value; } catch { return false; }
}
function partMd5(value: string) {
  const match = /^(?:"([a-f0-9]{32})"|([a-f0-9]{32}))$/.exec(value);
  const hex = match?.[1] ?? match?.[2];
  if (!hex) throw new ExecutionStorageError("storage_part_checksum_unavailable");
  return btoa(hex.replace(/../g, pair => String.fromCharCode(Number.parseInt(pair, 16))));
}
function object(value: ExecutionStorageObject) {
  if (!key(value.storageKey) || !value.storageKey.startsWith("execution/") ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.artifactId) || !/^[a-f0-9]{64}$/.test(value.bindingHash) ||
    !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(value.contentType) || value.contentType.length > 128 ||
    !Number.isSafeInteger(value.byteLength) || value.byteLength < 1 || value.byteLength > MAX_UPLOAD_SIZE_BYTES) {
    throw new ExecutionStorageError("storage_assignment_invalid");
  }
}
function assignment(value: ExecutionMultipartAssignment) {
  object(value);
  if (typeof value.uploadId !== "string" || value.uploadId.length < 1 || value.uploadId.length > 2048 ||
    !/^[\x21-\x7e]+$/.test(value.uploadId) || value.partSizeBytes !== EXECUTION_PART_SIZE_BYTES) {
    throw new ExecutionStorageError("storage_assignment_invalid");
  }
}
function source(value: ExecutionPinSource, byteLength: number) {
  if (!key(value.storageKey) || !etag(value.etag) || value.byteLength !== byteLength) throw new ExecutionStorageError("storage_assignment_invalid");
}
function partBytes(value: ExecutionMultipartAssignment, number: number) {
  const count = Math.ceil(value.byteLength / value.partSizeBytes);
  if (!Number.isInteger(number) || number < 1 || number > count) throw new ExecutionStorageError("storage_parts_invalid");
  return Math.min(value.partSizeBytes, value.byteLength - (number - 1) * value.partSizeBytes);
}

/** Content-MD5 is the one proven R2 UploadPart checksum plan. SHA256 remains
 * executor-measured evidence; neither ListParts nor HEAD independently verifies
 * the full-object SHA256. Provider operations only. Callers must authorize fences and persist create/complete intent before calling. */
export function createExecutionStorage(config: ExecutionStorageConfig, options: { client?: S3Client; now?: () => Date } = {}) {
  if (!/^[a-f0-9]{32}$/.test(config.accountId) || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket) ||
    typeof config.accessKeyId !== "string" || !config.accessKeyId || typeof config.secretAccessKey !== "string" || !config.secretAccessKey) throw new ExecutionStorageError("storage_configuration_invalid");
  const now = options.now ?? (() => new Date());
  const client = options.client ?? new S3Client({ region: "auto", endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    requestHandler: new FetchHttpHandler({ requestTimeout: REQUEST_TIMEOUT_MS }), maxAttempts: 3,
    requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED" });
  const bucket = config.bucket;
  const metadata = (value: ExecutionStorageObject) => ({ "execution-artifact-id": value.artifactId, "execution-binding-hash": value.bindingHash });
  async function provider<T>(work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal, completing = false): Promise<T> {
    try { return await work(signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS)); }
    catch (error) {
      if (completing) throw new ExecutionStorageError("storage_completion_unconfirmed");
      const name = error && typeof error === "object" && "name" in error ? error.name : null;
      if (name === "NoSuchKey" || name === "NotFound") throw new ExecutionStorageError("storage_object_missing");
      if (name === "NoSuchUpload") throw new ExecutionStorageError("storage_upload_missing");
      if (name === "PreconditionFailed") throw new ExecutionStorageError("storage_source_changed");
      throw new ExecutionStorageError("storage_provider_failed");
    }
  }
  function expiry(window: ExecutionGrantWindow) {
    const issuedAt = now();
    const seconds = Math.floor((Math.min(window.leaseExpiresAt.getTime(), window.operationDeadlineAt.getTime(), issuedAt.getTime() + 120_000) - issuedAt.getTime()) / 1000);
    if (!Number.isFinite(seconds) || seconds < 1) throw new ExecutionStorageError("storage_grant_expired");
    return { issuedAt, seconds, expiresAt: new Date(issuedAt.getTime() + seconds * 1000) };
  }
  async function head(value: ExecutionStorageObject, signal?: AbortSignal): Promise<ExecutionStoredObject | null> {
    object(value);
    try {
      const found = await provider(abortSignal => client.send(new HeadObjectCommand({ Bucket: bucket, Key: value.storageKey }), { abortSignal }), signal);
      if (!etag(found.ETag) || found.ContentLength !== value.byteLength || found.ContentType !== value.contentType ||
        found.Metadata?.["execution-artifact-id"] !== value.artifactId || found.Metadata?.["execution-binding-hash"] !== value.bindingHash) {
        throw new ExecutionStorageError("storage_completion_unconfirmed");
      }
      return { key: value.storageKey, etag: found.ETag, byteLength: found.ContentLength, contentType: found.ContentType };
    } catch (error) {
      if (error instanceof ExecutionStorageError && error.code === "storage_object_missing") return null;
      throw error;
    }
  }
  async function listParts(value: ExecutionMultipartAssignment, signal?: AbortSignal) {
    assignment(value);
    const parts: Array<Omit<ExecutionPartReceipt, "checksumSha256"> & { byteLength: number }> = [];
    let marker: string | undefined;
    for (let page = 0; page < 2; page++) {
      const result = await provider(abortSignal => client.send(new ListPartsCommand({ Bucket: bucket, Key: value.storageKey,
        UploadId: value.uploadId, PartNumberMarker: marker, MaxParts: 1000 }), { abortSignal }), signal);
      for (const part of result.Parts ?? []) {
        if (!Number.isInteger(part.PartNumber) || !etag(part.ETag) || part.Size !== partBytes(value, part.PartNumber ?? 0)) throw new ExecutionStorageError("storage_parts_invalid");
        parts.push({ partNumber: part.PartNumber ?? 0, etag: part.ETag, checksumMd5: partMd5(part.ETag), byteLength: part.Size });
      }
      if (parts.length > Math.ceil(value.byteLength / value.partSizeBytes)) throw new ExecutionStorageError("storage_parts_invalid");
      if (!result.IsTruncated) return parts;
      if (!result.NextPartNumberMarker || result.NextPartNumberMarker === marker) throw new ExecutionStorageError("storage_parts_invalid");
      marker = result.NextPartNumberMarker;
    }
    throw new ExecutionStorageError("storage_parts_invalid");
  }
  return {
    async signSource(frozen: ExecutionPinSource, window: ExecutionGrantWindow): Promise<ExecutionStorageGrant> {
      if (!key(frozen.storageKey) || !etag(frozen.etag) || !Number.isSafeInteger(frozen.byteLength) ||
        frozen.byteLength < 1 || frozen.byteLength > MAX_UPLOAD_SIZE_BYTES) throw new ExecutionStorageError("storage_assignment_invalid");
      const ttl = expiry(window);
      const url = await provider(() => getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: frozen.storageKey, IfMatch: frozen.etag }), {
        expiresIn: ttl.seconds, signingDate: ttl.issuedAt, signableHeaders: new Set(["if-match"]),
      }));
      return { url, headers: { "If-Match": frozen.etag }, expiresAt: ttl.expiresAt };
    },
    async signInput(frozen: ExecutionPinSource, window: ExecutionGrantWindow): Promise<ExecutionStorageGrant> {
      if (!key(frozen.storageKey) || !frozen.storageKey.startsWith("execution-input/") || !etag(frozen.etag) ||
        !Number.isSafeInteger(frozen.byteLength) || frozen.byteLength < 1 || frozen.byteLength > 16 * 1024 * 1024) throw new ExecutionStorageError("storage_assignment_invalid");
      const ttl = expiry(window);
      const url = await provider(() => getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: frozen.storageKey, IfMatch: frozen.etag }), {
        expiresIn: ttl.seconds, signingDate: ttl.issuedAt, signableHeaders: new Set(["if-match"]),
      }));
      return { url, headers: { "If-Match": frozen.etag }, expiresAt: ttl.expiresAt };
    },
    async create(value: ExecutionStorageObject, signal?: AbortSignal): Promise<ExecutionMultipartAssignment> {
      object(value);
      const result = await provider(abortSignal => client.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: value.storageKey,
        ContentType: value.contentType, Metadata: metadata(value) }), { abortSignal }), signal);
      const created = { ...value, uploadId: result.UploadId ?? "", partSizeBytes: EXECUTION_PART_SIZE_BYTES };
      assignment(created);
      return created;
    },
    async findUnfinished(storageKey: string, signal?: AbortSignal) {
      if (!key(storageKey) || !storageKey.startsWith("execution/")) throw new ExecutionStorageError("storage_assignment_invalid");
      const uploads: Array<{ uploadId: string; initiatedAt: Date }> = [];
      let keyMarker: string | undefined, uploadIdMarker: string | undefined;
      for (let page = 0; page < 10; page++) {
        const result = await provider(abortSignal => client.send(new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: storageKey,
          KeyMarker: keyMarker, UploadIdMarker: uploadIdMarker, MaxUploads: 1000 }), { abortSignal }), signal);
        for (const upload of result.Uploads ?? []) {
          if (upload.Key !== storageKey) continue;
          if (!upload.UploadId || !upload.Initiated || !Number.isFinite(upload.Initiated.getTime())) throw new ExecutionStorageError("storage_parts_invalid");
          uploads.push({ uploadId: upload.UploadId, initiatedAt: upload.Initiated });
        }
        if (!result.IsTruncated) return uploads.sort((a, b) => a.initiatedAt.getTime() - b.initiatedAt.getTime() || a.uploadId.localeCompare(b.uploadId));
        if (!result.NextKeyMarker || !result.NextUploadIdMarker || result.NextKeyMarker === keyMarker && result.NextUploadIdMarker === uploadIdMarker) throw new ExecutionStorageError("storage_parts_invalid");
        keyMarker = result.NextKeyMarker; uploadIdMarker = result.NextUploadIdMarker;
      }
      throw new ExecutionStorageError("storage_parts_invalid");
    },
    async signPart(value: ExecutionMultipartAssignment, input: ExecutionGrantWindow & { partNumber: number; byteLength: number; checksumSha256: string; checksumMd5: string }): Promise<ExecutionStorageGrant> {
      assignment(value);
      if (input.byteLength !== partBytes(value, input.partNumber) || !checksum(input.checksumSha256) || !checksum(input.checksumMd5, 16)) throw new ExecutionStorageError("storage_parts_invalid");
      const ttl = expiry(input);
      const url = await provider(() => getSignedUrl(client, new UploadPartCommand({ Bucket: bucket, Key: value.storageKey, UploadId: value.uploadId,
        PartNumber: input.partNumber, ContentLength: input.byteLength, ContentMD5: input.checksumMd5 }), {
        expiresIn: ttl.seconds, signingDate: ttl.issuedAt, signableHeaders: new Set(["content-length", "content-md5"]),
      }));
      return { url, headers: { "Content-Length": String(input.byteLength), "Content-MD5": input.checksumMd5 }, expiresAt: ttl.expiresAt };
    },
    async signSourceRange(value: ExecutionMultipartAssignment, frozen: ExecutionPinSource,
      input: ExecutionGrantWindow & { start: number; end: number }): Promise<ExecutionStorageGrant> {
      assignment(value); source(frozen, value.byteLength);
      const partNumber = input.start / value.partSizeBytes + 1;
      if (!Number.isSafeInteger(input.start) || !Number.isSafeInteger(input.end) || input.end - input.start !== partBytes(value, partNumber)) throw new ExecutionStorageError("storage_parts_invalid");
      const ttl = expiry(input), range = `bytes=${input.start}-${input.end - 1}`;
      const url = await provider(() => getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: frozen.storageKey, IfMatch: frozen.etag, Range: range }), {
        expiresIn: ttl.seconds, signingDate: ttl.issuedAt, signableHeaders: new Set(["if-match", "range"]),
      }));
      return { url, headers: { "If-Match": frozen.etag, Range: range }, expiresAt: ttl.expiresAt };
    },
    listParts,
    async complete(value: ExecutionMultipartAssignment, receipts: readonly ExecutionPartReceipt[], signal?: AbortSignal) {
      assignment(value);
      const count = Math.ceil(value.byteLength / value.partSizeBytes);
      if (receipts.length !== count || receipts.some((part, index) => part.partNumber !== index + 1 || !etag(part.etag) || !checksum(part.checksumSha256) || !checksum(part.checksumMd5, 16))) throw new ExecutionStorageError("storage_parts_invalid");
      const inventory = await listParts(value, signal);
      if (inventory.length !== count || inventory.some((part, index) => part.partNumber !== receipts[index]?.partNumber ||
        part.etag !== receipts[index]?.etag || part.checksumMd5 !== receipts[index]?.checksumMd5)) throw new ExecutionStorageError("storage_parts_invalid");
      await provider(abortSignal => client.send(new CompleteMultipartUploadCommand({ Bucket: bucket, Key: value.storageKey, UploadId: value.uploadId,
        MultipartUpload: { Parts: receipts.map(part => ({ PartNumber: part.partNumber, ETag: part.etag })) } }), { abortSignal }), signal, true);
      const target = await head(value, signal);
      if (!target) throw new ExecutionStorageError("storage_completion_unconfirmed");
      return target;
    },
    head,
    async copySmall(value: ExecutionStorageObject, frozen: ExecutionPinSource, signal?: AbortSignal) {
      object(value); source(frozen, value.byteLength);
      if (value.byteLength > MAX_CONDITIONAL_COPY_SIZE_BYTES) throw new ExecutionStorageError("storage_assignment_invalid");
      await provider(abortSignal => client.send(new CopyObjectCommand({ Bucket: bucket, Key: value.storageKey,
        CopySource: `${bucket}/${frozen.storageKey.split("/").map(encodeURIComponent).join("/")}`, CopySourceIfMatch: frozen.etag,
        MetadataDirective: "REPLACE", Metadata: metadata(value), ContentType: value.contentType }), { abortSignal }), signal);
      const target = await head(value, signal);
      if (!target) throw new ExecutionStorageError("storage_completion_unconfirmed");
      return target;
    },
    async abort(value: ExecutionMultipartAssignment, signal?: AbortSignal) {
      assignment(value);
      try { await provider(abortSignal => client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: value.storageKey, UploadId: value.uploadId }), { abortSignal }), signal); }
      catch (error) { if (!(error instanceof ExecutionStorageError && error.code === "storage_upload_missing")) throw error; }
    },
    close() { if (!options.client) client.destroy(); },
  };
}

import { AbortMultipartUploadCommand, DeleteObjectCommand, ListMultipartUploadsCommand, S3Client } from "@aws-sdk/client-s3";
import { FetchHttpHandler } from "@smithy/fetch-http-handler";
import type { ExecutionStorageConfig } from "./execution-storage";
import { MEDIA_CLEANUP_HTTP_TIMEOUT_MS, type MediaCleanupStorage } from "./media-cleanup-control";

export class MediaCleanupStorageError extends Error {
  constructor(readonly code: "cleanup_storage_configuration_invalid" | "cleanup_storage_key_invalid" | "cleanup_storage_unconfirmed") { super(code); }
}
/** Small metadata HTTP only, always the configured R2 origin/bucket. Exact-key
 * MPU inventory is bounded; an incomplete page never permits DELETE. */
export function createMediaCleanupStorage(config: ExecutionStorageConfig, options: { client?: S3Client } = {}): MediaCleanupStorage {
  if (!/^[a-f0-9]{32}$/.test(config.accountId) || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket) || !config.accessKeyId || !config.secretAccessKey) throw new MediaCleanupStorageError("cleanup_storage_configuration_invalid");
  const client = options.client ?? new S3Client({ region: "auto", endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }, maxAttempts: 1,
    requestHandler: new FetchHttpHandler({ requestTimeout: MEDIA_CLEANUP_HTTP_TIMEOUT_MS }), requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED" });
  return { async deleteExact(storageKey, options) {
    if (!/^[A-Za-z0-9][A-Za-z0-9/_.-]{0,1023}$/.test(storageKey) || storageKey.split("/").some(part => !part || part === "." || part === "..")) throw new MediaCleanupStorageError("cleanup_storage_key_invalid");
    const abortSignal = AbortSignal.any([options.signal, AbortSignal.timeout(MEDIA_CLEANUP_HTTP_TIMEOUT_MS)]), Bucket = config.bucket;
    try {
      const uploads = await client.send(new ListMultipartUploadsCommand({ Bucket, Prefix: storageKey, MaxUploads: 9 }), { abortSignal });
      const exact = (uploads.Uploads ?? []).filter(upload => upload.Key === storageKey);
      for (let offset = 0; offset < Math.min(exact.length, 8); offset += 4) await Promise.all(exact.slice(offset, offset + 4).map(async upload => {
        if (!upload.UploadId) throw new MediaCleanupStorageError("cleanup_storage_unconfirmed");
        try { await client.send(new AbortMultipartUploadCommand({ Bucket, Key: storageKey, UploadId: upload.UploadId }), { abortSignal }); }
        catch (error) { if ((error as { name?: string } | null)?.name !== "NoSuchUpload") throw error; }
      }));
      if (uploads.IsTruncated || exact.length > 8) throw new MediaCleanupStorageError("cleanup_storage_unconfirmed");
      const deleted = await client.send(new DeleteObjectCommand({ Bucket, Key: storageKey }), { abortSignal });
      if (![200, 204].includes(deleted.$metadata.httpStatusCode ?? 0)) throw new MediaCleanupStorageError("cleanup_storage_unconfirmed");
    } catch (error) {
      if ((error as { name?: string } | null)?.name === "NoSuchKey") return;
      if (error instanceof MediaCleanupStorageError) throw error;
      throw new MediaCleanupStorageError("cleanup_storage_unconfirmed");
    }
  } };
}

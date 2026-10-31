import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { FetchHttpHandler } from "@smithy/fetch-http-handler";
import type { ExecutionStorageConfig } from "./execution-storage";
import type { ClipSelectionStorage } from "./clip-selection-preparation";
import type { ClipSelectionObjectReference } from "./clip-selection-window";
import { clipSelectionBytesHash } from "./clip-selection-input";
import { WorkflowFailure } from "./workflow-attempt-contract";

const uuid = "[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
const inputKey = new RegExp(`^projects/${uuid}/selection/${uuid}/${uuid}/([a-f0-9]{64})\\.json$`);
const resultKey = new RegExp(`^execution/[1-9][0-9]*/clip_selection_window/${uuid}/[1-9][0-9]*/(?:server|${uuid}/${uuid})/selection_window/${uuid}/([a-f0-9]{64})\\.json$`);
function failure(code: "selection_storage_reference_invalid" | "selection_storage_changed" | "selection_storage_unavailable") {
  return new WorkflowFailure(code, code === "selection_storage_unavailable" ? "retryable" : "permanent", code.replaceAll("_", " "));
}
function key(storageKey: string) {
  const input = inputKey.exec(storageKey), result = resultKey.exec(storageKey);
  if (!input && !result) throw failure("selection_storage_reference_invalid");
  return { sha256: (input ?? result)![1]!, maximum: input ? 16_777_216 : 1_048_576 };
}
function status(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
}
function quotedEtag(etag: unknown): etag is string { return typeof etag === "string" && etag.length <= 160 && /^"[\x21\x23-\x7e]+"$/.test(etag); }

/** Workers-safe private JSON I/O. No caller-selected URLs or native transfer code. */
export function createClipSelectionStorage(config: ExecutionStorageConfig, options: { client?: S3Client } = {}): ClipSelectionStorage {
  if (!/^[a-f0-9]{32}$/.test(config.accountId) || !config.bucket || !config.accessKeyId || !config.secretAccessKey) throw new Error("selection_storage_configuration_invalid");
  const client = options.client ?? new S3Client({ region: "auto", endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }, requestHandler: new FetchHttpHandler({ requestTimeout: 10_000 }),
    requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED", maxAttempts: 3 });
  async function provider<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); } catch (error) {
      if (error instanceof WorkflowFailure) throw error;
      if ([404, 412].includes(status(error) ?? 0) || ["NoSuchKey", "NotFound", "PreconditionFailed"].includes((error as { name?: string } | null)?.name ?? "")) throw failure("selection_storage_changed");
      throw failure("selection_storage_unavailable");
    }
  }
  async function read(reference: ClipSelectionObjectReference): Promise<Uint8Array> {
    const expected = key(reference.storageKey);
    if (!quotedEtag(reference.etag) || expected.sha256 !== reference.sha256 || !Number.isSafeInteger(reference.byteLength) || reference.byteLength < 1 || reference.byteLength > expected.maximum) throw failure("selection_storage_reference_invalid");
    return provider(async () => {
      const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: reference.storageKey, IfMatch: reference.etag, Range: `bytes=0-${reference.byteLength - 1}` }), { abortSignal: AbortSignal.timeout(10_000) });
      if (!response.Body) throw failure("selection_storage_changed");
      const stream = response.Body.transformToWebStream();
      if (response.ETag !== reference.etag || response.ContentLength !== reference.byteLength || response.ContentType !== "application/json" || response.Metadata?.["selection-sha256"] !== reference.sha256) {
        await stream.cancel().catch(() => {}); throw failure("selection_storage_changed");
      }
      const reader = stream.getReader(), chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const chunk = await reader.read(); if (chunk.done) break;
          if (!(chunk.value instanceof Uint8Array) || length + chunk.value.byteLength > reference.byteLength) throw failure("selection_storage_changed");
          length += chunk.value.byteLength; chunks.push(chunk.value);
        }
        if (length !== reference.byteLength) throw failure("selection_storage_changed");
        const bytes = new Uint8Array(length); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        if (await clipSelectionBytesHash(bytes) !== reference.sha256) throw failure("selection_storage_changed");
        return bytes;
      } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      finally { reader.releaseLock(); }
    });
  }
  return {
    read,
    async write(storageKey, bytes) {
      const expected = key(storageKey), sha256 = await clipSelectionBytesHash(bytes);
      if (!bytes.byteLength || bytes.byteLength > expected.maximum || expected.sha256 !== sha256) throw failure("selection_storage_reference_invalid");
      return provider(async () => {
        let existing = false, putEtag: string | undefined;
        try {
          const written = await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: storageKey, Body: bytes, ContentLength: bytes.byteLength, ContentType: "application/json",
            IfNoneMatch: "*", Metadata: { "selection-sha256": sha256 } }), { abortSignal: AbortSignal.timeout(10_000) });
          putEtag = written.ETag;
        } catch (error) {
          if (status(error) !== 412 && (error as { name?: string } | null)?.name !== "PreconditionFailed") throw error;
          existing = true;
        }
        const head = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: storageKey }), { abortSignal: AbortSignal.timeout(10_000) });
        if (!quotedEtag(head.ETag) || head.ContentLength !== bytes.byteLength || head.ContentType !== "application/json" || head.Metadata?.["selection-sha256"] !== sha256 || (!existing && head.ETag !== putEtag)) throw failure("selection_storage_changed");
        if (existing) await read({ storageKey, etag: head.ETag, byteLength: bytes.byteLength, sha256 });
        return { etag: head.ETag, byteLength: bytes.byteLength, sha256 };
      });
    },
  };
}

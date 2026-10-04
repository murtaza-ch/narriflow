import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { parseArgs } from "node:util";
import { buildMcpContentPack, mcpGenerationSettingsSchema, openUploadSessionSchema, type OpenUploadSessionInput, type UploadMimeType } from "@narriflow/validators";
import type { FinalizeUploadSessionOutcome, GrantUploadPartsOutcome, OpenUploadSessionOutcome, ReadUploadSessionOutcome } from "@narriflow/services/upload-session.service";

export interface UploadVideoOptions {
  endpoint: string;
  apiKey: string;
  workspaceId: string;
  filePath: string;
  clientIdempotencyKey: string;
  title?: string;
  contentType?: UploadMimeType;
  generationContext?: OpenUploadSessionInput["generationContext"];
  fetch?: typeof fetch;
  signal?: AbortSignal;
  onProgress?: (completedBytes: number, totalBytes: number) => void;
}

const mimeTypes: Record<string, UploadMimeType> = { ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".aac": "audio/aac" };

/** Resumability belongs to Upload Sessions. Re-running this command with the
 * same key and unchanged file resumes its verified storage inventory. */
export async function uploadVideo(options: UploadVideoOptions): Promise<FinalizeUploadSessionOutcome> {
  const endpoint = new URL(options.endpoint);
  if (endpoint.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)) throw new Error("Narriflow endpoint must use HTTPS");
  if (endpoint.username || endpoint.password) throw new Error("Keep Narriflow credentials in NARRIFLOW_API_KEY");
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(options.workspaceId)) throw new Error("Select a workspace UUID from narriflow_list_workspaces");
  if (!options.apiKey.startsWith("nf_")) throw new Error("Set NARRIFLOW_API_KEY to a workspace API key");
  const file = await stat(options.filePath);
  if (!file.isFile()) throw new Error("The source must be a regular media file");
  const contentType = options.contentType ?? mimeTypes[extname(options.filePath).toLowerCase()];
  if (!contentType) throw new Error("Specify a supported media MIME type with --content-type");
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(options.filePath, { signal: options.signal })) digest.update(chunk);
  const fingerprint = `sha256:${digest.digest("hex")}`;
  const input = openUploadSessionSchema.parse({ clientIdempotencyKey: options.clientIdempotencyKey, title: options.title ?? basename(options.filePath), source: { fileName: basename(options.filePath), sizeBytes: file.size, contentType, browserFingerprint: fingerprint }, generationContext: options.generationContext ?? { contentPack: buildMcpContentPack(), languageCode: null } });
  const transport = options.fetch ?? fetch;
  async function request<T>(action: string, body: unknown): Promise<T> {
    const response = await transport(new URL(`/mcp/integrations/${encodeURIComponent(options.workspaceId)}/upload-sessions/${action}`, endpoint), { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.apiKey}` }, body: JSON.stringify(body), signal: options.signal, redirect: "error" });
    if (!response.ok) throw new Error(`Narriflow upload ${action} returned HTTP ${response.status}; retry with the same idempotency key`);
    return await response.json() as T;
  }
  let state: ReadUploadSessionOutcome = await request<OpenUploadSessionOutcome>("open", input);
  for (let attempt = 0; state.outcome === "reconciling" && attempt < 12; attempt++) {
    await abortableDelay(Math.min(state.retryAfterSeconds, 5) * 1000, options.signal);
    state = await request<ReadUploadSessionOutcome>("status", { clientIdempotencyKey: options.clientIdempotencyKey, sessionId: state.sessionId, browserFingerprint: fingerprint });
  }
  if (state.outcome === "queued_for_ingest") return state;
  if (state.outcome !== "uploading") throw new Error(`Upload is ${state.outcome}; retry with the same key after reconciliation completes`);
  const sessionId = state.sessionId;
  const parts: Array<{ partNumber: number; etag: string }> = [];
  let completedBytes = 0;
  const handle = await open(options.filePath, "r");
  try {
    if (state.transfer.kind === "single") {
      // The server's single-object threshold is bounded; multipart handles large files.
      if (file.size > 100 * 1024 * 1024) throw new Error("The server returned an invalid single-object transfer plan for a large file");
      const bytes = await handle.readFile({ signal: options.signal });
      await put(state.transfer.grant.url, bytes, state.transfer.contentType);
      completedBytes = bytes.length;
      options.onProgress?.(completedBytes, file.size);
    } else {
      const transfer = state.transfer;
      parts.push(...transfer.completedParts);
      completedBytes = parts.reduce((total, part) => total + Math.min(transfer.partSizeBytes, file.size - (part.partNumber - 1) * transfer.partSizeBytes), 0);
      options.onProgress?.(completedBytes, file.size);
      const grants = new Map(transfer.grants.map((grant) => [grant.partNumber, grant.url]));
      const done = new Set(parts.map((part) => part.partNumber));
      const missing = Array.from({ length: transfer.partCount }, (_, i) => i + 1).filter((number) => !done.has(number));
      const concurrency = Math.max(1, Math.min(4, transfer.concurrency));
      for (let start = 0; start < missing.length; start += concurrency) {
        const batch = missing.slice(start, start + concurrency);
        const needGrants = batch.filter((number) => !grants.has(number));
        if (needGrants.length) {
          const result = await request<GrantUploadPartsOutcome>("grants", { sessionId, partNumbers: needGrants });
          for (const grant of result.grants) grants.set(grant.partNumber, grant.url);
        }
        const results = await Promise.allSettled(batch.map(async (partNumber) => {
          const url = grants.get(partNumber);
          if (!url) throw new Error("Narriflow did not grant the requested part");
          const offset = (partNumber - 1) * transfer.partSizeBytes;
          const bytes = Buffer.alloc(Math.min(transfer.partSizeBytes, file.size - offset));
          const read = await handle.read(bytes, 0, bytes.length, offset);
          if (read.bytesRead !== bytes.length) throw new Error("Source changed during upload; start again with the unchanged source");
          const etag = await put(url, bytes);
          if (!etag) throw new Error("Storage did not return an ETag; allow the ETag response header in storage CORS");
          parts.push({ partNumber, etag });
          completedBytes += bytes.length;
          options.onProgress?.(completedBytes, file.size);
        }));
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      }
    }
  } finally { await handle.close(); }
  const current = await stat(options.filePath);
  if (current.size !== file.size || current.mtimeMs !== file.mtimeMs) throw new Error("Source changed during upload. Retry with the original unchanged file.");
  return request<FinalizeUploadSessionOutcome>("finalize", { sessionId, parts: parts.sort((a, b) => a.partNumber - b.partNumber) });

  async function put(url: string, bytes: Uint8Array, type?: string): Promise<string | null> {
    const response = await transport(url, { method: "PUT", body: new Uint8Array(bytes).buffer, headers: type ? { "Content-Type": type } : undefined, signal: options.signal, redirect: "error" });
    if (!response.ok) throw new Error(`Storage upload returned HTTP ${response.status}; retry the command with the same key`);
    return response.headers.get("etag");
  }
}

function abortableDelay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function main() {
  const { values } = parseArgs({ options: { file: { type: "string" }, workspace: { type: "string" }, key: { type: "string" }, title: { type: "string" }, "content-type": { type: "string" }, settings: { type: "string" } }, strict: true });
  if (!values.file || !values.workspace) throw new Error("Usage: bun run apps/mcp/src/upload.ts --file <path> --workspace <UUID> --key <UUID> [--title <title>]. Set NARRIFLOW_API_KEY and NARRIFLOW_URL in the environment.");
  const clientIdempotencyKey = values.key ?? randomUUID();
  // Print the replay key before networking, so an interrupted upload can resume.
  process.stderr.write(`Upload idempotency key: ${clientIdempotencyKey}\n`);
  const settings = mcpGenerationSettingsSchema.parse(values.settings ? JSON.parse(await readFile(values.settings, "utf8")) : {});
  const result = await uploadVideo({ endpoint: process.env.NARRIFLOW_URL ?? "http://localhost:3000", apiKey: process.env.NARRIFLOW_API_KEY ?? "", workspaceId: values.workspace, filePath: values.file, clientIdempotencyKey, title: values.title, contentType: values["content-type"] as UploadMimeType | undefined, generationContext: { contentPack: buildMcpContentPack(settings), languageCode: settings.languageCode } });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.main) main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : "Upload failed"}\n`); process.exitCode = 1; });

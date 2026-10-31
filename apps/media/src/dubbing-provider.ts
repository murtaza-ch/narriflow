import { open } from "node:fs/promises";
import { guardedFetch, type GuardedFetchOptions } from "./outbound-transport";

export type DubProviderRequest = (url: string, options: GuardedFetchOptions) => Promise<Response>;
export type DubProviderFailure = { outcome: "unknown" } | { outcome: "rejected"; httpStatus: 400 | 401 | 403 | 404 | 413 | 415 | 422 | 429 };
const refusals = new Set([400, 401, 403, 404, 413, 415, 422, 429]);
type Options = { apiKey: string; signal: AbortSignal; request?: DubProviderRequest };
function unknown(stage: "translation" | "speech", phase: "request" | "response" | "body" | "payload", error?: unknown): DubProviderFailure {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" && new Set(["EEXIST", "EBADF", "ENOSPC", "EACCES", "EPERM", "ERR_INVALID_ARG_TYPE", "ERR_INVALID_ARG_VALUE"]).has(error.code) ? error.code : null;
  console.warn(JSON.stringify({ level: "warn", message: "dubbing_provider_outcome_unconfirmed", providerStage: stage, phase, ioCode: code }));
  return { outcome: "unknown" };
}

async function post(stage: "translation" | "speech", body: object, options: Options): Promise<Response | DubProviderFailure> {
  if (!options.apiKey || options.apiKey.length > 8192 || /[\r\n\0]/.test(options.apiKey)) throw Error("dub_provider_configuration_invalid");
  options.signal.throwIfAborted();
  try {
    const response = await (options.request ?? guardedFetch)(`https://api.openai.com/v1/${stage === "translation" ? "responses" : "audio/speech"}`, {
      method: "POST", headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(stage === "translation" ? 120_000 : 180_000)]), timeoutMs: stage === "translation" ? 120_000 : 180_000, maxRedirects: 0,
    });
    if (response.ok) return response;
    await response.body?.cancel().catch(() => {});
    return refusals.has(response.status) ? { outcome: "rejected", httpStatus: response.status as Extract<DubProviderFailure, { outcome: "rejected" }>["httpStatus"] } : unknown(stage, "response");
  } catch (error) {
    options.signal.throwIfAborted();return unknown(stage, "request", error);
  }
}

/** One fixed-origin POST, bounded response, and no automatic retry. */
export async function submitDubTranslation(body: object, options: Options): Promise<DubProviderFailure | { outcome: "completed"; text: string; providerRequestId: string | null }> {
  const response = await post("translation", body, options);if (!(response instanceof Response)) return response;
  try {
    const chunks: Uint8Array[] = [];let size = 0;
    if (!response.body) return unknown("translation", "body");
    const reader = response.body.getReader();
    try { while (true) { const part = await reader.read();if (part.done) break;size += part.value.byteLength;if (size > 1024 ** 2) throw Error();chunks.push(part.value); } }
    finally { await reader.cancel().catch(() => {}); }
    const payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    const text = (typeof payload?.output_text === "string" ? payload.output_text : Array.isArray(payload?.output) ? payload.output.flatMap((item: { content?: unknown }) => Array.isArray(item?.content) ? item.content : []).flatMap((item: { text?: unknown }) => typeof item?.text === "string" ? [item.text] : []).join("") : "").trim();
    if (!text || text.length > 100_000 || text.includes("\0")) return unknown("translation", "payload");
    const providerRequestId = typeof payload?.id === "string" && /^[A-Za-z0-9_.:-]{1,256}$/.test(payload.id) ? payload.id : null;
    return { outcome: "completed", text, providerRequestId };
  } catch (error) { options.signal.throwIfAborted();return unknown("translation", "body", error); }
}

export async function submitDubSpeech(body: object, outputPath: string, options: Options): Promise<DubProviderFailure | { outcome: "completed" }> {
  const response = await post("speech", body, options);if (!(response instanceof Response)) return response;
  try {
    if (!response.body) return unknown("speech", "body");
    const file = await open(outputPath, "wx", 0o600), reader = response.body.getReader();let size = 0;
    try {
      while (true) { options.signal.throwIfAborted();const part = await reader.read();if (part.done) break;size += part.value.byteLength;if (size > 64 * 1024 ** 2) throw Error();await file.writeFile(part.value); }
    } finally { await file.close();await reader.cancel().catch(() => {}); }
    return size ? { outcome: "completed" } : unknown("speech", "body");
  } catch (error) { options.signal.throwIfAborted();return unknown("speech", "body", error); }
}

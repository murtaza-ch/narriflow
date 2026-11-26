import { openAiResponseText } from "./openai-responses";
import { parseRetryAfterMs } from "./retry-after";

// One streamed OpenAI Responses request with a strict JSON schema: the
// request AI word taggers share (clip-filler-tagging.ts, clip-emoji-tagging.ts).
// It never throws; every failure is a `failed` result.

export type TaggingFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface TaggingModel { model: string; reasoningEffort: string }

/**
 * Requests stream, because a Worker holds at most six connections waiting
 * for response headers and queues the rest; a streamed response sends its
 * headers at once.
 */
export const TAGGING_REQUEST_DEFAULTS = {
  requestTimeoutMs: 30_000,
  /** A request needs at least this long left to start. */
  minStartMs: 5_000,
  /** A 429 is retried only when this much time is left after waiting. */
  retryReserveMs: 10_000,
  /** A streamed response larger than this is abandoned: a completed reply under the
   *  output-token cap stays far below it (measured 38-154 kB). */
  maxResponseBytes: 2 * 1024 * 1024,
  /** Longest server-sent-event line kept while waiting for its end (measured up to 8 kB). */
  maxLineBytes: 256 * 1024,
} as const;

const TERMINAL_EVENTS = new Set(["response.completed", "response.incomplete", "response.failed", "error"]);
type TerminalEvent = { type: string; response?: unknown };

/**
 * Reads a Responses event stream (server-sent events: "event:" and "data:"
 * fields, an event ending at a blank line) until its first terminal event,
 * then stops reading. Returns that event's payload, or null (fail closed)
 * when the stream ends without one, a terminal event's data is not JSON or
 * names another type, a line or the body exceeds its cap, or reading fails.
 * Measured 2026-11-13: real streams are 38-154 kB with lines up to 8 kB.
 */
async function readTerminalEvent(body: ReadableStream<Uint8Array>): Promise<TerminalEvent | null> {
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffered = "", bytes = 0, name = "", data: string[] = [];
  // One complete event: null to keep reading, else the stream's outcome.
  const dispatch = (): { done: TerminalEvent | null } | null => {
    const event = name, joined = data.join("\n");
    name = ""; data = [];
    if (!TERMINAL_EVENTS.has(event)) return null;
    try {
      const payload = JSON.parse(joined) as TerminalEvent;
      return { done: payload && payload.type === event ? payload : null };
    } catch { return { done: null }; }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return null; // An event left unfinished at the end is discarded.
      bytes += value.byteLength;
      if (bytes > TAGGING_REQUEST_DEFAULTS.maxResponseBytes) return null;
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      if (utf8Bytes(buffered) > TAGGING_REQUEST_DEFAULTS.maxLineBytes) return null;
      for (const raw of lines) {
        if (utf8Bytes(raw) > TAGGING_REQUEST_DEFAULTS.maxLineBytes) return null;
        const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
        if (line === "") { const result = dispatch(); if (result) return result.done; continue; }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":"), field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "event") name = value;
        else if (field === "data") data.push(value);
      }
    }
  } catch { return null; } finally { await reader.cancel().catch(() => undefined); }
}

const encoder = new TextEncoder();
/** UTF-8 size of `text`, encoding only when its length alone cannot decide. */
function utf8Bytes(text: string): number {
  return text.length * 3 <= TAGGING_REQUEST_DEFAULTS.maxLineBytes ? text.length : encoder.encode(text).byteLength;
}

/** At most `maxBytes` of a body as text (for error replies). */
async function readBounded(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<string> {
  if (!body) return "";
  const reader = body.getReader(), decoder = new TextDecoder();
  let text = "", bytes = 0;
  try {
    while (bytes < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const kept = value.subarray(0, maxBytes - bytes);
      bytes += kept.byteLength;
      text += decoder.decode(kept, { stream: true });
    }
  } catch { /* a partial reply is enough */ } finally { await reader.cancel().catch(() => undefined); }
  return text;
}

export type TaggingRequestResult = { kind: "ok"; report: unknown; tokens: number } | { kind: "failed"; tokens: number; rateLimited?: true };

/** What one tagging request needs. */
export interface TaggingRequestConfig {
  apiKey: string;
  /** Absolute time (on `now`'s clock) by which the request has finished. */
  deadline: number;
  maxOutputTokens: number;
  fetch?: TaggingFetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** The caller's abort (a client disconnect); the deadline bounds the request without it. */
  signal?: AbortSignal;
}

/** The system prompt, user message and strict output schema of one tagging request. */
export interface TaggingRequest { system: string; user: string; schemaName: string; schema: Record<string, unknown> }

/** One streamed Responses request, bounded by one abort signal through the
 *  whole body. Retries once, only on a received 429 that is not a quota
 *  refusal (nothing was billed) and only when the wait leaves the reserve.
 */
export async function requestTaggingReport(config: TaggingRequestConfig, model: TaggingModel, request: TaggingRequest): Promise<TaggingRequestResult> {
  const fetchImpl = config.fetch ?? fetch, now = config.now ?? Date.now, sleep = config.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let tokens = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const remaining = config.deadline - now();
    if (remaining < TAGGING_REQUEST_DEFAULTS.minStartMs || config.signal?.aborted) return { kind: "failed", tokens };
    const timeout = AbortSignal.timeout(Math.min(TAGGING_REQUEST_DEFAULTS.requestTimeoutMs, remaining));
    const signal = config.signal ? AbortSignal.any([timeout, config.signal]) : timeout;
    let response: Response;
    try {
      response = await fetchImpl("https://api.openai.com/v1/responses", { method: "POST", signal,
        headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ model: model.model, reasoning: { effort: model.reasoningEffort }, max_output_tokens: config.maxOutputTokens, store: false,
          stream: true, stream_options: { include_obfuscation: false },
          input: [{ role: "system", content: request.system }, { role: "user", content: request.user }],
          text: { format: { type: "json_schema", name: request.schemaName, strict: true, schema: request.schema } } }) });
    } catch { return { kind: "failed", tokens }; }
    if (response.status === 429) {
      const body = await readBounded(response.body, 64 * 1024);
      // Without a server delay, wait 1-2 s with jitter so parallel retries do not land together.
      const wait = parseRetryAfterMs(response.headers.get("retry-after"), new Date(now())) ?? 1_000 + Math.floor(Math.random() * 1_000);
      if (attempt === 0 && !body.includes("insufficient_quota") && config.deadline - now() - wait > TAGGING_REQUEST_DEFAULTS.retryReserveMs) { await sleep(wait); continue; }
      return { kind: "failed", tokens, rateLimited: true };
    }
    if (!response.ok || !response.body) { await response.body?.cancel().catch(() => undefined); return { kind: "failed", tokens }; }
    const final = await readTerminalEvent(response.body);
    const payload = final?.response as { status?: string; usage?: { total_tokens?: number } } | undefined;
    const used = payload?.usage?.total_tokens;
    if (Number.isSafeInteger(used) && used! >= 0) tokens += used!;
    if (final?.type !== "response.completed" || payload?.status !== "completed") return { kind: "failed", tokens };
    const text = openAiResponseText(payload);
    if (!text) return { kind: "failed", tokens };
    try { return { kind: "ok", report: JSON.parse(text), tokens }; } catch { return { kind: "failed", tokens }; }
  }
  return { kind: "failed", tokens };
}

import {
  acceptFillerTags,
  chunkTranscriptForFillerTagging,
  collectFillerKeys,
  FILLER_TAG_MAX_KEY_LENGTH,
  FILLER_TAG_MAX_KEYS,
  FILLER_TAGGING_PROMPT,
  FILLER_TAGGING_SCHEMA,
  type FillerTaggingChunk,
  type FillerTaggingOutcome,
  type TranscriptUtterance,
} from "@narriflow/validators";
import { openAiResponseText } from "./openai-responses";
import { parseRetryAfterMs } from "./retry-after";

// AI filler tagging for one transcript, run once while clip selection
// prepares its frozen input. Optional enrichment: it never throws, and every
// failure leaves its chunk untagged (a missed filler, never a wrong cut).

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface FillerTaggingModel { model: string; reasoningEffort: string }

export interface FillerTaggingConfig {
  apiKey: string;
  /** Every model must accept a token for it to count. */
  models: readonly FillerTaggingModel[];
  /** Absolute time (on `now`'s clock) by which every request has finished. */
  deadline: number;
  /** Requests in flight at once, across all models. */
  concurrency: number;
  maxOutputTokens: number;
  fetch?: Fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Measured 2026-11-12 per 250-word chunk: luna (low) p50 4.2 s, p90 7.3 s,
 * p99 12 s; gpt-5.4 (none) p50 2.9 s. Both must finish, so a 3-hour source
 * may not be fully tagged within the budget; untagged chunks keep fillers. Requests stream, because a Worker holds at most six
 * connections waiting for response headers and queues the rest; a streamed
 * response sends its headers at once.
 */
export const FILLER_TAGGING_DEFAULTS = {
  /** Tagging ends this long after preparation starts; the 2-minute workflow
   *  command keeps 75 s for persistence, delivery and scheduling (Sol v3). */
  budgetMs: 45_000,
  concurrency: 24,
  maxOutputTokens: 4_000,
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

/**
 * Production models. A token is cut only when both accept it. Measured
 * 2026-11-12 on FLEURS (102 languages, 86,659 read-speech tokens): luna alone
 * 1 wrong tag, gpt-5.4 alone 3, both together 0; on the Nyra verbatim
 * benchmark (10 languages) together 82% recall of written fillers and no
 * real word cut. About $28 per million transcript words.
 */
export const FILLER_TAGGING_MODELS: readonly FillerTaggingModel[] = [
  { model: "gpt-5.6-luna", reasoningEffort: "low" },
  { model: "gpt-5.4", reasoningEffort: "none" },
];

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function fillerTaggingContract(config: Pick<FillerTaggingConfig, "models" | "maxOutputTokens">): Promise<FillerTaggingOutcome["contract"]> {
  return { models: config.models.map(({ model, reasoningEffort }) => ({ model, reasoningEffort })), promptSha256: await sha256(FILLER_TAGGING_PROMPT),
    schemaSha256: await sha256(JSON.stringify(FILLER_TAGGING_SCHEMA)), maxOutputTokens: config.maxOutputTokens };
}

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
      if (bytes > FILLER_TAGGING_DEFAULTS.maxResponseBytes) return null;
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      if (utf8Bytes(buffered) > FILLER_TAGGING_DEFAULTS.maxLineBytes) return null;
      for (const raw of lines) {
        if (utf8Bytes(raw) > FILLER_TAGGING_DEFAULTS.maxLineBytes) return null;
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
  return text.length * 3 <= FILLER_TAGGING_DEFAULTS.maxLineBytes ? text.length : encoder.encode(text).byteLength;
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

type RequestResult = { kind: "ok"; report: unknown; tokens: number } | { kind: "failed"; tokens: number };

/** One streamed Responses request, bounded by one abort signal through the
 *  whole body. Retries once, only on a received 429 that is not a quota
 *  refusal (nothing was billed) and only when the wait leaves the reserve. */
async function requestReport(config: FillerTaggingConfig, model: FillerTaggingModel, prompt: string): Promise<RequestResult> {
  const fetchImpl = config.fetch ?? fetch, now = config.now ?? Date.now, sleep = config.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let tokens = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const remaining = config.deadline - now();
    if (remaining < FILLER_TAGGING_DEFAULTS.minStartMs) return { kind: "failed", tokens };
    const signal = AbortSignal.timeout(Math.min(FILLER_TAGGING_DEFAULTS.requestTimeoutMs, remaining));
    let response: Response;
    try {
      response = await fetchImpl("https://api.openai.com/v1/responses", { method: "POST", signal,
        headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ model: model.model, reasoning: { effort: model.reasoningEffort }, max_output_tokens: config.maxOutputTokens, store: false,
          stream: true, stream_options: { include_obfuscation: false },
          input: [{ role: "system", content: FILLER_TAGGING_PROMPT }, { role: "user", content: prompt }],
          text: { format: { type: "json_schema", name: "fillers", strict: true, schema: FILLER_TAGGING_SCHEMA } } }) });
    } catch { return { kind: "failed", tokens }; }
    if (response.status === 429) {
      const body = await readBounded(response.body, 64 * 1024);
      // Without a server delay, wait 1-2 s with jitter so parallel retries do not land together.
      const wait = parseRetryAfterMs(response.headers.get("retry-after"), new Date(now())) ?? 1_000 + Math.floor(Math.random() * 1_000);
      if (attempt === 0 && !body.includes("insufficient_quota") && config.deadline - now() - wait > FILLER_TAGGING_DEFAULTS.retryReserveMs) { await sleep(wait); continue; }
      return { kind: "failed", tokens };
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

/** Tags hesitation sounds in `utterances` (a non-English transcript). */
export async function tagTranscriptFillers(utterances: TranscriptUtterance[], languageCode: string, config: FillerTaggingConfig): Promise<FillerTaggingOutcome> {
  const now = config.now ?? Date.now;
  const contract = await fillerTaggingContract(config);
  const chunks = chunkTranscriptForFillerTagging(utterances, languageCode);
  const accepted: number[][] = chunks.map(() => []);
  const outcome = { chunks: chunks.length, tagged: 0, failed: 0, skipped: 0, unsafe: 0, tokensUsed: 0 };
  if (!config.apiKey.trim() || config.models.length === 0) return { contract, ...outcome, skipped: chunks.length, overflow: false, keys: [] };

  let next = 0;
  const work = async () => {
    for (;;) {
      const index = next++;
      if (index >= chunks.length) return;
      const chunk: FillerTaggingChunk = chunks[index]!;
      if (chunk.prompt === null) { outcome.unsafe++; continue; }
      if (config.deadline - now() < FILLER_TAGGING_DEFAULTS.minStartMs) { outcome.skipped++; continue; }
      // Below one request per model, models run one after another to honour the cap.
      const results = config.concurrency >= config.models.length
        ? await Promise.all(config.models.map((model) => requestReport(config, model, chunk.prompt!)))
        : await config.models.reduce(async (done, model) => [...await done, await requestReport(config, model, chunk.prompt!)], Promise.resolve([] as RequestResult[]));
      outcome.tokensUsed += results.reduce((sum, r) => sum + r.tokens, 0);
      if (results.some((r) => r.kind !== "ok")) { outcome.failed++; continue; }
      // Agreement: a token counts only when every model accepts it.
      const sets = results.map((r) => new Set(acceptFillerTags(chunk, (r as { report: unknown }).report)));
      accepted[index] = [...sets[0]!].filter((id) => sets.every((set) => set.has(id))).sort((a, b) => a - b);
      outcome.tagged++;
    }
  };
  const workers = Math.max(1, Math.min(Math.floor(config.concurrency / config.models.length), chunks.length));
  await Promise.all(Array.from({ length: workers }, work));
  const keys = collectFillerKeys(chunks, accepted).filter((key) => key.length <= FILLER_TAG_MAX_KEY_LENGTH);
  // Too many tags to freeze is itself suspicious: keep none rather than an arbitrary subset.
  const overflow = keys.length > FILLER_TAG_MAX_KEYS;
  return { contract, ...outcome, overflow, keys: overflow ? [] : keys };
}

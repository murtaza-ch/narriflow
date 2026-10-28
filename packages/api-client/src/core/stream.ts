import { createParser } from "eventsource-parser";
import { ApiError, CLIENT_ERROR_CODES, isApiError } from "./error";
import type { BoundTransport } from "./transport";

export interface StreamMessage {
  /** The SSE `event:` name; `message` when the frame names none. */
  event: string;
  data: string;
  id?: string;
}

export interface ReadMessagesOptions {
  signal?: AbortSignal;
  /** No bytes (not even a heartbeat comment) for this long ends the read with `stream_idle`. */
  idleTimeoutMs?: number;
  /** Bounds a single unterminated frame. */
  maxBufferBytes?: number;
}

export const DEFAULT_IDLE_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_BUFFER_BYTES = 256 * 1024;

function streamError(code: string, message: string): ApiError {
  return new ApiError({ code, message, status: 0 });
}

function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      void reader.cancel().catch(() => undefined);
      reject(streamError(CLIENT_ERROR_CODES.streamIdle, "The event stream went silent."));
    }, idleTimeoutMs);
    reader.read().then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Parses an SSE response body into messages. Comments (heartbeats) keep the
 * stream alive but are never yielded. Ends when the body ends or `signal`
 * aborts; throws `stream_idle` on silence and `stream_protocol` when a frame
 * exceeds the buffer bound. Check the HTTP status before calling this.
 */
export async function* readStreamMessages(
  response: Response,
  options: ReadMessagesOptions = {},
): AsyncGenerator<StreamMessage, void, void> {
  if (!response.body) throw streamError(CLIENT_ERROR_CODES.unexpectedResponse, "The stream had no body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const pending: StreamMessage[] = [];
  let overflow = false;
  const parser = createParser({
    maxBufferSize: options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES,
    onEvent: (message) => {
      pending.push({
        event: message.event ?? "message",
        data: message.data,
        ...(message.id === undefined ? {} : { id: message.id }),
      });
    },
    onError: (error) => {
      // Unknown fields and bad retry values are ignorable; an oversized frame is not.
      if (error.type === "max-buffer-size-exceeded") overflow = true;
    },
  });
  const onAbort = () => void reader.cancel().catch(() => undefined);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await readWithIdleTimeout(reader, idleTimeoutMs);
      } catch (error) {
        if (error instanceof ApiError || options.signal?.aborted) throw error;
        throw new ApiError({
          code: CLIENT_ERROR_CODES.network,
          message: "The event stream was interrupted.",
          status: 0,
          cause: error,
        });
      }
      const { done, value } = chunk;
      if (done) return;
      parser.feed(decoder.decode(value, { stream: true }));
      if (overflow) {
        void reader.cancel().catch(() => undefined);
        throw streamError("stream_protocol", "The event stream sent an oversized frame.");
      }
      while (pending.length > 0) yield pending.shift() as StreamMessage;
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    void reader.cancel().catch(() => undefined);
  }
}

export type StreamStatus =
  | { state: "connecting"; attempt: number }
  | { state: "open"; attempt: number }
  | { state: "reconnecting"; attempt: number; retryInMs: number; error: ApiError | null }
  | { state: "closed" };

export type StreamEnd =
  | { reason: "aborted" }
  /** Retrying cannot help (refused, signed out, Workspace changed). Show the matching recovery. */
  | { reason: "fatal"; error: ApiError };

export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
}

export interface EventStreamOptions<TEvent> {
  transport: BoundTransport;
  path: string;
  /** Ends the stream. Pair with the owner's lifecycle (unmount, project change). */
  signal: AbortSignal;
  /** Query parameters for a connection resuming after `cursor` (null on the first connect). */
  query?: (cursor: number | null) => Readonly<Record<string, string | number | undefined>>;
  /** Maps a frame to an event, `null` to skip it, or throws to force a controlled reconnect. */
  decode: (message: StreamMessage) => TEvent | null;
  /** The monotonically increasing position of an event, if it has one. */
  cursorOf?: (event: TEvent) => number | null;
  /** Applied events advance the cursor only after this returns. A throw here is a bug and rejects the run. */
  onEvent: (event: TEvent) => void | Promise<void>;
  initialCursor?: number | null;
  onStatus?: (status: StreamStatus) => void;
  idleTimeoutMs?: number;
  backoff?: BackoffOptions;
  /** Injection points for tests. */
  random?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 1_000, maxMs: 30_000 };
/**
 * A server `Retry-After` is honored in full up to this long, independent of the
 * backoff cap (reconnecting sooner would just be refused again). A longer
 * refusal ends the run with that error, as the query retry policy does.
 */
export const MAX_STREAM_RETRY_AFTER_SECONDS = 300;
/** Statuses where trying again later can succeed. Everything else 4xx ends the stream. */
const RETRYABLE_STATUSES = new Set([0, 408, 429]);

function isRetryable(error: ApiError): boolean {
  if (error.code === CLIENT_ERROR_CODES.scopeChanged) return false;
  if (error.status >= 500) return true;
  return RETRYABLE_STATUSES.has(error.status) && error.code !== "workspace_selection_required";
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

class DecodeFailure extends Error {}

/**
 * Keeps one authenticated event stream alive. Each connection is a fresh
 * request (so a fresh token) that resumes after the last *applied* event;
 * a frame that fails to decode forces a reconnect from that cursor instead of
 * skipping it. HTTP failures are inspected before parsing: auth, permission,
 * conflict and missing-resource refusals end the run, transport/5xx/429
 * back off with jitter (honouring `Retry-After` up to
 * `MAX_STREAM_RETRY_AFTER_SECONDS`, beyond which the run ends), and a server-side close
 * reconnects. Resolves when `signal` aborts or a fatal refusal arrives.
 */
export async function runEventStream<TEvent>(
  options: EventStreamOptions<TEvent>,
): Promise<StreamEnd> {
  const { signal, onStatus } = options;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? defaultSleep;
  const backoff = options.backoff ?? DEFAULT_BACKOFF;
  let cursor = options.initialCursor ?? null;
  let attempt = 0;

  while (!signal.aborted) {
    onStatus?.({ state: "connecting", attempt });
    let delivered = false;
    let failure: ApiError | null = null;
    try {
      const query = options.query?.(cursor) ?? {};
      const search = new URLSearchParams();
      for (const [name, value] of Object.entries(query)) {
        if (value !== undefined) search.set(name, String(value));
      }
      const suffix = search.size > 0 ? `${options.path.includes("?") ? "&" : "?"}${search}` : "";
      const opened = await options.transport.open(`${options.path}${suffix}`, {
        method: "GET",
        headers: { Accept: "text/event-stream" },
        signal,
      });
      try {
        onStatus?.({ state: "open", attempt });
        for await (const message of readStreamMessages(opened.response, {
          signal,
          idleTimeoutMs: options.idleTimeoutMs,
        })) {
          let event: TEvent | null;
          try {
            event = options.decode(message);
          } catch (cause) {
            throw new DecodeFailure("stream frame failed to decode", { cause });
          }
          if (event === null) continue;
          await options.onEvent(event);
          delivered = true;
          const next = options.cursorOf?.(event) ?? null;
          if (next !== null && (cursor === null || next > cursor)) cursor = next;
        }
      } finally {
        opened.release();
      }
    } catch (error) {
      if (signal.aborted) break;
      if (error instanceof DecodeFailure) {
        failure = streamError("stream_protocol", "The event stream sent an unreadable frame.");
      } else if (isApiError(error)) {
        if (
          !isRetryable(error) ||
          (error.retryAfterSeconds ?? 0) > MAX_STREAM_RETRY_AFTER_SECONDS
        ) {
          onStatus?.({ state: "closed" });
          return { reason: "fatal", error };
        }
        failure = error;
      } else {
        throw error;
      }
    }
    if (signal.aborted) break;
    attempt = delivered ? 0 : attempt + 1;
    const ceiling = Math.min(backoff.baseMs * 2 ** Math.max(attempt - 1, 0), backoff.maxMs);
    const jittered = Math.round(ceiling * (0.5 + random() / 2));
    const retryInMs =
      failure?.retryAfterSeconds !== undefined
        ? failure.retryAfterSeconds * 1000
        : jittered;
    onStatus?.({ state: "reconnecting", attempt, retryInMs, error: failure });
    await sleep(retryInMs, signal);
  }
  onStatus?.({ state: "closed" });
  return { reason: "aborted" };
}

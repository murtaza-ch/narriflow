import { describe, expect, test } from "bun:test";
import { ApiError, CLIENT_ERROR_CODES } from "./error";
import { ApiScope } from "./scope";
import {
  readStreamMessages,
  runEventStream,
  type StreamMessage,
  type StreamStatus,
} from "./stream";
import { createApiTransport } from "./transport";
import { errorResponse, USER, WORKSPACE_A, WORKSPACE_B } from "./test-helpers";

const encoder = new TextEncoder();

function sseResponse(
  chunks: string[],
  options: { keepOpen?: boolean; signal?: AbortSignal } = {},
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (!options.keepOpen) controller.close();
      // A real fetch body errors with the abort reason when its request is aborted.
      options.signal?.addEventListener("abort", () => controller.error(options.signal?.reason));
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
}

async function collect(response: Response, options = {}): Promise<StreamMessage[]> {
  const messages: StreamMessage[] = [];
  for await (const message of readStreamMessages(response, options)) messages.push(message);
  return messages;
}

describe("readStreamMessages", () => {
  test("parses named frames, defaults to message, ignores heartbeat comments", async () => {
    const messages = await collect(
      sseResponse([
        ": heartbeat\n\n",
        'event: workflow.stage.updated\ndata: {"seq":1}\n\n',
        "data: plain\n\n",
        ": heartbeat\n\n",
      ]),
    );
    expect(messages).toEqual([
      { event: "workflow.stage.updated", data: '{"seq":1}' },
      { event: "message", data: "plain" },
    ]);
  });

  test("handles frames split across chunks, multibyte characters and CRLF", async () => {
    const payload = "event: a\r\ndata: héllo ✓\r\n\r\n";
    const bytes = encoder.encode(payload);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    const messages = await collect(new Response(stream));
    expect(messages).toEqual([{ event: "a", data: "héllo ✓" }]);
  });

  test("an oversized unterminated frame ends the read with stream_protocol", async () => {
    const error = await collect(sseResponse([`data: ${"x".repeat(5_000)}`]), {
      maxBufferBytes: 1_000,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("stream_protocol");
  });

  test("silence ends the read with stream_idle", async () => {
    const error = await collect(sseResponse([": hi\n\n"], { keepOpen: true }), {
      idleTimeoutMs: 30,
    }).catch((e: unknown) => e);
    expect((error as ApiError).code).toBe(CLIENT_ERROR_CODES.streamIdle);
  });

  test("aborting the signal ends the read cleanly", async () => {
    const controller = new AbortController();
    const response = sseResponse(["data: one\n\n"], { keepOpen: true });
    const seen: StreamMessage[] = [];
    for await (const message of readStreamMessages(response, { signal: controller.signal })) {
      seen.push(message);
      controller.abort();
    }
    expect(seen).toHaveLength(1);
  });
});

function harness(responses: Array<(signal: AbortSignal | undefined) => Response | Promise<Response>>) {
  const scope = new ApiScope();
  scope.setUser(USER);
  scope.selectWorkspace(WORKSPACE_A);
  const urls: string[] = [];
  const tokens: string[] = [];
  let n = 0;
  const transport = createApiTransport({
    baseUrl: "https://api.example.test",
    scope,
    getToken: async () => `token-${++n}`,
    fetch: (async (input: unknown, init: RequestInit = {}) => {
      urls.push(String(input));
      tokens.push(new Headers(init.headers).get("Authorization") ?? "");
      const respond = responses[Math.min(urls.length - 1, responses.length - 1)];
      if (!respond) throw new Error("no response");
      return respond(init.signal ?? undefined);
    }) as typeof fetch,
  });
  const bound = transport.scoped({ userId: USER, workspaceId: WORKSPACE_A });
  return { scope, bound, urls, tokens };
}

const frame = (seq: number) => `event: tick\ndata: {"seq":${seq}}\n\n`;
const decode = (message: StreamMessage) => {
  if (message.event !== "tick") return null;
  return JSON.parse(message.data) as { seq: number };
};
const noSleep = async () => undefined;

describe("runEventStream", () => {
  test("resumes from the last applied cursor with a fresh token on each connection", async () => {
    const { bound, urls, tokens } = harness([
      () => sseResponse([frame(1), frame(2)]),
      () => sseResponse([frame(3)]),
    ]);
    const controller = new AbortController();
    const applied: number[] = [];
    const statuses: StreamStatus["state"][] = [];
    const end = await runEventStream({
      transport: bound,
      path: "/api/stream/p1",
      signal: controller.signal,
      query: (cursor) => ({ sinceSeq: cursor ?? undefined }),
      decode,
      cursorOf: (event) => event.seq,
      onEvent: (event) => {
        applied.push(event.seq);
        if (event.seq === 3) controller.abort();
      },
      onStatus: (status) => statuses.push(status.state),
      sleep: noSleep,
    });
    expect(end).toEqual({ reason: "aborted" });
    expect(applied).toEqual([1, 2, 3]);
    expect(urls).toEqual([
      "https://api.example.test/api/stream/p1",
      "https://api.example.test/api/stream/p1?sinceSeq=2",
    ]);
    expect(tokens).toEqual(["Bearer token-1", "Bearer token-2"]);
    expect(statuses).toContain("reconnecting");
    expect(statuses.at(-1)).toBe("closed");
  });

  test("a frame that fails to decode reconnects from the last applied event, never skipping it", async () => {
    const { bound, urls } = harness([
      () => sseResponse([frame(1), "event: tick\ndata: {broken\n\n", frame(9)]),
      () => sseResponse([frame(2)]),
    ]);
    const controller = new AbortController();
    const applied: number[] = [];
    await runEventStream({
      transport: bound,
      path: "/api/stream/p1",
      signal: controller.signal,
      query: (cursor) => ({ sinceSeq: cursor ?? undefined }),
      decode,
      cursorOf: (event) => event.seq,
      onEvent: (event) => {
        applied.push(event.seq);
        if (event.seq === 2) controller.abort();
      },
      sleep: noSleep,
    });
    expect(applied).toEqual([1, 2]);
    expect(urls[1]).toContain("sinceSeq=1");
  });

  test("the cursor never moves backwards", async () => {
    const { bound, urls } = harness([
      () => sseResponse([frame(5), frame(3)]),
      () => sseResponse([]),
    ]);
    const controller = new AbortController();
    let sleeps = 0;
    await runEventStream({
      transport: bound,
      path: "/s",
      signal: controller.signal,
      query: (cursor) => ({ sinceSeq: cursor ?? undefined }),
      decode,
      cursorOf: (event) => event.seq,
      onEvent: () => undefined,
      sleep: async () => {
        sleeps += 1;
        if (sleeps === 2) controller.abort();
      },
    });
    expect(urls[1]).toContain("sinceSeq=5");
  });

  for (const [status, code] of [
    [401, "authentication_required"],
    [403, "capability_denied"],
    [404, "project_not_found"],
    [409, "workspace_selection_changed"],
  ] as const) {
    test(`${status} ${code} ends the run without parsing or retrying`, async () => {
      const { bound, urls } = harness([() => errorResponse(status, code)]);
      const end = await runEventStream({
        transport: bound,
        path: "/api/stream/p1",
        signal: new AbortController().signal,
        decode,
        onEvent: () => undefined,
        sleep: noSleep,
      });
      expect(end.reason).toBe("fatal");
      expect((end as { error: ApiError }).error.code).toBe(code);
      // 401 gets exactly the transport's one forced refresh.
      expect(urls).toHaveLength(status === 401 ? 2 : 1);
    });
  }

  test("429 backs off using Retry-After, 5xx and network errors retry", async () => {
    const { bound } = harness([
      () => errorResponse(429, "rate_limited", { retryAfterSeconds: 3 }),
      () => errorResponse(503, "unavailable"),
      () => {
        throw new TypeError("offline");
      },
      () => sseResponse([frame(1)]),
    ]);
    const controller = new AbortController();
    const delays: number[] = [];
    const statuses: StreamStatus[] = [];
    await runEventStream({
      transport: bound,
      path: "/api/stream/p1",
      signal: controller.signal,
      decode,
      cursorOf: (e) => e.seq,
      onEvent: () => controller.abort(),
      onStatus: (s) => statuses.push(s),
      random: () => 1,
      backoff: { baseMs: 1_000, maxMs: 30_000 },
      sleep: async (ms) => void delays.push(ms),
    });
    expect(delays).toEqual([3_000, 2_000, 4_000]);
    const reconnects = statuses.filter((s) => s.state === "reconnecting");
    expect(reconnects.map((s) => (s as { attempt: number }).attempt)).toEqual([1, 2, 3]);
  });

  test("backoff grows while nothing is delivered and resets after a delivered event", async () => {
    const { bound } = harness([
      () => sseResponse([]),
      () => sseResponse([]),
      () => sseResponse([frame(1)]),
      () => sseResponse([]),
    ]);
    const controller = new AbortController();
    const delays: number[] = [];
    await runEventStream({
      transport: bound,
      path: "/s",
      signal: controller.signal,
      decode,
      cursorOf: (e) => e.seq,
      onEvent: () => undefined,
      random: () => 1,
      backoff: { baseMs: 1_000, maxMs: 30_000 },
      sleep: async (ms) => {
        delays.push(ms);
        if (delays.length === 4) controller.abort();
      },
    });
    expect(delays).toEqual([1_000, 2_000, 1_000, 1_000]);
  });

  test("a silent connection is cut and retried", async () => {
    const { bound, urls } = harness([
      () => sseResponse([": hi\n\n"], { keepOpen: true }),
      () => sseResponse([frame(1)]),
    ]);
    const controller = new AbortController();
    await runEventStream({
      transport: bound,
      path: "/s",
      signal: controller.signal,
      decode,
      onEvent: () => controller.abort(),
      idleTimeoutMs: 30,
      sleep: noSleep,
    });
    expect(urls).toHaveLength(2);
  });

  test("a Workspace switch ends the stream as fatal scope_changed and aborts the connection", async () => {
    const { bound, scope } = harness([
      (signal) => sseResponse([frame(1)], { keepOpen: true, signal }),
    ]);
    const statuses: string[] = [];
    const end = await runEventStream({
      transport: bound,
      path: "/s",
      signal: new AbortController().signal,
      decode,
      cursorOf: (e) => e.seq,
      onEvent: () => {
        scope.selectWorkspace(WORKSPACE_B);
      },
      onStatus: (s) => statuses.push(s.state),
      sleep: noSleep,
    });
    expect(end.reason).toBe("fatal");
    expect((end as { error: ApiError }).error.code).toBe(CLIENT_ERROR_CODES.scopeChanged);
    expect(statuses).not.toContain("reconnecting");
  });

  test("aborting while connecting resolves as aborted", async () => {
    const controller = new AbortController();
    const { bound } = harness([
      (signal) =>
        new Promise<Response>((_, reject) => {
          if (signal?.aborted) reject(signal.reason);
          signal?.addEventListener("abort", () => reject(signal.reason));
        }),
    ]);
    const run = runEventStream({
      transport: bound,
      path: "/s",
      signal: controller.signal,
      decode,
      onEvent: () => undefined,
      sleep: noSleep,
    });
    await Promise.resolve();
    controller.abort(new DOMException("stop", "AbortError"));
    expect(await run).toEqual({ reason: "aborted" });
  });

  test("a consumer bug in onEvent rejects the run instead of looping", async () => {
    const { bound, urls } = harness([() => sseResponse([frame(1)])]);
    await expect(
      runEventStream({
        transport: bound,
        path: "/s",
        signal: new AbortController().signal,
        decode,
        onEvent: () => {
          throw new Error("handler bug");
        },
        sleep: noSleep,
      }),
    ).rejects.toThrow("handler bug");
    expect(urls).toHaveLength(1);
  });

  test("appends to an existing query string", async () => {
    const { bound, urls } = harness([() => sseResponse([])]);
    const controller = new AbortController();
    await runEventStream({
      transport: bound,
      path: "/api/stream/p1?a=1",
      signal: controller.signal,
      query: () => ({ sinceSeq: 4 }),
      decode,
      onEvent: () => undefined,
      sleep: async () => controller.abort(),
    });
    expect(urls[0]).toBe("https://api.example.test/api/stream/p1?a=1&sinceSeq=4");
  });
});

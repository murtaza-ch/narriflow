import { describe, expect, test } from "bun:test";
import { ApiError, CLIENT_ERROR_CODES } from "./error";
import { ApiScope } from "./scope";
import { createApiTransport, type GetToken } from "./transport";
import {
  deferred,
  errorResponse,
  fakeFetch,
  jsonResponse,
  USER,
  WORKSPACE_A,
  WORKSPACE_B,
} from "./test-helpers";

const BASE = "https://api.example.test";

function setup(options: {
  handlers: Parameters<typeof fakeFetch>;
  getToken?: GetToken;
  onAuthenticationFailed?: (error: ApiError) => void;
  onWorkspaceSelectionChanged?: (error: ApiError) => void;
}) {
  const scope = new ApiScope();
  scope.setUser(USER);
  scope.selectWorkspace(WORKSPACE_A);
  const { fetch, calls } = fakeFetch(...options.handlers);
  const tokens: Array<{ skipCache: boolean }> = [];
  const getToken: GetToken =
    options.getToken ??
    (async (opts) => {
      tokens.push({ skipCache: opts?.skipCache === true });
      return opts?.skipCache ? "fresh-token" : "token-1";
    });
  const transport = createApiTransport({
    baseUrl: BASE,
    scope,
    getToken,
    fetch,
    onAuthenticationFailed: options.onAuthenticationFailed,
    onWorkspaceSelectionChanged: options.onWorkspaceSelectionChanged,
  });
  return { scope, transport, calls, tokens };
}

const scopeA = { userId: USER, workspaceId: WORKSPACE_A };

describe("request construction", () => {
  test("sends Bearer + X-Workspace-Id, omits cookies, resolves paths against the API origin", async () => {
    const { transport, calls } = setup({ handlers: [() => jsonResponse({ ok: true })] });
    const data = await transport.scoped(scopeA).json<{ ok: boolean }>("/api/projects", {
      query: { q: "a b", limit: 5, skip: undefined, tags: ["x", "y"] },
    });
    expect(data).toEqual({ ok: true });
    const call = calls[0];
    expect(call?.url).toBe(`${BASE}/api/projects?q=a+b&limit=5&tags=x&tags=y`);
    expect(call?.headers.get("Authorization")).toBe("Bearer token-1");
    expect(call?.headers.get("X-Workspace-Id")).toBe(WORKSPACE_A);
    expect(call?.init.credentials).toBe("omit");
    expect(call?.init.method).toBe("GET");
  });

  test("identity calls carry no Workspace header even if the caller supplies one", async () => {
    const { transport, calls } = setup({ handlers: [() => jsonResponse({})] });
    await transport.identity({ userId: USER }).json("/api/session/bootstrap", {
      headers: { "X-Workspace-Id": WORKSPACE_B },
    });
    expect(calls[0]?.headers.has("X-Workspace-Id")).toBe(false);
  });

  test("caller cannot override Authorization or credentials", async () => {
    const { transport, calls } = setup({ handlers: [() => jsonResponse({})] });
    await transport.scoped(scopeA).fetch("/api/x", {
      headers: { Authorization: "Bearer attacker" },
      credentials: "include",
    });
    expect(calls[0]?.headers.get("Authorization")).toBe("Bearer token-1");
    expect(calls[0]?.init.credentials).toBe("omit");
  });

  test("JSON bodies, method default and idempotency key", async () => {
    const { transport, calls } = setup({ handlers: [() => jsonResponse({ id: 1 }, { status: 201 })] });
    await transport.scoped(scopeA).json("/api/library/folders", {
      json: { name: "n" },
      idempotencyKey: "key-1",
    });
    const call = calls[0];
    expect(call?.init.method).toBe("POST");
    expect(call?.init.body).toBe('{"name":"n"}');
    expect(call?.headers.get("Content-Type")).toBe("application/json");
    expect(call?.headers.get("Idempotency-Key")).toBe("key-1");
  });

  test("rejects bad idempotency keys before any network call", async () => {
    const { transport, calls } = setup({ handlers: [() => jsonResponse({})] });
    await expect(
      transport.scoped(scopeA).json("/api/x", { method: "POST", idempotencyKey: "" }),
    ).rejects.toThrow(TypeError);
    await expect(
      transport.scoped(scopeA).json("/api/x", { method: "POST", idempotencyKey: "k".repeat(129) }),
    ).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });

  test("never sends the token to another origin", async () => {
    const { transport, calls } = setup({ handlers: [() => jsonResponse({})] });
    const bound = transport.scoped(scopeA);
    await expect(bound.fetch("https://evil.example/steal")).rejects.toThrow(/different origin/);
    await expect(bound.fetch("//evil.example/steal")).rejects.toThrow(/different origin/);
    await expect(bound.json("https://evil.example/x")).rejects.toThrow(/different origin/);
    expect(calls).toHaveLength(0);
    await bound.fetch(`${BASE}/api/ok`);
    expect(calls).toHaveLength(1);
  });

  test("parse validates the body; empty bodies resolve to undefined", async () => {
    const { transport } = setup({
      handlers: [() => jsonResponse({ n: 1 }), () => new Response(null, { status: 204 })],
    });
    const bound = transport.scoped(scopeA);
    expect(await bound.json("/a", { parse: (d) => (d as { n: number }).n })).toBe(1);
    expect(await bound.json("/b", { method: "DELETE" })).toBeUndefined();
  });

  test("a non-JSON success body is an unexpected_response, not a crash", async () => {
    const { transport } = setup({ handlers: [() => new Response("<html>", { status: 200 })] });
    const error = await transport.scoped(scopeA).json("/a").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe(CLIENT_ERROR_CODES.unexpectedResponse);
  });

  test("a scoped call without a Workspace is refused locally", () => {
    const { transport } = setup({ handlers: [() => jsonResponse({})] });
    expect(() => transport.scoped({ userId: USER, workspaceId: "" })).toThrow(ApiError);
  });
});

describe("error mapping", () => {
  test("maps the envelope to ApiError.code and keeps safe details", async () => {
    const { transport } = setup({
      handlers: [
        () => errorResponse(402, "plan_required", { details: { feature: "api" }, requestId: "r9" }),
      ],
    });
    const error = (await transport
      .scoped(scopeA)
      .json("/a")
      .catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe("plan_required");
    expect(error.status).toBe(402);
    expect(error.requestId).toBe("r9");
    expect(error.details).toEqual({ feature: "api" });
  });

  test("hc-style fetch also throws ApiError for non-2xx", async () => {
    const { transport } = setup({ handlers: [() => errorResponse(404, "project_not_found")] });
    const error = (await transport
      .scoped(scopeA)
      .fetch("/api/projects/x")
      .catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe("project_not_found");
  });

  test("network failures become network_error with status 0", async () => {
    const { transport } = setup({
      handlers: [
        () => {
          throw new TypeError("fetch failed");
        },
      ],
    });
    const error = (await transport
      .scoped(scopeA)
      .json("/a")
      .catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe(CLIENT_ERROR_CODES.network);
    expect(error.status).toBe(0);
  });

  test("409 workspace_selection_changed notifies once and keeps the code", async () => {
    const seen: string[] = [];
    const { transport } = setup({
      handlers: [() => errorResponse(409, "workspace_selection_changed")],
      onWorkspaceSelectionChanged: (e) => seen.push(e.code),
    });
    const error = (await transport
      .scoped(scopeA)
      .json("/a", { method: "POST", json: {} })
      .catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe("workspace_selection_changed");
    expect(seen).toEqual(["workspace_selection_changed"]);
  });

  test("a caller abort rethrows the abort, not a network error", async () => {
    const gate = deferred<Response>();
    const { transport } = setup({ handlers: [() => gate.promise] });
    const controller = new AbortController();
    const pending = transport.scoped(scopeA).json("/a", { signal: controller.signal });
    controller.abort(new DOMException("aborted", "AbortError"));
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
  });
});

describe("token handling", () => {
  test("a 401 forces exactly one fresh token and replays the same key and body", async () => {
    const { transport, calls, tokens } = setup({
      handlers: [
        () => errorResponse(401, "authentication_required"),
        () => jsonResponse({ created: true }, { status: 201 }),
      ],
    });
    const result = await transport
      .scoped(scopeA)
      .json("/api/library/folders", { json: { name: "n" }, idempotencyKey: "intent-1" });
    expect(result).toEqual({ created: true });
    expect(tokens).toEqual([{ skipCache: false }, { skipCache: true }]);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.headers.get("Authorization")).toBe("Bearer token-1");
    expect(calls[1]?.headers.get("Authorization")).toBe("Bearer fresh-token");
    expect(calls[1]?.headers.get("Idempotency-Key")).toBe("intent-1");
    expect(calls[1]?.init.body).toBe(calls[0]?.init.body);
  });

  test("a second 401 is final: no third attempt, auth failure reported once", async () => {
    const failures: string[] = [];
    const { transport, calls } = setup({
      handlers: [() => errorResponse(401, "authentication_required")],
      onAuthenticationFailed: (e) => failures.push(e.code),
    });
    const error = (await transport
      .scoped(scopeA)
      .json("/a")
      .catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe("authentication_required");
    expect(calls).toHaveLength(2);
    expect(failures).toEqual(["authentication_required"]);
  });

  test("no token means no request and an authentication_required error", async () => {
    const failures: string[] = [];
    const { transport, calls } = setup({
      handlers: [() => jsonResponse({})],
      getToken: async () => null,
      onAuthenticationFailed: (e) => failures.push(e.code),
    });
    const error = (await transport
      .scoped(scopeA)
      .json("/a")
      .catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe("authentication_required");
    expect(error.status).toBe(401);
    expect(calls).toHaveLength(0);
    expect(failures).toHaveLength(1);
  });

  test("a failing token provider is an authentication_unavailable error, not a sign-out", async () => {
    const failures: string[] = [];
    const { transport } = setup({
      handlers: [() => jsonResponse({})],
      getToken: async () => {
        throw new Error("clerk offline");
      },
      onAuthenticationFailed: (e) => failures.push(e.code),
    });
    const error = (await transport
      .scoped(scopeA)
      .json("/a")
      .catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe("authentication_unavailable");
    expect(failures).toHaveLength(0);
  });

  test("a stream body is not replayed after 401", async () => {
    const { transport, calls } = setup({ handlers: [() => errorResponse(401, "authentication_required")] });
    const body = new ReadableStream({ start: (c) => c.close() });
    await expect(
      transport.scoped(scopeA).fetch("/a", { method: "POST", body, duplex: "half" } as RequestInit),
    ).rejects.toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(1);
  });

  test("each request asks for the token at request time", async () => {
    let n = 0;
    const { transport, calls } = setup({
      handlers: [() => jsonResponse({})],
      getToken: async () => `t${++n}`,
    });
    await transport.scoped(scopeA).json("/a");
    await transport.scoped(scopeA).json("/a");
    expect(calls.map((c) => c.headers.get("Authorization"))).toEqual(["Bearer t1", "Bearer t2"]);
  });
});

describe("scope safety", () => {
  test("an A to B to A switch still discards an earlier request if fetch ignores abort", async () => {
    const gate = deferred<Response>();
    const scope = new ApiScope();
    scope.setUser(USER);
    scope.selectWorkspace(WORKSPACE_A);
    const transport = createApiTransport({
      baseUrl: BASE,
      scope,
      getToken: async () => "t",
      fetch: (() => gate.promise) as unknown as typeof fetch,
    });
    const pending = transport.scoped(scopeA).json("/a");
    await Promise.resolve();
    await Promise.resolve();
    scope.selectWorkspace(WORKSPACE_B);
    scope.selectWorkspace(WORKSPACE_A);
    gate.resolve(jsonResponse({ stale: true }));
    const error = (await pending.catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe(CLIENT_ERROR_CODES.scopeChanged);
  });

  test("a bound scope that is no longer current is refused without a network call", async () => {
    const { transport, scope, calls } = setup({ handlers: [() => jsonResponse({})] });
    const bound = transport.scoped(scopeA);
    scope.selectWorkspace(WORKSPACE_B);
    const error = (await bound.json("/a").catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe(CLIENT_ERROR_CODES.scopeChanged);
    expect(calls).toHaveLength(0);
  });

  test("switching Workspace aborts an in-flight request and discards its result", async () => {
    const gate = deferred<Response>();
    const { transport, scope } = setup({ handlers: [() => gate.promise] });
    const pending = transport.scoped(scopeA).json("/a", { method: "POST", json: {} });
    await Promise.resolve();
    await Promise.resolve();
    scope.selectWorkspace(WORKSPACE_B);
    const error = (await pending.catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe(CLIENT_ERROR_CODES.scopeChanged);
    gate.resolve(jsonResponse({ stale: true }));
  });

  test("a response that arrives after the scope moved is rejected even if fetch ignored the abort", async () => {
    const gate = deferred<Response>();
    const scope = new ApiScope();
    scope.setUser(USER);
    scope.selectWorkspace(WORKSPACE_A);
    const transport = createApiTransport({
      baseUrl: BASE,
      scope,
      getToken: async () => "t",
      // Ignores the abort signal entirely, like a hostile or buggy fetch.
      fetch: (() => gate.promise) as unknown as typeof fetch,
    });
    const pending = transport.scoped(scopeA).json("/a");
    await Promise.resolve();
    await Promise.resolve();
    scope.selectWorkspace(WORKSPACE_B);
    gate.resolve(jsonResponse({ stale: true }));
    const error = (await pending.catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe(CLIENT_ERROR_CODES.scopeChanged);
  });

  test("signing out aborts identity requests too", async () => {
    const gate = deferred<Response>();
    const { transport, scope } = setup({ handlers: [() => gate.promise] });
    const pending = transport.identity({ userId: USER }).json("/api/session/bootstrap");
    await Promise.resolve();
    await Promise.resolve();
    scope.setUser(null);
    const error = (await pending.catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe(CLIENT_ERROR_CODES.scopeChanged);
  });

  test("an identity request survives a Workspace switch", async () => {
    const gate = deferred<Response>();
    const { transport, scope } = setup({ handlers: [() => gate.promise] });
    const pending = transport.identity({ userId: USER }).json<{ ok: boolean }>("/api/session/bootstrap");
    await Promise.resolve();
    await Promise.resolve();
    scope.selectWorkspace(WORKSPACE_B);
    gate.resolve(jsonResponse({ ok: true }));
    expect(await pending).toEqual({ ok: true });
  });

  test("a response admitted for another Workspace is discarded", async () => {
    const { transport } = setup({
      handlers: [() => jsonResponse({ leaked: true }, { headers: { "X-Workspace-Id": WORKSPACE_B } })],
    });
    const error = (await transport
      .scoped(scopeA)
      .json("/a")
      .catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe(CLIENT_ERROR_CODES.workspaceResponseMismatch);
  });

  test("a matching or absent X-Workspace-Id is accepted", async () => {
    const { transport } = setup({
      handlers: [
        () => jsonResponse({ n: 1 }, { headers: { "X-Workspace-Id": WORKSPACE_A } }),
        () => jsonResponse({ n: 2 }),
      ],
    });
    expect(await transport.scoped(scopeA).json("/a")).toEqual({ n: 1 });
    expect(await transport.scoped(scopeA).json("/a")).toEqual({ n: 2 });
  });
});

/** A response whose body the test feeds by hand: the first half now, the rest on demand. */
function splitBodyResponse(first: string) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      c.enqueue(encoder.encode(first));
    },
  });
  return {
    response: new Response(body, { headers: { "Content-Type": "application/json" } }),
    finish: (rest: string) => {
      try {
        controller.enqueue(encoder.encode(rest));
        controller.close();
      } catch {
        // The guard already cancelled the source after the scope moved.
      }
    },
  };
}

describe("bound fetch keeps scope tracking through the response body", () => {
  function setupBody(handler: () => Response) {
    const scope = new ApiScope();
    scope.setUser(USER);
    scope.selectWorkspace(WORKSPACE_A);
    const released: string[] = [];
    const track = scope.track.bind(scope);
    scope.track = (target, external) => {
      const tracked = track(target, external);
      const release = tracked.release;
      return Object.assign(Object.create(tracked) as typeof tracked, {
        release: () => {
          released.push("release");
          release();
        },
      });
    };
    const transport = createApiTransport({
      baseUrl: BASE,
      scope,
      getToken: async () => "t",
      // Ignores the abort signal, like a hostile or buggy fetch.
      fetch: (async () => handler()) as unknown as typeof fetch,
    });
    return { scope, bound: transport.scoped(scopeA), released };
  }

  test("a Workspace switch while .json() is reading rejects with scope_changed", async () => {
    const half = splitBodyResponse('{"stale":');
    const { scope, bound } = setupBody(() => half.response);
    const response = await bound.fetch("/api/x");
    const pending = response.json();
    scope.selectWorkspace(WORKSPACE_B);
    half.finish("true}");
    const error = (await pending.catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe(CLIENT_ERROR_CODES.scopeChanged);
  });

  test("a scope that moved before the last chunk arrives still rejects, and A to B to A is not a return", async () => {
    const half = splitBodyResponse('{"stale":');
    const { scope, bound } = setupBody(() => half.response);
    const response = await bound.fetch("/api/x");
    const pending = response.text();
    scope.selectWorkspace(WORKSPACE_B);
    scope.selectWorkspace(WORKSPACE_A);
    half.finish("true}");
    const error = (await pending.catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe(CLIENT_ERROR_CODES.scopeChanged);
  });

  test("reading to the end releases tracking exactly once and the body parses", async () => {
    const { bound, released } = setupBody(() => jsonResponse({ ok: true }));
    const response = await bound.fetch("/api/x");
    expect(released).toEqual([]);
    expect(await response.json()).toEqual({ ok: true });
    expect(released).toEqual(["release"]);
  });

  test("cancelling the body releases tracking", async () => {
    const half = splitBodyResponse("{");
    const { bound, released } = setupBody(() => half.response);
    const response = await bound.fetch("/api/x");
    await response.body?.cancel();
    expect(released).toEqual(["release"]);
  });

  test("a caller abort during the body surfaces as that abort, not scope_changed", async () => {
    const half = splitBodyResponse("{");
    const { bound, released } = setupBody(() => half.response);
    const caller = new AbortController();
    const response = await bound.fetch("/api/x", { signal: caller.signal });
    const pending = response.json();
    caller.abort(new DOMException("stop", "AbortError"));
    const error = (await pending.catch((e: unknown) => e)) as Error;
    expect(error.name).toBe("AbortError");
    expect(released).toEqual(["release"]);
  });

  test("a bodiless response is released immediately", async () => {
    const { bound, released } = setupBody(() => new Response(null, { status: 204 }));
    await bound.fetch("/api/x");
    expect(released).toEqual(["release"]);
  });

  test("real loopback server: switching Workspace between header and end of the JSON body rejects", async () => {
    const encoder = new TextEncoder();
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(encoder.encode('{"stale":'));
              await finished;
              controller.enqueue(encoder.encode("true}"));
              controller.close();
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      },
    });
    try {
      const scope = new ApiScope();
      scope.setUser(USER);
      scope.selectWorkspace(WORKSPACE_A);
      const transport = createApiTransport({
        baseUrl: `http://127.0.0.1:${server.port}`,
        scope,
        getToken: async () => "t",
      });
      const response = await transport.scoped(scopeA).fetch("/api/x");
      const pending = response.json();
      await new Promise((resolve) => setTimeout(resolve, 20));
      scope.selectWorkspace(WORKSPACE_B);
      finish();
      const error = (await pending.catch((e: unknown) => e)) as ApiError;
      expect(error.code).toBe(CLIENT_ERROR_CODES.scopeChanged);
    } finally {
      await server.stop(true);
    }
  });
});

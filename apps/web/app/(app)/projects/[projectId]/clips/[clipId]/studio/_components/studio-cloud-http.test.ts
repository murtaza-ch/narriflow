import { describe, expect, test } from "bun:test";
import { createApiRuntime } from "@narriflow/api-client/core";
import type { StudioApi } from "./studio-api";
import {
  KEEPALIVE_MAX_BODY_BYTES,
  createStudioCloudHttp,
  createTokenSnapshot,
  tokenExpiryMs,
} from "./studio-cloud-http";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const CLIP = "22222222-2222-4222-8222-222222222222";

function jwt(expSec: number): string {
  const encode = (value: unknown) => btoa(JSON.stringify(value)).replace(/=+$/, "");
  return `${encode({ alg: "none" })}.${encode({ exp: expSec })}.sig`;
}

function setup(options: { token?: string | null; fetchImpl?: typeof fetch; hang?: boolean } = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const transportFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (options.hang) {
      // A connection that never answers: only the caller's abort ends it.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    }
    return Response.json({ revision: 4, document: {} });
  }) as typeof fetch;
  const runtime = createApiRuntime({
    baseUrl: "https://api.test",
    getToken: async () => options.token ?? jwt(Math.floor(Date.now() / 1000) + 60),
    fetch: transportFetch,
  });
  runtime.setIdentity("user_1");
  runtime.selectWorkspace("ws_1");
  const api: StudioApi = { runtime, scope: { userId: "user_1", workspaceId: "ws_1" } };
  return { api, runtime, calls };
}

describe("token snapshot", () => {
  test("reads the expiry claim without trusting it", () => {
    expect(tokenExpiryMs(jwt(1_000))).toBe(1_000_000);
    expect(tokenExpiryMs("not-a-token")).toBeNull();
  });

  test("hands out the captured token only while it has time left", async () => {
    let clock = 0;
    const snapshot = createTokenSnapshot({
      getToken: async () => jwt(10),
      now: () => clock,
    });
    expect(snapshot.current()).toBeNull();
    await snapshot.refresh();
    expect(snapshot.current()).not.toBeNull();
    clock = 9_000;
    expect(snapshot.current()).toBeNull();
  });

  test("a failed refresh keeps the previous capture until it expires", async () => {
    let fail = false;
    const snapshot = createTokenSnapshot({
      getToken: async () => {
        if (fail) throw new Error("offline");
        return jwt(100);
      },
      now: () => 0,
    });
    await snapshot.refresh();
    fail = true;
    await snapshot.refresh();
    expect(snapshot.current()).not.toBeNull();
  });
});

describe("save and reset time limit", () => {
  test("a save that never answers is abandoned so the session can retry it", async () => {
    const { api } = setup({ hang: true });
    const http = createStudioCloudHttp({
      api,
      projectId: PROJECT,
      clipId: CLIP,
      tokens: createTokenSnapshot({ getToken: async () => null }),
      requestTimeoutMs: 20,
    });
    // A rejection (no response arrived) is what the session classifies as a transient network failure.
    await expect(http.save({ baseRevision: 3, document: {} })).rejects.toBeDefined();
    await expect(http.reset({ baseRevision: 3 })).rejects.toBeDefined();
  });
});

describe("accepted writes", () => {
  function http(api: StudioApi, onWritten: () => void) {
    return createStudioCloudHttp({
      api,
      projectId: PROJECT,
      clipId: CLIP,
      tokens: createTokenSnapshot({ getToken: async () => null }),
      onWritten,
    });
  }

  test("a stored save or reset tells the page the clip changed", async () => {
    const { api } = setup();
    let written = 0;
    const cloud = http(api, () => {
      written += 1;
    });
    await cloud.load();
    expect(written).toBe(0);
    await cloud.save({ baseRevision: 3, document: {} });
    await cloud.reset({ baseRevision: 4 });
    expect(written).toBe(2);
  });

  test("a refused save changes nothing", async () => {
    let written = 0;
    await http(setupRefusal(), () => {
      written += 1;
    }).save({ baseRevision: 3, document: {} });
    expect(written).toBe(0);
  });
});

function setupRefusal(): StudioApi {
  const runtime = createApiRuntime({
    baseUrl: "https://api.test",
    getToken: async () => jwt(Math.floor(Date.now() / 1000) + 60),
    fetch: (async () =>
      Response.json({ error: "editor_revision_conflict", message: "stale" }, { status: 409 })) as typeof fetch,
  });
  runtime.setIdentity("user_1");
  runtime.selectWorkspace("ws_1");
  return { runtime, scope: { userId: "user_1", workspaceId: "ws_1" } };
}

describe("close-time keepalive", () => {
  const document = { clip: "x" };

  test("sends one credentialless-cookie PUT with the captured token and Workspace", async () => {
    const { api } = setup();
    const sent: Array<{ url: string; init: RequestInit }> = [];
    const token = jwt(Math.floor(Date.now() / 1000) + 60);
    const http = createStudioCloudHttp({
      api,
      projectId: PROJECT,
      clipId: CLIP,
      tokens: { current: () => token, refresh: async () => undefined },
      fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
        sent.push({ url: String(url), init: init ?? {} });
        return new Response(null, { status: 200 });
      }) as typeof fetch,
    });
    expect(http.keepalive({ baseRevision: 3, document })).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(`https://api.test/api/projects/${PROJECT}/clips/${CLIP}/editor`);
    const init = sent[0]?.init as RequestInit & { keepalive?: boolean };
    expect(init.method).toBe("PUT");
    expect(init.keepalive).toBe(true);
    expect(init.credentials).toBe("omit");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${token}`);
    expect(headers["X-Workspace-Id"]).toBe("ws_1");
    expect(JSON.parse(String(init.body))).toEqual({ baseRevision: 3, document });
  });

  test("does not send without a usable token", () => {
    const { api } = setup();
    let sends = 0;
    const http = createStudioCloudHttp({
      api,
      projectId: PROJECT,
      clipId: CLIP,
      tokens: { current: () => null, refresh: async () => undefined },
      fetchImpl: (async () => {
        sends += 1;
        return new Response(null);
      }) as typeof fetch,
    });
    expect(http.keepalive({ baseRevision: 3, document })).toBe(false);
    expect(sends).toBe(0);
  });

  test("does not send a body over the keepalive budget", () => {
    const { api } = setup();
    let sends = 0;
    const http = createStudioCloudHttp({
      api,
      projectId: PROJECT,
      clipId: CLIP,
      tokens: { current: () => "token", refresh: async () => undefined },
      fetchImpl: (async () => {
        sends += 1;
        return new Response(null);
      }) as typeof fetch,
    });
    const big = { text: "x".repeat(KEEPALIVE_MAX_BODY_BYTES) };
    expect(http.keepalive({ baseRevision: 3, document: big })).toBe(false);
    expect(sends).toBe(0);
  });

  test("never replays into another Workspace after the selection moved", () => {
    const { api, runtime } = setup();
    let sends = 0;
    const http = createStudioCloudHttp({
      api,
      projectId: PROJECT,
      clipId: CLIP,
      tokens: { current: () => "token", refresh: async () => undefined },
      fetchImpl: (async () => {
        sends += 1;
        return new Response(null);
      }) as typeof fetch,
    });
    runtime.selectWorkspace("ws_2");
    expect(http.keepalive({ baseRevision: 3, document })).toBe(false);
    expect(sends).toBe(0);
  });
});

describe("editor requests", () => {
  test("a refusal resolves with its status and envelope for the session to classify", async () => {
    const runtime = createApiRuntime({
      baseUrl: "https://api.test",
      getToken: async () => "token",
      fetch: (async () =>
        Response.json(
          { error: "editor_revision_conflict", message: "stale", requestId: "r1", details: { currentRevision: 9 } },
          { status: 409, headers: { "X-Workspace-Id": "ws_1" } },
        )) as typeof fetch,
    });
    runtime.setIdentity("user_1");
    runtime.selectWorkspace("ws_1");
    const http = createStudioCloudHttp({
      api: { runtime, scope: { userId: "user_1", workspaceId: "ws_1" } },
      projectId: PROJECT,
      clipId: CLIP,
      tokens: { current: () => null, refresh: async () => undefined },
    });
    const outcome = await http.save({ baseRevision: 1, document: {} });
    expect(outcome.status).toBe(409);
    expect(outcome.body).toMatchObject({ error: "editor_revision_conflict", details: { currentRevision: 9 } });
  });

  test("a request that never got a response rejects", async () => {
    const runtime = createApiRuntime({
      baseUrl: "https://api.test",
      getToken: async () => "token",
      fetch: (async () => {
        throw new TypeError("offline");
      }) as typeof fetch,
    });
    runtime.setIdentity("user_1");
    runtime.selectWorkspace("ws_1");
    const http = createStudioCloudHttp({
      api: { runtime, scope: { userId: "user_1", workspaceId: "ws_1" } },
      projectId: PROJECT,
      clipId: CLIP,
      tokens: { current: () => null, refresh: async () => undefined },
    });
    await expect(http.load()).rejects.toBeDefined();
  });
});

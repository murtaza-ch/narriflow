import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { ApiEnv } from "./env";
import { apiErrorHandler, apiNotFoundHandler } from "./errors";
import {
  baselineRateRules,
  BODY_LIMIT_BYTES,
  enforceRecordedRateLimit,
  ipRateLimit,
  limitBody,
  limitRequestEnvelope,
  MAX_REQUEST_HEADER_BYTES,
  rateLimitHeaders,
  RATE_TIERS,
  trustedIngressIp,
} from "./limits";
import { apiRequestId } from "./logging";

function app(register: (app: Hono<ApiEnv>) => void) {
  const instance = new Hono<ApiEnv>();
  instance.use("*", apiRequestId());
  instance.onError(apiErrorHandler);
  instance.notFound(apiNotFoundHandler);
  register(instance);
  return instance;
}

describe("body limits", () => {
  test("rejects an oversized declared body before the handler reads it", async () => {
    let read = false;
    const server = app((a) => {
      a.post("/guest", limitBody("guest"), async (c) => {
        read = true;
        return c.json(await c.req.json());
      });
    });
    const response = await server.request("/guest", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(BODY_LIMIT_BYTES.guest + 1) },
      body: JSON.stringify({ pad: "x".repeat(BODY_LIMIT_BYTES.guest) }),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: "payload_too_large" });
    expect(read).toBe(false);
  });

  test("rejects a chunked body that exceeds the limit without trusting Content-Length", async () => {
    const server = app((a) => {
      a.post("/guest", limitBody("guest"), async (c) => c.json({ length: (await c.req.text()).length }));
    });
    const chunk = new TextEncoder().encode("x".repeat(8 * 1024));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 8; index += 1) controller.enqueue(chunk);
        controller.close();
      },
    });
    const response = await server.request("/guest", {
      method: "POST",
      body: stream,
      // @ts-expect-error Bun streams request bodies with half duplex.
      duplex: "half",
    });
    expect(response.status).toBe(413);
  });

  test("accepts a body inside the limit and keeps the editor class larger than ordinary controls", async () => {
    const server = app((a) => {
      a.post("/control", limitBody("control"), async (c) => c.json({ length: (await c.req.text()).length }));
    });
    const response = await server.request("/control", { method: "POST", body: "x".repeat(2048) });
    expect(response.status).toBe(200);
    expect(BODY_LIMIT_BYTES.editor).toBe(8 * 1024 * 1024);
    expect(BODY_LIMIT_BYTES.control).toBe(1024 * 1024);
    expect(BODY_LIMIT_BYTES.guest).toBe(32 * 1024);
  });
});

describe("request envelope bounds", () => {
  const server = app((a) => {
    a.use("*", limitRequestEnvelope());
    a.get("/ok", (c) => c.json({ ok: true }));
  });

  test("refuses a request URL over 8 KiB with a bounded safe failure", async () => {
    const response = await server.request(`/ok?q=${"a".repeat(9 * 1024)}`);
    expect(response.status).toBe(414);
    expect(await response.json()).toMatchObject({ error: "uri_too_long" });
  });

  test("refuses a header block over 32 KiB", async () => {
    const headers: Record<string, string> = {};
    for (let index = 0; index < 10; index += 1) headers[`x-pad-${index}`] = "v".repeat(4 * 1024);
    expect(Object.values(headers).join("").length).toBeGreaterThan(MAX_REQUEST_HEADER_BYTES);
    const response = await server.request("/ok", { headers });
    expect(response.status).toBe(431);
    expect(await response.json()).toMatchObject({ error: "request_headers_too_large" });
  });

  test("passes an ordinary request", async () => {
    expect((await server.request("/ok", { headers: { authorization: "Bearer abc" } })).status).toBe(200);
  });
});

describe("rate tiers", () => {
  test("carry the spec values", () => {
    expect(RATE_TIERS.read).toEqual({ limit: 300, windowSeconds: 60 });
    expect(RATE_TIERS.mutation).toEqual({ limit: 60, windowSeconds: 60 });
    expect(RATE_TIERS.editor).toEqual({ limit: 120, windowSeconds: 60 });
    expect(RATE_TIERS.editorGlobal).toEqual({ limit: 300, windowSeconds: 60 });
    expect(RATE_TIERS.streamStart).toEqual({ limit: 30, windowSeconds: 60 });
    expect(RATE_TIERS.publicRead).toEqual({ limit: 60, windowSeconds: 60 });
    expect(RATE_TIERS.guestExchange).toEqual({ limit: 30, windowSeconds: 60 });
    expect(RATE_TIERS.adminRead).toEqual({ limit: 60, windowSeconds: 60 });
    expect(RATE_TIERS.adminMutation).toEqual({ limit: 10, windowSeconds: 60 });
  });

  test("baseline keys include the Workspace so tenants never share a bucket", () => {
    const [rule] = baselineRateRules("mutation");
    expect(rule?.key({ actorUserId: "u", workspaceId: "a" })).not.toBe(
      rule?.key({ actorUserId: "u", workspaceId: "b" }),
    );
    expect(rule?.key({ actorUserId: "u" })).toBe("api-mutation:u");
  });

  test("the editor tier needs a clip and is separate from the mutation bucket", () => {
    expect(() => baselineRateRules("editor")).toThrow();
    const keys = baselineRateRules("editor", { editorClipId: "clip" }).map((rule) =>
      rule.key({ actorUserId: "u", workspaceId: "w" }),
    );
    expect(keys).toEqual(["api-editor:w:u:clip", "api-editor-global:u"]);
  });

  test("the none tier adds nothing", () => {
    expect(baselineRateRules("none")).toEqual([]);
  });
});

describe("recorded limiter outcomes", () => {
  test("do nothing without a limiter or when allowed", () => {
    expect(() => enforceRecordedRateLimit(null)).not.toThrow();
    expect(() => enforceRecordedRateLimit({ allowed: true, availability: "available" })).not.toThrow();
  });

  test("an exhausted counter answers rate_limited with window guidance", () => {
    expect(() =>
      enforceRecordedRateLimit({ allowed: false, availability: "available", retryAfterSeconds: 41 }),
    ).toThrow(expect.objectContaining({ code: "rate_limited", retryAfterSeconds: 41 }));
  });

  test("an unavailable limiter pauses new work with mutations_unavailable and Retry-After 5", () => {
    expect(() => enforceRecordedRateLimit({ allowed: true, availability: "unavailable" })).toThrow(
      expect.objectContaining({ code: "mutations_unavailable", kind: "unavailable", retryAfterSeconds: 5 }),
    );
  });

  test("RateLimit headers appear only for an available window", () => {
    expect(
      rateLimitHeaders({ allowed: true, availability: "available", limit: 60, remaining: 7, resetSeconds: 12 }),
    ).toEqual({ "RateLimit-Limit": "60", "RateLimit-Remaining": "7", "RateLimit-Reset": "12" });
    expect(rateLimitHeaders({ allowed: true, availability: "unavailable", limit: 60, remaining: 7, resetSeconds: 1 })).toEqual({});
    expect(rateLimitHeaders(null)).toEqual({});
  });
});

describe("trusted ingress IP", () => {
  test("ignores forwarded headers unless the deployment names a trusted one", () => {
    const headers = new Headers({ "x-forwarded-for": "6.6.6.6", "x-real-ip": "7.7.7.7" });
    expect(trustedIngressIp(headers, { trustedHeader: null, socketAddress: "10.0.0.5" })).toBe("10.0.0.5");
    expect(trustedIngressIp(headers, { trustedHeader: "x-real-ip", socketAddress: "10.0.0.5" })).toBe("7.7.7.7");
    expect(trustedIngressIp(new Headers(), { trustedHeader: "x-real-ip" })).toBe("unknown");
  });

  test("limits public reads per IP at 60/min and guest exchange at 30/min", async () => {
    const seen: Array<{ key: string; limit: number }> = [];
    const server = app((a) => {
      const base = {
        clientIp: () => "9.9.9.9",
        rateLimit: async (input: { key: string; limit: number; windowSeconds: number }) => {
          seen.push({ key: input.key, limit: input.limit });
          return { allowed: seen.length < 3 };
        },
      };
      a.get("/share", ipRateLimit({ ...base, prefix: "share", tier: "publicRead" }), (c) => c.json({}));
      a.post("/access", ipRateLimit({ ...base, prefix: "guest", tier: "guestExchange" }), (c) => c.json({}));
    });
    expect((await server.request("/share")).status).toBe(200);
    expect((await server.request("/access", { method: "POST" })).status).toBe(200);
    const limited = await server.request("/share");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(seen).toEqual([
      { key: "share:9.9.9.9", limit: 60 },
      { key: "guest:9.9.9.9", limit: 30 },
      { key: "share:9.9.9.9", limit: 60 },
    ]);
  });
});

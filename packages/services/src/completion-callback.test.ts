import { describe, expect, test } from "bun:test";
import { Webhook } from "standardwebhooks";
import {
  assertCompletionCallbackUrl,
  buildCallbackPayload,
  CALLBACK_RETRY_DELAYS_MS,
  classifyDelivery,
  createCallbackCipher,
  deliverCallback,
  generateCallbackSigningSecret,
  nextAttemptDelayMs,
  nextObservationDelayMs,
  signCallback,
} from "./completion-callback";
import { decodeOperationId, encodeOperationId } from "./operation-status";

const publicResolver = async () => [{ address: "93.184.216.34", family: 4 }];
const OPERATION = { kind: "export" as const, id: "6d27d010-f52c-4e5c-9ea3-012c0bf7d921" };

describe("Completion Callback signing", () => {
  test("signatures verify with the reference Standard Webhooks implementation", () => {
    const secret = generateCallbackSigningSecret();
    const body = JSON.stringify({ id: "evt", type: "operation.completed" });
    const timestamp = Math.floor(Date.now() / 1000);
    const headers = { "webhook-id": "evt", "webhook-timestamp": String(timestamp), "webhook-signature": signCallback({ eventId: "evt", timestamp, body, secrets: [secret] }) };
    expect(new Webhook(secret).verify(body, headers)).toEqual(JSON.parse(body));
    expect(() => new Webhook(generateCallbackSigningSecret()).verify(body, headers)).toThrow();
  });

  test("rotation overlap signs with both secrets so either verifies", () => {
    const [previous, current] = [generateCallbackSigningSecret(), generateCallbackSigningSecret()];
    const body = "{}";
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = signCallback({ eventId: "evt", timestamp, body, secrets: [current, previous] });
    expect(signature.split(" ")).toHaveLength(2);
    for (const secret of [previous, current]) {
      expect(new Webhook(secret).verify(body, { "webhook-id": "evt", "webhook-timestamp": String(timestamp), "webhook-signature": signature })).toEqual({});
    }
  });

  test("secrets are whsec_ with 32 random bytes", () => {
    const secret = generateCallbackSigningSecret();
    expect(secret).toStartWith("whsec_");
    expect(Buffer.from(secret.slice(6), "base64")).toHaveLength(32);
    expect(generateCallbackSigningSecret()).not.toBe(secret);
  });
});

describe("Completion Callback URLs", () => {
  test("accepts only public HTTPS on port 443", async () => {
    await expect(assertCompletionCallbackUrl("https://hooks.example/resume/abc", publicResolver)).resolves.toBeInstanceOf(URL);
    await expect(assertCompletionCallbackUrl("https://hooks.example:443/x", publicResolver)).resolves.toBeInstanceOf(URL);
    for (const url of ["http://hooks.example/x", "https://hooks.example:8443/x", "https://127.0.0.1/x", "https://localhost/x", "https://user:pw@hooks.example/x", "ftp://hooks.example/x", `https://hooks.example/${"a".repeat(2_100)}`]) {
      await expect(assertCompletionCallbackUrl(url, publicResolver)).rejects.toMatchObject({ code: "callback_url_invalid", kind: "invalid" });
    }
    await expect(assertCompletionCallbackUrl("https://rebind.example/x", async () => [{ address: "10.0.0.5", family: 4 }])).rejects.toMatchObject({ code: "callback_url_invalid" });
  });

  test("the cipher round-trips and never stores the URL in clear text", () => {
    const cipher = createCallbackCipher("test-key-material");
    const sealed = cipher.seal("https://hooks.example/secret-path");
    expect(sealed).not.toContain("secret-path");
    expect(cipher.open(sealed)).toBe("https://hooks.example/secret-path");
    expect(() => createCallbackCipher("other-key").open(sealed)).toThrow();
  });
});

describe("Completion Callback events", () => {
  test("operation IDs are opaque and round-trip kind and domain ID", () => {
    const encoded = encodeOperationId(OPERATION);
    expect(encoded).toMatch(/^op_[A-Za-z0-9_-]{23}$/);
    expect(encoded).not.toContain(OPERATION.id);
    expect(decodeOperationId(encoded)).toEqual(OPERATION);
    for (const bad of ["op_", "op_xx", OPERATION.id, `${encoded}a`, `op_${Buffer.alloc(17).toString("base64url")}`]) {
      expect(decodeOperationId(bad)).toBeNull();
    }
  });

  test("payloads carry IDs only and wait while work continues", () => {
    const createdAt = new Date("2026-10-08T00:00:00.000Z");
    const working = { ...OPERATION, state: "working" as const, stage: "rendering", progress: 0.5, items: [], notices: [], failureCode: null, results: { projectId: "p", clipIds: ["c"], exportId: OPERATION.id } };
    expect(buildCallbackPayload({ eventId: "e", workspaceId: "w", createdAt, status: working })).toBeNull();
    const payload = buildCallbackPayload({ eventId: "e", workspaceId: "w", createdAt, status: { ...working, state: "partial", failureCode: "render_failed" } });
    expect(payload).toEqual({ id: "e", type: "operation.completed", version: 1, createdAt: createdAt.toISOString(), workspaceId: "w",
      data: { operationId: encodeOperationId(OPERATION), kind: "export", state: "partial", projectId: "p", clipIds: ["c"], exportId: OPERATION.id, failureCode: "render_failed" } });
    expect(JSON.stringify(payload)).not.toMatch(/https?:/);
  });

  test("a notice about how the work was done travels with the event", () => {
    const notice = { code: "framing_degraded" as const, aspectRatio: "9:16" as const, croppedPercent: 68 };
    const done = { ...OPERATION, state: "completed" as const, stage: "rendering", progress: 1, items: [], notices: [notice], failureCode: null, results: { projectId: "p", clipIds: ["c"], exportId: OPERATION.id } };
    expect(buildCallbackPayload({ eventId: "e", workspaceId: "w", createdAt: new Date(), status: done })?.data.notices).toEqual([notice]);
  });

  test("an unavailable operation produces a terminal unavailable event", () => {
    const payload = buildCallbackPayload({ eventId: "e", workspaceId: "w", createdAt: new Date(), status: { ...OPERATION, state: "unavailable" } });
    expect(payload?.data).toEqual({ operationId: encodeOperationId(OPERATION), kind: "export", state: "unavailable", projectId: null, failureCode: "project_unavailable" });
  });
});

describe("Completion Callback schedules", () => {
  test("retry delays stay within their jitter bounds, then the budget ends", () => {
    for (let attempt = 1; attempt <= CALLBACK_RETRY_DELAYS_MS.length; attempt++) {
      const base = CALLBACK_RETRY_DELAYS_MS[attempt - 1]!;
      expect(nextAttemptDelayMs(attempt, () => 0)).toBe(Math.round(base * 0.8));
      expect(nextAttemptDelayMs(attempt, () => 1)).toBe(Math.round(base * 1.2));
    }
    expect(CALLBACK_RETRY_DELAYS_MS.map((delay) => delay / 1000)).toEqual([30, 120, 600, 1800, 3600, 10800, 21600, 43200, 86400]);
    expect(nextAttemptDelayMs(CALLBACK_RETRY_DELAYS_MS.length + 1)).toBeNull();
  });

  test("observation backs off from 15 seconds to a 5-minute cap", () => {
    expect([0, 1, 2, 3, 4, 5, 10].map(nextObservationDelayMs)).toEqual([15_000, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
  });

  test("2xx delivers, 410 cancels, everything else retries", () => {
    expect([200, 204, 299].map(classifyDelivery)).toEqual(["delivered", "delivered", "delivered"]);
    expect(classifyDelivery(410)).toBe("cancelled");
    expect([null, 301, 400, 404, 429, 500, 503].map(classifyDelivery)).toEqual(Array(7).fill("retry"));
  });
});

describe("Completion Callback delivery", () => {
  const payload = buildCallbackPayload({ eventId: "11111111-1111-4111-8111-111111111111", workspaceId: "w", createdAt: new Date(), status: { ...OPERATION, state: "unavailable" } })!;

  test("posts the exact signed body, never follows redirects, and cancels the response body", async () => {
    const secret = generateCallbackSigningSecret();
    const seen: Array<{ method: string; headers: Headers; body?: string | Uint8Array }> = [];
    let cancelled = false;
    const result = await deliverCallback({
      url: "https://hooks.example/resume", payload, secrets: [secret], now: new Date(), resolver: publicResolver,
      transport: async (_url, request) => {
        seen.push(request);
        return new Response(new ReadableStream({ cancel() { cancelled = true; } }, { highWaterMark: 0 }), { status: 302, headers: { location: "https://elsewhere.example/" } });
      },
    });
    expect(result.status).toBe(302);
    expect(seen).toHaveLength(1);
    expect(cancelled).toBe(true);
    const request = seen[0]!;
    expect(request.method).toBe("POST");
    expect(new Webhook(secret).verify(String(request.body), {
      "webhook-id": request.headers.get("webhook-id")!, "webhook-timestamp": request.headers.get("webhook-timestamp")!, "webhook-signature": request.headers.get("webhook-signature")!,
    })).toEqual(JSON.parse(JSON.stringify(payload)));
  });

  test("timeouts and network errors report no status, so they retry", async () => {
    const result = await deliverCallback({ url: "https://hooks.example/resume", payload, secrets: [generateCallbackSigningSecret()], now: new Date(), resolver: publicResolver,
      transport: async () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); } });
    expect(result.status).toBeNull();
    expect(classifyDelivery(result.status)).toBe("retry");
  });
});

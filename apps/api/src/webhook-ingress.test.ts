import { withServiceEnvironment } from "@narriflow/services/runtime-environment";
import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { BODY_LIMIT_BYTES, ORDINARY_BODY_CAP_BYTES } from "./http/limits";
import { createInventoryApp } from "./test-app";

const MIB = 1024 * 1024;
const SECRET = "wsec_ingress_test";
const URL_PATH = "/api/webhooks/elevenlabs";

// Application composition tests. test:ingress:workerd covers network transport.
const app = createInventoryApp();
function post(path: string, body: Uint8Array | ReadableStream<Uint8Array>, headers: Record<string, string> = {}) {
  return withServiceEnvironment({ ELEVENLABS_WEBHOOK_SECRET: SECRET }, () => app.request(path, {
    method: "POST",
    headers: { ...(body instanceof Uint8Array ? { "content-length": String(body.byteLength) } : {}), ...headers },
    body,
  }));
}

/** A signed, ignorable delivery padded to exactly `bytes`. */
function signedDelivery(bytes: number): { body: Uint8Array; signature: string } {
  const prefix = '{"type":"noop","pad":"';
  const suffix = '"}';
  const body = new Uint8Array(bytes);
  body.fill(0x61);
  body.set(new TextEncoder().encode(prefix), 0);
  body.set(new TextEncoder().encode(suffix), bytes - suffix.length);
  const t = Math.floor(Date.now() / 1000);
  const digest = createHmac("sha256", SECRET).update(`${t}.`).update(body).digest("hex");
  return { body, signature: `t=${t},v0=${digest}` };
}

/** Well-formed and fresh, so the pre-body gate passes; the digest is not checked until the body is read. */
const freshHeader = () => ({ "elevenlabs-signature": `t=${Math.floor(Date.now() / 1000)},v0=${"0".repeat(64)}` });

/** A stream with no declared Content-Length. */
function chunked(body: Uint8Array, chunkBytes = MIB): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= body.byteLength) return controller.close();
      controller.enqueue(body.subarray(offset, offset + chunkBytes));
      offset += chunkBytes;
    },
  });
}

describe("body classes", () => {
  test("the provider result class is 128 MiB; ordinary routes keep their 16 MiB ceiling", () => {
    expect(BODY_LIMIT_BYTES.providerResult).toBe(128 * MIB);
    expect(ORDINARY_BODY_CAP_BYTES).toBe(16 * MIB);
    expect(BODY_LIMIT_BYTES.webhook).toBe(MIB);
  });
});

describe("POST /api/webhooks/elevenlabs ingress", () => {
  test("accepts a signed body over 16 MiB declared by Content-Length", async () => {
    const { body, signature } = signedDelivery(20 * MIB);
    const response = await post(URL_PATH, body, { "elevenlabs-signature": signature, "content-type": "application/json" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, disposition: "ignored" });
  });

  test("accepts a signed body over 16 MiB sent chunked", async () => {
    const { body, signature } = signedDelivery(20 * MIB);
    const response = await post(URL_PATH, chunked(body), { "elevenlabs-signature": signature, "content-type": "application/json" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, disposition: "ignored" });
  });

  test("an unsigned body over 16 MiB is refused for its signature", async () => {
    const response = await post(URL_PATH, new Uint8Array(20 * MIB));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "invalid_signature" });
  });

  test("refuses a missing or stale signature without reading any of the body", async () => {
    for (const headers of [{}, { "elevenlabs-signature": `t=${Math.floor(Date.now() / 1000) - 3600},v0=${"0".repeat(64)}` }]) {
      let pulled = 0;
      const body = new ReadableStream<Uint8Array>({ pull(controller) { pulled += 1; controller.enqueue(new Uint8Array(MIB)); } }, { highWaterMark: 0 });
      const response = await post(URL_PATH, body, headers);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: "invalid_signature" });
      expect(pulled).toBe(0);
    }
  });

  test("refuses a declared provider body above 128 MiB before reading", async () => {
    const response = await post(URL_PATH, new Uint8Array(1), { ...freshHeader(), "content-length": String(128 * MIB + 1) });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: "payload_too_large" });
  });

  test("counts and cancels a provider stream above 128 MiB without trusting Content-Length", async () => {
    // Reuse a chunk to prove counting without allocating a 128 MiB fixture.
    // This is not a public edge transport or isolate memory proof.
    const chunk = new Uint8Array(MIB);
    let remaining = 128 * MIB + 1;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!remaining) return controller.close();
        const bytes = Math.min(remaining, chunk.byteLength);
        controller.enqueue(chunk.subarray(0, bytes));
        remaining -= bytes;
      },
      cancel() { cancelled = true; },
    });
    const response = await post(URL_PATH, body, freshHeader());
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: "payload_too_large" });
    expect(cancelled).toBe(true);
  });
});

describe("other routes keep their limits", () => {
  test("every other webhook refuses more than 1 MiB, declared or chunked", async () => {
    for (const path of ["/api/webhooks/clerk", "/api/webhooks/stripe", "/api/webhooks/zoom"]) {
      const declared = await post(path, new Uint8Array(MIB + 1));
      expect(declared.status).toBe(413);
      expect(await declared.json()).toMatchObject({ error: "payload_too_large" });
      const streamed = await post(path, chunked(new Uint8Array(2 * MIB)));
      expect(streamed.status).toBe(413);
      expect(await streamed.json()).toMatchObject({ error: "payload_too_large" });
    }
  });

  test("a webhook body at 1 MiB reaches signature verification", async () => {
    const response = await post("/api/webhooks/stripe", new Uint8Array(MIB));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "missing_signature" });
  });

  test("over 16 MiB is refused with the common envelope on first-party, REST and MCP routes", async () => {
    const big = new Uint8Array(17 * MIB);
    for (const path of ["/api/recipes", "/api/v1/projects", "/mcp"]) {
      const response = await post(path, big, { "content-type": "application/json" });
      expect(response.status).toBe(413);
      expect(response.headers.get("x-request-id")).toBeTruthy();
      expect(await response.json()).toMatchObject({ error: "payload_too_large" });
    }
  });

  test("first-party routes keep their class limits", async () => {
    for (const body of [new Uint8Array(9 * MIB), chunked(new Uint8Array(9 * MIB))]) {
      const response = await post("/api/recipes", body, { "content-type": "application/json" });
      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({ error: "payload_too_large" });
    }
  });
});

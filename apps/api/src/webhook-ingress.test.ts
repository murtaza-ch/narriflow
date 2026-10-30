import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { BODY_LIMIT_BYTES, NATIVE_BODY_CAP_BYTES, ORDINARY_BODY_CAP_BYTES } from "./http/limits";
import { createInventoryApp } from "./test-app";

const MIB = 1024 * 1024;
const SECRET = "wsec_ingress_test";
const URL_PATH = "/api/webhooks/elevenlabs";

/** The real composition behind Bun's real ingress, with the production native cap. */
let server: ReturnType<typeof Bun.serve>;
let base = "";
const previousSecret = process.env.ELEVENLABS_WEBHOOK_SECRET;

beforeAll(() => {
  process.env.ELEVENLABS_WEBHOOK_SECRET = SECRET;
  const app = createInventoryApp();
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    maxRequestBodySize: NATIVE_BODY_CAP_BYTES,
    fetch: (req, bunServer) => app.fetch(req, { server: bunServer }),
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.stop(true);
  if (previousSecret === undefined) delete process.env.ELEVENLABS_WEBHOOK_SECRET;
  else process.env.ELEVENLABS_WEBHOOK_SECRET = previousSecret;
});

/** A signed, ignorable delivery (`type` unknown to the adapter) padded to `bytes`. */
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

/** A chunked body: a stream has no known length, so no Content-Length is sent. */
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
  test("the provider result class is the native cap; ordinary routes keep their 16 MiB ceiling", () => {
    expect(BODY_LIMIT_BYTES.providerResult).toBe(128 * MIB);
    expect(NATIVE_BODY_CAP_BYTES).toBe(BODY_LIMIT_BYTES.providerResult);
    expect(ORDINARY_BODY_CAP_BYTES).toBe(16 * MIB);
    expect(BODY_LIMIT_BYTES.webhook).toBe(MIB);
  });
});

describe("POST /api/webhooks/elevenlabs ingress", () => {
  test("accepts a signed body over 16 MiB declared by Content-Length", async () => {
    const { body, signature } = signedDelivery(20 * MIB);
    const response = await fetch(`${base}${URL_PATH}`, {
      method: "POST",
      headers: { "elevenlabs-signature": signature, "content-type": "application/json" },
      body,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, disposition: "ignored" });
  });

  test("accepts a signed body over 16 MiB sent chunked", async () => {
    const { body, signature } = signedDelivery(20 * MIB);
    const response = await fetch(`${base}${URL_PATH}`, {
      method: "POST",
      headers: { "elevenlabs-signature": signature, "content-type": "application/json" },
      body: chunked(body),
      // @ts-expect-error Bun/undici need duplex for a streamed request body.
      duplex: "half",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, disposition: "ignored" });
  });

  test("an unsigned body over 16 MiB reaches the handler and is refused for its signature, not its size", async () => {
    const response = await fetch(`${base}${URL_PATH}`, { method: "POST", body: new Uint8Array(20 * MIB) });
    expect(response.status).toBe(401);
  });

  test("refuses a body over 128 MiB, declared or chunked", async () => {
    const over = new Uint8Array(128 * MIB + 1);
    // Declared: Bun answers before the application runs (413, or a bare 400 on a reused connection).
    const declared = await fetch(`${base}${URL_PATH}`, { method: "POST", body: over });
    expect([400, 413]).toContain(declared.status);
    // Chunked: the application counts the bytes and answers its common envelope
    // (Bun 1.4 errors the read at the cap first, with its bare 413).
    const streamed = await fetch(`${base}${URL_PATH}`, {
      method: "POST",
      body: chunked(over, 4 * MIB),
      // @ts-expect-error Bun/undici need duplex for a streamed request body.
      duplex: "half",
    });
    expect(streamed.status).toBe(413);
    const text = await streamed.text();
    if (text) expect(JSON.parse(text)).toMatchObject({ error: "payload_too_large" });
  });
});

describe("other routes keep their limits", () => {
  const post = (path: string, body: Uint8Array | ReadableStream<Uint8Array>, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers,
      body,
      ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
    } as RequestInit);

  test("every other webhook still refuses more than 1 MiB, declared or chunked", async () => {
    for (const path of ["/api/webhooks/clerk", "/api/webhooks/stripe", "/api/webhooks/zoom"]) {
      const declared = await post(path, new Uint8Array(MIB + 1));
      expect(declared.status).toBe(413);
      expect(await declared.json()).toMatchObject({ error: "payload_too_large" });
      const streamed = await post(path, chunked(new Uint8Array(2 * MIB)));
      expect(streamed.status).toBe(413);
    }
  });

  test("a webhook body at 1 MiB is still read", async () => {
    const response = await post("/api/webhooks/stripe", new Uint8Array(MIB));
    expect(response.status).not.toBe(413);
  });

  test("a body over 16 MiB is refused with the common envelope on first-party, REST and MCP routes", async () => {
    const big = new Uint8Array(17 * MIB);
    for (const path of ["/api/recipes", "/api/v1/projects", "/mcp"]) {
      const response = await post(path, big, { "content-type": "application/json" });
      expect(response.status).toBe(413);
      expect(response.headers.get("x-request-id")).toBeTruthy();
      expect(await response.json()).toMatchObject({ error: "payload_too_large" });
    }
  });

  test("first-party routes keep their class limits", async () => {
    const response = await post("/api/recipes", new Uint8Array(9 * MIB), { "content-type": "application/json" });
    expect(response.status).toBe(413);
    const streamed = await post("/api/recipes", chunked(new Uint8Array(9 * MIB)), { "content-type": "application/json" });
    expect(streamed.status).toBe(413);
  });
});

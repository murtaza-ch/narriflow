import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { unstable_dev } from "wrangler";

const MIB = 1024 * 1024;
const WEB = "http://localhost:3000";
const secret = "local-workerd-ingress-fixture";
const worker = await unstable_dev(fileURLToPath(new URL("./gates/ingress-runtime-probe.ts", import.meta.url)), {
  config: fileURLToPath(new URL("./gates/wrangler.ingress-probe.jsonc", import.meta.url)),
  local: true,
  ip: "127.0.0.1",
  port: 0,
  inspectorPort: 0,
  persist: false,
  logLevel: "error",
  vars: {
    HYPERDRIVE: { connectionString: "postgresql://unused.invalid/no_database_calls" },
    ELEVENLABS_WEBHOOK_SECRET: secret,
  },
  experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false },
});
const checks: string[] = [];
function chunked(body: Uint8Array) {
  let offset = 0;
  return new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset === body.byteLength) return controller.close();
    const next = Math.min(offset + MIB, body.byteLength);
    controller.enqueue(body.subarray(offset, next));
    offset = next;
  } });
}
function post(path: string, body: Uint8Array | ReadableStream<Uint8Array>, headers: Record<string, string> = {}) {
  return worker.fetch(path, {
    method: "POST",
    headers: { ...(body instanceof Uint8Array ? { "content-length": String(body.byteLength) } : {}), ...headers },
    body,
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  });
}
function signature(body: Uint8Array) {
  const time = Math.floor(Date.now() / 1000);
  return `t=${time},v0=${createHmac("sha256", secret).update(`${time}.`).update(body).digest("hex")}`;
}
async function tooLarge(response: Response, cors = false) {
  assert.equal(response.status, 413, await response.clone().text());
  assert.ok(response.headers.get("x-request-id"));
  assert.equal(response.headers.get("access-control-allow-origin"), cors ? WEB : null);
  assert.equal((await response.json() as { error: string }).error, "payload_too_large");
}
try {
  const body = new Uint8Array(20 * MIB).fill(0x61);
  const prefix = new TextEncoder().encode('{ "type" : "noop", "pad" : "');
  const suffix = new TextEncoder().encode('" }\n');
  body.set(prefix);
  body.set(suffix, body.byteLength - suffix.byteLength);
  const signedHeaders = { "content-type": "application/json", "elevenlabs-signature": signature(body) };
  for (const [transport, bytes] of [["declared", body], ["streamed", chunked(body)]] as const) {
    const response = await post("/api/webhooks/elevenlabs", bytes, signedHeaders);
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { received: true, disposition: "ignored" });
    checks.push(`signed_20_mib_${transport}_full_app`);
  }
  body[prefix.byteLength] = 0x62;
  const tampered = await post("/api/webhooks/elevenlabs", body, signedHeaders);
  assert.equal(tampered.status, 401);
  assert.deepEqual(await tampered.json(), { error: "invalid_signature" });
  checks.push("large_signed_bytes_tamper_rejected");
  const unsigned = await post("/api/webhooks/elevenlabs", body);
  assert.equal(unsigned.status, 401);
  assert.deepEqual(await unsigned.json(), { error: "invalid_signature" });
  checks.push("large_unsigned_reaches_signature_verification");

  const raw = new TextEncoder().encode('{ "type" : "noop", "value" : "\\u0061" }\n');
  const headers = { "elevenlabs-signature": signature(raw), "content-type": "application/json" };
  assert.equal((await post("/api/webhooks/elevenlabs", raw, headers)).status, 200);
  const reserialized = await post("/api/webhooks/elevenlabs", new TextEncoder().encode(JSON.stringify(JSON.parse(new TextDecoder().decode(raw)))), headers);
  assert.equal(reserialized.status, 401);
  checks.push("raw_whitespace_and_escape_signature_preserved");

  for (const path of ["/api/webhooks/clerk", "/api/webhooks/stripe", "/api/webhooks/zoom"]) {
    await tooLarge(await post(path, new Uint8Array(MIB + 1)));
    await tooLarge(await post(path, chunked(new Uint8Array(2 * MIB))));
    checks.push(`${path.split("/").at(-1)}_one_mib_declared_and_streamed`);
  }
  const boundary = await post("/api/webhooks/stripe", new Uint8Array(MIB));
  assert.equal(boundary.status, 400);
  assert.deepEqual(await boundary.json(), { error: "missing_signature" });
  checks.push("webhook_exact_one_mib_reaches_signature_handler");
  for (const path of ["/api/recipes", "/api/v1/projects", "/mcp"]) {
    await tooLarge(await post(path, new Uint8Array(17 * MIB), { origin: WEB, "content-type": "application/json" }), path === "/api/recipes");
    checks.push(`${path}_ordinary_declared_ceiling`);
  }
  await tooLarge(await post("/api/recipes", new Uint8Array(9 * MIB), { origin: WEB, "content-type": "application/json" }), true);
  await tooLarge(await post("/api/recipes", chunked(new Uint8Array(2 * MIB)), { origin: WEB, "content-type": "application/json" }), true);
  checks.push("first_party_class_nine_mib_declared_and_two_mib_streamed_cors");
  const firstPartyCounter = await (await worker.fetch("/__gates/first-party-stream-over")).json() as {
    status: number; requestId: string | null; body: { error: string }; cors: string | null; cancelled: boolean; enqueued: number;
  };
  assert.equal(firstPartyCounter.status, 413);
  assert.ok(firstPartyCounter.requestId);
  assert.equal(firstPartyCounter.body.error, "payload_too_large");
  assert.equal(firstPartyCounter.cors, WEB);
  assert.equal(firstPartyCounter.cancelled, true);
  assert.ok(firstPartyCounter.enqueued < 9 * MIB);
  checks.push("first_party_nine_mib_synthetic_stream_stops_early_with_cors");
  await tooLarge(await post("/api/recipes", new Uint8Array(17 * MIB), { origin: "https://foreign.test" }));
  await tooLarge(await post("/api/webhooks/clerk", new Uint8Array(17 * MIB), { origin: WEB }));
  checks.push("ingress_cors_excludes_foreign_origin_and_webhook");
  for (const mode of ["declared", "stream"]) {
    const probe = await (await worker.fetch(`/__gates/provider-${mode}-over`)).json() as {
      status: number; requestId: string | null; body: { error: string }; cancelled: boolean; enqueued: number;
    };
    assert.equal(probe.status, 413);
    assert.ok(probe.requestId);
    assert.equal(probe.body.error, "payload_too_large");
    if (mode === "stream") {
      assert.equal(probe.cancelled, true);
      assert.equal(probe.enqueued, 128 * MIB + 1);
    }
    checks.push(`provider_128_mib_${mode}_synthetic_application_counter`);
  }
  process.stdout.write(`${JSON.stringify({ runtime: "workerd", checks, passed: checks.length, scope: "Local network transport through full application; 128 MiB synthetic counters are not public edge or heap proofs; database factory poisoned" })}\n`);
} finally {
  await worker.stop();
}

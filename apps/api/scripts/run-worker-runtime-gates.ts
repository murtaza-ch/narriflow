import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { fileURLToPath } from "node:url";
import { unstable_dev } from "wrangler";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const webhookSecret = "local-workerd-webhook-fixture";
const now = Math.floor(Date.now() / 1000);
function token(azp = "https://web.narriflow.test") {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "local-gate" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: "user_cutover_gate", sid: "sess_cutover_gate", iss: "https://fixture.clerk.accounts.dev", azp, iat: now, nbf: now - 5, exp: now + 300 })).toString("base64url");
  const input = `${header}.${payload}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
}
const worker = await unstable_dev(fileURLToPath(new URL("./gates/runtime-probe.ts", import.meta.url)), {
  config: fileURLToPath(new URL("./gates/wrangler.runtime-probe.jsonc", import.meta.url)),
  local: true,
  ip: "127.0.0.1",
  port: 0,
  inspectorPort: 0,
  persist: false,
  logLevel: "error",
  vars: {
    HYPERDRIVE: { connectionString: "postgresql://unused.test/no_database_calls" },
    CLERK_JWT_KEY: publicPem,
    ELEVENLABS_WEBHOOK_SECRET: webhookSecret,
    PEXELS_API_KEY: "local-stock-fixture",
    FIXTURE_ID: "isolated-local-runtime",
  },
  experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false },
});
const checks: string[] = [];
try {
  const health = await worker.fetch("/api/health");
  assert.equal(health.status, 200, await health.text());
  checks.push("static_liveness");
  const cookie = await worker.fetch("/auth", { headers: { cookie: `__session=${token()}` } });
  assert.equal(cookie.status, 401);
  checks.push("cookie_is_not_a_bearer");
  const accepted = await worker.fetch("/auth", { headers: { authorization: `Bearer ${token()}` } });
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { userId: "user_cutover_gate" });
  checks.push("clerk_rs256_bearer");
  assert.equal((await worker.fetch("/auth", { headers: { authorization: `Bearer ${token("https://wrong.test")}` } })).status, 401);
  checks.push("clerk_authorized_party");
  assert.deepEqual(await (await worker.fetch("/scope")).json(), { fixture: "isolated-local-runtime" });
  checks.push("invocation_settings");
  const body = '{ "type" : "speech_to_text_transcription", "data": { "request_id": "gate", "webhook_metadata": { "workflowRunId": "10000000-0000-4000-8000-000000000001", "attemptId": "20000000-0000-4000-8000-000000000001", "deploymentEpoch": 1, "sourceRevision": 1, "sourceAudioId": null }, "transcription": { "transcription_id": "gate", "text": "\\u0061" } } }\n';
  const digest = createHmac("sha256", webhookSecret).update(`${now}.`).update(body).digest("hex");
  const headers = { "content-type": "application/json", "elevenlabs-signature": `t=${now},v0=${digest}` };
  const exact = await worker.fetch("/api/webhooks/elevenlabs", { method: "POST", headers, body });
  assert.equal(exact.status, 200);
  assert.deepEqual(await exact.json(), { received: true, disposition: "applied" });
  checks.push("scribe_exact_signed_bytes");
  assert.equal((await worker.fetch("/api/webhooks/elevenlabs", { method: "POST", headers, body: JSON.stringify(JSON.parse(body)) })).status, 401);
  checks.push("scribe_rejects_reserialized_bytes");
  const counts = await Promise.all(Array.from({ length: 8 }, async () => await (await worker.fetch("/rate/concurrent?limit=2")).json() as { allowed: boolean }));
  assert.equal(counts.filter((result) => result.allowed).length, 2);
  checks.push("durable_rate_concurrency");
  const peek = await (await worker.fetch("/rate/concurrent?limit=2&peek=1")).json() as { allowed: boolean; remaining: number };
  assert.equal(peek.allowed, false);
  assert.equal(peek.remaining, 0);
  checks.push("durable_rate_peek");
  const firstWindow = await (await worker.fetch("/rate/expiry?limit=1&window=1")).json() as { allowed: boolean };
  assert.equal(firstWindow.allowed, true);
  assert.equal((await (await worker.fetch("/rate/expiry?limit=1&window=1&peek=1")).json() as { allowed: boolean }).allowed, false);
  await new Promise((resolve) => setTimeout(resolve, 1_250));
  assert.equal((await (await worker.fetch("/rate/expiry?limit=1&window=1&peek=1")).json() as { allowed: boolean }).allowed, true);
  checks.push("durable_rate_window_expiry");
  const stockPath = `/stock-cache?q=runtime-gate-${Date.now()}`;
  assert.deepEqual(await (await worker.fetch(stockPath)).json(), { videos: 1, providerCalls: 1 });
  assert.deepEqual(await (await worker.fetch(stockPath)).json(), { videos: 1, providerCalls: 1 });
  checks.push("pexels_cache_api");
  process.stdout.write(`${JSON.stringify({ runtime: "workerd", checks, passed: checks.length })}\n`);
} finally {
  await worker.stop();
}

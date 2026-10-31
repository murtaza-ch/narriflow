import { describe, expect, test } from "bun:test";
import { signExecutionRequest } from "@narriflow/services/execution-signature";
import { createExecutionRoutes } from "./routes";

const now = 1_793_406_000;
const key = new Uint8Array(32).fill(7);
const command = { action: "process-start", fence: {
  reference: { dispatchId: crypto.randomUUID(), deploymentEpoch: 1, kind: "modal_execution", subject: { kind: "ingest_job", id: crypto.randomUUID() }, generation: 1, inputHash: "a".repeat(64) },
  attemptToken: crypto.randomUUID(), owner: crypto.randomUUID(),
} };

async function request(body = JSON.stringify(command), signingKey = key) {
  const bytes = new TextEncoder().encode(body);
  const metadata = await signExecutionRequest({ keyId: "v1", key: signingKey, audience: "executor-control", method: "POST",
    target: "/execution/command", body: bytes, timestamp: now, deliveryId: crypto.randomUUID() });
  return new Request("https://api.example.test/execution/command", { method: "POST", body: bytes,
    headers: { "Content-Type": "application/json", "X-Execution-Signature": JSON.stringify(metadata) } });
}

describe("independently signed executor HTTP commands", () => {
  test("a wrong signing key fails before constructing domain or database work", async () => {
    let executions = 0;
    const app = createExecutionRoutes({ keyRing: () => new Map([["v1", key]]), nowSeconds: () => now,
      execute: async () => { executions++; return { disposition: "started" }; } });
    const response = await app.fetch(await request(undefined, new Uint8Array(32).fill(8)));
    expect(response.status).toBe(401);
    expect(executions).toBe(0);
  });

  test("passes only a verified strict command to domain work", async () => {
    let executions = 0;
    const app = createExecutionRoutes({ keyRing: () => new Map([["v1", key]]), nowSeconds: () => now,
      execute: async (parsed, verified) => {
        executions++; expect(parsed).toEqual(command); expect(verified.metadata.canonicalTarget).toBe("/execution/command");
        return { disposition: "started" };
      } });
    const response = await app.fetch(await request());
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Execution-Server-Time")).toBe(new Date(now * 1_000).toISOString());
    expect(await response.json()).toEqual({ disposition: "started" });
    expect(executions).toBe(1);
  });

  test("rejects reserialized raw bytes, expired signatures and bodies above 64 KiB", async () => {
    let executions = 0;
    const execute = async () => { executions++; return { disposition: "started" as const }; };
    const app = createExecutionRoutes({ keyRing: () => new Map([["v1", key]]), nowSeconds: () => now, execute });
    const signed = await request();
    const modified = new Request(signed.url, { method: "POST", headers: signed.headers, body: `${JSON.stringify(command)}\n` });
    expect((await app.fetch(modified)).status).toBe(401);
    const oversized = new Request(signed.url, { method: "POST", headers: signed.headers, body: " ".repeat(65537) });
    expect((await app.fetch(oversized)).status).toBe(413);
    const expired = createExecutionRoutes({ keyRing: () => new Map([["v1", key]]), nowSeconds: () => now + 301, execute });
    expect((await expired.fetch(await request())).status).toBe(401);
    expect(executions).toBe(0);
  });
});

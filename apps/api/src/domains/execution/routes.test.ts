import { describe, expect, test } from "bun:test";
import { signExecutionRequest } from "@narriflow/services/execution-signature";
import { createExecutionRoutes } from "./routes";

const now = 1_793_406_000;
const key = new Uint8Array(32).fill(7);
const transferUnavailable = async (): Promise<never> => { throw new Error("Transfer was not expected"); };
const command = { action: "process-start", fence: {
  reference: { dispatchId: crypto.randomUUID(), deploymentEpoch: 1, kind: "modal_execution", subject: { kind: "ingest_job", id: crypto.randomUUID() }, generation: 1, inputHash: "a".repeat(64) },
  attemptToken: crypto.randomUUID(), owner: crypto.randomUUID(),
} };

async function request(body = JSON.stringify(command), signingKey = key, target = "/execution/command") {
  const bytes = new TextEncoder().encode(body);
  const metadata = await signExecutionRequest({ keyId: "v1", key: signingKey, audience: "executor-control", method: "POST",
    target, body: bytes, timestamp: now, deliveryId: crypto.randomUUID() });
  return new Request(`https://api.example.test${target}`, { method: "POST", body: bytes,
    headers: { "Content-Type": "application/json", "X-Execution-Signature": JSON.stringify(metadata) } });
}

describe("independently signed executor HTTP commands", () => {
  test("a wrong signing key fails before constructing domain or database work", async () => {
    let executions = 0;
    const app = createExecutionRoutes({ transfer: transferUnavailable, keyRing: () => new Map([["v1", key]]), nowSeconds: () => now,
      execute: async () => { executions++; return { disposition: "started" }; } });
    const response = await app.fetch(await request(undefined, new Uint8Array(32).fill(8)));
    expect(response.status).toBe(401);
    expect(executions).toBe(0);
  });

  test("passes only a verified strict command to domain work", async () => {
    let executions = 0;
    const app = createExecutionRoutes({ transfer: transferUnavailable, keyRing: () => new Map([["v1", key]]), nowSeconds: () => now,
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
    const app = createExecutionRoutes({ transfer: transferUnavailable, keyRing: () => new Map([["v1", key]]), nowSeconds: () => now, execute });
    const signed = await request();
    const modified = new Request(signed.url, { method: "POST", headers: signed.headers, body: `${JSON.stringify(command)}\n` });
    expect((await app.fetch(modified)).status).toBe(401);
    const oversized = new Request(signed.url, { method: "POST", headers: signed.headers, body: " ".repeat(65537) });
    expect((await app.fetch(oversized)).status).toBe(413);
    const expired = createExecutionRoutes({ transfer: transferUnavailable, keyRing: () => new Map([["v1", key]]), nowSeconds: () => now + 301, execute });
    expect((await expired.fetch(await request())).status).toBe(401);
    expect(executions).toBe(0);
  });

  test("storage commands verify their own raw target before resolving scoped transfers", async () => {
    const transferCommand = { action: "upload-abort", fence: command.fence, artifactId: crypto.randomUUID() };
    let transfers = 0;
    const app = createExecutionRoutes({ keyRing: () => new Map([["v1", key]]), nowSeconds: () => now,
      execute: async () => { throw new Error("Control domain was not expected"); },
      transfer: async (parsed, verified) => {
        transfers++; expect(parsed).toEqual(transferCommand); expect(verified.metadata.canonicalTarget).toBe("/execution/transfer");
        return { disposition: "upload_aborted", artifactId: transferCommand.artifactId };
      } });
    const wrongTarget = await request(JSON.stringify(transferCommand));
    expect((await app.fetch(new Request("https://api.example.test/execution/transfer", { method: "POST", headers: wrongTarget.headers, body: JSON.stringify(transferCommand) }))).status).toBe(401);
    expect(transfers).toBe(0);
    const valid = await app.fetch(await request(JSON.stringify(transferCommand), key, "/execution/transfer"));
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual({ disposition: "upload_aborted", artifactId: transferCommand.artifactId });
    expect(transfers).toBe(1);
  });
});

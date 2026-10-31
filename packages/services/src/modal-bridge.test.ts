import { describe, expect, test } from "bun:test";
import { createModalBridgeClient } from "./modal-bridge";
import { verifyExecutionRequest } from "./execution-signature";

const key = Uint8Array.from({ length: 32 }, (_, index) => index);
const deliveryId = "9d97e3a6-9169-40ab-a359-4bb995a72a64";
const command = { action: "spawn" as const, function: "fetch_source" as const, attemptToken: "6fe6b8d5-42a9-4270-bf7d-d7f47dcd7fc4",
  reference: { dispatchId: deliveryId, deploymentEpoch: 1, generation: 1, kind: "modal_execution" as const,
    subject: { kind: "ingest_job" as const, id: "dfdc23c0-d8bf-4384-a635-6785275dc839" }, inputHash: "a".repeat(64) } };

describe("Modal reference bridge transport", () => {
  test.each(["https://murtazach275--narriflow-media-bridge.modal.run", "https://murtazach275--narriflow-media-bridge.us-east.modal.run"])("signs reference bytes and refreshes authentication without changing delivery content at %s", async origin => {
    let now = new Date("2026-10-31T00:00:00Z");
    const bodies: string[] = [], hashes: string[] = [], signatures: string[] = [];
    const client = createModalBridgeClient({ origin, keyId: "public", key }, {
      now: () => now,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        expect(url.pathname).toBe("/bridge/command");
        const headers = new Headers(init?.headers), body = new Uint8Array(init?.body as Uint8Array);
        const metadata = JSON.parse(headers.get("X-Execution-Signature")!);
        const verified = await verifyExecutionRequest({ signature: metadata, keyRing: new Map([["public", key]]), audience: "modal-bridge",
          method: "POST", target: url.pathname, body, nowSeconds: now.getTime() / 1000 });
        bodies.push(new TextDecoder().decode(body)); hashes.push(verified.requestHash); signatures.push(metadata.signature);
        return Response.json({ disposition: "spawned", callId: "fc-public-test" });
      },
    });
    expect(await client.command(command, deliveryId)).toEqual({ disposition: "spawned", callId: "fc-public-test" });
    now = new Date(now.getTime() + 600_000);
    await client.command(command, deliveryId);
    expect(bodies[1]).toBe(bodies[0]); expect(hashes[1]).toBe(hashes[0]); expect(signatures[1]).not.toBe(signatures[0]);
    expect(Object.keys(JSON.parse(bodies[0]!)).sort()).toEqual(["action", "attemptToken", "function", "reference"]);
  });
  test("unknown responses and network failure never acknowledge dispatch", async () => {
    for (const response of [Response.json({ disposition: "completed" }), new Response("x".repeat(4097), { headers: { "Content-Type": "application/json" } })]) {
      const client = createModalBridgeClient({ origin: "https://test.modal.run", keyId: "public", key }, { fetch: async () => response });
      await expect(client.command(command, deliveryId)).rejects.toMatchObject({ code: "modal_bridge_unconfirmed" });
    }
    const client = createModalBridgeClient({ origin: "https://test.modal.run", keyId: "public", key }, { fetch: async () => { throw new Error("connection lost"); } });
    await expect(client.command(command, deliveryId)).rejects.toMatchObject({ code: "modal_bridge_unconfirmed" });
  });
  test("redirects use the Workers-supported manual mode and never acknowledge or follow a signed request", async () => {
    const modes:unknown[]=[];
    const client=createModalBridgeClient({origin:"https://test.modal.run",keyId:"public",key},{fetch:async(_input,init)=>{
      modes.push(init?.redirect);
      return new Response(JSON.stringify({disposition:"spawned",callId:"fc-must-not-acknowledge"}),{status:302,headers:{Location:"https://untrusted.example/","Content-Type":"application/json"}});
    }});
    await expect(client.command(command,deliveryId)).rejects.toMatchObject({code:"modal_bridge_unconfirmed"});
    expect(modes).toEqual(["manual"]);
  });
  test("only the configured known Modal origin is allowed", () => {
    for (const origin of ["http://test.modal.run", "https://test.modal.run.evil.example", "https://test.modal.run/path", "https://secret@test.modal.run", "not a URL"]) {
      expect(() => createModalBridgeClient({ origin, keyId: "public", key })).toThrow("modal_bridge_configuration_invalid");
    }
  });
});

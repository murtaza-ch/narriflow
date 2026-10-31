import { expect, test } from "bun:test";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { NarriflowMcpServer } from "@narriflow/mcp-core/server";
import { createDatabaseScope, getPrismaClient } from "@narriflow/db/client";
import { readServiceEnvironment } from "@narriflow/services/runtime-environment";
import { z } from "zod";
import { createApiWorker } from "./worker";
import type { ApiWorkerBindings } from "./worker-bindings";

const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "scope-gate", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} };
const bindings = { HYPERDRIVE: { connectionString: "fixture" }, FIXTURE_ID: "request-settings" } as unknown as ApiWorkerBindings;
const context = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

/** Exercise the SDK's actual SSE response and public registered callback seam. */
test("an MCP tool finishes in its own DB scope after the HTTP stream opens", async () => {
  let resume!: () => void;
  const mayQuery = new Promise<void>((resolve) => { resume = resolve; });
  let created = 0;
  let closed = 0;
  const worker = createApiWorker({
    createScope: () => createDatabaseScope({ createClient: () => {
      created += 1;
      return { client: { $queryRaw: async () => [{ answer: 42 }] } as unknown as NonNullable<ReturnType<typeof getPrismaClient>>, dispose: async () => { closed += 1; } };
    } }),
    createApp: (_environment, runInRequestScope) => {
      const handler = createMcpHandler(() => {
        const server = new NarriflowMcpServer({ name: "scope-gate", version: "1" }, undefined, runInRequestScope);
        server.registerTool("query", { inputSchema: z.strictObject({}) }, async () => {
          await mayQuery;
          const rows = await getPrismaClient()!.$queryRaw<Array<{ answer: number }>>`SELECT 42 AS answer`;
          return { content: [{ type: "text", text: `${rows[0]?.answer}:${readServiceEnvironment().FIXTURE_ID}` }] };
        });
        return server;
      }, { responseMode: "sse" });
      return { fetch: (request) => handler.fetch(request) };
    },
  });
  const response = await worker.fetch(new Request("https://api.test/mcp", {
    method: "POST", headers: { "Content-Type": "application/json", "MCP-Protocol-Version": "2026-07-28", "MCP-Method": "tools/call", "MCP-Name": "query" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "query", arguments: {}, _meta: meta } }),
  }), bindings, context);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect(created).toBe(0);
  resume();
  expect(await response.text()).toContain("42:request-settings");
  expect(created).toBe(1);
  expect(closed).toBe(1);
  expect(getPrismaClient()).toBeNull();
});

import { createMcpHandler } from "@modelcontextprotocol/server";
import { NarriflowMcpServer } from "@narriflow/mcp-core/server";
import { createDatabaseScope, getPrismaClient } from "@narriflow/db/client";
import { readServiceEnvironment } from "@narriflow/services/runtime-environment";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { createApiWorker } from "../../src/worker";
import type { ApiWorkerBindings } from "../../src/worker-bindings";

let created = 0;
let disposed = 0;
let queries = 0;

/** Fixed read-only SQL, protected when deployed. This never accepts SQL input. */
const worker = createApiWorker({
  createScope: (connectionString) => createDatabaseScope({ createClient: () => {
    created += 1;
    const client = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 1, connectionTimeoutMillis: 10_000, query_timeout: 10_000 }) });
    return { client, dispose: async () => { await client.$disconnect(); disposed += 1; } };
  } }),
  createApp: (_environment, runInRequestScope) => {
    const handler = createMcpHandler(() => {
      const server = new NarriflowMcpServer({ name: "scope-gate", version: "1" }, { capabilities: { logging: {} } }, runInRequestScope);
      const query = async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        const rows = await getPrismaClient()!.$queryRaw<Array<{ answer: number }>>`SELECT 42::integer AS answer`;
        queries += 1;
        return `${rows[0]?.answer}:${readServiceEnvironment().FIXTURE_ID}`;
      };
      server.registerTool("query", { inputSchema: z.strictObject({}) }, async (_input, context) => {
        // A real related notification makes the default modern adapter stream
        // before the delayed database operation completes.
        await context.mcpReq.notify({ method: "notifications/message", params: { level: "info", data: "query-started" } });
        return { content: [{ type: "text", text: await query() }] };
      });
      server.registerResource("query", "gate://query", {}, async () => ({ contents: [{ uri: "gate://query", text: await query() }] }));
      server.server.setRequestHandler("narriflow-extension/tasks/get", { params: z.object({ taskId: z.string() }), result: z.object({ resultType: z.literal("complete"), value: z.string() }) },
        async () => ({ resultType: "complete", value: await query() }));
      return server;
    });
    return { async fetch(request) {
      if (new URL(request.url).pathname === "/stats") return Response.json({ created, disposed, queries });
      return handler.fetch(request);
    } };
  },
});
export default {
  fetch(request: Request, bindings: ApiWorkerBindings, context: ExecutionContext) {
    if (typeof bindings.GATE_KEY === "string" && request.headers.get("X-Gate-Key") !== bindings.GATE_KEY) return new Response(null, { status: 401 });
    return worker.fetch(request, bindings, context);
  },
};

import { Hono } from "hono";
import { apiSecurityHeaders } from "../../src/http/cors";
import { apiRequestId } from "../../src/http/logging";
import { createProgressSocketRoutes } from "../../src/domains/progress/socket";
import { createProgressTicketCodec, loadProgressTicketKeys } from "@narriflow/services/progress-ticket";
import type { ProgressReplay } from "@narriflow/services/progress-feed";
import type { ApiEnv } from "../../src/http/env";
import type { ProgressRevocation } from "../../src/durable-objects/project-progress";
export { ProjectProgress } from "../../src/durable-objects/project-progress";

const replays = new Map<string, ProgressReplay & { delayMs?: number }>();
let replayReads = 0;
export default {
  async fetch(request: Request, bindings: ApiEnv["Bindings"], context: ExecutionContext) {
    if (typeof bindings.GATE_KEY === "string" && request.headers.get("X-Gate-Key") !== bindings.GATE_KEY) return new Response(null, { status: 401 });
    const app = new Hono<ApiEnv>();
    app.use("*", apiRequestId());
    app.use("*", apiSecurityHeaders({ production: true }));
    app.post("/control/replay/:projectId", async (c) => { replays.set(c.req.param("projectId"), await c.req.json()); return c.json({ ok: true }); });
    app.post("/control/publish/:projectId", async (c) => { const input = await c.req.json(); await bindings.PROJECT_PROGRESS.getByName(c.req.param("projectId")).publish(input.scope, input.event); return c.json({ ok: true }); });
    app.post("/control/revoke/:projectId", async (c) => { await bindings.PROJECT_PROGRESS.getByName(c.req.param("projectId")).revoke(await c.req.json<ProgressRevocation>()); return c.json({ ok: true }); });
    app.get("/control/stats", (c) => c.json({ replayReads }));
    const codec = createProgressTicketCodec(loadProgressTicketKeys({ PROGRESS_CONNECT_KEY_ID: String(bindings.PROGRESS_CONNECT_KEY_ID), PROGRESS_CONNECT_KEYS_JSON: String(bindings.PROGRESS_CONNECT_KEYS_JSON) }));
    app.route("/api", createProgressSocketRoutes({ allowedOrigins: ["https://web.narriflow.test"], audience: "https://api.narriflow.test/api/progress", verify: codec.verify,
      replay: async (scope) => { replayReads += 1; const replay = replays.get(scope.projectId) ?? { highWater: 0, events: [], reset: false }; if (replay.delayMs) await new Promise((resolve) => setTimeout(resolve, replay.delayMs)); return replay; },
    }));
    return app.fetch(request, bindings, context);
  },
};

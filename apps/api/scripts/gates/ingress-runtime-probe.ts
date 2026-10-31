import { createDatabaseScope } from "@narriflow/db/client";
import { BODY_LIMIT_BYTES } from "../../src/http/limits";
import { createInventoryApp } from "../../src/test-app";
import { createApiWorker } from "../../src/worker";
import type { ApiWorkerBindings } from "../../src/worker-bindings";

let app: ReturnType<typeof createInventoryApp> | undefined;
const api = createApiWorker({
  createApp: () => app ??= createInventoryApp(),
  createScope: () => createDatabaseScope({ createClient() { throw new Error("Ingress gate must not open a database client"); } }),
});

/** Local-only probe. Normal requests traverse the real Worker scope and the full
 * application mounts. Only the fixed synthetic counter fixtures below are
 * constructed internally, so they make no claim about public edge ingress. */
export default {
  async fetch(request: Request, env: ApiWorkerBindings, ctx: ExecutionContext) {
    const path = new URL(request.url).pathname;
    if (path === "/__gates/provider-declared-over" || path === "/__gates/provider-stream-over" || path === "/__gates/first-party-stream-over") {
      const firstParty = path === "/__gates/first-party-stream-over";
      const declared = path === "/__gates/provider-declared-over";
      const chunk = new Uint8Array(1024 * 1024);
      let remaining = firstParty ? 9 * 1024 * 1024 : BODY_LIMIT_BYTES.providerResult + 1;
      let enqueued = 0;
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!remaining) return controller.close();
          const bytes = Math.min(remaining, chunk.byteLength);
          controller.enqueue(chunk.subarray(0, bytes));
          remaining -= bytes;
          enqueued += bytes;
        },
        cancel() { cancelled = true; },
      });
      const response = await api.fetch(new Request(firstParty ? "https://ingress.invalid/api/recipes" : "https://ingress.invalid/api/webhooks/elevenlabs", {
        method: "POST",
        headers: firstParty ? { origin: "http://localhost:3000" } : declared ? { "content-length": String(BODY_LIMIT_BYTES.providerResult + 1) } : {},
        body,
      }), env, ctx);
      return Response.json({ status: response.status, requestId: response.headers.get("x-request-id"), body: await response.json(), cors: response.headers.get("access-control-allow-origin"), cancelled, enqueued });
    }
    return api.fetch(request, env, ctx);
  },
};

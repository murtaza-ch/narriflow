import type { ProgressTicketPayload } from "@narriflow/validators/api/progress";
import { parseSinceSeq } from "@narriflow/validators/api/progress";
import type { ProgressReplay } from "@narriflow/services/progress-feed";
import { createRouteApp } from "../../http/admission";
import { jsonError, requestIdOf } from "../../http/errors";
import { uuidParams } from "../platform/params";
import { progressSocketAdmission } from "./admission";

export interface ProgressSocketDeps {
  allowedOrigins: readonly string[];
  audience: string;
  verify(ticket: string, input: { audience: string; origin: string; nowMs: number }): Promise<ProgressTicketPayload>;
  replay(scope: { projectId: string; workspaceId: string }, cursor: number): Promise<ProgressReplay | null>;
}

/** Connect-ticket authentication runs before the first possible SQL read. */
export function createProgressSocketRoutes(deps: ProgressSocketDeps) {
  return createRouteApp(progressSocketAdmission).get("/progress/:projectId", uuidParams("projectId"), async (c) => {
    const origin = c.req.header("Origin");
    if (!origin || !deps.allowedOrigins.includes(origin)) return jsonError(403, "progress_origin_not_allowed", "Progress requires an allowed browser origin.", requestIdOf(c));
    if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") return new Response(null, { status: 426 });
    let ticket: ProgressTicketPayload;
    try { ticket = await deps.verify(c.req.query("ticket") ?? "", { origin, audience: deps.audience, nowMs: Date.now() }); }
    catch { return jsonError(401, "invalid_progress_ticket", "Request a fresh progress connection ticket.", requestIdOf(c)); }
    if (ticket.projectId !== c.req.valid("param").projectId) return jsonError(403, "project_inaccessible", "Project unavailable.", requestIdOf(c));
    const stub = c.env.PROJECT_PROGRESS.getByName(ticket.projectId);
    // DO subscribes and buffers before SQL captures its high-water mark.
    const response = await stub.fetch(c.req.raw);
    if (response.status !== 101) return response;
    try {
      const replay = await deps.replay(ticket, parseSinceSeq(c.req.query("sinceSeq")));
      if (!replay) {
        await stub.revoke({ projectId: ticket.projectId, workspaceId: ticket.workspaceId, authorizedBefore: Date.now(), error: "project_inaccessible" });
      } else await stub.replay(ticket.nonce, replay);
    } catch (error) {
      // A failed replay must never leave a socket silently live at a stale cursor.
      await stub.abortReplay(ticket.nonce);
      throw error;
    }
    return response;
  });
}

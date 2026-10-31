import type { ProgressTicketPayload } from "@narriflow/validators/api/progress";
import { PROGRESS_CONNECT_TICKET_MS, PROGRESS_SUBSCRIPTION_MAX_MS } from "@narriflow/validators/api/progress";
import { getActor, createRouteApp } from "../../http/admission";
import { jsonError, requestIdOf } from "../../http/errors";
import { uuidParams } from "../platform/params";
import { progressAdmission } from "./admission";

export interface ProgressRouteDeps {
  allowedOrigins: readonly string[];
  audience: string;
  issue(scope: Pick<ProgressTicketPayload, "actorUserId" | "workspaceId" | "projectId" | "origin" | "audience">, authorizedAt: number): Promise<string>;
}

export function createProgressRoutes(deps: ProgressRouteDeps) {
  return createRouteApp(progressAdmission).post("/projects/:projectId/progress-ticket", uuidParams("projectId"), async (c) => {
    const actor = getActor(c);
    const origin = c.req.header("Origin");
    if (!origin || !deps.allowedOrigins.includes(origin)) return jsonError(403, "progress_origin_not_allowed", "Progress requires an allowed browser origin.", requestIdOf(c));
    // Authorization began before any actor lookup. A delayed lookup cannot mint
    // a ticket that extends a removed member's 60-second access bound.
    const authorizedAt = c.get("requestStartedAt") ?? Date.now();
    if (Date.now() >= authorizedAt + PROGRESS_CONNECT_TICKET_MS) return jsonError(503, "progress_authorization_expired", "Retry progress authorization.", requestIdOf(c));
    const ticket = await deps.issue({ actorUserId: actor.actorUserId, workspaceId: actor.workspaceId, projectId: c.req.valid("param").projectId, origin, audience: deps.audience }, authorizedAt);
    c.header("Cache-Control", "no-store");
    return c.json({ ticket, ticketExpiresAt: authorizedAt + PROGRESS_CONNECT_TICKET_MS, subscriptionExpiresAt: authorizedAt + PROGRESS_SUBSCRIPTION_MAX_MS });
  });
}
export type ProgressRoutes = ReturnType<typeof createProgressRoutes>;

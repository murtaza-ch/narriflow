import type { NarriflowMcpPrincipal } from "@narriflow/mcp-core";
import { getPrismaClient } from "@narriflow/db/client";
import { ExpectedDomainFailureError } from "@narriflow/services";

/** Call only with verified signed state and a matching signed-in actor. */
export function continuationPrincipal(state: { callerId: string; actorUserId: string; workspaceId: string }): NarriflowMcpPrincipal {
  const prefix = "api_key:";
  if (state.callerId.startsWith(prefix)) {
    const keyId = state.callerId.slice(prefix.length, -(state.actorUserId.length + 1));
    if (!/^[a-f0-9-]{36}$/i.test(keyId) || state.callerId !== `api_key:${keyId}:${state.actorUserId}`) throw new Error("Invalid signed caller identity");
    return { kind: "api_key", apiKeyId: keyId, userId: state.actorUserId, workspaceId: state.workspaceId, clientId: `narriflow-api-key:${keyId}`, scopes: ["processing:write", "publishing:write"] };
  }
  const clientId = state.callerId.slice("oauth:".length, -(state.actorUserId.length + 1));
  if (!clientId || state.callerId !== `oauth:${clientId}:${state.actorUserId}`) throw new Error("Invalid signed caller identity");
  return { kind: "oauth", userId: state.actorUserId, clientId, scopes: ["processing:write", "publishing:write"] };
}

/** Browser identity confirms the signed caller, while key-backed continuations
 * must still honor revocation and the key's current explicit grant. */
export async function admitMcpContinuation(state: { callerId: string; actorUserId: string; workspaceId: string }, requiredScope: "processing:write" | "publishing:write") {
  const principal = continuationPrincipal(state);
  if (principal.kind === "api_key") {
    const key = await getPrismaClient()?.apiKey.findFirst({ where: { id: principal.apiKeyId, workspaceId: principal.workspaceId, revokedAt: null }, select: { createdByUserId: true, userId: true, scopes: true } });
    if (!key || (key.createdByUserId ?? key.userId) !== principal.userId) throw new ExpectedDomainFailureError({ code: "mcp_continuation_revoked", kind: "forbidden", message: "This connection was revoked. Prepare the request again using an active connection." });
    if (!key.scopes.includes(requiredScope)) throw new ExpectedDomainFailureError({ code: "mcp_scope_required", kind: "forbidden", message: `This connection requires ${requiredScope}` });
    principal.scopes = key.scopes;
  }
  return principal;
}

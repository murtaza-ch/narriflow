import type { NarriflowMcpPrincipal } from "@narriflow/mcp-core";
import { getPrismaClient } from "@narriflow/db/client";
import { ExpectedDomainFailureError } from "@narriflow/services";

type SignedContinuation = { callerId: string; actorUserId: string; workspaceId: string; principalKind: "oauth" | "api_key"; scopes: string[] };
type ContinuationScope = "processing:write" | "publishing:write";
type ActiveKey = { createdByUserId: string | null; userId: string; scopes: string[] };

/** Call only with verified signed state and a matching signed-in actor. The
 * principal holds exactly the scopes signed when the continuation was made. */
export function continuationPrincipal(state: SignedContinuation): NarriflowMcpPrincipal {
  if (state.principalKind === "api_key") {
    const keyId = state.callerId.slice("api_key:".length, -(state.actorUserId.length + 1));
    if (!/^[a-f0-9-]{36}$/i.test(keyId) || state.callerId !== `api_key:${keyId}:${state.actorUserId}`) throw new Error("Invalid signed caller identity");
    return { kind: "api_key", apiKeyId: keyId, userId: state.actorUserId, workspaceId: state.workspaceId, clientId: `narriflow-api-key:${keyId}`, scopes: [...state.scopes] };
  }
  const clientId = state.callerId.slice("oauth:".length, -(state.actorUserId.length + 1));
  if (!clientId || state.callerId !== `oauth:${clientId}:${state.actorUserId}`) throw new Error("Invalid signed caller identity");
  return { kind: "oauth", userId: state.actorUserId, clientId, scopes: [...state.scopes] };
}

function scopeRequired(scope: ContinuationScope): never {
  throw new ExpectedDomainFailureError({ code: "scope_required", kind: "forbidden", message: `This connection requires ${scope}` });
}

/** Browser identity confirms the signed caller. The signed grant must include
 * the needed scope, and key-backed continuations also honor revocation and the
 * key's current explicit grant. */
export async function admitMcpContinuation(
  state: SignedContinuation,
  requiredScope: ContinuationScope,
  findActiveKey: (keyId: string, workspaceId: string) => Promise<ActiveKey | null> = async (id, workspaceId) =>
    await getPrismaClient()?.apiKey.findFirst({ where: { id, workspaceId, revokedAt: null }, select: { createdByUserId: true, userId: true, scopes: true } }) ?? null,
) {
  const principal = continuationPrincipal(state);
  if (!principal.scopes.includes(requiredScope)) scopeRequired(requiredScope);
  if (principal.kind === "api_key") {
    const key = await findActiveKey(principal.apiKeyId, principal.workspaceId);
    if (!key || (key.createdByUserId ?? key.userId) !== principal.userId) throw new ExpectedDomainFailureError({ code: "mcp_continuation_revoked", kind: "forbidden", message: "This connection was revoked. Prepare the request again using an active connection." });
    if (!key.scopes.includes(requiredScope)) scopeRequired(requiredScope);
    principal.scopes = principal.scopes.filter((scope) => key.scopes.includes(scope));
  }
  return principal;
}

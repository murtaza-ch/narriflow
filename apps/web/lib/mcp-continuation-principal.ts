import { openMcpContinuationAccessToken, type NarriflowMcpPrincipal } from "@narriflow/mcp-core";
import { OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";
import { McpAuthUnavailableError, principalFromMcpAuth } from "@narriflow/mcp-core/auth";
import { getPrismaClient } from "@narriflow/db/client";
import { ExpectedDomainFailureError } from "@narriflow/services";

type SignedContinuation = { callerId: string; actorUserId: string; workspaceId: string; principalKind: "oauth" | "api_key"; scopes: string[]; oauthToken?: string };
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
 * the needed scope. Both credential kinds recheck revocation and the current
 * explicit grant; verification outages refuse admission. */
export async function admitMcpContinuation(
  state: SignedContinuation,
  requiredScope: ContinuationScope,
  findActiveKey: (keyId: string, workspaceId: string) => Promise<ActiveKey | null> = async (id, workspaceId) =>
    await getPrismaClient()?.apiKey.findFirst({ where: { id, workspaceId, revokedAt: null }, select: { createdByUserId: true, userId: true, scopes: true } }) ?? null,
  verifyOAuthAccessToken: (token: string) => Promise<NarriflowMcpPrincipal> = async (token) =>
    principalFromMcpAuth(await (await import("./mcp-auth")).narriflowMcpTokenVerifier.verifyAccessToken(token)),
) {
  const principal = continuationPrincipal(state);
  if (!principal.scopes.includes(requiredScope)) scopeRequired(requiredScope);
  if (principal.kind === "api_key") {
    const key = await findActiveKey(principal.apiKeyId, principal.workspaceId);
    if (!key || (key.createdByUserId ?? key.userId) !== principal.userId) throw new ExpectedDomainFailureError({ code: "mcp_continuation_revoked", kind: "forbidden", message: "This connection was revoked. Prepare the request again using an active connection." });
    if (!key.scopes.includes(requiredScope)) scopeRequired(requiredScope);
    principal.scopes = principal.scopes.filter((scope) => key.scopes.includes(scope));
  } else {
    const token = openMcpContinuationAccessToken(state);
    let current: NarriflowMcpPrincipal;
    try {
      current = await verifyOAuthAccessToken(token);
    } catch (error) {
      if (error instanceof McpAuthUnavailableError) throw new ExpectedDomainFailureError({ code: "mcp_continuation_unavailable", kind: "unavailable", message: "Credential verification is temporarily unavailable. Retry this request.", retryAfterSeconds: error.retryAfterSeconds });
      if (!(error instanceof OAuthError) || error.code !== OAuthErrorCode.InvalidToken) throw error;
      throw new ExpectedDomainFailureError({ code: "mcp_continuation_revoked", kind: "forbidden", message: "This connection was revoked or expired. Prepare the request again using an active connection." });
    }
    if (current.kind !== "oauth" || current.userId !== principal.userId || current.clientId !== principal.clientId) {
      throw new ExpectedDomainFailureError({ code: "mcp_continuation_revoked", kind: "forbidden", message: "This connection no longer matches the request. Prepare the request again using an active connection." });
    }
    if (!current.scopes.includes(requiredScope)) scopeRequired(requiredScope);
    principal.scopes = principal.scopes.filter((scope) => current.scopes.includes(scope));
  }
  return principal;
}

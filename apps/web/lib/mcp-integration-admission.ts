import { OAuthError } from "@modelcontextprotocol/server";
import type { RateLimitResult } from "@narriflow/services";
import { mcpAuthFailureResponse } from "@narriflow/mcp-core/http";
import { requireNewMutationAllowed } from "@narriflow/services";

export function mcpIntegrationAuthenticationFailure(error: unknown, metadataUrl: string) {
  return error instanceof OAuthError ? mcpAuthFailureResponse(error, metadataUrl) : null;
}

/** Every request consumes the normal budget. Limiter outages defer only the
 * new-mutation check so accepted upload transfers and replays can continue. */
export function mcpIntegrationMutationGuard(result: RateLimitResult) {
  if (!result.allowed) requireNewMutationAllowed(result);
  return () => requireNewMutationAllowed(result);
}

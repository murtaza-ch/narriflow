import { OAuthError, OAuthErrorCode, verifyBearerToken, type OAuthTokenVerifier } from "@modelcontextprotocol/server";
import { getPrismaClient } from "@narriflow/db/client";
import { createNarriflowTokenVerifier, principalFromMcpAuth } from "@narriflow/mcp-core/auth";
import { mcpRateLimitKey, parseMcpOrigins } from "@narriflow/mcp-core/http";
import { checkRateLimit, workspaceService } from "@narriflow/services";
import { WORKSPACE_API_KEY_SCOPES } from "@narriflow/validators";
import type { ApiConfig, ApiEnvironment } from "../../config";
import { mcpIntegrationAuthenticationFailure, mcpIntegrationMutationGuard } from "./mcp-integration-admission";

/** API resource and browser destinations have independent canonical origins. */
export function createMcpAuth(config: ApiConfig, env: ApiEnvironment = process.env) {
  const resourceUrl = new URL("/mcp", config.apiOrigin).href;
  const metadataUrl = new URL("/.well-known/oauth-protected-resource/mcp", config.apiOrigin).href;
  const issuerValue = env.CLERK_OAUTH_ISSUER?.trim();
  const issuer = issuerValue ? new URL(issuerValue) : null;
  if (issuer && (issuer.protocol !== "https:" || issuer.username || issuer.password || issuer.search || issuer.hash)) {
    throw new Error("CLERK_OAUTH_ISSUER must be an HTTPS issuer URL");
  }
  const issuerUrl = issuer?.href.replace(/\/$/, "");
  const allowedHosts = [...new Set([new URL(config.apiOrigin).hostname, ...(config.nodeEnv === "production" ? [] : ["localhost", "127.0.0.1", "[::1]"]), ...(env.MCP_ALLOWED_HOSTS ?? "").split(",").map((value) => value.trim()).filter(Boolean).map((value) => value.includes("://") ? new URL(value).hostname : value)])];
  const allowedOrigins = [...new Set(parseMcpOrigins([config.apiOrigin, config.webOrigin, ...(env.MCP_ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean)]))];
  const verifier: OAuthTokenVerifier = createNarriflowTokenVerifier({
    resourceUrl: () => resourceUrl,
    secretKey: () => config.clerk.secretKey,
    authenticateApiKey: (token) => workspaceService.authenticateApiKey(token),
    findUser: async (clerkId) => {
      const prisma = getPrismaClient();
      if (!prisma) throw new Error("Identity storage is unavailable");
      return prisma.user.findFirst({ where: { clerkId, deletedAt: null }, select: { id: true } });
    },
  });
  return {
    resourceUrl, metadataUrl, issuerUrl, allowedHosts, allowedOrigins, verifier,
    protectedResourceMetadata: () => {
      if (!issuerUrl) throw new Error("CLERK_OAUTH_ISSUER is required for OAuth discovery");
      return { resource: resourceUrl, authorization_servers: [issuerUrl], bearer_methods_supported: ["header"], scopes_supported: [...WORKSPACE_API_KEY_SCOPES] };
    },
    async authenticate(request: Request) {
      const header = request.headers.get("authorization") ?? "";
      if (!/^Bearer [^\s,]+$/i.test(header)) throw new OAuthError(OAuthErrorCode.InvalidToken, "Expected one Bearer credential");
      return principalFromMcpAuth(await verifyBearerToken(header, { verifier }));
    },
    authenticationFailure: (error: unknown) => mcpIntegrationAuthenticationFailure(error, metadataUrl),
  };
}

export async function getMcpMutationGuard(principal: Parameters<typeof mcpRateLimitKey>[0]) {
  return mcpIntegrationMutationGuard(await checkRateLimit(mcpRateLimitKey(principal), 300, 60));
}

import "server-only";

import {
  OAuthError,
  OAuthErrorCode,
  verifyBearerToken,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import { getPrismaClient } from "@narriflow/db/client";
import { checkRateLimit, workspaceService } from "@narriflow/services";
import type { NarriflowMcpPrincipal } from "@narriflow/mcp-core";
import { createNarriflowTokenVerifier, principalFromMcpAuth } from "@narriflow/mcp-core/auth";
import { mcpRateLimitKey, parseMcpOrigins } from "@narriflow/mcp-core/http";
import { WORKSPACE_API_KEY_SCOPES } from "@narriflow/validators";
import { mcpIntegrationAuthenticationFailure, mcpIntegrationMutationGuard } from "./mcp-integration-admission";

function requiredUrl(name: "NEXT_PUBLIC_APP_URL" | "CLERK_OAUTH_ISSUER") {
  const raw = process.env[name]?.trim();
  if (!raw) {
    if (name === "NEXT_PUBLIC_APP_URL" && process.env.NODE_ENV !== "production") {
      return new URL("http://localhost:3000");
    }
    throw new Error(`${name} is required for the remote MCP server`);
  }
  const url = new URL(raw);
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error(`${name} must use HTTPS in production`);
  }
  return url;
}

export function getMcpResourceUrl() {
  return new URL("/mcp", requiredUrl("NEXT_PUBLIC_APP_URL"));
}

export function getMcpResourceMetadataUrl() {
  return new URL(
    "/.well-known/oauth-protected-resource/mcp",
    requiredUrl("NEXT_PUBLIC_APP_URL"),
  );
}

export function getClerkOAuthIssuer() {
  const issuer = requiredUrl("CLERK_OAUTH_ISSUER");
  issuer.pathname = issuer.pathname.replace(/\/$/, "");
  issuer.search = "";
  issuer.hash = "";
  return issuer;
}

function envHostnames(name: "MCP_ALLOWED_HOSTS" | "MCP_ALLOWED_ORIGINS") {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      try {
        return value.includes("://") ? new URL(value).hostname : value;
      } catch {
        throw new Error(`${name} contains an invalid host: ${value}`);
      }
    });
}

export function getMcpAllowedHosts() {
  const hosts = new Set([getMcpResourceUrl().hostname, ...envHostnames("MCP_ALLOWED_HOSTS")]);
  if (process.env.NODE_ENV !== "production") {
    hosts.add("localhost");
    hosts.add("127.0.0.1");
    hosts.add("[::1]");
  }
  return [...hosts];
}

export function getMcpAllowedOrigins() {
  return parseMcpOrigins([getMcpResourceUrl().origin, ...(process.env.MCP_ALLOWED_ORIGINS ?? "")
    .split(",").map((value) => value.trim()).filter(Boolean)]);
}

export function getMcpProtectedResourceMetadata() {
  return {
    resource: getMcpResourceUrl().href,
    authorization_servers: [getClerkOAuthIssuer().href.replace(/\/$/, "")],
    bearer_methods_supported: ["header"],
    scopes_supported: [...WORKSPACE_API_KEY_SCOPES],
  };
}

export const narriflowMcpTokenVerifier: OAuthTokenVerifier = createNarriflowTokenVerifier({
  resourceUrl: () => getMcpResourceUrl().href,
  secretKey: () => process.env.CLERK_SECRET_KEY,
  authenticateApiKey: (token) => workspaceService.authenticateApiKey(token),
  findUser: async (clerkId) => {
    const prisma = getPrismaClient();
    if (!prisma) throw new Error("Identity storage is unavailable");
    return prisma.user.findFirst({ where: { clerkId, deletedAt: null }, select: { id: true } });
  },
});
export const getMcpPrincipal = principalFromMcpAuth;

export async function authenticateMcpRequest(request: Request): Promise<NarriflowMcpPrincipal> {
  const header = request.headers.get("authorization") ?? "";
  if (!/^Bearer [^\s,]+$/i.test(header)) throw new OAuthError(OAuthErrorCode.InvalidToken, "Expected one Bearer credential");
  return getMcpPrincipal(await verifyBearerToken(header, { verifier: narriflowMcpTokenVerifier }));
}
export function getMcpAuthFailureResponse(error: unknown) {
  return mcpIntegrationAuthenticationFailure(error, getMcpResourceMetadataUrl().href);
}

export async function getMcpMutationGuard(principal: NarriflowMcpPrincipal) {
  const result = await checkRateLimit(mcpRateLimitKey(principal), 300, 60);
  return mcpIntegrationMutationGuard(result);
}

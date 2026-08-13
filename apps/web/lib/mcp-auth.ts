import "server-only";

import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import { getAppUserByClerkId } from "@narriflow/auth";
import { workspaceService } from "@narriflow/services";
import type { NarriflowMcpPrincipal } from "@narriflow/mcp-core";

const CLERK_OAUTH_VERIFY_URL =
  "https://api.clerk.com/oauth_applications/access_tokens/verify";
const NON_EXPIRING_API_KEY_TIMESTAMP = 253402300799;

interface ClerkOAuthTokenVerification {
  active?: false;
  object?: "clerk_idp_oauth_access_token";
  client_id?: string;
  subject?: string;
  scopes?: string[];
  revoked?: boolean;
  expired?: boolean;
  expiration?: number | null;
}

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
  const hosts = new Set([
    getMcpResourceUrl().hostname,
    ...envHostnames("MCP_ALLOWED_ORIGINS"),
  ]);
  if (process.env.NODE_ENV !== "production") {
    hosts.add("localhost");
    hosts.add("127.0.0.1");
    hosts.add("[::1]");
  }
  return [...hosts];
}

export function getMcpProtectedResourceMetadata() {
  return {
    resource: getMcpResourceUrl().href,
    authorization_servers: [getClerkOAuthIssuer().href.replace(/\/$/, "")],
    bearer_methods_supported: ["header"],
    scopes_supported: ["openid", "profile", "email", "offline_access"],
  };
}

async function verifyClerkOAuthToken(token: string): Promise<AuthInfo> {
  const secretKey = process.env.CLERK_SECRET_KEY?.trim();
  if (!secretKey) throw new OAuthError(OAuthErrorCode.ServerError, "Clerk is not configured");

  let response: Response;
  try {
    response = await fetch(CLERK_OAUTH_VERIFY_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ access_token: token }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new OAuthError(OAuthErrorCode.ServerError, "OAuth verification is unavailable");
  }

  if (!response.ok) {
    const code = response.status >= 500 ? OAuthErrorCode.ServerError : OAuthErrorCode.InvalidToken;
    throw new OAuthError(code, code === OAuthErrorCode.ServerError
      ? "OAuth verification is unavailable"
      : "OAuth access token is invalid");
  }

  const verification = await response.json() as ClerkOAuthTokenVerification;
  if (
    verification.active === false ||
    verification.object !== "clerk_idp_oauth_access_token" ||
    verification.revoked ||
    verification.expired ||
    !verification.subject ||
    !verification.client_id ||
    typeof verification.expiration !== "number"
  ) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "OAuth access token is inactive");
  }

  const appUser = await getAppUserByClerkId(verification.subject);
  if (!appUser) {
    throw new OAuthError(
      OAuthErrorCode.InvalidToken,
      "Sign in to Narriflow once before connecting an MCP client",
    );
  }

  const principal: NarriflowMcpPrincipal = {
    kind: "oauth",
    userId: appUser.id,
    clientId: verification.client_id,
    scopes: verification.scopes ?? [],
  };
  return {
    token,
    clientId: verification.client_id,
    scopes: verification.scopes ?? [],
    expiresAt: verification.expiration,
    extra: { narriflowPrincipal: principal },
  };
}

export const narriflowMcpTokenVerifier: OAuthTokenVerifier = {
  async verifyAccessToken(token) {
    if (!token.startsWith("nf_")) return verifyClerkOAuthToken(token);

    const key = await workspaceService.authenticateApiKey(token);
    if (!key) throw new OAuthError(OAuthErrorCode.InvalidToken, "API key is invalid or revoked");

    const principal: NarriflowMcpPrincipal = {
      kind: "api_key",
      userId: key.userId,
      clientId: `narriflow-api-key:${key.apiKeyId}`,
      apiKeyId: key.apiKeyId,
      workspaceId: key.workspaceId,
      scopes: key.scopes,
    };
    return {
      token,
      clientId: principal.clientId,
      scopes: key.scopes,
      expiresAt: NON_EXPIRING_API_KEY_TIMESTAMP,
      extra: { narriflowPrincipal: principal },
    };
  },
};

export function getMcpPrincipal(authInfo: AuthInfo | undefined): NarriflowMcpPrincipal {
  const candidate = authInfo?.extra?.narriflowPrincipal;
  if (!candidate || typeof candidate !== "object") {
    throw new Error("Authenticated Narriflow principal is missing");
  }
  return candidate as NarriflowMcpPrincipal;
}

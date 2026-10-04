import { OAuthError, OAuthErrorCode, type AuthInfo, type OAuthTokenVerifier } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { NarriflowMcpPrincipal } from "./mcp-tool-admission";

const verificationSchema = z.union([
  z.object({ active: z.literal(false) }),
  z.object({
    object: z.literal("clerk_idp_oauth_access_token"),
    id: z.string().min(1).max(128), client_id: z.string().min(1).max(128), subject: z.string().min(1).max(128),
    scopes: z.array(z.string().min(1).max(128)).max(64), aud: z.array(z.string().min(1).max(2048)).max(32).optional(),
    revoked: z.boolean(), revocation_reason: z.string().nullable(), expired: z.boolean(),
    expiration: z.number().finite().nullable(), created_at: z.number().finite(), updated_at: z.number().finite(),
  }),
]);

export class McpAuthUnavailableError extends OAuthError {
  constructor(readonly retryAfterSeconds = 5) {
    super(OAuthErrorCode.ServerError, "Credential verification is temporarily unavailable");
  }
}

type ApiKey = { apiKeyId: string; userId: string; workspaceId: string; scopes: string[] };
export interface McpVerifierDependencies {
  resourceUrl(): string;
  secretKey(): string | undefined;
  authenticateApiKey(token: string): Promise<ApiKey | null>;
  findUser(clerkUserId: string): Promise<{ id: string } | null>;
  fetch?: typeof fetch;
  now?: () => number;
}

function retryDelay(response: Response) {
  const delay = Number(response.headers.get("Retry-After"));
  return Number.isFinite(delay) && delay > 0 ? Math.min(300, Math.ceil(delay)) : 5;
}

export function principalFromMcpAuth(auth: AuthInfo | undefined): NarriflowMcpPrincipal {
  const value = auth?.extra?.narriflowPrincipal;
  if (!value || typeof value !== "object" || !("kind" in value)) throw new Error("Authenticated principal is missing");
  return value as NarriflowMcpPrincipal;
}

/** Online verification intentionally has no token cache: revocation takes effect on the next request. */
export function createNarriflowTokenVerifier(deps: McpVerifierDependencies): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token) {
      if (token.startsWith("nf_")) {
        let key: ApiKey | null;
        try { key = await deps.authenticateApiKey(token); } catch { throw new McpAuthUnavailableError(); }
        if (!key) throw new OAuthError(OAuthErrorCode.InvalidToken, "API key is invalid or revoked");
        const principal: NarriflowMcpPrincipal = {
          kind: "api_key", userId: key.userId, clientId: `narriflow-api-key:${key.apiKeyId}`,
          apiKeyId: key.apiKeyId, workspaceId: key.workspaceId, scopes: key.scopes,
        };
        return { token, clientId: principal.clientId, scopes: principal.scopes, expiresAt: 253402300799,
          extra: { narriflowPrincipal: principal } };
      }
      const secret = deps.secretKey()?.trim();
      if (!secret) throw new McpAuthUnavailableError();
      let response: Response;
      try {
        response = await (deps.fetch ?? fetch)("https://api.clerk.com/v1/oauth_applications/access_tokens/verify", {
          method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
          body: JSON.stringify({ access_token: token }), cache: "no-store", signal: AbortSignal.timeout(10_000),
        });
      } catch { throw new McpAuthUnavailableError(); }
      if (!response.ok) {
        if (response.status === 429 || response.status >= 500 || response.status === 401 || response.status === 403) {
          throw new McpAuthUnavailableError(retryDelay(response));
        }
        throw new OAuthError(OAuthErrorCode.InvalidToken, "OAuth access token is invalid");
      }
      let raw: unknown;
      try { raw = await response.json(); } catch { throw new McpAuthUnavailableError(); }
      const parsed = verificationSchema.safeParse(raw);
      if (!parsed.success) throw new McpAuthUnavailableError();
      const claims = parsed.data;
      if ("active" in claims || claims.revoked || claims.expired || claims.expiration === null ||
        claims.expiration <= (deps.now ?? Date.now)() / 1000 || !claims.aud?.includes(deps.resourceUrl())) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, "OAuth access token is inactive or has an invalid audience");
      }
      let user: { id: string } | null;
      try { user = await deps.findUser(claims.subject); } catch { throw new McpAuthUnavailableError(); }
      if (!user) throw new OAuthError(OAuthErrorCode.InvalidToken, "Sign in to Narriflow once before connecting an MCP client");
      const principal: NarriflowMcpPrincipal = { kind: "oauth", userId: user.id, clientId: claims.client_id, scopes: claims.scopes };
      return { token, clientId: claims.client_id, scopes: claims.scopes, expiresAt: claims.expiration,
        extra: { narriflowPrincipal: principal } };
    },
  };
}

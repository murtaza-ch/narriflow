import { createClerkClient, type ClerkClient } from "@clerk/backend";
import { TokenVerificationErrorReason } from "@clerk/backend/errors";

export interface ClerkServerConfig {
  secretKey: string;
  publishableKey: string;
}

/** One Backend API client per process: session verification plus user lookups. */
export function createServerClerkClient(config: ClerkServerConfig): ClerkClient {
  return createClerkClient({
    secretKey: config.secretKey,
    publishableKey: config.publishableKey,
    telemetry: { disabled: true },
  });
}

declare const verifiedIdentityBrand: unique symbol;

/**
 * A Clerk user whose session token was verified for this request. Only
 * `createBearerAuthenticator` mints one, so staff and Workspace resolution can
 * require it instead of trusting a bare id.
 */
export interface VerifiedClerkIdentity {
  readonly clerkUserId: string;
  readonly sessionId: string | null;
  readonly [verifiedIdentityBrand]: true;
}

export type BearerAuthResult =
  | { status: "authenticated"; identity: VerifiedClerkIdentity }
  | {
      status: "unauthenticated";
      reason: "missing_credential" | "malformed_credential" | "rejected_token";
    }
  /** Clerk (or its key material) could not be reached: a 503, never a sign-out. */
  | { status: "unavailable" };

export type SessionTokenVerifier = Pick<ClerkClient, "authenticateRequest">;

export interface BearerAuthenticatorOptions {
  client: SessionTokenVerifier;
  /** Full frontend origins allowed in the session token's `azp` claim. */
  authorizedParties: readonly string[];
}

const MAX_BEARER_LENGTH = 8 * 1024;
// RFC 6750 b64token. A comma means several Authorization values were merged.
const BEARER_HEADER = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i;

const UNAVAILABLE_REASONS: ReadonlySet<string> = new Set([
  TokenVerificationErrorReason.RemoteJWKFailedToLoad,
  TokenVerificationErrorReason.RemoteJWKInvalid,
  TokenVerificationErrorReason.RemoteJWKMissing,
  TokenVerificationErrorReason.JWKFailedToResolve,
  TokenVerificationErrorReason.LocalJWKMissing,
  TokenVerificationErrorReason.InvalidSecretKey,
  // Clerk reports non-verification exceptions (network, parsing) this way.
  "unexpected-error",
]);

function readBearerToken(request: Request): string | null | undefined {
  const header = request.headers.get("authorization");
  if (header === null) return undefined;
  if (header.length > MAX_BEARER_LENGTH + 7) return null;
  return BEARER_HEADER.exec(header)?.[1] ?? null;
}

function assertAuthorizedParties(parties: readonly string[]): void {
  if (parties.length === 0) {
    // An empty list makes Clerk skip the `azp` check entirely.
    throw new Error("CLERK_AUTHORIZED_PARTIES must list at least one frontend origin");
  }
  for (const party of parties) {
    let origin: string | null = null;
    try {
      origin = new URL(party).origin;
    } catch {
      // Falls through to the shared error below.
    }
    if (origin !== party || party.includes("*")) {
      throw new Error("CLERK_AUTHORIZED_PARTIES entries must be full origins without a path");
    }
  }
}

function logUnavailable(reason: string): void {
  console.warn(JSON.stringify({ level: "warn", message: "auth_provider_unavailable", reason }));
}

/**
 * Verifies the explicit `Authorization: Bearer` Clerk session token and
 * nothing else. Cookies never authenticate: Clerk only ever sees a request
 * rebuilt with the single Authorization header, so no cookie, handshake or
 * redirect path exists.
 */
export function createBearerAuthenticator(
  options: BearerAuthenticatorOptions,
): (request: Request) => Promise<BearerAuthResult> {
  assertAuthorizedParties(options.authorizedParties);
  const authorizedParties = [...options.authorizedParties];

  return async (request) => {
    const token = readBearerToken(request);
    if (token === undefined) return { status: "unauthenticated", reason: "missing_credential" };
    if (token === null) return { status: "unauthenticated", reason: "malformed_credential" };

    try {
      const state = await options.client.authenticateRequest(
        new Request(request.url, { headers: { authorization: `Bearer ${token}` } }),
        { acceptsToken: "session_token", authorizedParties },
      );

      if (state.status === "signed-in" && state.tokenType === "session_token") {
        const auth = state.toAuth();
        if (auth.userId) {
          return {
            status: "authenticated",
            identity: { clerkUserId: auth.userId, sessionId: auth.sessionId ?? null } as VerifiedClerkIdentity,
          };
        }
        return { status: "unauthenticated", reason: "rejected_token" };
      }

      const reason = state.reason ?? "";
      if (UNAVAILABLE_REASONS.has(reason)) {
        logUnavailable(reason);
        return { status: "unavailable" };
      }
      return { status: "unauthenticated", reason: "rejected_token" };
    } catch (error) {
      logUnavailable(error instanceof Error ? error.name : "unknown");
      return { status: "unavailable" };
    }
  };
}

/** Confirmed "no such user" answer from the Clerk Backend API. */
export function isClerkNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const kind = (error.constructor as { kind?: unknown } | undefined)?.kind;
  return kind === "ClerkAPIResponseError" && "status" in error && error.status === 404;
}

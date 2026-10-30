import type { MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import type { ApiEnv } from "./env";
import { failureResponse, markEnvelope, requestIdOf } from "./errors";

export const CORS_ALLOWED_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const;

/** First-party request headers. MCP upload and REST declare their own sets. */
export const CORS_ALLOWED_HEADERS = [
  "Authorization",
  "Content-Type",
  "X-Workspace-Id",
  "Idempotency-Key",
  "Campaign-Retry-Of",
] as const;

export const CORS_EXPOSED_HEADERS = [
  "X-Request-ID",
  "X-Workspace-Id",
  "Retry-After",
  "Idempotent-Replayed",
  "RateLimit-Limit",
  "RateLimit-Remaining",
  "RateLimit-Reset",
  "Content-Disposition",
  "X-Editor-Revision",
] as const;

/**
 * First-party browser CORS. A request that carries an `Origin` outside the
 * exact allowlist is refused outright (preflight included) instead of being
 * served without CORS headers; server and provider requests without an
 * `Origin` stay valid under their own credential model. Credentials are never
 * allowed: tokens travel in `Authorization`, not cookies.
 */
export function firstPartyCors(options: {
  allowedOrigins: readonly string[];
}): MiddlewareHandler<ApiEnv> {
  const allowed = new Set(options.allowedOrigins);
  const policy = cors({
    origin: (origin) => (allowed.has(origin) ? origin : null),
    allowMethods: [...CORS_ALLOWED_METHODS],
    allowHeaders: [...CORS_ALLOWED_HEADERS],
    exposeHeaders: [...CORS_EXPOSED_HEADERS],
    maxAge: 600,
    credentials: false,
  }) as MiddlewareHandler<ApiEnv>;

  return async (c, next) => {
    const origin = c.req.header("origin");
    if (origin !== undefined && !allowed.has(origin)) {
      c.header("Vary", "Origin");
      return markEnvelope(
        c,
        failureResponse({
          code: "origin_not_allowed",
          category: "authorization",
          status: 403,
          message: "This origin is not allowed to call the API.",
          requestId: requestIdOf(c),
        }),
      );
    }
    return policy(c, next);
  };
}

/** Endpoint groups under `/api` that answer to their own credential model, not to first-party browsers. */
const NON_FIRST_PARTY_PREFIXES = ["/api/v1", "/api/webhooks/", "/api/health", "/api/ready"] as const;

function isFirstPartyPath(pathname: string): boolean {
  return (
    pathname.startsWith("/api/") &&
    !NON_FIRST_PARTY_PREFIXES.some(
      (prefix) => pathname === prefix || pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`),
    )
  );
}

/**
 * Headers that make an ingress refusal (414/431 before routing, 503 while
 * draining) readable by an allowed first-party browser origin, so the typed
 * error and request ID reach the app instead of an opaque network failure.
 * Never added for other origins, other credential models (REST, MCP,
 * webhooks), or when no `Origin` is sent. Identity is not involved.
 */
export function firstPartyRefusalHeaders(allowedOrigins: readonly string[]) {
  const allowed = new Set(allowedOrigins);
  return (request: Request): Record<string, string> => {
    const origin = request.headers.get("origin");
    if (origin === null || !allowed.has(origin) || !isFirstPartyPath(new URL(request.url).pathname)) {
      return {};
    }
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Expose-Headers": CORS_EXPOSED_HEADERS.join(","),
      Vary: "Origin",
    };
  };
}

/**
 * Secure response headers for a JSON API, plus the default
 * `Cache-Control: private, no-store`. A handler that sets its own policy
 * (SSE, the public OpenAPI document) keeps it.
 */
export function apiSecurityHeaders(options: {
  production: boolean;
}): MiddlewareHandler<ApiEnv> {
  const secure = secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
    strictTransportSecurity: options.production
      ? "max-age=31536000; includeSubDomains"
      : false,
    referrerPolicy: "no-referrer",
    crossOriginResourcePolicy: "cross-origin",
  }) as MiddlewareHandler<ApiEnv>;
  return async (c, next) => {
    await secure(c, async () => {
      await next();
      if (!c.res.headers.has("Cache-Control")) {
        c.header("Cache-Control", "private, no-store");
      }
    });
  };
}

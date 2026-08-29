import type { Context, Next } from "hono";
import {
  authenticatedRequestPolicy,
  type BrowserActorScope,
} from "./authenticated-request-policy.server";
import {
  isIndependentTrustHonoSurface,
  matchBrowserSessionHonoSurface,
} from "./authenticated-request-inventory";
import {
  AuthenticatedRequestUnexpectedError,
  type ActiveProjectScope,
} from "./authenticated-request-policy";
import {
  authenticatedRequestHttpFailure,
  normalizeAuthenticatedErrorResponse,
} from "./authenticated-request-http";

const ACTOR_KEY = "authenticatedRequestActor";
const PROJECT_KEY = "authenticatedRequestProject";

export function authenticatedHonoActor(c: Context): BrowserActorScope {
  const actor = c.get(ACTOR_KEY) as BrowserActorScope | undefined;
  if (!actor)
    throw new Error("Authenticated Request Policy did not admit this route");
  return actor;
}

export function authenticatedHonoProject(
  c: Context,
): ActiveProjectScope | null {
  return (c.get(PROJECT_KEY) as ActiveProjectScope | null | undefined) ?? null;
}

function routePath(c: Context): string {
  const path = new URL(c.req.url).pathname;
  return path.startsWith("/api") ? path.slice(4) || "/" : path;
}

export async function authenticatedRequestHonoMiddleware(
  c: Context,
  next: Next,
) {
  const path = routePath(c);
  if (isIndependentTrustHonoSurface(c.req.method, path)) {
    await next();
    return;
  }

  const declaration = matchBrowserSessionHonoSurface(c.req.method, path);
  if (!declaration) {
    console.warn(
      JSON.stringify({
        level: "error",
        message: "authenticated_request_surface_missing",
        adapter: "hono",
        method: c.req.method,
        path,
      }),
    );
    return c.json(
      {
        error: "request_policy_missing",
        message: "This request is unavailable.",
      },
      500,
    );
  }

  try {
    const result = await authenticatedRequestPolicy.execute({
      adapter: "hono",
      operationName: declaration.operationName,
      admission: declaration.admission,
      rateLimit: declaration.rateLimit,
      operation: async ({ actor, project, requestId }) => {
        c.set(ACTOR_KEY, actor);
        c.set(PROJECT_KEY, project);
        c.header("X-Request-ID", requestId);
        await next();
        return normalizeAuthenticatedErrorResponse(c.res, requestId);
      },
      diagnoseResult: async (response) => {
        if (response.status < 400) return null;
        let failureCode = response.status >= 500 ? "internal_error" : "request_failed";
        try {
          const payload = (await response.clone().json()) as Record<string, unknown>;
          if (typeof payload.error === "string") failureCode = payload.error;
        } catch {
          // Non-JSON failures retain the bounded fallback code.
        }
        return {
          disposition: response.status >= 500 ? "failed" : "refused",
          failureCode,
          status: response.status,
        };
      },
    });

    if (result.ok) return result.value;
    const translated = authenticatedRequestHttpFailure(result.failure);
    c.header("X-Request-ID", result.requestId);
    if (translated.retryAfterSeconds) {
      c.header("Retry-After", String(translated.retryAfterSeconds));
    }
    return c.json(translated.body, translated.status);
  } catch (error) {
    const requestId =
      error instanceof AuthenticatedRequestUnexpectedError
        ? error.requestId
        : crypto.randomUUID();
    console.warn(
      JSON.stringify({
        level: "error",
        message: "authenticated_request_unexpected_failure",
        adapter: "hono",
        operation: declaration.operationName,
        requestId,
        method: c.req.method,
        path,
      }),
    );
    return c.json(
      {
        error: "internal_error",
        message: "Something went wrong. Try again or contact support.",
        requestId,
      },
      500,
    );
  }
}

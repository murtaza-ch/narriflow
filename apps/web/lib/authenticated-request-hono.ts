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
const INPUT_KEY = "authenticatedRequestInput";

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

export function authenticatedHonoInput<T>(c: Context): T {
  const input = c.get(INPUT_KEY) as T | undefined;
  if (input === undefined) {
    throw new Error("Authenticated Request Policy did not validate route input");
  }
  return input;
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
    const common = {
      adapter: "hono",
      operationName: declaration.operationName,
      admission: declaration.admission,
      rateLimit: declaration.rateLimit,
    } as const;
    const operation = async ({
      actor,
      project,
      requestId,
      input,
    }: {
      actor: BrowserActorScope;
      project: ActiveProjectScope | null;
      requestId: string;
      input?: unknown;
    }) => {
        c.set(ACTOR_KEY, actor);
        c.set(PROJECT_KEY, project);
        if (input !== undefined) c.set(INPUT_KEY, input);
        c.header("X-Request-ID", requestId);
        await next();
        return normalizeAuthenticatedErrorResponse(c.res, requestId);
      };
    const diagnoseResult = async (
      response: Response,
    ): Promise<{
      disposition: "failed" | "refused";
      failureCode: string;
      status: number;
    } | null> => {
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
      };
    const result = declaration.input
      ? await authenticatedRequestPolicy.execute({
          ...common,
          input: {
            schema: declaration.input.schema,
            load: async () => {
              const value: Record<string, unknown> = {};
              for (const name of declaration.input?.params ?? []) {
                value[name] = c.req.param(name);
              }
              for (const name of declaration.input?.query ?? []) {
                const queryValue = c.req.query(name);
                if (queryValue !== undefined) value[name] = queryValue;
              }
              if (declaration.input?.body) {
                value.body = await c.req.raw
                  .clone()
                  .json()
                  .catch(() =>
                    declaration.input?.body === "optional" ? {} : null,
                  );
              }
              return value;
            },
          },
          operation,
          diagnoseResult,
        })
      : await authenticatedRequestPolicy.execute({
          ...common,
          operation: async ({ actor, project, requestId }) =>
            operation({ actor, project, requestId }),
          diagnoseResult,
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

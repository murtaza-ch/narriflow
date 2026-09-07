import type { Context, Next } from "hono";
import { isExpectedDomainFailure } from "@narriflow/services";
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
  applyAuthenticatedErrorResponse,
  authenticatedRequestDomainFailure,
  authenticatedRequestHttpFailure,
} from "./authenticated-request-http";
import { parseAuthenticatedJsonBody } from "./authenticated-request-input";

const ACTOR_KEY = "authenticatedRequestActor";
const PROJECT_KEY = "authenticatedRequestProject";
const INPUT_KEY = "authenticatedRequestInput";

export function authenticatedHonoActor(c: Context): BrowserActorScope {
  const actor = c.get(ACTOR_KEY) as BrowserActorScope | undefined;
  if (!actor)
    throw new Error("Authenticated Request Policy did not admit this route");
  return actor;
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

function replaceHonoResponse(c: Context, response: Response): Response {
  c.res = response.clone();
  return response;
}

async function runAuthenticatedRequestHonoMiddleware(
  c: Context,
  next: Next,
  policy: Pick<typeof authenticatedRequestPolicy, "execute">,
) {
  const path = routePath(c);
  if (isIndependentTrustHonoSurface(c.req.method, path)) {
    await next();
    return;
  }

  const declaration = matchBrowserSessionHonoSurface(c.req.method, path);
  if (!declaration) {
    const requestId = crypto.randomUUID();
    console.warn(
      JSON.stringify({
        level: "error",
        message: "authenticated_request_surface_missing",
        adapter: "hono",
        method: c.req.method,
        path,
        requestId,
      }),
    );
    c.header("X-Request-ID", requestId);
    return c.json(
      {
        error: "request_policy_missing",
        message: "This request is unavailable.",
        requestId,
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
        try {
          await next();
        } catch (error) {
          if (isExpectedDomainFailure(error)) {
            throw authenticatedRequestDomainFailure(error);
          }
          throw error;
        }
        if (c.error) {
          if (isExpectedDomainFailure(c.error)) {
            throw authenticatedRequestDomainFailure(c.error);
          }
          throw c.error;
        }
        return applyAuthenticatedErrorResponse(c, requestId);
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
      ? await policy.execute({
          ...common,
          input: {
            schema: declaration.input.schema,
            load: async () => {
              const value: Record<string, unknown> = {};
              for (const name of declaration.input?.params ?? []) {
                value[name] = declaration.params[name];
              }
              for (const name of declaration.input?.query ?? []) {
                const queryValue = c.req.query(name);
                if (queryValue !== undefined) value[name] = queryValue;
              }
              for (const [name, header] of Object.entries(
                declaration.input?.headers ?? {},
              )) {
                const headerValue = c.req.header(header);
                if (headerValue !== undefined) value[name] = headerValue;
              }
              if (declaration.input?.body) {
                const rawBody = await c.req.raw.clone().text();
                value.body = parseAuthenticatedJsonBody(
                  rawBody,
                  declaration.input.body === "optional",
                );
              }
              return value;
            },
          },
          operation,
          diagnoseResult,
        })
      : await policy.execute({
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
    return replaceHonoResponse(
      c,
      c.json(translated.body, translated.status),
    );
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
    c.header("X-Request-ID", requestId);
    return replaceHonoResponse(
      c,
      c.json(
        {
          error: "internal_error",
          message: "Something went wrong. Try again or contact support.",
          requestId,
        },
        500,
      ),
    );
  }
}

export function createAuthenticatedRequestHonoMiddleware(
  policy: Pick<typeof authenticatedRequestPolicy, "execute"> =
    authenticatedRequestPolicy,
) {
  return (c: Context, next: Next) =>
    runAuthenticatedRequestHonoMiddleware(c, next, policy);
}

export const authenticatedRequestHonoMiddleware =
  createAuthenticatedRequestHonoMiddleware();

export function authenticatedRequestHonoErrorHandler(
  _error: Error,
  c: Context,
): Response {
  const path = routePath(c);
  if (isIndependentTrustHonoSurface(c.req.method, path)) {
    console.warn(
      JSON.stringify({
        level: "error",
        message: "independent_trust_hono_failure",
        method: c.req.method,
        path,
      }),
    );
  }
  return c.text("Internal Server Error", 500);
}

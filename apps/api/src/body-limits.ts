import type { MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";
import type { ApiEnv } from "./http/env";
import { payloadTooLargeResponse, requestIdOf } from "./http/errors";
import { type BodyLimitClass, limitBody, ORDINARY_BODY_CAP_BYTES } from "./http/limits";

const BODY_CLASS = Symbol.for("narriflow.api.bodyClass");

/**
 * Declares a route's request-body ceiling. Register it as the first handler of
 * a route that needs more (`editor`, 8 MiB) or less (`guest`, 32 KiB) than the
 * default: `.put(path, bodyClass("editor"), admit(...), ...)`. The marker does
 * nothing at request time; `routeBodyLimit` reads it before any body is read.
 */
export function bodyClass(limitClass: BodyLimitClass): MiddlewareHandler<ApiEnv> {
  const marker: MiddlewareHandler<ApiEnv> = async (_c, next) => {
    await next();
  };
  Object.defineProperty(marker, BODY_CLASS, { value: limitClass });
  return marker;
}

function declaredClass(handlers: readonly { handler: unknown }[]): BodyLimitClass | undefined {
  for (const { handler } of handlers) {
    const declared =
      typeof handler === "function"
        ? (handler as unknown as Record<symbol, unknown>)[BODY_CLASS]
        : undefined;
    if (typeof declared === "string") return declared as BodyLimitClass;
  }
  return undefined;
}

/**
 * App-level streaming body limit, chosen per route class before any handler
 * reads, clones or parses the body. A route's `bodyClass(...)` marker picks the
 * class; everything else gets `fallback`.
 */
export function routeBodyLimit(fallback: BodyLimitClass = "control"): MiddlewareHandler<ApiEnv> {
  const limiters = {
    guest: limitBody("guest"),
    control: limitBody("control"),
    webhook: limitBody("webhook"),
    editor: limitBody("editor"),
    providerResult: limitBody("providerResult"),
  } satisfies Record<BodyLimitClass, MiddlewareHandler<ApiEnv>>;
  return (c, next) => limiters[declaredClass(matchedRoutes(c)) ?? fallback](c, next);
}

/**
 * Refuses a declared Content-Length above the ordinary ceiling before anything
 * reads the body, for every route except one that declared `providerResult`.
 * Bun's native cap is sized for that class, so this keeps every other route's
 * effective ceiling where it was, including routes (MCP) with no limiter of
 * their own.
 */
export function ingressCeiling(): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const declared = Number(c.req.raw.headers.get("content-length"));
    if (declared > ORDINARY_BODY_CAP_BYTES && declaredClass(matchedRoutes(c)) !== "providerResult") {
      return payloadTooLargeResponse(requestIdOf(c));
    }
    await next();
  };
}

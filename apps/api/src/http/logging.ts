import type { MiddlewareHandler } from "hono";
import { requestId } from "hono/request-id";
import { routePath } from "hono/route";
import type { ApiEnv } from "./env";

/** Accepts only a bounded safe inbound `X-Request-ID`; otherwise generates one. Exposed to CORS clients. */
export function apiRequestId(): MiddlewareHandler<ApiEnv> {
  return requestId({
    limitLength: 64,
    headerName: "X-Request-ID",
  }) as MiddlewareHandler<ApiEnv>;
}

/**
 * One structured line per request. It records the matched route pattern,
 * never the concrete URL, so path tokens, query strings and credentials cannot
 * reach the log.
 */
export function requestLogger(options: {
  skipRoutes?: readonly string[];
  now?: () => number;
  write?: (line: string) => void;
} = {}): MiddlewareHandler<ApiEnv> {
  const now = options.now ?? Date.now;
  const write = options.write ?? ((line: string) => console.warn(line));
  const skip = new Set(options.skipRoutes ?? []);
  return async (c, next) => {
    const startedAt = now();
    await next();
    const route = routePath(c, -1);
    if (skip.has(c.req.path)) return;
    write(
      JSON.stringify({
        level: c.res.status >= 500 ? "error" : "info",
        message: "http_request",
        requestId: c.get("requestId"),
        method: c.req.method,
        route,
        status: c.res.status,
        durationMs: Math.max(0, now() - startedAt),
      }),
    );
  };
}

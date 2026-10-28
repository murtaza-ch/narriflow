import type { Hono } from "hono";
import { hc } from "hono/client";
import type { BoundTransport } from "./core";

/** The part of a bound transport that Hono's RPC client needs. */
export type RpcTransport = Pick<BoundTransport, "baseUrl" | "fetch">;

/**
 * One `hc<DomainRoutes>` per domain. The transport supplies the Bearer token,
 * the `X-Workspace-Id` scope header, the single 401 refresh and typed
 * `ApiError`s; the route type only comes from `import type`.
 */
export function createRpcClient<Routes extends Hono<any, any, any>>(
  transport: RpcTransport,
  mount = "/api",
) {
  return hc<Routes>(`${transport.baseUrl}${mount}`, {
    fetch: transport.fetch as typeof fetch,
  });
}

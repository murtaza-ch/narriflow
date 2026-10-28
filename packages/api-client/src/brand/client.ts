import type { BrandRoutes } from "@narriflow/api/types/brand";
import { type RpcTransport, createRpcClient } from "../rpc";

export type { BrandRoutes };

/** Typed client for the brand routes. Pass a bound transport (`runtime.transport.scoped(scope)`). */
export function createBrandClient(transport: RpcTransport) {
  return createRpcClient<BrandRoutes>(transport);
}

export type BrandClient = ReturnType<typeof createBrandClient>;

import type { BillingRoutes } from "@narriflow/api/types/billing";
import { type RpcTransport, createRpcClient } from "../rpc";

export type { BillingRoutes };

/** Typed client for the billing routes. Pass a bound transport (`runtime.transport.scoped(scope)`). */
export function createBillingClient(transport: RpcTransport) {
  return createRpcClient<BillingRoutes>(transport);
}

export type BillingClient = ReturnType<typeof createBillingClient>;

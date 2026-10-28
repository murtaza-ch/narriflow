import type { PublishingRoutes } from "@narriflow/api/types/publishing";
import { type RpcTransport, createRpcClient } from "../rpc";

export type { PublishingRoutes };
export * from "./mutations";
export * from "./queries";

/** Typed client for the publishing routes. Pass a bound transport (`runtime.transport.scoped(scope)`). */
export function createPublishingClient(transport: RpcTransport) {
  return createRpcClient<PublishingRoutes>(transport);
}

export type PublishingClient = ReturnType<typeof createPublishingClient>;

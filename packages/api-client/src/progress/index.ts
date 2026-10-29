import type { ProgressRoutes } from "@narriflow/api/types/progress";
import { type RpcTransport, createRpcClient } from "../rpc";

export type { ProgressRoutes };

/** Typed client for the progress routes. Pass a bound transport (`runtime.transport.scoped(scope)`). */
export function createProgressClient(transport: RpcTransport) {
  return createRpcClient<ProgressRoutes>(transport);
}

export type ProgressClient = ReturnType<typeof createProgressClient>;

export { decodeProgressMessage, isTerminalProgress, terminalProgressIdentity, type ProgressMessage } from "./events";
export {
  PROGRESS_INVALIDATE_THROTTLE_MS,
  PROGRESS_LINGER_MS,
  createProgressHub,
  type ProgressHub,
  type ProgressHubOptions,
  type ProgressSubscriber,
} from "./hub";
export { invalidateAfterProgress, invalidateAfterTerminalProgress } from "./invalidation";
export { progressHubFor, useProgressStream, type UseProgressStreamOptions } from "./react";

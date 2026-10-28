import type { IngestRoutes } from "@narriflow/api/types/ingest";
import { type RpcTransport, createRpcClient } from "../rpc";

/** Typed client for the ingest routes. Pass a bound transport (`runtime.transport.scoped(scope)`). */
export function createIngestClient(transport: RpcTransport) {
  return createRpcClient<IngestRoutes>(transport);
}

export type IngestClient = ReturnType<typeof createIngestClient>;

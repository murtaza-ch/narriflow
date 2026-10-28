import type { RecipesRoutes } from "@narriflow/api/types/recipes";
import { type RpcTransport, createRpcClient } from "../rpc";

export type { RecipesRoutes };

/** Typed client for the recipes routes. Pass a bound transport (`runtime.transport.scoped(scope)`). */
export function createRecipesClient(transport: RpcTransport) {
  return createRpcClient<RecipesRoutes>(transport);
}

export type RecipesClient = ReturnType<typeof createRecipesClient>;

import type { ReviewsRoutes } from "@narriflow/api/types/reviews";
import { type RpcTransport, createRpcClient } from "../rpc";

export type { ReviewsRoutes };

/** Typed client for the reviews routes. Pass a bound transport (`runtime.transport.scoped(scope)`). */
export function createReviewsClient(transport: RpcTransport) {
  return createRpcClient<ReviewsRoutes>(transport);
}

export type ReviewsClient = ReturnType<typeof createReviewsClient>;

export { createGuestReviewsClient } from "./guest";
export { reviewQueries } from "./queries";
export { invalidateReviewMutation, invalidateGuestReviewMutation, reviewMutationOptions } from "./mutations";

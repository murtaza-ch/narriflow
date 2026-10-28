import { reviewNotificationService, reviewService } from "@narriflow/services";
import type { ApiConfig } from "../../config";
import type { ReviewsRouteDeps } from "./routes";

/** Production wiring of the reviews routes. */
export function createReviewsRouteDeps(_config: ApiConfig): ReviewsRouteDeps {
  return { reviewService, reviewNotificationService };
}

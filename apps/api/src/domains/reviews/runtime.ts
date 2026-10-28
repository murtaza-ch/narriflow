import { checkRateLimit, clipExportService, reviewerOptOut, reviewService, reviewsCommands, ReviewServiceError } from "@narriflow/services";
import type { ApiConfig } from "../../config";
import { trustedIngressIp } from "../../http/limits";
import { socketAddress } from "../../server-hooks";
import type { ReviewsRouteDeps } from "./routes";
export function createReviewsRouteDeps(config: ApiConfig): ReviewsRouteDeps {
  return {
    reviewService, commands: reviewsCommands, optOut: reviewerOptOut,
    sharedExport: (token) => clipExportService.getShared(token),
    sessionSecret() {
      const secret = process.env.REVIEW_SESSION_SECRET?.trim();
      if (!secret || secret.length < 32) throw new ReviewServiceError("review_session_configuration_invalid", "Review session secret is not configured");
      return secret;
    },
    allowedOrigins: config.corsAllowedOrigins,
    clientIp: (c) => trustedIngressIp(c.req.raw.headers, { trustedHeader: config.trustedClientIpHeader, socketAddress: socketAddress(c) }),
    rateLimit: ({ key, limit, windowSeconds }) => checkRateLimit(key, limit, windowSeconds),
  };
}

import type { AdmissionTable } from "../platform/admission-table";

/** Admission of the reviews routes, keyed by `METHOD /path` under `/api`. */
export const reviewsAdmission = {
  "POST /projects/:id/review-rounds": { kind: "project", deferRateRefusal: true, capability: "review.manage", projectParam: "id", rate: { scope: "actor", prefix: "review-round", limit: 20, windowSeconds: 3600 } },
  "GET /projects/:id/review-rounds": { kind: "project", capability: "content.view", projectParam: "id" },
  "POST /projects/:id/review-rounds/:roundId/invite": { kind: "project", deferRateRefusal: true, capability: "review.manage", projectParam: "id", rate: { scope: "actor", prefix: "review-invite", limit: 20, windowSeconds: 3600 } },
  "POST /projects/:id/review-rounds/:roundId/comments": { kind: "project", deferRateRefusal: true, capability: "review.manage", projectParam: "id", rate: { scope: "actor", prefix: "review-comment-internal", limit: 60 } },
  "POST /projects/:id/review-rounds/:roundId/comments/:commentId/resolve": { kind: "project", deferRateRefusal: true, capability: "review.manage", projectParam: "id" },
  "POST /projects/:id/review-rounds/:roundId/comments/:commentId/reopen": { kind: "project", deferRateRefusal: true, capability: "review.manage", projectParam: "id" },
  "POST /projects/:id/review-rounds/:roundId/notifications/retry": { kind: "project", deferRateRefusal: true, capability: "review.manage", projectParam: "id", rate: { scope: "actor", prefix: "review-notification-retry", limit: 20, windowSeconds: 3600 } },
  "POST /projects/:id/review-rounds/:roundId/revoke": { kind: "project", deferRateRefusal: true, capability: "review.manage", projectParam: "id" },
  "GET /review/opt-out": { trust: "signed_opt_out_token" },
  "POST /review/opt-out": { trust: "signed_opt_out_token" },
  "GET /share/:token": { trust: "public_share_token" },
  "POST /review/:token": { trust: "signed_review_token" },
  "POST /review/:token/access": { trust: "signed_review_token" },
  "GET /review/:token": { trust: "signed_review_token" },
  "POST /review/:token/comments": { trust: "signed_review_token" },
  "POST /review/:token/decision": { trust: "signed_review_token" },
  "PATCH /review/:token/comments/:commentId": { trust: "signed_review_token" },
  "DELETE /review/:token/comments/:commentId": { trust: "signed_review_token" },
  "GET /review/:token/media/:itemId/:variantId": { trust: "signed_review_token" },
  "GET /review/:token/download/:itemId/:variantId": { trust: "signed_review_token" },
} as const satisfies AdmissionTable;

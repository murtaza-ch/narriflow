import type { AdmissionTable } from "../platform/admission-table";

/** Admission of the reviews routes, keyed by `METHOD /path` under `/api`. */
export const reviewsAdmission = {
  "POST /projects/:id/review-rounds": { kind: "project", capability: "review.manage", projectParam: "id", rate: { scope: "actor", prefix: "review-round", limit: 20, windowSeconds: 3600 } },
  "GET /projects/:id/review-rounds": { kind: "project", capability: "content.view", projectParam: "id" },
  "POST /projects/:id/review-rounds/:roundId/invite": { kind: "project", capability: "review.manage", projectParam: "id", rate: { scope: "actor", prefix: "review-invite", limit: 20, windowSeconds: 3600 } },
  "POST /projects/:id/review-rounds/:roundId/comments": { kind: "project", capability: "review.manage", projectParam: "id", rate: { scope: "actor", prefix: "review-comment-internal", limit: 60 } },
  "POST /projects/:id/review-rounds/:roundId/comments/:commentId/resolve": { kind: "project", capability: "review.manage", projectParam: "id" },
  "POST /projects/:id/review-rounds/:roundId/comments/:commentId/reopen": { kind: "project", capability: "review.manage", projectParam: "id" },
  "POST /projects/:id/review-rounds/:roundId/notifications/retry": { kind: "project", capability: "review.manage", projectParam: "id", rate: { scope: "actor", prefix: "review-notification-retry", limit: 20, windowSeconds: 3600 } },
  "POST /projects/:id/review-rounds/:roundId/revoke": { kind: "project", capability: "review.manage", projectParam: "id" },
} as const satisfies AdmissionTable;

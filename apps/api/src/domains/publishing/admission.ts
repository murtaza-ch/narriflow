import type { AdmissionTable } from "../platform/admission-table";

/** Admission of the publishing routes, keyed by `METHOD /path` under `/api`. */
export const publishingAdmission = {
  "POST /webhooks/tiktok/publication": { trust: "provider_signature" },
  "POST /projects/:id/assisted-copy/generations": { kind: "project", capability: "publishing.manage", projectParam: "id", rate: { scope: "actor", prefix: "assisted-copy", limit: 30 } },

  // Social accounts and OAuth. The callback is provider navigation: it carries no session, only the stored one-use state.
  // Members see connected accounts (the settings page and queue aggregates already show them to content.view).
  "GET /social/accounts": { kind: "workspace", capability: "content.view" },
  "POST /social/oauth/start/:platform": { kind: "workspace", capability: "social.manage" },
  "GET /social/oauth/callback": { trust: "oauth_state" },
  "GET /social/oauth/facebook-selection/:token": { kind: "workspace", capability: "social.manage" },
  "POST /social/oauth/facebook-selection/:token": { kind: "workspace", capability: "social.manage", rate: { scope: "actor", prefix: "facebook-page-selection", limit: 10, windowSeconds: 900 } },
  "DELETE /social/accounts/:accountId": { kind: "workspace", capability: "social.manage" },
  "GET /social/accounts/:accountId/posting-schedule": { kind: "workspace", capability: "content.view" },
  "PUT /social/accounts/:accountId/posting-schedule": { kind: "workspace", capability: "publishing.manage" },
  "GET /social/accounts/:accountId/tiktok-options": { kind: "workspace", capability: "publishing.manage", rate: { scope: "actor", prefix: "publishing-options", limit: 30 } },

  // Queue proposals. Proposing is a receipt-backed create, so its limiter outcome is enforced only after the receipt lookup.
  "POST /social/proposals": { kind: "workspace", capability: "publishing.manage", deferRateRefusal: true },
  "POST /social/proposals/accept-all": { kind: "workspace", capability: "publishing.manage" },
  "PATCH /social/proposals/:proposalId": { kind: "workspace", capability: "publishing.manage" },
  "POST /social/proposals/:proposalId/reject": { kind: "workspace", capability: "publishing.manage" },
  "POST /social/proposals/:proposalId/accept": { kind: "workspace", capability: "publishing.manage" },

  // Screen aggregates and reads.
  "GET /publishing/calendar": { kind: "workspace", capability: "content.view" },
  "GET /publishing/queue": { kind: "workspace", capability: "content.view" },
  "GET /publishing/proposals": { kind: "workspace", capability: "content.view" },
  "GET /publishing/proposals/count": { kind: "workspace", capability: "content.view" },
  "GET /workspace/calendar/posts": { kind: "workspace", capability: "content.view" },
  "GET /workspace/calendar/filters": { kind: "workspace", capability: "content.view" },
  "GET /workspace/calendar/composer-options": { kind: "workspace", capability: "publishing.manage" },
  "GET /performance/what-worked": { kind: "workspace", capability: "content.view" },
  "GET /performance/guidance": { kind: "workspace", capability: "content.view" },

  // Project publishing.
  "POST /projects/:id/campaign-operations/schedule/preview": { kind: "project", capability: "publishing.manage", projectParam: "id", rate: { scope: "actor", prefix: "publishing-preview", limit: 60 } },
  "POST /projects/:id/campaign-operations/schedule": { kind: "project", capability: "publishing.manage", projectParam: "id", rate: { scope: "actor", prefix: "campaign-schedule", limit: 20, windowSeconds: 3600 } },
  "GET /projects/:id/social-accounts/:accountId/publishing-options": { kind: "project", capability: "content.view", projectParam: "id", rate: { scope: "actor", prefix: "publishing-options", limit: 30 } },
  "POST /projects/:id/social-posts/:postId/refresh-inbox": { kind: "project", capability: "publishing.manage", projectParam: "id", rate: { scope: "actor", prefix: "refresh-inbox", limit: 20 } },
  "GET /projects/:id/social-posts": { kind: "project", capability: "content.view", projectParam: "id" },
  "DELETE /projects/:id/social-posts/:postId": { kind: "project", capability: "publishing.manage", projectParam: "id" },
  "GET /projects/:id/social-posts/:postId/publication": { kind: "project", capability: "content.view", projectParam: "id" },
  "POST /projects/:id/social-posts/:postId/recheck": { kind: "project", capability: "publishing.manage", projectParam: "id", deferRateRefusal: true },
  "POST /projects/:id/social-posts/:postId/confirm": { kind: "project", capability: "publishing.manage", projectParam: "id", deferRateRefusal: true },
  "POST /projects/:id/social-posts/:postId/publish-again": { kind: "project", capability: "publishing.manage", projectParam: "id", deferRateRefusal: true },
} as const satisfies AdmissionTable;

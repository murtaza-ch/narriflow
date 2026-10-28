import type { AdmissionTable } from "../platform/admission-table";

/** Admission of the publishing routes, keyed by `METHOD /path` under `/api`. */
export const publishingAdmission = {
  "POST /webhooks/tiktok/publication": { trust: "provider_signature" },
  "POST /projects/:id/assisted-copy/generations": { kind: "project", capability: "publishing.manage", projectParam: "id", rate: { scope: "actor", prefix: "assisted-copy", limit: 30 } },
  "GET /social/accounts": { kind: "workspace", capability: "social.manage" },
  "GET /social/oauth/start/:platform": { kind: "workspace", capability: "social.manage" },
  "GET /social/oauth/callback": { trust: "oauth_state" },
  "GET /social/oauth/facebook-selection/:token": { kind: "workspace", capability: "social.manage" },
  "POST /social/oauth/facebook-selection/:token": { kind: "workspace", capability: "social.manage", rate: { scope: "actor", prefix: "facebook-page-selection", limit: 10, windowSeconds: 900 } },
  "DELETE /social/accounts/:accountId": { kind: "workspace", capability: "social.manage" },
} as const satisfies AdmissionTable;

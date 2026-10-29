import type { AdmissionTable } from "../platform/admission-table";

/** Admission of the developer routes, keyed by `METHOD /path` under `/api`. */
export const developerAdmission = {
  // Integrations overview. Anyone who can view the Workspace reads it; the key and
  // signing facts inside it are read only for a member who can also manage the API.
  "GET /integrations": { kind: "workspace", capability: "content.view" },

  // Developer access. Every read and write holds api.manage; the handlers add the plan's
  // `integrations.api` where the old actions did.
  "GET /developer/settings": { kind: "workspace", capability: "api.manage" },
  "GET /workspace/api-keys": { kind: "workspace", capability: "api.manage" },
  // Creating a key, rotating the signing secret, registering a webhook and testing one are receipt-backed:
  // the limiter outcome is recorded here and enforced only after the immutable replay lookup.
  "POST /workspace/api-keys": { kind: "workspace", capability: "api.manage", deferRateRefusal: true },
  "DELETE /workspace/api-keys/:keyId": { kind: "workspace", capability: "api.manage" },
  "GET /workspace/callback-signing-secret": { kind: "workspace", capability: "api.manage" },
  "POST /workspace/callback-signing-secret/rotate": { kind: "workspace", capability: "api.manage", deferRateRefusal: true },
  "GET /workspace/webhooks": { kind: "workspace", capability: "api.manage" },
  "POST /workspace/webhooks": { kind: "workspace", capability: "api.manage", deferRateRefusal: true },
  "DELETE /workspace/webhooks/:webhookId": { kind: "workspace", capability: "api.manage" },
  "POST /workspace/webhooks/:webhookId/enable": { kind: "workspace", capability: "api.manage" },
  // A test send is retry-safe: the endpoint's answer is recorded under the caller's key.
  "POST /workspace/webhooks/:webhookId/test": { kind: "workspace", capability: "api.manage", deferRateRefusal: true },
} as const satisfies AdmissionTable;

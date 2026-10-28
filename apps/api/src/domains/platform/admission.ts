import type { AdmissionTable } from "./admission-table";

/** Platform routes: liveness, readiness and the Clerk delivery adapter. */
export const platformAdmission = {
  "GET /health": { trust: "public_health" },
  "GET /ready": { trust: "public_health" },
  "POST /webhooks/clerk": { trust: "provider_signature" },
} as const satisfies AdmissionTable;

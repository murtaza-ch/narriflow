import type { AdmissionTable } from "./admission-table";

/** Platform routes: liveness, readiness and the Clerk delivery adapter and browser CSP reports. */
export const platformAdmission = {
  "GET /health": { trust: "public_health" },
  "GET /ready": { trust: "public_health" },
  "POST /webhooks/clerk": { trust: "provider_signature" },
  "POST /csp-report": { trust: "public_browser_report" },
} as const satisfies AdmissionTable;

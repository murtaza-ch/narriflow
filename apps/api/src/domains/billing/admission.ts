import type { AdmissionTable } from "../platform/admission-table";

/**
 * Admission of the billing routes, keyed by `METHOD /path` under `/api`.
 * Checkout, portal and plan changes need `billing.manage`; reading the state
 * needs only `content.view`, so a restricted Workspace's members still see why.
 * Retries are identified by the native keys in the body (`clientIdempotencyKey`,
 * `quoteId`, `checkoutIdempotencyKey`), not by an `Idempotency-Key` header. The one
 * exception is creating the New Workspace, a receipt-backed command that takes the
 * header key and defers its limiter until replay lookup has run.
 */
export const billingAdmission = {
  "POST /webhooks/stripe": { trust: "provider_signature" },
  "POST /workspaces/business-checkout": { kind: "signed_in", deferRateRefusal: true },
  "POST /billing/checkout": { kind: "workspace", capability: "billing.manage" },
  "POST /billing/checkout/return": { kind: "workspace", capability: "billing.manage" },
  "POST /billing/portal": { kind: "workspace", capability: "billing.manage" },
  "GET /billing/state": { kind: "workspace", capability: "content.view" },
  "POST /billing/plan-change/preview": { kind: "workspace", capability: "billing.manage" },
  "POST /billing/plan-change/confirm": { kind: "workspace", capability: "billing.manage" },
  "POST /billing/plan-change/payment": { kind: "workspace", capability: "billing.manage" },
  "POST /billing/plan-change/cancel": { kind: "workspace", capability: "billing.manage" },
  "POST /billing/reconcile": { kind: "workspace", capability: "billing.manage" },
} as const satisfies AdmissionTable;

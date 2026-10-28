import { createRouteApp } from "../../http/admission";
import { billingAdmission } from "./admission";

/** Dependencies of the billing routes. The owning ticket replaces this with the services it calls. */
export type BillingRouteDeps = Record<string, never>;

/** Workspace billing controls and the new-Workspace checkout. */
export function createBillingRoutes(_deps: BillingRouteDeps) {
  return createRouteApp(billingAdmission);
}

export type BillingRoutes = ReturnType<typeof createBillingRoutes>;

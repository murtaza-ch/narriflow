import { Hono } from "hono";
import type { ApiEnv } from "../../http/env";

/** Dependencies of the billing routes. The owning ticket replaces this with the services it calls. */
export type BillingRouteDeps = Record<string, never>;

/** Workspace billing controls and the new-Workspace checkout. */
export function createBillingRoutes(_deps: BillingRouteDeps) {
  return new Hono<ApiEnv>();
}

export type BillingRoutes = ReturnType<typeof createBillingRoutes>;

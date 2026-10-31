import { getPrismaClient } from "@narriflow/db/client";
import { billingService } from "./billing.service";
import { createBillingReconciliation } from "./billing-reconciliation";
import { deliverExecutionDispatches } from "./execution-dispatch-runtime";
import { readServiceEnvironment } from "./runtime-environment";

export function getBillingReconciliation() {
  const database = getPrismaClient();
  if (!database) throw new Error("Billing reconciliation requires a database scope");
  return createBillingReconciliation({ database, leaseMs: Number(readServiceEnvironment().WORKSPACE_BILLING_LEASE_MS ?? 60_000),
    register: deliverExecutionDispatches, reconcile: claim => billingService.reconcileClaim(claim) });
}

import { createDatabaseScope, withDatabaseScope } from "@narriflow/db/client";
import { BillingError, billingService } from "../src/billing.service";
import { parseWorkspaceBillingOperatorArgs } from "../src/workspace-billing-operator";

function write(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

try {
  const connectionString = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error("Database connection is required");
  await withDatabaseScope(createDatabaseScope({ connectionString }), async () => {
  const input = parseWorkspaceBillingOperatorArgs(process.argv.slice(2));
  billingService.validateConfiguration({ surface: "operator" });
  const before = await billingService.inspectAccount(input.workspaceId);
  if (!input.reconcile) {
    write({ mode: "inspect", inspection: before });
  } else {
    const reconciliation = await billingService.reconcileCurrentState(
      input.workspaceId,
    );
    const after = await billingService.inspectAccount(input.workspaceId);
    write({
      mode: "reconcile",
      outcome: reconciliation.kind,
      before,
      after,
    });
  }
  });
} catch (error) {
  write({
    mode: "failed",
    error: error instanceof BillingError ? error.code : "operator_command_failed",
  });
  process.exitCode = 1;
}

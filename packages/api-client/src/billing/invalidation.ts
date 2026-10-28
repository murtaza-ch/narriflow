import type { QueryClient } from "@tanstack/query-core";
import {
  invalidateScoped,
  invalidateSession,
  type WorkspaceScope,
} from "../core";

/**
 * After an observed change in provider-verified billing state (a settled
 * reconcile, a confirmed plan change), everything that depends on the plan:
 * the billing state itself, the Workspace bootstrap and usage (allowance,
 * entitlements, seat billing) and the identity memberships (tier chips).
 * Navigating back from Checkout proves nothing, so callers do not run this
 * for the return itself, only for a state that was read from the provider.
 * Pass `includeState: false` when the billing state was just set from that read.
 */
export async function invalidateBillingDependents(
  queryClient: QueryClient,
  scope: WorkspaceScope,
  options: { includeState?: boolean } = {},
): Promise<void> {
  await Promise.all([
    options.includeState === false
      ? Promise.resolve()
      : invalidateScoped(queryClient, scope, "billing"),
    invalidateScoped(queryClient, scope, "workspace"),
    invalidateSession(queryClient, scope, "bootstrap"),
  ]);
}

import type { QueryClient } from "@tanstack/query-core";
import { invalidateBrand } from "../brand/queries";
import {
  invalidateScoped,
  invalidateSession,
  type WorkspaceScope,
} from "../core";
import { PROJECT_RESOURCES } from "../projects/queries";

/**
 * After an observed change in provider-verified billing state (a settled
 * reconcile, a confirmed plan change), everything that depends on the plan:
 * the billing state itself, the Workspace bootstrap and usage (allowance,
 * entitlements, seat billing), the identity memberships (tier chips), and the
 * aggregates that gate by plan: Brand Kit, Recipes, intake configuration and the
 * Studio's retained assets (all via `invalidateBrand`), Project detail/snapshot
 * tabs, and Autopilot. The Studio's working document stays with its Editing
 * Session; its bootstrap is never invalidated here.
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
    invalidateBrand(queryClient, scope),
    invalidateScoped(queryClient, scope, "projects", PROJECT_RESOURCES.detail),
    invalidateScoped(queryClient, scope, "projects", PROJECT_RESOURCES.snapshot),
    invalidateScoped(queryClient, scope, "projects", PROJECT_RESOURCES.dubsAllowance),
    invalidateScoped(queryClient, scope, "automation", "overview"),
  ]);
}

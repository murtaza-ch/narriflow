import type { PricingTier } from "@narriflow/validators";
import { hasFeature } from "./plan-features";

// The billing side of watermark clearance. It imports nothing from the render
// lifecycle; the billing store is handed the clearance by its production wiring.

/** Due for every committed billing state whose plan has `export.noWatermark`,
 * not only the commit that gains it. Clearance is idempotent by state (a paid
 * Workspace never keeps a marked file), so each verified commit, including the
 * periodic reconcile, retries a clearance that failed, skipped a restricted
 * Workspace, or met a render still running. */
export function watermarkClearanceDue(tier: PricingTier): boolean {
  return hasFeature(tier, "export.noWatermark");
}

/** Runs after the billing transaction has committed. It never throws, so the
 * billing result is returned whatever happens here. */
export async function clearWatermarksAfterBillingCommit(
  input: { workspaceId: string; tier: PricingTier },
  clear: (workspaceId: string) => Promise<void>,
): Promise<void> {
  if (!watermarkClearanceDue(input.tier)) return;
  try {
    await clear(input.workspaceId);
  } catch (error) {
    console.warn(JSON.stringify({
      level: "warn", message: "watermark_clearance_failed", workspaceId: input.workspaceId,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

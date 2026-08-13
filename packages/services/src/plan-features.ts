import { resolvePricingTier, type PricingTier } from "@narriflow/validators";

export type PlanFeature =
  | "export.1080p"
  | "export.noWatermark"
  | "integrations.api"
  | "integrations.mcp";

const PLAN_FEATURES: Record<PricingTier, Record<PlanFeature, boolean>> = {
  free: {
    "export.1080p": false,
    "export.noWatermark": false,
    "integrations.api": false,
    "integrations.mcp": false,
  },
  creator: {
    "export.1080p": true,
    "export.noWatermark": true,
    "integrations.api": false,
    "integrations.mcp": false,
  },
  pro: {
    "export.1080p": true,
    "export.noWatermark": true,
    "integrations.api": false,
    "integrations.mcp": false,
  },
  business: {
    "export.1080p": true,
    "export.noWatermark": true,
    "integrations.api": true,
    "integrations.mcp": true,
  },
};

/** Pure entitlement check — the one place plan gating decisions are made. */
export function hasFeature(tier: string | null | undefined, feature: PlanFeature): boolean {
  return PLAN_FEATURES[resolvePricingTier(tier)][feature];
}

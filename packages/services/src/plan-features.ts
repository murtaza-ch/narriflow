import { resolvePricingTier, type PricingTier } from "@narriflow/validators";

export type PlanFeature =
  | "export.1080p"
  | "export.noWatermark"
  | "integrations.api"
  | "integrations.mcp"
  | "brand.profiles"
  | "brand.customFonts"
  | "brand.scenes"
  | "editor.censoring"
  | "editor.motion"
  | "publishing.assistedCopy"
  | "publishing.customThumbnails"
  | "campaign.operations"
  | "export.bundles"
  | "review.rooms"
  | "generated.images"
  | "generated.video";

const PLAN_FEATURES: Record<PricingTier, Record<PlanFeature, boolean>> = {
  free: {
    "export.1080p": false,
    "export.noWatermark": false,
    "integrations.api": false,
    "integrations.mcp": false,
    "brand.profiles": false,
    "brand.customFonts": false,
    "brand.scenes": false,
    "editor.censoring": false,
    "editor.motion": false,
    "publishing.assistedCopy": false,
    "publishing.customThumbnails": false,
    "campaign.operations": false,
    "export.bundles": false,
    "review.rooms": false,
    "generated.images": true,
    "generated.video": false,
  },
  creator: {
    "export.1080p": true,
    "export.noWatermark": true,
    "integrations.api": false,
    "integrations.mcp": false,
    "brand.profiles": true,
    "brand.customFonts": true,
    "brand.scenes": true,
    "editor.censoring": true,
    "editor.motion": true,
    "publishing.assistedCopy": true,
    "publishing.customThumbnails": false,
    "campaign.operations": false,
    "export.bundles": false,
    "review.rooms": false,
    "generated.images": true,
    "generated.video": false,
  },
  pro: {
    "export.1080p": true,
    "export.noWatermark": true,
    "integrations.api": false,
    "integrations.mcp": false,
    "brand.profiles": true,
    "brand.customFonts": true,
    "brand.scenes": true,
    "editor.censoring": true,
    "editor.motion": true,
    "publishing.assistedCopy": true,
    "publishing.customThumbnails": true,
    "campaign.operations": true,
    "export.bundles": true,
    "review.rooms": false,
    "generated.images": true,
    "generated.video": true,
  },
  business: {
    "export.1080p": true,
    "export.noWatermark": true,
    "integrations.api": true,
    "integrations.mcp": true,
    "brand.profiles": true,
    "brand.customFonts": true,
    "brand.scenes": true,
    "editor.censoring": true,
    "editor.motion": true,
    "publishing.assistedCopy": true,
    "publishing.customThumbnails": true,
    "campaign.operations": true,
    "export.bundles": true,
    "review.rooms": true,
    "generated.images": true,
    "generated.video": true,
  },
};

/** Pure entitlement check — the one place plan gating decisions are made. */
export function hasFeature(tier: string | null | undefined, feature: PlanFeature): boolean {
  return PLAN_FEATURES[resolvePricingTier(tier)][feature];
}

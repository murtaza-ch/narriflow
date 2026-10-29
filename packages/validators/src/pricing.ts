import { z } from "zod";

export const pricingTierSchema = z.enum([
  "free",
  "creator",
  "pro",
  "business",
]);
export type PricingTier = z.infer<typeof pricingTierSchema>;

/** Tiers in ascending order. Used to find the lowest tier that unlocks something. */
export const PRICING_TIER_ORDER: readonly PricingTier[] = pricingTierSchema.options;

export function resolvePricingTier(value: string | null | undefined): PricingTier {
  const parsed = pricingTierSchema.safeParse(value);
  return parsed.success ? parsed.data : "free";
}

/**
 * Boolean plan features. Count-limited capabilities also have a feature here
 * (for example `dubbing`), and the catalog keeps the two consistent: a feature
 * is enabled exactly when its count limit is above zero.
 */
export const planFeatureSchema = z.enum([
  "export.1080p",
  "export.noWatermark",
  "export.bundles",
  "export.timelines",
  "integrations.api",
  "integrations.mcp",
  "brand.profiles",
  "brand.customTemplates",
  "brand.customFonts",
  "brand.scenes",
  "brand.defaultScenes",
  "brand.governance",
  "editor.censoring",
  "editor.motion",
  "content.repurposing",
  "publishing.schedule",
  "publishing.assistedCopy",
  "publishing.customThumbnails",
  "campaign.operations",
  "automation.autopilot",
  "review.rooms",
  "workspace.members",
  "generated.images",
  "dubbing",
]);
export type PlanFeature = z.infer<typeof planFeatureSchema>;

export interface PlanLimits {
  /** Credits per UTC calendar month. One credit is one started minute of source media. */
  monthlyCredits: number;
  /** Longest single source video, in seconds of source media. */
  maxSourceSeconds: number;
  /** Processing Capacity: new imports wait while this many videos are importing or processing (ADR 0012; checked at intake only). */
  processingCapacity: number;
  /** Hours a new Project is kept; `null` keeps it while the plan is paid. */
  projectRetentionHours: number | null;
  /** Active Brand Profiles in the owner scope. */
  brandProfiles: number;
  /** Active custom (non built-in) Brand Templates in the owner scope. */
  brandTemplates: number;
  /** Usable connected social destinations in the Workspace. */
  socialDestinations: number;
  /** Active Autopilot rules (RSS and Zoom combined). */
  autopilotRules: number;
  /** AI image generations: a lifetime sample on Free, a monthly count on paid plans. */
  generatedImages: { period: "lifetime" | "month"; count: number; concurrency: number };
  /** Voice-over dubs per UTC month, each up to `maxClipSeconds` long. */
  dubs: { perMonth: number; maxClipSeconds: number };
}

export interface PlanDefinition {
  tier: PricingTier;
  name: string;
  /** Integer USD cents. Informational: Stripe prices are the charging source of truth. */
  monthlyPriceCents: number;
  /** Integer USD cents billed once per year. */
  annualPriceCents: number;
  features: Readonly<Record<PlanFeature, boolean>>;
  limits: Readonly<PlanLimits>;
}

const MINUTE = 60;

const NO_FEATURES: Record<PlanFeature, boolean> = Object.fromEntries(
  planFeatureSchema.options.map((feature) => [feature, false]),
) as Record<PlanFeature, boolean>;

const CREATOR_FEATURES: Record<PlanFeature, boolean> = {
  ...NO_FEATURES,
  "export.1080p": true,
  "export.noWatermark": true,
  "brand.profiles": true,
  "brand.customTemplates": true,
  "brand.customFonts": true,
  "brand.scenes": true,
  "editor.censoring": true,
  "editor.motion": true,
  "content.repurposing": true,
  "publishing.schedule": true,
  "publishing.assistedCopy": true,
  "generated.images": true,
};

const PRO_FEATURES: Record<PlanFeature, boolean> = {
  ...CREATOR_FEATURES,
  "export.bundles": true,
  "export.timelines": true,
  "integrations.api": true,
  "integrations.mcp": true,
  "publishing.customThumbnails": true,
  "campaign.operations": true,
  "automation.autopilot": true,
  "dubbing": true,
};

const BUSINESS_FEATURES: Record<PlanFeature, boolean> = {
  ...PRO_FEATURES,
  "brand.defaultScenes": true,
  "brand.governance": true,
  "review.rooms": true,
  "workspace.members": true,
};

/**
 * The plan catalog: the single source of truth for what each tier includes.
 * Enforcement (`hasFeature`, `planLimits`) and every pricing surface read it.
 */
export const PLAN_CATALOG: Readonly<Record<PricingTier, PlanDefinition>> = {
  free: {
    tier: "free",
    name: "Free",
    monthlyPriceCents: 0,
    annualPriceCents: 0,
    features: { ...NO_FEATURES, "generated.images": true },
    limits: {
      monthlyCredits: 60,
      maxSourceSeconds: 60 * MINUTE,
      processingCapacity: 2,
      projectRetentionHours: 72,
      brandProfiles: 0,
      brandTemplates: 0,
      socialDestinations: 0,
      autopilotRules: 0,
      generatedImages: { period: "lifetime", count: 1, concurrency: 1 },
      dubs: { perMonth: 0, maxClipSeconds: 0 },
    },
  },
  creator: {
    tier: "creator",
    name: "Creator",
    monthlyPriceCents: 1500,
    annualPriceCents: 14400,
    features: CREATOR_FEATURES,
    limits: {
      monthlyCredits: 300,
      maxSourceSeconds: 120 * MINUTE,
      processingCapacity: 5,
      projectRetentionHours: null,
      brandProfiles: 1,
      brandTemplates: 3,
      socialDestinations: 3,
      autopilotRules: 0,
      generatedImages: { period: "month", count: 10, concurrency: 2 },
      dubs: { perMonth: 0, maxClipSeconds: 0 },
    },
  },
  pro: {
    tier: "pro",
    name: "Pro",
    monthlyPriceCents: 2900,
    annualPriceCents: 27600,
    features: PRO_FEATURES,
    limits: {
      monthlyCredits: 900,
      maxSourceSeconds: 180 * MINUTE,
      processingCapacity: 10,
      projectRetentionHours: null,
      brandProfiles: 4,
      brandTemplates: 10,
      socialDestinations: 6,
      autopilotRules: 3,
      generatedImages: { period: "month", count: 30, concurrency: 4 },
      dubs: { perMonth: 10, maxClipSeconds: 180 },
    },
  },
  business: {
    tier: "business",
    name: "Business",
    monthlyPriceCents: 4900,
    annualPriceCents: 46800,
    features: BUSINESS_FEATURES,
    limits: {
      monthlyCredits: 1800,
      maxSourceSeconds: 180 * MINUTE,
      processingCapacity: 20,
      projectRetentionHours: null,
      brandProfiles: 10,
      brandTemplates: 30,
      socialDestinations: 20,
      autopilotRules: 10,
      generatedImages: { period: "month", count: 60, concurrency: 4 },
      dubs: { perMonth: 30, maxClipSeconds: 180 },
    },
  },
};

/** Days a formerly paid Project stays downloadable after paid access ends. */
export const PAID_ACCESS_ENDED_GRACE_DAYS = 28;

/** Price of each additional Business Admin or Editor, in integer USD cents. Viewers are free. */
export const BUSINESS_ADDITIONAL_SEAT_PRICE_CENTS = {
  monthly: 500,
  annual: 6000,
} as const;

export function planDefinition(tier: string | null | undefined): PlanDefinition {
  return PLAN_CATALOG[resolvePricingTier(tier)];
}

/** Pure entitlement check: the one place plan feature decisions are made. */
export function hasFeature(tier: string | null | undefined, feature: PlanFeature): boolean {
  return planDefinition(tier).features[feature];
}

export function planLimits(tier: string | null | undefined): Readonly<PlanLimits> {
  return planDefinition(tier).limits;
}

/** The cheapest tier that satisfies `predicate`, or `null` when no tier does. */
export function lowestTier(predicate: (plan: PlanDefinition) => boolean): PricingTier | null {
  return PRICING_TIER_ORDER.find((tier) => predicate(PLAN_CATALOG[tier])) ?? null;
}

export function lowestTierWithFeature(feature: PlanFeature): PricingTier | null {
  return lowestTier((plan) => plan.features[feature]);
}

/** Human names for plan features, shared by refusals and upgrade prompts. */
export const PLAN_FEATURE_LABELS: Readonly<Record<PlanFeature, string>> = {
  "export.1080p": "1080p exports",
  "export.noWatermark": "Watermark-free exports",
  "export.bundles": "Export bundles",
  "export.timelines": "Editor timelines",
  "integrations.api": "The REST API",
  "integrations.mcp": "MCP integrations",
  "brand.profiles": "Brand Profiles",
  "brand.customTemplates": "Custom Brand Templates",
  "brand.customFonts": "Custom fonts",
  "brand.scenes": "Scenes",
  "brand.defaultScenes": "Default intros and outros",
  "brand.governance": "Brand approval rules",
  "editor.censoring": "Auto censor",
  "editor.motion": "Motion",
  "content.repurposing": "Content repurposing",
  "publishing.schedule": "Social publishing",
  "publishing.assistedCopy": "AI post copy",
  "publishing.customThumbnails": "Custom thumbnails",
  "campaign.operations": "Batch actions and Finishing",
  "automation.autopilot": "Autopilot",
  "review.rooms": "Client review rooms",
  "workspace.members": "Team members",
  "generated.images": "AI images",
  "dubbing": "Voice-over dubbing",
};

/** Features whose label is a singular noun phrase ("Autopilot needs…"); the rest are plural. */
const SINGULAR_FEATURE_LABELS: ReadonlySet<PlanFeature> = new Set<PlanFeature>([
  "integrations.api",
  "editor.censoring",
  "editor.motion",
  "content.repurposing",
  "publishing.schedule",
  "publishing.assistedCopy",
  "automation.autopilot",
  "dubbing",
]);

/**
 * Why `tier` can't use `feature`, or `null` when it can. Server pages use it to
 * disable an action before the user starts; services throw the same message.
 */
export function planFeatureRequirement(
  tier: string | null | undefined,
  feature: PlanFeature,
): { requiredTier: PricingTier | null; message: string } | null {
  if (hasFeature(tier, feature)) return null;
  const requiredTier = lowestTierWithFeature(feature);
  return {
    requiredTier,
    message: requiredTier
      ? `${PLAN_FEATURE_LABELS[feature]} ${SINGULAR_FEATURE_LABELS.has(feature) ? "needs" : "need"} the ${PLAN_CATALOG[requiredTier].name} plan.`
      : `${PLAN_FEATURE_LABELS[feature]} is not available on any plan.`,
  };
}

export type BrandPlanRequirement = { requiredTier: PricingTier | null; message: string };

/**
 * Why this Workspace's plan can't use a branding `feature`, or `null` when it
 * can. Branding in a collaborative Workspace is part of team collaboration, so
 * there the plan needs the feature and `workspace.members`. The service refusal
 * and every upgrade prompt read this one policy, so an offered tier always
 * unlocks the action.
 */
export function brandPlanRequirement(
  scope: { pricingTier: string | null | undefined; isPersonalWorkspace: boolean },
  feature: PlanFeature,
): BrandPlanRequirement | null {
  if (scope.isPersonalWorkspace) return planFeatureRequirement(scope.pricingTier, feature);
  if (hasFeature(scope.pricingTier, feature) && hasFeature(scope.pricingTier, "workspace.members")) {
    return null;
  }
  const requiredTier = lowestTier((plan) => plan.features[feature] && plan.features["workspace.members"]);
  return {
    requiredTier,
    message: requiredTier
      ? `Branding in a shared Workspace needs the ${PLAN_CATALOG[requiredTier].name} plan.`
      : "Branding in a shared Workspace is not available on any plan.",
  };
}

/** Count limits enforced when an object is created or activated. */
export type PlanCountLimit =
  | "brandProfiles"
  | "brandTemplates"
  | "socialDestinations"
  | "autopilotRules";

const PLAN_COUNT_LIMIT_LABELS: Readonly<Record<PlanCountLimit, string>> = {
  brandProfiles: "Brand Profiles",
  brandTemplates: "custom Brand Templates",
  socialDestinations: "connected social accounts",
  autopilotRules: "active Autopilot rules",
};

const PLAN_COUNT_LIMIT_NOUNS: Readonly<Record<PlanCountLimit, string>> = {
  brandProfiles: "Brand Profile",
  brandTemplates: "custom Brand Template",
  socialDestinations: "connected social account",
  autopilotRules: "active Autopilot rule",
};

/** Lowercase words of four or more letters, for matching a feature to its catalog line. */
function significantWords(line: string): string[] {
  return line.toLowerCase().match(/[a-z]{4,}/g) ?? [];
}

/**
 * The line an upgrade prompt leads with: what `tier` adds for the limit or
 * feature that stopped the user. Limits read "Up to 4 Brand Profiles";
 * features use the plan's own highlight line ("REST API and MCP").
 */
export function planUpgradeHighlight(tier: PricingTier, gate: PlanFeature | PlanCountLimit): string {
  if (gate in PLAN_COUNT_LIMIT_NOUNS) {
    const limit = gate as PlanCountLimit;
    return `Up to ${plural(PLAN_CATALOG[tier].limits[limit], PLAN_COUNT_LIMIT_NOUNS[limit])}`;
  }
  const label = PLAN_FEATURE_LABELS[gate as PlanFeature];
  const words = significantWords(label);
  return (
    planHighlights(tier).find(
      (line) => !line.startsWith("Everything in") && significantWords(line).some((word) => words.includes(word)),
    ) ?? label
  );
}

/**
 * Why `tier` can't add `adding` more objects when `used` exist, or `null` when
 * it can. A zero limit reads as a missing feature; a full one as a reached limit.
 */
export function planCountRequirement(
  tier: string | null | undefined,
  limit: PlanCountLimit,
  used: number,
  adding = 1,
): {
  code: "plan_feature_required" | "plan_limit_reached";
  requiredTier: PricingTier | null;
  max: number;
  message: string;
} | null {
  const max = planDefinition(tier).limits[limit];
  if (used + adding <= max) return null;
  const requiredTier = lowestTier((plan) => plan.limits[limit] >= used + adding);
  const label = PLAN_COUNT_LIMIT_LABELS[limit];
  if (max === 0) {
    return {
      code: "plan_feature_required",
      requiredTier,
      max,
      message: `${label.charAt(0).toUpperCase()}${label.slice(1)} need${requiredTier ? ` the ${PLAN_CATALOG[requiredTier].name} plan` : " a higher plan"}.`,
    };
  }
  return {
    code: "plan_limit_reached",
    requiredTier,
    max,
    message: `This plan includes ${max} ${label}.${requiredTier ? ` ${PLAN_CATALOG[requiredTier].name} includes more.` : ""}`,
  };
}

/** Credits debited for one source: every started minute counts, with a one-credit minimum. */
export function creditsForSourceSeconds(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.max(1, Math.ceil(seconds / MINUTE));
}

/** Debit seconds stored on the ledger for a source: whole credits, as multiples of 60. */
export function creditDebitSeconds(sourceSeconds: number): number {
  return creditsForSourceSeconds(sourceSeconds) * MINUTE;
}

/** The UTC calendar month that owns usage admitted at `at`. */
export function processingPeriodStart(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}

/** The start of the UTC month after `periodStart`, when credits renew. */
export function processingPeriodEnd(periodStart: Date): Date {
  return new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1, 1));
}

/** The paid tiers that map to a Stripe price. `free` has no Stripe object. */
export const paidPricingTierSchema = z.enum(["creator", "pro", "business"]);
export type PaidPricingTier = z.infer<typeof paidPricingTierSchema>;

export const billingIntervalSchema = z.enum(["monthly", "annual"]);
export type BillingInterval = z.infer<typeof billingIntervalSchema>;

export const checkoutRequestSchema = z.object({
  clientIdempotencyKey: z.uuid(),
  tier: paidPricingTierSchema,
  interval: billingIntervalSchema.default("monthly"),
}).strict();
export type CheckoutRequest = z.infer<typeof checkoutRequestSchema>;

export const checkoutReturnRequestSchema = z.object({
  sessionId: z.string().trim().min(1).max(255),
}).strict();
export type CheckoutReturnRequest = z.infer<typeof checkoutReturnRequestSchema>;

/** Whole-percent annual saving versus 12 monthly payments, rounded down so copy never overstates it. */
export function annualSavingsPercent(tier: PaidPricingTier): number {
  const plan = PLAN_CATALOG[tier];
  // Integer arithmetic: 1 - 144/180 in floating point floors to 19, not 20.
  return Math.floor(100 - (plan.annualPriceCents * 100) / (plan.monthlyPriceCents * 12) + 1e-9);
}

/** The smallest annual saving across paid plans, for "save N% or more" copy. */
export function minimumAnnualSavingsPercent(): number {
  return Math.min(...paidPricingTierSchema.options.map(annualSavingsPercent));
}

/** Formats integer USD cents as `$15` or `$12.50`. */
export function formatUsdCents(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

function formatSourceLength(seconds: number): string {
  const minutes = seconds / MINUTE;
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${minutes} minutes`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Pricing bullets per tier, derived from the catalog so copy can never drift
 * from enforcement. Each tier lists only what it adds over the tier below.
 */
export function planHighlights(tier: PricingTier): string[] {
  const plan = PLAN_CATALOG[tier];
  const { limits } = plan;
  const credits = `${limits.monthlyCredits.toLocaleString("en-US")} credits / month${tier === "business" ? ", shared" : ""}`;
  const sourceLength = `Videos up to ${formatSourceLength(limits.maxSourceSeconds)} long`;
  switch (tier) {
    case "free":
      return [
        credits,
        sourceLength,
        "Full editor, captions, and AI clip scoring",
        "720p exports with watermark",
        `Projects kept for ${(limits.projectRetentionHours ?? 0) / 24} days`,
        "1 AI image to try",
      ];
    case "creator":
      return [
        credits,
        sourceLength,
        "1080p exports, no watermark",
        `${plural(limits.brandProfiles, "Brand Profile")}, ${plural(limits.brandTemplates, "custom template")}, custom fonts`,
        "Motion, scenes, and auto censor",
        `Publish and schedule to ${plural(limits.socialDestinations, "social account")}`,
        "Blog, X, LinkedIn, and show-notes repurposing",
        `${limits.generatedImages.count} AI images / month`,
      ];
    case "pro":
      return [
        credits,
        sourceLength,
        "Everything in Creator",
        "REST API and MCP",
        `Autopilot: ${plural(limits.autopilotRules, "active rule")}`,
        `${limits.dubs.perMonth} voice-over dubs / month`,
        `${plural(limits.socialDestinations, "social account")}, bulk scheduling, custom thumbnails`,
        "Export bundles and Premiere / DaVinci timelines",
        `${plural(limits.brandProfiles, "Brand Profile")}, ${limits.generatedImages.count} AI images / month`,
      ];
    case "business":
      return [
        credits,
        "Everything in Pro",
        "Team members: Admins and Editors billed per seat, Viewers free",
        "Shared brand assets with approval rules and default intros/outros",
        "Client review rooms",
        `${plural(limits.socialDestinations, "social account")}, ${limits.dubs.perMonth} dubs / month`,
        `${plural(limits.autopilotRules, "active Autopilot rule")}`,
      ];
  }
}

export interface PlanComparisonRow {
  label: string;
  /** `true`/`false` render as a check or a dash; strings render as-is. */
  values: Record<PricingTier, string | boolean>;
}

export interface PlanComparisonGroup {
  title: string;
  rows: PlanComparisonRow[];
}

function perTier(value: (plan: PlanDefinition) => string | boolean): Record<PricingTier, string | boolean> {
  return Object.fromEntries(
    PRICING_TIER_ORDER.map((tier) => [tier, value(PLAN_CATALOG[tier])]),
  ) as Record<PricingTier, string | boolean>;
}

function countOrNo(count: number, suffix = ""): string | boolean {
  return count > 0 ? `${count.toLocaleString("en-US")}${suffix}` : false;
}

/** The full plan comparison, derived from the catalog for the pricing page. */
export function planComparison(): PlanComparisonGroup[] {
  const feature = (name: PlanFeature) => perTier((plan) => plan.features[name]);
  return [
    {
      title: "Credits and processing",
      rows: [
        { label: "Credits per month", values: perTier((plan) => plan.limits.monthlyCredits.toLocaleString("en-US")) },
        { label: "Longest video", values: perTier((plan) => formatSourceLength(plan.limits.maxSourceSeconds)) },
        { label: "Imports in progress at once", values: perTier((plan) => String(plan.limits.processingCapacity)) },
        {
          label: "Project storage",
          values: perTier((plan) =>
            plan.limits.projectRetentionHours === null
              ? "While subscribed"
              : `${plan.limits.projectRetentionHours / 24} days`,
          ),
        },
      ],
    },
    {
      title: "Editing and export",
      rows: [
        { label: "AI clips, captions, scoring, reframing", values: perTier(() => true) },
        { label: "Export quality", values: perTier((plan) => (plan.features["export.1080p"] ? "1080p" : "720p")) },
        { label: "No watermark", values: feature("export.noWatermark") },
        { label: "Motion, scenes, auto censor", values: feature("editor.motion") },
        { label: "Export bundles", values: feature("export.bundles") },
        { label: "Premiere / DaVinci timelines", values: feature("export.timelines") },
      ],
    },
    {
      title: "Brand",
      rows: [
        { label: "Brand Profiles", values: perTier((plan) => countOrNo(plan.limits.brandProfiles)) },
        { label: "Custom Brand Templates", values: perTier((plan) => countOrNo(plan.limits.brandTemplates)) },
        { label: "Custom fonts and uploaded assets", values: feature("brand.customFonts") },
        { label: "Approval rules, default intros/outros", values: feature("brand.governance") },
      ],
    },
    {
      title: "AI generation",
      rows: [
        {
          label: "AI images",
          values: perTier((plan) =>
            plan.limits.generatedImages.period === "lifetime"
              ? `${plan.limits.generatedImages.count} to try`
              : `${plan.limits.generatedImages.count} / month`,
          ),
        },
        { label: "Voice-over dubbing", values: perTier((plan) => countOrNo(plan.limits.dubs.perMonth, " / month")) },
        { label: "Blog, X, LinkedIn, show-notes repurposing", values: feature("content.repurposing") },
        { label: "AI post titles, descriptions, hashtags", values: feature("publishing.assistedCopy") },
      ],
    },
    {
      title: "Publishing and automation",
      rows: [
        { label: "Connected social accounts", values: perTier((plan) => countOrNo(plan.limits.socialDestinations)) },
        { label: "Publish and schedule", values: feature("publishing.schedule") },
        { label: "Bulk scheduling and custom thumbnails", values: feature("publishing.customThumbnails") },
        { label: "Autopilot rules (RSS, Zoom)", values: perTier((plan) => countOrNo(plan.limits.autopilotRules)) },
        { label: "Finishing recipes", values: feature("campaign.operations") },
        { label: "REST API, MCP, webhooks", values: feature("integrations.api") },
      ],
    },
    {
      title: "Team",
      rows: [
        { label: "Team members", values: feature("workspace.members") },
        { label: "Client review rooms", values: feature("review.rooms") },
      ],
    },
  ];
}

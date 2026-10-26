import { describe, expect, test } from "bun:test";
import {
  checkoutRequestSchema,
  creditDebitSeconds,
  creditsForSourceSeconds,
  hasFeature,
  lowestTierWithFeature,
  paidPricingTierSchema,
  PLAN_CATALOG,
  planFeatureSchema,
  planLimits,
  PRICING_TIER_ORDER,
  processingPeriodEnd,
  processingPeriodStart,
  resolvePricingTier,
  type PlanFeature,
  type PlanLimits,
} from ".";

const plans = PRICING_TIER_ORDER.map((tier) => PLAN_CATALOG[tier]);

describe("pricing tiers", () => {
  test("resolvePricingTier falls back to free for unknown/empty values", () => {
    expect(resolvePricingTier(null)).toBe("free");
    expect(resolvePricingTier(undefined)).toBe("free");
    expect(resolvePricingTier("enterprise")).toBe("free");
    expect(resolvePricingTier("starter")).toBe("free");
    expect(resolvePricingTier("creator")).toBe("creator");
  });

  test("unknown tiers fail closed to Free's entitlements", () => {
    expect(planLimits("enterprise")).toBe(PLAN_CATALOG.free.limits);
    for (const feature of planFeatureSchema.options)
      expect(hasFeature("starter", feature)).toBe(PLAN_CATALOG.free.features[feature]);
  });

  test("credits rise with each tier, and no other limit ever shrinks", () => {
    const numeric = (limits: PlanLimits) => [
      limits.maxSourceSeconds,
      limits.processingCapacity,
      limits.brandProfiles,
      limits.brandTemplates,
      limits.socialDestinations,
      limits.autopilotRules,
      limits.dubs.perMonth,
      limits.generatedImages.concurrency,
    ];
    for (let i = 1; i < plans.length; i += 1) {
      const lower = plans[i - 1]!;
      const higher = plans[i]!;
      expect(higher.limits.monthlyCredits).toBeGreaterThan(lower.limits.monthlyCredits);
      expect(higher.monthlyPriceCents).toBeGreaterThan(lower.monthlyPriceCents);
      const lowerValues = numeric(lower.limits);
      numeric(higher.limits).forEach((value, index) => {
        expect(value).toBeGreaterThanOrEqual(lowerValues[index]!);
      });
    }
  });

  test("each higher tier includes every feature of the tier below", () => {
    for (let i = 1; i < plans.length; i += 1)
      for (const feature of planFeatureSchema.options)
        if (plans[i - 1]!.features[feature]) expect(plans[i]!.features[feature]).toBe(true);
  });

  test("a feature is enabled exactly when its count allows something", () => {
    const counted: Array<[PlanFeature, (limits: PlanLimits) => number]> = [
      ["generated.images", (limits) => limits.generatedImages.count],
      ["dubbing", (limits) => limits.dubs.perMonth],
      ["publishing.schedule", (limits) => limits.socialDestinations],
      ["automation.autopilot", (limits) => limits.autopilotRules],
      ["brand.profiles", (limits) => limits.brandProfiles],
      ["brand.customTemplates", (limits) => limits.brandTemplates],
    ];
    for (const plan of plans)
      for (const [feature, count] of counted)
        expect([plan.tier, feature, plan.features[feature]]).toEqual([
          plan.tier,
          feature,
          count(plan.limits) > 0,
        ]);
  });

  test("dubs have a clip length whenever they are included", () => {
    for (const plan of plans)
      expect(plan.limits.dubs.maxClipSeconds > 0).toBe(plan.limits.dubs.perMonth > 0);
  });

  test("lowestTierWithFeature names the cheapest tier that includes it", () => {
    for (const feature of planFeatureSchema.options) {
      const tier = lowestTierWithFeature(feature);
      if (tier === null) {
        for (const plan of plans) expect(plan.features[feature]).toBe(false);
        continue;
      }
      expect(PLAN_CATALOG[tier].features[feature]).toBe(true);
      for (const lower of PRICING_TIER_ORDER.slice(0, PRICING_TIER_ORDER.indexOf(tier)))
        expect(PLAN_CATALOG[lower].features[feature]).toBe(false);
    }
  });
});

describe("credits", () => {
  test("each started minute of a source is one credit, with a one-credit minimum", () => {
    expect(creditsForSourceSeconds(1)).toBe(1);
    expect(creditsForSourceSeconds(59.99)).toBe(1);
    expect(creditsForSourceSeconds(60)).toBe(1);
    expect(creditsForSourceSeconds(60.01)).toBe(2);
    expect(creditsForSourceSeconds(30 * 60)).toBe(30);
  });

  test("invalid or empty durations cost nothing", () => {
    for (const seconds of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(creditsForSourceSeconds(seconds)).toBe(0);
  });

  test("ledger debits are whole credits stored as multiples of 60 seconds", () => {
    for (const seconds of [1, 59.99, 60, 60.01, 3599, 10_800]) {
      const debit = creditDebitSeconds(seconds);
      expect(debit % 60).toBe(0);
      expect(debit / 60).toBe(creditsForSourceSeconds(seconds));
      expect(debit).toBeGreaterThanOrEqual(seconds);
    }
  });

  test("credits belong to the UTC calendar month and renew on the next 1st", () => {
    const period = processingPeriodStart(new Date("2026-01-31T23:59:59.999Z"));
    expect(period.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(processingPeriodStart(new Date("2026-02-01T00:00:00.000Z")).toISOString()).toBe(
      "2026-02-01T00:00:00.000Z",
    );
    expect(processingPeriodEnd(period).toISOString()).toBe("2026-02-01T00:00:00.000Z");
    expect(processingPeriodEnd(new Date("2026-12-01T00:00:00.000Z")).toISOString()).toBe(
      "2027-01-01T00:00:00.000Z",
    );
  });
});

describe("billing", () => {
  test("checkout request defaults the interval to monthly", () => {
    const parsed = checkoutRequestSchema.parse({
      clientIdempotencyKey: "018f5f6a-4c31-7c75-9a4f-8f74f977bc10",
      tier: "creator",
    });
    expect(parsed.interval).toBe("monthly");
  });

  test("checkout request rejects the free tier (paid only)", () => {
    expect(
      checkoutRequestSchema.safeParse({
        clientIdempotencyKey: "018f5f6a-4c31-7c75-9a4f-8f74f977bc10",
        tier: "free",
      }).success,
    ).toBe(false);
  });

  test("every paid tier is priced in whole cents with an annual discount", () => {
    for (const tier of paidPricingTierSchema.options) {
      const plan = PLAN_CATALOG[tier];
      expect(Number.isSafeInteger(plan.monthlyPriceCents)).toBe(true);
      expect(Number.isSafeInteger(plan.annualPriceCents)).toBe(true);
      expect(plan.monthlyPriceCents).toBeGreaterThan(0);
      expect(plan.annualPriceCents).toBeLessThan(plan.monthlyPriceCents * 12);
    }
    expect(PLAN_CATALOG.free.monthlyPriceCents).toBe(0);
  });
});

import { describe, expect, test } from "bun:test";
import {
  checkoutRequestSchema,
  MONTHLY_PROCESSING_MINUTE_LIMITS,
  MAX_UPLOAD_LENGTH_SECONDS,
  paidPricingTierSchema,
  processingMinutesFromSeconds,
  PRICING_TABLE,
  isProcessingQuotaExceeded,
  resolvePricingTier,
} from ".";

describe("pricing tiers", () => {
  test("resolvePricingTier falls back to free for unknown/empty values", () => {
    expect(resolvePricingTier(null)).toBe("free");
    expect(resolvePricingTier(undefined)).toBe("free");
    expect(resolvePricingTier("enterprise")).toBe("free");
    expect(resolvePricingTier("creator")).toBe("creator");
    expect(resolvePricingTier("starter")).toBe("creator");
  });

  test("limits increase monotonically with tier", () => {
    const order = ["free", "creator", "pro"] as const;
    for (let i = 1; i < order.length; i += 1) {
      expect(MONTHLY_PROCESSING_MINUTE_LIMITS[order[i]!]).toBeGreaterThan(
        MONTHLY_PROCESSING_MINUTE_LIMITS[order[i - 1]!],
      );
      expect(MAX_UPLOAD_LENGTH_SECONDS[order[i]!]).toBeGreaterThanOrEqual(
        MAX_UPLOAD_LENGTH_SECONDS[order[i - 1]!],
      );
    }
  });

  test("business shares the Pro processing and upload limits", () => {
    expect(MONTHLY_PROCESSING_MINUTE_LIMITS.business).toBe(MONTHLY_PROCESSING_MINUTE_LIMITS.pro);
    expect(MAX_UPLOAD_LENGTH_SECONDS.business).toBe(MAX_UPLOAD_LENGTH_SECONDS.pro);
  });

  test("source seconds are rounded up to quota minutes", () => {
    expect(processingMinutesFromSeconds(0)).toBe(0);
    expect(processingMinutesFromSeconds(1)).toBe(1);
    expect(processingMinutesFromSeconds(60)).toBe(1);
    expect(processingMinutesFromSeconds(61)).toBe(2);
  });

  test("quota checks include requested minutes and block new work at the limit", () => {
    expect(
      isProcessingQuotaExceeded({
        usedMinutes: 55,
        requestedSeconds: 5 * 60,
        limitMinutes: 60,
      }),
    ).toBe(false);
    expect(
      isProcessingQuotaExceeded({
        usedMinutes: 55,
        requestedSeconds: 6 * 60,
        limitMinutes: 60,
      }),
    ).toBe(true);
    expect(
      isProcessingQuotaExceeded({
        usedMinutes: 60,
        limitMinutes: 60,
        blockAtLimitWithoutRequest: true,
      }),
    ).toBe(true);
  });
});

describe("billing (checkout request + pricing table)", () => {
  test("checkout request defaults the interval to monthly", () => {
    const parsed = checkoutRequestSchema.parse({
      clientIdempotencyKey: "018f5f6a-4c31-7c75-9a4f-8f74f977bc10",
      tier: "creator",
    });
    expect(parsed.interval).toBe("monthly");
  });

  test("checkout request rejects the free tier (paid only)", () => {
    expect(checkoutRequestSchema.safeParse({
      clientIdempotencyKey: "018f5f6a-4c31-7c75-9a4f-8f74f977bc10",
      tier: "free",
    }).success).toBe(false);
  });

  test("every paid tier has a pricing-table entry with an annual discount", () => {
    for (const tier of paidPricingTierSchema.options) {
      const info = PRICING_TABLE[tier];
      expect(info.monthlyUsd).toBeGreaterThan(0);
      // Annual billed yearly should beat 12x the monthly price.
      expect(info.annualUsd).toBeLessThan(info.monthlyUsd * 12);
      // Pricing-table minutes match the enforced quota.
      expect(info.minutes).toBe(MONTHLY_PROCESSING_MINUTE_LIMITS[tier]);
    }
  });
});

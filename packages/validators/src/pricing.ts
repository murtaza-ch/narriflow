import { z } from "zod";

export const pricingTierSchema = z.enum([
  "free",
  "starter",
  "creator",
  "pro",
]);
export type PricingTier = z.infer<typeof pricingTierSchema>;

/**
 * Monthly processing-minute quota per tier (1 minute = 1 minute of SOURCE
 * media). Transcription, LLM detection and FFmpeg render all scale with source
 * duration, so this is the metric that tracks true cost-to-serve. Mirrors the
 * pricing model in ROADMAP.md.
 */
export const MONTHLY_PROCESSING_MINUTE_LIMITS: Record<PricingTier, number> = {
  free: 60,
  starter: 300,
  creator: 600,
  pro: 1800,
};

/** Per-tier cap on a single upload's duration, to bound worst-case render cost. */
export const MAX_UPLOAD_LENGTH_SECONDS: Record<PricingTier, number> = {
  free: 30 * 60,
  starter: 60 * 60,
  creator: 90 * 60,
  pro: 3 * 60 * 60,
};

export function resolvePricingTier(value: string | null | undefined): PricingTier {
  const parsed = pricingTierSchema.safeParse(value);
  return parsed.success ? parsed.data : "free";
}

export function processingMinutesFromSeconds(seconds: number | null | undefined) {
  return Math.ceil(Math.max(0, seconds ?? 0) / 60);
}

export function isProcessingQuotaExceeded(input: {
  usedMinutes: number;
  requestedSeconds?: number | null;
  limitMinutes: number;
  blockAtLimitWithoutRequest?: boolean;
}) {
  const requestedMinutes = processingMinutesFromSeconds(input.requestedSeconds);
  const total = input.usedMinutes + requestedMinutes;

  if (requestedMinutes === 0 && input.blockAtLimitWithoutRequest) {
    return input.usedMinutes >= input.limitMinutes;
  }

  return total > input.limitMinutes;
}

/** The paid tiers that map to a Stripe product. `free` has no Stripe object. */
export const paidPricingTierSchema = z.enum(["starter", "creator", "pro"]);
export type PaidPricingTier = z.infer<typeof paidPricingTierSchema>;

export const billingIntervalSchema = z.enum(["monthly", "annual"]);
export type BillingInterval = z.infer<typeof billingIntervalSchema>;

export const checkoutRequestSchema = z.object({
  tier: paidPricingTierSchema,
  interval: billingIntervalSchema.default("monthly"),
});
export type CheckoutRequest = z.infer<typeof checkoutRequestSchema>;

/** Display metadata for the billing UI (prices are informational; Stripe is source of truth). */
export const PRICING_TABLE: Record<
  PaidPricingTier,
  { name: string; monthlyUsd: number; annualUsd: number; minutes: number }
> = {
  starter: { name: "Starter", monthlyUsd: 7, annualUsd: 60, minutes: 300 },
  creator: { name: "Creator", monthlyUsd: 12, annualUsd: 96, minutes: 600 },
  pro: { name: "Pro", monthlyUsd: 24, annualUsd: 192, minutes: 1800 },
};

function formatUploadLimit(tier: PricingTier): string {
  const seconds = MAX_UPLOAD_LENGTH_SECONDS[tier];
  return seconds % 3600 === 0
    ? `Uploads up to ${seconds / 3600} hour${seconds / 3600 === 1 ? "" : "s"}`
    : `Uploads up to ${seconds / 60} minutes`;
}

/**
 * Feature bullets per tier for pricing/billing UIs. Single source of truth —
 * numeric limits are derived from the quota constants above so the copy can
 * never drift from what is actually enforced.
 */
export const PRICING_FEATURES: Record<PricingTier, string[]> = {
  free: [
    `${MONTHLY_PROCESSING_MINUTE_LIMITS.free} processing minutes / month`,
    "720p exports with watermark",
    formatUploadLimit("free"),
  ],
  starter: [
    `${MONTHLY_PROCESSING_MINUTE_LIMITS.starter} processing minutes / month`,
    "1080p exports, no watermark",
    "Caption presets and brand templates",
    formatUploadLimit("starter"),
  ],
  creator: [
    `${MONTHLY_PROCESSING_MINUTE_LIMITS.creator} processing minutes / month`,
    "Everything in Starter",
    "Content-suite repurposing (blog, X, LinkedIn, show notes)",
    formatUploadLimit("creator"),
  ],
  pro: [
    `${MONTHLY_PROCESSING_MINUTE_LIMITS.pro} processing minutes / month`,
    "Everything in Creator",
    "Voiceover dubbing",
    formatUploadLimit("pro"),
  ],
};

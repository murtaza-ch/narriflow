import Stripe from "stripe";
import { getPrismaClient } from "@narriflow/db/client";
import {
  resolvePricingTier,
  type BillingInterval,
  type PaidPricingTier,
  type PricingTier,
} from "@narriflow/validators";
import { projectRetentionService } from "./project-retention.service";

export class BillingError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BillingError";
  }
}

function requirePrisma() {
  const prisma = getPrismaClient();
  if (!prisma) {
    throw new BillingError("database_unavailable", "Database client unavailable");
  }
  return prisma;
}

let stripeClient: Stripe | null = null;
function getStripe(): Stripe {
  if (stripeClient) return stripeClient;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new BillingError("stripe_not_configured", "STRIPE_SECRET_KEY is not set");
  }
  stripeClient = new Stripe(key);
  return stripeClient;
}

const PAID_TIERS: PaidPricingTier[] = ["starter", "creator", "pro"];
const INTERVALS: BillingInterval[] = ["monthly", "annual"];

/**
 * Plan-gated capabilities (vizard-parity Phase C export options). Both
 * features currently draw the same free/paid line, but they're modeled as
 * two distinct flags — not one "isPaid" bit — because they're independently
 * meaningful product decisions (a future tier could ship 1080p without
 * dropping the watermark, or vice versa) and because call sites should say
 * what they're checking, not why. All new plan-gating must go through
 * `hasFeature` — no bare `tier === "free"` checks.
 */
export type PlanFeature = "export.1080p" | "export.noWatermark";

/** Single source of truth for which tiers unlock which features. `free` gets
 *  neither; every paid tier (starter, creator, pro) gets both. */
const PLAN_FEATURES: Record<PricingTier, Record<PlanFeature, boolean>> = {
  free: {
    "export.1080p": false,
    "export.noWatermark": false,
  },
  starter: {
    "export.1080p": true,
    "export.noWatermark": true,
  },
  creator: {
    "export.1080p": true,
    "export.noWatermark": true,
  },
  pro: {
    "export.1080p": true,
    "export.noWatermark": true,
  },
};

/** Pure entitlement check — the one place plan gating decisions are made. */
export function hasFeature(tier: PricingTier, feature: PlanFeature): boolean {
  return PLAN_FEATURES[tier][feature];
}

/** Resolves the configured Stripe price id for a tier + interval (env-driven). */
function priceIdFor(
  tier: PaidPricingTier,
  interval: BillingInterval,
): string | null {
  return (
    process.env[`STRIPE_PRICE_${tier.toUpperCase()}_${interval.toUpperCase()}`] ??
    null
  );
}

/** Reverse lookup: which tier does a purchased price id belong to? */
function tierForPriceId(priceId: string): PricingTier | null {
  for (const tier of PAID_TIERS) {
    for (const interval of INTERVALS) {
      if (priceIdFor(tier, interval) === priceId) return tier;
    }
  }
  return null;
}

export class BillingService {
  /** Whether Stripe is wired up (secret key present). UI hides upgrade if not. */
  isConfigured(): boolean {
    return Boolean(process.env.STRIPE_SECRET_KEY);
  }

  /** Paid tiers that have at least one price id configured (so the UI can hide unset ones). */
  configuredTiers(): PaidPricingTier[] {
    return PAID_TIERS.filter(
      (tier) => priceIdFor(tier, "monthly") || priceIdFor(tier, "annual"),
    );
  }

  async createCheckoutSession(
    userId: string,
    tier: PaidPricingTier,
    interval: BillingInterval,
    urls: { successUrl: string; cancelUrl: string },
  ): Promise<{ url: string }> {
    const stripe = getStripe();
    const priceId = priceIdFor(tier, interval);
    if (!priceId) {
      throw new BillingError(
        "price_not_configured",
        `No Stripe price configured for ${tier}/${interval}`,
      );
    }

    const customerId = await this.ensureCustomer(userId);
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: urls.successUrl,
      cancel_url: urls.cancelUrl,
      client_reference_id: userId,
      allow_promotion_codes: true,
      subscription_data: { metadata: { userId } },
    });

    if (!session.url) {
      throw new BillingError("checkout_failed", "Stripe did not return a checkout URL");
    }
    return { url: session.url };
  }

  async createBillingPortalSession(
    userId: string,
    returnUrl: string,
  ): Promise<{ url: string }> {
    const stripe = getStripe();
    const prisma = requirePrisma();
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { stripeCustomerId: true },
    });
    if (!user?.stripeCustomerId) {
      throw new BillingError("no_customer", "No billing account yet");
    }
    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: returnUrl,
    });
    return { url: session.url };
  }

  private async ensureCustomer(userId: string): Promise<string> {
    const stripe = getStripe();
    const prisma = requirePrisma();
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { stripeCustomerId: true, primaryEmail: true },
    });
    if (!user) throw new BillingError("user_not_found", "User not found");
    if (user.stripeCustomerId) return user.stripeCustomerId;

    const customer = await stripe.customers.create({
      email: user.primaryEmail ?? undefined,
      metadata: { userId },
    });
    await prisma.user.update({
      where: { id: userId },
      data: { stripeCustomerId: customer.id },
    });
    return customer.id;
  }

  /** Verifies + processes a Stripe webhook, keeping User.pricingTier in sync. */
  async handleWebhook(
    rawBody: string,
    signature: string,
  ): Promise<{ received: true }> {
    const stripe = getStripe();
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) {
      throw new BillingError("webhook_not_configured", "STRIPE_WEBHOOK_SECRET is not set");
    }

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, secret);
    } catch {
      throw new BillingError(
        "invalid_signature",
        "Stripe webhook signature verification failed",
      );
    }

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const customerId =
          typeof session.customer === "string"
            ? session.customer
            : (session.customer?.id ?? null);
        let tier: PricingTier = "free";
        if (session.subscription) {
          const subId =
            typeof session.subscription === "string"
              ? session.subscription
              : session.subscription.id;
          const sub = await stripe.subscriptions.retrieve(subId);
          tier = this.tierForSubscription(sub) ?? tier;
        }
        await this.applyTier({
          userId: session.client_reference_id ?? null,
          customerId,
          tier,
          effectiveAt: new Date(event.created * 1000),
        });
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const customerId =
          typeof sub.customer === "string" ? sub.customer : sub.customer.id;
        const active = sub.status === "active" || sub.status === "trialing";
        const tier = active ? (this.tierForSubscription(sub) ?? "free") : "free";
        await this.applyTier({
          userId: null,
          customerId,
          tier,
          effectiveAt: new Date(event.created * 1000),
        });
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const customerId =
          typeof sub.customer === "string" ? sub.customer : sub.customer.id;
        await this.applyTier({
          userId: null,
          customerId,
          tier: "free",
          effectiveAt: new Date(event.created * 1000),
        });
        break;
      }
      default:
        break;
    }

    return { received: true };
  }

  private tierForSubscription(sub: Stripe.Subscription): PricingTier | null {
    const priceId = sub.items.data[0]?.price.id;
    return priceId ? tierForPriceId(priceId) : null;
  }

  /** Reconciles a successful Checkout return immediately. The signed Stripe
   * webhook remains authoritative and idempotent, but this closes the window
   * where a user paid before project expiry and the webhook arrived later. */
  async confirmCheckoutSession(
    userId: string,
    sessionId: string,
  ): Promise<{ tier: PricingTier }> {
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["subscription"],
    });
    if (
      session.status !== "complete" ||
      session.client_reference_id !== userId
    ) {
      throw new BillingError(
        "checkout_not_confirmed",
        "Checkout session is not complete for this account",
      );
    }
    const customerId =
      typeof session.customer === "string"
        ? session.customer
        : (session.customer?.id ?? null);
    const subscription =
      typeof session.subscription === "object" && session.subscription
        ? session.subscription
        : session.subscription
          ? await stripe.subscriptions.retrieve(session.subscription)
          : null;
    const tier = subscription
      ? (this.tierForSubscription(subscription) ?? "free")
      : "free";
    const effectiveAt = subscription
      ? new Date(subscription.created * 1000)
      : new Date();
    await this.applyTier({
      userId,
      customerId,
      tier,
      effectiveAt,
    });
    return { tier };
  }

  private async applyTier(input: {
    userId: string | null;
    customerId: string | null;
    tier: PricingTier;
    effectiveAt: Date;
  }) {
    const prisma = requirePrisma();
    const tier = resolvePricingTier(input.tier);

    await prisma.$transaction(async (tx) => {
      const user = input.userId
        ? await tx.user.findUnique({ where: { id: input.userId } })
        : input.customerId
          ? await tx.user.findUnique({
              where: { stripeCustomerId: input.customerId },
            })
          : null;
      if (!user) return;
      if (
        user.billingEventCreatedAt &&
        user.billingEventCreatedAt.getTime() > input.effectiveAt.getTime()
      ) {
        return;
      }

      await projectRetentionService.applyTierTransition(tx, {
        userId: user.id,
        previousTier: user.pricingTier,
        nextTier: tier,
        effectiveAt: input.effectiveAt,
      });
      await tx.user.update({
        where: { id: user.id },
        data: {
          pricingTier: tier,
          billingEventCreatedAt: input.effectiveAt,
          ...(input.customerId ? { stripeCustomerId: input.customerId } : {}),
        },
      });
    });
  }
}

export const billingService = new BillingService();

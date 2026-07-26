import Stripe from "stripe";
import { getPrismaClient } from "@narriflow/db/client";
import {
  resolvePricingTier,
  type BillingInterval,
  type PaidPricingTier,
  type PricingTier,
} from "@narriflow/validators";

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
        await this.applyTier({ userId: null, customerId, tier });
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const customerId =
          typeof sub.customer === "string" ? sub.customer : sub.customer.id;
        await this.applyTier({ userId: null, customerId, tier: "free" });
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

  private async applyTier(input: {
    userId: string | null;
    customerId: string | null;
    tier: PricingTier;
  }) {
    const prisma = requirePrisma();
    const tier = resolvePricingTier(input.tier);

    if (input.userId) {
      await prisma.user.update({
        where: { id: input.userId },
        data: {
          pricingTier: tier,
          ...(input.customerId ? { stripeCustomerId: input.customerId } : {}),
        },
      });
      return;
    }
    if (input.customerId) {
      await prisma.user.updateMany({
        where: { stripeCustomerId: input.customerId },
        data: { pricingTier: tier },
      });
    }
  }
}

export const billingService = new BillingService();

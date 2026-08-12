import Stripe from "stripe";
import { getPrismaClient } from "@narriflow/db/client";
import {
  resolvePricingTier,
  type BillingInterval,
  type PaidPricingTier,
  type PricingTier,
} from "@narriflow/validators";
import { projectRetentionService } from "./project-retention.service";
import { workspaceService } from "./workspace.service";

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

const PAID_TIERS: PaidPricingTier[] = ["creator", "pro", "business"];
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
 *  neither; every paid tier gets both. */
const PLAN_FEATURES: Record<PricingTier, Record<PlanFeature, boolean>> = {
  free: {
    "export.1080p": false,
    "export.noWatermark": false,
  },
  creator: {
    "export.1080p": true,
    "export.noWatermark": true,
  },
  pro: {
    "export.1080p": true,
    "export.noWatermark": true,
  },
  business: {
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

function seatPriceIdFor(interval: BillingInterval): string | null {
  return process.env[`STRIPE_PRICE_BUSINESS_SEAT_${interval.toUpperCase()}`] ?? null;
}

function intervalForPriceId(priceId: string): BillingInterval | null {
  for (const interval of INTERVALS) {
    for (const tier of PAID_TIERS) {
      if (priceIdFor(tier, interval) === priceId) return interval;
    }
  }
  return null;
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

  isCheckoutConfigured(tier: PaidPricingTier, interval: BillingInterval): boolean {
    return this.isConfigured() && Boolean(priceIdFor(tier, interval));
  }

  async createCheckoutSession(
    userId: string,
    workspaceId: string,
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

    const actor = await workspaceService.requireActor(userId, workspaceId, "billing.manage");
    const prisma = requirePrisma();
    if (tier !== "business") {
      const additionalMembers = await prisma.workspaceMember.count({
        where: { workspaceId, userId: { not: actor.workspaceOwnerUserId } },
      });
      if (additionalMembers > 0) {
        throw new BillingError(
          "members_block_downgrade",
          "Remove all non-owner members before choosing a non-Business plan.",
        );
      }
    }

    const customerId = await this.ensureCustomer(userId, workspaceId);
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: urls.successUrl,
      cancel_url: urls.cancelUrl,
      client_reference_id: workspaceId,
      allow_promotion_codes: true,
      metadata: { workspaceId, actorUserId: userId, tier },
      subscription_data: { metadata: { workspaceId, actorUserId: userId } },
    });

    if (!session.url) {
      throw new BillingError("checkout_failed", "Stripe did not return a checkout URL");
    }
    return { url: session.url };
  }

  async createBillingPortalSession(
    userId: string,
    workspaceId: string,
    returnUrl: string,
  ): Promise<{ url: string }> {
    const stripe = getStripe();
    const prisma = requirePrisma();
    await workspaceService.requireActor(userId, workspaceId, "billing.manage");
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { stripeCustomerId: true },
    });
    if (!workspace?.stripeCustomerId) {
      throw new BillingError("no_customer", "No billing account yet");
    }
    const session = await stripe.billingPortal.sessions.create({
      customer: workspace.stripeCustomerId,
      return_url: returnUrl,
    });
    return { url: session.url };
  }

  private async ensureCustomer(userId: string, workspaceId: string): Promise<string> {
    const stripe = getStripe();
    const prisma = requirePrisma();
    await workspaceService.requireActor(userId, workspaceId, "billing.manage");
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        stripeCustomerId: true,
        name: true,
        owner: { select: { primaryEmail: true } },
      },
    });
    if (!workspace) throw new BillingError("workspace_not_found", "Workspace not found");
    if (workspace.stripeCustomerId) return workspace.stripeCustomerId;

    const customer = await stripe.customers.create({
      email: workspace.owner.primaryEmail ?? undefined,
      name: workspace.name,
      metadata: { workspaceId, ownerUserId: userId },
    });
    await prisma.workspace.update({
      where: { id: workspaceId },
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
          workspaceId: session.client_reference_id ?? session.metadata?.workspaceId ?? null,
          customerId,
          tier,
          subscriptionId:
            typeof session.subscription === "string"
              ? session.subscription
              : (session.subscription?.id ?? null),
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
          workspaceId: sub.metadata.workspaceId ?? null,
          customerId,
          tier,
          subscriptionId: sub.id,
          effectiveAt: new Date(event.created * 1000),
        });
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const customerId =
          typeof sub.customer === "string" ? sub.customer : sub.customer.id;
        await this.applyTier({
          workspaceId: sub.metadata.workspaceId ?? null,
          customerId,
          tier: "free",
          subscriptionId: sub.id,
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
    for (const item of sub.items.data) {
      const tier = tierForPriceId(item.price.id);
      if (tier) return tier;
    }
    return null;
  }

  async setWorkspaceSeatQuantity(
    workspaceId: string,
    quantity: number,
    idempotencyKey: string,
  ): Promise<void> {
    const prisma = requirePrisma();
    const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
    if (!workspace || workspace.pricingTier !== "business" || workspace.status !== "active") {
      throw new BillingError("business_required", "Active Business subscription required for paid seats");
    }
    if (!workspace.stripeSubscriptionId) {
      throw new BillingError("subscription_missing", "Business subscription is not synchronized yet");
    }
    const stripe = getStripe();
    const interval = workspace.billingInterval === "annual" ? "annual" : "monthly";
    const priceId = seatPriceIdFor(interval);
    if (!priceId) throw new BillingError("seat_price_not_configured", `No Business seat price configured for ${interval}`);
    const safeQuantity = Math.max(0, Math.trunc(quantity));

    if (safeQuantity === 0 && workspace.stripeSeatItemId) {
      await stripe.subscriptionItems.del(workspace.stripeSeatItemId, {}, { idempotencyKey });
      await prisma.workspace.update({ where: { id: workspaceId }, data: { stripeSeatItemId: null } });
      return;
    }
    if (safeQuantity === 0) return;

    if (workspace.stripeSeatItemId) {
      await stripe.subscriptionItems.update(
        workspace.stripeSeatItemId,
        { quantity: safeQuantity, proration_behavior: "create_prorations" },
        { idempotencyKey },
      );
      return;
    }

    const item = await stripe.subscriptionItems.create(
      {
        subscription: workspace.stripeSubscriptionId,
        price: priceId,
        quantity: safeQuantity,
        proration_behavior: "create_prorations",
      },
      { idempotencyKey },
    );
    await prisma.workspace.update({
      where: { id: workspaceId },
      data: { stripeSeatItemId: item.id },
    });
  }

  async reconcileWorkspaceSeats(workspaceId: string, reason = "reconcile") {
    const prisma = requirePrisma();
    const quantity = await prisma.workspaceMember.count({
      where: { workspaceId, role: { in: ["admin", "editor"] } },
    });
    await this.setWorkspaceSeatQuantity(
      workspaceId,
      quantity,
      `workspace-seats-${workspaceId}-${reason}-${quantity}`,
    );
    console.warn(JSON.stringify({
      level: "info",
      message: "workspace_seats_reconciled",
      workspaceId,
      quantity,
      reason,
    }));
    return quantity;
  }

  async reconcileAllWorkspaceSeats(limit = 100) {
    const prisma = requirePrisma();
    const workspaces = await prisma.workspace.findMany({
      where: {
        pricingTier: "business",
        status: "active",
        stripeSubscriptionId: { not: null },
      },
      select: { id: true },
      orderBy: { updatedAt: "asc" },
      take: Math.max(1, Math.min(500, limit)),
    });
    let reconciled = 0;
    let failed = 0;
    const hourBucket = new Date().toISOString().slice(0, 13);
    for (const workspace of workspaces) {
      try {
        await this.reconcileWorkspaceSeats(workspace.id, `scheduled-${hourBucket}`);
        reconciled += 1;
      } catch (error) {
        failed += 1;
        console.warn(JSON.stringify({
          level: "warn",
          message: "workspace_seat_reconciliation_failed",
          workspaceId: workspace.id,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    }
    return { checked: workspaces.length, reconciled, failed };
  }

  /** Reconciles a successful Checkout return immediately. The signed Stripe
   * webhook remains authoritative and idempotent, but this closes the window
   * where a user paid before project expiry and the webhook arrived later. */
  async confirmCheckoutSession(
    _userId: string,
    workspaceId: string,
    sessionId: string,
  ): Promise<{ tier: PricingTier }> {
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["subscription"],
    });
    if (
      session.status !== "complete" ||
      session.client_reference_id !== workspaceId
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
      workspaceId,
      customerId,
      tier,
      subscriptionId: subscription?.id ?? null,
      effectiveAt,
    });
    return { tier };
  }

  private async applyTier(input: {
    workspaceId: string | null;
    customerId: string | null;
    tier: PricingTier;
    subscriptionId: string | null;
    effectiveAt: Date;
  }) {
    const prisma = requirePrisma();
    const tier = resolvePricingTier(input.tier);
    const subscription = input.subscriptionId
      ? await getStripe().subscriptions.retrieve(input.subscriptionId)
      : null;
    const planItem = subscription?.items.data.find((item) => tierForPriceId(item.price.id));
    const billingInterval = planItem ? intervalForPriceId(planItem.price.id) : null;

    await prisma.$transaction(async (tx) => {
      let workspace = input.workspaceId
        ? await tx.workspace.findUnique({ where: { id: input.workspaceId } })
        : input.customerId
          ? await tx.workspace.findUnique({
              where: { stripeCustomerId: input.customerId },
            })
          : null;
      // Compatibility for checkout sessions created before workspace billing:
      // client_reference_id used to contain a User id.
      if (!workspace && input.workspaceId) {
        workspace = await tx.workspace.findUnique({
          where: { personalOwnerUserId: input.workspaceId },
        });
      }
      if (!workspace) return;
      if (
        workspace.billingEventCreatedAt &&
        workspace.billingEventCreatedAt.getTime() > input.effectiveAt.getTime()
      ) {
        return;
      }

      const restrictCancelledBusiness = workspace.pricingTier === "business" && tier === "free";
      const nextTier = restrictCancelledBusiness ? "business" : tier;
      await projectRetentionService.applyWorkspaceTierTransition(tx, {
        workspaceId: workspace.id,
        previousTier: workspace.pricingTier,
        nextTier,
        effectiveAt: input.effectiveAt,
      });
      await tx.workspace.update({
        where: { id: workspace.id },
        data: {
          pricingTier: nextTier,
          status: restrictCancelledBusiness ? "restricted" : "active",
          billingEventCreatedAt: input.effectiveAt,
          ...(input.subscriptionId ? { stripeSubscriptionId: input.subscriptionId } : {}),
          ...(billingInterval ? { billingInterval } : {}),
          ...(input.customerId ? { stripeCustomerId: input.customerId } : {}),
        },
      });

      // Dual-write the personal workspace tier while legacy entitlement reads
      // remain deployed. Collaborative workspaces never mutate User billing.
      if (workspace.personalOwnerUserId) {
        await projectRetentionService.applyTierTransition(tx, {
          userId: workspace.personalOwnerUserId,
          previousTier: workspace.pricingTier,
          nextTier,
          effectiveAt: input.effectiveAt,
        });
        await tx.user.update({
          where: { id: workspace.personalOwnerUserId },
          data: {
            pricingTier: nextTier,
            billingEventCreatedAt: input.effectiveAt,
            ...(input.customerId ? { stripeCustomerId: input.customerId } : {}),
          },
        });
      }
    });
  }
}

export const billingService = new BillingService();

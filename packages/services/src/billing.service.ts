import Stripe from "stripe";
import { getPrismaClient } from "@narriflow/db/client";
import {
  type BillingInterval,
  type PaidPricingTier,
  type PricingTier,
} from "@narriflow/validators";
export { hasFeature, type PlanFeature } from "./plan-features";
import { workspaceService } from "./workspace.service";
import {
  createBillingCatalog,
  createPrismaWorkspaceBillingStore,
  createWorkspaceBillingModule,
  type BillingCatalog,
  type ProviderCurrentState,
  type ProviderSubscription,
} from "./workspace-billing.service";

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
  stripeClient = new Stripe(key, {
    timeout: Number(
      process.env.WORKSPACE_BILLING_PROVIDER_DEADLINE_MS ?? 10_000,
    ),
    // The module owns retries and fencing. Keeping SDK retries disabled makes
    // the per-attempt provider call budget exact and observable.
    maxNetworkRetries: 0,
  });
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

function catalogFromEnvironment(): BillingCatalog {
  return createBillingCatalog({
    basePrices: PAID_TIERS.flatMap((tier) =>
      INTERVALS.map((interval) => ({
        priceId:
          priceIdFor(tier, interval) ??
          (() => {
            throw new BillingError(
              "billing_catalog_invalid",
              `Missing base price for ${tier}/${interval}`,
            );
          })(),
        tier,
        interval,
      })),
    ),
    seatPrices: INTERVALS.map((interval) => ({
      priceId:
        seatPriceIdFor(interval) ??
        (() => {
          throw new BillingError(
            "billing_catalog_invalid",
            `Missing seat price for business/${interval}`,
          );
        })(),
      interval,
    })),
    worker: {
      batchSize: Number(process.env.WORKSPACE_BILLING_BATCH_SIZE ?? 25),
      concurrency: Number(process.env.WORKSPACE_BILLING_CONCURRENCY ?? 4),
      leaseMs: Number(process.env.WORKSPACE_BILLING_LEASE_MS ?? 60_000),
      providerDeadlineMs: Number(
        process.env.WORKSPACE_BILLING_PROVIDER_DEADLINE_MS ?? 10_000,
      ),
      providerCallBudget: Number(
        process.env.WORKSPACE_BILLING_PROVIDER_CALL_BUDGET ?? 4,
      ),
    },
  });
}

export class BillingService {
  private catalog: BillingCatalog | null = null;

  /** Validate once at each process entry point, before it accepts work. */
  validateConfiguration(): void {
    if (!process.env.STRIPE_SECRET_KEY) {
      this.catalog = null;
      return;
    }
    this.catalog ??= catalogFromEnvironment();
  }

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

  private normalizeSubscription(subscription: Stripe.Subscription): ProviderSubscription {
    const periodEnds = subscription.items.data
      .map((item) => item.current_period_end)
      .filter((value) => Number.isFinite(value));
    const latestInvoice =
      subscription.latest_invoice && typeof subscription.latest_invoice === "object"
        ? subscription.latest_invoice
        : null;
    const secondsToDate = (value: number | null | undefined) =>
      value == null ? null : new Date(value * 1000);
    const periodStarts = subscription.items.data
      .map((item) => item.current_period_start)
      .filter((value) => Number.isFinite(value));
    const currentPeriodStart =
      periodStarts.length > 0 ? Math.max(...periodStarts) : subscription.created;
    const effectiveSeconds = (() => {
      switch (subscription.status) {
        case "trialing":
          return subscription.trial_start ?? subscription.created;
        case "active":
          return latestInvoice?.status_transitions.paid_at ?? currentPeriodStart;
        case "past_due":
          return latestInvoice?.due_date ?? latestInvoice?.created ?? currentPeriodStart;
        case "unpaid":
          return latestInvoice?.status_transitions.marked_uncollectible_at ??
            latestInvoice?.created ??
            currentPeriodStart;
        case "paused":
          return subscription.trial_end ?? currentPeriodStart;
        case "incomplete_expired":
          return subscription.ended_at ?? latestInvoice?.created ?? subscription.created;
        case "canceled":
          return subscription.ended_at ??
            subscription.canceled_at ??
            subscription.created;
        default:
          return latestInvoice?.created ?? subscription.created;
      }
    })();
    return {
      id: subscription.id,
      status: subscription.status,
      items: subscription.items.data.map((item) => ({
        priceId: item.price.id,
        quantity: item.quantity ?? 1,
      })),
      createdAt: new Date(subscription.created * 1000),
      effectiveAt: new Date(effectiveSeconds * 1000),
      currentPeriodEnd:
        periodEnds.length > 0 ? new Date(Math.min(...periodEnds) * 1000) : null,
      trialEnd: secondsToDate(subscription.trial_end),
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
    };
  }

  private async retrieveCurrentState(customerId: string): Promise<ProviderCurrentState> {
    const stripe = getStripe();
    let calls = 0;
    const consumeCall = () => {
      calls += 1;
      if (calls > (this.catalog?.worker.providerCallBudget ?? 0)) {
        throw new BillingError(
          "provider_call_budget_exhausted",
          "Workspace Billing provider call budget exhausted",
        );
      }
    };
    consumeCall();
    const customer = await stripe.customers.retrieve(customerId);
    if (customer.deleted) {
      throw new BillingError("customer_missing", "Billing customer no longer exists");
    }
    consumeCall();
    const subscriptions = await stripe.subscriptions.list({
      customer: customer.id,
      status: "all",
      limit: 100,
      expand: ["data.latest_invoice"],
    });
    if (subscriptions.has_more) {
      throw new BillingError(
        "subscription_collection_unbounded",
        "Billing customer has more subscriptions than the reconciliation limit",
      );
    }
    const customerWorkspaceId = customer.metadata.workspaceId?.trim() || null;
    const subscriptionWorkspaceIds = subscriptions.data.map(
      (subscription) => subscription.metadata.workspaceId?.trim() || null,
    );
    const ownership = !customerWorkspaceId || subscriptionWorkspaceIds.some((id) => !id)
      ? { kind: "missing_metadata" as const }
      : subscriptionWorkspaceIds.some((id) => id !== customerWorkspaceId)
        ? { kind: "workspace_mismatch" as const }
        : { kind: "verified" as const, workspaceId: customerWorkspaceId };
    return {
      customerId: customer.id,
      ownership,
      subscriptions: subscriptions.data.map((subscription) =>
        this.normalizeSubscription(subscription),
      ),
    };
  }

  private workspaceBillingModule() {
    this.validateConfiguration();
    const catalog = this.catalog;
    if (!catalog) {
      throw new BillingError("stripe_not_configured", "STRIPE_SECRET_KEY is not set");
    }
    return createWorkspaceBillingModule({
      catalog,
      store: createPrismaWorkspaceBillingStore(),
      provider: {
        verifyDelivery: (rawBody, signature) =>
          this.verifyStripeDelivery(rawBody, signature),
        retrieveCurrentState: (customerId) => this.retrieveCurrentState(customerId),
      },
      clock: { now: () => new Date() },
      diagnostics: {
        record: (event) => console.warn(JSON.stringify(event)),
      },
    });
  }

  reconcileCurrentState(workspaceId: string) {
    return this.workspaceBillingModule().reconcileCurrentState(workspaceId);
  }

  readBillingState(workspaceId: string) {
    return this.workspaceBillingModule().readBillingState(workspaceId);
  }

  reconcileDueAccounts() {
    return this.workspaceBillingModule().reconcileDueAccounts();
  }

  private verifyStripeDelivery(rawBody: string, signature: string) {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) {
      throw new BillingError(
        "webhook_not_configured",
        "STRIPE_WEBHOOK_SECRET is not set",
      );
    }
    let event: Stripe.Event;
    try {
      event = getStripe().webhooks.constructEvent(rawBody, signature, secret);
    } catch {
      throw new BillingError(
        "invalid_signature",
        "Stripe webhook signature verification failed",
      );
    }
    const object = event.data.object as unknown as Record<string, unknown>;
    const objectId = typeof object.id === "string" ? object.id : null;
    const relatedId = (value: unknown): string | null => {
      if (typeof value === "string") return value;
      if (
        value &&
        typeof value === "object" &&
        "id" in value &&
        typeof value.id === "string"
      ) {
        return value.id;
      }
      return null;
    };
    const metadata =
      object.metadata &&
      typeof object.metadata === "object" &&
      !Array.isArray(object.metadata)
        ? (object.metadata as Record<string, unknown>)
        : {};
    const parent =
      object.parent && typeof object.parent === "object"
        ? (object.parent as Record<string, unknown>)
        : null;
    const subscriptionDetails =
      parent?.subscription_details &&
      typeof parent.subscription_details === "object"
        ? (parent.subscription_details as Record<string, unknown>)
        : null;
    return {
      eventId: event.id,
      eventType: event.type,
      providerCreatedAt: new Date(event.created * 1000),
      liveMode: event.livemode,
      apiVersion: event.api_version ?? null,
      customerId: relatedId(object.customer) ??
        (event.type.startsWith("customer.") && !event.type.startsWith("customer.subscription")
          ? objectId
          : null),
      subscriptionId:
        event.type.startsWith("customer.subscription")
          ? objectId
          : relatedId(object.subscription) ??
            relatedId(subscriptionDetails?.subscription),
      checkoutSessionId: event.type.startsWith("checkout.session")
        ? objectId
        : null,
      workspaceHint:
        typeof metadata.workspaceId === "string"
          ? metadata.workspaceId
          : event.type.startsWith("checkout.session") &&
              typeof object.client_reference_id === "string"
            ? object.client_reference_id
            : null,
    };
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
      select: { billingAccount: { select: { providerCustomerId: true } } },
    });
    if (!workspace?.billingAccount?.providerCustomerId) {
      throw new BillingError("no_customer", "No billing account yet");
    }
    const session = await stripe.billingPortal.sessions.create({
      customer: workspace.billingAccount.providerCustomerId,
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
        billingAccount: { select: { providerCustomerId: true } },
        name: true,
        owner: { select: { primaryEmail: true } },
      },
    });
    if (!workspace) throw new BillingError("workspace_not_found", "Workspace not found");
    if (workspace.billingAccount?.providerCustomerId) {
      return workspace.billingAccount.providerCustomerId;
    }

    const customer = await stripe.customers.create({
      email: workspace.owner.primaryEmail ?? undefined,
      name: workspace.name,
      metadata: { workspaceId, ownerUserId: userId },
    });
    await prisma.workspaceBillingAccount.update({
      where: { workspaceId },
      data: { providerCustomerId: customer.id },
    });
    return customer.id;
  }

  /** Verifies and durably accepts a Stripe delivery without reconciling inline. */
  async handleWebhook(
    rawBody: string,
    signature: string,
  ) {
    const result = await this.workspaceBillingModule().acceptStripeDelivery(
      rawBody,
      signature,
    );
    return { received: true as const, disposition: result.kind };
  }

  async setWorkspaceSeatQuantity(
    workspaceId: string,
    quantity: number,
    idempotencyKey: string,
  ): Promise<void> {
    const prisma = requirePrisma();
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: { billingAccount: true },
    });
    if (!workspace || workspace.pricingTier !== "business" || workspace.status !== "active") {
      throw new BillingError("business_required", "Active Business subscription required for paid seats");
    }
    if (!workspace.billingAccount?.canonicalSubscriptionId) {
      throw new BillingError("subscription_missing", "Business subscription is not synchronized yet");
    }
    const stripe = getStripe();
    const interval = workspace.billingAccount.billingInterval === "annual" ? "annual" : "monthly";
    const priceId = seatPriceIdFor(interval);
    if (!priceId) throw new BillingError("seat_price_not_configured", `No Business seat price configured for ${interval}`);
    const safeQuantity = Math.max(0, Math.trunc(quantity));

    if (safeQuantity === 0 && workspace.billingAccount.seatItemId) {
      await stripe.subscriptionItems.del(workspace.billingAccount.seatItemId, {}, { idempotencyKey });
      await prisma.workspaceBillingAccount.update({
        where: { workspaceId },
        data: { seatItemId: null },
      });
      return;
    }
    if (safeQuantity === 0) return;

    if (workspace.billingAccount.seatItemId) {
      await stripe.subscriptionItems.update(
        workspace.billingAccount.seatItemId,
        { quantity: safeQuantity, proration_behavior: "create_prorations" },
        { idempotencyKey },
      );
      return;
    }

    const item = await stripe.subscriptionItems.create(
      {
        subscription: workspace.billingAccount.canonicalSubscriptionId,
        price: priceId,
        quantity: safeQuantity,
        proration_behavior: "create_prorations",
      },
      { idempotencyKey },
    );
    await prisma.workspaceBillingAccount.update({
      where: { workspaceId },
      data: { seatItemId: item.id },
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
        billingAccount: { canonicalSubscriptionId: { not: null } },
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
    userId: string,
    workspaceId: string,
    sessionId: string,
  ): Promise<{ tier: PricingTier }> {
    const stripe = getStripe();
    await workspaceService.requireActor(userId, workspaceId, "billing.manage");
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
    const result = await this.reconcileCurrentState(workspaceId);
    return { tier: result.view.plan };
  }
}

export const billingService = new BillingService();

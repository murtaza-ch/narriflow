import Stripe from "stripe";
import {
  type BillingInterval,
  type PaidPricingTier,
} from "@narriflow/validators";
export { hasFeature, type PlanFeature } from "./plan-features";
import {
  createBillingCatalog,
  createPrismaWorkspaceBillingStore,
  createWorkspaceBillingModule,
  type BillingCatalog,
  type ProviderCurrentState,
  type ProviderCheckoutSession,
  type ProviderSubscription,
  type WorkspaceBillingProvider,
  WorkspaceBillingError,
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

export const WORKSPACE_BILLING_STRIPE_API_VERSION = "2026-07-29.dahlia" as const;

let stripeClient: Stripe | null = null;
function getStripe(): Stripe {
  if (stripeClient) return stripeClient;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new BillingError("stripe_not_configured", "STRIPE_SECRET_KEY is not set");
  }
  stripeClient = new Stripe(key, {
    apiVersion: WORKSPACE_BILLING_STRIPE_API_VERSION,
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
  validateConfiguration(input?: { surface?: "core" | "web" | "worker" | "operator" }): void {
    if (!process.env.STRIPE_SECRET_KEY) {
      this.catalog = null;
      return;
    }
    this.catalog ??= catalogFromEnvironment();
    if (input?.surface === "web") {
      if (!process.env.STRIPE_WEBHOOK_SECRET?.startsWith("whsec_")) {
        throw new BillingError(
          "webhook_not_configured",
          "STRIPE_WEBHOOK_SECRET must be configured for the web process",
        );
      }
      if (!process.env.STRIPE_PORTAL_CONFIGURATION_ID?.startsWith("bpc_")) {
        throw new BillingError(
          "portal_not_configured",
          "STRIPE_PORTAL_CONFIGURATION_ID must be configured for the web process",
        );
      }
    }
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
        id: item.id,
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
    const subscriptions: Stripe.Subscription[] = [];
    let startingAfter: string | undefined;
    for (;;) {
      consumeCall();
      const page = await stripe.subscriptions.list({
        customer: customer.id,
        status: "all",
        limit: 100,
        expand: ["data.latest_invoice"],
        starting_after: startingAfter,
      });
      subscriptions.push(...page.data);
      if (!page.has_more) break;
      startingAfter = page.data.at(-1)?.id;
      if (!startingAfter) {
        throw new BillingError(
          "subscription_pagination_invalid",
          "Billing subscription pagination could not continue",
        );
      }
    }
    const customerWorkspaceId = customer.metadata.workspaceId?.trim() || null;
    const subscriptionWorkspaceIds = subscriptions.map(
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
      subscriptions: subscriptions.map((subscription) =>
        this.normalizeSubscription(subscription),
      ),
    };
  }

  /** Production Stripe adapter exposed for isolated sandbox contract tests. */
  stripeProviderAdapter(): WorkspaceBillingProvider {
    return {
        verifyDelivery: (rawBody, signature) =>
          this.verifyStripeDelivery(rawBody, signature),
        retrieveCurrentState: (customerId) => this.retrieveCurrentState(customerId),
        findCustomersByWorkspace: async (workspaceId) => {
          const result = await getStripe().customers.search({
            query: `metadata['workspaceId']:'${workspaceId}'`,
            limit: 10,
          });
          if (result.has_more) {
            throw new BillingError(
              "customer_collection_unbounded",
              "Customer recovery needs operator attention",
            );
          }
          return result.data
            .filter((customer) => customer.metadata.workspaceId === workspaceId)
            .map((customer) => ({ customerId: customer.id }));
        },
        createCustomer: async (input, idempotencyKey) => {
          const customer = await getStripe().customers.create(
            {
              metadata: {
                workspaceId: input.workspaceId,
                ownerUserId: input.actorUserId,
              },
            },
            { idempotencyKey },
          );
          return { customerId: customer.id };
        },
        findCheckoutSessionsByAttempt: async ({ attemptId, customerId }) => {
          const sessions = await getStripe().checkout.sessions.list({
            customer: customerId,
            limit: 100,
          });
          if (sessions.has_more) {
            throw new BillingError(
              "checkout_collection_unbounded",
              "Checkout recovery needs operator attention",
            );
          }
          return sessions.data
            .filter((session) => session.metadata?.attemptId === attemptId)
            .map((session) => this.normalizeCheckoutSession(session));
        },
        createCheckoutSession: async (input, idempotencyKey) => {
          const session = await getStripe().checkout.sessions.create(
            {
              mode: "subscription",
              customer: input.customerId,
              line_items: [{ price: input.priceId, quantity: 1 }],
              success_url: input.successUrl,
              cancel_url: input.cancelUrl,
              client_reference_id: input.workspaceId,
              allow_promotion_codes: true,
              metadata: {
                workspaceId: input.workspaceId,
                actorUserId: input.actorUserId,
                attemptId: input.attemptId,
              },
              subscription_data: {
                metadata: {
                  workspaceId: input.workspaceId,
                  actorUserId: input.actorUserId,
                  attemptId: input.attemptId,
                },
              },
            },
            { idempotencyKey },
          );
          return this.normalizeCheckoutSession(session);
        },
        retrieveCheckoutSession: async (sessionId) =>
          this.normalizeCheckoutSession(
            await getStripe().checkout.sessions.retrieve(sessionId),
          ),
        createPortalSession: async (input) => {
          const configuration = process.env.STRIPE_PORTAL_CONFIGURATION_ID;
          if (!configuration) {
            throw new BillingError(
              "portal_not_configured",
              "The billing portal is not configured",
            );
          }
          const session = await getStripe().billingPortal.sessions.create({
            customer: input.customerId,
            configuration,
            return_url: input.returnUrl,
          });
          return { url: session.url };
        },
        createSeatItem: async (input, idempotencyKey) => {
          const item = await getStripe().subscriptionItems.create(
            {
              subscription: input.subscriptionId,
              price: input.priceId,
              quantity: input.quantity,
              proration_behavior: input.prorationBehavior,
            },
            { idempotencyKey },
          );
          return { itemId: item.id };
        },
        updateSeatItem: async (input, idempotencyKey) => {
          await getStripe().subscriptionItems.update(
            input.itemId,
            {
              quantity: input.quantity,
              proration_behavior: input.prorationBehavior,
            },
            { idempotencyKey },
          );
        },
        deleteSeatItem: async (input, idempotencyKey) => {
          await getStripe().subscriptionItems.del(
            input.itemId,
            { proration_behavior: input.prorationBehavior },
            { idempotencyKey },
          );
        },
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
      provider: this.stripeProviderAdapter(),
      clock: { now: () => new Date() },
      diagnostics: {
        record: (event) => console.warn(JSON.stringify(event)),
      },
    });
  }

  private normalizeCheckoutSession(
    session: Stripe.Checkout.Session,
  ): ProviderCheckoutSession {
    return {
      sessionId: session.id,
      url: session.url,
      expiresAt: new Date(session.expires_at * 1000),
      status: session.status ?? "expired",
      paymentStatus: session.payment_status,
      workspaceId:
        session.metadata?.workspaceId ?? session.client_reference_id ?? undefined,
      attemptId: session.metadata?.attemptId ?? undefined,
    };
  }

  reconcileCurrentState(workspaceId: string) {
    return this.workspaceBillingModule().reconcileCurrentState(workspaceId);
  }

  readBillingState(workspaceId: string) {
    return this.workspaceBillingModule().readBillingState(workspaceId);
  }

  inspectAccount(workspaceId: string) {
    return this.workspaceBillingModule().inspectAccount(workspaceId);
  }

  reconcileDueAccounts() {
    return this.workspaceBillingModule().reconcileDueAccounts();
  }

  async verifyStripeDelivery(
    rawBody: string,
    signature: string,
    contract?: { stripe: Stripe; webhookSecret: string },
  ) {
    const secret = contract?.webhookSecret ?? process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) {
      throw new BillingError(
        "webhook_not_configured",
        "STRIPE_WEBHOOK_SECRET is not set",
      );
    }
    let event: Stripe.Event;
    try {
      event = await (contract?.stripe ?? getStripe()).webhooks.constructEventAsync(
        rawBody,
        signature,
        secret,
      );
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

  private async callWorkspaceBilling<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof WorkspaceBillingError) {
        throw new BillingError(error.code, error.message);
      }
      throw error;
    }
  }

  startCheckout(input: {
    userId: string;
    workspaceId: string;
    clientIdempotencyKey: string;
    tier: PaidPricingTier;
    interval: BillingInterval;
    returnDestination: string;
  }) {
    return this.callWorkspaceBilling(() =>
      this.workspaceBillingModule().startCheckout({
        workspaceId: input.workspaceId,
        actorUserId: input.userId,
        clientIdempotencyKey: input.clientIdempotencyKey,
        targetTier: input.tier,
        interval: input.interval,
        returnDestination: input.returnDestination,
      }),
    );
  }

  observeCheckoutReturn(input: {
    userId: string;
    workspaceId: string;
    sessionId: string;
  }) {
    return this.callWorkspaceBilling(() =>
      this.workspaceBillingModule().observeCheckoutReturn({
        workspaceId: input.workspaceId,
        actorUserId: input.userId,
        sessionId: input.sessionId,
      }),
    );
  }

  openPortal(input: {
    userId: string;
    workspaceId: string;
    returnUrl: string;
  }) {
    return this.callWorkspaceBilling(() =>
      this.workspaceBillingModule().openPortal({
        workspaceId: input.workspaceId,
        actorUserId: input.userId,
        returnUrl: input.returnUrl,
      }),
    );
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

}

export const billingService = new BillingService();

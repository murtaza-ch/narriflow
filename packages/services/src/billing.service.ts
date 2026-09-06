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
  type WorkspaceBillingErrorCode,
  WorkspaceBillingError,
} from "./workspace-billing.service";
import {
  ExpectedDomainFailureError,
  type ExpectedDomainFailureCatalog,
} from "./expected-domain-failure";

export type BillingErrorCode =
  | WorkspaceBillingErrorCode
  | "billing_catalog_invalid"
  | "checkout_collection_unbounded"
  | "checkout_payment_collection_unbounded"
  | "customer_collection_unbounded"
  | "customer_missing"
  | "invalid_signature"
  | "provider_call_budget_exhausted"
  | "stripe_not_configured"
  | "subscription_pagination_invalid"
  | "webhook_not_configured";

const billingFailureCatalog = {
  billing_catalog_invalid: "unavailable",
  billing_customer_missing: "conflict",
  billing_forbidden: "forbidden",
  billing_portal_required: "conflict",
  checkout_attempt_conflict: "conflict",
  checkout_attempt_invalid: "invalid",
  checkout_attempt_missing: "missing",
  checkout_attempt_terminal: "conflict",
  checkout_collection_unbounded: "unavailable",
  checkout_not_configured: "unavailable",
  checkout_payment_collection_unbounded: "unavailable",
  checkout_session_conflict: "conflict",
  customer_collection_unbounded: "unavailable",
  customer_identity_conflict: "conflict",
  customer_missing: "missing",
  invalid_signature: "forbidden",
  portal_not_configured: "unavailable",
  price_not_configured: "unavailable",
  provider_call_budget_exhausted: "unavailable",
  seat_provider_not_configured: "unavailable",
  stripe_not_configured: "unavailable",
  subscription_pagination_invalid: "unavailable",
  webhook_not_configured: "unavailable",
  workspace_not_found: "missing",
} as const satisfies ExpectedDomainFailureCatalog<BillingErrorCode>;

const billingSafeMessages: Record<BillingErrorCode, string> = {
  billing_catalog_invalid: "Billing is temporarily unavailable",
  billing_customer_missing: "No billing customer is available for this workspace",
  billing_forbidden: "Only the workspace owner can manage billing",
  billing_portal_required: "Manage the current plan in the billing portal",
  checkout_attempt_conflict: "This Checkout request was already used with different details",
  checkout_attempt_invalid: "The Checkout request is invalid",
  checkout_attempt_missing: "The Checkout request could not be found",
  checkout_attempt_terminal: "The previous Checkout is no longer available. Start a new one safely",
  checkout_collection_unbounded: "Billing is temporarily unavailable",
  checkout_not_configured: "Billing is temporarily unavailable",
  checkout_payment_collection_unbounded: "Billing is temporarily unavailable",
  checkout_session_conflict: "Checkout ownership could not be verified. Contact support",
  customer_collection_unbounded: "Billing is temporarily unavailable",
  customer_identity_conflict: "The billing account needs support before it can be changed",
  customer_missing: "The billing customer could not be found",
  invalid_signature: "The billing signature is invalid",
  portal_not_configured: "The billing portal is temporarily unavailable",
  price_not_configured: "This plan is temporarily unavailable",
  provider_call_budget_exhausted: "Billing is temporarily unavailable",
  seat_provider_not_configured: "Seat billing is temporarily unavailable",
  stripe_not_configured: "Billing is temporarily unavailable",
  subscription_pagination_invalid: "Billing is temporarily unavailable",
  webhook_not_configured: "Billing delivery is temporarily unavailable",
  workspace_not_found: "The workspace could not be found",
};

export class BillingError extends ExpectedDomainFailureError<BillingErrorCode> {
  constructor(
    code: BillingErrorCode,
    _message: string,
  ) {
    super({ code, kind: billingFailureCatalog[code], message: billingSafeMessages[code] });
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
const stripeContractAccess = Symbol("workspace-billing-stripe-contract-access");

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
  private stripeOverride: Stripe | null = null;

  private stripe() {
    return this.stripeOverride ?? getStripe();
  }

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
    const stripe = this.stripe();
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

  private stripeProviderAdapter(): WorkspaceBillingProvider {
    return {
        verifyDelivery: (rawBody, signature) =>
          this.verifyStripeDelivery(rawBody, signature),
        retrieveCurrentState: (customerId) => this.retrieveCurrentState(customerId),
        findCustomersByWorkspace: async (workspaceId) => {
          const result = await this.stripe().customers.search({
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
          const customer = await this.stripe().customers.create(
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
          const sessions = await this.stripe().checkout.sessions.list({
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
          const session = await this.stripe().checkout.sessions.create(
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
        retrieveCheckoutSession: (sessionId) =>
          this.retrieveCheckoutSession(sessionId),
        createPortalSession: async (input) => {
          const configuration = process.env.STRIPE_PORTAL_CONFIGURATION_ID;
          if (!configuration) {
            throw new BillingError(
              "portal_not_configured",
              "The billing portal is not configured",
            );
          }
          const session = await this.stripe().billingPortal.sessions.create({
            customer: input.customerId,
            configuration,
            return_url: input.returnUrl,
          });
          return { url: session.url };
        },
        createSeatItem: async (input, idempotencyKey) => {
          const item = await this.stripe().subscriptionItems.create(
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
          await this.stripe().subscriptionItems.update(
            input.itemId,
            {
              quantity: input.quantity,
              proration_behavior: input.prorationBehavior,
            },
            { idempotencyKey },
          );
        },
        deleteSeatItem: async (input, idempotencyKey) => {
          await this.stripe().subscriptionItems.del(
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
      metrics: {
        observe: (metric, value, attributes) =>
          console.warn(
            JSON.stringify({
              level: "info",
              message: "workspace_billing_metric",
              metric,
              value,
              ...attributes,
            }),
          ),
      },
    });
  }

  private normalizeCheckoutSession(
    session: Stripe.Checkout.Session,
    paymentStatus = session.payment_status,
  ): ProviderCheckoutSession {
    return {
      sessionId: session.id,
      url: session.url,
      expiresAt: new Date(session.expires_at * 1000),
      status: session.status ?? "expired",
      paymentStatus,
      workspaceId:
        session.metadata?.workspaceId ?? session.client_reference_id ?? undefined,
      attemptId: session.metadata?.attemptId ?? undefined,
    };
  }

  private async retrieveCheckoutSession(
    sessionId: string,
  ): Promise<ProviderCheckoutSession> {
    const stripe = this.stripe();
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
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["payment_intent"],
    });
    if (
      session.status !== "complete" ||
      session.payment_status !== "unpaid"
    ) {
      return this.normalizeCheckoutSession(session);
    }

    const directPaymentIntent =
      session.payment_intent && typeof session.payment_intent === "object"
        ? session.payment_intent
        : null;
    const terminalPaymentStatus = (status: string | undefined) =>
      status === "succeeded"
        ? "paid"
        : status === "requires_payment_method" || status === "canceled"
          ? "failed"
          : null;
    const directOutcome = terminalPaymentStatus(directPaymentIntent?.status);
    if (directOutcome) {
      return this.normalizeCheckoutSession(session, directOutcome);
    }

    let invoiceId =
      typeof session.invoice === "string" ? session.invoice : session.invoice?.id;
    if (!invoiceId && session.subscription) {
      const subscriptionId =
        typeof session.subscription === "string"
          ? session.subscription
          : session.subscription.id;
      consumeCall();
      const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
        expand: ["latest_invoice"],
      });
      invoiceId =
        typeof subscription.latest_invoice === "string"
          ? subscription.latest_invoice
          : subscription.latest_invoice?.id;
    }
    if (!invoiceId) return this.normalizeCheckoutSession(session);

    consumeCall();
    const payments = await stripe.invoicePayments.list({
      invoice: invoiceId,
      limit: 100,
      expand: ["data.payment.payment_intent"],
    });
    if (payments.has_more) {
      throw new BillingError(
        "checkout_payment_collection_unbounded",
        "Checkout payment recovery needs operator attention",
      );
    }
    let outcome: string | null = null;
    for (const payment of payments.data) {
      const paymentIntent =
        payment.payment.payment_intent &&
        typeof payment.payment.payment_intent === "object"
          ? payment.payment.payment_intent
          : null;
      const candidate = terminalPaymentStatus(paymentIntent?.status);
      if (candidate === "paid" || payment.status === "paid") {
        outcome = "paid";
        break;
      }
      if (candidate === "failed" || payment.status === "canceled") {
        outcome = "failed";
      }
    }
    return this.normalizeCheckoutSession(session, outcome ?? session.payment_status);
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

  private async verifyStripeDelivery(
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
      event = await (contract?.stripe ?? this.stripe()).webhooks.constructEventAsync(
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

  [stripeContractAccess]() {
    return {
      provider: (surface?: "core" | "web" | "worker" | "operator") => {
        this.validateConfiguration(surface ? { surface } : undefined);
        return this.stripeProviderAdapter();
      },
      providerWith: (input: { stripe: Stripe; catalog: BillingCatalog }) => {
        this.stripeOverride = input.stripe;
        this.catalog = input.catalog;
        return this.stripeProviderAdapter();
      },
      verifyDelivery: (
        rawBody: string,
        signature: string,
        contract: { stripe: Stripe; webhookSecret: string },
      ) => this.verifyStripeDelivery(rawBody, signature, contract),
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

/** Internal contract capability; it is not exported from the package surface. */
export function createWorkspaceBillingStripeContractHarness() {
  return new BillingService()[stripeContractAccess]();
}

export const billingService = new BillingService();

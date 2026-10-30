import {
  businessWorkspaceCheckoutResponseSchema,
  cancelBusinessWorkspaceCheckoutResponseSchema,
  type BusinessWorkspaceCheckoutRequest,
  type BusinessWorkspaceCheckoutResponse,
  planChangeQuoteSchema,
  planChangeResultSchema,
  resumeBusinessWorkspaceCheckoutResponseSchema,
} from "@narriflow/validators/api/billing";
import { workspaceBillingViewSchema } from "@narriflow/validators";
import type {
  BillingInterval,
  PaidPricingTier,
  PlanChangeQuote,
  PlanChangeResult,
  WorkspaceBillingView,
} from "@narriflow/validators";
import { ApiError, CLIENT_ERROR_CODES, IDEMPOTENCY_KEY_HEADER, type ApiTransport, type IdentityScope, type WorkspaceScope } from "../core";
import { createBillingClient } from "./client";

export type CheckoutReturnOutcome =
  | { kind: "activating"; retryAfterSeconds: number; view: WorkspaceBillingView }
  | { kind: "terminal"; reason: "expired"; view: WorkspaceBillingView };

/**
 * The Billing screen's commands, bound to one identity and Workspace. A
 * non-2xx answer throws `ApiError`; branch on its `code`. Checkout and plan
 * changes keep their native identities in the input (`clientIdempotencyKey`,
 * `quoteId`), so a retry replays the same provider operation; nothing here
 * mints or wraps a second key.
 */
export interface BillingActions {
  /** Opens Stripe Checkout for the Workspace; returns the hosted URL to navigate to. */
  startCheckout(input: {
    clientIdempotencyKey: string;
    tier: PaidPricingTier;
    interval: BillingInterval;
  }): Promise<string>;
  observeCheckoutReturn(sessionId: string, signal?: AbortSignal): Promise<CheckoutReturnOutcome>;
  /** Opens the Stripe billing portal; returns its URL. */
  openPortal(): Promise<string>;
  previewPlanChange(input: {
    clientIdempotencyKey: string;
    tier: PaidPricingTier;
    interval: BillingInterval;
  }): Promise<PlanChangeQuote>;
  confirmPlanChange(quoteId: string): Promise<PlanChangeResult>;
  cancelPlanChange(): Promise<PlanChangeResult>;
  /** The hosted invoice URL of an upgrade awaiting payment, or null when none is. */
  pendingPaymentUrl(): Promise<string | null>;
  /** Re-reads the provider-verified state. `unresolved` still carries the last known view. */
  reconcile(): Promise<{ kind: "reconciled" | "unresolved"; view: WorkspaceBillingView }>;
}

export function createBillingActions(
  transport: ApiTransport,
  scope: WorkspaceScope,
): BillingActions {
  const client = createBillingClient(transport.scoped(scope));
  const planChange = client.billing["plan-change"];

  return {
    async startCheckout(input) {
      const response = await client.billing.checkout.$post({ json: input });
      const { url } = (await response.json()) as { url: string };
      return url;
    },
    async observeCheckoutReturn(sessionId, signal) {
      const response = await client.billing.checkout.return.$post(
        { json: { sessionId } },
        { init: signal ? { signal } : {} },
      );
      const body = (await response.json()) as {
        kind: "activating" | "terminal";
        retryAfterSeconds?: number;
        reason?: "expired";
        view: unknown;
      };
      const view = workspaceBillingViewSchema.parse(body.view);
      return body.kind === "terminal"
        ? { kind: "terminal", reason: "expired", view }
        : { kind: "activating", retryAfterSeconds: body.retryAfterSeconds ?? 2, view };
    },
    async openPortal() {
      const response = await client.billing.portal.$post();
      return ((await response.json()) as { url: string }).url;
    },
    async previewPlanChange(input) {
      const response = await planChange.preview.$post({ json: input });
      return planChangeQuoteSchema.parse(((await response.json()) as { quote: unknown }).quote);
    },
    async confirmPlanChange(quoteId) {
      const response = await planChange.confirm.$post({ json: { quoteId } });
      return planChangeResultSchema.parse(await response.json());
    },
    async cancelPlanChange() {
      const response = await planChange.cancel.$post();
      return planChangeResultSchema.parse(await response.json());
    },
    async pendingPaymentUrl() {
      const response = await planChange.payment.$post();
      return ((await response.json()) as { url: string | null }).url;
    },
    async reconcile() {
      const response = await client.billing.reconcile.$post();
      const body = (await response.json()) as { kind: "reconciled" | "unresolved"; view: unknown };
      return { kind: body.kind, view: workspaceBillingViewSchema.parse(body.view) };
    },
  };
}

/** Never navigate to an address that is not Stripe's hosted Checkout. */
function unopenableCheckout(cause: unknown): ApiError {
  return new ApiError({
    code: CLIENT_ERROR_CODES.unexpectedResponse,
    message: "We couldn’t open checkout. Try again in a moment.",
    status: 0,
    cause,
  });
}

/**
 * Creates the pending Business Workspace (or resumes one awaiting payment) and
 * returns the Stripe URL plus the Workspace to select before navigating. It is
 * identity-only: the caller has no Workspace selected for it yet. Creating
 * needs the per-intent `idempotencyKey` (mint it once per form submission with
 * `createIntent`, keep it through a lost response): a retry then resumes the
 * same pending Workspace instead of creating another. A failure
 * after the Workspace exists carries `details.recovery` (see
 * `businessWorkspaceCheckoutRecoverySchema`) to resubmit against it.
 */
export async function startBusinessWorkspaceCheckout(
  transport: ApiTransport,
  scope: IdentityScope,
  input: BusinessWorkspaceCheckoutRequest,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<BusinessWorkspaceCheckoutResponse> {
  const client = createBillingClient(transport.identity(scope));
  const response = await client.workspaces["business-checkout"].$post(
    { json: input },
    { headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey }, init: signal ? { signal } : {} },
  );
  const parsed = businessWorkspaceCheckoutResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw unopenableCheckout(parsed.error);
  return parsed.data;
}

export async function cancelBusinessWorkspaceCheckout(
  transport: ApiTransport, scope: IdentityScope, workspaceId: string,
): Promise<void> {
  const client = createBillingClient(transport.identity(scope));
  const response = await client.workspaces["business-checkout"].cancel.$post({ json: { workspaceId } });
  cancelBusinessWorkspaceCheckoutResponseSchema.parse(await response.json());
}

export async function resumeBusinessWorkspaceCheckout(
  transport: ApiTransport, scope: IdentityScope, workspaceId: string,
): Promise<string> {
  const client = createBillingClient(transport.identity(scope));
  const response = await client.workspaces["business-checkout"].resume.$post({ json: { workspaceId } });
  const parsed = resumeBusinessWorkspaceCheckoutResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw unopenableCheckout(parsed.error);
  return parsed.data.checkoutUrl;
}

import { z } from "zod";
import { workspaceBillingViewSchema } from "../billing-copy";
import { billingIntervalSchema, paidPricingTierSchema } from "../pricing";

export {
  checkoutRequestSchema,
  checkoutReturnRequestSchema,
} from "../pricing";
export {
  planChangeConfirmRequestSchema,
  planChangePreviewRequestSchema,
  planChangeQuoteSchema,
  planChangeResultSchema,
} from "../billing-plan-change";
import { businessWorkspaceCheckoutActionSchema } from "../workspace-administration";

/** `POST /api/workspaces/business-checkout` body: a name to create, or a pending `workspaceId` to resume. */
export const businessWorkspaceCheckoutRequestSchema = businessWorkspaceCheckoutActionSchema;
export type BusinessWorkspaceCheckoutRequest = z.input<typeof businessWorkspaceCheckoutRequestSchema>;

/**
 * `GET /api/billing/state`: the Workspace's billing view plus the safe checkout
 * configuration the Billing screen needs, so the browser never reads Stripe
 * environment settings. `availableTiers` lists paid plans with a configured
 * price; `isConfigured` is false when Stripe is not wired up at all (the screen
 * then degrades to read-only, as before).
 */
export const billingStateResponseSchema = z.object({
  view: workspaceBillingViewSchema,
  availableTiers: z.array(paidPricingTierSchema),
  isConfigured: z.boolean(),
});
export type BillingStateResponse = z.infer<typeof billingStateResponseSchema>;

/** Stripe's hosted Checkout origin: the only place the browser navigates to pay. */
export const STRIPE_CHECKOUT_ORIGIN = "https://checkout.stripe.com";

export const stripeCheckoutUrlSchema = z.url().refine((value) => {
  try {
    return new URL(value).origin === STRIPE_CHECKOUT_ORIGIN;
  } catch {
    return false;
  }
}, "Not a Stripe Checkout address.");

/**
 * `POST /api/workspaces/business-checkout` success. `selection` is the new (or
 * recovered) pending Workspace: the browser makes it the explicit selection
 * before navigating to `checkoutUrl`. Nothing here grants an entitlement.
 */
export const businessWorkspaceCheckoutResponseSchema = z.object({
  checkoutUrl: stripeCheckoutUrlSchema,
  checkoutIdempotencyKey: z.uuid(),
  interval: billingIntervalSchema,
  selection: z.object({
    workspaceId: z.string().min(1).max(128),
    workspaceName: z.string().min(1).max(80),
  }),
});
export type BusinessWorkspaceCheckoutResponse = z.infer<
  typeof businessWorkspaceCheckoutResponseSchema
>;

/** `POST /api/workspaces/business-checkout/resume` success. */
export const resumeBusinessWorkspaceCheckoutResponseSchema = z.object({
  checkoutUrl: stripeCheckoutUrlSchema,
});

/**
 * `details.recovery` of a failed New-Workspace checkout, so
 * the form can resubmit against the Workspace that was already created with the
 * same Checkout key instead of creating another one.
 */
export const businessWorkspaceCheckoutRecoverySchema = z.object({
  workspaceId: z.string().min(1).max(128).optional(),
  workspaceName: z.string().max(80).optional(),
  interval: billingIntervalSchema.optional(),
  checkoutIdempotencyKey: z.uuid().optional(),
});
export type BusinessWorkspaceCheckoutRecovery = z.infer<
  typeof businessWorkspaceCheckoutRecoverySchema
>;

/** Identity-only cancellation, so a removed pending selection can be retried safely. */
export const cancelBusinessWorkspaceCheckoutRequestSchema = z.object({ workspaceId: z.uuid() }).strict();
export const cancelBusinessWorkspaceCheckoutResponseSchema = z.object({ canceled: z.literal(true) });

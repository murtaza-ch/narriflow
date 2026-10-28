import type { billingService } from "@narriflow/services";
import {
  businessWorkspaceCheckoutRequestSchema,
  checkoutRequestSchema,
  checkoutReturnRequestSchema,
  planChangeConfirmRequestSchema,
  planChangePreviewRequestSchema,
} from "@narriflow/validators/api/billing";
import { createRouteApp, getActor, getSignedInActor } from "../../http/admission";
import { validate } from "../../http/route";
import { billingAdmission as access } from "./admission";

type BillingService = Pick<
  typeof billingService,
  | "startCheckout"
  | "observeCheckoutReturn"
  | "openPortal"
  | "previewPlanChange"
  | "confirmPlanChange"
  | "cancelScheduledPlanChange"
  | "readPendingPlanChangePayment"
  | "readBillingState"
  | "reconcileCurrentState"
  | "startBusinessWorkspaceCheckout"
  | "configuredTiers"
  | "isConfigured"
>;

/** Services and origins the billing routes use. `runtime.ts` supplies the production values. */
export interface BillingRouteDeps {
  billingService: BillingService;
  /** Where Stripe sends people back to: always the web app, never derived from the request. */
  webOrigin: string;
}

/**
 * Workspace billing controls and the New-Workspace checkout. Stripe and the
 * Workspace Billing module own every billing decision; these handlers admit,
 * validate, call the service and serialize. A successful return or redirect
 * proves nothing about the plan: only the verified state read does.
 */
export function createBillingRoutes(deps: BillingRouteDeps) {
  const { billingService, webOrigin } = deps;
  const billingPage = `${webOrigin}/settings/billing`;

  return createRouteApp(access)
    .post(
      "/workspaces/business-checkout",
      validate("json", businessWorkspaceCheckoutRequestSchema),
      async (c) => {
        const actor = getSignedInActor(c);
        const input = c.req.valid("json");
        const result = await billingService.startBusinessWorkspaceCheckout({
          actorUserId: actor.actorUserId,
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
          interval: input.interval,
          ...(input.checkoutIdempotencyKey === undefined
            ? {}
            : { checkoutIdempotencyKey: input.checkoutIdempotencyKey }),
          returnDestination: billingPage,
        });
        return c.json(
          {
            checkoutUrl: result.checkoutUrl,
            checkoutIdempotencyKey: result.checkoutIdempotencyKey,
            interval: result.interval,
            selection: { workspaceId: result.workspaceId, workspaceName: result.workspaceName },
          },
          200,
        );
      },
    )

    .post("/billing/checkout", validate("json", checkoutRequestSchema), async (c) => {
      const actor = getActor(c);
      const input = c.req.valid("json");
      return c.json(
        await billingService.startCheckout({
          userId: actor.actorUserId,
          workspaceId: actor.workspaceId,
          clientIdempotencyKey: input.clientIdempotencyKey,
          tier: input.tier,
          interval: input.interval,
          returnDestination: billingPage,
        }),
        200,
      );
    })

    .post(
      "/billing/checkout/return",
      validate("json", checkoutReturnRequestSchema),
      async (c) => {
        const actor = getActor(c);
        const result = await billingService.observeCheckoutReturn({
          userId: actor.actorUserId,
          workspaceId: actor.workspaceId,
          sessionId: c.req.valid("json").sessionId,
        });
        if (result.kind === "activating") {
          c.header("Retry-After", String(result.retryAfterSeconds));
          return c.json(result, 202);
        }
        return c.json(result, 200);
      },
    )

    .post("/billing/portal", async (c) => {
      const actor = getActor(c);
      return c.json(
        await billingService.openPortal({
          userId: actor.actorUserId,
          workspaceId: actor.workspaceId,
          returnUrl: billingPage,
        }),
        200,
      );
    })

    .get("/billing/state", async (c) => {
      const actor = getActor(c);
      const view = await billingService.readBillingState(actor.workspaceId);
      if (view.health === "activating") c.header("Retry-After", "2");
      return c.json(
        {
          view,
          availableTiers: billingService.configuredTiers(),
          isConfigured: billingService.isConfigured(),
        },
        200,
      );
    })

    .post(
      "/billing/plan-change/preview",
      validate("json", planChangePreviewRequestSchema),
      async (c) => {
        const actor = getActor(c);
        return c.json(
          await billingService.previewPlanChange({
            userId: actor.actorUserId,
            workspaceId: actor.workspaceId,
            ...c.req.valid("json"),
          }),
          200,
        );
      },
    )

    .post(
      "/billing/plan-change/confirm",
      validate("json", planChangeConfirmRequestSchema),
      async (c) => {
        const actor = getActor(c);
        return c.json(
          await billingService.confirmPlanChange({
            userId: actor.actorUserId,
            workspaceId: actor.workspaceId,
            quoteId: c.req.valid("json").quoteId,
          }),
          200,
        );
      },
    )

    .post("/billing/plan-change/payment", async (c) => {
      const actor = getActor(c);
      return c.json(
        await billingService.readPendingPlanChangePayment({
          userId: actor.actorUserId,
          workspaceId: actor.workspaceId,
        }),
        200,
      );
    })

    .post("/billing/plan-change/cancel", async (c) => {
      const actor = getActor(c);
      return c.json(
        await billingService.cancelScheduledPlanChange({
          userId: actor.actorUserId,
          workspaceId: actor.workspaceId,
        }),
        200,
      );
    })

    .post("/billing/reconcile", async (c) => {
      const actor = getActor(c);
      const result = await billingService.reconcileCurrentState(actor.workspaceId);
      if (result.view.health === "activating" || result.view.health === "retrying") {
        c.header("Retry-After", "2");
      }
      return c.json(result, 200);
    });
}

export type BillingRoutes = ReturnType<typeof createBillingRoutes>;

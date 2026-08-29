"use server";

import { randomUUID } from "node:crypto";
import { setActiveWorkspaceForActor } from "@narriflow/auth";
import {
  billingService,
  workspaceService,
  WorkspaceOperationError,
} from "@narriflow/services";
import {
  businessWorkspaceCheckoutActionSchema,
  type BillingInterval,
} from "@narriflow/validators";
import {
  authenticatedActionResultError,
  type AuthenticatedActionFailure,
  executeSignedInActionWithInput,
} from "@/lib/authenticated-request-action";
import { resolveCanonicalAppOrigin } from "@/lib/safe-redirect";
import {
  buildBusinessWorkspaceCheckoutRequest,
  recoverBusinessWorkspaceCheckoutFields,
} from "./checkout-request";

export interface CreateWorkspaceState {
  error?: string;
  errorCode?: string;
  requestId?: string;
  checkoutUrl?: string;
  workspaceId?: string;
  workspaceName?: string;
  interval?: BillingInterval;
  checkoutIdempotencyKey?: string;
}

function isPolicyFailure(
  value: CreateWorkspaceState | AuthenticatedActionFailure,
): value is AuthenticatedActionFailure {
  return "ok" in value && value.ok === false;
}

export async function createBusinessWorkspaceAction(
  previous: CreateWorkspaceState,
  formData: FormData,
): Promise<CreateWorkspaceState> {
  const untrustedInput = buildBusinessWorkspaceCheckoutRequest(
    previous,
    formData,
  );
  const result = await executeSignedInActionWithInput(
    untrustedInput,
    businessWorkspaceCheckoutActionSchema,
    async (actor, input) => {
      const interval: BillingInterval = input.interval;
      if (!billingService.isCheckoutConfigured("business", interval)) {
        return {
          error: `Business ${interval} checkout is not configured.`,
          errorCode: "checkout_not_configured",
          workspaceId: input.workspaceId,
          workspaceName: input.name,
          interval,
          checkoutIdempotencyKey: input.checkoutIdempotencyKey,
        };
      }

      let workspaceId = input.workspaceId;
      let workspaceName = input.name;
      const checkoutIdempotencyKey =
        input.checkoutIdempotencyKey ?? randomUUID();
      try {
        if (workspaceId) {
          const workspaceActor = await workspaceService.requireActor(
            actor.actorUserId,
            workspaceId,
            "billing.manage",
          );
          if (
            workspaceActor.role !== "owner" ||
            workspaceActor.status !== "pending_payment"
          ) {
            throw new WorkspaceOperationError(
              "workspace_checkout_state_invalid",
              "This workspace is not awaiting Business checkout",
            );
          }
          workspaceName = workspaceActor.workspaceName;
        } else {
          if (!input.name) {
            throw new Error(
              "Validated Workspace creation input is missing a name",
            );
          }
          const workspace =
            await workspaceService.createPendingBusinessWorkspace(
              actor.actorUserId,
              { name: input.name },
            );
          workspaceId = workspace.id;
          workspaceName = workspace.name;
        }

        const origin = resolveCanonicalAppOrigin({
          configuredOrigin: process.env.NEXT_PUBLIC_APP_URL,
          environment: process.env.NODE_ENV,
          requestUrl: "http://localhost:3000/workspaces/new",
        });
        const checkout = await billingService.startCheckout({
          userId: actor.actorUserId,
          workspaceId,
          clientIdempotencyKey: checkoutIdempotencyKey,
          tier: "business",
          interval,
          returnDestination: `${origin}/settings/billing`,
        });
        await setActiveWorkspaceForActor(actor.actorUserId, workspaceId);
        return {
          workspaceId,
          workspaceName,
          interval,
          checkoutIdempotencyKey,
          checkoutUrl: checkout.url,
        };
      } catch (error) {
        const failure = authenticatedActionResultError(
          error,
          "Workspace checkout could not be started",
        );
        return {
          workspaceId,
          workspaceName,
          interval,
          checkoutIdempotencyKey,
          error: failure.message,
          errorCode: failure.errorCode,
        };
      }
    },
  );
  if (isPolicyFailure(result)) {
    const recoverable = recoverBusinessWorkspaceCheckoutFields(
      previous,
      untrustedInput,
    );
    return {
      workspaceId: previous.workspaceId,
      ...recoverable,
      checkoutIdempotencyKey: previous.checkoutIdempotencyKey,
      error: result.message,
      errorCode: result.code,
      requestId: result.requestId,
    };
  }
  return result;
}

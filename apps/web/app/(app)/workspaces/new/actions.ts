"use server";

import { requireCurrentAppUser, setActiveWorkspace } from "@narriflow/auth";
import { billingService, workspaceService } from "@narriflow/services";
import type { BillingInterval } from "@narriflow/validators";

export interface CreateWorkspaceState {
  error?: string;
  checkoutUrl?: string;
  workspaceId?: string;
}

export async function createBusinessWorkspaceAction(
  previous: CreateWorkspaceState,
  formData: FormData,
): Promise<CreateWorkspaceState> {
  const user = await requireCurrentAppUser();
  const interval: BillingInterval = formData.get("interval") === "monthly" ? "monthly" : "annual";
  if (!billingService.isCheckoutConfigured("business", interval)) {
    return { error: `Business ${interval} checkout is not configured.` };
  }

  let workspaceId = previous.workspaceId;
  try {
    if (workspaceId) {
      const actor = await workspaceService.requireActor(user.id, workspaceId, "billing.manage");
      if (actor.role !== "owner" || actor.status !== "pending_payment" || actor.pricingTier !== "business") {
        throw new Error("This workspace is not awaiting Business checkout");
      }
    } else {
      const workspace = await workspaceService.createPendingBusinessWorkspace(user.id, {
        name: String(formData.get("name") ?? ""),
      });
      workspaceId = workspace.id;
    }

    const origin = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "http://localhost:3000";
    const checkout = await billingService.createCheckoutSession(
      user.id,
      workspaceId,
      "business",
      interval,
      {
        successUrl: `${origin}/home?upgraded=1&session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${origin}/settings/subscription?setup=cancelled`,
      },
    );
    await setActiveWorkspace(workspaceId);
    return { workspaceId, checkoutUrl: checkout.url };
  } catch (error) {
    return {
      workspaceId,
      error: error instanceof Error ? error.message : "Workspace checkout could not be started",
    };
  }
}

"use server";

import { randomUUID } from "node:crypto";
import { requireCurrentAppUser, setActiveWorkspace } from "@narriflow/auth";
import { billingService, workspaceService } from "@narriflow/services";
import type { BillingInterval } from "@narriflow/validators";
import { resolveCanonicalAppOrigin } from "@/lib/safe-redirect";

export interface CreateWorkspaceState {
  error?: string;
  checkoutUrl?: string;
  workspaceId?: string;
  checkoutIdempotencyKey?: string;
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
  const checkoutIdempotencyKey =
    previous.checkoutIdempotencyKey ?? randomUUID();
  try {
    if (workspaceId) {
      const actor = await workspaceService.requireActor(user.id, workspaceId, "billing.manage");
      if (actor.role !== "owner" || actor.status !== "pending_payment") {
        throw new Error("This workspace is not awaiting Business checkout");
      }
    } else {
      const workspace = await workspaceService.createPendingBusinessWorkspace(user.id, {
        name: String(formData.get("name") ?? ""),
      });
      workspaceId = workspace.id;
    }

    const origin = resolveCanonicalAppOrigin({
      configuredOrigin: process.env.NEXT_PUBLIC_APP_URL,
      environment: process.env.NODE_ENV,
      requestUrl: "http://localhost:3000/workspaces/new",
    });
    const checkout = await billingService.startCheckout({
      userId: user.id,
      workspaceId,
      clientIdempotencyKey: checkoutIdempotencyKey,
      tier: "business",
      interval,
      returnDestination: `${origin}/settings/billing`,
    });
    await setActiveWorkspace(workspaceId);
    return { workspaceId, checkoutIdempotencyKey, checkoutUrl: checkout.url };
  } catch (error) {
    return {
      workspaceId,
      checkoutIdempotencyKey,
      error: error instanceof Error ? error.message : "Workspace checkout could not be started",
    };
  }
}

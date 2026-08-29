import { Hono, type Context } from "hono";
import {
  checkoutRequestSchema,
  checkoutReturnRequestSchema,
  type WorkspaceBillingView,
} from "@narriflow/validators";
import { workspaceBillingHttpFailure } from "./workspace-billing-http";

interface BillingActor {
  actorUserId: string;
  workspaceId: string;
}

interface WorkspaceBillingHttpDependencies {
  resolveAppOrigin(requestUrl: string): string;
  getActor(context: Context): Promise<BillingActor>;
  startCheckout(input: {
    userId: string;
    workspaceId: string;
    clientIdempotencyKey: string;
    tier: "creator" | "pro" | "business";
    interval: "monthly" | "annual";
    returnDestination: string;
  }): Promise<unknown>;
  observeCheckoutReturn(input: {
    userId: string;
    workspaceId: string;
    sessionId: string;
  }): Promise<
    | { kind: "activating"; retryAfterSeconds: number; view: WorkspaceBillingView;
      }
    | { kind: "terminal"; reason: "expired"; view: WorkspaceBillingView }
  >;
  openPortal(input: {
    userId: string;
    workspaceId: string;
    returnUrl: string;
  }): Promise<{ url: string }>;
  readBillingState(workspaceId: string): Promise<WorkspaceBillingView>;
  reconcileCurrentState(workspaceId: string): Promise<{
    kind: "reconciled" | "unresolved";
    reason?: string;
    view: WorkspaceBillingView;
  }>;
}

export function createWorkspaceBillingHttpRoutes(
  dependencies: WorkspaceBillingHttpDependencies,
) {
  const app = new Hono();

  app.post("/checkout", async (c) => {
    const actor = await dependencies.getActor(c);
    const parsed = checkoutRequestSchema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success) {
      return c.json({ error: "validation_failed", issues: parsed.error.issues }, 400,
      );
    }
    try {
      return c.json(
        await dependencies.startCheckout({
          userId: actor.actorUserId,
          workspaceId: actor.workspaceId,
          clientIdempotencyKey: parsed.data.clientIdempotencyKey,
          tier: parsed.data.tier,
          interval: parsed.data.interval,
          returnDestination: `${dependencies.resolveAppOrigin(c.req.url)}/settings/billing`,
        }),
        200,
      );
    } catch (error) {
      const failure = workspaceBillingHttpFailure(error, "checkout_failed");
      return c.json(failure.body, failure.status);
    }
  });

  app.post("/checkout/return", async (c) => {
    const actor = await dependencies.getActor(c);
    const parsed = checkoutReturnRequestSchema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success) {
      return c.json(
        { error: "invalid_checkout_return", issues: parsed.error.issues },
        400,
      );
    }
    try {
      const result = await dependencies.observeCheckoutReturn({
        userId: actor.actorUserId,
        workspaceId: actor.workspaceId,
        sessionId: parsed.data.sessionId,
      });
      if (result.kind === "activating") {
        c.header("Retry-After", String(result.retryAfterSeconds));
        return c.json(result, 202);
      }
      return c.json(result, 200);
    } catch (error) {
      const failure = workspaceBillingHttpFailure(error, "checkout_return_failed",
      );
      return c.json(failure.body, failure.status);
    }
  });

  app.post("/portal", async (c) => {
    const actor = await dependencies.getActor(c);
    try {
      return c.json(
        await dependencies.openPortal({
          userId: actor.actorUserId,
          workspaceId: actor.workspaceId,
          returnUrl: `${dependencies.resolveAppOrigin(c.req.url)}/settings/billing`,
        }),
        200,
      );
    } catch (error) {
      const failure = workspaceBillingHttpFailure(error, "portal_failed");
      return c.json(failure.body, failure.status);
    }
  });

  app.get("/state", async (c) => {
    const actor = await dependencies.getActor(c);
    try {
      const view = await dependencies.readBillingState(actor.workspaceId);
      if (view.health === "activating") c.header("Retry-After", "2");
      return c.json({ view }, 200);
    } catch {
      return c.json({ error: "billing_state_unavailable" }, 503);
    }
  });

  app.post("/reconcile", async (c) => {
    const actor = await dependencies.getActor(c);
    try {
      const result = await dependencies.reconcileCurrentState(actor.workspaceId,
      );
      if (result.view.health === "activating" || result.view.health === "retrying") {
        c.header("Retry-After", "2");
      }
      return c.json(result, 200);
    } catch (error) {
      const failure = workspaceBillingHttpFailure(
        error,
        "billing_reconciliation_unavailable",
      );
      return c.json(failure.body, failure.status);
    }
  });

  return app;
}

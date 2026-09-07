import { describe, expect, test } from "bun:test";
import { businessWorkspaceCheckoutActionSchema } from "@narriflow/validators";
import {
  buildBusinessWorkspaceCheckoutRequest,
  recoverBusinessWorkspaceCheckoutFields,
} from "./checkout-request";

describe("identity-only Business Workspace checkout request", () => {
  test("preserves a failed monthly checkout's name and identity for retry", () => {
    const formData = new FormData();
    const retry = buildBusinessWorkspaceCheckoutRequest(
      {
        workspaceId: "workspace_pending",
        workspaceName: "Acme Studio",
        interval: "monthly",
        checkoutIdempotencyKey: "550e8400-e29b-41d4-a716-446655440000",
      },
      formData,
    );

    expect(businessWorkspaceCheckoutActionSchema.parse(retry)).toEqual({
      workspaceId: "workspace_pending",
      name: "Acme Studio",
      interval: "monthly",
      checkoutIdempotencyKey: "550e8400-e29b-41d4-a716-446655440000",
    });
  });

  test("keeps bounded correctable values after initial policy validation", () => {
    expect(
      recoverBusinessWorkspaceCheckoutFields(
        {},
        {
          name: "  Acme   Studio  ",
          interval: "monthly",
          forgedOwnerId: "attacker",
        },
      ),
    ).toEqual({ workspaceName: "Acme Studio", interval: "monthly" });
    expect(
      recoverBusinessWorkspaceCheckoutFields(
        { interval: "annual" },
        { name: "A".repeat(200), interval: "forged" },
      ),
    ).toEqual({ workspaceName: "A".repeat(80), interval: "annual" });
  });

  test("leaves malformed intervals and unknown fields for strict validation", () => {
    const formData = new FormData();
    formData.set("name", "Acme Studio");
    formData.set("interval", "forged");
    formData.set("ownerUserId", "attacker");

    const request = buildBusinessWorkspaceCheckoutRequest({}, formData);
    expect(businessWorkspaceCheckoutActionSchema.safeParse(request).success).toBe(
      false,
    );
  });
});

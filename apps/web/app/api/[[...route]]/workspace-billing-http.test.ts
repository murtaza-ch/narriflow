import { describe, expect, test } from "bun:test";
import { BillingError } from "@narriflow/services";
import { workspaceBillingHttpFailure } from "./workspace-billing-http";

describe("Workspace Billing HTTP adapter", () => {
  test("maps product conflicts without exposing provider messages", () => {
    expect(
      workspaceBillingHttpFailure(
        new BillingError("checkout_attempt_terminal", "raw provider detail"),
        "checkout_failed",
      ),
    ).toEqual({
      status: 409,
      body: {
        error: "checkout_attempt_terminal",
        message: "The previous Checkout is no longer available. Start a new one safely.",
      },
    });
  });

  test("distinguishes authorization, absence, repair conflicts, and outages", () => {
    expect(
      workspaceBillingHttpFailure(
        new BillingError("billing_forbidden", "private detail"),
        "checkout_failed",
      ).status,
    ).toBe(403);
    expect(
      workspaceBillingHttpFailure(
        new BillingError("workspace_not_found", "private detail"),
        "checkout_failed",
      ).status,
    ).toBe(404);
    expect(
      workspaceBillingHttpFailure(
        new BillingError("customer_identity_conflict", "private detail"),
        "checkout_failed",
      ).status,
    ).toBe(409);
    expect(
      workspaceBillingHttpFailure(
        new BillingError("billing_customer_missing", "private detail"),
        "portal_failed",
      ),
    ).toEqual({
      status: 409,
      body: {
        error: "billing_customer_missing",
        message: "No billing customer is available for this workspace.",
      },
    });
    expect(
      workspaceBillingHttpFailure(new Error("network secret"), "portal_failed"),
    ).toEqual({
      status: 503,
      body: {
        error: "portal_failed",
        message: "Billing is temporarily unavailable. Try again.",
      },
    });
  });
});

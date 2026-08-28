import { describe, expect, test } from "bun:test";
import { parseWorkspaceBillingPollInterval } from "./workspace-billing-config";

describe("Workspace Billing worker config", () => {
  test("uses the finite default and enforces hard bounds", () => {
    expect(parseWorkspaceBillingPollInterval(undefined)).toBe(5_000);
    expect(parseWorkspaceBillingPollInterval("250")).toBe(250);
    expect(parseWorkspaceBillingPollInterval("300000")).toBe(300_000);
    for (const value of ["NaN", "249", "300001", "12.5"]) {
      expect(() => parseWorkspaceBillingPollInterval(value)).toThrow(
        "WORKSPACE_BILLING_POLL_INTERVAL_MS",
      );
    }
  });
});

import { describe, expect, test } from "bun:test";
import { parseWorkspaceBillingOperatorArgs } from "./workspace-billing-operator";

describe("Workspace Billing operator command", () => {
  test("defaults to read-only inspection", () => {
    expect(
      parseWorkspaceBillingOperatorArgs([
        "--workspace",
        "11111111-1111-4111-8111-111111111111",
      ]),
    ).toEqual({
      workspaceId: "11111111-1111-4111-8111-111111111111",
      reconcile: false,
    });
  });

  test("requires the explicit reconcile switch and rejects unsafe arguments", () => {
    expect(
      parseWorkspaceBillingOperatorArgs([
        "--workspace",
        "11111111-1111-4111-8111-111111111111",
        "--reconcile",
      ]).reconcile,
    ).toBe(true);
    expect(() =>
      parseWorkspaceBillingOperatorArgs(["--workspace", "not-an-id"]),
    ).toThrow("valid Workspace UUID");
    expect(() =>
      parseWorkspaceBillingOperatorArgs([
        "--workspace",
        "11111111-1111-4111-8111-111111111111",
        "--delete",
      ]),
    ).toThrow("Unknown argument");
  });
});

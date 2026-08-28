import { describe, expect, test } from "bun:test";
import {
  billingStatusPresentation,
  shouldShowSeatSyncStatus,
} from "./billing-view-model";

const base = {
  workspaceId: "018f5f6a-4c31-7c75-9a4f-8f74f977bc10",
  plan: "pro" as const,
  interval: "monthly" as const,
  status: "active" as const,
  workspaceAccessStatus: "active" as const,
  health: "current" as const,
  renewalOrEndAt: "2026-09-28T10:00:00.000Z",
  cancelAtPeriodEnd: false,
  graceDeadlineAt: null,
  lastSuccessfulSyncAt: "2026-08-28T10:00:00.000Z",
  desiredAdditionalSeats: 0,
  synchronizedAdditionalSeats: 0,
  actions: ["open_portal" as const],
};

describe("billing status presentation", () => {
  test("uses durable health and access facts for recovery copy", () => {
    expect(
      billingStatusPresentation({ ...base, health: "activating" }),
    ).toMatchObject({
      headline: "Activating your plan",
      body: expect.stringContaining("leave this page"),
      live: "polite",
    });
    expect(
      billingStatusPresentation({ ...base, health: "retrying" }),
    ).toMatchObject({
      headline: "Billing sync delayed",
      body: expect.stringContaining("verified access is unchanged"),
    });
    expect(
      billingStatusPresentation({
        ...base,
        health: "payment_action_required",
        status: "payment_past_due",
        graceDeadlineAt: "2026-09-04T10:00:00.000Z",
      }),
    ).toMatchObject({
      headline: "Payment action required",
      dateLabel: "Recovery deadline",
      primaryAction: "open_portal",
    });
    expect(
      billingStatusPresentation({
        ...base,
        workspaceAccessStatus: "restricted",
        plan: "free",
      }),
    ).toMatchObject({
      headline: "Workspace access is restricted",
      body: expect.stringContaining("downloads and billing repair remain available"),
    });
    expect(
      billingStatusPresentation({ ...base, health: "attention_required" }),
    ).toMatchObject({
      headline: "Billing needs attention",
      body: expect.not.stringContaining("conflict"),
    });
  });

  test("limits paid-seat synchronization copy to Business owners", () => {
    const delayed = {
      ...base,
      plan: "business" as const,
      desiredAdditionalSeats: 2,
      synchronizedAdditionalSeats: 1,
    };
    expect(shouldShowSeatSyncStatus(delayed, "owner")).toBe(true);
    expect(
      shouldShowSeatSyncStatus({ ...delayed, plan: "pro" }, "owner"),
    ).toBe(false);
    expect(shouldShowSeatSyncStatus(delayed, "admin")).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import { finishingReasonMessage, finishingSettingsSchema } from "./finishing";
import {
  createStandingGrantSchema,
  renewStandingGrantSchema,
  STANDING_GRANT_MAX_DAYS,
  standingGrantPauseMessage,
} from "./standing-grant";
import { WORKSPACE_EVENT_TYPES, workspaceEventSchema } from "./workspace-event";

const ruleId = "00000000-0000-4000-8000-000000000001";
const accountId = "00000000-0000-4000-8000-000000000002";
const terms = { dailyCap: 2, weeklyCap: 5, expiresInDays: 30 };

describe("createStandingGrantSchema", () => {
  test("a publish grant names one account and a review grant names its reviewers", () => {
    expect(createStandingGrantSchema.parse({ kind: "publish", autopilotRuleId: ruleId, socialAccountId: accountId, ...terms })).toMatchObject({ kind: "publish", socialAccountId: accountId });
    expect(createStandingGrantSchema.parse({ kind: "review_send", autopilotRuleId: ruleId, reviewerEmails: ["client@example.test"], ...terms })).toMatchObject({ kind: "review_send" });
    // Each kind refuses the other's destination.
    expect(createStandingGrantSchema.safeParse({ kind: "publish", autopilotRuleId: ruleId, reviewerEmails: ["a@example.test"], ...terms }).success).toBe(false);
    expect(createStandingGrantSchema.safeParse({ kind: "review_send", autopilotRuleId: ruleId, socialAccountId: accountId, ...terms }).success).toBe(false);
    expect(createStandingGrantSchema.safeParse({ kind: "review_send", autopilotRuleId: ruleId, reviewerEmails: [], ...terms }).success).toBe(false);
  });

  test("caps and expiry have bounds, and the week can't hold less than the day", () => {
    const base = { kind: "publish" as const, autopilotRuleId: ruleId, socialAccountId: accountId };
    expect(createStandingGrantSchema.safeParse({ ...base, ...terms, expiresInDays: STANDING_GRANT_MAX_DAYS }).success).toBe(true);
    for (const invalid of [
      { ...terms, expiresInDays: STANDING_GRANT_MAX_DAYS + 1 },
      { ...terms, expiresInDays: 0 },
      { ...terms, dailyCap: 0 },
      { ...terms, dailyCap: 21 },
      { ...terms, weeklyCap: 101 },
      { ...terms, dailyCap: 4, weeklyCap: 3 },
      { ...terms, dailyCap: 1.5 },
    ]) {
      expect(createStandingGrantSchema.safeParse({ ...base, ...invalid }).success).toBe(false);
    }
  });
});

describe("renewStandingGrantSchema", () => {
  test("restates the terms for a grant", () => {
    expect(renewStandingGrantSchema.safeParse({ grantId: ruleId, ...terms }).success).toBe(true);
    expect(renewStandingGrantSchema.safeParse({ grantId: ruleId, ...terms, expiresInDays: 91 }).success).toBe(false);
    expect(renewStandingGrantSchema.safeParse({ grantId: ruleId, ...terms, dailyCap: 9 }).success).toBe(false);
  });
});

describe("pause messages", () => {
  test("every reason reads plainly, and an unknown one reads generically", () => {
    expect(standingGrantPauseMessage("post_failed")).toContain("failed");
    expect(standingGrantPauseMessage("post_needs_attention")).toContain("needs attention");
    expect(standingGrantPauseMessage("granter_unavailable")).toContain("no longer an Owner or Admin");
    expect(standingGrantPauseMessage("something_new")).toBe("Paused.");
    expect(standingGrantPauseMessage(null)).toBeNull();
  });
});

describe("finishing delivery send_review_round", () => {
  test("needs no queue accounts, and refuses them", () => {
    expect(finishingSettingsSchema.parse({ topClips: 2, delivery: "send_review_round" })).toMatchObject({ delivery: "send_review_round", queueAccountIds: [] });
    expect(finishingSettingsSchema.safeParse({ topClips: 2, delivery: "send_review_round", queueAccountIds: [accountId] }).success).toBe(false);
  });

  test("a review round that wasn't sent says why", () => {
    for (const reason of ["review_not_sent_no_grant", "review_not_sent_plan", "review_not_sent_cap", "review_not_sent_granter", "review_not_sent_failed"]) {
      expect(finishingReasonMessage(reason)).not.toBe("Finishing did not complete.");
    }
  });
});

describe("grant Workspace Events", () => {
  const envelope = { id: "00000000-0000-4000-8000-0000000000aa", seq: 1, version: 1, occurredAt: "2026-10-24T10:00:00.000Z" };

  test("are public event types with IDs-only subjects", () => {
    expect(WORKSPACE_EVENT_TYPES).toContain("grant.paused");
    expect(WORKSPACE_EVENT_TYPES).toContain("grant.expired");
    expect(workspaceEventSchema.safeParse({ ...envelope, type: "grant.paused", subject: { grantId: ruleId, kind: "publish", autopilotRuleId: ruleId, reason: "post_failed" } }).success).toBe(true);
    expect(workspaceEventSchema.safeParse({ ...envelope, type: "grant.expired", subject: { grantId: ruleId, kind: "review_send", autopilotRuleId: ruleId } }).success).toBe(true);
    // Subjects are strict: an account, a post or an email address never rides along.
    expect(workspaceEventSchema.safeParse({ ...envelope, type: "grant.expired", subject: { grantId: ruleId, kind: "publish", autopilotRuleId: ruleId, socialAccountId: accountId } }).success).toBe(false);
    expect(workspaceEventSchema.safeParse({ ...envelope, type: "grant.paused", subject: { grantId: ruleId, kind: "publish", autopilotRuleId: ruleId, reason: "because" } }).success).toBe(false);
  });
});

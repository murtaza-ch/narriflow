import { describe, expect, test } from "bun:test";
import { autopilotFinishingAuthoritySchema } from "./autopilot-finishing-authority";

describe("Frozen Autopilot finishing authority", () => {
  const sourceRuleFingerprint = "a".repeat(64);
  const account = "11111111-1111-4111-8111-111111111111";
  const grant = { id: "22222222-2222-4222-8222-222222222222", revision: 3, ruleFingerprint: sourceRuleFingerprint };
  test("keeps explicit absent grants and exact revisions", () => {
    const value = { sourceRuleFingerprint, publish: [{ socialAccountId: account, grant: null }], review: grant };
    expect(autopilotFinishingAuthoritySchema.parse(value)).toEqual(value);
    expect(autopilotFinishingAuthoritySchema.safeParse({ sourceRuleFingerprint, publish: [], review: undefined }).success).toBe(false);
  });
  test("refuses a different source fingerprint, duplicate destination, or unbounded destination list", () => {
    expect(autopilotFinishingAuthoritySchema.safeParse({ sourceRuleFingerprint, publish: [], review: { ...grant, ruleFingerprint: "b".repeat(64) } }).success).toBe(false);
    const destination = { socialAccountId: account, grant };
    expect(autopilotFinishingAuthoritySchema.safeParse({ sourceRuleFingerprint, publish: [destination, destination], review: null }).success).toBe(false);
    expect(autopilotFinishingAuthoritySchema.safeParse({ sourceRuleFingerprint, publish: Array.from({ length: 11 }, () => destination), review: null }).success).toBe(false);
    expect(autopilotFinishingAuthoritySchema.safeParse({ sourceRuleFingerprint, publish: [], review: null, latest: true }).success).toBe(false);
  });
});

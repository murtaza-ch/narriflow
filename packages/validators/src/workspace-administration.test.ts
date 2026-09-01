import { describe, expect, test } from "bun:test";
import {
  businessWorkspaceCheckoutActionSchema,
  onboardingProfileActionSchema,
  workspaceApiKeyActionSchema,
  workspaceInviteActionSchema,
  workspaceSettingsActionSchema,
} from "./workspace-administration";

describe("Workspace administration request boundaries", () => {
  test("accepts bounded settings and rejects invalid timezones and ownership fields", () => {
    expect(
      workspaceSettingsActionSchema.safeParse({
        name: "Editorial",
        timezone: "Asia/Karachi",
      }).success,
    ).toBe(true);
    expect(
      workspaceSettingsActionSchema.safeParse({
        name: "Editorial",
        timezone: "not/a-timezone",
      }).success,
    ).toBe(false);
    expect(
      workspaceSettingsActionSchema.safeParse({
        name: "Editorial",
        timezone: "UTC",
        workspaceId: "forged",
      }).success,
    ).toBe(false);
  });

  test("rejects invalid invitations before membership or email work", () => {
    expect(
      workspaceInviteActionSchema.safeParse({
        email: "editor@example.com",
        role: "editor",
      }).success,
    ).toBe(true);
    expect(
      workspaceInviteActionSchema.safeParse({ email: "bad", role: "owner" })
        .success,
    ).toBe(false);
  });

  test("rejects unsupported or forged API-key scopes", () => {
    expect(
      workspaceApiKeyActionSchema.safeParse({
        name: "Automation",
        scopes: ["projects:read", "autopilot:write"],
      }).success,
    ).toBe(true);
    expect(
      workspaceApiKeyActionSchema.safeParse({
        name: "Automation",
        scopes: ["billing:write"],
      }).success,
    ).toBe(false);
  });

  test("requires a name for creation but permits a preserved checkout retry", () => {
    expect(
      businessWorkspaceCheckoutActionSchema.safeParse({
        name: "Acme Studio",
        interval: "annual",
      }).success,
    ).toBe(true);
    expect(
      businessWorkspaceCheckoutActionSchema.safeParse({
        workspaceId: "workspace_pending",
        interval: "monthly",
      }).success,
    ).toBe(true);
    expect(
      businessWorkspaceCheckoutActionSchema.safeParse({
        name: "Acme Studio",
        interval: "forged",
      }).success,
    ).toBe(false);
  });

  test("keeps onboarding profile input bounded and strict", () => {
    expect(
      onboardingProfileActionSchema.safeParse({
        firstName: "Ada",
        lastName: "Lovelace",
      }).success,
    ).toBe(true);
    expect(
      onboardingProfileActionSchema.safeParse({
        firstName: "Ada",
        lastName: "Lovelace",
        workspaceId: "forged",
      }).success,
    ).toBe(false);
  });
});

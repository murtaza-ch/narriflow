import { describe, expect, test } from "bun:test";

import {
  assertWorkspaceInviteEntitlement,
  normalizeWorkspaceApiKeyInput,
  normalizeWorkspaceName,
  roleHasWorkspaceCapability,
  WorkspaceOperationError,
  workspaceAllowsCapability,
  type WorkspaceCapability,
} from "./workspace.service";

describe("workspace permission matrix", () => {
  const capabilities: WorkspaceCapability[] = [
    "content.view", "content.download", "content.edit", "processing.consume",
    "publishing.manage", "brand.manage", "social.manage", "workspace.manage", "api.manage", "members.invite",
    "members.promote_admin", "billing.manage",
  ];

  test("owner has every capability", () => {
    for (const capability of capabilities) {
      expect(roleHasWorkspaceCapability("owner", capability)).toBe(true);
    }
  });

  test("admin cannot promote admins or manage billing", () => {
    expect(roleHasWorkspaceCapability("admin", "members.invite")).toBe(true);
    expect(roleHasWorkspaceCapability("admin", "members.promote_admin")).toBe(false);
    expect(roleHasWorkspaceCapability("admin", "billing.manage")).toBe(false);
  });

  test("editor can create content but cannot manage connections or members", () => {
    expect(roleHasWorkspaceCapability("editor", "content.edit")).toBe(true);
    expect(roleHasWorkspaceCapability("editor", "brand.manage")).toBe(true);
    expect(roleHasWorkspaceCapability("editor", "social.manage")).toBe(false);
    expect(roleHasWorkspaceCapability("editor", "members.invite")).toBe(false);
  });

  test("viewer is read-only", () => {
    expect(roleHasWorkspaceCapability("viewer", "content.view")).toBe(true);
    expect(roleHasWorkspaceCapability("viewer", "content.download")).toBe(true);
    expect(roleHasWorkspaceCapability("viewer", "content.edit")).toBe(false);
  });

  test("restricted workspaces retain read and owner billing access", () => {
    expect(workspaceAllowsCapability({ role: "owner", status: "restricted" }, "content.view")).toBe(true);
    expect(workspaceAllowsCapability({ role: "owner", status: "restricted" }, "content.download")).toBe(true);
    expect(workspaceAllowsCapability({ role: "owner", status: "restricted" }, "billing.manage")).toBe(true);
    expect(workspaceAllowsCapability({ role: "owner", status: "restricted" }, "content.edit")).toBe(false);
    expect(workspaceAllowsCapability({ role: "owner", status: "restricted" }, "api.manage")).toBe(false);
    expect(workspaceAllowsCapability({ role: "owner", status: "restricted" }, "processing.consume")).toBe(false);
    expect(workspaceAllowsCapability({ role: "admin", status: "restricted" }, "content.edit")).toBe(false);
    expect(workspaceAllowsCapability({ role: "admin", status: "restricted" }, "social.manage")).toBe(false);
    expect(workspaceAllowsCapability({ role: "admin", status: "restricted" }, "workspace.manage")).toBe(false);
    expect(workspaceAllowsCapability({ role: "admin", status: "restricted" }, "api.manage")).toBe(false);
  });

  test("pending workspaces permit only owner setup and billing", () => {
    expect(workspaceAllowsCapability({ role: "owner", status: "pending_payment" }, "content.view")).toBe(true);
    expect(workspaceAllowsCapability({ role: "owner", status: "pending_payment" }, "workspace.manage")).toBe(true);
    expect(workspaceAllowsCapability({ role: "owner", status: "pending_payment" }, "billing.manage")).toBe(true);
    expect(workspaceAllowsCapability({ role: "owner", status: "pending_payment" }, "content.edit")).toBe(false);
    expect(workspaceAllowsCapability({ role: "owner", status: "pending_payment" }, "processing.consume")).toBe(false);
    expect(workspaceAllowsCapability({ role: "owner", status: "pending_payment" }, "members.invite")).toBe(false);
    expect(workspaceAllowsCapability({ role: "admin", status: "pending_payment" }, "content.view")).toBe(false);
  });
});

describe("Workspace name normalization", () => {
  test("uses the canonical service name returned to checkout state", () => {
    expect(normalizeWorkspaceName("  Ａｃｍｅ   Studio  ")).toBe("Acme Studio");
  });
});

describe("workspace administration failures", () => {
  test("uses stable codes for plan and owner-only invitation refusals", () => {
    expect(() =>
      assertWorkspaceInviteEntitlement({
        collaborationEnabled: true,
        pricingTier: "free",
        workspaceStatus: "active",
        actorRole: "owner",
        invitedRole: "viewer",
      }),
    ).toThrow(expect.objectContaining({ code: "workspace_invites_require_business" }));
    expect(() =>
      assertWorkspaceInviteEntitlement({
        collaborationEnabled: true,
        pricingTier: "business",
        workspaceStatus: "active",
        actorRole: "admin",
        invitedRole: "admin",
      }),
    ).toThrow(
      expect.objectContaining({ code: "workspace_admin_invite_owner_required" }),
    );
  });

  test("uses stable codes for invalid API-key scope and plan refusal", () => {
    expect(() =>
      normalizeWorkspaceApiKeyInput("free", {
        name: "Automation",
        scopes: ["projects:read"],
      }),
    ).toThrow(expect.objectContaining({ code: "workspace_api_requires_business" }));
    expect(() =>
      normalizeWorkspaceApiKeyInput("business", {
        name: "Automation",
        scopes: ["billing:write"],
      }),
    ).toThrow(expect.objectContaining({ code: "workspace_api_scope_invalid" }));
  });

  test("duplicate-membership refusal is typed for the action mapper", () => {
    const error = new WorkspaceOperationError(
      "workspace_member_already_exists",
      "This person is already a workspace member",
    );
    expect(error.code).toBe("workspace_member_already_exists");
  });
});

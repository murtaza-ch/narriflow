import { describe, expect, test } from "bun:test";
import { workspaceAccessReason } from "./access-note";

describe("workspaceAccessReason", () => {
  test("is null when the member may act", () => {
    expect(workspaceAccessReason({ role: "admin", status: "active" }, "workspace.manage", "change settings")).toBeNull();
  });

  test("names who to ask for a role refusal, from the capability matrix", () => {
    expect(workspaceAccessReason({ role: "viewer", status: "active" }, "brand.manage", "change the brand kit")?.message).toBe(
      "Ask a workspace owner, admin or editor to change the brand kit.",
    );
    expect(workspaceAccessReason({ role: "editor", status: "active" }, "members.invite", "invite members")?.message).toBe(
      "Ask a workspace owner or admin to invite members.",
    );
  });

  test("a billing hold sends the owner to billing and tells everyone else to ask the owner", () => {
    expect(workspaceAccessReason({ role: "owner", status: "pending_payment" }, "members.invite", "invite members")).toEqual({
      message: "Finish billing setup to invite members.",
      billingLink: true,
    });
    expect(workspaceAccessReason({ role: "owner", status: "restricted" }, "social.manage", "connect a social account")).toEqual({
      message: "Fix billing to connect a social account.",
      billingLink: true,
    });
    expect(workspaceAccessReason({ role: "admin", status: "restricted" }, "workspace.manage", "change settings")).toEqual({
      message: "This workspace is restricted. Ask the workspace owner to fix billing.",
      billingLink: false,
    });
  });

  test("a role refusal stays a role refusal while billing is on hold", () => {
    expect(workspaceAccessReason({ role: "viewer", status: "restricted" }, "workspace.manage", "change settings")?.message).toBe(
      "Ask a workspace owner or admin to change settings.",
    );
  });
});

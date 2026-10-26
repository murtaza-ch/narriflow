import { describe, expect, test } from "bun:test";
import { isWorkspaceRoleElevation } from "./workspace-membership.service";

describe("Workspace membership role changes", () => {
  test("elevations need the team-members plan; demotions are cleanup", () => {
    for (const [from, to] of [
      ["viewer", "editor"],
      ["viewer", "admin"],
      ["editor", "admin"],
    ] as const) {
      expect(isWorkspaceRoleElevation(from, to)).toBe(true);
    }
    for (const [from, to] of [
      ["admin", "editor"],
      ["admin", "viewer"],
      ["editor", "viewer"],
      ["editor", "editor"],
    ] as const) {
      expect(isWorkspaceRoleElevation(from, to)).toBe(false);
    }
  });
});

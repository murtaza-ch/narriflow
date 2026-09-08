import { describe, expect, test } from "bun:test";
import { isSettingsPath, settingsReturnState } from "./settings-return";

describe("settings return navigation", () => {
  test("direct entry falls back to Home", () => {
    expect(settingsReturnState(null, "a", "/settings/profile").destination).toBe("/home");
    expect(isSettingsPath("/settings-other")).toBe(false);
    expect(isSettingsPath("/settings")).toBe(true);
  });
  test("preserves the entry page and query through settings and reload", () => {
    let state = settingsReturnState(null, "a", "/calendar?month=2026-09");
    state = settingsReturnState(state, "a", "/settings/workspace");
    state = settingsReturnState(state, "a", "/settings/social-accounts?connected=1");
    state = settingsReturnState(JSON.parse(JSON.stringify(state)), "a", "/settings/profile");
    expect(state.destination).toBe("/calendar?month=2026-09");
    state = settingsReturnState(state, "a", "/projects/one");
    expect(settingsReturnState(state, "a", "/settings/billing").destination).toBe("/projects/one");
  });
  test("drops a previous workspace destination", () => {
    const state = settingsReturnState(null, "a", "/projects/private");
    expect(settingsReturnState(state, "b", "/settings/profile").destination).toBe("/home");
    expect(settingsReturnState(state, "b", "/projects/private").destination).toBe("/home");
  });
  test("rejects external and recursive stored destinations", () => {
    for (const destination of ["https://example.com", "//example.com", "/\\example.com", "/settings/profile"]) {
      expect(settingsReturnState({ workspaceId: "a", destination }, "a", "/settings/profile").destination).toBe("/home");
    }
  });
});

import { describe, expect, test } from "bun:test";
import { matchNavigationActions } from "./navigation-actions";

describe("matchNavigationActions", () => {
  test("makes MCP and API destinations discoverable by common client terms", () => {
    expect(matchNavigationActions("mcp").map((item) => item.id)).toContain("mcp");
    expect(matchNavigationActions("Codex").map((item) => item.id)).toContain("mcp");
    expect(matchNavigationActions("api key").map((item) => item.id)).toContain("developer-access");
  });

  test("requires every query term while preserving useful default actions", () => {
    expect(matchNavigationActions("AI assistant").map((item) => item.id)).toEqual(["mcp", "help"]);
    expect(matchNavigationActions("").map((item) => item.id)).toEqual([
      "integrations",
      "mcp",
      "developer-access",
    ]);
  });
});

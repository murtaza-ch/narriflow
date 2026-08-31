import { describe, expect, test } from "bun:test";

import {
  DEFAULT_WORKSPACE_API_KEY_SCOPES,
  resolveWorkspaceApiKeyScopes,
} from "./api-key-scope-selection";

describe("API key scope selection", () => {
  test("preserves the existing read-only key defaults", () => {
    expect(resolveWorkspaceApiKeyScopes([])).toEqual(
      DEFAULT_WORKSPACE_API_KEY_SCOPES,
    );
  });

  test("adds explicit Business workflow scopes without duplicates", () => {
    expect(resolveWorkspaceApiKeyScopes([
      "brand:read",
      "review:write",
      "generated-media:submit",
      "projects:read",
    ])).toEqual([
      ...DEFAULT_WORKSPACE_API_KEY_SCOPES,
      "brand:read",
      "review:write",
      "generated-media:submit",
    ]);
  });
});

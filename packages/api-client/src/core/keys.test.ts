import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/query-core";
import {
  canonicalJson,
  canonicalize,
  guestKey,
  invalidateScoped,
  invalidateSession,
  isWorkspaceKey,
  scopedKey,
  sessionKey,
  sha256Hex,
  shareKey,
} from "./keys";
import { USER, WORKSPACE_A, WORKSPACE_B } from "./test-helpers";

const scopeA = { userId: USER, workspaceId: WORKSPACE_A };

describe("key shapes", () => {
  test("workspace keys are exactly [nf, user, workspace, domain, resource, id]", () => {
    expect(scopedKey(scopeA, "projects", "detail", "p1")).toEqual([
      "nf",
      USER,
      WORKSPACE_A,
      "projects",
      "detail",
      "p1",
    ]);
    expect(scopedKey(scopeA, "projects", "list", { q: "x", limit: 10 })).toEqual([
      "nf",
      USER,
      WORKSPACE_A,
      "projects",
      "list",
      { limit: 10, q: "x" },
    ]);
  });

  test("session keys are identity-only", () => {
    expect(sessionKey({ userId: USER }, "bootstrap")).toEqual(["nf", USER, "session", "bootstrap"]);
  });

  test("guest and share keys use their own roots and require a digest", async () => {
    const digest = await sha256Hex("review-token");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(guestKey(digest, "room")).toEqual(["nf-guest", digest, "room"]);
    expect(shareKey(digest, "clip", { v: 1 })).toEqual(["nf-share", digest, "clip", { v: 1 }]);
    expect(() => guestKey("raw-token-value", "room")).toThrow();
    expect(() => shareKey("AB".repeat(32), "clip")).toThrow();
  });

  test("a resource-less key with a filter is rejected", () => {
    expect(() => scopedKey(scopeA, "projects", undefined, { q: 1 })).toThrow();
  });
});

describe("canonical filters", () => {
  test("equal filters produce equal keys regardless of property order", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 2], c: "x" } })).toBe(
      canonicalJson({ a: { c: "x", d: [1, 2] }, b: 1 }),
    );
  });

  test("undefined properties are dropped, -0 is 0", () => {
    expect(canonicalize({ a: undefined, b: -0, c: null })).toEqual({ b: 0, c: null });
  });

  test("rejects values that would split or poison the cache", () => {
    expect(() => canonicalize({ at: new Date() })).toThrow(TypeError);
    expect(() => canonicalize({ n: 10n })).toThrow(TypeError);
    expect(() => canonicalize({ s: new Set([1]) })).toThrow(TypeError);
    expect(() => canonicalize({ m: new Map() })).toThrow(TypeError);
    expect(() => canonicalize({ f: () => 1 })).toThrow(TypeError);
    expect(() => canonicalize({ n: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalize([undefined])).toThrow(TypeError);
    expect(() => canonicalize(Symbol("x"))).toThrow(TypeError);
  });

  test("refuses credential-looking properties", () => {
    for (const name of ["token", "Authorization", "accessToken", "grant", "passcode", "apiKey"]) {
      expect(() => canonicalize({ [name]: "x" })).toThrow(/credential/);
    }
    expect(() => canonicalize({ cursor: "abc", tokenCount: 3 })).not.toThrow();
  });
});

describe("workspace key predicates", () => {
  test("isWorkspaceKey excludes session keys and other users", () => {
    expect(isWorkspaceKey(scopedKey(scopeA, "billing", "state"), USER, WORKSPACE_A)).toBe(true);
    expect(isWorkspaceKey(scopedKey(scopeA, "billing", "state"), USER, WORKSPACE_B)).toBe(false);
    expect(isWorkspaceKey(sessionKey({ userId: USER }, "bootstrap"), USER)).toBe(false);
    expect(isWorkspaceKey(scopedKey(scopeA, "billing", "state"), "other")).toBe(false);
    expect(isWorkspaceKey(["nf-guest", "x"], USER)).toBe(false);
  });
});

describe("invalidation helpers", () => {
  test("invalidateScoped only touches the same identity, Workspace and domain", async () => {
    const client = new QueryClient();
    const scopeB = { userId: USER, workspaceId: WORKSPACE_B };
    const keys = {
      hit: scopedKey(scopeA, "projects", "detail", "p1"),
      hitList: scopedKey(scopeA, "projects", "list", { q: "x" }),
      otherDomain: scopedKey(scopeA, "clips", "list"),
      otherWorkspace: scopedKey(scopeB, "projects", "detail", "p1"),
      otherUser: scopedKey({ userId: "u2", workspaceId: WORKSPACE_A }, "projects", "detail", "p1"),
    };
    for (const key of Object.values(keys)) client.setQueryData(key as unknown[], 1);
    await invalidateScoped(client, scopeA, "projects");
    const invalid = (key: readonly unknown[]) =>
      client.getQueryState(key as unknown[])?.isInvalidated;
    expect(invalid(keys.hit)).toBe(true);
    expect(invalid(keys.hitList)).toBe(true);
    expect(invalid(keys.otherDomain)).toBe(false);
    expect(invalid(keys.otherWorkspace)).toBe(false);
    expect(invalid(keys.otherUser)).toBe(false);
  });

  test("invalidateSession leaves Workspace keys alone", async () => {
    const client = new QueryClient();
    const session = sessionKey({ userId: USER }, "bootstrap");
    const workspace = scopedKey(scopeA, "workspace", "bootstrap");
    client.setQueryData(session as unknown[], 1);
    client.setQueryData(workspace as unknown[], 1);
    await invalidateSession(client, { userId: USER });
    expect(client.getQueryState(session as unknown[])?.isInvalidated).toBe(true);
    expect(client.getQueryState(workspace as unknown[])?.isInvalidated).toBe(false);
  });
});

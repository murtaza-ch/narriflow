import { describe, expect, test } from "bun:test";
import { needsUserRefresh, type AppUser } from "./identity";

const HOUR = 60 * 60 * 1000;
const now = Date.parse("2026-11-04T12:00:00Z");
const user = (overrides: Partial<AppUser>) =>
  ({ primaryEmail: "a@example.test", emailVerifiedAt: new Date(now), lastSignInAt: new Date(now), updatedAt: new Date(now - 10 * HOUR), ...overrides }) as AppUser;

describe("needsUserRefresh", () => {
  test("a complete profile never asks Clerk", () => {
    expect(needsUserRefresh(user({}), now)).toBe(false);
  });

  test("a user missing a field asks Clerk at most hourly", () => {
    expect(needsUserRefresh(user({ lastSignInAt: null, updatedAt: new Date(now - 5 * 60_000) }), now)).toBe(false);
    expect(needsUserRefresh(user({ lastSignInAt: null, updatedAt: new Date(now - HOUR) }), now)).toBe(true);
    expect(needsUserRefresh(user({ primaryEmail: null }), now)).toBe(true);
    expect(needsUserRefresh(user({ emailVerifiedAt: null, updatedAt: new Date(now - 1000) }), now)).toBe(false);
  });
});

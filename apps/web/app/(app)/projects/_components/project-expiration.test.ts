import { describe, expect, test } from "bun:test";
import { formatProjectExpiryCountdown } from "./project-expiration";

describe("formatProjectExpiryCountdown", () => {
  const now = new Date("2026-08-20T00:00:00.000Z").getTime();

  test("formats day, hour, and minute boundaries", () => {
    expect(
      formatProjectExpiryCountdown("2026-08-22T03:00:00.000Z", now),
    ).toBe("Expires in 2d 3h");
    expect(
      formatProjectExpiryCountdown("2026-08-20T02:01:00.000Z", now),
    ).toBe("Expires in 3h");
    expect(
      formatProjectExpiryCountdown("2026-08-20T00:01:00.000Z", now),
    ).toBe("Expires in 1m");
  });

  test("locks to expiring now at the exact boundary", () => {
    expect(
      formatProjectExpiryCountdown("2026-08-20T00:00:00.000Z", now),
    ).toBe("Expiring now");
  });
});

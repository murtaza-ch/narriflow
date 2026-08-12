import { describe, expect, test } from "bun:test";
import {
  CalendarTimeError,
  workspaceLocalDateTimeToUtc,
} from "./calendar-time";

describe("workspaceLocalDateTimeToUtc", () => {
  test("converts a normal workspace wall-clock time to UTC", () => {
    expect(
      workspaceLocalDateTimeToUtc(
        "2026-07-15T09:00",
        "America/New_York",
      ).toISOString(),
    ).toBe("2026-07-15T13:00:00.000Z");
  });

  test("rejects a spring-forward time that never occurs", () => {
    expect(() =>
      workspaceLocalDateTimeToUtc(
        "2026-03-08T02:30",
        "America/New_York",
      ),
    ).toThrow(CalendarTimeError);
    try {
      workspaceLocalDateTimeToUtc(
        "2026-03-08T02:30",
        "America/New_York",
      );
    } catch (error) {
      expect((error as CalendarTimeError).code).toBe("nonexistent_local_time");
    }
  });

  test("rejects a fall-back time that maps to two instants", () => {
    try {
      workspaceLocalDateTimeToUtc(
        "2026-11-01T01:30",
        "America/New_York",
      );
      throw new Error("expected conversion to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CalendarTimeError);
      expect((error as CalendarTimeError).code).toBe("ambiguous_local_time");
    }
  });

  test("supports fractional-hour timezones", () => {
    expect(
      workspaceLocalDateTimeToUtc(
        "2026-07-15T09:00",
        "Asia/Kathmandu",
      ).toISOString(),
    ).toBe("2026-07-15T03:15:00.000Z");
  });
});

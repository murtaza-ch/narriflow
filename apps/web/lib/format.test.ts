import { expect, test } from "bun:test";
import { formatDateInputInTimeZone } from "./format";

test("derives date-input defaults from the workspace calendar day", () => {
  const instant = new Date("2026-09-02T22:30:00.000Z");

  expect(formatDateInputInTimeZone(instant, "America/Los_Angeles", 1)).toBe(
    "2026-09-03",
  );
  expect(formatDateInputInTimeZone(instant, "Asia/Karachi", 1)).toBe(
    "2026-09-04",
  );
  expect(formatDateInputInTimeZone(instant, "Not/A-Timezone", 1)).toBe("");
});

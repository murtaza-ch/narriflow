import { expect, test } from "bun:test";
import { formatDateInputInTimeZone, formatFileSize, formatUtcDateTime } from "./format";

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

test("formats file sizes in KB and MB, and nothing for a missing size", () => {
  expect(formatFileSize(null)).toBeNull();
  expect(formatFileSize(0)).toBeNull();
  expect(formatFileSize(500)).toBe("1 KB");
  expect(formatFileSize(340 * 1024)).toBe("340 KB");
  expect(formatFileSize(12.4 * 1024 * 1024)).toBe("12 MB");
  expect(formatFileSize(3.25 * 1024 * 1024)).toBe("3.3 MB");
});

test("formats instants in UTC whatever the viewer's zone", () => {
  expect(formatUtcDateTime("2026-11-04T14:32:00.000Z")).toBe("Nov 4, 2026 at 2:32 PM UTC");
});

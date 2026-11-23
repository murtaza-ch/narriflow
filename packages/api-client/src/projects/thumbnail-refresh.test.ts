import { expect, test } from "bun:test";
import { projectThumbnailRefreshInterval } from "./queries";

test("signed image access renews before the earliest expiry and stops when no image exists", () => {
  expect(projectThumbnailRefreshInterval([{ thumbnail: null }])).toBe(false);
  const interval = projectThumbnailRefreshInterval([
    { thumbnail: { expiresAt: new Date(Date.now() + 180_000).toISOString() } },
    { thumbnail: { expiresAt: new Date(Date.now() + 300_000).toISOString() } },
  ]);
  expect(interval).toBeGreaterThan(119_000); expect(interval as number).toBeLessThanOrEqual(120_000);
  expect(projectThumbnailRefreshInterval([{ thumbnail: { expiresAt: new Date(Date.now()).toISOString() } }])).toBe(1000);
});

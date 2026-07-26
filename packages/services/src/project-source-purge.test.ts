import { describe, expect, test } from "bun:test";
import {
  isProjectSourcePurgeEligible,
  purgeExpiredProjectSources,
  purgeOldWorkflowEvents,
  retentionCutoffDate,
  type ProjectSourcePurgeCandidate,
} from "./project.service";

const NOW_MS = 1_700_000_000_000; // fixed instant for deterministic math
const DAY_MS = 24 * 60 * 60 * 1000;

function candidate(
  overrides: Partial<ProjectSourcePurgeCandidate> = {},
): ProjectSourcePurgeCandidate {
  return {
    sourceStorageKey: "projects/p1/source.mp4",
    ingestStatus: "ready",
    ingestCompletedAt: new Date(NOW_MS - 100 * DAY_MS),
    hasActiveWorkflowRun: false,
    hasCompletedRender: true,
    ...overrides,
  };
}

describe("retentionCutoffDate", () => {
  test("subtracts retentionDays worth of milliseconds from nowMs", () => {
    expect(retentionCutoffDate(90, NOW_MS).getTime()).toBe(NOW_MS - 90 * DAY_MS);
    expect(retentionCutoffDate(1, NOW_MS).getTime()).toBe(NOW_MS - DAY_MS);
  });

  test("zero retention days returns the instant passed in", () => {
    expect(retentionCutoffDate(0, NOW_MS).getTime()).toBe(NOW_MS);
  });

  test("defaults nowMs to the current time when omitted", () => {
    const before = Date.now();
    const cutoff = retentionCutoffDate(0);
    const after = Date.now();
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before);
    expect(cutoff.getTime()).toBeLessThanOrEqual(after);
  });
});

describe("isProjectSourcePurgeEligible", () => {
  const options = { retentionDays: 90, nowMs: NOW_MS };

  test("is eligible once ingest is ready, nothing is in flight, a render is done, and retention has elapsed", () => {
    expect(isProjectSourcePurgeEligible(candidate(), options)).toBe(true);
  });

  test("is not eligible once the source key is already null (nothing to purge)", () => {
    expect(
      isProjectSourcePurgeEligible(
        candidate({ sourceStorageKey: null }),
        options,
      ),
    ).toBe(false);
  });

  test("is not eligible while ingest hasn't reached ready", () => {
    for (const ingestStatus of [
      "pending",
      "uploading",
      "queued",
      "downloading",
      "normalizing",
      "failed",
    ] as const) {
      expect(
        isProjectSourcePurgeEligible(candidate({ ingestStatus }), options),
      ).toBe(false);
    }
  });

  test("is not eligible while a workflow run is still queued or running", () => {
    expect(
      isProjectSourcePurgeEligible(
        candidate({ hasActiveWorkflowRun: true }),
        options,
      ),
    ).toBe(false);
  });

  // The specific guard called out in the fix: never delete a source before
  // any render output exists for it.
  test("is not eligible when no completed render exists yet", () => {
    expect(
      isProjectSourcePurgeEligible(
        candidate({ hasCompletedRender: false }),
        options,
      ),
    ).toBe(false);
  });

  test("is not eligible when ingestCompletedAt is missing", () => {
    expect(
      isProjectSourcePurgeEligible(
        candidate({ ingestCompletedAt: null }),
        options,
      ),
    ).toBe(false);
  });

  test("is not eligible when ingestCompletedAt does not parse to a valid date", () => {
    expect(
      isProjectSourcePurgeEligible(
        candidate({ ingestCompletedAt: "not-a-date" }),
        options,
      ),
    ).toBe(false);
  });

  test("is not eligible before the retention window has elapsed", () => {
    expect(
      isProjectSourcePurgeEligible(
        candidate({ ingestCompletedAt: new Date(NOW_MS - 10 * DAY_MS) }),
        options,
      ),
    ).toBe(false);
  });

  test("treats the retention boundary as exclusive: exactly at cutoff is not yet eligible, one ms past is", () => {
    const cutoffMs = NOW_MS - options.retentionDays * DAY_MS;

    expect(
      isProjectSourcePurgeEligible(
        candidate({ ingestCompletedAt: new Date(cutoffMs) }),
        options,
      ),
    ).toBe(false);

    expect(
      isProjectSourcePurgeEligible(
        candidate({ ingestCompletedAt: new Date(cutoffMs - 1) }),
        options,
      ),
    ).toBe(true);
  });

  test("accepts an ISO string for ingestCompletedAt, not just a Date", () => {
    expect(
      isProjectSourcePurgeEligible(
        candidate({
          ingestCompletedAt: new Date(NOW_MS - 100 * DAY_MS).toISOString(),
        }),
        options,
      ),
    ).toBe(true);
  });
});

describe("purgeExpiredProjectSources / purgeOldWorkflowEvents (no database configured)", () => {
  // This package's tests run without DATABASE_URL set, matching
  // getPrismaClient()'s documented "no database" fallback. Both jobs must be
  // safe no-ops in that mode rather than throwing, since the worker reaper
  // calls them unconditionally on every tick.
  test("purgeExpiredProjectSources resolves to 0 without touching R2 or the DB", async () => {
    await expect(purgeExpiredProjectSources()).resolves.toBe(0);
    await expect(purgeExpiredProjectSources(30)).resolves.toBe(0);
  });

  test("purgeOldWorkflowEvents resolves to 0 without touching the DB", async () => {
    await expect(purgeOldWorkflowEvents()).resolves.toBe(0);
    await expect(purgeOldWorkflowEvents(7)).resolves.toBe(0);
  });
});

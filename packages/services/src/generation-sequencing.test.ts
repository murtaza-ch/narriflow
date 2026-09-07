import { describe, expect, test } from "bun:test";
import {
  autoTriggerIdempotencyKey,
  isQuotaBlockedMidFlight,
  isUniqueConstraintError,
  selectActionablePack,
} from "./generation-sequencing";

// Gate tests for the link-first sequencing contract
// (docs/plans/link-to-clips-uiux.md §6). The pure claim/selection semantics
// are tested here; the Prisma-transaction shells in project.service.ts are
// thin wrappers over these rules plus the DB uniques the migration adds.

describe("autoTriggerIdempotencyKey", () => {
  test("is deterministic per (project, pack) — both transition paths derive the same key", () => {
    const a = autoTriggerIdempotencyKey("proj-1", "pack-1");
    const b = autoTriggerIdempotencyKey("proj-1", "pack-1");
    expect(a).toBe(b);
    expect(a).toBe("auto:proj-1:pack-1");
  });

  test("differs per pack, so a re-configured project claims a distinct run", () => {
    expect(autoTriggerIdempotencyKey("proj-1", "pack-1")).not.toBe(
      autoTriggerIdempotencyKey("proj-1", "pack-2"),
    );
  });
});

describe("selectActionablePack (draft semantics)", () => {
  const at = (iso: string) => new Date(iso);

  test("returns the latest committed pack", () => {
    const picked = selectActionablePack([
      { id: "old", draft: false, createdAt: at("2026-07-01T00:00:00Z") },
      { id: "new", draft: false, createdAt: at("2026-07-02T00:00:00Z") },
    ]);
    expect(picked?.id).toBe("new");
  });

  test("STOPS when the latest pack is a draft — never falls back to an older committed pack", () => {
    const picked = selectActionablePack([
      { id: "committed", draft: false, createdAt: at("2026-07-01T00:00:00Z") },
      { id: "draft", draft: true, createdAt: at("2026-07-02T00:00:00Z") },
    ]);
    expect(picked).toBeNull();
  });

  test("a lone draft never auto-fires (Step 1 done, Step 2 not finished)", () => {
    expect(
      selectActionablePack([
        { id: "draft", draft: true, createdAt: at("2026-07-02T00:00:00Z") },
      ]),
    ).toBeNull();
  });

  test("no packs → no claim", () => {
    expect(selectActionablePack([])).toBeNull();
  });

  test("input order does not matter (sorts by createdAt, not array position)", () => {
    const picked = selectActionablePack([
      { id: "new", draft: false, createdAt: at("2026-07-03T00:00:00Z") },
      { id: "old", draft: true, createdAt: at("2026-07-01T00:00:00Z") },
    ]);
    expect(picked?.id).toBe("new");
  });
});

describe("isUniqueConstraintError (P2002 recovery)", () => {
  test("detects Prisma P2002 shapes", () => {
    expect(isUniqueConstraintError({ code: "P2002" })).toBe(true);
  });

  test("rejects other errors so real failures still throw", () => {
    expect(isUniqueConstraintError(new Error("boom"))).toBe(false);
    expect(isUniqueConstraintError({ code: "P2025" })).toBe(false);
    expect(isUniqueConstraintError(null)).toBe(false);
    expect(isUniqueConstraintError("P2002")).toBe(false);
  });
});

describe("concurrent run-claim simulation (both callers converge on one run)", () => {
  // Simulates the DB unique: first create wins, the second throws P2002; the
  // claim wrapper must catch it and return the winner. This mirrors the
  // catch-block contract in projectService.triggerGeneration.
  function makeClaimHarness() {
    const runsByKey = new Map<string, { id: string }>();
    let nextId = 0;

    async function claim(projectId: string, packId: string): Promise<string> {
      const key = autoTriggerIdempotencyKey(projectId, packId);
      const existing = runsByKey.get(key);
      if (existing) return existing.id; // pre-check fast path
      try {
        // Simulated create — the "unique index" is the map entry.
        if (runsByKey.has(key)) {
          throw { code: "P2002" };
        }
        const run = { id: `run-${++nextId}` };
        runsByKey.set(key, run);
        return run.id;
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          const winner = runsByKey.get(key);
          if (winner) return winner.id;
        }
        throw error;
      }
    }

    // A variant whose pre-check is stale (both callers passed the pre-check
    // before either created — the real interleaving that produced P2002).
    async function claimWithStalePrecheck(
      projectId: string,
      packId: string,
    ): Promise<string> {
      const key = autoTriggerIdempotencyKey(projectId, packId);
      try {
        if (runsByKey.has(key)) {
          throw { code: "P2002" };
        }
        const run = { id: `run-${++nextId}` };
        runsByKey.set(key, run);
        return run.id;
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          const winner = runsByKey.get(key);
          if (winner) return winner.id;
        }
        throw error;
      }
    }

    return { claim, claimWithStalePrecheck, runsByKey };
  }

  test("web finalize and worker completion claim concurrently → one run, same id, neither throws", async () => {
    const harness = makeClaimHarness();
    const [webRun, workerRun] = await Promise.all([
      harness.claimWithStalePrecheck("proj-1", "pack-1"),
      harness.claimWithStalePrecheck("proj-1", "pack-1"),
    ]);
    expect(webRun).toBe(workerRun);
    expect(harness.runsByKey.size).toBe(1);
  });

  test("sequential re-claim returns the existing run (refresh / SSE re-fire)", async () => {
    const harness = makeClaimHarness();
    const first = await harness.claim("proj-1", "pack-1");
    const second = await harness.claim("proj-1", "pack-1");
    expect(second).toBe(first);
  });

  test("a different pack id claims a distinct run (re-run after re-configure)", async () => {
    const harness = makeClaimHarness();
    const first = await harness.claim("proj-1", "pack-1");
    const second = await harness.claim("proj-1", "pack-2");
    expect(second).not.toBe(first);
    expect(harness.runsByKey.size).toBe(2);
  });
});

describe("isQuotaBlockedMidFlight (derived, never persisted)", () => {
  const base = {
    ingestReady: true,
    hasCommittedPack: true,
    hasAnyRun: false,
    tier: "free" as const,
    usedMinutes: 61,
  };

  test("ingest ready + committed pack + no run + over limit → blocked state shows", () => {
    expect(isQuotaBlockedMidFlight(base)).toBe(true);
  });

  test("exactly at the limit is NOT blocked — mirrors the authoritative gate's strict >", () => {
    expect(isQuotaBlockedMidFlight({ ...base, usedMinutes: 60 })).toBe(false);
  });

  test("clears when usage drops below the limit (upgrade / month rollover)", () => {
    expect(isQuotaBlockedMidFlight({ ...base, usedMinutes: 12 })).toBe(false);
  });

  test("clears once a run exists (successful re-claim)", () => {
    expect(isQuotaBlockedMidFlight({ ...base, hasAnyRun: true })).toBe(false);
  });

  test("not shown while ingest is still running or setup is unfinished", () => {
    expect(isQuotaBlockedMidFlight({ ...base, ingestReady: false })).toBe(false);
    expect(
      isQuotaBlockedMidFlight({ ...base, hasCommittedPack: false }),
    ).toBe(false);
  });

  test("higher tiers use their own limits", () => {
    expect(
      isQuotaBlockedMidFlight({ ...base, tier: "pro", usedMinutes: 60 }),
    ).toBe(false);
  });
});

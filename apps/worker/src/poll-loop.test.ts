import { describe, expect, test } from "bun:test";
import {
  createIsolatedPollLoop,
  stallBudgetMs,
  UNHEALTHY_CONSECUTIVE_STALLS,
  unhealthyLoops,
} from "./poll-loop";

describe("isolated worker poll loops", () => {
  test("billing reconciliation completes while an ingest tick remains busy", async () => {
    let releaseIngest!: () => void;
    const ingestBlocked = new Promise<void>((resolve) => {
      releaseIngest = resolve;
    });
    let accountsReconciled = 0;
    const ingest = createIsolatedPollLoop({
      name: "ingest",
      run: async () => {
        await ingestBlocked;
        return 1;
      },
      maximumConsecutiveFailures: 3,
      stallAfterMs: 60_000,
    });
    const billing = createIsolatedPollLoop({
      name: "workspace_billing",
      run: async () => {
        accountsReconciled += 1;
        return 1;
      },
      maximumConsecutiveFailures: 3,
      stallAfterMs: 60_000,
    });

    const ingestTick = ingest.tick();
    await billing.tick();

    expect(ingest.status().polling).toBe(true);
    expect(billing.status().polling).toBe(false);
    expect(accountsReconciled).toBe(1);
    releaseIngest();
    await ingestTick;
  });

  test("a hung billing provider does not block another worker loop", async () => {
    let releaseProvider!: () => void;
    const providerBlocked = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    let notificationsProcessed = 0;
    const billing = createIsolatedPollLoop({
      name: "workspace_billing",
      run: async () => {
        await providerBlocked;
        return 1;
      },
      maximumConsecutiveFailures: 3,
      stallAfterMs: 60_000,
    });
    const notifications = createIsolatedPollLoop({
      name: "notification_retry",
      run: async () => {
        notificationsProcessed += 1;
        return 1;
      },
      maximumConsecutiveFailures: 3,
      stallAfterMs: 60_000,
    });

    const billingTick = billing.tick();
    await notifications.tick();

    expect(billing.status().polling).toBe(true);
    expect(notificationsProcessed).toBe(1);
    releaseProvider();
    await billingTick;
  });
});

const never = () => new Promise<never>(() => {});

describe("poll loop stall watchdog", () => {
  test("without a watchdog a tick that never settles ends the loop silently", async () => {
    let runs = 0;
    const loop = createIsolatedPollLoop({
      name: "ingest",
      run: () => {
        runs += 1;
        return never();
      },
      maximumConsecutiveFailures: 3,
      stallAfterMs: 60_000,
    });

    void loop.tick();
    await loop.tick();
    await loop.tick();

    expect(runs).toBe(1);
    expect(loop.status().polling).toBe(true);
  });

  test("a tick over its budget is abandoned, reported, and the loop resumes", async () => {
    const stalls: number[] = [];
    let runs = 0;
    const loop = createIsolatedPollLoop({
      name: "ingest",
      run: async () => {
        runs += 1;
        if (runs === 1) return never();
        return 1;
      },
      maximumConsecutiveFailures: 3,
      stallAfterMs: 20,
      onStall: ({ consecutiveStalls }) => stalls.push(consecutiveStalls),
    });

    await loop.tick();
    expect(stalls).toEqual([1]);
    expect(loop.status().polling).toBe(false);

    await loop.tick();
    expect(runs).toBe(2);
    expect(loop.status().consecutiveStalls).toBe(0);
    expect(loop.status().totalStalls).toBe(1);
  });

  test("a stalled tick that later fails or resolves does not disturb the loop", async () => {
    let rejectLate!: (error: Error) => void;
    const failures: unknown[] = [];
    let processed = 0;
    let runs = 0;
    const loop = createIsolatedPollLoop({
      name: "ingest",
      run: () => {
        runs += 1;
        if (runs === 1) return new Promise<number>((_, reject) => (rejectLate = reject));
        return Promise.resolve(0);
      },
      maximumConsecutiveFailures: 1,
      stallAfterMs: 20,
      onProcessed: (count) => (processed += count),
      onFailure: (error) => failures.push(error),
      onFailureLimit: () => failures.push("limit"),
    });

    await loop.tick();
    rejectLate(new Error("Connection terminated unexpectedly"));
    await loop.tick();

    expect(failures).toEqual([]);
    expect(processed).toBe(0);
  });

  test("work under a held lease is not subject to the budget, its claim and aftermath are", async () => {
    let finishWork!: () => void;
    const work = new Promise<void>((resolve) => (finishWork = resolve));
    const stalls: number[] = [];
    const loop = createIsolatedPollLoop({
      name: "render",
      run: async ({ holdingLease }) => {
        await holdingLease(() => work);
        return never();
      },
      maximumConsecutiveFailures: 3,
      stallAfterMs: 20,
      onStall: ({ consecutiveStalls }) => stalls.push(consecutiveStalls),
    });

    const tick = loop.tick();
    await Bun.sleep(80);
    expect(stalls).toEqual([]);
    expect(loop.status().holdingLease).toBe(true);

    finishWork();
    await tick;
    expect(stalls).toEqual([1]);
    expect(loop.status().holdingLease).toBe(false);
  });

  test("a claim that hangs before the lease is taken is abandoned", async () => {
    const stalls: number[] = [];
    const loop = createIsolatedPollLoop({
      name: "render",
      run: async ({ holdingLease }) => {
        await never(); // lifecycle.claim() on a dead connection
        return holdingLease(async () => 1);
      },
      maximumConsecutiveFailures: 3,
      stallAfterMs: 20,
      onStall: ({ consecutiveStalls }) => stalls.push(consecutiveStalls),
    });
    await loop.tick();
    expect(stalls).toEqual([1]);
  });

  test("a late claim after abandonment never double-processes a job", async () => {
    // Claims are atomic and leased: each queued job can be handed out once.
    const queue = ["job-1"];
    const claim = () => queue.shift() ?? null;
    const executed: string[] = [];
    let releaseFirstClaim!: () => void;
    const firstClaimStuck = new Promise<void>((resolve) => (releaseFirstClaim = resolve));
    let calls = 0;
    const loop = createIsolatedPollLoop({
      name: "ingest",
      stallAfterMs: 20,
      maximumConsecutiveFailures: 3,
      run: async ({ holdingLease }) => {
        calls += 1;
        // The first tick's claim query is stuck; the database has not answered.
        if (calls === 1) await firstClaimStuck;
        const job = claim();
        if (!job) return 0;
        await holdingLease(async () => {
          executed.push(job);
        });
        return 1;
      },
    });

    await loop.tick(); // abandoned
    await loop.tick(); // claims and runs job-1
    releaseFirstClaim(); // the stuck tick resumes and finds nothing left
    await Bun.sleep(10);

    expect(executed).toEqual(["job-1"]);
  });
});

describe("worker health", () => {
  const base = {
    polling: false,
    consecutiveStalls: 0,
    totalStalls: 0,
    stallAfterMs: 1_000,
    holdingLease: false,
  };
  const at = (ms: number) => new Date(ms).toISOString();

  test("the budget never drops below a long stage's interval or fifteen minutes", () => {
    expect(stallBudgetMs(2_500)).toBe(15 * 60 * 1000);
    expect(stallBudgetMs(15 * 60 * 1000)).toBe(150 * 60 * 1000);
  });

  test("a loop that keeps being abandoned makes the worker unhealthy", () => {
    const loops = [
      { name: "ingest", status: { ...base, lastPollAt: at(0), consecutiveStalls: UNHEALTHY_CONSECUTIVE_STALLS } },
      { name: "stt", status: { ...base, lastPollAt: at(0), consecutiveStalls: 1 } },
    ];
    expect(unhealthyLoops(loops, new Date(0))).toEqual(["ingest"]);
  });

  test("a loop that has not polled for two budgets is unhealthy unless it holds a lease", () => {
    const stale = at(0);
    const loops = [
      { name: "wedged", status: { ...base, lastPollAt: stale } },
      { name: "rendering", status: { ...base, lastPollAt: stale, holdingLease: true } },
      { name: "recent", status: { ...base, lastPollAt: at(1_500) } },
      { name: "not_yet", status: { ...base, lastPollAt: null } },
    ];
    expect(unhealthyLoops(loops, new Date(2_001))).toEqual(["wedged"]);
  });
});

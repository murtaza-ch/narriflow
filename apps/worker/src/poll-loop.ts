/** What a tick's `run` may tell its loop about the work it is doing. */
export interface PollRunContext {
  /**
   * Wraps work that owns a heartbeated lease (a claimed workflow attempt or
   * ingest job). A render or link download legitimately outlives any tick
   * budget, and its lease heartbeat — which aborts the work when the lease is
   * lost — is what bounds it, so the stall budget is paused for the duration.
   * Only the claim before it and the bookkeeping after it are watched.
   */
  holdingLease: <T>(work: () => Promise<T>) => Promise<T>;
}

export interface PollLoopStatus {
  polling: boolean;
  lastPollAt: string | null;
  /** Last tick settlement, including work that held a lease for a long time. */
  lastFinishedAt: string | null;
  /** Ticks abandoned since the last tick that settled on its own. */
  consecutiveStalls: number;
  /** Ticks abandoned over the loop's lifetime. */
  totalStalls: number;
  /** Unleased time after which a still-running tick is abandoned. */
  stallAfterMs: number;
  /** True while the tick is running leased work (not subject to the budget). */
  holdingLease: boolean;
}

export interface PollLoop {
  name: string;
  tick: () => Promise<void>;
  status: () => PollLoopStatus;
}

/**
 * The unleased time one tick may take before the loop abandons it. Ten
 * intervals, never under fifteen minutes: far past any healthy claim or batch
 * (every DB call has its own connect and query timeout), and still short
 * enough that a wedged worker recovers within a coffee break.
 */
export function stallBudgetMs(intervalMs: number): number {
  return Math.max(15 * 60 * 1000, 10 * intervalMs);
}

/** Consecutive abandoned ticks after which the worker reports itself unhealthy. */
export const UNHEALTHY_CONSECUTIVE_STALLS = 3;

export function createIsolatedPollLoop(input: {
  name: string;
  run: (context: PollRunContext) => Promise<number>;
  maximumConsecutiveFailures: number;
  /** See `stallBudgetMs`. */
  stallAfterMs: number;
  now?: () => Date;
  onProcessed?: (count: number) => void;
  onFailure?: (error: unknown, consecutiveFailures: number) => void;
  onFailureLimit?: (consecutiveFailures: number) => void;
  onStall?: (stall: { stallAfterMs: number; consecutiveStalls: number }) => void;
}): PollLoop {
  let polling = false;
  let holdingLease = false;
  let lastPollAt: string | null = null;
  let lastFinishedAt: string | null = null;
  let consecutiveFailures = 0;
  let consecutiveStalls = 0;
  let totalStalls = 0;

  return {
    name: input.name,
    status: () => ({
      polling,
      lastPollAt,
      lastFinishedAt,
      consecutiveStalls,
      totalStalls,
      stallAfterMs: input.stallAfterMs,
      holdingLease,
    }),
    tick: async () => {
      if (polling) return;
      polling = true;
      lastPollAt = (input.now?.() ?? new Date()).toISOString();

      // A tick whose work never settles (a query on a dead connection) would
      // otherwise hold `polling` forever and silently end the loop. After the
      // budget the tick is abandoned: its late result is ignored and the loop
      // resumes. Abandoning is safe because every claim is a conditional
      // database update with a lease — a later tick or a peer can only claim
      // what is unowned or expired, never what this abandoned tick holds.
      let abandoned = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let markStalled!: () => void;
      const stalled = new Promise<"stalled">((resolve) => {
        markStalled = () => resolve("stalled");
      });
      const arm = () => {
        clearTimeout(timer);
        if (abandoned) return;
        timer = setTimeout(markStalled, input.stallAfterMs);
      };
      const context: PollRunContext = {
        holdingLease: async (work) => {
          clearTimeout(timer);
          holdingLease = !abandoned;
          try {
            return await work();
          } finally {
            if (!abandoned) holdingLease = false;
            arm();
          }
        },
      };

      arm();
      const settled = input.run(context).then(
        (processed) => ({ processed }) as const,
        (error: unknown) => ({ error }) as const,
      );
      try {
        const outcome = await Promise.race([settled, stalled]);
        if (outcome === "stalled") {
          abandoned = true;
          holdingLease = false;
          consecutiveStalls += 1;
          totalStalls += 1;
          input.onStall?.({ stallAfterMs: input.stallAfterMs, consecutiveStalls });
          return;
        }
        consecutiveStalls = 0;
        if ("error" in outcome) {
          consecutiveFailures += 1;
          input.onFailure?.(outcome.error, consecutiveFailures);
          if (consecutiveFailures >= input.maximumConsecutiveFailures) {
            input.onFailureLimit?.(consecutiveFailures);
          }
          return;
        }
        consecutiveFailures = 0;
        if (outcome.processed > 0) input.onProcessed?.(outcome.processed);
      } finally {
        clearTimeout(timer);
        lastFinishedAt = (input.now?.() ?? new Date()).toISOString();
        polling = false;
      }
    },
  };
}

/**
 * Busy, unleased ticks retain their stall budget. Idle loops must poll within
 * twice their configured interval, allowing at least 30s for scheduling delays.
 * A finished long render starts a fresh idle window. Railway can restart a
 * worker whose scheduler stopped even though its HTTP server still answers.
 */
export function unhealthyLoops(
  loops: readonly { name: string; intervalMs: number; status: PollLoopStatus }[],
  now: Date = new Date(),
): string[] {
  return loops
    .filter(({ status, intervalMs }) => {
      if (status.consecutiveStalls >= UNHEALTHY_CONSECUTIVE_STALLS) return true;
      if (status.holdingLease || status.lastPollAt === null) return false;
      if (!status.polling) {
        const lastFinished = Date.parse(status.lastFinishedAt ?? status.lastPollAt);
        return now.getTime() - lastFinished > Math.max(30_000, 2 * intervalMs);
      }
      return now.getTime() - Date.parse(status.lastPollAt) > 2 * status.stallAfterMs;
    })
    .map(({ name }) => name);
}

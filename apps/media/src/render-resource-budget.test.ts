import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRenderConfig } from "./render-config";
import {
  RenderResourceBudget,
  RenderResourceDeferral,
  ScratchFileRefs,
  estimateRenderOutputBytes,
  freeSpaceFloorBytes,
  judgeAdmission,
  readDiskFacts,
  renderEncodeDeadlineMs,
  renderResourceBudgetFor,
  scratchLimitBytes,
  startTransferWatchdog,
  transferDeadlineMs,
  type BudgetEnvironment,
} from "./render-resource-budget";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const config = parseRenderConfig({});

function fakeClock() {
  let nowMs = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  let nextId = 1;
  return {
    nowMs: () => nowMs,
    setTimeout: (callback: () => void, delayMs: number) => {
      const id = nextId++;
      timers.set(id, { at: nowMs + delayMs, callback });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (handle: ReturnType<typeof setTimeout>) => void timers.delete(handle as unknown as number),
    /** Advances time, firing due timers in order (microtasks settle between them). */
    async advance(ms: number) {
      const target = nowMs + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        nowMs = due[1].at;
        due[1].callback();
        for (let turn = 0; turn < 5; turn++) await Promise.resolve();
      }
      nowMs = target;
    },
  };
}

function diskOf(freeBytes: number, volumeBytes = 100 * GIB) {
  let free = freeBytes;
  return {
    set: (value: number) => {
      free = value;
    },
    statfs: async () => ({ bavail: free, bsize: 1, blocks: volumeBytes }),
  };
}

function environment(overrides: Partial<BudgetEnvironment> & { disk?: ReturnType<typeof diskOf> } = {}): BudgetEnvironment {
  const clock = fakeClock();
  return {
    statfs: (overrides.disk ?? diskOf(50 * GIB)).statfs,
    nowMs: clock.nowMs,
    sleep: async (ms) => clock.advance(ms),
    ...overrides,
  };
}

describe("encode deadline", () => {
  const sdr = { sourceWidth: 1920, sourceHeight: 1080, hdr: false };

  test("is the floor for short clips and 20x the edited duration in the middle", () => {
    expect(renderEncodeDeadlineMs({ ...sdr, editedDurationSec: 0 }, config)).toBe(300_000);
    expect(renderEncodeDeadlineMs({ ...sdr, editedDurationSec: 10 }, config)).toBe(300_000);
    expect(renderEncodeDeadlineMs({ ...sdr, editedDurationSec: 30 }, config)).toBe(600_000);
  });

  test("4K and HDR work get proportionally more time, up to the configured ceiling", () => {
    const base = renderEncodeDeadlineMs({ ...sdr, editedDurationSec: 20 }, config);
    const fourK = renderEncodeDeadlineMs({ editedDurationSec: 20, sourceWidth: 3840, sourceHeight: 2160, hdr: false }, config);
    const hdr = renderEncodeDeadlineMs({ editedDurationSec: 20, sourceWidth: 3840, sourceHeight: 2160, hdr: true }, config);
    expect(base).toBe(400_000);
    expect(fourK).toBe(base * 4);
    expect(hdr).toBe(config.renderCommandTimeoutMs);
    expect(renderEncodeDeadlineMs({ ...sdr, editedDurationSec: 20, hdr: true }, config)).toBe(base * 3);
  });

  test("smaller-than-1080p sources never shrink the allowance", () => {
    expect(renderEncodeDeadlineMs({ editedDurationSec: 30, sourceWidth: 640, sourceHeight: 360, hdr: false }, config)).toBe(600_000);
  });

  test("is finite and inside [floor, ceiling] at every extreme", () => {
    const sizes = [0, 0.001, 1, 3600, 86_400, 1e12, Number.MAX_VALUE];
    for (const editedDurationSec of sizes) {
      for (const hdr of [false, true]) {
        for (const [sourceWidth, sourceHeight] of [[0, 0], [1, 1], [7680, 4320], [1e9, 1e9]] as const) {
          const ms = renderEncodeDeadlineMs({ editedDurationSec, sourceWidth, sourceHeight, hdr }, config);
          expect(Number.isFinite(ms)).toBe(true);
          expect(ms).toBeGreaterThanOrEqual(config.renderDeadlineFloorMs);
          expect(ms).toBeLessThanOrEqual(config.renderCommandTimeoutMs);
        }
      }
    }
  });

  test("unknown or invalid durations get the ceiling, not a short guess", () => {
    for (const editedDurationSec of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(renderEncodeDeadlineMs({ ...sdr, editedDurationSec }, config)).toBe(config.renderCommandTimeoutMs);
    }
  });

  test("a floor above the ceiling cannot exceed the ceiling", () => {
    expect(renderEncodeDeadlineMs({ ...sdr, editedDurationSec: 1 }, { ...config, renderDeadlineFloorMs: 9_999_999 })).toBe(
      config.renderCommandTimeoutMs,
    );
  });
});

describe("transfer deadline", () => {
  test("is 30s plus bytes at the minimum rate, between the floor and the ceiling", () => {
    expect(transferDeadlineMs(0, config)).toBe(120_000);
    expect(transferDeadlineMs(500 * MIB, config)).toBe(30_000 + 500_000);
    expect(transferDeadlineMs(500 * GIB, config)).toBe(1_800_000);
  });

  test("unknown or invalid sizes use the ceiling", () => {
    for (const bytes of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, -5]) {
      expect(transferDeadlineMs(bytes, config)).toBe(1_800_000);
    }
  });
});

describe("disk admission", () => {
  test("the free-space floor and scratch limit follow the spec", () => {
    expect(freeSpaceFloorBytes(config, 100 * GIB)).toBe(10 * GIB);
    expect(freeSpaceFloorBytes(config, 4 * GIB)).toBe(1 * GIB);
    expect(scratchLimitBytes(config, 100 * GIB)).toBe(8 * GIB);
    expect(scratchLimitBytes(config, 10 * GIB)).toBe(5 * GIB);
  });

  test("verdicts distinguish low disk, a full scratch ledger and a request that can never fit", () => {
    const facts = { freeBytes: 30 * GIB, volumeBytes: 100 * GIB };
    expect(judgeAdmission(config, facts, 0, 1 * GIB)).toBe("admit");
    expect(judgeAdmission(config, { freeBytes: 11 * GIB, volumeBytes: 100 * GIB }, 0, 2 * GIB)).toBe("wait_disk_low");
    expect(judgeAdmission(config, facts, 7 * GIB, 2 * GIB)).toBe("wait_scratch_full");
    expect(judgeAdmission(config, facts, 0, 9 * GIB)).toBe("never_fits");
    expect(judgeAdmission(config, { freeBytes: Number.NaN, volumeBytes: 100 * GIB }, 0, 1)).toBe("wait_disk_low");
    expect(judgeAdmission(config, { freeBytes: 1, volumeBytes: 0 }, 0, 1)).toBe("wait_disk_low");
  });

  test("readDiskFacts falls back to the nearest existing parent for a scratch path not created yet", async () => {
    const seen: string[] = [];
    const facts = await readDiskFacts("/missing/a/b", async (path) => {
      seen.push(path);
      if (path !== "/") throw new Error("ENOENT");
      return { bavail: 10, bsize: 2, blocks: 100 };
    });
    expect(seen).toEqual(["/missing/a/b", "/missing/a", "/missing", "/"]);
    expect(facts).toEqual({ freeBytes: 20, volumeBytes: 200 });
  });

  test("the output estimate has a floor and grows with duration", () => {
    expect(estimateRenderOutputBytes(0)).toBe(16 * MIB);
    expect(estimateRenderOutputBytes(60)).toBe(120 * MIB);
    expect(estimateRenderOutputBytes(Number.NaN)).toBe(16 * MIB);
  });
});

describe("RenderResourceBudget disk waiting", () => {
  test("waits with backoff until space returns, then admits", async () => {
    const budget = new RenderResourceBudget({ ...config, diskAdmissionWaitMs: 60_000 });
    const clock = fakeClock();
    const disk = diskOf(11 * GIB);
    const sleeps: number[] = [];
    const result = await budget.reserve(
      { directory: "/scratch", bytes: 2 * GIB, kind: "source" },
      {
        statfs: disk.statfs,
        nowMs: clock.nowMs,
        sleep: async (ms) => {
          sleeps.push(ms);
          if (sleeps.length === 3) disk.set(40 * GIB);
          await clock.advance(ms);
        },
      },
    );
    expect(sleeps).toEqual([1_000, 2_000, 4_000]);
    expect(result.bytes).toBe(2 * GIB);
    expect(budget.snapshot().reservedBytes).toBe(2 * GIB);
    result.release();
    expect(budget.snapshot().reservedBytes).toBe(0);
  });

  test("defers with a typed retryable failure after the configured wait, holding nothing", async () => {
    const budget = new RenderResourceBudget({ ...config, diskAdmissionWaitMs: 10_000 });
    const clock = fakeClock();
    const error = await budget
      .reserve(
        { directory: "/scratch", bytes: 1 * GIB, kind: "source" },
        { statfs: diskOf(1 * GIB).statfs, nowMs: clock.nowMs, sleep: (ms) => clock.advance(ms) },
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RenderResourceDeferral);
    expect(error).toMatchObject({ code: "render_scratch_disk_low", disposition: "retryable" });
    expect(budget.snapshot().reservations).toBe(0);
  });

  test("a zero wait defers immediately and a request larger than the scratch limit is rejected without waiting", async () => {
    const budget = new RenderResourceBudget({ ...config, diskAdmissionWaitMs: 0 });
    let slept = false;
    const env = { ...environment({ disk: diskOf(2 * GIB) }), sleep: async () => {
        slept = true;
      },
    };
    await expect(budget.reserve({ directory: "/s", bytes: 1 * GIB, kind: "source" }, env)).rejects.toBeInstanceOf(RenderResourceDeferral);
    await expect(
      budget.reserve({ directory: "/s", bytes: 9 * GIB, kind: "source" }, { ...env, statfs: diskOf(90 * GIB).statfs }),
    ).rejects.toMatchObject({ code: "render_scratch_limit_exceeded" });
    expect(slept).toBe(false);
  });

  test("outstanding reservations count against free space and the scratch ledger", async () => {
    const budget = new RenderResourceBudget({ ...config, diskAdmissionWaitMs: 0 });
    const env = environment({ disk: diskOf(30 * GIB) });
    const first = await budget.reserve({ directory: "/s", bytes: 6 * GIB, kind: "source" }, env);
    await expect(budget.reserve({ directory: "/s", bytes: 3 * GIB, kind: "source" }, env)).rejects.toMatchObject({
      code: "render_scratch_limit_reached",
    });
    first.release();
    (await budget.reserve({ directory: "/s", bytes: 3 * GIB, kind: "source" }, env)).release();
  });

  test("cancellation interrupts the backoff", async () => {
    const budget = new RenderResourceBudget({ ...config, diskAdmissionWaitMs: 60_000 });
    const controller = new AbortController();
    const env: BudgetEnvironment = {
      statfs: diskOf(1 * GIB).statfs,
      nowMs: () => 0,
      sleep: async (_ms, signal) => {
        controller.abort(new DOMException("stop", "AbortError"));
        signal?.throwIfAborted();
      },
      signal: controller.signal,
    };
    await expect(budget.reserve({ directory: "/s", bytes: 1 * GIB, kind: "source" }, env)).rejects.toMatchObject({ name: "AbortError" });
    expect(budget.snapshot().reservations).toBe(0);
  });
});

describe("RenderResourceBudget upload backlog", () => {
  const policy = { ...config, uploadMaxWaitingJobs: 2, uploadMaxWaitingBytes: 512 * MIB };
  const small = 100 * MIB;

  test("a slow uploader holds back the producer at two waiting jobs while one overlap slot stays open", async () => {
    const budget = new RenderResourceBudget(policy);
    const env = environment();
    const a = await budget.reserve({ directory: "/s", bytes: small, kind: "output" }, env);
    a.queued(small);
    const b = await budget.reserve({ directory: "/s", bytes: small, kind: "output" }, env);
    b.queued(small);
    let third = false;
    const pending = budget.reserve({ directory: "/s", bytes: small, kind: "output" }, env).then((reservation) => {
      third = true;
      return reservation;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(third).toBe(false);
    expect(budget.snapshot()).toMatchObject({ waitingUploads: 2, blockedProducers: 1 });
    a.uploading();
    const c = await pending;
    expect(third).toBe(true);
    expect(budget.snapshot()).toMatchObject({ waitingUploads: 1, activeUploads: 1, reservations: 3 });
    for (const reservation of [a, b, c]) reservation.release();
    expect(budget.snapshot()).toMatchObject({ reservations: 0, reservedBytes: 0 });
  });

  test("waiting bytes bound the backlog independently of the job count", async () => {
    const budget = new RenderResourceBudget({ ...policy, uploadMaxWaitingJobs: 8 });
    const env = environment();
    const a = await budget.reserve({ directory: "/s", bytes: 300 * MIB, kind: "output" }, env);
    a.queued(300 * MIB);
    let admitted = false;
    const pending = budget.reserve({ directory: "/s", bytes: 300 * MIB, kind: "output" }, env).then((reservation) => {
      admitted = true;
      return reservation;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(admitted).toBe(false);
    a.release();
    (await pending).release();
  });

  test("an output larger than the waiting-bytes limit takes the replica exclusively", async () => {
    const budget = new RenderResourceBudget(policy);
    const env = environment();
    const active = await budget.reserve({ directory: "/s", bytes: small, kind: "output" }, env);
    active.queued(small);
    active.uploading();
    let admitted = false;
    const pending = budget.reserve({ directory: "/s", bytes: 600 * MIB, kind: "output" }, env).then((reservation) => {
      admitted = true;
      return reservation;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(admitted).toBe(false);
    active.release();
    const large = await pending;
    expect(admitted).toBe(true);
    large.release();
  });

  test("cancellation wakes a blocked producer and releases nothing it never held", async () => {
    const budget = new RenderResourceBudget({ ...policy, uploadMaxWaitingJobs: 1 });
    const controller = new AbortController();
    const env = { ...environment(), signal: controller.signal };
    const a = await budget.reserve({ directory: "/s", bytes: small, kind: "output" }, env);
    a.queued(small);
    const blocked = budget.reserve({ directory: "/s", bytes: small, kind: "output" }, env);
    await Promise.resolve();
    expect(budget.snapshot().blockedProducers).toBe(1);
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(blocked).rejects.toMatchObject({ name: "AbortError" });
    expect(budget.snapshot()).toMatchObject({ blockedProducers: 0, reservations: 1 });
    a.release();
  });

  test("source downloads never wait on the output backlog, and release is idempotent", async () => {
    const budget = new RenderResourceBudget({ ...policy, uploadMaxWaitingJobs: 1 });
    const env = environment();
    const a = await budget.reserve({ directory: "/s", bytes: small, kind: "output" }, env);
    a.queued(small);
    const source = await budget.reserve({ directory: "/s", bytes: small, kind: "source" }, env);
    source.release();
    source.release();
    a.release();
    a.release();
    expect(budget.snapshot().reservations).toBe(0);
  });

  test("queued replaces the estimate with the measured size", async () => {
    const budget = new RenderResourceBudget(policy);
    const reservation = await budget.reserve({ directory: "/s", bytes: 200 * MIB, kind: "output" }, environment());
    reservation.queued(50 * MIB);
    expect(budget.snapshot().waitingUploadBytes).toBe(50 * MIB);
    reservation.release();
  });

  test("tracks the single full encode for background schedulers", async () => {
    const budget = new RenderResourceBudget(policy);
    expect(budget.snapshot().encoding).toBe(false);
    await budget.trackEncode(async () => expect(budget.snapshot().encoding).toBe(true));
    await expect(
      budget.trackEncode(async () => {
        throw new Error("encode failed");
      }),
    ).rejects.toThrow("encode failed");
    expect(budget.snapshot().encoding).toBe(false);
  });

  test("one process-wide budget per frozen config", () => {
    expect(renderResourceBudgetFor(config)).toBe(renderResourceBudgetFor(config));
    expect(renderResourceBudgetFor(parseRenderConfig({}))).not.toBe(renderResourceBudgetFor(config));
  });
});

describe("ScratchFileRefs", () => {
  test("unlinks at the last release and keeps a file an active upload still needs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "narriflow-refs-test-"));
    try {
      const path = join(directory, "out.mp4");
      await writeFile(path, "bytes");
      const refs = new ScratchFileRefs();
      refs.retain(path); // producer
      refs.retain(path); // upload
      await refs.release(path);
      expect(await readdir(directory)).toEqual(["out.mp4"]);
      expect(refs.count(path)).toBe(1);
      await refs.release(path);
      expect(await readdir(directory)).toEqual([]);
      await refs.release(path); // already gone: harmless
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("a failing unlink is reported and does not throw", async () => {
    const failures: string[] = [];
    const refs = new ScratchFileRefs(
      async () => {
        throw new Error("EBUSY");
      },
      (path) => failures.push(path),
    );
    refs.retain("/x");
    await refs.release("/x");
    expect(failures).toEqual(["/x"]);
    await mkdir(tmpdir(), { recursive: true });
  });
});

describe("transfer watchdog", () => {
  test("aborts a download that outlives its deadline with a typed retryable failure", async () => {
    const clock = fakeClock();
    const watchdog = startTransferWatchdog({
      deadlineMs: 10_000,
      noProgressMs: 60_000,
      measureBytes: async () => Math.floor(clock.nowMs() / 1000),
      clock,
      codePrefix: "source_download",
    });
    await clock.advance(9_999);
    expect(watchdog.signal.aborted).toBe(false);
    await clock.advance(1);
    expect(watchdog.signal.aborted).toBe(true);
    expect(watchdog.failure()).toMatchObject({ code: "source_download_timeout", disposition: "retryable" });
    expect(watchdog.signal.reason).toBe(watchdog.failure());
  });

  test("aborts when the byte count stops growing, but not while it grows", async () => {
    const clock = fakeClock();
    let bytes = 0;
    const watchdog = startTransferWatchdog({
      deadlineMs: 600_000,
      noProgressMs: 30_000,
      pollMs: 5_000,
      measureBytes: async () => bytes,
      clock,
      codePrefix: "source_download",
    });
    for (let second = 0; second < 120; second += 5) {
      bytes += 1024;
      await clock.advance(5_000);
    }
    expect(watchdog.signal.aborted).toBe(false);
    await clock.advance(40_000);
    expect(watchdog.failure()).toMatchObject({ code: "source_download_stalled" });
    watchdog.stop();
  });

  test("a file that does not exist yet counts as no progress, and stop disarms everything", async () => {
    const clock = fakeClock();
    const stalled = startTransferWatchdog({
      deadlineMs: 600_000,
      noProgressMs: 10_000,
      pollMs: 2_000,
      measureBytes: async () => {
        throw new Error("ENOENT");
      },
      clock,
      codePrefix: "source_download",
    });
    await clock.advance(12_000);
    expect(stalled.failure()).toMatchObject({ code: "source_download_stalled" });

    const stopped = startTransferWatchdog({
      deadlineMs: 5_000,
      noProgressMs: 1_000,
      measureBytes: async () => 0,
      clock,
      codePrefix: "source_download",
    });
    stopped.stop();
    await clock.advance(60_000);
    expect(stopped.signal.aborted).toBe(false);
    expect(stopped.failure()).toBeNull();
  });

  test("follows the attempt signal without recording a watchdog failure", async () => {
    const clock = fakeClock();
    const parent = new AbortController();
    const watchdog = startTransferWatchdog({
      parent: parent.signal,
      deadlineMs: 5_000,
      noProgressMs: 1_000,
      measureBytes: async () => 0,
      clock,
      codePrefix: "source_download",
    });
    const cancelled = new DOMException("cancelled", "AbortError");
    parent.abort(cancelled);
    expect(watchdog.signal.aborted).toBe(true);
    expect(watchdog.signal.reason).toBe(cancelled);
    expect(watchdog.failure()).toBeNull();
    watchdog.stop();
  });
});

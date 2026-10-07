import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";
import {
  IngestJobClaimLost,
  IngestJobLifecycle,
  type IngestJobLifecycleDependencies,
} from "./ingest-job-lifecycle";

function harness() {
  let clock = 0;
  let callback: (() => void) | undefined;
  let cancelled = false;
  let renewals = 0;
  let seq = 0;
  const claim = { id: "job", projectId: "project", claimId: "claim" };
  const lease = {
    claimId: "claim" as string | null,
    expiresAt: 10_000 as number | null,
    status: "running",
    attemptCount: 1,
  };
  const tx = {
    ingestJob: {
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        if (
          where.claimId !== lease.claimId ||
          lease.status !== "running" ||
          (lease.expiresAt ?? 0) <= clock
        )
          return { count: 0 };
        if (data.claimExpiresAt instanceof Date) {
          lease.expiresAt = data.claimExpiresAt.getTime();
          renewals++;
        }
        if (data.status === "queued") {
          lease.status = "queued";
          lease.claimId = null;
          lease.expiresAt = null;
          lease.attemptCount--;
        }
        return { count: 1 };
      },
    },
    project: { update: async () => ({ workflowEventSeq: ++seq }) },
    workflowEvent: { create: async () => ({ id: "event" }) },
  };
  const dependencies = {
    prisma: {
      $transaction: async (
        work: (transaction: typeof tx) => Promise<unknown>,
      ) => work(tx),
    } as unknown as PrismaClient,
    workflow: {
      admitWithHandoff: async () => {
        throw new Error("unexpected generation");
      },
    },
    now: () => new Date(clock),
    leaseMs: 10_000,
    heartbeatMs: 2_000,
    requireRetryActor: async () => {},
    usage: {
      reserve: async () => {
        throw new Error("unexpected reservation");
      },
      settle: async () => {
        throw new Error("unexpected settlement");
      },
      release: async () => false,
    },
    scheduler: {
      schedule: (tick: () => void) => {
        callback = tick;
        return 1;
      },
      cancel: () => {
        cancelled = true;
      },
    },
  } satisfies IngestJobLifecycleDependencies;
  const lifecycle = new IngestJobLifecycle(dependencies);
  return {
    lifecycle,
    claim,
    lease,
    advance(ms: number) {
      clock += ms;
    },
    tick() {
      if (!cancelled) callback?.();
    },
    get cancelled() {
      return cancelled;
    },
    get renewals() {
      return renewals;
    },
  };
}
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("Ingest execution claim lifetime", () => {
  test("shutdown during claim acquisition never starts work and releases the late claim", async () => {
    const h = harness();
    const shutdown = new AbortController();
    shutdown.abort(new Error("worker shutdown"));
    let started = false;
    await h.lifecycle.runClaim(
      h.claim,
      async () => {
        started = true;
      },
      { signal: shutdown.signal },
    );
    expect(started).toBe(false);
    expect(h.lease.status).toBe("queued");
    expect(h.lease.attemptCount).toBe(0);
    expect(h.renewals).toBe(0);
  });
  test("fake-clock heartbeat keeps long work owned and shuts down without retry cost", async () => {
    const h = harness();
    const shutdown = new AbortController();
    const work = h.lifecycle.runClaim(
      h.claim,
      ({ signal }) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
      { signal: shutdown.signal },
    );
    for (let tick = 0; tick < 8; tick++) {
      h.advance(2_000);
      h.tick();
      await flush();
    }
    expect(h.renewals).toBe(8);
    expect(h.lease.status).toBe("running");
    expect(h.lease.expiresAt).toBe(26_000);
    shutdown.abort(new Error("worker shutdown"));
    await work;
    expect(h.cancelled).toBe(true);
    expect(h.lease.status).toBe("queued");
    expect(h.lease.attemptCount).toBe(0);
    h.tick();
    expect(h.renewals).toBe(8);
  });
  test("shutdown fences a handler that ignores cancellation before waiting for it", async () => {
    const h = harness();
    const shutdown = new AbortController();
    let finish!: () => void;
    const work = h.lifecycle.runClaim(
      h.claim,
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
      { signal: shutdown.signal },
    );
    shutdown.abort(new Error("worker shutdown"));
    await flush();
    expect(h.cancelled).toBe(true);
    expect(h.lease.status).toBe("queued");
    expect(h.lease.attemptCount).toBe(0);
    finish();
    await work;
    expect(h.lease.attemptCount).toBe(0);
  });
  test("a missed lease aborts work with claim loss and preserves another worker's ownership", async () => {
    const h = harness();
    const work = h.lifecycle.runClaim(
      h.claim,
      ({ signal }) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const observed = work.catch((error) => error);
    h.advance(10_000);
    h.tick();
    expect(await observed).toBeInstanceOf(IngestJobClaimLost);
    expect(h.cancelled).toBe(true);
    expect(h.lease.status).toBe("running");
    expect(h.lease.attemptCount).toBe(1);
  });
});

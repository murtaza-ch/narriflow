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
  const claim = { id: "job", projectId: "60000000-0000-4000-8000-000000000001", claimId: "claim" };
  const lease = {
    claimId: "claim" as string | null,
    expiresAt: 10_000 as number | null,
    status: "running",
    attemptCount: 1,
    startedAt: new Date(0) as Date | null,
  };
  const tx = {
    ingestJob: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        where.claimId === lease.claimId && lease.status === "running" && (lease.expiresAt ?? 0) > clock
          ? { id: claim.id, projectId: claim.projectId, attemptCount: lease.attemptCount, startedAt: lease.startedAt }
          : null,
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
          lease.startedAt = null;
          if (data.attemptCount && typeof data.attemptCount === "object" && "decrement" in data.attemptCount) {
            lease.attemptCount -= Number(data.attemptCount.decrement);
          }
        }
        return { count: 1 };
      },
    },
    project: { update: async () => ({ workflowEventSeq: ++seq }) },
    workflowEvent: { create: async ({ data }: { data: Record<string, unknown> }) => ({ ...data, id: "50000000-0000-4000-8000-000000000001", projectId: claim.projectId, emittedAt: new Date(clock) }) },
    executionEpoch: { findUniqueOrThrow: async () => ({ epoch: 1 }) },
    // This claim-lifetime fixture borrows the transaction boundary. Durable
    // event/dispatch semantics themselves run against PostgreSQL in the gate.
    $queryRaw: async (query: TemplateStringsArray, ...values: unknown[]) => {
      const sql = query.join("?");
      if (sql.includes('SELECT "epoch"')) return [{ epoch: 1 }];
      if (sql.includes('INSERT INTO "ExecutionDispatch"')) return [{
        id: values[0], kind: values[1], subjectKind: values[2], subjectId: values[3], generation: values[4], deploymentEpoch: values[5], inputHash: values[6], deliveryKey: values[7], dueAt: values[8], nextDeliveryAt: new Date(clock), wakeKind: values[9], deadlineKind: values[10], observedDeadlineAt: values[11],
        deliveryAttempts: 0, acknowledgedAt: null, destinationId: null, deadLetteredAt: null, errorCode: null,
      }];
      throw new Error("Unexpected claim fixture SQL");
    },
  };
  const dependencies = {
    prisma: {
      $transaction: async (
        work: (transaction: typeof tx) => Promise<unknown>,
      ) => work(tx),
    } as unknown as PrismaClient,
    workflow: {
      cancelSourceExecutionsWithinTransaction: async () => { throw new Error("Source cancellation is outside this fixture"); },
      dispatchRunWithinTransaction: async () => { throw new Error("Handoff is outside this fixture"); },
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

import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";
import { LayoutEvidenceClaimLost, LayoutEvidenceLifecycle, type ClipPendingAutoLayoutAnalysis } from "./layout-evidence";

function executionFixture() {
  let clock = 0;
  let expiresAt = 60_000;
  let token: string | null = "owned";
  let status = "processing";
  let tick: (() => void) | undefined;
  let cancelled = false;
  const claim: ClipPendingAutoLayoutAnalysis = {
    id: "clip", projectId: "project", startSec: 10, endSec: 30,
    transcriptSlice: [], deletedRanges: [], editorRevision: 7,
    previewStorageKey: "preview", previewStartSec: 6, previewDurationSec: 28,
    autoLayoutClaimToken: "owned", sourceStorageKey: "source", leaseMs: 60_000,
  };
  const prisma = { clip: { updateMany: async ({ where, data }: {
    where: { autoLayoutClaimToken: string; autoLayoutLeaseExpiresAt: { gt: Date } };
    data: { autoLayoutStatus?: string; autoLayoutClaimToken?: null; autoLayoutLeaseExpiresAt: Date | null };
  }) => {
    if (status !== "processing" || token !== where.autoLayoutClaimToken || expiresAt <= where.autoLayoutLeaseExpiresAt.gt.getTime()) return { count: 0 };
    expiresAt = data.autoLayoutLeaseExpiresAt?.getTime() ?? 0;
    if (data.autoLayoutStatus) status = data.autoLayoutStatus;
    if (data.autoLayoutClaimToken === null) token = null;
    return { count: 1 };
  } } } as unknown as PrismaClient;
  const lifecycle = new LayoutEvidenceLifecycle({
    prisma, now: () => new Date(clock),
    scheduler: {
      schedule(callback, intervalMs) { expect(intervalMs).toBe(20_000); tick = callback; return callback; },
      cancel() { cancelled = true; },
    },
  });
  return {
    lifecycle, claim,
    advance(ms: number) { clock += ms; },
    async heartbeat() { tick?.(); await new Promise((resolve) => setTimeout(resolve, 0)); },
    replaceOwner() { token = "replacement"; },
    canPublish() { return status === "processing" && token === "owned" && expiresAt > clock; },
    status: () => status,
    cancelled: () => cancelled,
  };
}

describe("Layout Evidence background execution", () => {
  test("renews throughout work longer than the original lease", async () => {
    const f = executionFixture();
    let finish!: () => void;
    const work = f.lifecycle.runAutomaticClaim(f.claim, async ({ signal }) => {
      await new Promise<void>((resolve) => { finish = resolve; });
      signal.throwIfAborted();
      return f.canPublish();
    });
    for (let step = 0; step < 5; step++) {
      f.advance(20_000);
      await f.heartbeat();
    }
    finish();
    expect(await work).toBe(true);
    expect(f.cancelled()).toBe(true);
  });

  test("renewal loss cancels active IO and cannot release a replacement owner", async () => {
    const f = executionFixture();
    let observed: AbortSignal | undefined;
    const work = f.lifecycle.runAutomaticClaim(f.claim, async ({ signal }) => {
      observed = signal;
      await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    // Attach rejection handling before the fake scheduler can deliver it.
    const rejection = work.catch((error: unknown) => error);
    f.replaceOwner();
    await f.heartbeat();
    expect(await rejection).toBeInstanceOf(LayoutEvidenceClaimLost);
    expect(observed?.aborted).toBe(true);
    expect(f.status()).toBe("processing");
    expect(f.cancelled()).toBe(true);
  });

  test("shutdown releases immediately when a handler ignores cancellation", async () => {
    const f = executionFixture();
    const shutdown = new AbortController();
    let finish!: () => void;
    const work = f.lifecycle.runAutomaticClaim(f.claim, async () => {
      await new Promise<void>((resolve) => { finish = resolve; });
    }, { signal: shutdown.signal });
    shutdown.abort(new Error("worker shutdown"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.status()).toBe("pending");
    expect(f.canPublish()).toBe(false);
    expect(f.cancelled()).toBe(true);
    finish();
    await work;
  });
});

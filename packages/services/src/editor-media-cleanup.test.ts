import { describe, expect, test } from "bun:test";
import {
  EditorMediaCleanupClaimLost,
  classifyEditorCleanupStorageError,
  createEditorMediaCleanupWorker,
  createInMemoryEditorMediaCleanupStore,
  defaultEditorMediaCleanupConfig,
} from "./editor-media-cleanup";

function seed(overrides: Record<string, unknown> = {}) {
  return {
    id: "cleanup-1",
    projectId: "project-1",
    clipId: "clip-1",
    cleanupClass: "mutable_render" as const,
    objectKey: "projects/project-1/renders/obsolete.mp4",
    attemptCount: 0,
    nextAttemptAt: new Date("2026-08-29T00:00:00.000Z"),
    claimId: null,
    claimExpiresAt: null,
    failureCode: null,
    completedAt: null,
    ...overrides,
  };
}

describe("obsolete editor media cleanup", () => {
  test("deletes the exact recorded object and settles the current claim", async () => {
    const now = new Date("2026-08-29T00:00:01.000Z");
    const store = createInMemoryEditorMediaCleanupStore([seed()]);
    const deleted: string[] = [];
    const worker = createEditorMediaCleanupWorker({
      store,
      storage: { deleteExact: async (key) => void deleted.push(key) },
      now: () => now,
      createId: () => "claim-1",
      random: () => 0.5,
      config: defaultEditorMediaCleanupConfig(),
    });

    expect(await worker.processDue()).toEqual({ claimed: 1, completed: 1, retried: 0 });
    expect(deleted).toEqual(["projects/project-1/renders/obsolete.mp4"]);
    expect(store.inspect("cleanup-1")?.completedAt).toEqual(now);
  });

  test("provider not-found is idempotent success", async () => {
    const now = new Date("2026-08-29T00:00:01.000Z");
    const store = createInMemoryEditorMediaCleanupStore([seed()]);
    const worker = createEditorMediaCleanupWorker({
      store,
      storage: {
        async deleteExact() {
          throw Object.assign(new Error("gone"), { code: "not_found" });
        },
      },
      classifyStorageError: () => "not_found",
      now: () => now,
      createId: () => "claim-1",
      random: () => 0.5,
      config: defaultEditorMediaCleanupConfig(),
    });
    expect((await worker.processDue()).completed).toBe(1);
  });

  test("temporary failures remain due with capped exponential backoff", async () => {
    let now = new Date("2026-08-29T00:00:01.000Z");
    const store = createInMemoryEditorMediaCleanupStore([
      seed({ attemptCount: 20 }),
    ]);
    const config = { ...defaultEditorMediaCleanupConfig(), maxDelayMs: 60_000 };
    const worker = createEditorMediaCleanupWorker({
      store,
      storage: { deleteExact: async () => { throw new Error("outage"); } },
      classifyStorageError: () => "temporary",
      now: () => now,
      createId: () => "claim-1",
      random: () => 0.5,
      config,
    });
    expect((await worker.processDue()).retried).toBe(1);
    const obligation = store.inspect("cleanup-1")!;
    expect(obligation.completedAt).toBeNull();
    expect(obligation.failureCode).toBe("storage_temporary");
    expect(obligation.nextAttemptAt.getTime() - now.getTime()).toBe(60_000);

    now = new Date(obligation.nextAttemptAt.getTime() + 1);
    expect((await worker.processDue()).claimed).toBe(1);
  });

  test("an expired claim is recoverable and late settlement is fenced", async () => {
    const now = new Date("2026-08-29T00:01:00.000Z");
    const store = createInMemoryEditorMediaCleanupStore([
      seed({
        claimId: "expired-claim",
        claimExpiresAt: new Date("2026-08-29T00:00:30.000Z"),
      }),
    ]);
    const [recovered] = await store.claimDue({
      now,
      limit: 1,
      leaseMs: 30_000,
      createId: () => "new-claim",
    });
    expect(recovered?.claimId).toBe("new-claim");
    await expect(
      store.complete({ id: "cleanup-1", claimId: "expired-claim", now }),
    ).rejects.toBeInstanceOf(EditorMediaCleanupClaimLost);
    expect(await store.complete({ id: "cleanup-1", claimId: "new-claim", now })).toBe(true);
  });

  test("cancellation releases every unprocessed claim immediately", async () => {
    const now = new Date("2026-08-29T00:00:01.000Z");
    const store = createInMemoryEditorMediaCleanupStore([
      seed(),
      seed({ id: "cleanup-2", objectKey: "projects/project-1/renders/second.mp4" }),
    ]);
    const abort = new AbortController();
    const worker = createEditorMediaCleanupWorker({
      store,
      storage: {
        async deleteExact() {
          abort.abort();
        },
      },
      now: () => now,
      createId: (() => {
        let id = 0;
        return () => `claim-${++id}`;
      })(),
      random: () => 0.5,
      config: defaultEditorMediaCleanupConfig(),
    });
    await worker.processDue({ signal: abort.signal });
    expect(store.inspect("cleanup-2")?.claimId).toBeNull();
    expect(store.inspect("cleanup-2")?.nextAttemptAt).toEqual(now);
  });

  test("diagnostics failure cannot change settlement", async () => {
    const now = new Date("2026-08-29T00:00:01.000Z");
    const store = createInMemoryEditorMediaCleanupStore([seed()]);
    const worker = createEditorMediaCleanupWorker({
      store,
      storage: { deleteExact: async () => undefined },
      diagnostics: { record() { throw new Error("logger down"); } },
      now: () => now,
      createId: () => "claim-1",
      random: () => 0.5,
      config: defaultEditorMediaCleanupConfig(),
    });
    expect((await worker.processDue()).completed).toBe(1);
  });

  test("configuration failures remain due under the validated retry cap", async () => {
    const now = new Date("2026-08-29T00:00:01.000Z");
    const store = createInMemoryEditorMediaCleanupStore([seed()]);
    const worker = createEditorMediaCleanupWorker({
      store,
      storage: {
        async deleteExact() {
          throw new Error("Missing required environment variable R2_ACCOUNT_ID");
        },
      },
      classifyStorageError: classifyEditorCleanupStorageError,
      now: () => now,
      createId: () => "claim-1",
      random: () => 0.5,
      config: {
        ...defaultEditorMediaCleanupConfig(),
        baseDelayMs: 1_000,
        maxDelayMs: 2_000,
        jitterRatio: 0,
      },
    });
    expect(await worker.processDue()).toEqual({ claimed: 1, completed: 0, retried: 1 });
    expect(store.inspect("cleanup-1")).toMatchObject({
      completedAt: null,
      failureCode: "storage_configuration",
      nextAttemptAt: new Date(now.getTime() + 1_000),
    });
  });
});

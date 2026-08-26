import { expect, test } from "bun:test";
import { RenderObjectReconciler } from "./render-object-reconciler";

test("orphan reconciliation is project-scoped, attempt-only, and dry-run first", async () => {
  const projectId = "11111111-1111-1111-1111-111111111111";
  const old = new Date("2026-08-15T00:00:00.000Z");
  const young = new Date("2026-08-16T18:00:00.000Z");
  const referenced = `projects/${projectId}/renders/clip/9x16-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp4`;
  const orphan = `projects/${projectId}/exports/export/variant-9x16-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.mp4`;
  const protectedKey = `projects/${projectId}/renders/clip/1x1-cccccccc-cccc-4ccc-8ccc-cccccccccccc.mp4`;
  const legacy = `projects/${projectId}/renders/clip/9x16.mp4`;
  const deleted: string[] = [];
  const listedPrefixes: string[] = [];
  const reconciler = new RenderObjectReconciler({
    now: () => new Date("2026-08-17T12:00:00.000Z"),
    storage: {
      listPage: async (prefix) => {
        listedPrefixes.push(prefix);
        return {
          objects: [
            { key: referenced, lastModified: old },
            { key: orphan, lastModified: old },
            { key: protectedKey, lastModified: young },
            { key: legacy, lastModified: old },
          ].filter((object) => object.key.startsWith(prefix)),
          nextContinuationToken: null,
        };
      },
      delete: async (key) => {
        deleted.push(key);
      },
    },
    persistence: {
      listReferencedKeys: async () => new Set([referenced]),
    },
  });

  const result = await reconciler.execute({ projectId, delete: false });

  expect(listedPrefixes).toEqual([
    `projects/${projectId}/renders/`,
    `projects/${projectId}/exports/`,
  ]);
  expect(result).toEqual({
    examined: 3,
    referenced: 1,
    ageProtected: 1,
    orphaned: 1,
    deleted: 0,
    failed: 0,
    objectIds: [orphan],
  });
  expect(deleted).toEqual([]);
});

test("destructive reconciliation refreshes references before deletion", async () => {
  const projectId = "11111111-1111-1111-1111-111111111111";
  const key = `projects/${projectId}/renders/clip/9x16-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp4`;
  let referenceRead = 0;
  const deleted: string[] = [];
  const reconciler = new RenderObjectReconciler({
    now: () => new Date("2026-08-17T12:00:00.000Z"),
    storage: {
      listPage: async (prefix) => ({
        objects: prefix.endsWith("/renders/")
          ? [{ key, lastModified: new Date("2026-08-15T00:00:00.000Z") }]
          : [],
        nextContinuationToken: null,
      }),
      delete: async (objectKey) => {
        deleted.push(objectKey);
      },
    },
    persistence: {
      listReferencedKeys: async () => {
        referenceRead += 1;
        return referenceRead === 1 ? new Set() : new Set([key]);
      },
    },
  });

  expect(await reconciler.execute({ projectId, delete: true })).toMatchObject({
    referenced: 1,
    orphaned: 0,
    deleted: 0,
    failed: 0,
  });
  expect(deleted).toEqual([]);
});

test("destructive reconciliation rechecks each candidate immediately before deletion", async () => {
  const projectId = "11111111-1111-1111-1111-111111111111";
  const first = `projects/${projectId}/renders/clip/9x16-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp4`;
  const second = `projects/${projectId}/renders/clip/1x1-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.mp4`;
  const deleted: string[] = [];
  let referenceRead = 0;
  const reconciler = new RenderObjectReconciler({
    now: () => new Date("2026-08-17T12:00:00.000Z"),
    storage: {
      listPage: async (prefix) => ({
        objects: prefix.endsWith("/renders/")
          ? [first, second].map((key) => ({
              key,
              lastModified: new Date("2026-08-15T00:00:00.000Z"),
            }))
          : [],
        nextContinuationToken: null,
      }),
      delete: async (key) => {
        deleted.push(key);
      },
    },
    persistence: {
      listReferencedKeys: async () => {
        referenceRead += 1;
        return referenceRead >= 3 ? new Set([second]) : new Set();
      },
    },
  });

  await expect(
    reconciler.execute({ projectId, delete: true }),
  ).resolves.toMatchObject({
    referenced: 1,
    orphaned: 1,
    deleted: 1,
    failed: 0,
    objectIds: [first],
  });
  expect(deleted).toEqual([first]);
});

test("destructive reconciliation reports deletion failures without hiding the orphan", async () => {
  const projectId = "11111111-1111-1111-1111-111111111111";
  const key = `projects/${projectId}/exports/export/variant-9x16-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.mp4`;
  const diagnostics: Array<Record<string, unknown>> = [];
  const reconciler = new RenderObjectReconciler({
    now: () => new Date("2026-08-17T12:00:00.000Z"),
    storage: {
      listPage: async (prefix) => ({
        objects: prefix.endsWith("/exports/")
          ? [{ key, lastModified: new Date("2026-08-15T00:00:00.000Z") }]
          : [],
        nextContinuationToken: null,
      }),
      delete: async () => {
        throw new Error("access denied");
      },
    },
    persistence: { listReferencedKeys: async () => new Set() },
    diagnose: (diagnostic) => diagnostics.push(diagnostic),
  });

  expect(await reconciler.execute({ projectId, delete: true })).toMatchObject({
    orphaned: 1,
    deleted: 0,
    failed: 1,
    objectIds: [key],
  });
  expect(diagnostics).toContainEqual(
    expect.objectContaining({
      message: "render_orphan_delete_failed",
      objectId: key,
    }),
  );
});

test("orphan reconciliation scans every project-scoped storage page", async () => {
  const projectId = "11111111-1111-1111-1111-111111111111";
  const first = `projects/${projectId}/renders/clip/9x16-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp4`;
  const second = `projects/${projectId}/renders/clip/1x1-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.mp4`;
  const listCalls: Array<[string, string | undefined]> = [];
  const reconciler = new RenderObjectReconciler({
    now: () => new Date("2026-08-17T12:00:00.000Z"),
    storage: {
      listPage: async (prefix, continuationToken) => {
        listCalls.push([prefix, continuationToken]);
        if (!prefix.endsWith("/renders/")) {
          return { objects: [], nextContinuationToken: null };
        }
        return continuationToken
          ? {
              objects: [
                { key: second, lastModified: new Date("2026-08-15T00:00:00Z") },
              ],
              nextContinuationToken: null,
            }
          : {
              objects: [
                { key: first, lastModified: new Date("2026-08-15T00:00:00Z") },
              ],
              nextContinuationToken: "page-2",
            };
      },
      delete: async () => {},
    },
    persistence: { listReferencedKeys: async () => new Set() },
  });

  await expect(reconciler.execute({ projectId })).resolves.toMatchObject({
    examined: 2,
    orphaned: 2,
    objectIds: [first, second],
  });
  expect(listCalls).toEqual([
    [`projects/${projectId}/renders/`, undefined],
    [`projects/${projectId}/renders/`, "page-2"],
    [`projects/${projectId}/exports/`, undefined],
  ]);
});

test("orphan reconciliation stops safely when durable references are unavailable", async () => {
  const projectId = "11111111-1111-1111-1111-111111111111";
  let listed = false;
  let deleted = false;
  const reconciler = new RenderObjectReconciler({
    storage: {
      listPage: async () => {
        listed = true;
        return { objects: [], nextContinuationToken: null };
      },
      delete: async () => {
        deleted = true;
      },
    },
    persistence: {
      listReferencedKeys: async () => {
        throw new Error("database unavailable");
      },
    },
  });

  await expect(
    reconciler.execute({ projectId, delete: true }),
  ).rejects.toThrow("database unavailable");
  expect(listed).toBe(false);
  expect(deleted).toBe(false);
});

test("destructive reconciliation is idempotent after a partial replay", async () => {
  const projectId = "11111111-1111-1111-1111-111111111111";
  const key = `projects/${projectId}/renders/clip/9x16-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp4`;
  const objects = new Set([key]);
  const reconciler = new RenderObjectReconciler({
    now: () => new Date("2026-08-17T12:00:00.000Z"),
    storage: {
      listPage: async (prefix) => ({
        objects:
          prefix.endsWith("/renders/") && objects.has(key)
            ? [{ key, lastModified: new Date("2026-08-15T00:00:00Z") }]
            : [],
        nextContinuationToken: null,
      }),
      delete: async (objectKey) => {
        objects.delete(objectKey);
      },
    },
    persistence: { listReferencedKeys: async () => new Set() },
  });

  await expect(
    reconciler.execute({ projectId, delete: true }),
  ).resolves.toMatchObject({ examined: 1, orphaned: 1, deleted: 1, failed: 0 });
  await expect(
    reconciler.execute({ projectId, delete: true }),
  ).resolves.toEqual({
    examined: 0,
    referenced: 0,
    ageProtected: 0,
    orphaned: 0,
    deleted: 0,
    failed: 0,
    objectIds: [],
  });
});

test("storage listing is deadline-bounded with an active abort signal", async () => {
  const projectId = "11111111-1111-1111-1111-111111111111";
  let receivedSignal: AbortSignal | undefined;
  const reconciler = new RenderObjectReconciler({
    storageOperationTimeoutMs: 5,
    storage: {
      listPage: async (_prefix, _continuationToken, options) => {
        receivedSignal = options?.signal;
        return await new Promise((_, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason),
            { once: true },
          );
        });
      },
      delete: async () => {},
    },
    persistence: { listReferencedKeys: async () => new Set() },
  });

  await expect(reconciler.execute({ projectId })).rejects.toMatchObject({
    name: "TimeoutError",
  });
  expect(receivedSignal?.aborted).toBe(true);
});

test("caller cancellation actively aborts destructive storage operations", async () => {
  const projectId = "11111111-1111-1111-1111-111111111111";
  const key = `projects/${projectId}/renders/clip/9x16-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp4`;
  const controller = new AbortController();
  let deleteSignal: AbortSignal | undefined;
  const reconciler = new RenderObjectReconciler({
    now: () => new Date("2026-08-17T12:00:00.000Z"),
    storage: {
      listPage: async (prefix) => ({
        objects: prefix.endsWith("/renders/")
          ? [{ key, lastModified: new Date("2026-08-15T00:00:00.000Z") }]
          : [],
        nextContinuationToken: null,
      }),
      delete: async (_objectKey, options) => {
        deleteSignal = options?.signal;
        controller.abort(new DOMException("cancelled", "AbortError"));
        options?.signal?.throwIfAborted();
      },
    },
    persistence: { listReferencedKeys: async () => new Set() },
  });

  await expect(
    reconciler.execute({ projectId, delete: true, signal: controller.signal }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(deleteSignal?.aborted).toBe(true);
});

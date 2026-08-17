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

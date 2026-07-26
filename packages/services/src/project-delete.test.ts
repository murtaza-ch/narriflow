import { describe, expect, test } from "bun:test";
import {
  planProjectStorageDeletion,
  deleteProjectStorageObjects,
  runProjectDeletion,
  ProjectAccessDeniedError,
  ProjectNotFoundError,
  projectService,
  type ProjectDeletionAccessResult,
  type ProjectDeletionDeps,
  type ProjectDeletionRow,
  type ProjectStorageSnapshot,
} from "./project.service";

function storageSnapshot(
  overrides: Partial<ProjectStorageSnapshot> = {},
): ProjectStorageSnapshot {
  return {
    sourceStorageKey: "projects/p1/source.mp4",
    transcriptRawStorageKey: "projects/p1/transcripts/raw.json",
    uploadSessions: [],
    clipPreviewStorageKeys: [],
    clipRenderStorageKeys: [],
    clipDubStorageKeys: [],
    ...overrides,
  };
}

describe("planProjectStorageDeletion", () => {
  test("collects every storage-key-bearing field into a deduped list", () => {
    const plan = planProjectStorageDeletion(
      storageSnapshot({
        clipPreviewStorageKeys: ["projects/p1/clips/c1/preview.mp4", null],
        clipRenderStorageKeys: [
          "projects/p1/clips/c1/9x16.mp4",
          "projects/p1/clips/c1/1x1.mp4",
          null,
        ],
        clipDubStorageKeys: [
          "projects/p1/dubs/c1/d1.mp3",
          "projects/p1/dubs/c1/d1.mp4",
          null,
        ],
      }),
    );

    expect(new Set(plan.objectKeysToDelete)).toEqual(
      new Set([
        "projects/p1/source.mp4",
        "projects/p1/transcripts/raw.json",
        "projects/p1/clips/c1/preview.mp4",
        "projects/p1/clips/c1/9x16.mp4",
        "projects/p1/clips/c1/1x1.mp4",
        "projects/p1/dubs/c1/d1.mp3",
        "projects/p1/dubs/c1/d1.mp4",
      ]),
    );
    expect(plan.multipartUploadsToAbort).toEqual([]);
  });

  test("drops null/empty keys instead of queuing empty-string deletes", () => {
    const plan = planProjectStorageDeletion(
      storageSnapshot({
        sourceStorageKey: null,
        transcriptRawStorageKey: null,
        clipPreviewStorageKeys: [null, null],
      }),
    );

    expect(plan.objectKeysToDelete).toEqual([]);
  });

  test("dedupes a completed UploadSession's key against sourceStorageKey", () => {
    const plan = planProjectStorageDeletion(
      storageSnapshot({
        sourceStorageKey: "projects/p1/source.mp4",
        transcriptRawStorageKey: null,
        uploadSessions: [
          {
            storageKey: "projects/p1/source.mp4",
            providerUploadId: "upload-1",
            status: "completed",
          },
        ],
      }),
    );

    expect(plan.objectKeysToDelete).toEqual(["projects/p1/source.mp4"]);
    expect(plan.multipartUploadsToAbort).toEqual([]);
  });

  test("routes a still-initiated UploadSession to abort, not delete", () => {
    const plan = planProjectStorageDeletion(
      storageSnapshot({
        sourceStorageKey: null,
        transcriptRawStorageKey: null,
        uploadSessions: [
          {
            storageKey: "projects/p1/pending-upload.mp4",
            providerUploadId: "upload-2",
            status: "initiated",
          },
        ],
      }),
    );

    expect(plan.objectKeysToDelete).toEqual([]);
    expect(plan.multipartUploadsToAbort).toEqual([
      { key: "projects/p1/pending-upload.mp4", uploadId: "upload-2" },
    ]);
  });

  test("leaves aborted/expired UploadSession keys alone beyond the dedupe pass", () => {
    const plan = planProjectStorageDeletion(
      storageSnapshot({
        sourceStorageKey: null,
        transcriptRawStorageKey: null,
        uploadSessions: [
          {
            storageKey: "projects/p1/stale.mp4",
            providerUploadId: "upload-3",
            status: "expired",
          },
        ],
      }),
    );

    // Not routed to abort (nothing left in-flight to abort) — and since
    // nothing else claimed this key, it still shows up as a delete target.
    expect(plan.objectKeysToDelete).toEqual(["projects/p1/stale.mp4"]);
    expect(plan.multipartUploadsToAbort).toEqual([]);
  });
});

describe("deleteProjectStorageObjects", () => {
  test("treats an already-missing object as success, not a failure", async () => {
    const result = await deleteProjectStorageObjects(
      { objectKeysToDelete: ["gone.mp4"], multipartUploadsToAbort: [] },
      {
        deleteObject: async () => {
          throw { name: "NoSuchKey" };
        },
        abortMultipartUpload: async () => {},
        isMissingObjectError: (error) =>
          (error as { name?: string })?.name === "NoSuchKey",
      },
    );

    expect(result.failedKeys).toEqual([]);
  });

  test("reports a genuine delete failure without letting one bad key stop the rest", async () => {
    const attempted: string[] = [];
    const result = await deleteProjectStorageObjects(
      {
        objectKeysToDelete: ["ok-1.mp4", "broken.mp4", "ok-2.mp4"],
        multipartUploadsToAbort: [],
      },
      {
        deleteObject: async (key) => {
          attempted.push(key);
          if (key === "broken.mp4") {
            throw { name: "InternalError" };
          }
        },
        abortMultipartUpload: async () => {},
        isMissingObjectError: () => false,
      },
    );

    expect(attempted.sort()).toEqual(["broken.mp4", "ok-1.mp4", "ok-2.mp4"]);
    expect(result.failedKeys).toEqual(["broken.mp4"]);
  });

  test("a failed multipart abort is best-effort and never surfaces as a failedKey", async () => {
    const result = await deleteProjectStorageObjects(
      {
        objectKeysToDelete: [],
        multipartUploadsToAbort: [{ key: "pending.mp4", uploadId: "u1" }],
      },
      {
        deleteObject: async () => {},
        abortMultipartUpload: async () => {
          throw new Error("network blip");
        },
        isMissingObjectError: () => false,
      },
    );

    expect(result.failedKeys).toEqual([]);
  });
});

describe("runProjectDeletion", () => {
  function baseRow(overrides: Partial<ProjectDeletionRow> = {}): ProjectDeletionRow {
    return {
      hasActiveWorkflowRun: false,
      storage: storageSnapshot(),
      ...overrides,
    };
  }

  function makeDeps(
    access: ProjectDeletionAccessResult,
    overrides: Partial<ProjectDeletionDeps> = {},
  ): ProjectDeletionDeps & {
    calls: { deleteObject: string[]; deleteProjectRow: number };
  } {
    const calls = { deleteObject: [] as string[], deleteProjectRow: 0 };
    return {
      calls,
      getAccessAndRow: async () => access,
      deleteObject: async (key) => {
        calls.deleteObject.push(key);
      },
      abortMultipartUpload: async () => {},
      isMissingObjectError: () => false,
      deleteProjectRow: async () => {
        calls.deleteProjectRow += 1;
        return { count: 1 };
      },
      ...overrides,
    };
  }

  test("ownership rejection: a missing project resolves to not_found without touching storage or the DB row", async () => {
    const deps = makeDeps({ access: "missing", row: null });

    const outcome = await runProjectDeletion(deps);

    expect(outcome).toEqual({ kind: "not_found" });
    expect(deps.calls.deleteObject).toEqual([]);
    expect(deps.calls.deleteProjectRow).toBe(0);
  });

  test("ownership rejection: another user's project resolves to forbidden without touching storage or the DB row", async () => {
    const deps = makeDeps({ access: "forbidden", row: null });

    const outcome = await runProjectDeletion(deps);

    expect(outcome).toEqual({ kind: "forbidden" });
    expect(deps.calls.deleteObject).toEqual([]);
    expect(deps.calls.deleteProjectRow).toBe(0);
  });

  test("active-run guard: a queued/running workflow run blocks deletion entirely", async () => {
    const deps = makeDeps({
      access: "owned",
      row: baseRow({ hasActiveWorkflowRun: true }),
    });

    const outcome = await runProjectDeletion(deps);

    expect(outcome).toEqual({ kind: "active_workflow" });
    expect(deps.calls.deleteObject).toEqual([]);
    expect(deps.calls.deleteProjectRow).toBe(0);
  });

  test("storage-fails-so-DB-row-survives: a genuine storage failure reports storage_incomplete and never deletes the DB row", async () => {
    // Constructed inline rather than via makeDeps: overriding deleteObject
    // through makeDeps's spread would replace (not wrap) its call-tracking,
    // so this test tracks the attempt itself directly.
    const attemptedDeletes: string[] = [];
    let deleteProjectRowCalls = 0;
    const deps: ProjectDeletionDeps = {
      getAccessAndRow: async () => ({
        access: "owned",
        row: baseRow({
          storage: storageSnapshot({
            sourceStorageKey: "projects/p1/source.mp4",
            transcriptRawStorageKey: null,
          }),
        }),
      }),
      deleteObject: async (key) => {
        attemptedDeletes.push(key);
        throw new Error("R2 5xx");
      },
      abortMultipartUpload: async () => {},
      isMissingObjectError: () => false,
      deleteProjectRow: async () => {
        deleteProjectRowCalls += 1;
        return { count: 1 };
      },
    };

    const outcome = await runProjectDeletion(deps);

    expect(outcome).toEqual({
      kind: "storage_incomplete",
      failedKeys: ["projects/p1/source.mp4"],
    });
    // The critical ordering guarantee: storage deletion was attempted, but
    // the DB row delete must never be reached when it fails.
    expect(attemptedDeletes).toEqual(["projects/p1/source.mp4"]);
    expect(deleteProjectRowCalls).toBe(0);
  });

  test("happy path: clean storage deletion (including already-missing keys) proceeds to delete the DB row", async () => {
    const deps = makeDeps(
      {
        access: "owned",
        row: baseRow({
          storage: storageSnapshot({
            sourceStorageKey: "projects/p1/source.mp4",
            transcriptRawStorageKey: "projects/p1/transcripts/raw.json",
          }),
        }),
      },
      {
        deleteObject: async (key) => {
          if (key.endsWith("raw.json")) {
            throw { name: "NoSuchKey" }; // already gone — still a success
          }
        },
        isMissingObjectError: (error) =>
          (error as { name?: string })?.name === "NoSuchKey",
      },
    );

    const outcome = await runProjectDeletion(deps);

    expect(outcome).toEqual({ kind: "deleted" });
    expect(deps.calls.deleteProjectRow).toBe(1);
  });

  test("idempotent re-delete: deleteProjectRow resolving to count 0 is a clean already_deleted outcome, not a thrown error", async () => {
    const deps = makeDeps(
      { access: "owned", row: baseRow({ storage: storageSnapshot({ uploadSessions: [] }) }) },
      {
        deleteProjectRow: async () => ({ count: 0 }),
      },
    );

    await expect(runProjectDeletion(deps)).resolves.toEqual({
      kind: "already_deleted",
    });
  });

  test("idempotent re-delete: calling runProjectDeletion twice against the same fake store never throws the second time", async () => {
    // Simulates two concurrent/sequential calls: the first finds and deletes
    // the row, the second finds it already gone.
    let deleted = false;
    const deps: ProjectDeletionDeps = {
      getAccessAndRow: async () =>
        deleted
          ? { access: "missing", row: null }
          : { access: "owned", row: baseRow() },
      deleteObject: async () => {},
      abortMultipartUpload: async () => {},
      isMissingObjectError: () => false,
      deleteProjectRow: async () => {
        const wasAlreadyDeleted = deleted;
        deleted = true;
        return { count: wasAlreadyDeleted ? 0 : 1 };
      },
    };

    const first = await runProjectDeletion(deps);
    const second = await runProjectDeletion(deps);

    expect(first).toEqual({ kind: "deleted" });
    expect(second).toEqual({ kind: "not_found" });
  });
});

describe("ProjectService.deleteProject (no database configured)", () => {
  // Matches this package's documented "no DATABASE_URL" test mode: the
  // service falls back to its in-memory project map.
  test("deletes an owned project and leaves it unreachable afterward", async () => {
    const project = await projectService.createProject("delete-test-user-a", {
      title: "Owned project",
      sourceMediaUrl: "https://example.com/a.mp4",
    });

    await expect(
      projectService.deleteProject("delete-test-user-a", project.id),
    ).resolves.toBeUndefined();
    expect(
      await projectService.getProjectAccess("delete-test-user-a", project.id),
    ).toBe("missing");
  });

  test("throws ProjectNotFoundError for an id that was never created", async () => {
    await expect(
      projectService.deleteProject(
        "delete-test-user-a",
        "00000000-0000-4000-8000-000000000000",
      ),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  test("throws ProjectAccessDeniedError when the project belongs to someone else", async () => {
    const project = await projectService.createProject("delete-test-owner", {
      title: "Not yours",
      sourceMediaUrl: "https://example.com/b.mp4",
    });

    await expect(
      projectService.deleteProject("delete-test-intruder", project.id),
    ).rejects.toBeInstanceOf(ProjectAccessDeniedError);

    // Access denial must not have deleted it out from under the owner.
    expect(
      await projectService.getProjectAccess("delete-test-owner", project.id),
    ).toBe("owned");
  });

  test("idempotent re-delete: deleting an already-deleted project throws ProjectNotFoundError instead of crashing", async () => {
    const project = await projectService.createProject("delete-test-user-c", {
      title: "Ephemeral",
      sourceMediaUrl: "https://example.com/c.mp4",
    });

    await projectService.deleteProject("delete-test-user-c", project.id);

    await expect(
      projectService.deleteProject("delete-test-user-c", project.id),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});

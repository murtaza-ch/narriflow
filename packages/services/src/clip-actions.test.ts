import { describe, expect, test } from "bun:test";
import {
  ClipActionError,
  ClipService,
  CLIP_TITLE_SYSTEM_PROMPT,
  buildClipTitleUserPrompt,
  clipDuplicatePreviewStorageKey,
  clipDuplicateRenderStorageKey,
  planClipStorageDeletion,
  runClipDeletion,
  type ClipDeletionDeps,
  type ClipDeletionAdapter,
  type ClipStorageSnapshot,
} from "./clip.service";
import { buildCopySource } from "./r2-storage";

function storageSnapshot(
  overrides: Partial<ClipStorageSnapshot> = {},
): ClipStorageSnapshot {
  return {
    previewStorageKey: "projects/p1/previews/c1/attempt-1.mp4",
    renderStorageKeys: ["projects/p1/renders/c1/9x16.mp4"],
    dubStorageKeys: [],
    ...overrides,
  };
}

describe("planClipStorageDeletion", () => {
  test("collects renders, dubs, and the preview proxy into one list", () => {
    const keys = planClipStorageDeletion(
      storageSnapshot({
        renderStorageKeys: [
          "projects/p1/renders/c1/9x16.mp4",
          "projects/p1/renders/c1/1x1.mp4",
        ],
        dubStorageKeys: [
          "projects/p1/dubs/c1/d1.mp3",
          "projects/p1/dubs/c1/d1.mp4",
        ],
      }),
    );

    expect(keys.sort()).toEqual(
      [
        "projects/p1/renders/c1/9x16.mp4",
        "projects/p1/renders/c1/1x1.mp4",
        "projects/p1/dubs/c1/d1.mp3",
        "projects/p1/dubs/c1/d1.mp4",
        "projects/p1/previews/c1/attempt-1.mp4",
        // The peaks sidecar (derived key, no own column) must be swept too.
        "projects/p1/previews/c1/attempt-1.peaks.json",
      ].sort(),
    );
  });

  test("includes the derived peaks sidecar key alongside the preview proxy", () => {
    const keys = planClipStorageDeletion(storageSnapshot());

    expect(keys).toContain("projects/p1/previews/c1/attempt-1.peaks.json");
  });

  test("never throws for a legacy/malformed previewStorageKey that doesn't end in .mp4", () => {
    const keys = planClipStorageDeletion(
      storageSnapshot({
        previewStorageKey: "projects/p1/previews/c1/legacy.mov",
      }),
    );

    expect(keys).toContain("projects/p1/previews/c1/legacy.mov");
    expect(keys).not.toContain(null);
  });

  test("drops nulls — an unrendered, un-dubbed clip yields nothing to delete", () => {
    expect(
      planClipStorageDeletion({
        previewStorageKey: null,
        renderStorageKeys: [null, null],
        dubStorageKeys: [null, null],
      }),
    ).toEqual([]);
  });

  test("dedupes repeated keys so a delete never round-trips twice", () => {
    const keys = planClipStorageDeletion(
      storageSnapshot({
        renderStorageKeys: [
          "projects/p1/renders/c1/9x16.mp4",
          "projects/p1/renders/c1/9x16.mp4",
        ],
        dubStorageKeys: ["projects/p1/previews/c1/attempt-1.mp4"],
      }),
    );

    // 9x16.mp4, attempt-1.mp4 (deduped preview/dub), attempt-1.peaks.json.
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("runClipDeletion", () => {
  function makeDeps(
    overrides: Partial<ClipDeletionDeps> = {},
  ): ClipDeletionDeps & {
    attempted: string[];
    rowDeleteCalls: number;
  } {
    const attempted: string[] = [];
    const state = { rowDeleteCalls: 0 };
    return {
      attempted,
      get rowDeleteCalls() {
        return state.rowDeleteCalls;
      },
      getClipRow: async () => ({
        hasActivePublication: false,
        storage: storageSnapshot({
          renderStorageKeys: ["private/render-a.mp4", "private/render-b.mp4"],
          dubStorageKeys: ["private/dub.mp3"],
          previewStorageKey: null,
        }),
      }),
      deleteObject: async (key) => void attempted.push(key),
      isMissingObjectError: () => false,
      deleteClipRow: async () => {
        state.rowDeleteCalls += 1;
        return { count: 1 };
      },
      ...overrides,
    };
  }

  test("full storage success deletes the Clip row", async () => {
    const deps = makeDeps();

    expect(await runClipDeletion(deps)).toEqual({ kind: "deleted" });
    expect(deps.attempted.sort()).toEqual(
      ["private/dub.mp3", "private/render-a.mp4", "private/render-b.mp4"].sort(),
    );
    expect(deps.rowDeleteCalls).toBe(1);
  });

  test("one genuine storage failure attempts every object and preserves the Clip", async () => {
    const attempted: string[] = [];
    let rowDeleteCalls = 0;
    const deps = makeDeps({
      deleteObject: async (key) => {
        attempted.push(key);
        if (key === "private/render-a.mp4") throw new Error("provider detail");
      },
      deleteClipRow: async () => {
        rowDeleteCalls += 1;
        return { count: 1 };
      },
    });

    expect(await runClipDeletion(deps)).toEqual({
      kind: "storage_incomplete",
      failedObjectCount: 1,
    });
    expect(attempted.sort()).toEqual(
      ["private/dub.mp3", "private/render-a.mp4", "private/render-b.mp4"].sort(),
    );
    expect(rowDeleteCalls).toBe(0);
  });

  test("multiple genuine failures never reach Clip-row deletion", async () => {
    let rowDeleteCalls = 0;
    const deps = makeDeps({
      deleteObject: async () => {
        throw new Error("storage unavailable");
      },
      deleteClipRow: async () => {
        rowDeleteCalls += 1;
        return { count: 1 };
      },
    });

    expect(await runClipDeletion(deps)).toEqual({
      kind: "storage_incomplete",
      failedObjectCount: 3,
    });
    expect(rowDeleteCalls).toBe(0);
  });

  test("missing objects and successful deletions both converge", async () => {
    const deps = makeDeps({
      deleteObject: async (key) => {
        if (key === "private/render-a.mp4") throw { name: "NoSuchKey" };
      },
      isMissingObjectError: (error) =>
        (error as { name?: string })?.name === "NoSuchKey",
    });

    expect(await runClipDeletion(deps)).toEqual({ kind: "deleted" });
  });

  test("a retry after partial progress accepts missing objects and completes", async () => {
    const existing = new Set([
      "private/render-a.mp4",
      "private/render-b.mp4",
      "private/dub.mp3",
    ]);
    let firstAttempt = true;
    let rowDeleteCalls = 0;
    const deps = makeDeps({
      deleteObject: async (key) => {
        if (!existing.has(key)) throw { name: "NoSuchKey" };
        if (firstAttempt && key === "private/render-b.mp4") {
          throw new Error("temporary outage");
        }
        existing.delete(key);
      },
      isMissingObjectError: (error) =>
        (error as { name?: string })?.name === "NoSuchKey",
      deleteClipRow: async () => {
        rowDeleteCalls += 1;
        return { count: 1 };
      },
    });

    expect(await runClipDeletion(deps)).toMatchObject({ kind: "storage_incomplete" });
    firstAttempt = false;
    expect(await runClipDeletion(deps)).toEqual({ kind: "deleted" });
    expect(rowDeleteCalls).toBe(1);
  });

  test("database deletion failure leaves the Clip retryable after storage success", async () => {
    const existing = new Set([
      "private/render-a.mp4",
      "private/render-b.mp4",
      "private/dub.mp3",
    ]);
    let failDatabase = true;
    const deps = makeDeps({
      deleteObject: async (key) => {
        if (!existing.delete(key)) throw { name: "NoSuchKey" };
      },
      isMissingObjectError: (error) =>
        (error as { name?: string })?.name === "NoSuchKey",
      deleteClipRow: async () => {
        if (failDatabase) throw new Error("database unavailable");
        return { count: 1 };
      },
    });

    await expect(runClipDeletion(deps)).rejects.toThrow("database unavailable");
    failDatabase = false;
    await expect(runClipDeletion(deps)).resolves.toEqual({ kind: "deleted" });
  });

  test("ownership denial touches neither storage nor the Clip row", async () => {
    const deps = makeDeps({ getClipRow: async () => null });

    expect(await runClipDeletion(deps)).toEqual({ kind: "not_found" });
    expect(deps.attempted).toEqual([]);
    expect(deps.rowDeleteCalls).toBe(0);
  });

  test("active publication preserves storage and the Clip row", async () => {
    const deps = makeDeps({
      getClipRow: async () => ({
        hasActivePublication: true,
        storage: storageSnapshot(),
      }),
    });

    expect(await runClipDeletion(deps)).toEqual({ kind: "active_publication" });
    expect(deps.attempted).toEqual([]);
    expect(deps.rowDeleteCalls).toBe(0);
  });
});

describe("ClipService.deleteClip", () => {
  function makeAdapter(
    overrides: Partial<ClipDeletionAdapter> = {},
  ): ClipDeletionAdapter & {
    attempted: string[];
    rowDeleteCalls: number;
  } {
    const attempted: string[] = [];
    let rowDeleteCalls = 0;
    return {
      attempted,
      get rowDeleteCalls() {
        return rowDeleteCalls;
      },
      getClipRow: async (context) => {
        expect(context).toEqual({
          userId: "user-1",
          projectId: "project-1",
          clipId: "clip-1",
        });
        return {
          hasActivePublication: false,
          storage: storageSnapshot({
            renderStorageKeys: ["private/render-a.mp4", "private/render-b.mp4"],
            dubStorageKeys: ["private/dub.mp3"],
            previewStorageKey: null,
          }),
        };
      },
      deleteObject: async (key) => void attempted.push(key),
      isMissingObjectError: () => false,
      deleteClipRow: async () => {
        rowDeleteCalls += 1;
        return { count: 1 };
      },
      ...overrides,
    };
  }

  async function expectActionCode(
    promise: Promise<unknown>,
    code: string,
  ): Promise<void> {
    try {
      await promise;
      throw new Error("expected ClipActionError");
    } catch (error) {
      expect(error).toBeInstanceOf(ClipActionError);
      expect((error as ClipActionError).code).toBe(code);
    }
  }

  test("returns the retryable public error after attempting every object and preserves the row", async () => {
    const attempted: string[] = [];
    let rowDeleteCalls = 0;
    const adapter = makeAdapter({
      deleteObject: async (key) => {
        attempted.push(key);
        if (key === "private/render-a.mp4") {
          throw new Error("provider detail must not escape");
        }
      },
      deleteClipRow: async () => {
        rowDeleteCalls += 1;
        return { count: 1 };
      },
    });

    await expectActionCode(
      new ClipService({ clipDeletionAdapter: adapter }).deleteClip(
        "user-1",
        "project-1",
        "clip-1",
      ),
      "clip_storage_delete_incomplete",
    );
    expect(attempted.sort()).toEqual(
      ["private/dub.mp3", "private/render-a.mp4", "private/render-b.mp4"].sort(),
    );
    expect(rowDeleteCalls).toBe(0);
  });

  test("a public retry accepts objects removed by the first attempt", async () => {
    const existing = new Set([
      "private/render-a.mp4",
      "private/render-b.mp4",
      "private/dub.mp3",
    ]);
    let firstAttempt = true;
    const adapter = makeAdapter({
      deleteObject: async (key) => {
        if (!existing.has(key)) throw { name: "NoSuchKey" };
        if (firstAttempt && key === "private/render-b.mp4") {
          throw new Error("temporary outage");
        }
        existing.delete(key);
      },
      isMissingObjectError: (error) =>
        (error as { name?: string })?.name === "NoSuchKey",
    });
    const service = new ClipService({ clipDeletionAdapter: adapter });

    await expectActionCode(
      service.deleteClip("user-1", "project-1", "clip-1"),
      "clip_storage_delete_incomplete",
    );
    firstAttempt = false;
    await expect(
      service.deleteClip("user-1", "project-1", "clip-1"),
    ).resolves.toBeUndefined();
    expect(adapter.rowDeleteCalls).toBe(1);
  });

  test("preserves the typed database failure after storage succeeds", async () => {
    const adapter = makeAdapter({
      deleteClipRow: async () => {
        throw new ClipActionError("clip_delete_failed", "clip delete failed");
      },
    });

    await expectActionCode(
      new ClipService({ clipDeletionAdapter: adapter }).deleteClip(
        "user-1",
        "project-1",
        "clip-1",
      ),
      "clip_delete_failed",
    );
  });

  test("ownership and active-publication rejection never touch storage", async () => {
    const missing = makeAdapter({ getClipRow: async () => null });
    await expectActionCode(
      new ClipService({ clipDeletionAdapter: missing }).deleteClip(
        "user-1",
        "project-1",
        "clip-1",
      ),
      "clip_not_found",
    );
    expect(missing.attempted).toEqual([]);

    const active = makeAdapter({
      getClipRow: async () => ({
        hasActivePublication: true,
        storage: storageSnapshot(),
      }),
    });
    await expectActionCode(
      new ClipService({ clipDeletionAdapter: active }).deleteClip(
        "user-1",
        "project-1",
        "clip-1",
      ),
      "clip_has_scheduled_posts",
    );
    expect(active.attempted).toEqual([]);
  });
});

describe("duplicate destination keys", () => {
  test("render key is scoped to the NEW clip id, never the source's", () => {
    const key = clipDuplicateRenderStorageKey("p1", "copy-1", "9:16");

    expect(key).toBe("projects/p1/renders/copy-1/9x16.mp4");
    expect(key).not.toContain("c1");
  });

  test("each aspect ratio gets its own slugged key", () => {
    const keys = (["9:16", "16:9", "1:1", "4:5"] as const).map((ratio) =>
      clipDuplicateRenderStorageKey("p1", "copy-1", ratio),
    );

    expect(new Set(keys).size).toBe(keys.length);
  });

  test("preview key is attempt-scoped, so two duplicates never collide", () => {
    const first = clipDuplicatePreviewStorageKey("p1", "copy-1", "attempt-a");
    const second = clipDuplicatePreviewStorageKey("p1", "copy-1", "attempt-b");

    expect(first).toBe("projects/p1/previews/copy-1/attempt-a.mp4");
    expect(first).not.toBe(second);
  });

  test("a duplicate's keys never equal the source clip's", () => {
    // The whole point of copying rather than sharing: delete-by-key on either
    // clip must not touch the other's bytes.
    const source = clipDuplicateRenderStorageKey("p1", "c1", "9:16");
    const copy = clipDuplicateRenderStorageKey("p1", "copy-1", "9:16");

    expect(source).not.toBe(copy);
  });
});

describe("buildCopySource", () => {
  test("keeps path separators intact while encoding each segment", () => {
    expect(buildCopySource("bucket", "projects/p1/renders/c1/9x16.mp4")).toBe(
      "bucket/projects/p1/renders/c1/9x16.mp4",
    );
  });

  test("escapes characters that would otherwise break the copy source", () => {
    expect(buildCopySource("bucket", "projects/p1/my clip+v2.mp4")).toBe(
      "bucket/projects/p1/my%20clip%2Bv2.mp4",
    );
  });
});

describe("clip title prompt", () => {
  const base = {
    languageCode: "en" as string | null,
    category: "hook",
    title: "The Wrong Technology",
    hookText: "the choice of our technology was absolutely wrong",
    payoffText: null,
    spokenText: "The thing that most people don't believe is that the choice of our technology was absolutely wrong.",
  };

  test("states the transcript's language code verbatim", () => {
    // The regression this guards: the language was never passed at all, so the
    // model inferred one from a short slice and returned Spanish for English
    // audio.
    const prompt = buildClipTitleUserPrompt(base);

    expect(prompt).toContain("provider language code en");
    expect(prompt.split("\n")[0]).toStartWith("Source language:");
  });

  test("carries a non-English code through unchanged", () => {
    expect(buildClipTitleUserPrompt({ ...base, languageCode: "hi" })).toContain(
      "provider language code hi",
    );
    expect(buildClipTitleUserPrompt({ ...base, languageCode: "es" })).toContain(
      "provider language code es",
    );
  });

  test("falls back to inferring one consistent language when the code is unknown", () => {
    const prompt = buildClipTitleUserPrompt({ ...base, languageCode: null });

    expect(prompt).toContain("unknown");
    expect(prompt).toContain("that one language for every option");
    expect(prompt).not.toContain("provider language code");
  });

  test("system prompt forbids translating and mixing languages", () => {
    expect(CLIP_TITLE_SYSTEM_PROMPT).toContain("Never translate");
    expect(CLIP_TITLE_SYSTEM_PROMPT).toContain("exactly one language");
    expect(CLIP_TITLE_SYSTEM_PROMPT).toContain("that language's own script");
  });

  test("omits optional lines rather than emitting empty ones", () => {
    const prompt = buildClipTitleUserPrompt({
      ...base,
      title: null,
      payoffText: null,
    });

    expect(prompt).not.toContain("Current title:");
    expect(prompt).not.toContain("Payoff:");
    expect(prompt.split("\n").every((line) => line.trim().length > 0)).toBe(true);
  });

  test("falls back to the hook when the clip has no transcript text", () => {
    const prompt = buildClipTitleUserPrompt({ ...base, spokenText: "" });

    expect(prompt).toContain(`Spoken text: ${base.hookText}`);
  });
});

describe("ClipActionError", () => {
  test("carries the code the API maps to user-facing copy", () => {
    const error = new ClipActionError("clip_has_scheduled_posts", "2 posts");

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("clip_has_scheduled_posts");
    expect(error.message).toBe("2 posts");
  });
});

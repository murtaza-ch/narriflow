import { describe, expect, test } from "bun:test";
import { indexedDB as fakeIndexedDB } from "fake-indexeddb";
import {
  DEFAULT_CAPTION_PRESET,
  editorDocumentSchema,
  studioEditsSchema,
  type EditorDocument,
} from "@narriflow/validators";
import {
  EDITOR_LEASE_TTL_MS,
  claimEditorLease,
  decideDraftRecovery,
  editorDraftKey,
  editorLeaseKey,
  loadEditorDraft,
  mergeEditorDocuments,
  parseStoredEditorDraft,
  readEditorLease,
  releaseEditorLease,
  removeEditorDraft,
  renewEditorLease,
  retryDelayMs,
  persistEditorDraft,
  type StorageLike,
  type StoredEditorDraft,
} from "./local-editor-draft";

function makeDocument(): EditorDocument {
  return editorDocumentSchema.parse({
    clipStartSec: 10,
    clipEndSec: 40,
    captionPreset: DEFAULT_CAPTION_PRESET,
    transcriptSlice: [],
    studioEdits: studioEditsSchema.parse(undefined),
    brollUrl: null,
    deletedRanges: [],
  });
}

function makeDraft(overrides: Partial<StoredEditorDraft> = {}): StoredEditorDraft {
  const baseDocument = makeDocument();
  return {
    formatVersion: 2,
    key: editorDraftKey("project", "clip"),
    projectId: "project",
    clipId: "clip",
    baseRevision: 3,
    baseDocument,
    document: {
      ...baseDocument,
      brollUrl: "https://cdn.example.com/recovered.mp4",
    },
    updatedAt: 100,
    writerId: "writer-a",
    ownershipGeneration: 1,
    ...overrides,
  };
}

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

describe("local editor draft recovery", () => {
  test("round-trips and removes a validated draft through IndexedDB", async () => {
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: fakeIndexedDB,
    });
    const draft = makeDraft();
    expect(await persistEditorDraft(draft)).toBe("written");
    expect(await loadEditorDraft(draft.projectId, draft.clipId)).toEqual(draft);
    await removeEditorDraft(draft.projectId, draft.clipId);
    expect(await loadEditorDraft(draft.projectId, draft.clipId)).toBeNull();
  });

  test("normalizes a version-one record without discarding its document", () => {
    const current = makeDraft();
    const { formatVersion: _formatVersion, ownershipGeneration: _generation, ...legacy } =
      current;
    expect(parseStoredEditorDraft(legacy)).toEqual({
      ...legacy,
      formatVersion: 1,
      ownershipGeneration: 0,
    });
  });

  test("rejects a Device Draft write from an older ownership generation", async () => {
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: fakeIndexedDB,
    });
    const key = editorDraftKey("fenced-project", "fenced-clip");
    const newer = makeDraft({
      key,
      projectId: "fenced-project",
      clipId: "fenced-clip",
      ownershipGeneration: 5,
      writerId: "writer-new",
    });
    const stale = makeDraft({
      ...newer,
      document: makeDocument(),
      ownershipGeneration: 4,
      writerId: "writer-old",
    });

    expect(await persistEditorDraft(newer)).toBe("written");
    expect(await persistEditorDraft(stale)).toBe("stale");
    expect(await loadEditorDraft("fenced-project", "fenced-clip")).toEqual(newer);
  });

  test("rejects draft removal from an older ownership generation", async () => {
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: fakeIndexedDB,
    });
    const draft = makeDraft({
      key: editorDraftKey("remove-project", "remove-clip"),
      projectId: "remove-project",
      clipId: "remove-clip",
      ownershipGeneration: 8,
    });
    await persistEditorDraft(draft);

    expect(await removeEditorDraft("remove-project", "remove-clip", 7)).toBe("stale");
    expect(await loadEditorDraft("remove-project", "remove-clip")).toEqual(draft);
    expect(await removeEditorDraft("remove-project", "remove-clip", 8)).toBe("removed");
  });

  test("ignores a draft identical to the cloud document", () => {
    const server = makeDocument();
    expect(decideDraftRecovery(makeDraft({ document: server }), server, 3)).toEqual({
      kind: "none",
    });
  });

  test("removes a draft whose deleted ranges are semantically equal to the cloud", () => {
    const server = {
      ...makeDocument(),
      deletedRanges: [{ startSec: 12, endSec: 16 }],
    };
    const draft = makeDraft({
      document: {
        ...server,
        deletedRanges: [
          { startSec: 14, endSec: 16 },
          { startSec: 12, endSec: 15 },
        ],
      },
    });

    expect(decideDraftRecovery(draft, server, 3)).toEqual({ kind: "none" });
  });

  test("recovers a dirty draft based on the current cloud revision", () => {
    const draft = makeDraft();
    expect(decideDraftRecovery(draft, draft.baseDocument, 3)).toEqual({
      kind: "recover",
      document: draft.document,
      baseRevision: 3,
      merged: false,
    });
  });

  test("automatically merges disjoint local and remote changes", () => {
    const draft = makeDraft();
    const remote = {
      ...draft.baseDocument,
      captionPreset: { ...draft.baseDocument.captionPreset, fontSize: 61 },
    };
    const recovery = decideDraftRecovery(draft, remote, 4);
    expect(recovery.kind).toBe("recover");
    if (recovery.kind !== "recover") throw new Error("expected recovery");
    expect(recovery.merged).toBe(true);
    expect(recovery.baseRevision).toBe(4);
    expect(recovery.document.brollUrl).toBe(draft.document.brollUrl);
    expect(recovery.document.captionPreset.fontSize).toBe(61);
  });

  test("does not guess when both copies changed the same field", () => {
    const draft = makeDraft({
      document: { ...makeDocument(), brollUrl: "https://local.example.com/video.mp4" },
    });
    const remote = {
      ...draft.baseDocument,
      brollUrl: "https://remote.example.com/video.mp4",
    };
    expect(decideDraftRecovery(draft, remote, 4)).toEqual({
      kind: "conflict",
      document: draft.document,
      paths: ["brollUrl"],
    });
  });

  test("treats independently changed ordered arrays as conflicts", () => {
    const base = makeDocument();
    const local = { ...base, deletedRanges: [{ startSec: 12, endSec: 13 }] };
    const remote = { ...base, deletedRanges: [{ startSec: 20, endSec: 21 }] };
    expect(mergeEditorDocuments(base, local, remote).conflicts).toContain("deletedRanges");
  });

  test("requires an explicit choice for a draft revision ahead of cloud", () => {
    const draft = makeDraft({ baseRevision: 9 });
    expect(decideDraftRecovery(draft, draft.baseDocument, 4)).toEqual({
      kind: "conflict",
      document: draft.document,
      paths: ["revision"],
    });
  });

  test("rejects malformed or schema-invalid stored records", () => {
    expect(parseStoredEditorDraft(null)).toBeNull();
    expect(parseStoredEditorDraft({ ...makeDraft(), baseRevision: -1 })).toBeNull();
    expect(parseStoredEditorDraft({ ...makeDraft(), key: "another:clip" })).toBeNull();
    expect(
      parseStoredEditorDraft({
        ...makeDraft(),
        document: { ...makeDocument(), clipEndSec: 1 },
      }),
    ).toBeNull();
  });
});

describe("single-writer editor lease", () => {
  test("builds clip-scoped keys", () => {
    expect(editorDraftKey("p", "c")).toBe("p:c");
    expect(editorLeaseKey("p", "c")).toBe("narriflow:studio-lease:p:c");
  });

  test("first writer claims and renews its lease", () => {
    const storage = new MemoryStorage();
    const key = editorLeaseKey("p", "c");
    expect(claimEditorLease(storage, key, "a", 1_000)).toBe(true);
    expect(readEditorLease(storage, key)).toEqual({
      ownerId: "a",
      expiresAt: 1_000 + EDITOR_LEASE_TTL_MS,
    });
    expect(renewEditorLease(storage, key, "a", 2_000)).toBe(true);
    expect(readEditorLease(storage, key)?.expiresAt).toBe(2_000 + EDITOR_LEASE_TTL_MS);
  });

  test("a live lease blocks another writer", () => {
    const storage = new MemoryStorage();
    const key = editorLeaseKey("p", "c");
    claimEditorLease(storage, key, "a", 1_000);
    expect(claimEditorLease(storage, key, "b", 2_000)).toBe(false);
    expect(readEditorLease(storage, key)?.ownerId).toBe("a");
  });

  test("an expired lease is recoverable and explicit takeover is immediate", () => {
    const storage = new MemoryStorage();
    const key = editorLeaseKey("p", "c");
    claimEditorLease(storage, key, "a", 1_000);
    expect(claimEditorLease(storage, key, "b", 1_000 + EDITOR_LEASE_TTL_MS + 1)).toBe(true);
    expect(claimEditorLease(storage, key, "c", 1_001, true)).toBe(true);
    expect(readEditorLease(storage, key)?.ownerId).toBe("c");
  });

  test("only the owner can release or renew a lease", () => {
    const storage = new MemoryStorage();
    const key = editorLeaseKey("p", "c");
    claimEditorLease(storage, key, "a", 1_000);
    expect(renewEditorLease(storage, key, "b", 2_000)).toBe(false);
    releaseEditorLease(storage, key, "b");
    expect(readEditorLease(storage, key)?.ownerId).toBe("a");
    releaseEditorLease(storage, key, "a");
    expect(readEditorLease(storage, key)).toBeNull();
  });
});

describe("autosave retry backoff", () => {
  test("grows exponentially and caps at thirty seconds", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 99].map(retryDelayMs)).toEqual([
      1_000,
      2_000,
      4_000,
      8_000,
      16_000,
      30_000,
      30_000,
      30_000,
    ]);
  });
});

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CAPTION_PRESET,
  editorDocumentSchema,
  studioEditsSchema,
  type EditorDocument,
  type TranscriptUtterance,
} from "@narriflow/validators";
import {
  ClipEditorDocumentPersistenceError,
  ClipEditorRevisionConflictError,
  createClipEditorDocumentPersistence,
  createInMemoryClipEditorDocumentStore,
  type ClipEditorDocumentStoredState,
} from "./clip-editor-document-persistence";

function utterance(text: string, startSec = 10): TranscriptUtterance {
  const words = text.split(" ");
  return {
    index: 0,
    speaker: 0,
    speakerLabel: "Speaker A",
    startSec,
    endSec: startSec + words.length * 0.5,
    text,
    confidence: null,
    words: words.map((word, index) => ({
      word,
      startSec: startSec + index * 0.5,
      endSec: startSec + (index + 1) * 0.5,
      confidence: null,
    })),
  };
}

function document(overrides: Partial<EditorDocument> = {}): EditorDocument {
  return editorDocumentSchema.parse({
    clipStartSec: 10,
    clipEndSec: 30,
    captionPreset: DEFAULT_CAPTION_PRESET,
    transcriptSlice: [utterance("one two three four")],
    studioEdits: studioEditsSchema.parse(undefined),
    brollUrl: null,
    deletedRanges: [],
    ...overrides,
  });
}

function stored(overrides: Partial<ClipEditorDocumentStoredState> = {}) {
  return {
    actorUserId: "user-1",
    projectId: "project-1",
    clipId: "clip-1",
    revision: 3,
    document: document(),
    original: null,
    sourceDurationSec: 300,
    sourceStorageKey: "projects/project-1/source.mp4",
    sourceTranscript: [utterance("one two three four five six", 10)],
    viralityScore: 70,
    status: "detected" as const,
    preview: {
      storageKey: "projects/project-1/clips/clip-1/preview.mp4",
      startSec: 6,
      durationSec: 28,
    },
    evidence: { screen: { version: 1 }, automatic: { version: 1 }, split: { version: 1 } },
    scores: { durationOptimality: 80, tiktok: 80, youtube: 70, instagram: 75 },
    mutableRenders: [{ id: "render-1", storageKey: "projects/project-1/renders/current.mp4" }],
    ...overrides,
  } satisfies ClipEditorDocumentStoredState;
}

function setup(state = stored()) {
  const store = createInMemoryClipEditorDocumentStore([state]);
  const persistence = createClipEditorDocumentPersistence({ store });
  const scope = {
    actorUserId: state.actorUserId,
    projectId: state.projectId,
    clipId: state.clipId,
  };
  return { persistence, scope, store };
}

describe("Clip Editor Document Persistence", () => {
  test("canonical no-op performs no write or invalidation", async () => {
    const { persistence, scope, store } = setup();
    const result = await persistence.mutateDocument({
      ...scope,
      intent: { kind: "replace", baseRevision: 3, document: document() },
    });

    expect(result).toMatchObject({ revision: 3, noop: true });
    const snapshot = store.inspect(scope.clipId)!;
    expect(snapshot.writeCount).toBe(0);
    expect(snapshot.state.mutableRenders).toHaveLength(1);
    expect(snapshot.cleanupObligations).toHaveLength(0);
  });

  test("real save captures one immutable original and durably retires mutable renders", async () => {
    const { persistence, scope, store } = setup();
    const next = document({ brollUrl: "https://cdn.example.com/cutaway.mp4" });
    const result = await persistence.mutateDocument({
      ...scope,
      intent: { kind: "replace", baseRevision: 3, document: next },
    });

    expect(result).toMatchObject({ revision: 4, noop: false, document: next });
    const snapshot = store.inspect(scope.clipId)!;
    expect(snapshot.state.original).toEqual(document());
    expect(snapshot.state.mutableRenders).toHaveLength(0);
    expect(snapshot.state.preview.storageKey).not.toBeNull();
    expect(snapshot.state.evidence).toEqual(stored().evidence);
    expect(snapshot.cleanupObligations.map((item) => item.objectKey)).toEqual([
      "projects/project-1/renders/current.mp4",
    ]);
  });

  test("lost successful response is acknowledged, while a different stale save conflicts", async () => {
    const { persistence, scope, store } = setup();
    const next = document({ brollUrl: "https://cdn.example.com/cutaway.mp4" });
    await persistence.mutateDocument({
      ...scope,
      intent: { kind: "replace", baseRevision: 3, document: next },
    });
    const acknowledged = await persistence.mutateDocument({
      ...scope,
      intent: { kind: "replace", baseRevision: 3, document: next },
    });
    expect(acknowledged).toMatchObject({ revision: 4, noop: true });
    expect(store.inspect(scope.clipId)!.writeCount).toBe(1);

    await expect(
      persistence.mutateDocument({
        ...scope,
        intent: { kind: "replace", baseRevision: 3, document: document({ brollUrl: null }) },
      }),
    ).rejects.toBeInstanceOf(ClipEditorRevisionConflictError);
  });

  test("boundary mutation invalidates only window-bound derived state", async () => {
    const { persistence, scope, store } = setup();
    const result = await persistence.mutateDocument({
      ...scope,
      intent: { kind: "set_boundaries", startSec: 12, endSec: 32 },
    });

    expect(result.revision).toBe(4);
    const snapshot = store.inspect(scope.clipId)!;
    expect(snapshot.state.preview.storageKey).toBeNull();
    expect(snapshot.state.evidence).toEqual({ screen: null, automatic: null, split: null });
    expect(snapshot.cleanupObligations.map((item) => item.cleanupClass).sort()).toEqual([
      "mutable_render",
      "preview_peaks",
      "preview_proxy",
    ]);
  });

  test("Reset restores the complete immutable original and repeated Reset is zero-write", async () => {
    const original = document({
      brollUrl: "https://cdn.example.com/original.mp4",
      deletedRanges: [{ startSec: 14, endSec: 15 }],
    });
    const { persistence, scope, store } = setup(stored({ original }));
    const first = await persistence.mutateDocument({
      ...scope,
      intent: { kind: "reset", baseRevision: 3 },
    });
    expect(first).toMatchObject({ revision: 4, document: original, noop: false });
    expect(store.inspect(scope.clipId)!.state.original).toEqual(original);

    const lostResponseRetry = await persistence.mutateDocument({
      ...scope,
      intent: { kind: "reset", baseRevision: 3 },
    });
    expect(lostResponseRetry).toMatchObject({ revision: 4, noop: true });
    expect(store.inspect(scope.clipId)!.writeCount).toBe(1);

    await persistence.mutateDocument({
      ...scope,
      intent: {
        kind: "replace",
        baseRevision: 4,
        document: document({ brollUrl: null }),
      },
    });
    await expect(
      persistence.mutateDocument({
        ...scope,
        intent: { kind: "reset", baseRevision: 4 },
      }),
    ).rejects.toMatchObject({ currentRevision: 5 });
  });

  test("transcript intent applies to the latest document without moving boundaries", async () => {
    const { persistence, scope, store } = setup();
    await persistence.mutateDocument({
      ...scope,
      intent: {
        kind: "replace",
        baseRevision: 3,
        document: document({ brollUrl: "https://cdn.example.com/new.mp4" }),
      },
    });
    const result = await persistence.mutateDocument({
      ...scope,
      intent: {
        kind: "set_transcript",
        transcriptSlice: [utterance("replacement words", 9.5)],
      },
    });

    expect(result.revision).toBe(5);
    expect(result.document.brollUrl).toBe("https://cdn.example.com/new.mp4");
    expect(result.document.clipStartSec).toBe(10);
    expect(result.document.clipEndSec).toBe(30);
    expect(result.document.transcriptSlice[0]?.startSec).toBeGreaterThanOrEqual(10);
    expect(store.inspect(scope.clipId)!.state.preview.storageKey).not.toBeNull();
  });

  test("bounded field retries surface typed retryable contention", async () => {
    const { persistence, scope, store } = setup();
    store.forceContention(3);
    await expect(
      persistence.mutateDocument({
        ...scope,
        intent: { kind: "set_transcript", transcriptSlice: [utterance("new words")] },
      }),
    ).rejects.toMatchObject<Partial<ClipEditorDocumentPersistenceError>>({
      code: "retryable_contention",
    });
    expect(store.inspect(scope.clipId)!.writeCount).toBe(0);
  });

  test("Reset without an original is revision guarded and changes nothing", async () => {
    const { persistence, scope, store } = setup();
    const noop = await persistence.mutateDocument({
      ...scope,
      intent: { kind: "reset", baseRevision: 3 },
    });
    expect(noop).toMatchObject({ revision: 3, noop: true });
    await expect(
      persistence.mutateDocument({
        ...scope,
        intent: { kind: "reset", baseRevision: 2 },
      }),
    ).rejects.toMatchObject({ currentRevision: 3 });
    expect(store.inspect(scope.clipId)).toMatchObject({
      writeCount: 0,
      cleanupObligations: [],
      state: { original: null, revision: 3 },
    });
  });

  test("validation rejects unsafe Reset media and a boundary change after source removal", async () => {
    const unsafeOriginal = document({ brollUrl: "http://127.0.0.1/private.mp4" });
    const unsafe = setup(stored({ original: unsafeOriginal }));
    await expect(
      unsafe.persistence.mutateDocument({
        ...unsafe.scope,
        intent: { kind: "reset", baseRevision: 3 },
      }),
    ).rejects.toThrow("unsafe_url");
    expect(unsafe.store.inspect(unsafe.scope.clipId)!.writeCount).toBe(0);

    const purged = setup(stored({ sourceStorageKey: null }));
    await expect(
      purged.persistence.mutateDocument({
        ...purged.scope,
        intent: { kind: "set_boundaries", startSec: 12, endSec: 32 },
      }),
    ).rejects.toMatchObject({ code: "editor_boundaries_invalid" });
    expect(purged.store.inspect(purged.scope.clipId)!.state.preview.storageKey).not.toBeNull();
  });

  test.each([
    [-1, 20],
    [20, 10],
    [10, 14],
    [10, 131],
    [290, 310],
  ])("boundary validation rejects %p to %p without mutation", async (startSec, endSec) => {
    const { persistence, scope, store } = setup();
    await expect(
      persistence.mutateDocument({
        ...scope,
        intent: { kind: "set_boundaries", startSec, endSec },
      }),
    ).rejects.toMatchObject({ code: "editor_boundaries_invalid" });
    expect(store.inspect(scope.clipId)!.writeCount).toBe(0);
  });

  test("malformed stored document is a typed corruption outcome", async () => {
    const malformed = stored();
    malformed.document = {
      ...malformed.document,
      studioEdits: { textLayers: "bad" },
    } as never;
    const { persistence, scope } = setup(malformed);
    await expect(persistence.readDocument(scope)).rejects.toMatchObject({
      code: "corrupt_stored_document",
    });
  });

  test("injected commit failure leaves the complete stored state untouched", async () => {
    const seed = stored();
    const backing = createInMemoryClipEditorDocumentStore([seed]);
    const persistence = createClipEditorDocumentPersistence({
      store: {
        read: (scope) => backing.read(scope),
        async commit() {
          throw new Error("injected transaction failure");
        },
      },
    });
    const before = backing.inspect(seed.clipId);
    await expect(
      persistence.mutateDocument({
        actorUserId: seed.actorUserId,
        projectId: seed.projectId,
        clipId: seed.clipId,
        intent: {
          kind: "replace",
          baseRevision: seed.revision,
          document: document({ brollUrl: "https://cdn.example.com/new.mp4" }),
        },
      }),
    ).rejects.toThrow("injected transaction failure");
    expect(backing.inspect(seed.clipId)).toEqual(before);
  });
});

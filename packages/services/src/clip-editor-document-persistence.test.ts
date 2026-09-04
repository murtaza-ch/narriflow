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
  decodeClipEditorDocumentFromStorage,
  encodeClipEditorDocumentForStorage,
  type ClipEditorDocumentDiagnostics,
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
    version: 2,
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
    workspaceId: "workspace-1",
    workspaceOwnerUserId: "user-1",
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

function actorScope(state: ClipEditorDocumentStoredState) {
  return {
    actorUserId: state.workspaceOwnerUserId,
    workspaceId: state.workspaceId,
    workspaceOwnerUserId: state.workspaceOwnerUserId,
  };
}

function setup(state = stored()) {
  const store = createInMemoryClipEditorDocumentStore([state]);
  const persistence = createClipEditorDocumentPersistence({ store });
  const scope = {
    ...actorScope(state),
    projectId: state.projectId,
    clipId: state.clipId,
  };
  return { persistence, scope, store };
}

describe("Clip Editor Document Persistence", () => {
  test("the storage codec round-trips canonical creation values and owns null defaults", () => {
    const encoded = encodeClipEditorDocumentForStorage(document(), 300);
    expect(
      decodeClipEditorDocumentFromStorage(
        {
          ...encoded,
          captionPreset: null,
          studioEdits: null,
          deletedRanges: null,
        },
        300,
      ),
    ).toEqual(document());
  });

  test("fails closed when storage contains an unknown future document version", () => {
    const encoded = encodeClipEditorDocumentForStorage(document(), 300);
    expect(() => decodeClipEditorDocumentFromStorage({ ...encoded, editorDocumentVersion: 99 }, 300)).toThrow(
      expect.objectContaining({ code: "unsupported_editor_document_version" }),
    );
  });

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

  test("an unchanged boundary intent preserves corrected words as a semantic no-op", async () => {
    const raw = utterance("one two three four");
    const corrected = structuredClone(raw);
    corrected.words[0]!.word = "ONE";
    corrected.text = "ONE two three four";
    const seed = stored({
      sourceTranscript: [raw],
      document: document({ transcriptSlice: [corrected] }),
    });
    const { persistence, scope, store } = setup(seed);

    const result = await persistence.mutateDocument({
      ...scope,
      intent: { kind: "set_boundaries", startSec: 10, endSec: 30 },
    });

    expect(result).toMatchObject({ revision: 3, noop: true });
    expect(result.document.transcriptSlice[0]?.words[0]?.word).toBe("ONE");
    expect(store.inspect(scope.clipId)?.writeCount).toBe(0);
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
    expect(store.inspect(scope.clipId)!.state.evidence).toEqual(stored().evidence);
    expect(store.inspect(scope.clipId)!.state.scores).toEqual(stored().scores);
  });

  test("caption preset intent applies to the latest document and retires only mutable renders", async () => {
    const { persistence, scope, store } = setup();
    const captionPreset = {
      ...DEFAULT_CAPTION_PRESET,
      fontName: "Bebas Neue",
      primaryColor: "#123456",
    };

    const result = await persistence.mutateDocument({
      ...scope,
      intent: { kind: "set_caption_preset", captionPreset },
    });

    expect(result).toMatchObject({
      revision: 4,
      noop: false,
      document: { captionPreset },
    });
    expect(store.inspect(scope.clipId)).toMatchObject({
      writeCount: 1,
      state: {
        original: document(),
        status: "edited",
        preview: stored().preview,
        evidence: stored().evidence,
        scores: stored().scores,
        mutableRenders: [],
      },
      cleanupObligations: [
        {
          cleanupClass: "mutable_render",
          objectKey: "projects/project-1/renders/current.mp4",
        },
      ],
    });
  });

  test("null caption intent resolves to the canonical default as a zero-write no-op", async () => {
    const { persistence, scope, store } = setup();

    const result = await persistence.mutateDocument({
      ...scope,
      intent: { kind: "set_caption_preset", captionPreset: null },
    });

    expect(result).toMatchObject({ revision: 3, noop: true });
    expect(result.document.captionPreset).toEqual(DEFAULT_CAPTION_PRESET);
    expect(store.inspect(scope.clipId)).toMatchObject({
      writeCount: 0,
      cleanupObligations: [],
      state: { original: null, mutableRenders: stored().mutableRenders },
    });
  });

  test("B-roll intent uses shared media safety and preserves unrelated document fields", async () => {
    const current = document({
      captionPreset: { ...DEFAULT_CAPTION_PRESET, fontName: "Impact" },
    });
    const { persistence, scope, store } = setup(stored({ document: current }));

    const result = await persistence.mutateDocument({
      ...scope,
      intent: {
        kind: "set_broll_url",
        brollUrl: "https://cdn.example.com/cutaway.mp4",
      },
    });

    expect(result.document).toMatchObject({
      brollUrl: "https://cdn.example.com/cutaway.mp4",
      captionPreset: current.captionPreset,
      studioEdits: current.studioEdits,
    });
    await expect(
      persistence.mutateDocument({
        ...scope,
        intent: {
          kind: "set_broll_url",
          brollUrl: "http://127.0.0.1/private.mp4",
        },
      }),
    ).rejects.toThrow("unsafe_url");
    expect(store.inspect(scope.clipId)?.writeCount).toBe(1);
  });

  test("Studio edits replace only that document field and deep-equivalent retries are no-ops", async () => {
    const { persistence, scope, store } = setup();
    const studioEdits = studioEditsSchema.parse({
      transition: { type: "fade", durationSec: 0.8 },
      sourceAudio: { volume: 72, muted: false },
    });

    const first = await persistence.mutateDocument({
      ...scope,
      intent: { kind: "set_studio_edits", studioEdits },
    });
    const retry = await persistence.mutateDocument({
      ...scope,
      intent: {
        kind: "set_studio_edits",
        studioEdits: studioEditsSchema.parse(structuredClone(studioEdits)),
      },
    });

    expect(first).toMatchObject({ revision: 4, noop: false });
    expect(first.document).toMatchObject({
      captionPreset: DEFAULT_CAPTION_PRESET,
      brollUrl: null,
      studioEdits,
    });
    expect(retry).toMatchObject({ revision: 4, noop: true });
    expect(store.inspect(scope.clipId)?.writeCount).toBe(1);
  });

  test("project selection applies one grouped layout intent atomically and excludes the open clip", async () => {
    const targetStudioEdits = studioEditsSchema.parse({
      background: { mode: "off" },
      framing: { mode: "center" },
    });
    const open = stored({ clipId: "clip-open" });
    const matching = stored({
      clipId: "clip-matching",
      document: document({ studioEdits: targetStudioEdits }),
    });
    const changedDocument = document({
      brollUrl: "https://cdn.example.com/keep.mp4",
      studioEdits: studioEditsSchema.parse({
        background: { mode: "color", color: "#112233" },
        framing: { mode: "auto" },
        sourceAudio: { volume: 61, muted: false },
      }),
    });
    const changed = stored({ clipId: "clip-changed", document: changedDocument });
    const store = createInMemoryClipEditorDocumentStore([open, matching, changed]);
    const persistence = createClipEditorDocumentPersistence({ store });

    const result = await persistence.mutateProjectSelection({
      ...actorScope(open),
      projectId: open.projectId,
      excludeClipId: open.clipId,
      intent: {
        kind: "patch_studio_edits",
        patches: [
          { background: targetStudioEdits.background },
          { framing: targetStudioEdits.framing },
        ],
      },
    });

    expect(result).toEqual({ updated: 1 });
    expect(store.inspect(open.clipId)).toMatchObject({ writeCount: 0 });
    expect(store.inspect(matching.clipId)).toMatchObject({
      writeCount: 0,
      state: { revision: 3, original: null, mutableRenders: matching.mutableRenders },
    });
    expect(store.inspect(changed.clipId)).toMatchObject({
      writeCount: 1,
      state: {
        revision: 4,
        original: changedDocument,
        document: {
          brollUrl: changedDocument.brollUrl,
          captionPreset: changedDocument.captionPreset,
          transcriptSlice: changedDocument.transcriptSlice,
          studioEdits: {
            background: targetStudioEdits.background,
            framing: targetStudioEdits.framing,
            sourceAudio: changedDocument.studioEdits.sourceAudio,
          },
        },
        preview: changed.preview,
        evidence: changed.evidence,
        scores: changed.scores,
        mutableRenders: [],
      },
      cleanupObligations: [
        {
          cleanupClass: "mutable_render",
          objectKey: "projects/project-1/renders/current.mp4",
        },
      ],
    });
  });

  test("project caption selection skips matching targets and changes each other clip once", async () => {
    const captionPreset = {
      ...DEFAULT_CAPTION_PRESET,
      fontName: "Impact",
      primaryColor: "#ABCDEF",
    };
    const matching = stored({
      clipId: "clip-matching",
      document: document({ captionPreset }),
    });
    const changed = stored({ clipId: "clip-changed" });
    const store = createInMemoryClipEditorDocumentStore([matching, changed]);
    const persistence = createClipEditorDocumentPersistence({ store });

    await expect(
      persistence.mutateProjectSelection({
        ...actorScope(matching),
        projectId: matching.projectId,
        intent: { kind: "set_caption_preset", captionPreset },
      }),
    ).resolves.toEqual({ updated: 1 });
    expect(store.inspect(matching.clipId)).toMatchObject({ writeCount: 0 });
    expect(store.inspect(changed.clipId)).toMatchObject({
      writeCount: 1,
      state: { revision: 4, document: { captionPreset }, mutableRenders: [] },
    });
  });

  test("a malformed project target aborts before any target changes", async () => {
    const valid = stored({ clipId: "clip-valid" });
    const malformed = stored({ clipId: "clip-malformed" });
    malformed.document = {
      ...malformed.document,
      studioEdits: { textLayers: "bad" },
    } as never;
    const store = createInMemoryClipEditorDocumentStore([valid, malformed]);
    const persistence = createClipEditorDocumentPersistence({ store });
    const before = store.inspect(valid.clipId);

    await expect(
      persistence.mutateProjectSelection({
        ...actorScope(valid),
        projectId: valid.projectId,
        intent: {
          kind: "set_caption_preset",
          captionPreset: { ...DEFAULT_CAPTION_PRESET, fontName: "Impact" },
        },
      }),
    ).rejects.toMatchObject({ code: "corrupt_stored_document" });
    expect(store.inspect(valid.clipId)).toEqual(before);
  });

  test("project contention exhausts without a partial mutation", async () => {
    const first = stored({ clipId: "clip-first" });
    const second = stored({ clipId: "clip-second" });
    const store = createInMemoryClipEditorDocumentStore([first, second]);
    store.forceContention(3);
    const persistence = createClipEditorDocumentPersistence({ store });

    await expect(
      persistence.mutateProjectSelection({
        ...actorScope(first),
        projectId: first.projectId,
        intent: {
          kind: "set_caption_preset",
          captionPreset: { ...DEFAULT_CAPTION_PRESET, fontName: "Impact" },
        },
      }),
    ).rejects.toMatchObject({ code: "retryable_contention" });
    expect(store.inspect(first.clipId)).toMatchObject({ writeCount: 0 });
    expect(store.inspect(second.clipId)).toMatchObject({ writeCount: 0 });
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
    studioEditsSchema.parse({ music: { url: "http://127.0.0.1/music.mp3" } }),
    studioEditsSchema.parse({
      background: {
        mode: "image",
        imageUrl: "http://127.0.0.1/background.png",
      },
    }),
  ])("full replacement rejects unsafe Studio media without mutation", async (studioEdits) => {
    const { persistence, scope, store } = setup();
    await expect(
      persistence.mutateDocument({
        ...scope,
        intent: {
          kind: "replace",
          baseRevision: 3,
          document: document({ studioEdits }),
        },
      }),
    ).rejects.toThrow("unsafe_url");
    expect(store.inspect(scope.clipId)!.writeCount).toBe(0);
  });

  test("deleted-range changes retain preview and scores but invalidate composition evidence", async () => {
    const { persistence, scope, store } = setup();
    await persistence.mutateDocument({
      ...scope,
      intent: {
        kind: "replace",
        baseRevision: 3,
        document: document({ deletedRanges: [{ startSec: 14, endSec: 15 }] }),
      },
    });
    const snapshot = store.inspect(scope.clipId)!;
    expect(snapshot.state.preview).toEqual(stored().preview);
    expect(snapshot.state.scores).toEqual(stored().scores);
    expect(snapshot.state.evidence).toEqual({ screen: null, automatic: null, split: null });
    expect(snapshot.cleanupObligations.map((item) => item.cleanupClass)).toEqual([
      "mutable_render",
    ]);
  });

  test.each([
    {
      name: "transcript",
      intent: {
        kind: "set_transcript" as const,
        transcriptSlice: [utterance("changed transcript words")],
      },
    },
    {
      name: "caption",
      intent: {
        kind: "set_caption_preset" as const,
        captionPreset: { ...DEFAULT_CAPTION_PRESET, fontName: "Impact" },
      },
    },
    {
      name: "B-roll",
      intent: {
        kind: "set_broll_url" as const,
        brollUrl: "https://cdn.example.com/matrix.mp4",
      },
    },
    {
      name: "Studio visual",
      intent: {
        kind: "set_studio_edits" as const,
        studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }),
      },
    },
    {
      name: "Studio audio",
      intent: {
        kind: "set_studio_edits" as const,
        studioEdits: studioEditsSchema.parse({
          sourceAudio: { volume: 40, muted: false },
        }),
      },
    },
  ])("$name changes retire renders while retaining window-bound work", async ({ intent }) => {
    const seed = stored();
    const { persistence, scope, store } = setup(seed);

    await persistence.mutateDocument({ ...scope, intent });

    expect(store.inspect(scope.clipId)).toMatchObject({
      state: {
        mutableRenders: [],
        preview: seed.preview,
        evidence: seed.evidence,
        scores: seed.scores,
      },
      cleanupObligations: [{ cleanupClass: "mutable_render" }],
    });
  });

  test("same-window Reset retains eligible preview and evidence", async () => {
    const original = document({ brollUrl: "https://cdn.example.com/original.mp4" });
    const { persistence, scope, store } = setup(stored({ original }));
    await persistence.mutateDocument({
      ...scope,
      intent: { kind: "reset", baseRevision: 3 },
    });
    const snapshot = store.inspect(scope.clipId)!;
    expect(snapshot.state.preview).toEqual(stored().preview);
    expect(snapshot.state.evidence).toEqual(stored().evidence);
    expect(snapshot.state.scores).toEqual(stored().scores);
  });

  test("unknown source duration permits an otherwise valid boundary window", async () => {
    const { persistence, scope } = setup(stored({ sourceDurationSec: null }));
    const result = await persistence.mutateDocument({
      ...scope,
      intent: { kind: "set_boundaries", startSec: 290, endSec: 310 },
    });
    expect(result).toMatchObject({
      revision: 4,
      document: { clipStartSec: 290, clipEndSec: 310 },
    });
  });

  test("the exact maximum boundary duration remains valid", async () => {
    const { persistence, scope } = setup();
    const result = await persistence.mutateDocument({
      ...scope,
      intent: { kind: "set_boundaries", startSec: 10, endSec: 130 },
    });
    expect(result.document).toMatchObject({ clipStartSec: 10, clipEndSec: 130 });
  });

  test("a no-op transcript field intent preserves every dependent record", async () => {
    const seed = stored();
    const { persistence, scope, store } = setup(seed);
    const result = await persistence.mutateDocument({
      ...scope,
      intent: { kind: "set_transcript", transcriptSlice: seed.document.transcriptSlice },
    });
    expect(result).toMatchObject({ revision: 3, noop: true });
    expect(store.inspect(scope.clipId)).toMatchObject({
      writeCount: 0,
      cleanupObligations: [],
      state: {
        original: null,
        mutableRenders: seed.mutableRenders,
        preview: seed.preview,
        evidence: seed.evidence,
        scores: seed.scores,
      },
    });
  });

  test("a no-op field intent rebases when a full save wins before acknowledgement", async () => {
    const seed = stored();
    const backing = createInMemoryClipEditorDocumentStore([seed]);
    const competing = createClipEditorDocumentPersistence({ store: backing });
    let raced = false;
    const persistence = createClipEditorDocumentPersistence({
      store: {
        read: (scope) => backing.read(scope),
        commit: (input) => backing.commit(input),
        async confirmRevision(scope, revision) {
          if (!raced) {
            raced = true;
            await competing.mutateDocument({
              ...scope,
              intent: {
                kind: "replace",
                baseRevision: revision,
                document: document({ brollUrl: "https://cdn.example.com/race.mp4" }),
              },
            });
          }
          return backing.confirmRevision(scope, revision);
        },
      },
    });

    const result = await persistence.mutateDocument({
      ...actorScope(seed),
      projectId: seed.projectId,
      clipId: seed.clipId,
      intent: { kind: "set_transcript", transcriptSlice: seed.document.transcriptSlice },
    });

    expect(result).toMatchObject({
      revision: 4,
      noop: true,
      document: { brollUrl: "https://cdn.example.com/race.mp4" },
    });
    expect(backing.inspect(seed.clipId)?.writeCount).toBe(1);
  });

  test("Reset without an original conflicts when a first save wins before acknowledgement", async () => {
    const seed = stored();
    const backing = createInMemoryClipEditorDocumentStore([seed]);
    const competing = createClipEditorDocumentPersistence({ store: backing });
    let raced = false;
    const persistence = createClipEditorDocumentPersistence({
      store: {
        read: (scope) => backing.read(scope),
        commit: (input) => backing.commit(input),
        async confirmRevision(scope, revision) {
          if (!raced) {
            raced = true;
            await competing.mutateDocument({
              ...scope,
              intent: {
                kind: "replace",
                baseRevision: revision,
                document: document({ brollUrl: "https://cdn.example.com/race.mp4" }),
              },
            });
          }
          return backing.confirmRevision(scope, revision);
        },
      },
    });

    await expect(
      persistence.mutateDocument({
        ...actorScope(seed),
        projectId: seed.projectId,
        clipId: seed.clipId,
        intent: { kind: "reset", baseRevision: seed.revision },
      }),
    ).rejects.toMatchObject({ currentRevision: 4 });
    expect(backing.inspect(seed.clipId)).toMatchObject({
      writeCount: 1,
      state: { revision: 4, original: seed.document },
    });
  });

  test("a boundary-changing Reset after source removal preserves current state", async () => {
    const original = document({ clipStartSec: 12, clipEndSec: 32 });
    const seed = stored({ original, sourceStorageKey: null });
    const { persistence, scope, store } = setup(seed);
    await expect(
      persistence.mutateDocument({
        ...scope,
        intent: { kind: "reset", baseRevision: 3 },
      }),
    ).rejects.toMatchObject({ code: "editor_boundaries_invalid" });
    expect(store.inspect(scope.clipId)).toMatchObject({
      writeCount: 0,
      cleanupObligations: [],
      state: { revision: 3, document: seed.document, preview: seed.preview },
    });
  });

  test("frame-unsafe deleted-range slivers are rejected before commit", async () => {
    const { persistence, scope, store } = setup();
    await expect(
      persistence.mutateDocument({
        ...scope,
        intent: {
          kind: "replace",
          baseRevision: 3,
          document: document({ deletedRanges: [{ startSec: 10, endSec: 29.99 }] }),
        },
      }),
    ).rejects.toMatchObject({ code: "editor_document_empty_timeline" });
    expect(store.inspect(scope.clipId)!.writeCount).toBe(0);
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
        confirmRevision: (scope, revision) => backing.confirmRevision(scope, revision),
        async commit() {
          throw new Error("injected transaction failure");
        },
      },
    });
    const before = backing.inspect(seed.clipId);
    await expect(
      persistence.mutateDocument({
        ...actorScope(seed),
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

  test("mutation diagnostics expose settlement metadata without document or storage contents", async () => {
    const seed = stored();
    const store = createInMemoryClipEditorDocumentStore([seed]);
    const events: Array<Parameters<ClipEditorDocumentDiagnostics["record"]>[0]> = [];
    const persistence = createClipEditorDocumentPersistence({
      store,
      diagnostics: { record: (event) => events.push(event) },
      now: () => new Date("2026-08-29T00:00:00.000Z"),
    });

    await persistence.mutateDocument({
      ...actorScope(seed),
      projectId: seed.projectId,
      clipId: seed.clipId,
      intent: {
        kind: "set_broll_url",
        brollUrl: "https://cdn.example.com/private-object-key.mp4",
      },
    });

    expect(events).toEqual([
      {
        actorUserId: seed.workspaceOwnerUserId,
        projectId: seed.projectId,
        clipId: seed.clipId,
        mutationKind: "set_broll_url",
        attempt: 1,
        baseRevision: null,
        resultingRevision: 4,
        noop: false,
        invalidationClasses: ["mutable_renders"],
        cleanupCount: 1,
        outcome: "accepted",
        elapsedMs: 0,
      },
    ]);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("private-object-key");
    expect(serialized).not.toContain("current.mp4");
    expect(serialized).not.toContain("captionPreset");
  });
});

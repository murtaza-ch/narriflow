import { describe, expect, test } from "bun:test";
import { compositionAssetRef } from "@narriflow/composition-plan";
import {
  DEFAULT_CAPTION_PRESET,
  editorDocumentSchema,
  studioEditsSchema,
  type ClipAutoLayoutAnalysis,
  type EditorDocument,
} from "@narriflow/validators";
import {
  createStudioEditingSession,
  type StudioSessionDependencies,
  type StudioSessionSnapshot,
} from "./studio-editing-session";

function makeDocument(startSec = 10, endSec = 40): EditorDocument {
  return editorDocumentSchema.parse({
    clipStartSec: startSec,
    clipEndSec: endSec,
    captionPreset: DEFAULT_CAPTION_PRESET,
    transcriptSlice: [],
    studioEdits: studioEditsSchema.parse(undefined),
    brollUrl: null,
    deletedRanges: [],
  });
}

function makeAutomaticLayout(
  deletedRanges: Array<{ startSec: number; endSec: number }> = [],
): ClipAutoLayoutAnalysis {
  const editedDurationSec =
    30 -
    deletedRanges.reduce(
      (total, range) => total + (range.endSec - range.startSec),
      0,
    );
  return {
    version: 1,
    engine: "shot-layout-v1",
    sourceIdentity: compositionAssetRef("source", "project"),
    analyzedAtISO: "2026-08-14T00:00:00.000Z",
    clipStartSec: 10,
    clipEndSec: 40,
    deletedRanges,
    editedDurationSec,
    sourceWidth: 1920,
    sourceHeight: 1080,
    segments: [
      {
        startSec: 0,
        endSec: editedDurationSec,
        layout: "single",
        cxNorm: 0.5,
        cyNorm: 0.5,
        zoom: 1,
      },
    ],
    noSplitSegments: [
      {
        startSec: 0,
        endSec: editedDurationSec,
        layout: "single",
        cxNorm: 0.5,
        cyNorm: 0.5,
        zoom: 1,
      },
    ],
    shotCount: 1,
    soloShotCount: 1,
    multiShotCount: 0,
    twoUpSegmentCount: 0,
    speakerCount: 1,
    mappedSpeakerCount: 1,
  };
}

function waitForSnapshot(
  session: ReturnType<typeof createStudioEditingSession>,
  predicate: (snapshot: StudioSessionSnapshot) => boolean,
): Promise<StudioSessionSnapshot> {
  const current = session.getSnapshot();
  if (predicate(current)) return Promise.resolve(current);
  return new Promise((resolve) => {
    const unsubscribe = session.subscribe(() => {
      const next = session.getSnapshot();
      if (!predicate(next)) return;
      unsubscribe();
      resolve(next);
    });
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class ManualRuntime {
  nowMs = 100;
  private nextTimerId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  now = () => this.nowMs;
  createId = () => "writer";
  random = () => 0.5;
  isOnline = () => true;
  clearTimeout = (id: number) => {
    this.timers.delete(id);
  };
  setTimeout = (callback: () => void, delayMs: number) => {
    const id = this.nextTimerId;
    this.nextTimerId += 1;
    this.timers.set(id, { at: this.nowMs + delayMs, callback });
    return id;
  };

  advance(ms: number): void {
    const target = this.nowMs + ms;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.nowMs = due[1].at;
      due[1].callback();
    }
    this.nowMs = target;
  }
}

function makeDeterministicDependencies(
  cloudDocument: EditorDocument,
  options: {
    runtime?: ManualRuntime;
    preview?: StudioSessionDependencies["preview"];
    ownership?: "writer" | "reader";
    headDocument?: EditorDocument;
    headRevision?: number;
  } = {},
): StudioSessionDependencies {
  let revision = options.headRevision ?? 3;
  cloudDocument = options.headDocument ?? cloudDocument;
  return {
    drafts: {
      load: async () => null,
      write: async () => "written",
      remove: async () => "removed",
    },
    coordination: {
      start: async () => ({
        kind: options.ownership ?? "writer",
        generation: 1,
      }),
      takeOver: async () => ({ kind: "acquired", generation: 2, forced: false }),
      close: () => undefined,
    },
    cloud: {
      loadHead: async () => ({ revision, document: cloudDocument }),
      save: async ({ document }) => {
        revision += 1;
        cloudDocument = structuredClone(document);
        return { kind: "saved", revision, document: cloudDocument };
      },
    },
    ...(options.preview ? { preview: options.preview } : {}),
    runtime: options.runtime ?? new ManualRuntime(),
  };
}

describe("StudioEditingSession preview eligibility seam", () => {
  test("falls back to source immediately for a boundary edit and reuses the exact proxy on undo", async () => {
    const session = createStudioEditingSession({
      document: makeDocument(),
      segments: [],
      preview: {
        sourceUrl: "https://cdn.example.com/source.mp4",
        sourcePurged: false,
        proxy: {
          url: "https://cdn.example.com/proxy.mp4",
          startSec: 6,
          durationSec: 38,
          waveformPeaksUrl: "/preview-peaks?v=old",
        },
        automaticLayout: null,
      },
    });

    const original = session.getSnapshot().preview;
    expect(original.activeAsset.kind).toBe("proxy");
    expect(original.proxy?.windowFingerprint).toBe("10.000:40.000");

    expect(
      await session.perform({
        type: "trim",
        startSec: 12,
        endSec: 38,
        transcriptSlice: [],
        segments: [],
      }),
    ).toEqual({ kind: "trimmed" });

    const trimmed = session.getSnapshot().preview;
    expect(trimmed.proxy).toBeNull();
    expect(trimmed.waveformPeaksUrl).toBeNull();
    expect(trimmed.activeAsset).toEqual({
      kind: "source",
      url: "https://cdn.example.com/source.mp4",
      offsetSec: 0,
    });

    session.dispatch({ type: "history.undo" });

    const undone = session.getSnapshot().preview;
    expect(undone.proxy?.url).toBe("https://cdn.example.com/proxy.mp4");
    expect(undone.waveformPeaksUrl).toBe("/preview-peaks?v=old");
    expect(undone.activeAsset.kind).toBe("proxy");
  });

  test("invalidates automatic layout as soon as its deleted-range inputs change", () => {
    const session = createStudioEditingSession({
      document: makeDocument(),
      segments: [],
      preview: {
        sourceUrl: "https://cdn.example.com/source.mp4",
        sourcePurged: false,
        proxy: null,
        automaticLayout: makeAutomaticLayout(),
      },
    });

    expect(session.getSnapshot().preview.automaticLayout).not.toBeNull();

    session.dispatch({
      type: "document.edit",
      action: {
        type: "deleteRange",
        range: { startSec: 20, endSec: 22 },
      },
    });

    expect(session.getSnapshot().preview.automaticLayout).toBeNull();
  });

  test("retires an invalidated proxy and waveform when the boundary save is acknowledged", async () => {
    const cloud = makeDocument();
    const session = createStudioEditingSession(
      {
        projectId: "project",
        clipId: "clip",
        cloudRevision: 3,
        document: cloud,
        segments: [],
        preview: {
          sourceUrl: "https://cdn.example.com/source.mp4",
          sourcePurged: false,
          proxy: {
            url: "https://cdn.example.com/proxy.mp4",
            startSec: 6,
            durationSec: 38,
            waveformPeaksUrl: "/preview-peaks?v=old",
          },
          automaticLayout: makeAutomaticLayout(),
        },
      },
      makeDeterministicDependencies(cloud),
    );
    await waitForSnapshot(session, (snapshot) => snapshot.status === "ready");

    await session.perform({
      type: "trim",
      startSec: 12,
      endSec: 38,
      transcriptSlice: [],
      segments: [],
    });
    expect(await session.perform({ type: "checkpoint-cloud" })).toEqual({
      kind: "cloud-current",
      revision: 4,
    });

    session.dispatch({ type: "history.undo" });

    const afterUndo = session.getSnapshot().preview;
    expect(afterUndo.proxy).toBeNull();
    expect(afterUndo.waveformPeaksUrl).toBeNull();
    expect(afterUndo.automaticLayout).toBeNull();
    expect(afterUndo.activeAsset.kind).toBe("source");
  });

  test("adopts only a matching replacement proxy and ignores a stale poll response", async () => {
    const cloud = makeDocument();
    const runtime = new ManualRuntime();
    const polls: Array<ReturnType<typeof deferred<{
      previewUrl: string | null;
      previewStartSec: number;
      previewDurationSec: number | null;
      waveformPeaksUrl: string | null;
    }>>> = [];
    const session = createStudioEditingSession(
      {
        projectId: "project",
        clipId: "clip",
        cloudRevision: 3,
        document: cloud,
        segments: [],
        preview: {
          sourceUrl: "https://cdn.example.com/source.mp4",
          sourcePurged: false,
          proxy: {
            url: "https://cdn.example.com/original.mp4",
            startSec: 6,
            durationSec: 38,
            waveformPeaksUrl: "/preview-peaks?v=original",
          },
          automaticLayout: null,
        },
      },
      makeDeterministicDependencies(cloud, {
        runtime,
        preview: {
          fetchProxyStatus: () => {
            const poll = deferred<{
              previewUrl: string | null;
              previewStartSec: number;
              previewDurationSec: number | null;
              waveformPeaksUrl: string | null;
            }>();
            polls.push(poll);
            return poll.promise;
          },
          fetchAutomaticLayout: async () => null,
        },
      }),
    );
    await waitForSnapshot(session, (snapshot) => snapshot.status === "ready");

    await session.perform({
      type: "trim",
      startSec: 12,
      endSec: 38,
      transcriptSlice: [],
      segments: [],
    });
    await session.perform({ type: "checkpoint-cloud" });
    runtime.advance(8_000);
    expect(polls).toHaveLength(1);

    await session.perform({
      type: "trim",
      startSec: 14,
      endSec: 36,
      transcriptSlice: [],
      segments: [],
    });
    await session.perform({ type: "checkpoint-cloud" });
    polls[0]!.resolve({
      previewUrl: "https://cdn.example.com/stale.mp4",
      previewStartSec: 8,
      previewDurationSec: 36,
      waveformPeaksUrl: "/preview-peaks?v=stale",
    });
    await Promise.resolve();
    expect(session.getSnapshot().preview.proxy).toBeNull();

    runtime.advance(8_000);
    expect(polls).toHaveLength(2);
    polls[1]!.resolve({
      previewUrl: "https://cdn.example.com/replacement.mp4",
      previewStartSec: 10,
      previewDurationSec: 30,
      waveformPeaksUrl: "/preview-peaks?v=replacement",
    });
    await waitForSnapshot(
      session,
      (snapshot) => snapshot.preview.proxy?.url.endsWith("replacement.mp4") === true,
    );

    expect(session.getSnapshot().preview.proxy).toMatchObject({
      url: "https://cdn.example.com/replacement.mp4",
      waveformPeaksUrl: "/preview-peaks?v=replacement",
      windowFingerprint: "14.000:36.000",
    });
    expect(session.getSnapshot().preview.activeAsset.kind).toBe("proxy");
  });

  test("ignores stale analysis and adopts only a result matching the current inputs", async () => {
    const cloud = makeDocument();
    const runtime = new ManualRuntime();
    const polls: Array<ReturnType<typeof deferred<ClipAutoLayoutAnalysis | null>>> = [];
    const session = createStudioEditingSession(
      {
        projectId: "project",
        clipId: "clip",
        cloudRevision: 3,
        document: cloud,
        segments: [],
        preview: {
          sourceUrl: "https://cdn.example.com/source.mp4",
          sourcePurged: false,
          proxy: {
            url: "https://cdn.example.com/proxy.mp4",
            startSec: 6,
            durationSec: 38,
            waveformPeaksUrl: "/preview-peaks?v=current",
          },
          automaticLayout: null,
        },
      },
      makeDeterministicDependencies(cloud, {
        runtime,
        preview: {
          fetchProxyStatus: async () => ({
            previewUrl: null,
            previewStartSec: 0,
            previewDurationSec: null,
            waveformPeaksUrl: null,
          }),
          fetchAutomaticLayout: () => {
            const poll = deferred<ClipAutoLayoutAnalysis | null>();
            polls.push(poll);
            return poll.promise;
          },
        },
      }),
    );
    await waitForSnapshot(session, (snapshot) => snapshot.status === "ready");

    runtime.advance(2_000);
    expect(polls).toHaveLength(1);
    session.dispatch({
      type: "document.edit",
      action: {
        type: "deleteRange",
        range: { startSec: 20, endSec: 22 },
      },
    });
    polls[0]!.resolve(makeAutomaticLayout());
    await Promise.resolve();
    expect(session.getSnapshot().preview.automaticLayout).toBeNull();

    await session.perform({ type: "checkpoint-cloud" });
    runtime.advance(2_000);
    expect(polls).toHaveLength(2);
    polls[1]!.resolve(
      makeAutomaticLayout([{ startSec: 20, endSec: 22 }]),
    );
    await waitForSnapshot(
      session,
      (snapshot) => snapshot.preview.automaticLayout !== null,
    );

    expect(session.getSnapshot().preview.automaticLayout?.deletedRanges).toEqual([
      { startSec: 20, endSec: 22 },
    ]);
  });

  test("marks automatic layout failed after the bounded polling deadline", async () => {
    const cloud = makeDocument();
    const runtime = new ManualRuntime();
    const session = createStudioEditingSession(
      {
        projectId: "project",
        clipId: "clip",
        cloudRevision: 3,
        document: cloud,
        segments: [],
        preview: {
          sourceUrl: "https://cdn.example.com/source.mp4",
          sourcePurged: false,
          proxy: {
            url: "https://cdn.example.com/proxy.mp4",
            startSec: 6,
            durationSec: 38,
            waveformPeaksUrl: "/preview-peaks?v=current",
          },
          automaticLayout: null,
        },
      },
      makeDeterministicDependencies(cloud, {
        runtime,
        preview: {
          fetchAutomaticLayout: async () => null,
        },
      }),
    );
    await waitForSnapshot(session, (snapshot) => snapshot.status === "ready");
    expect(session.getSnapshot().preview.automaticLayoutStatus).toBe("pending");

    for (let elapsedMs = 0; elapsedMs < 390_000; elapsedMs += 30_000) {
      runtime.advance(30_000);
      await Promise.resolve();
    }

    expect(session.getSnapshot().preview.automaticLayout).toBeNull();
    expect(session.getSnapshot().preview.automaticLayoutStatus).toBe("failed");
  });


  test("bounds proxy readiness polling", async () => {
    const cloud = makeDocument();
    const runtime = new ManualRuntime();
    let polls = 0;
    const session = createStudioEditingSession(
      {
        projectId: "project",
        clipId: "clip",
        cloudRevision: 3,
        document: cloud,
        segments: [],
        preview: {
          sourceUrl: "https://cdn.example.com/source.mp4",
          sourcePurged: false,
          proxy: null,
          automaticLayout: null,
        },
      },
      makeDeterministicDependencies(cloud, {
        runtime,
        preview: {
          fetchProxyStatus: async () => {
            polls += 1;
            return {
              previewUrl: null,
              previewStartSec: 0,
              previewDurationSec: null,
              waveformPeaksUrl: null,
            };
          },
        },
      }),
    );
    await waitForSnapshot(session, (snapshot) => snapshot.status === "ready");

    for (let attempt = 0; attempt < 50; attempt += 1) {
      runtime.advance(8_000);
      await Promise.resolve();
    }

    expect(polls).toBe(45);
    expect(session.getSnapshot().preview.proxy).toBeNull();
  });

  test("ignores a proxy response from a closed session generation", async () => {
    const cloud = makeDocument();
    const runtime = new ManualRuntime();
    const poll = deferred<{
      previewUrl: string | null;
      previewStartSec: number;
      previewDurationSec: number | null;
      waveformPeaksUrl: string | null;
    }>();
    const session = createStudioEditingSession(
      {
        projectId: "project",
        clipId: "clip",
        cloudRevision: 3,
        document: cloud,
        segments: [],
        preview: {
          sourceUrl: "https://cdn.example.com/source.mp4",
          sourcePurged: false,
          proxy: null,
          automaticLayout: null,
        },
      },
      makeDeterministicDependencies(cloud, {
        runtime,
        preview: {
          fetchProxyStatus: () => poll.promise,
        },
      }),
    );
    await waitForSnapshot(session, (snapshot) => snapshot.status === "ready");
    runtime.advance(8_000);

    await session.perform({ type: "close", reason: "navigation" });
    poll.resolve({
      previewUrl: "https://cdn.example.com/late.mp4",
      previewStartSec: 6,
      previewDurationSec: 38,
      waveformPeaksUrl: "/preview-peaks?v=late",
    });
    await Promise.resolve();

    expect(session.getSnapshot().status).toBe("closed");
    expect(session.getSnapshot().preview.proxy).toBeNull();
  });

  test("lets a read-only session opt into source playback", async () => {
    const cloud = makeDocument();
    const session = createStudioEditingSession(
      {
        projectId: "project",
        clipId: "clip",
        cloudRevision: 3,
        document: cloud,
        segments: [],
        preview: {
          sourceUrl: "https://cdn.example.com/source.mp4",
          sourcePurged: false,
          proxy: null,
          automaticLayout: null,
        },
      },
      makeDeterministicDependencies(cloud, { ownership: "reader" }),
    );
    await waitForSnapshot(session, (snapshot) => snapshot.status === "ready");

    expect(
      session.dispatch({
        type: "preview.set-source-fallback",
        enabled: true,
      }),
    ).toEqual({ accepted: true });
    expect(session.getSnapshot().preview.activeAsset.kind).toBe("source");
  });

  test("never reuses assets invalidated before takeover refreshed the cloud head", async () => {
    const original = makeDocument();
    const remote = makeDocument(12, 38);
    const session = createStudioEditingSession(
      {
        projectId: "project",
        clipId: "clip",
        cloudRevision: 3,
        document: original,
        segments: [],
        preview: {
          sourceUrl: "https://cdn.example.com/source.mp4",
          sourcePurged: false,
          proxy: {
            url: "https://cdn.example.com/original.mp4",
            startSec: 6,
            durationSec: 38,
            waveformPeaksUrl: "/preview-peaks?v=original",
          },
          automaticLayout: makeAutomaticLayout(),
        },
      },
      makeDeterministicDependencies(original, {
        ownership: "reader",
        headDocument: remote,
        headRevision: 4,
      }),
    );
    await waitForSnapshot(session, (snapshot) => snapshot.status === "ready");

    expect(await session.perform({ type: "take-over" })).toMatchObject({
      kind: "ownership-acquired",
      cloudRevision: 4,
    });
    expect(session.getSnapshot().document).toMatchObject({
      clipStartSec: 12,
      clipEndSec: 38,
    });

    await session.perform({
      type: "trim",
      startSec: 10,
      endSec: 40,
      transcriptSlice: [],
      segments: [],
    });

    expect(session.getSnapshot().preview.proxy).toBeNull();
    expect(session.getSnapshot().preview.waveformPeaksUrl).toBeNull();
    expect(session.getSnapshot().preview.automaticLayout).toBeNull();
  });
});

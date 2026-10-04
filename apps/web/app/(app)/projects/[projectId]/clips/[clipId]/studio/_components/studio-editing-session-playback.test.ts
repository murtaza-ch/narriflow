import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CAPTION_PRESET,
  editorDocumentSchema,
  studioEditsSchema,
  type EditorDocument,
} from "@narriflow/validators";
import {
  baseEditedToComposite,
  compositeToBaseEdited,
  createStudioEditingSession,
  type StudioMediaAdapter,
  type StudioMediaCommand,
  type StudioMediaEvent,
} from "./studio-editing-session";

test("projects source lanes around an intro and a mid-roll scene", () => {
  const document = makeDocument();
  document.sceneBlocks = [
    { id: crypto.randomUUID(), schemaVersion: 1, anchorSec: 0, durationSec: 3, content: { kind: "color", color: "#111827" }, motion: { entrance: "none", exit: "none" }, templateSnapshot: null },
    { id: crypto.randomUUID(), schemaVersion: 1, anchorSec: 8, durationSec: 2, content: { kind: "color", color: "#1D4ED8" }, motion: { entrance: "none", exit: "none" }, templateSnapshot: null },
  ];
  expect(baseEditedToComposite(document, 0)).toBe(3);
  expect(baseEditedToComposite(document, 4)).toBe(7);
  expect(baseEditedToComposite(document, 5)).toBe(10);
  expect(compositeToBaseEdited(document, 1)).toBe(0);
  expect(compositeToBaseEdited(document, 8.5)).toBe(5);
  expect(compositeToBaseEdited(document, 12)).toBe(7);
});

function makeDocument(
  deletedRanges: Array<{ startSec: number; endSec: number }> = [],
): EditorDocument {
  return editorDocumentSchema.parse({
    version: 1,
    clipStartSec: 10,
    clipEndSec: 40,
    captionPreset: DEFAULT_CAPTION_PRESET,
    transcriptSlice: [],
    studioEdits: studioEditsSchema.parse(undefined),
    brollUrl: null,
    deletedRanges,
  });
}

class InMemoryMediaAdapter implements StudioMediaAdapter {
  readonly commands: StudioMediaCommand[] = [];
  private listener: ((event: StudioMediaEvent) => void) | null = null;

  subscribe(listener: (event: StudioMediaEvent) => void): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = null;
    };
  }

  command(command: StudioMediaCommand): void {
    this.commands.push(structuredClone(command));
  }

  emit(event: StudioMediaEvent): void {
    this.listener?.(event);
  }
}

class ManualRuntime {
  nowMs = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { callback: () => void; dueAt: number }>();

  now = () => this.nowMs;
  createId = () => "session";
  setTimeout = (callback: () => void, delayMs: number) => {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { callback, dueAt: this.nowMs + delayMs });
    return id;
  };
  clearTimeout = (id: number) => {
    this.timers.delete(id);
  };
  advance(ms: number) {
    this.nowMs += ms;
    for (;;) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.dueAt <= this.nowMs)
        .sort((left, right) => left[1].dueAt - right[1].dueAt)[0];
      if (!next) return;
      this.timers.delete(next[0]);
      next[1].callback();
    }
  }
}

function makeSession(
  media: InMemoryMediaAdapter,
  ownership: "writer" | "reader" = "writer",
  runtime = new ManualRuntime(),
  document = makeDocument(),
) {
  return createStudioEditingSession(
    {
      projectId: "project",
      clipId: "clip",
      cloudRevision: 1,
      document,
      segments: [],
      preview: {
        sourceUrl: "https://cdn.example.com/source.mp4",
        sourcePurged: false,
        proxy: {
          url: "https://cdn.example.com/proxy.mp4",
          startSec: 6,
          durationSec: 38,
          waveformPeaksUrl: null,
        },
        automaticLayout: null,
      },
    },
    {
      drafts: {
        load: async () => null,
        write: async () => "written",
        remove: async () => "removed",
      },
      coordination: {
        start: async () => ({ kind: ownership, generation: 1 }),
        takeOver: async () => ({ kind: "acquired", generation: 2, forced: false }),
        close: () => undefined,
      },
      cloud: {
        loadHead: async () => ({ revision: 1, document }),
      },
      runtime,
      media,
    },
  );
}

function insertedSceneDocument(): EditorDocument {
  const document = makeDocument();
  document.sceneBlocks = [{
    id: "8b16c1ce-6aaa-4fe0-88f2-6528a9193df1",
    schemaVersion: 1,
    anchorSec: 4.414,
    durationSec: 3,
    content: { kind: "text", text: "Timing verification", color: "#FFFFFF", fontFamily: "Archivo", fontAsset: null, backgroundColor: "#111827" },
    motion: { entrance: "fade", exit: "fade", durationSec: 0.5 },
    templateSnapshot: null,
  }];
  return document;
}

describe("StudioEditingSession playback seam", () => {
  test("applies the planner-owned output envelope through the session audio command", async () => {
    const media = new InMemoryMediaAdapter();
    const session = makeSession(media);
    while (session.getSnapshot().status !== "ready") await Promise.resolve();
    const binding = session.getSnapshot().playback.mediaBinding;

    expect(
      session.dispatch({
        type: "preview.set-source-audio-envelope",
        gain: 0.25,
      }),
    ).toEqual({ accepted: true });
    expect(media.commands.at(-1)).toEqual({
      type: "set-audio",
      binding,
      muted: false,
      volume: 0.25,
    });

    session.dispatch({
      type: "document.edit",
      action: {
        type: "setStudioEdits",
        studioEdits: {
          ...makeDocument().studioEdits,
          sourceAudio: { muted: false, volume: 60 },
        },
      },
    });
    expect(media.commands.at(-1)).toEqual({
      type: "set-audio",
      binding,
      muted: false,
      volume: 0.15,
    });
  });

  test("preserves a kept source frame across a cut and undo", async () => {
    const media = new InMemoryMediaAdapter();
    const session = makeSession(media);
    while (session.getSnapshot().status !== "ready") await Promise.resolve();
    const binding = session.getSnapshot().playback.mediaBinding;

    session.dispatch({ type: "playback.seek", editedTimeSec: 15 });
    expect(session.getSnapshot().playback.editedTimeSec).toBe(15);
    expect(media.commands.at(-1)).toEqual({
      type: "seek",
      binding,
      mediaTimeSec: 19,
    });

    session.dispatch({
      type: "document.edit",
      action: { type: "deleteRange", range: { startSec: 12, endSec: 14 } },
    });
    expect(session.getSnapshot().playback.editedTimeSec).toBe(13);
    expect(media.commands.at(-1)).toEqual({
      type: "seek",
      binding,
      mediaTimeSec: 19,
    });

    session.dispatch({ type: "history.undo" });
    expect(session.getSnapshot().playback.editedTimeSec).toBe(15);
    expect(media.commands.at(-1)).toEqual({
      type: "seek",
      binding,
      mediaTimeSec: 19,
    });

    session.dispatch({ type: "history.redo" });
    expect(session.getSnapshot().playback.editedTimeSec).toBe(13);
    expect(media.commands.at(-1)).toEqual({
      type: "seek",
      binding,
      mediaTimeSec: 19,
    });
  });

  test("moves a deleted current frame to the next kept frame", async () => {
    const media = new InMemoryMediaAdapter();
    const session = makeSession(media);
    while (session.getSnapshot().status !== "ready") await Promise.resolve();
    const binding = session.getSnapshot().playback.mediaBinding;

    session.dispatch({ type: "playback.seek", editedTimeSec: 15 });
    session.dispatch({
      type: "document.edit",
      action: { type: "deleteRange", range: { startSec: 24, endSec: 27 } },
    });

    expect(session.getSnapshot().playback.editedTimeSec).toBe(14);
    expect(media.commands.at(-1)).toEqual({
      type: "seek",
      binding,
      mediaTimeSec: 21,
    });
  });

  test("moves a deleted current frame to the last kept frame when none follows", async () => {
    const media = new InMemoryMediaAdapter();
    const session = makeSession(media);
    while (session.getSnapshot().status !== "ready") await Promise.resolve();
    const binding = session.getSnapshot().playback.mediaBinding;

    session.dispatch({ type: "playback.seek", editedTimeSec: 25 });
    session.dispatch({ type: "playback.play" });
    const commandsBeforeCut = media.commands.length;
    session.dispatch({
      type: "document.edit",
      action: { type: "deleteRange", range: { startSec: 30, endSec: 40 } },
    });

    expect(session.getSnapshot().playback).toMatchObject({
      editedTimeSec: 20,
      state: "paused",
    });
    expect(media.commands.slice(commandsBeforeCut)).toEqual([
      { type: "pause", binding },
      { type: "seek", binding, mediaTimeSec: 23.999 },
    ]);
  });

  test("preserves play state and rate when proxy playback swaps to source", async () => {
    const media = new InMemoryMediaAdapter();
    const session = makeSession(media);
    while (session.getSnapshot().status !== "ready") await Promise.resolve();

    session.dispatch({ type: "playback.seek", editedTimeSec: 15 });
    session.dispatch({ type: "playback.set-rate", rate: 1.5 });
    session.dispatch({ type: "playback.play" });
    session.perform({
      type: "trim",
      startSec: 12,
      endSec: 38,
      transcriptSlice: [],
      segments: [],
    });

    expect(session.getSnapshot().preview.activeAsset.kind).toBe("source");
    expect(session.getSnapshot().playback).toMatchObject({
      editedTimeSec: 13,
      state: "playing",
      rate: 1.5,
    });
    expect(media.commands.at(-1)).toEqual({
      type: "load",
      binding: session.getSnapshot().playback.mediaBinding,
      url: "https://cdn.example.com/source.mp4",
      mediaTimeSec: 25,
      rate: 1.5,
      playing: true,
      muted: false,
      volume: 1,
    });

    session.dispatch({ type: "history.undo" });
    expect(session.getSnapshot().preview.activeAsset.kind).toBe("proxy");
    expect(media.commands.at(-1)).toEqual({
      type: "load",
      binding: session.getSnapshot().playback.mediaBinding,
      url: "https://cdn.example.com/proxy.mp4",
      mediaTimeSec: 19,
      rate: 1.5,
      playing: true,
      muted: false,
      volume: 1,
    });
  });

  test("continuous playback skips a deleted range exactly once", async () => {
    const media = new InMemoryMediaAdapter();
    const session = makeSession(media);
    while (session.getSnapshot().status !== "ready") await Promise.resolve();
    session.dispatch({
      type: "document.edit",
      action: { type: "deleteRange", range: { startSec: 20, endSec: 22 } },
    });
    session.dispatch({ type: "playback.play" });
    const binding = session.getSnapshot().playback.mediaBinding;
    const commandsBefore = media.commands.length;

    media.emit({ type: "time", binding, mediaTimeSec: 14.5 });
    media.emit({ type: "time", binding, mediaTimeSec: 14.5 });

    expect(session.getSnapshot().playback.editedTimeSec).toBe(10);
    expect(media.commands.slice(commandsBefore)).toEqual([
      { type: "seek", binding, mediaTimeSec: 16 },
    ]);
  });

  test("continuous playback pauses source media while an inserted scene owns the shared timeline", async () => {
    const media = new InMemoryMediaAdapter();
    const runtime = new ManualRuntime();
    const session = makeSession(media, "writer", runtime);
    while (session.getSnapshot().status !== "ready") await Promise.resolve();
    session.dispatch({
      type: "document.edit",
      action: {
        type: "insertSceneBlock",
        scene: {
          schemaVersion: 1,
          id: "31ddc1dd-838c-4fed-a940-4cbed7a3974b",
          anchorSec: 5,
          durationSec: 2,
          content: { kind: "color", color: "#112233" },
          motion: { entrance: "fade", exit: "fade", durationSec: 0.5 },
          templateSnapshot: null,
        },
      },
    });
    const binding = session.getSnapshot().playback.mediaBinding;
    session.dispatch({ type: "playback.play" });
    const beforeCrossing = media.commands.length;

    media.emit({ type: "time", binding, mediaTimeSec: 9.1 });

    expect(session.getSnapshot().playback).toMatchObject({
      editedTimeSec: 5,
      durationSec: 32,
      state: "playing",
    });
    expect(media.commands.slice(beforeCrossing)).toEqual([
      { type: "pause", binding },
      { type: "seek", binding, mediaTimeSec: 9 },
    ]);

    runtime.advance(1_000);
    expect(session.getSnapshot().playback.editedTimeSec).toBe(6);
    runtime.advance(1_000);
    expect(session.getSnapshot().playback.editedTimeSec).toBe(7);
    expect(media.commands.slice(-2)).toEqual([
      { type: "seek", binding, mediaTimeSec: 9 },
      { type: "play", binding },
    ]);
  });

  for (const eventOrder of [
    ["seeked", "time", "time"],
    ["time", "seeked", "time"],
    ["time", "time", "seeked"],
  ] as const) {
    test(`explicit inserted Scene seek survives ${eventOrder.join("/ ")} and plays its complete duration`, async () => {
      const media = new InMemoryMediaAdapter();
      const runtime = new ManualRuntime();
      const session = makeSession(media, "writer", runtime, insertedSceneDocument());
      while (session.getSnapshot().status !== "ready") await Promise.resolve();
      const binding = session.getSnapshot().playback.mediaBinding;
      const anchorSec = 4.414;
      const mediaAnchorSec = 8.414;
      session.dispatch({ type: "playback.seek", editedTimeSec: anchorSec });
      for (const type of eventOrder) {
        media.emit({ type, binding, mediaTimeSec: mediaAnchorSec });
        expect(session.getSnapshot().playback).toMatchObject({ editedTimeSec: anchorSec, state: "paused" });
      }
      const beforePlay = media.commands.length;
      session.dispatch({ type: "playback.play" });
      expect(media.commands.slice(beforePlay)).toEqual([
        { type: "pause", binding },
        { type: "seek", binding, mediaTimeSec: mediaAnchorSec },
      ]);
      // Valid old source events cannot replace the inserted Scene's clock.
      media.emit({ type: "seeked", binding, mediaTimeSec: mediaAnchorSec });
      media.emit({ type: "time", binding, mediaTimeSec: mediaAnchorSec + 0.03 });
      runtime.advance(1_000);
      expect(session.getSnapshot().playback.editedTimeSec).toBe(anchorSec + 1);
      runtime.advance(1_000);
      expect(session.getSnapshot().playback.editedTimeSec).toBe(anchorSec + 2);
      expect(media.commands.slice(beforePlay).some((command) => command.type === "play")).toBe(false);
      runtime.advance(1_000);
      expect(session.getSnapshot().playback.editedTimeSec).toBe(anchorSec + 3);
      expect(media.commands.slice(-2)).toEqual([
        { type: "seek", binding, mediaTimeSec: mediaAnchorSec },
        { type: "play", binding },
      ]);
      media.emit({ type: "seeked", binding, mediaTimeSec: mediaAnchorSec });
      media.emit({ type: "time", binding, mediaTimeSec: mediaAnchorSec + 0.03 });
      expect(session.getSnapshot().playback.editedTimeSec).toBeCloseTo(anchorSec + 3.03, 6);
      expect(session.getSnapshot().playback.state).toBe("playing");
    });
  }

  test("playing immediately after an inserted seek cannot rewind on the first post-Scene source acknowledgment", async () => {
    const media = new InMemoryMediaAdapter();
    const runtime = new ManualRuntime();
    const session = makeSession(media, "writer", runtime, insertedSceneDocument());
    while (session.getSnapshot().status !== "ready") await Promise.resolve();
    const binding = session.getSnapshot().playback.mediaBinding;
    session.dispatch({ type: "playback.seek", editedTimeSec: 4.414 });
    // No source event consumed the requested composite seek before Play.
    session.dispatch({ type: "playback.play" });
    runtime.advance(3_000);
    media.emit({ type: "seeked", binding, mediaTimeSec: 8.414 });
    expect(session.getSnapshot().playback.editedTimeSec).toBeCloseTo(7.414, 6);
  });

  test("paused inserted Scene interiors survive source samples and resume from their composite position", async () => {
    const media = new InMemoryMediaAdapter();
    const runtime = new ManualRuntime();
    const session = makeSession(media, "writer", runtime, insertedSceneDocument());
    while (session.getSnapshot().status !== "ready") await Promise.resolve();
    const binding = session.getSnapshot().playback.mediaBinding;
    session.dispatch({ type: "playback.seek", editedTimeSec: 4.414 });
    session.dispatch({ type: "playback.play" });
    runtime.advance(1_000);
    session.dispatch({ type: "playback.pause" });
    media.emit({ type: "seeked", binding, mediaTimeSec: 8.414 });
    media.emit({ type: "time", binding, mediaTimeSec: 8.444 });
    runtime.advance(5_000);
    expect(session.getSnapshot().playback).toMatchObject({ editedTimeSec: 5.414, state: "paused" });
    session.dispatch({ type: "playback.play" });
    runtime.advance(1_000);
    expect(session.getSnapshot().playback.editedTimeSec).toBe(6.414);
    runtime.advance(1_000);
    expect(session.getSnapshot().playback.editedTimeSec).toBe(7.414);
    expect(media.commands.at(-1)?.type).toBe("play");
  });

  test("seeking into an inserted Scene during source playback hands off to the composite clock", async () => {
    const media = new InMemoryMediaAdapter();
    const runtime = new ManualRuntime();
    const session = makeSession(media, "writer", runtime, insertedSceneDocument());
    while (session.getSnapshot().status !== "ready") await Promise.resolve();
    const binding = session.getSnapshot().playback.mediaBinding;
    session.dispatch({ type: "playback.play" });
    const beforeSeek = media.commands.length;
    session.dispatch({ type: "playback.seek", editedTimeSec: 5.414 });
    expect(media.commands.slice(beforeSeek)).toEqual([
      { type: "pause", binding },
      { type: "seek", binding, mediaTimeSec: 8.414 },
    ]);
    media.emit({ type: "seeked", binding, mediaTimeSec: 8.414 });
    media.emit({ type: "time", binding, mediaTimeSec: 8.444 });
    runtime.advance(1_000);
    expect(session.getSnapshot().playback.editedTimeSec).toBe(6.414);
    runtime.advance(1_000);
    expect(session.getSnapshot().playback).toMatchObject({ editedTimeSec: 7.414, state: "playing" });
    expect(media.commands.at(-1)?.type).toBe("play");
  });

  for (const paused of [false, true]) {
    test(`seeking from an inserted Scene into source ${paused ? "keeps playback paused" : "resumes source playback"}`, async () => {
      const media = new InMemoryMediaAdapter();
      const runtime = new ManualRuntime();
      const session = makeSession(media, "writer", runtime, insertedSceneDocument());
      while (session.getSnapshot().status !== "ready") await Promise.resolve();
      const binding = session.getSnapshot().playback.mediaBinding;
      session.dispatch({ type: "playback.play" });
      session.dispatch({ type: "playback.seek", editedTimeSec: 5.414 });
      runtime.advance(1_000);
      if (paused) session.dispatch({ type: "playback.pause" });
      const beforeSeek = media.commands.length;
      session.dispatch({ type: "playback.seek", editedTimeSec: 10 });
      expect(media.commands.slice(beforeSeek)).toEqual([
        { type: "seek", binding, mediaTimeSec: 11 },
        ...(paused ? [] : [{ type: "play" as const, binding }]),
      ]);
      media.emit({ type: "seeked", binding, mediaTimeSec: 11 });
      runtime.advance(5_000);
      expect(session.getSnapshot().playback).toMatchObject({ editedTimeSec: 10, state: paused ? "paused" : "playing" });
      if (!paused) {
        media.emit({ type: "time", binding, mediaTimeSec: 11.5 });
        expect(session.getSnapshot().playback.editedTimeSec).toBe(10.5);
      }
    });
  }

  for (const endEvent of ["time", "ended"] as const) {
    test(`source ${endEvent} hands playback to an inserted End Scene before parking`, async () => {
      const media = new InMemoryMediaAdapter();
      const runtime = new ManualRuntime();
      const document = insertedSceneDocument();
      document.sceneBlocks[0]!.anchorSec = 30;
      const session = makeSession(media, "writer", runtime, document);
      while (session.getSnapshot().status !== "ready") await Promise.resolve();
      const binding = session.getSnapshot().playback.mediaBinding;
      session.dispatch({ type: "playback.play" });
      media.emit({ type: "time", binding, mediaTimeSec: 33 });
      const beforeEnd = media.commands.length;
      media.emit(endEvent === "time"
        ? { type: "time", binding, mediaTimeSec: 34 }
        : { type: "ended", binding });
      expect(session.getSnapshot().playback).toMatchObject({ editedTimeSec: 30, state: "playing", durationSec: 33 });
      expect(media.commands.slice(beforeEnd).map((command) => command.type)).toEqual(["pause", "seek"]);
      // A late source end event must not end the independent Scene clock.
      media.emit({ type: "ended", binding });
      runtime.advance(2_000);
      expect(session.getSnapshot().playback).toMatchObject({ editedTimeSec: 32, state: "playing" });
      runtime.advance(1_000);
      expect(session.getSnapshot().playback).toMatchObject({ editedTimeSec: 33, state: "paused" });
      expect(media.commands.slice(beforeEnd).some((command) => command.type === "play")).toBe(false);
    });
  }

  test("an End Scene after a tail cut holds the last kept source frame", async () => {
    const media = new InMemoryMediaAdapter();
    const runtime = new ManualRuntime();
    const document = makeDocument([{ startSec: 30, endSec: 40 }]);
    document.sceneBlocks = [{ ...insertedSceneDocument().sceneBlocks[0]!, anchorSec: 20 }];
    const session = makeSession(media, "writer", runtime, document);
    while (session.getSnapshot().status !== "ready") await Promise.resolve();
    const binding = session.getSnapshot().playback.mediaBinding;
    session.dispatch({ type: "playback.play" });
    media.emit({ type: "time", binding, mediaTimeSec: 23 });
    media.emit({ type: "time", binding, mediaTimeSec: 24 });
    expect(session.getSnapshot().playback).toMatchObject({ editedTimeSec: 20, state: "playing" });
    expect(media.commands.at(-1)).toEqual({ type: "seek", binding, mediaTimeSec: 23.999 });
    runtime.advance(3_000);
    expect(session.getSnapshot().playback).toMatchObject({ editedTimeSec: 23, state: "paused" });
    expect(media.commands.at(-1)).toEqual({ type: "seek", binding, mediaTimeSec: 23.999 });
  });

  test("parks on the last kept frame when playback reaches a tail cut", async () => {
    const media = new InMemoryMediaAdapter();
    const session = makeSession(media);
    while (session.getSnapshot().status !== "ready") await Promise.resolve();
    session.dispatch({
      type: "document.edit",
      action: { type: "deleteRange", range: { startSec: 30, endSec: 40 } },
    });
    session.dispatch({ type: "playback.play" });
    const binding = session.getSnapshot().playback.mediaBinding;
    const commandsBefore = media.commands.length;

    media.emit({ type: "time", binding, mediaTimeSec: 24 });

    expect(session.getSnapshot().playback).toMatchObject({
      editedTimeSec: 20,
      state: "paused",
    });
    expect(media.commands.slice(commandsBefore)).toEqual([
      { type: "pause", binding },
      { type: "seek", binding, mediaTimeSec: 23.999 },
    ]);
  });

  test("seeking to the edited end parks inside the last kept frame", async () => {
    const media = new InMemoryMediaAdapter();
    const session = makeSession(media);
    while (session.getSnapshot().status !== "ready") await Promise.resolve();
    session.dispatch({
      type: "document.edit",
      action: { type: "deleteRange", range: { startSec: 30, endSec: 40 } },
    });
    const binding = session.getSnapshot().playback.mediaBinding;
    const commandsBefore = media.commands.length;

    session.dispatch({ type: "playback.seek", editedTimeSec: 20 });

    expect(session.getSnapshot().playback.editedTimeSec).toBe(20);
    expect(media.commands.slice(commandsBefore)).toEqual([
      { type: "seek", binding, mediaTimeSec: 23.999 },
    ]);
  });

  test("ignores late media events from a prior source binding", async () => {
    const media = new InMemoryMediaAdapter();
    const session = makeSession(media);
    while (session.getSnapshot().status !== "ready") await Promise.resolve();
    const staleBinding = session.getSnapshot().playback.mediaBinding;
    session.dispatch({ type: "playback.seek", editedTimeSec: 15 });
    session.dispatch({ type: "playback.play" });
    await session.perform({
      type: "trim",
      startSec: 12,
      endSec: 38,
      transcriptSlice: [],
      segments: [],
    });
    const beforeLateEvent = session.getSnapshot();
    const commandsBefore = media.commands.length;

    media.emit({ type: "paused", binding: staleBinding });
    media.emit({ type: "time", binding: staleBinding, mediaTimeSec: 30 });

    expect(session.getSnapshot()).toBe(beforeLateEvent);
    expect(media.commands).toHaveLength(commandsBefore);
  });

  test("lets a read-only session play and seek", async () => {
    const media = new InMemoryMediaAdapter();
    const session = makeSession(media, "reader");
    while (session.getSnapshot().status !== "ready") await Promise.resolve();

    expect(session.getSnapshot().capabilities.mutate).toBe(false);
    expect(
      session.dispatch({ type: "playback.seek", editedTimeSec: 5 }),
    ).toEqual({ accepted: true });
    expect(session.dispatch({ type: "playback.play" })).toEqual({
      accepted: true,
    });
    expect(session.getSnapshot().playback).toMatchObject({
      editedTimeSec: 5,
      state: "playing",
    });
  });

  test("ignores media events after the session generation closes", async () => {
    const media = new InMemoryMediaAdapter();
    const session = makeSession(media);
    while (session.getSnapshot().status !== "ready") await Promise.resolve();
    const staleBinding = session.getSnapshot().playback.mediaBinding;

    await session.perform({ type: "close", reason: "navigation" });
    const closed = session.getSnapshot();
    media.emit({ type: "played", binding: staleBinding });
    media.emit({ type: "time", binding: staleBinding, mediaTimeSec: 20 });

    expect(session.getSnapshot()).toBe(closed);
    expect(closed.playback.state).toBe("paused");
  });
});

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CAPTION_PRESET,
  editorDocumentSchema,
  studioEditsSchema,
} from "@narriflow/validators";
import { createStudioEditingSession } from "./studio-editing-session";
import {
  createStudioSessionSelectorStore,
  selectStudioCanRedo,
  selectStudioCanUndo,
  selectStudioDocument,
  selectStudioPlaybackPresentation,
  selectStudioPreview,
  studioPlaybackPresentationEqual,
  studioPreviewPresentationEqual,
} from "./studio-editing-session-react";

function makeSession(withSourcePreview = false) {
  return createStudioEditingSession({
    document: editorDocumentSchema.parse({
    version: 2,
      clipStartSec: 10,
      clipEndSec: 40,
      captionPreset: DEFAULT_CAPTION_PRESET,
      transcriptSlice: [],
      studioEdits: studioEditsSchema.parse(undefined),
      brollUrl: null,
      deletedRanges: [],
    }),
    segments: [{ id: "segment", label: "Clip", startSec: 0, endSec: 30 }],
    ...(withSourcePreview
      ? {
          preview: {
            sourceUrl: "https://cdn.example.com/source.mp4",
            sourcePurged: false,
            proxy: null,
            automaticLayout: null,
          },
        }
      : {}),
  });
}

describe("Studio Editing Session React selector adapter", () => {
  test("does not publish a document projection for playhead-only changes", () => {
    const session = makeSession();
    const store = createStudioSessionSelectorStore(
      session,
      selectStudioDocument,
    );
    const initial = store.getSnapshot();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });

    session.dispatch({ type: "playback.seek", editedTimeSec: 12 });

    expect(store.getSnapshot()).toBe(initial);
    expect(notifications).toBe(0);

    session.dispatch({
      type: "document.edit",
      action: { type: "setBrollUrl", brollUrl: "https://cdn.example.com/a.mp4" },
    });

    expect(store.getSnapshot()).not.toBe(initial);
    expect(store.getSnapshot().brollUrl).toBe(
      "https://cdn.example.com/a.mp4",
    );
    expect(notifications).toBe(1);
    unsubscribe();
  });

  test("keeps the shell playback projection stable while the playhead advances", () => {
    const session = makeSession();
    const store = createStudioSessionSelectorStore(
      session,
      selectStudioPlaybackPresentation,
      studioPlaybackPresentationEqual,
    );
    const initial = store.getSnapshot();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });

    session.dispatch({ type: "playback.seek", editedTimeSec: 12 });

    expect(store.getSnapshot()).toBe(initial);
    expect(notifications).toBe(0);

    session.dispatch({ type: "playback.set-rate", rate: 1.5 });

    expect(store.getSnapshot()).toEqual({
      durationSec: 30,
      state: "paused",
      rate: 1.5,
    });
    expect(notifications).toBe(1);
    unsubscribe();
  });

  test("does not publish history capabilities for playhead-only changes", () => {
    const session = makeSession();
    const undoStore = createStudioSessionSelectorStore(
      session,
      selectStudioCanUndo,
    );
    const redoStore = createStudioSessionSelectorStore(
      session,
      selectStudioCanRedo,
    );
    let notifications = 0;
    const unsubscribeUndo = undoStore.subscribe(() => {
      notifications += 1;
    });
    const unsubscribeRedo = redoStore.subscribe(() => {
      notifications += 1;
    });

    session.dispatch({ type: "playback.seek", editedTimeSec: 12 });

    expect(notifications).toBe(0);
    expect(undoStore.getSnapshot()).toBe(false);
    expect(redoStore.getSnapshot()).toBe(false);

    session.dispatch({
      type: "document.edit",
      action: { type: "setBrollUrl", brollUrl: "https://cdn.example.com/a.mp4" },
    });

    expect(notifications).toBe(1);
    expect(undoStore.getSnapshot()).toBe(true);
    unsubscribeUndo();
    unsubscribeRedo();
  });

  test("does not publish preview presentation for playhead-only changes", () => {
    const session = makeSession(true);
    const store = createStudioSessionSelectorStore(
      session,
      selectStudioPreview,
      studioPreviewPresentationEqual,
    );
    const initial = store.getSnapshot();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });

    session.dispatch({ type: "playback.seek", editedTimeSec: 12 });

    expect(store.getSnapshot()).toBe(initial);
    expect(notifications).toBe(0);

    session.dispatch({ type: "preview.set-source-fallback", enabled: true });

    expect(store.getSnapshot().activeAsset.kind).toBe("source");
    expect(notifications).toBe(1);
    unsubscribe();
  });
});

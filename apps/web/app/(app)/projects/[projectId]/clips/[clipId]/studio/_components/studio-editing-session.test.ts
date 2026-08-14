import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CAPTION_PRESET,
  editorDocumentSchema,
  studioEditsSchema,
  type EditorDocument,
} from "@narriflow/validators";
import { createStudioEditingSession } from "./studio-editing-session";
import type { TimelineSegment } from "./studio-types";

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

const initialSegments: TimelineSegment[] = [
  { id: "segment", label: "Clip", startSec: 0, endSec: 30 },
];

function makeSession() {
  const document = makeDocument();
  return createStudioEditingSession({
    document,
    segments: initialSegments,
  });
}

describe("StudioEditingSession document and history seam", () => {
  test("publishes an accepted document edit synchronously", () => {
    const session = makeSession();
    let notifications = 0;
    session.subscribe(() => {
      notifications += 1;
    });

    const receipt = session.dispatch({
      type: "document.edit",
      action: { type: "setBrollUrl", brollUrl: "https://cdn.example.com/a.mp4" },
    });

    expect(receipt).toEqual({ accepted: true });
    expect(session.getSnapshot().document.brollUrl).toBe(
      "https://cdn.example.com/a.mp4",
    );
    expect(session.getSnapshot().history.canUndo).toBe(true);
    expect(notifications).toBe(1);
  });

  test("keeps the public snapshot stable for a no-op edit", () => {
    const session = makeSession();
    const before = session.getSnapshot();
    let notifications = 0;
    session.subscribe(() => {
      notifications += 1;
    });

    expect(
      session.dispatch({
        type: "document.edit",
        action: { type: "setBrollUrl", brollUrl: null },
      }),
    ).toEqual({ accepted: true });

    expect(session.getSnapshot()).toBe(before);
    expect(notifications).toBe(0);
  });

  test("owns its input values and exposes an immutable snapshot", () => {
    const document = makeDocument();
    const segments: TimelineSegment[] = [
      { id: "segment", label: "Clip", startSec: 0, endSec: 30 },
    ];
    const session = createStudioEditingSession({ document, segments });

    document.brollUrl = "https://cdn.example.com/outside.mp4";
    segments[0]!.label = "Changed outside";

    expect(session.getSnapshot().document.brollUrl).toBeNull();
    expect(session.getSnapshot().segments[0]?.label).toBe("Clip");

    const exposed = session.getSnapshot() as unknown as {
      document: EditorDocument;
      segments: TimelineSegment[];
    };
    expect(() => {
      exposed.document.brollUrl = "https://cdn.example.com/mutated.mp4";
    }).toThrow();
    expect(() => {
      exposed.segments[0]!.label = "Mutated snapshot";
    }).toThrow();
  });

  test("interleaves document and segment history through one interface", () => {
    const session = makeSession();
    const split: TimelineSegment[] = [
      { id: "a", label: "A", startSec: 0, endSec: 15 },
      { id: "b", label: "B", startSec: 15, endSec: 30 },
    ];
    session.dispatch({
      type: "document.edit",
      action: { type: "setBrollUrl", brollUrl: "https://cdn.example.com/a.mp4" },
    });
    session.dispatch({ type: "segments.replace", segments: split });

    session.dispatch({ type: "history.undo" });
    expect(session.getSnapshot().segments).toEqual(initialSegments);
    expect(session.getSnapshot().document.brollUrl).toBe(
      "https://cdn.example.com/a.mp4",
    );

    session.dispatch({ type: "history.undo" });
    expect(session.getSnapshot().document.brollUrl).toBeNull();

    session.dispatch({ type: "history.redo" });
    expect(session.getSnapshot().document.brollUrl).toBe(
      "https://cdn.example.com/a.mp4",
    );
    session.dispatch({ type: "history.redo" });
    expect(session.getSnapshot().segments).toEqual(split);
  });

  test("gesture completion prevents later edits from coalescing", () => {
    const session = makeSession();
    session.dispatch({
      type: "document.edit",
      action: {
        type: "setCaptionPreset",
        captionPreset: { ...session.getSnapshot().document.captionPreset, fontSize: 40 },
      },
      coalesceKey: "caption.fontSize",
    });
    session.dispatch({ type: "gesture.end" });
    session.dispatch({
      type: "document.edit",
      action: {
        type: "setCaptionPreset",
        captionPreset: { ...session.getSnapshot().document.captionPreset, fontSize: 42 },
      },
      coalesceKey: "caption.fontSize",
    });

    session.dispatch({ type: "history.undo" });
    expect(session.getSnapshot().document.captionPreset.fontSize).toBe(40);
    session.dispatch({ type: "history.undo" });
    expect(session.getSnapshot().document.captionPreset.fontSize).toBe(36);
  });

  test("coalesces continuous edits with the same gesture key", () => {
    const session = makeSession();
    session.dispatch({
      type: "document.edit",
      action: {
        type: "setCaptionPreset",
        captionPreset: { ...session.getSnapshot().document.captionPreset, fontSize: 38 },
      },
      coalesceKey: "caption.fontSize",
    });
    session.dispatch({
      type: "document.edit",
      action: {
        type: "setCaptionPreset",
        captionPreset: { ...session.getSnapshot().document.captionPreset, fontSize: 40 },
      },
      coalesceKey: "caption.fontSize",
    });

    session.dispatch({ type: "history.undo" });
    expect(session.getSnapshot().document.captionPreset.fontSize).toBe(36);
    expect(session.getSnapshot().history.canUndo).toBe(false);
  });

  test("stops notifying a subscriber after it unsubscribes", () => {
    const session = makeSession();
    let notifications = 0;
    const unsubscribe = session.subscribe(() => {
      notifications += 1;
    });

    session.dispatch({
      type: "document.edit",
      action: { type: "setBrollUrl", brollUrl: "https://cdn.example.com/a.mp4" },
    });
    unsubscribe();
    session.dispatch({ type: "history.undo" });

    expect(notifications).toBe(1);
  });
});

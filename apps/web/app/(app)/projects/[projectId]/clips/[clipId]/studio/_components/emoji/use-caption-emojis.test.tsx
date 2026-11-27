import { beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  applyWithHistory,
  buildEditedTimeMap,
  captionWordKey,
  createEditorHistory,
  undoEditor,
  type EditorAction,
  type EditorDocument,
  type EditorHistory,
} from "@narriflow/validators";
import { emojiFixtureDocument } from "./caption-emoji-fixture";
import { captionEmojiSession, registerCaptionEmojiSource, resetCaptionEmojiSessions } from "./caption-emoji-runs";
import { captionEmojiTarget, captionEmojiWords } from "./caption-emoji-words";
import { preloadCaptionEmojiArt } from "./use-caption-emoji-art";
import { useCaptionEmojiEditor, type CaptionEmojiEditor, type CaptionEmojiSource } from "./use-caption-emojis";

const modelOf = (document: EditorDocument) =>
  captionEmojiWords(document, buildEditedTimeMap(document.deletedRanges, { startSec: document.clipStartSec, endSec: document.clipEndSec }));

/** The editor over a real history: every source write goes through the document reducer. */
function harness(document: EditorDocument, suggest: CaptionEmojiSource["suggest"] = async () => ({ emojis: {} }), readOnly = false) {
  let history: EditorHistory = createEditorHistory(document);
  const dispatched: EditorAction[] = [];
  const apply = (action: EditorAction) => {
    dispatched.push(action);
    history = applyWithHistory(history, action);
  };
  const source = (): CaptionEmojiSource => ({
    clipId: "clip-1",
    preset: history.present.captionPreset,
    entries: history.present.studioEdits.captionEmojis,
    model: modelOf(history.present),
    readOnly,
    updatePreset: (patch) => apply({ type: "setCaptionPreset", captionPreset: { ...history.present.captionPreset, ...patch } }),
    setEmojis: (entries) => apply({ type: "setCaptionEmojis", entries }),
    replaceEmojis: (value) => {
      apply({ type: "replaceCaptionEmojis", value });
      return history.present.studioEdits.captionEmojis;
    },
    save: async () => true,
    suggest,
    failureCode: (error) => (error as { code?: string }).code ?? null,
  });
  // Server rendering runs no effects: register the live source as the mounted hook would.
  registerCaptionEmojiSource("clip-1", () => {
    const current = source();
    return { entries: current.entries, model: current.model, readOnly: current.readOnly, replace: current.replaceEmojis };
  });
  let editor: CaptionEmojiEditor | null = null;
  const render = () => {
    function Probe() {
      editor = useCaptionEmojiEditor(source());
      return null;
    }
    renderToStaticMarkup(<Probe />);
    return editor!;
  };
  return { render, dispatched, history: () => history, undo: () => (history = undoEditor(history)) };
}

beforeEach(() => resetCaptionEmojiSessions());

describe("emoji editor wiring", () => {
  test("a hand edit is one setCaptionEmojis action on the entry's own key, undone in one step", () => {
    const document = emojiFixtureDocument({ presetId: "bold-pop" });
    const h = harness(document);
    const editor = h.render();
    const word = editor.model.words.findIndex((entry) => entry.text === "made");
    editor.place(captionEmojiTarget(editor.model, editor.placement, word), { id: "flame" });
    // The entry stores its word's text, so a later rewrite of that word cannot move it onto another.
    expect(h.dispatched).toEqual([{ type: "setCaptionEmojis", entries: { [editor.model.words[word]!.key]: { id: "flame", word: "made" } } }]);
    expect(h.history().present.studioEdits.captionEmojis?.[editor.model.words[word]!.key]).toEqual({ id: "flame", word: "made" });
    h.undo();
    expect(h.history().present).toBe(document);
  });

  test("removing an emoji clears its stored entry", () => {
    const document = emojiFixtureDocument({ presetId: "bold-pop" });
    const h = harness(document);
    const editor = h.render();
    const [word, placed] = [...editor.placement.byWord][0]!;
    editor.place(captionEmojiTarget(editor.model, editor.placement, word), null);
    expect(h.dispatched).toEqual([{ type: "setCaptionEmojis", entries: { [placed.entryKey]: null } }]);
  });

  test("Remove all is one replaceCaptionEmojis action, undone in one step", () => {
    const document = emojiFixtureDocument({ presetId: "bold-pop" });
    const h = harness(document);
    h.render().removeAll();
    expect(h.dispatched).toEqual([{ type: "replaceCaptionEmojis", value: {} }]);
    expect(h.history().present.studioEdits.captionEmojis).toBeUndefined();
    h.undo();
    expect(h.history().present).toBe(document);
  });

  test("an AI run replaces every emoji in one undo step", async () => {
    const document = emojiFixtureDocument({ presetId: "bold-pop" });
    const key = captionWordKey(document.transcriptSlice[1]!.words[3]!.startSec);
    const h = harness({ ...document, studioEdits: { ...document.studioEdits, captionEmojis: undefined } }, async () => ({ emojis: { [key]: { id: "money-bag" } } }));
    const before = h.history().present;
    // The run commits once the answer's art is loaded; warm, it commits on the next turn.
    await preloadCaptionEmojiArt(["money-bag"]);
    h.render().generate("light");
    await Bun.sleep(0);
    expect(h.dispatched).toEqual([{ type: "replaceCaptionEmojis", value: { [key]: { id: "money-bag" } } }]);
    expect(captionEmojiSession("clip-1")).toEqual({ density: "light", run: { status: "done", added: 1, leftOut: 0, partial: false } });
    h.undo();
    expect(h.history().present).toBe(before);
  });

  test("moving an emoji to another word of its line is one undo step", () => {
    const document = emojiFixtureDocument({ presetId: "bold-pop" });
    const h = harness(document);
    const editor = h.render();
    const [word, placed] = [...editor.placement.byWord][0]!;
    const to = word + 1;
    editor.move(captionEmojiTarget(editor.model, editor.placement, word), to);
    expect(h.dispatched).toEqual([{ type: "setCaptionEmojis", entries: { [placed.entryKey]: null, [editor.model.words[to]!.key]: { ...placed.ref, word: editor.model.words[to]!.text } } }]);
    h.undo();
    expect(h.history().present).toBe(document);
  });

  test("a read-only tab writes nothing", () => {
    const h = harness(emojiFixtureDocument({ presetId: "bold-pop" }), undefined, true);
    const editor = h.render();
    editor.place(captionEmojiTarget(editor.model, editor.placement, 0), { id: "flame" });
    editor.removeAll();
    editor.generate("balanced");
    expect(h.dispatched).toEqual([]);
  });

  test("Regenerate confirms unless the emojis are exactly what this session's AI run committed", async () => {
    const document = emojiFixtureDocument({ presetId: "bold-pop" });
    const key = captionWordKey(document.transcriptSlice[1]!.words[3]!.startSec);
    // Loaded with emojis (provenance unknown after a reload): confirm.
    const h = harness(document, async () => ({ emojis: { [key]: { id: "money-bag" } } }));
    let editor = h.render();
    expect(editor.confirmRegenerate).toBe(true);
    await preloadCaptionEmojiArt(["money-bag"]);
    editor.generate("balanced");
    await Bun.sleep(0);
    editor = h.render();
    expect(editor.confirmRegenerate).toBe(false);
    editor.place(captionEmojiTarget(editor.model, editor.placement, 0), { id: "flame" });
    expect(h.render().confirmRegenerate).toBe(true);
    h.undo();
    expect(h.render().confirmRegenerate).toBe(false);
  });
});

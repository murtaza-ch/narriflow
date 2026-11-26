import { afterEach, describe, expect, test } from "bun:test";
import { ChakraProvider } from "@chakra-ui/react";
import { system } from "@narriflow/ui/theme";
import { renderToStaticMarkup } from "react-dom/server";
import { buildEditedTimeMap, captionWordKey, type CaptionEmojiRef, type EditorDocument } from "@narriflow/validators";
import { emojiFixtureDocument } from "./caption-emoji-fixture";
import { createCaptionEmojiLines, type CaptionEmojiLines } from "./caption-emoji-lines";
import { captionEmojiTarget, captionEmojiWords } from "./caption-emoji-words";
import { LineEmojiChips, openLineEmojiChip } from "./emoji-chips";
import { closeEmojiPicker, emojiPickerRequest } from "./emoji-picker-host";
import { useCaptionEmojiEditor, type CaptionEmojiEditor } from "./use-caption-emojis";

const noop = () => undefined;

/** The line chips' store over a document, as the transcript panel publishes it. */
function linesFor(document: EditorDocument, options: { seek?: (sec: number) => void; setEmojis?: (entries: Record<string, CaptionEmojiRef | null>) => void } = {}) {
  const model = captionEmojiWords(document, buildEditedTimeMap(document.deletedRanges, { startSec: document.clipStartSec, endSec: document.clipEndSec }));
  const store = createCaptionEmojiLines();
  let editor: CaptionEmojiEditor | null = null;
  function Probe() {
    editor = useCaptionEmojiEditor({
      clipId: "clip-line-chips",
      preset: document.captionPreset,
      entries: document.studioEdits.captionEmojis,
      model,
      readOnly: false,
      updatePreset: noop,
      setEmojis: options.setEmojis ?? noop,
      replaceEmojis: () => undefined,
      save: async () => true,
      suggest: async () => ({ emojis: {} }),
      failureCode: () => null,
    });
    return null;
  }
  renderToStaticMarkup(<Probe />);
  store.set({ editor: editor!, addContext: () => ({ playheadSec: Number.NaN, heroKeys: new Set() }), seek: options.seek ?? null, typedEmojiCues: [] });
  return { store, editor: editor! };
}

function renderLine(store: CaptionEmojiLines, line: number) {
  return renderToStaticMarkup(
    <ChakraProvider value={system}>
      <LineEmojiChips store={store} lines={[line]} direction="ltr" />
    </ChakraProvider>,
  );
}

/** The fixture clip with emojis on and line 1's emojis removed. */
function document(options: { emojis: boolean }): EditorDocument {
  const base = emojiFixtureDocument({ presetId: "bold-pop" });
  const lineOneKeys = new Set(base.transcriptSlice[1]!.words.map((word) => captionWordKey(word.startSec)));
  const captionEmojis = Object.fromEntries(Object.entries(base.studioEdits.captionEmojis ?? {}).filter(([key]) => !lineOneKeys.has(key)));
  return { ...base, captionPreset: { ...base.captionPreset, emojis: options.emojis }, studioEdits: { ...base.studioEdits, captionEmojis } };
}

const addButton = (markup: string) => markup.match(/<button[^>]*aria-label="Add emoji to this line"[^>]*>/)?.[0] ?? null;

afterEach(() => closeEmojiPicker(false));

describe("line Add emoji", () => {
  test("emojis on, line without an emoji: the add button is always shown, not a hover action", () => {
    const markup = renderLine(linesFor(document({ emojis: true })).store, 1);
    const button = addButton(markup);
    expect(button).not.toBeNull();
    expect(button).not.toContain("data-line-actions");
    expect(button).toContain('title="Add emoji"');
    expect(markup).not.toContain('aria-label="Emojis on this line"');
  });

  test("emojis on, line with an emoji: its chips, and add stays a hover action", () => {
    const markup = renderLine(linesFor(document({ emojis: true })).store, 0);
    expect(markup).toContain('aria-label="Emojis on this line"');
    expect(addButton(markup)).toContain("data-line-actions");
  });

  test("emojis off: no chips, add is a hover action", () => {
    const markup = renderLine(linesFor(document({ emojis: false })).store, 1);
    expect(markup).not.toContain('aria-label="Emojis on this line"');
    expect(addButton(markup)).toContain("data-line-actions");
  });
});

describe("line chips", () => {
  test("a stored emoji that does not draw is dimmed and says why", () => {
    const base = document({ emojis: true });
    const idea = base.transcriptSlice[0]!.words[2]!;
    const markup = renderLine(linesFor({ ...base, deletedRanges: [{ startSec: idea.startSec - 0.01, endSec: idea.endSec + 0.01 }] }).store, 0);
    expect(markup).toContain("Not shown: this word is cut");
    expect(markup).toMatch(/title="Not shown: this word is cut"/);
    expect(renderLine(linesFor(base).store, 0)).not.toContain("Not shown");
  });

  test("pressing a chip moves the playhead to its word and opens the picker with its line's words", () => {
    const base = document({ emojis: true });
    const seeks: number[] = [];
    const moves: Record<string, CaptionEmojiRef | null>[] = [];
    const { store, editor } = linesFor(base, { seek: (sec) => seeks.push(sec), setEmojis: (entries) => moves.push(entries) });
    const [word, placed] = [...editor.placement.byWord][0]!;
    const target = captionEmojiTarget(editor.model, editor.placement, word);
    openLineEmojiChip({} as HTMLElement, store, target, "ltr");
    expect(seeks).toEqual([editor.model.words[word]!.editedStartSec!]);
    const request = emojiPickerRequest()!;
    expect(request.label).toBe(`Emoji on “${target.text}”`);
    const choices = request.move!.words;
    expect(choices.find((choice) => choice.current)?.word).toBe(word);
    const other = choices.find((choice) => !choice.current)!;
    request.move!.onMove(other.word);
    // The moved entry stores the text of the word it now sits on.
    expect(moves).toEqual([{ [placed.entryKey]: null, [editor.model.words[other.word]!.key]: { ...placed.ref, word: editor.model.words[other.word]!.text } }]);
  });
});

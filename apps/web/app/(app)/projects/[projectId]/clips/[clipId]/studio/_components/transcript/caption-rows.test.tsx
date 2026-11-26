import { describe, expect, test } from "bun:test";
import { ChakraProvider } from "@chakra-ui/react";
import { system } from "@narriflow/ui/theme";
import { renderToStaticMarkup } from "react-dom/server";
import { buildEditedTimeMap, type EditorDocument } from "@narriflow/validators";
import { createCaptionEmojiLines } from "../emoji/caption-emoji-lines";
import { captionEmojiWords } from "../emoji/caption-emoji-words";
import { RowEmojiButtons } from "../emoji/row-emoji-buttons";
import { useCaptionEmojiEditor, type CaptionEmojiEditor } from "../emoji/use-caption-emojis";
import { CaptionRow, type CaptionRowActions, type RowEmojiSlot } from "./caption-rows";
import { transcriptFixtureDocument, type TranscriptFixtureOptions } from "./transcript-fixture";
import { captionRows } from "./transcript-rows";

const noop = () => undefined;
const actions: CaptionRowActions = { seek: noop, edit: noop, addAfter: noop, remove: noop };

/** The emoji store the panel publishes, over a fixture document. */
function emojiSlot(document: EditorDocument, readOnly: boolean): RowEmojiSlot {
  const model = captionEmojiWords(document, buildEditedTimeMap(document.deletedRanges, { startSec: document.clipStartSec, endSec: document.clipEndSec }));
  const store = createCaptionEmojiLines();
  let editor: CaptionEmojiEditor | null = null;
  function Probe() {
    editor = useCaptionEmojiEditor({
      clipId: "clip-caption-rows",
      preset: document.captionPreset,
      entries: document.studioEdits.captionEmojis,
      model,
      readOnly,
      updatePreset: noop,
      setEmojis: noop,
      replaceEmojis: () => undefined,
      save: async () => true,
      suggest: async () => ({ emojis: {} }),
      failureCode: () => null,
    });
    return null;
  }
  renderToStaticMarkup(<Probe />);
  store.set({ editor: editor!, addContext: () => ({ playheadSec: Number.NaN, heroKeys: new Set() }), seek: null, typedEmojiCues: [] });
  return (row, direction) => <RowEmojiButtons store={store} spans={row.spans} direction={direction} />;
}

/** The markup of the first caption row whose text includes `holding`, without Emotion's style tags. */
function render(options: TranscriptFixtureOptions & { holding: string; readOnly?: boolean; active?: boolean; last?: boolean }) {
  const document = transcriptFixtureDocument({ seconds: 70, ...options });
  const language = options.rtl ? "ur" : "en";
  const rows = captionRows(document, language);
  const row = options.last ? rows.at(-1)! : rows.find((candidate) => candidate.text.includes(options.holding))!;
  return renderToStaticMarkup(
    <ChakraProvider value={system}>
      <CaptionRow
        row={row}
        active={options.active ?? false}
        readOnly={options.readOnly ?? false}
        language={language}
        query=""
        actions={actions}
        emoji={emojiSlot(document, options.readOnly ?? false)}
      />
    </ChakraProvider>,
  ).replace(/<style[^>]*>.*?<\/style>/gs, "");
}

const tag = (markup: string, label: string) => markup.match(new RegExp(`<[a-z]+[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? null;
const emojiButtons = (markup: string) => markup.match(/<button[^>]*aria-label="[^"]* emoji on “[^”]*”, change"/g) ?? [];

describe("a caption row", () => {
  test("its time range on top, as on the video, then its text", () => {
    const markup = render({ holding: "Of course." });
    expect(markup).toContain("00:00.20 – 00:00.88");
    expect(markup.indexOf("00:00.20")).toBeLessThan(markup.indexOf('aria-label="Caption at 00:00.20"'));
    expect(markup).toMatch(/<textarea[^>]*aria-label="Caption at 00:00\.20"[^>]*>Of course\.<\/textarea>/);
    expect(tag(markup, "Add caption after")).not.toBeNull();
    expect(tag(markup, "Merge with next")).not.toContain("aria-disabled");
    expect(tag(markup, "Delete caption")).not.toBeNull();
    expect(markup).not.toContain("Speaker");
    expect(markup).not.toContain("aria-current");
  });

  test("no emoji, emojis on: the add button is always shown at the right edge", () => {
    const button = tag(render({ holding: "Of course." }), "Add emoji to this caption");
    expect(button).not.toBeNull();
    expect(button).not.toContain("data-row-actions");
  });

  test("one emoji: its art in the button, and a remove control beside it", () => {
    const markup = render({ holding: "springboard." });
    expect(emojiButtons(markup)).toHaveLength(1);
    expect(markup).toMatch(/aria-label="Remove [^"]+ emoji from “springboard\.”"/);
    expect(tag(markup, "Add emoji to this caption")).toBeNull();
  });

  test("two emojis on one caption: two buttons", () => {
    const markup = render({ holding: "huge party", emojis: "two" });
    expect(emojiButtons(markup)).toHaveLength(2);
    expect(markup.match(/data-emoji-remove/g)).toHaveLength(2);
  });

  test("emojis off: the add icon is a hover action and stored emojis do not show", () => {
    const markup = render({ holding: "springboard.", emojisOn: false });
    expect(emojiButtons(markup)).toHaveLength(0);
    expect(tag(markup, "Add emoji to this caption")).toContain("data-row-actions");
  });

  test("read-only: the text cannot change, no actions, emojis show without controls", () => {
    const markup = render({ holding: "springboard.", readOnly: true });
    expect(markup).toMatch(/<textarea[^>]*readOnly=""/i);
    expect(tag(markup, "Add caption after")).toBeNull();
    expect(tag(markup, "Delete caption")).toBeNull();
    expect(tag(markup, "Merge with next")).toBeNull();
    expect(markup).not.toContain("data-emoji-remove");
    expect(markup).toMatch(/<span[^>]*aria-label="[^"]+ emoji on “springboard\.”"/);
  });

  test("the last caption cannot merge with a next one", () => {
    expect(tag(render({ holding: "", last: true }), "Merge with next")).toContain('aria-disabled="true"');
  });

  test("active: marked as the current caption", () => {
    expect(render({ holding: "Of course.", active: true })).toContain('aria-current="true"');
  });

  test("right-to-left: the text runs right to left in Urdu; times and the emoji button keep their places", () => {
    const markup = render({ holding: "خیال", rtl: true });
    expect(markup).toMatch(/<textarea[^>]*lang="ur"[^>]*dir="rtl"|<textarea[^>]*dir="rtl"[^>]*lang="ur"/);
    // The row keeps a left-to-right frame: the emoji button stays at the right edge, as in Vizard.
    expect(markup).toMatch(/^<div[^>]*dir="ltr"/);
    expect(markup.indexOf("00:00.20")).toBeLessThan(markup.indexOf("<textarea"));
    expect(markup.indexOf("<textarea")).toBeLessThan(markup.indexOf("emoji on “خیال”"));
  });
});

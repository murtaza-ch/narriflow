import { beforeEach, describe, expect, test } from "bun:test";
import { ChakraProvider } from "@chakra-ui/react";
import { system } from "@narriflow/ui/theme";
import { renderToStaticMarkup } from "react-dom/server";
import { buildEditedTimeMap, type EditorDocument } from "@narriflow/validators";
import { emojiFixtureDocument, emojiFixtureLayersFor } from "./caption-emoji-fixture";
import { registerCaptionEmojiSource, resetCaptionEmojiSessions, runCaptionEmojiSuggestion, type CaptionEmojiAnswer } from "./caption-emoji-runs";
import { captionEmojiWords } from "./caption-emoji-words";
import { emojiRunFailure, EmojisSection } from "./emojis-section";
import { useCaptionEmojiEditor } from "./use-caption-emojis";

const noop = () => undefined;
const ColourField = ({ label }: { label: string }) => <span>{label} field</span>;

function render(document: EditorDocument, options: { readOnly?: boolean; timeSec?: number } = {}) {
  const model = captionEmojiWords(document, buildEditedTimeMap(document.deletedRanges, { startSec: document.clipStartSec, endSec: document.clipEndSec }));
  const layers = document.transcriptSlice.length > 0 ? emojiFixtureLayersFor(document, {}) : [];
  const clock = { getSnapshot: () => options.timeSec ?? 0.9, subscribe: () => noop };
  function Section() {
    const editor = useCaptionEmojiEditor({
      clipId: "clip-section",
      preset: document.captionPreset,
      entries: document.studioEdits.captionEmojis,
      model,
      readOnly: options.readOnly ?? false,
      updatePreset: noop,
      setEmojis: noop,
      replaceEmojis: () => undefined,
      save: async () => true,
      suggest: async () => ({ emojis: {} }),
      failureCode: () => null,
    });
    return <EmojisSection editor={editor} live={{ clock, layers, toBaseEdited: (sec) => sec }} ColourField={ColourField} />;
  }
  return renderToStaticMarkup(
    <ChakraProvider value={system}>
      <Section />
    </ChakraProvider>,
  );
}

const withEmojis = () => emojiFixtureDocument({ presetId: "bold-pop" });
const withoutEmojis = () => {
  const document = withEmojis();
  return { ...document, studioEdits: { ...document.studioEdits, captionEmojis: undefined } };
};

beforeEach(() => resetCaptionEmojiSessions());

/** An AI run on `clip-section` over the clip without emojis. */
function run(suggest: () => Promise<CaptionEmojiAnswer>, save: () => Promise<boolean> = async () => true) {
  const model = captionEmojiWords(withoutEmojis(), buildEditedTimeMap([], { startSec: 0, endSec: 100 }));
  registerCaptionEmojiSource("clip-section", () => ({ entries: undefined, model, readOnly: false, replace: (value) => value }));
  return runCaptionEmojiSuggestion("clip-section", "balanced", { save, suggest, failureCode: () => null });
}

const primaryButton = (markup: string) => markup.match(/<button[^>]*>(?:(?!<\/button>).)*(?:Add with AI|Adding emojis)(?:(?!<\/button>).)*<\/button>/)?.[0] ?? "";
/** The button's own background and opacity, read from the CSS emitted for its class. */
function surfaceOf(markup: string, button: string) {
  const className = button.match(/class="([^"]*)"/)?.[1] ?? "";
  const rule = markup.match(new RegExp(`\\.${className}\\{([^}]*)\\}`))?.[1] ?? "";
  return { background: rule.match(/(?:^|;)background:([^;]*)/)?.[1], opacity: rule.match(/(?:^|;)opacity:([^;]*)/)?.[1] };
}

describe("Emojis section states", () => {
  test("off: the switch and one line, no controls", () => {
    const document = withEmojis();
    const markup = render({ ...document, captionPreset: { ...document.captionPreset, emojis: false } });
    expect(markup).toContain('role="switch"');
    expect(markup).toContain('aria-checked="false"');
    expect(markup).toContain("Stickers above your captions");
    expect(markup).not.toContain("Add with AI");
    expect(markup).not.toContain("Regenerate");
  });

  test("on without emojis: Add with AI, the density choice and the hand-placement hint", () => {
    const markup = render(withoutEmojis());
    expect(markup).toContain("Add with AI");
    expect(markup).toContain("Balanced");
    expect(markup).toContain("Expressive");
    expect(markup).toContain("Or tap a word below to add one by hand.");
    expect(markup).not.toContain("Regenerate");
    expect(markup).toContain("On screen now");
  });

  test("on with emojis: the count, Regenerate, Remove all, style controls and word chips", () => {
    const markup = render(withEmojis());
    expect(markup).toContain("4 emojis");
    expect(markup).toContain("Regenerate");
    expect(markup).toContain("Remove all");
    expect(markup).toContain("Match template colors");
    expect(markup).toContain('aria-label="Emoji size"');
    expect(markup).toContain('aria-label="Emoji position"');
    expect(markup).toContain('aria-label="Sticker outline"');
    expect(markup).toContain("bulb emoji on “idea”, change");
    expect(markup).toContain("Add emoji to “This”");
  });

  test("read-only: the controls are inert and the switch is disabled", () => {
    const markup = render(withEmojis(), { readOnly: true });
    expect(markup).toContain("inert");
    expect(markup).toMatch(/role="switch"[^>]*aria-disabled="true"/);
  });

  test("a clip with no caption words says so and offers no AI action", () => {
    const markup = render({ ...withEmojis(), transcriptSlice: [] });
    expect(markup).toContain("This clip has no caption words yet");
    expect(markup).not.toContain("Add with AI");
  });

  test("an empty AI answer shows No emojis fit this clip", async () => {
    await run(async () => ({ emojis: {} }));
    expect(render(withoutEmojis())).toContain("No emojis fit this clip");
  });

  test("Add with AI keeps one surface while running and shows progress inside it", async () => {
    const idleMarkup = render(withoutEmojis());
    void run(() => new Promise(() => undefined));
    await Bun.sleep(0);
    const runningMarkup = render(withoutEmojis());
    const running = primaryButton(runningMarkup);
    expect(running).toContain('aria-busy="true"');
    expect(running).toContain("Adding emojis");
    const idle = surfaceOf(idleMarkup, primaryButton(idleMarkup));
    expect(idle.background).toBe("var(--chakra-colors-studio-raised)");
    expect(surfaceOf(runningMarkup, running)).toEqual(idle);
  });

  test("a done run says when picks were left out or part of the clip went untagged", async () => {
    const key = (line: number, word: number) => String(Math.round(withoutEmojis().transcriptSlice[line]!.words[word]!.startSec * 1000));
    await run(async () => ({ emojis: { [key(1, 3)]: { id: "flame" } }, complete: false }));
    expect(render(withoutEmojis())).toContain("Part of this clip couldn’t be tagged.");
  });

  test("a save that cannot finish says so, with a retry", async () => {
    await run(async () => ({ emojis: {} }), async () => false);
    const markup = render(withoutEmojis());
    expect(markup).toContain("Couldn’t save your latest edits, so no emojis were added.");
    expect(markup).toContain("Try again");
  });

  test("RTL cues lay their chips out right to left: the first word stands rightmost", () => {
    const document = emojiFixtureDocument({ presetId: "bold-pop", rtl: true });
    const model = captionEmojiWords(document, buildEditedTimeMap([], { startSec: document.clipStartSec, endSec: document.clipEndSec }));
    const layers = emojiFixtureLayersFor(document, { rtl: true });
    const clock = { getSnapshot: () => layers[0]!.activeRange.startSec + 0.01, subscribe: () => noop };
    function Section() {
      const editor = useCaptionEmojiEditor({
        clipId: "clip-rtl",
        preset: document.captionPreset,
        entries: document.studioEdits.captionEmojis,
        model,
        readOnly: false,
        updatePreset: noop,
        setEmojis: noop,
        replaceEmojis: () => undefined,
        save: async () => true,
        suggest: async () => ({ emojis: {} }),
        failureCode: () => null,
      });
      return <EmojisSection editor={editor} live={{ clock, layers, toBaseEdited: (sec) => sec }} ColourField={ColourField} />;
    }
    const markup = renderToStaticMarkup(
      <ChakraProvider value={system}>
        <Section />
      </ChakraProvider>,
    );
    const group = markup.slice(markup.indexOf('aria-label="Words on screen now"'));
    const words = layers[0]!.words.map((word) => word.text);
    expect(group.indexOf(words[0]!)).toBeGreaterThan(group.indexOf(words.at(-1)!));
    expect(markup).not.toMatch(/dir="rtl"[^>]*aria-label="Words on screen now"/);
  });
});

describe("AI failures", () => {
  const request = (code: string | null) => emojiRunFailure({ reason: "request", code });
  test("typed codes get their copy; a missing key or clip offers no retry", () => {
    expect(request("openai_rate_limited")).toEqual({ message: "Our AI provider is busy right now. Please try again in a minute.", retry: true });
    expect(request("clip_emoji_suggestion_failed").retry).toBe(true);
    expect(request("openai_not_configured").retry).toBe(false);
    expect(request("clip_not_found").retry).toBe(false);
    expect(request(null)).toEqual({ message: "Couldn't reach Narriflow. Check your connection and try again.", retry: true });
  });

  test("an incomplete Regenerate leaves the emojis and says so", () => {
    expect(emojiRunFailure({ reason: "incomplete" })).toEqual({ message: "Couldn’t finish. Your emojis are unchanged.", retry: true });
  });
});

import { describe, expect, test } from "bun:test";
import { ChakraProvider } from "@chakra-ui/react";
import { CAPTION_EMOJI_INDEX } from "@narriflow/caption-emoji/index";
import { loadCaptionEmojiArt } from "@narriflow/caption-emoji/art";
import { system } from "@narriflow/ui/theme";
import { CAPTION_EMOJI_PALETTES, captionEmojiTemplateColours, getCaptionPresetById, resolveCaptionEmojiPalette } from "@narriflow/validators";
import { renderToStaticMarkup } from "react-dom/server";
import { captionEmojiSvgMarkup, EmojiGlyph } from "./emoji-glyph";
import { pickerLayout } from "./emoji-picker-model";
import { EmojiPickerGrid } from "./emoji-picker-parts";

describe("Studio glyphs draw what the video draws", () => {
  test("under the template's palette a face takes the template's colours like every design; a named palette colours it", async () => {
    const art = await loadCaptionEmojiArt(["heart-eyes", "rocket"]);
    const headline = resolveCaptionEmojiPalette({}, captionEmojiTemplateColours(getCaptionPresetById("headline")!.preset));
    const face = captionEmojiSvgMarkup(art.get("heart-eyes")!, headline, 0, 24);
    // Headline's green body and teal rim, never the pack's yellow.
    expect(face).toContain(`fill="${headline.a}"`);
    expect(face).toContain(`fill="${headline.b}"`);
    expect(face).not.toContain('fill="#ffe45c"');
    expect(captionEmojiSvgMarkup(art.get("rocket")!, headline, 0, 24)).toContain(`fill="${headline.a}"`);
    const jelly = CAPTION_EMOJI_PALETTES[1].palette;
    expect(captionEmojiSvgMarkup(art.get("heart-eyes")!, jelly, 0, 24)).toContain(`fill="${jelly.a}"`);
  });
});

/** The CSS rules the markup's elements of `className` get (Chakra emits one rule per class). */
function rulesOf(markup: string, className: string): string {
  return [...markup.matchAll(/\.([\w-]+)\{([^}]*)\}/g)].filter((rule) => className.split(" ").includes(rule[1]!)).map((rule) => rule[2]).join(";");
}

describe("art still loading never shows a placeholder", () => {
  const palette = CAPTION_EMOJI_PALETTES[1].palette;

  test("a glyph is an empty box of its size: no art, no fill, no round shape", () => {
    // Server markup runs no effect, so the art is never loaded here.
    const markup = renderToStaticMarkup(
      <ChakraProvider value={system}>
        <EmojiGlyph id="rocket" palette={palette} size={22} />
      </ChakraProvider>,
    );
    expect(markup).not.toContain("<svg");
    const box = markup.match(/<div[^>]*aria-hidden="true"[^>]*>/)?.[0] ?? "";
    const rules = rulesOf(markup, box.match(/class="([^"]*)"/)?.[1] ?? "");
    expect(rules).toContain("22px");
    expect(rules).not.toMatch(/background|border-radius/);
  });

  test("a picker cell whose art is not loaded is empty", () => {
    const layout = pickerLayout([{ id: "a", label: "A", items: CAPTION_EMOJI_INDEX.slice(0, 8) }], 8, { header: 30, row: 40 });
    const markup = renderToStaticMarkup(
      <ChakraProvider value={system}>
        <EmojiPickerGrid gridId="grid" cellId={(index) => `cell-${index}`} layout={layout} rows={layout.rows} first={0} active={0} currentId={null}
          art={new Map()} palette={palette} tone={0} onActive={() => undefined} onPick={() => undefined} />
      </ChakraProvider>,
    );
    const cells = [...markup.matchAll(/<div[^>]*role="gridcell"[^>]*>(.*?)<\/div>/g)];
    expect(cells).toHaveLength(8);
    expect(cells.every((cell) => cell[1] === "")).toBe(true);
    expect(markup).not.toContain("<span data-placeholder");
  });
});

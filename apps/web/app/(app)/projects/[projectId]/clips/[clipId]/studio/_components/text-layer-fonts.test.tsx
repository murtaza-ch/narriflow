import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChakraProvider } from "@chakra-ui/react";
import { system } from "@narriflow/ui/theme";
import { DEFAULT_TITLE_STYLE, captionFontFace, studioTextLayerSchema } from "@narriflow/validators";
import { type BrandFontChoice, BrandFontsProvider } from "@/app/(app)/brand-kit/_components/brand-fonts";
import { textLayerSceneKey } from "./text-layer-scene";
import { TextFontMenu } from "./tool-panels/text-style-controls";

/** Title-text ticket 08 in the Studio: uploads key the Text Layer build, and the font menu names the chosen upload. */

const FONT: BrandFontChoice = {
  id: "4d119c8d-acde-4d95-82a4-0e61210e61db",
  family: "Brand Sans",
  style: "SemiBold",
  weight: 600,
  fingerprint: "a".repeat(64),
  accessUrl: "https://example.test/font.ttf",
  face: { ...captionFontFace("Inter"), name: "Brand Sans", assName: "Brand Sans SemiBold", file: "" },
};
const OTHER: BrandFontChoice = { ...FONT, id: "9d119c8d-acde-4d95-82a4-0e61210e61db", family: "Other" };
const reference = { kind: "brand_font" as const, id: FONT.id, fingerprint: FONT.fingerprint };
const entry = (fontAsset: typeof reference | null) => ({ layer: studioTextLayerSchema.parse({ id: "t", text: "Hello", style: { ...DEFAULT_TITLE_STYLE, fontAsset } }), window: { fromMs: 0, toMs: 1000 } });
const CANVAS = { width: 1080, height: 1920 };

describe("textLayerSceneKey", () => {
  test("a loaded upload a layer draws changes the key; uploads no layer uses do not", () => {
    const plain = [entry(null)];
    expect(textLayerSceneKey(plain, CANVAS, [FONT, OTHER])).toBe(textLayerSceneKey(plain, CANVAS));
    const uploaded = [entry(reference)];
    // Before the file loads the layer draws its family; the load rebuilds it in the upload.
    expect(textLayerSceneKey(uploaded, CANVAS, [FONT])).not.toBe(textLayerSceneKey(uploaded, CANVAS, []));
    expect(textLayerSceneKey(uploaded, CANVAS, [FONT, OTHER])).toBe(textLayerSceneKey(uploaded, CANVAS, [FONT]));
  });
});

describe("TextFontMenu", () => {
  const render = (fontAsset: typeof reference | null, fonts: readonly BrandFontChoice[] = [FONT]) =>
    renderToStaticMarkup(
      <ChakraProvider value={system}>
        <BrandFontsProvider fonts={fonts}>
          <TextFontMenu value={{ font: "Montserrat", fontAsset }} onChange={() => undefined} />
        </BrandFontsProvider>
      </ChakraProvider>,
    );

  test("names the upload when one is chosen, else the family", () => {
    expect(render(reference)).toContain('aria-label="Font: Brand Sans"');
    expect(render(null)).toContain('aria-label="Font: Montserrat"');
    // An upload no longer in the library is still named as a saved font (it draws in its family).
    expect(render(reference, [])).toContain('aria-label="Font: Saved font"');
  });
});

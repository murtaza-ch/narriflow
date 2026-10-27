import { describe, expect, test } from "bun:test";
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { renderToStaticMarkup } from "react-dom/server";
import { captionFontFace } from "@narriflow/validators";
import {
  BrandFontPicker,
  BrandFontsProvider,
  type BrandFontChoice,
} from "./brand-fonts";
import { UpgradeProvider } from "../../_components/upgrade";

const font: BrandFontChoice = {
  id: "10000000-0000-4000-8000-000000000003",
  family: "My uploaded font",
  style: "Regular",
  weight: 400,
  fingerprint: "a".repeat(64),
  accessUrl: "https://storage.example.test/font.ttf",
  face: captionFontFace("Anton"),
};
function render(fonts: BrandFontChoice[], requirement: string | null = null) {
  return renderToStaticMarkup(
    <ChakraProvider value={defaultSystem}>
      <UpgradeProvider
        currentTier="free"
        billingMode="checkout"
        canManageBilling
      >
        <BrandFontsProvider
          fonts={fonts}
          requirement={requirement}
          upgrade={
            requirement ? { tier: "creator", headline: "Custom fonts" } : null
          }
        >
          <BrandFontPicker value={null} onChange={() => {}} />
        </BrandFontsProvider>
      </UpgradeProvider>
    </ChakraProvider>,
  );
}

describe("custom font selection", () => {
  test("paid users can choose an available uploaded face", () => {
    const html = render([font]);
    expect(html).toContain('aria-label="Custom font"');
    expect(html).toContain("My uploaded font");
    expect(html).toContain(font.id);
  });
  test("Free users see the shared upgrade affordance and no selectable upload", () => {
    const html = render([font], "Custom fonts need the Creator plan.");
    expect(html).toContain("Custom fonts need the Creator plan.");
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).not.toContain('aria-label="Custom font"');
  });
  test("deleted and missing fonts stay out of new selections", () => {
    const html = render([
      { ...font, insertable: false },
      { ...font, id: "10000000-0000-4000-8000-000000000004", accessUrl: null },
    ]);
    expect(html).not.toContain("My uploaded font");
    expect(html).toContain("Upload fonts in Brand kit");
  });
});

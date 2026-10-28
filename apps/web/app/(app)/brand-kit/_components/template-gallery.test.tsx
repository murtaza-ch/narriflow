import { describe, expect, mock, test } from "bun:test";
import { ChakraProvider } from "@chakra-ui/react";
import { system } from "@narriflow/ui/theme";
import { DEFAULT_CAPTION_PRESET, type BrandTemplateSummary } from "@narriflow/validators";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  notFound: () => {},
}));
const { TemplateGallery } = await import("./template-gallery");
const { StubBrandApi } = await import("./brand-api.test-support");

const builtIn: BrandTemplateSummary = {
  id: "10000000-0000-4000-8000-000000000001",
  userId: null,
  name: "Bold pop",
  isBuiltIn: true,
  builtInKey: "bold-pop",
  captionPreset: DEFAULT_CAPTION_PRESET,
  logoStorageKey: null,
  logoPosition: "top-right",
  logoOpacity: 100,
  logoScalePct: 100,
  primaryColor: "#FFFFFF",
  secondaryColor: "#000000",
  accentColor: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
} as BrandTemplateSummary;

function render(canManage: boolean, canSetDefault: boolean) {
  return renderToStaticMarkup(
    <ChakraProvider value={system}>
      <StubBrandApi>
      <TemplateGallery
        builtIns={[builtIn]}
        mine={[]}
        defaultId={null}
        access={{ canManage, canSetDefault, customUpgrade: null, duplicateBlocked: null }}
      />
      </StubBrandApi>
    </ChakraProvider>,
  );
}

function radio(html: string) {
  return html.match(/<button[^>]*role="radio"[^>]*>/)?.[0] ?? "";
}

describe("Template gallery access", () => {
  test("a viewer sees styles without actions or a default control", () => {
    const html = render(false, false);
    expect(html).toContain("Bold pop");
    expect(html).not.toContain("Actions for Bold pop");
    expect(radio(html)).toContain("disabled");
    expect(html).toContain("Saved styles appear here.");
  });

  test("an editor manages styles but can't choose the workspace default", () => {
    const html = render(true, false);
    expect(html).toContain("Actions for Bold pop");
    expect(radio(html)).toContain("disabled");
  });

  test("an owner or admin can choose the default", () => {
    const html = render(true, true);
    expect(radio(html)).not.toContain("disabled");
  });
});

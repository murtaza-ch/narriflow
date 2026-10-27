import { describe, expect, test } from "bun:test";
import { ChakraProvider } from "@chakra-ui/react";
import { system } from "@narriflow/ui/theme";
import type { PricingTier } from "@narriflow/validators";
import { renderToStaticMarkup } from "react-dom/server";
import { UpgradeProvider } from "../../_components/upgrade";
import { BrandTemplatePicker } from "./brand-template-picker";

function render(tier: PricingTier, profiles: Array<{ id: string; name: string; defaultTemplateId: string | null; templates: [] }> = []) {
  return renderToStaticMarkup(
    <ChakraProvider value={system}>
      <UpgradeProvider currentTier={tier} billingMode="checkout" canManageBilling>
        <BrandTemplatePicker builtIns={[]} mine={[]} value={null} onChange={() => {}} profiles={profiles} />
      </UpgradeProvider>
    </ChakraProvider>,
  );
}

describe("BrandTemplatePicker", () => {
  test("a plan without Brand Profiles explains the empty list and offers the upgrade", () => {
    const markup = render("free");
    expect(markup).toContain("Brand Profiles need the Creator plan.");
    expect(markup).toContain("Upgrade");
  });

  test("a plan with Brand Profiles shows no upgrade notice", () => {
    expect(render("creator")).not.toContain("need the");
  });
});

import { describe, expect, test } from "bun:test";
import { ChakraProvider } from "@chakra-ui/react";
import { system } from "@narriflow/ui/theme";
import type { PricingTier } from "@narriflow/validators";
import { renderToStaticMarkup } from "react-dom/server";
import { UpgradeProvider } from "../_components/upgrade";
import { CreationTools } from "./creation-tools";

function render(tier: PricingTier) {
  return renderToStaticMarkup(
    <ChakraProvider value={system}>
      <UpgradeProvider currentTier={tier} billingMode="checkout" canManageBilling>
        <CreationTools items={[]} />
      </UpgradeProvider>
    </ChakraProvider>,
  );
}

describe("CreationTools", () => {
  test("marks the tools the plan lacks with the plan that adds them", () => {
    const free = render("free");
    expect(free).toContain('aria-label="Needs Creator"');
    expect(free).toContain('aria-label="Needs Pro"');
    const creator = render("creator");
    expect(creator).not.toContain('aria-label="Needs Creator"');
    expect(creator).toContain('aria-label="Needs Pro"');
    expect(render("pro")).not.toContain('aria-label="Needs');
  });
});

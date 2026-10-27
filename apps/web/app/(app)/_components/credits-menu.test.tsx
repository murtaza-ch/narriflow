import { describe, expect, test } from "bun:test";
import { ChakraProvider } from "@chakra-ui/react";
import { system } from "@narriflow/ui/theme";
import { renderToStaticMarkup } from "react-dom/server";
import type { PricingTier } from "@narriflow/validators";
import { CreditsMenu, creditsPresentation, creditsUpgradeTier } from "./credits-menu";

describe("creditsPresentation", () => {
  test("is quiet at 0% and states nothing extra", () => {
    const view = creditsPresentation({ usedCredits: 0, reservedCredits: 0, limitCredits: 300 });
    expect(view).toMatchObject({ pct: 0, palette: "accent", status: null, usage: "0 of 300 used" });
  });

  test("warns in words at 80%", () => {
    const view = creditsPresentation({ usedCredits: 240, reservedCredits: 0, limitCredits: 300 });
    expect(view).toMatchObject({ pct: 80, palette: "warning", status: "Running low" });
  });

  test("says when none are left at 100%", () => {
    const view = creditsPresentation({ usedCredits: 300, reservedCredits: 0, limitCredits: 300 });
    expect(view).toMatchObject({ pct: 100, palette: "danger", status: "No credits left" });
  });

  test("reports reserved credits apart from settled ones and counts them in the bar", () => {
    const view = creditsPresentation({ usedCredits: 100, reservedCredits: 50, limitCredits: 300 });
    expect(view.usage).toBe("100 of 300 used · 50 reserved");
    expect(view.pct).toBe(50);
  });

  test("reports real usage past the allowance and caps only the bar", () => {
    const view = creditsPresentation({ usedCredits: 900, reservedCredits: 0, limitCredits: 300 });
    expect(view.usage).toBe("900 of 300 used");
    expect(view.pct).toBe(100);
  });

  test("formats thousands with the en-US separator on server and client", () => {
    const view = creditsPresentation({ usedCredits: 1500, reservedCredits: 0, limitCredits: 12000 });
    expect(view.usage).toBe("1,500 of 12,000 used");
  });
});

describe("creditsUpgradeTier", () => {
  test("offers the next plan when it has room", () => {
    expect(creditsUpgradeTier("free", 10)).toBe("creator");
    expect(creditsUpgradeTier("creator", 250)).toBe("pro");
    expect(creditsUpgradeTier("pro", 850)).toBe("business");
  });

  test("skips plans the spent credits would leave with none", () => {
    // Free after a downgrade from Pro: Creator (300) and Pro (900) are already used up.
    expect(creditsUpgradeTier("free", 900)).toBe("business");
    expect(creditsUpgradeTier("free", 899)).toBe("pro");
    expect(creditsUpgradeTier("creator", 300)).toBe("pro");
  });

  test("offers nothing when no higher plan has room, or on the top plan", () => {
    expect(creditsUpgradeTier("free", 1900)).toBeNull();
    expect(creditsUpgradeTier("pro", 1800)).toBeNull();
    expect(creditsUpgradeTier("business", 0)).toBeNull();
  });
});

describe("CreditsMenu trigger", () => {
  function render(props: {
    remainingCredits: number;
    usedCredits: number;
    limitCredits: number;
    reservedCredits?: number;
    tier?: PricingTier;
    canManageBilling?: boolean;
  }) {
    return renderToStaticMarkup(
      <ChakraProvider value={system}>
        <CreditsMenu
          reservedCredits={0}
          renewsAt="2026-11-01T00:00:00.000Z"
          tier="free"
          canManageBilling
          {...props}
        />
      </ChakraProvider>,
    );
  }

  test("offers the cheapest plan that still has credits after a downgrade", () => {
    const markup = render({ remainingCredits: 0, usedCredits: 900, limitCredits: 60 });
    expect(markup).toContain("/settings/billing?plan=business#plans");
  });

  test("counts reserved credits when picking the plan", () => {
    const markup = render({ remainingCredits: 0, usedCredits: 500, reservedCredits: 400, limitCredits: 60 });
    expect(markup).toContain("/settings/billing?plan=business#plans");
  });

  test("offers no upgrade when no higher plan has room", () => {
    const markup = render({ remainingCredits: 0, usedCredits: 1900, limitCredits: 60 });
    expect(markup).not.toContain("plan=");
    expect(markup).not.toContain("Upgrade");
  });

  test("offers no upgrade to someone who cannot manage billing", () => {
    const markup = render({ remainingCredits: 50, usedCredits: 10, limitCredits: 60, canManageBilling: false });
    expect(markup).not.toContain("plan=");
  });

  test("announces a depleted balance in text, not only color", () => {
    const markup = render({ remainingCredits: 0, usedCredits: 900, limitCredits: 300 });
    expect(markup).toContain("0 credits left. No credits left");
    expect(markup).toContain("lucide-circle-alert");
  });

  test("keeps the plain balance when credits are healthy", () => {
    const markup = render({ remainingCredits: 1500, usedCredits: 10, limitCredits: 1510 });
    expect(markup).toContain('aria-label="1,500 credits left"');
    expect(markup).not.toContain("lucide-circle-alert");
  });
});

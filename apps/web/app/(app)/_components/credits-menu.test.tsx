import { describe, expect, test } from "bun:test";
import { ChakraProvider } from "@chakra-ui/react";
import { system } from "@narriflow/ui/theme";
import { renderToStaticMarkup } from "react-dom/server";
import { CreditsMenu, creditsPresentation } from "./credits-menu";

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

describe("CreditsMenu trigger", () => {
  function render(props: { remainingCredits: number; usedCredits: number; limitCredits: number }) {
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

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { ChakraProvider } from "@chakra-ui/react";
import { system } from "@narriflow/ui/theme";
import { renderToStaticMarkup } from "react-dom/server";
import { LockedButton, UpgradeHero, upgradeHref } from "./upgrade";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(<ChakraProvider value={system}>{node}</ChakraProvider>);
}

describe("LockedButton", () => {
  test("stays a visible action marked with a gem and names the required plan to screen readers", () => {
    const markup = render(
      <LockedButton prompt={{ tier: "pro", headline: "Upgrade to export a bundle" }}>Export bundle</LockedButton>,
    );
    expect(markup).toContain("Export bundle");
    expect(markup).toContain("lucide-gem");
    expect(markup).toContain("(needs Pro)");
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).not.toContain(`disabled=""`);
  });
});

describe("UpgradeHero", () => {
  test("sends a non-owner to the owner instead of a purchase action", () => {
    const markup = render(
      <UpgradeHero
        title="Bring your team into one workspace"
        points={["Invite admins and editors."]}
        ctaLabel="Upgrade to invite your team"
        visual={null}
        prompt={{ tier: "business", headline: "Upgrade to work with your team", canManageBilling: false }}
      />,
    );
    expect(markup).toContain("Ask the workspace owner to upgrade to Business.");
    expect(markup).not.toContain("Upgrade to invite your team");
  });
});

describe("upgradeHref", () => {
  test("opens billing on the plan and interval, at the plans section", () => {
    expect(upgradeHref("pro", "annual")).toBe("/settings/billing?plan=pro&interval=annual#plans");
    expect(upgradeHref("pro")).toBe("/settings/billing?plan=pro#plans");
    expect(upgradeHref("free")).toBe("/settings/billing#plans");
    expect(upgradeHref(null)).toBe("/settings/billing#plans");
  });
});

// The open dialog needs a DOM, so it runs in the repo's happy-dom fixture
// subprocess, which keeps browser globals out of this process.
test("UpgradeProvider dialog: checkout interval choice, plan change review, owner-only action", async () => {
  const child = Bun.spawn(
    ["bun", "test", "./apps/web/app/(app)/_components/upgrade.browser.fixture.tsx"],
    { cwd: resolve(import.meta.dir, "../../../../.."), stdout: "pipe", stderr: "pipe" },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`${stdout}\n${stderr}`);
  expect(exitCode).toBe(0);
}, 30_000);

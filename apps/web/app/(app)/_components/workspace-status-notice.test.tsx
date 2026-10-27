import { describe, expect, test } from "bun:test";
import { ChakraProvider } from "@chakra-ui/react";
import { system } from "@narriflow/ui/theme";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceStatusNotice } from "./workspace-status-notice";

function render(props: Parameters<typeof WorkspaceStatusNotice>[0]) {
  return renderToStaticMarkup(
    <ChakraProvider value={system}>
      <WorkspaceStatusNotice {...props} />
    </ChakraProvider>,
  );
}

describe("WorkspaceStatusNotice", () => {
  test("says nothing in an active workspace", () => {
    expect(render({ status: "active", role: "owner", pathname: "/home" })).not.toContain(`role="status"`);
  });

  test("gives the owner the way out of each state", () => {
    const pending = render({ status: "pending_payment", role: "owner", pathname: "/home" });
    expect(pending).toContain('href="/settings/billing"');
    expect(pending).toContain("Complete setup");
    const restricted = render({ status: "restricted", role: "owner", pathname: "/projects" });
    expect(restricted).toContain("Manage billing");
  });

  test("tells everyone else whom to ask, without a billing action", () => {
    const markup = render({ status: "restricted", role: "editor", pathname: "/home" });
    expect(markup).toContain("Ask the workspace owner to fix billing.");
    expect(markup).not.toContain('href="/settings/billing"');
  });

  test("stays off the billing page, which explains the state itself", () => {
    expect(render({ status: "restricted", role: "owner", pathname: "/settings/billing" })).not.toContain(`role="status"`);
  });
});

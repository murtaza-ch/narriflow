import { describe, expect, mock, test } from "bun:test";
import { ApiError } from "@narriflow/api-client/core";
import type { ReactNode } from "react";
import { ChakraProvider } from "@chakra-ui/react";
import { system } from "@narriflow/ui/theme";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("./workspace-billing-link", () => ({ WorkspaceBillingLink: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a> }));
const { ConnectorUnavailable, connectorUnavailableReason, connectorWorkspaceFromError } = await import("./connector-unavailable");

type Workspace = Parameters<typeof ConnectorUnavailable>[0]["workspace"];
const ACME = { workspaceId: "00000000-0000-4000-8000-0000000000a1", workspaceName: "Acme" } as const;

function render(workspace: Omit<Workspace, "workspaceId" | "workspaceName">, capability: "processing.consume" | "publishing.manage" = "processing.consume") {
  return renderToStaticMarkup(
    <ChakraProvider value={system}>
      <ConnectorUnavailable workspace={{ ...ACME, ...workspace }} capability={capability} action="Uploading for your assistant" />
    </ChakraProvider>,
  );
}

describe("ConnectorUnavailable", () => {
  test("the owner of a plan without the connector gets the plans link", () => {
    const markup = render({ role: "owner", status: "active", pricingTier: "creator" });
    expect(markup).toContain("Acme is on the Creator plan. Uploading for your assistant needs the Pro plan.");
    expect(markup).toContain('href="/settings/billing?plan=pro#plans"');
  });

  test("anyone else is told to ask the owner, with no billing link", () => {
    const markup = render({ role: "editor", status: "active", pricingTier: "creator" });
    expect(markup).toContain("Ask the workspace owner to upgrade.");
    expect(markup).not.toContain("/settings/billing");
    expect(markup).toContain('href="/integrations/mcp"');
  });

  test("a restricted or pending Workspace names its state; only the owner gets billing", () => {
    expect(render({ role: "owner", status: "restricted", pricingTier: "pro" })).toContain('href="/settings/billing"');
    const admin = render({ role: "admin", status: "pending_payment", pricingTier: "pro" });
    expect(admin).toContain("Acme isn&#x27;t active, so uploading for your assistant is paused. Ask the workspace owner to fix billing.");
    expect(admin).not.toContain("/settings/billing");
  });

  test("a viewer is told to ask for access, never offered an upgrade, whatever the plan", () => {
    const markup = render({ role: "viewer", status: "active", pricingTier: "creator" }, "publishing.manage");
    expect(markup).toContain("needs editor access. Ask a workspace owner or admin.");
    expect(markup).not.toContain("plan");
    expect(markup).not.toContain("/settings/billing");
  });

  test("reasons come in order: role, then plan, then Workspace state", () => {
    const workspace = { ...ACME, role: "editor", status: "restricted", pricingTier: "creator" } as const;
    expect(connectorUnavailableReason({ ...workspace, role: "viewer" }, "processing.consume")).toBe("role");
    expect(connectorUnavailableReason(workspace, "processing.consume")).toBe("plan");
    expect(connectorUnavailableReason({ ...workspace, pricingTier: "pro" }, "processing.consume")).toBe("status");
    expect(connectorUnavailableReason({ ...workspace, pricingTier: "pro", status: "active" }, "processing.consume")).toBeNull();
  });
});

test("connector recovery requires the typed refusal and valid Workspace facts", () => {
  const workspace: Workspace = { ...ACME, role: "owner", status: "restricted", pricingTier: "pro" };
  expect(connectorWorkspaceFromError(new ApiError({ code: "integration_access_unavailable", status: 402, message: "Unavailable", details: { workspace } }))).toEqual(workspace);
  expect(connectorWorkspaceFromError(new ApiError({ code: "mcp_continuation_revoked", status: 403, message: "Revoked", details: { workspace } }))).toBeNull();
  expect(connectorWorkspaceFromError(new ApiError({ code: "integration_access_unavailable", status: 403, message: "Unavailable", details: { workspace: { ...workspace, role: "staff" } } }))).toBeNull();
});

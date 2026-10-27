import { describe, expect, mock, test } from "bun:test";
import { ChakraProvider } from "@chakra-ui/react";
import { system } from "@narriflow/ui/theme";
import type { WorkspaceBillingView } from "@narriflow/validators";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {} }) }));
mock.module("../actions", () => ({
  changeMemberRoleAction: async () => ({ ok: true }),
  inviteMemberAction: async () => ({ ok: true }),
  removeMemberAction: async () => ({ ok: true }),
  resendInviteAction: async () => ({ ok: true }),
  revokeInviteAction: async () => ({ ok: true }),
}));
const { MembersPanel } = await import("./members-panel");

const billingView = { plan: "business", health: "current", desiredAdditionalSeats: 0, synchronizedAdditionalSeats: 0 } as WorkspaceBillingView;
const members = [
  { id: "m1", role: "owner" as const, joinedAt: "2026-10-01T00:00:00.000Z", user: { id: "u1", primaryEmail: "owner@example.com", firstName: "Olive", lastName: null } },
  { id: "m2", role: "editor" as const, joinedAt: "2026-10-01T00:00:00.000Z", user: { id: "u2", primaryEmail: "ed@example.com", firstName: "Ed", lastName: null } },
];

function render(actorRole: "owner" | "admin" | "editor" | "viewer", workspaceStatus: "active" | "pending_payment" | "restricted", view = billingView) {
  return renderToStaticMarkup(
    <ChakraProvider value={system}>
      <MembersPanel actorRole={actorRole} isBusiness workspaceStatus={workspaceStatus} billingView={view} members={members} invites={[]} />
    </ChakraProvider>,
  );
}

describe("Members panel", () => {
  test("an editor is told whom to ask instead of seeing a disabled invite form", () => {
    const html = render("editor", "active");
    expect(html).toContain("Ask a workspace owner or admin to invite members.");
    expect(html).not.toContain("Send invite");
  });

  test("a pending owner, who can't manage members yet, is sent to billing", () => {
    const html = render("owner", "pending_payment");
    expect(html).toContain("Finish billing setup to invite members.");
    expect(html).toContain('href="/settings/billing"');
    expect(html).not.toContain("Send invite");
    expect(html).not.toContain("Remove Ed");
  });

  test("a restricted owner keeps remove and demote, with a way to billing", () => {
    const html = render("owner", "restricted");
    expect(html).toContain("Invitations are unavailable until billing is active.");
    expect(html).toContain('href="/settings/billing"');
    expect(html).toContain("Remove Ed");
  });

  test("paid seats held back by billing say why", () => {
    const html = render("admin", "active", { ...billingView, health: "attention_required" } as WorkspaceBillingView);
    expect(html).toContain("Admins and editors are paid seats");
    expect(html).toContain("Ask the workspace owner to update billing.");
  });
});

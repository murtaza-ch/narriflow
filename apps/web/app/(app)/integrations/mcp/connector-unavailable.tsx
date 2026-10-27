import Link from "next/link";
import { Flex, Stack } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import { PageHeader } from "@narriflow/ui/components/page-header";
import {
  hasFeature,
  lowestTierWithFeature,
  PLAN_CATALOG,
  resolvePricingTier,
  roleHasWorkspaceCapability,
  workspaceAllowsCapability,
  type WorkspaceAccessRole,
  type WorkspaceAccessStatus,
  type WorkspaceCapability,
} from "@narriflow/validators";
import { WorkspaceBillingLink } from "./workspace-billing-link";

type HandoffWorkspace = { workspaceId: string; workspaceName: string; role: WorkspaceAccessRole; status: WorkspaceAccessStatus; pricingTier: string };

/**
 * Why this member can't finish an assistant handoff in its Workspace now, or
 * null when they can. The role comes first (no plan fixes it), then the plan,
 * then the Workspace's billing state.
 */
export function connectorUnavailableReason(workspace: HandoffWorkspace, capability: WorkspaceCapability): "role" | "plan" | "status" | null {
  if (!roleHasWorkspaceCapability(workspace.role, capability)) return "role";
  if (!hasFeature(workspace.pricingTier, "integrations.mcp")) return "plan";
  if (workspace.status !== "active") return "status";
  return null;
}

/**
 * An assistant handoff (upload or publication confirmation) this member can't
 * finish right now: says why and offers the next step. Only the owner can
 * change the plan or fix billing, and the billing link opens the handoff's
 * Workspace; everyone else is told whom to ask.
 */
export function ConnectorUnavailable({
  workspace,
  action,
  capability,
}: {
  workspace: HandoffWorkspace;
  /** What the handoff does, e.g. "Uploading for your assistant". */
  action: string;
  /** What the handoff needs the member to be allowed to do. */
  capability: WorkspaceCapability;
}) {
  const reason = connectorUnavailableReason(workspace, capability) ?? "status";
  const canManageBilling = reason !== "role" && workspaceAllowsCapability(workspace, "billing.manage");
  const required = lowestTierWithFeature("integrations.mcp");
  const description =
    reason === "role"
      ? `${action} in ${workspace.workspaceName} needs editor access. Ask a workspace owner or admin.`
      : reason === "plan"
        ? `${workspace.workspaceName} is on the ${PLAN_CATALOG[resolvePricingTier(workspace.pricingTier)].name} plan. ${action} needs ${required ? `the ${PLAN_CATALOG[required].name} plan` : "a higher plan"}.${canManageBilling ? "" : " Ask the workspace owner to upgrade."}`
        : `${workspace.workspaceName} isn't active, so ${action.toLowerCase()} is paused.${canManageBilling ? "" : " Ask the workspace owner to fix billing."}`;
  return (
    <Stack gap="4">
      <PageHeader title="Assistant connector unavailable" description={description} />
      <Flex gap="3" wrap="wrap" align="flex-start">
        {canManageBilling ? (
          <WorkspaceBillingLink
            workspaceId={workspace.workspaceId}
            href={reason === "plan" && required ? `/settings/billing?plan=${required}#plans` : "/settings/billing"}
          >
            {reason === "plan" ? "See plans" : "Open billing"}
          </WorkspaceBillingLink>
        ) : null}
        <Button asChild variant="subtle">
          <Link href="/integrations/mcp">Back to MCP integration</Link>
        </Button>
      </Flex>
    </Stack>
  );
}

import { admitWorkspacePage } from "@/lib/authenticated-request-page";
import { autopilotService, hasFeature, recipeService, standingGrants, zoomConfigured, zoomService } from "@narriflow/services";
import { planCountRequirement, workspaceAllowsCapability } from "@narriflow/validators";
import { AutopilotPanel } from "./autopilot-panel";

export default async function AutopilotPage({ searchParams }: { searchParams: Promise<{ zoom?: string }> }) {
  const appUser = await admitWorkspacePage("content.view");
  const zoomEnabled = zoomConfigured();
  const [rules, recipes, grants, connections, query] = await Promise.all([
    autopilotService.listRules(appUser),
    recipeService.list(appUser),
    standingGrants.list(appUser),
    zoomEnabled ? zoomService.listConnections(appUser) : [],
    searchParams,
  ]);

  // Active and running rules hold a slot; paused or failed ones don't.
  const activeRules = rules.filter((rule) => rule.status === "active" || rule.status === "running").length;
  const newRuleRequirement = planCountRequirement(appUser.pricingTier, "autopilotRules", activeRules);
  return (
    <AutopilotPanel
      newRuleRequirement={newRuleRequirement?.message ?? null}
      newRuleUpgradeTier={newRuleRequirement?.requiredTier ?? null}
      autopilotIncluded={hasFeature(appUser.pricingTier, "automation.autopilot")}
      canManageBilling={appUser.role === "owner"}
      initialRules={rules}
      recipes={recipes}
      zoomEnabled={zoomEnabled}
      zoomConnections={connections}
      zoomNotice={query.zoom}
      canConnectZoom={workspaceAllowsCapability({ role: appUser.role, status: appUser.status }, "content.edit")}
      canTakeOver={workspaceAllowsCapability(
        { role: appUser.role, status: appUser.status },
        "workspace.manage",
      )}
      finishingAvailable={hasFeature(appUser.pricingTier, "campaign.operations")}
      grants={grants.flatMap((grant) =>
        grant.autopilotRuleId && (grant.status === "active" || grant.status === "paused")
          ? [{
              id: grant.id,
              ruleId: grant.autopilotRuleId,
              kind: grant.kind,
              status: grant.status,
              destination: grant.kind === "publish" ? (grant.accountLabel ?? "an account") : `${grant.reviewerCount} reviewer${grant.reviewerCount === 1 ? "" : "s"}`,
              expiresAt: grant.expiresAt,
            }]
          : [])}
    />
  );
}

import { admitWorkspacePage } from "@/lib/authenticated-request-page";
import { autopilotService, hasFeature, recipeService, standingGrants } from "@narriflow/services";
import { workspaceAllowsCapability } from "@narriflow/validators";
import { AutopilotPanel } from "./autopilot-panel";

export default async function AutopilotPage() {
  const appUser = await admitWorkspacePage("content.view");
  const [rules, recipes, grants] = await Promise.all([
    autopilotService.listRules(appUser),
    recipeService.list(appUser),
    standingGrants.list(appUser),
  ]);

  return (
    <AutopilotPanel
      initialRules={rules}
      recipes={recipes}
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

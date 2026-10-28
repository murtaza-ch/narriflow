import type {
  AutomationOverview,
  AutopilotGrantSummary,
  GrantAccountOption,
  StandingGrantsOverview,
  StandingGrantView,
} from "@narriflow/validators/api/automation";
import {
  hasFeature,
  planCountRequirement,
  workspaceAllowsCapability,
} from "@narriflow/validators";
import type { BrowserActorScope } from "../../http/request-policy-runtime";
import type { AutomationRouteDeps } from "./routes";

type ReadDeps = Pick<
  AutomationRouteDeps,
  "autopilotService" | "recipeService" | "standingGrants" | "zoomService" | "zoomConfigured" | "socialOAuthService"
>;

/** The grants the Autopilot page lists beside their rules: live ones only, with a one-line destination. */
export function summarizeGrants(grants: readonly StandingGrantView[]): AutopilotGrantSummary[] {
  return grants.flatMap((grant) =>
    grant.autopilotRuleId && (grant.status === "active" || grant.status === "paused")
      ? [
          {
            id: grant.id,
            ruleId: grant.autopilotRuleId,
            kind: grant.kind,
            status: grant.status,
            destination:
              grant.kind === "publish"
                ? (grant.accountLabel ?? "an account")
                : `${grant.reviewerCount} reviewer${grant.reviewerCount === 1 ? "" : "s"}`,
            expiresAt: grant.expiresAt,
          },
        ]
      : [],
  );
}

/** `GET /api/automation`: the Autopilot page's reads, in parallel, with the facts its controls depend on. */
export async function readAutomation(deps: ReadDeps, actor: BrowserActorScope): Promise<AutomationOverview> {
  const zoomEnabled = deps.zoomConfigured();
  const [rules, recipes, grants, zoomConnections] = await Promise.all([
    deps.autopilotService.listRules(actor),
    deps.recipeService.list(actor),
    deps.standingGrants.list(actor),
    zoomEnabled ? deps.zoomService.listConnections(actor) : Promise.resolve([]),
  ]);
  const { workspace } = actor;
  // Active and running rules hold a slot; paused or failed ones don't.
  const activeRules = rules.filter((rule) => rule.status === "active" || rule.status === "running").length;
  const requirement = planCountRequirement(workspace.pricingTier, "autopilotRules", activeRules);
  const canEdit = workspaceAllowsCapability(workspace, "content.edit");
  return {
    rules,
    recipes,
    grants: summarizeGrants(grants),
    zoomEnabled,
    zoomConnections,
    newRuleRequirement: requirement?.message ?? null,
    newRuleUpgradeTier: requirement?.requiredTier ?? null,
    autopilotIncluded: hasFeature(workspace.pricingTier, "automation.autopilot"),
    finishingAvailable: hasFeature(workspace.pricingTier, "campaign.operations"),
    workspaceStatus: workspace.status,
    access: {
      canEdit,
      canRun: workspaceAllowsCapability(workspace, "processing.consume"),
      canTakeOver: workspaceAllowsCapability(workspace, "workspace.manage"),
      canConnectZoom: canEdit,
      canManageBilling: workspace.role === "owner",
    },
  };
}

/** `GET /api/automation/standing-grants`: the grants page's reads, in parallel. */
export async function readStandingGrants(deps: ReadDeps, actor: BrowserActorScope): Promise<StandingGrantsOverview> {
  const [grants, rules, accounts] = await Promise.all([
    deps.standingGrants.list(actor),
    deps.autopilotService.listRules(actor),
    deps.socialOAuthService.listAccounts(actor),
  ]);
  const { workspace } = actor;
  return {
    grants,
    rules: rules.map(({ id, name }) => ({ id, name })),
    // TikTok needs the creator's choices on every post, so it can't hold a grant;
    // nor can an account the plan doesn't publish to.
    accounts: accounts
      .filter((account) => account.status === "active" && account.publishingEligible && account.platform !== "tiktok")
      .map(
        ({ id, displayName, handle, platform }): GrantAccountOption => ({
          id,
          label: `${displayName}${handle ? ` (${handle})` : ""}`,
          platform,
        }),
      ),
    canManage: workspaceAllowsCapability(workspace, "workspace.manage"),
    reviewAvailable: hasFeature(workspace.pricingTier, "review.rooms"),
    autopilotIncluded: hasFeature(workspace.pricingTier, "automation.autopilot"),
    pricingTier: workspace.pricingTier,
  };
}

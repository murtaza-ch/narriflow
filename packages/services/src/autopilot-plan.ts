import type { Prisma } from "@prisma/client";
import { lowestTierWithFeature, PLAN_CATALOG } from "@narriflow/validators";
import { hasFeature, planLimits, requirePlanFeature, requireWithinPlanLimit } from "./plan-features";

/**
 * Autopilot plan rules, shared by RSS and Zoom rules.
 *
 * A rule that is active or running holds one of the plan's `autopilotRules`
 * slots. When a plan runs fewer rules than are active (after a downgrade), the
 * oldest by `createdAt`, then `id`, keep running and the pollers pause the rest
 * with pause kind `plan`. Paused and failed rules stay readable and editable.
 */

type RuleReader = Pick<Prisma.TransactionClient, "autopilotRule" | "workspace">;

export const ACTIVE_AUTOPILOT_RULE_STATUSES = ["active", "running"] as const;

export function holdsAutopilotSlot(status: string) {
	return (ACTIVE_AUTOPILOT_RULE_STATUSES as readonly string[]).includes(status);
}

/** Serializes the Workspace's active-rule count with the write it admits. */
export async function lockWorkspaceAutopilotRules(tx: Prisma.TransactionClient, workspaceId: string) {
	const key = `autopilot_rules:${workspaceId}`;
	await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0)) IS NULL AS "locked"`;
}

/**
 * Admits one more active rule: the plan must include Autopilot and have a free
 * slot besides `ruleId`'s own. Call under `lockWorkspaceAutopilotRules`.
 */
export async function requireAutopilotRuleSlot(
	tx: Prisma.TransactionClient,
	input: { workspaceId: string; tier: string | null | undefined; ruleId?: string },
) {
	requirePlanFeature(input.tier, "automation.autopilot");
	const active = await tx.autopilotRule.count({
		where: {
			workspaceId: input.workspaceId,
			status: { in: [...ACTIVE_AUTOPILOT_RULE_STATUSES] },
			...(input.ruleId ? { id: { not: input.ruleId } } : {}),
		},
	});
	requireWithinPlanLimit(input.tier, "autopilotRules", active);
}

/**
 * Why the Workspace's current plan does not run this rule now, or null. The
 * pollers read it before fetching a feed or importing a recording, so a rule
 * the plan no longer covers pauses once instead of failing every episode.
 */
export async function autopilotPlanPauseReason(
	db: RuleReader,
	rule: { id: string; workspaceId: string },
): Promise<string | null> {
	const workspace = await db.workspace.findUnique({ where: { id: rule.workspaceId }, select: { pricingTier: true } });
	const tier = workspace?.pricingTier ?? null;
	if (!hasFeature(tier, "automation.autopilot")) {
		const required = lowestTierWithFeature("automation.autopilot");
		return `Autopilot needs the ${required ? PLAN_CATALOG[required].name : "a higher"} plan. This rule is paused; change the plan, then turn it back on.`;
	}
	const max = planLimits(tier).autopilotRules;
	const running = await db.autopilotRule.findMany({
		where: { workspaceId: rule.workspaceId, status: { in: [...ACTIVE_AUTOPILOT_RULE_STATUSES] } },
		orderBy: [{ createdAt: "asc" }, { id: "asc" }],
		take: max,
		select: { id: true },
	});
	if (running.some((candidate) => candidate.id === rule.id)) return null;
	return `This plan runs ${max} active Autopilot ${max === 1 ? "rule" : "rules"}, and older rules use them. Pause or delete another rule, then turn this one back on.`;
}

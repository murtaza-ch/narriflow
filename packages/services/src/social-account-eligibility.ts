import type { Prisma } from "@prisma/client";
import { lowestTier, PLAN_CATALOG, resolvePricingTier } from "@narriflow/validators";
import {
	hasFeature,
	planLimits,
	PlanRequirementError,
	requirePlanFeature,
} from "./plan-features";

/**
 * Social Destination plan rules, shared by every path that connects an account
 * or publishes to one.
 *
 * Every connected account that is not revoked holds one of the plan's
 * `socialDestinations` slots, across providers. On a plan with fewer slots than
 * accounts (after a downgrade), the oldest accounts by `createdAt`, then `id`,
 * may publish and the rest are plan-ineligible; their tokens stay. Disconnecting
 * an older account makes the next one eligible.
 */

type SocialAccountReader = Pick<Prisma.TransactionClient, "socialAccount">;
type WorkspacePlanReader = Pick<Prisma.TransactionClient, "socialAccount" | "workspace">;

/** Accounts in these states hold a slot. Revocation frees it. */
export const SOCIAL_DESTINATION_SLOT_WHERE = { status: { not: "revoked" } } as const satisfies Prisma.SocialAccountWhereInput;

/** Serializes account connection per Workspace, so a count and the write it admits commit together. */
export async function lockWorkspaceSocialAccounts(tx: Prisma.TransactionClient, workspaceId: string) {
	const key = `social_destinations:${workspaceId}`;
	await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0)) IS NULL AS "locked"`;
}

/**
 * The accounts of `accounts` that may publish on `tier`: none without
 * `publishing.schedule`, otherwise the oldest up to the plan's slot count.
 * `accounts` must be the Workspace's slot-holding accounts.
 */
export function publishableSocialAccountIds(
	tier: string | null | undefined,
	accounts: ReadonlyArray<{ id: string; createdAt: Date }>,
): Set<string> {
	if (!hasFeature(tier, "publishing.schedule")) return new Set();
	const ordered = [...accounts].sort((left, right) =>
		left.createdAt.getTime() - right.createdAt.getTime() || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
	return new Set(ordered.slice(0, planLimits(tier).socialDestinations).map((account) => account.id));
}

/** Reads the Workspace's slot-holding accounts and returns the ones that may publish on `tier`. */
export async function readPublishableSocialAccountIds(
	db: SocialAccountReader,
	workspaceId: string,
	tier: string | null | undefined,
): Promise<{ eligible: Set<string>; used: number }> {
	const accounts = await db.socialAccount.findMany({
		where: { workspaceId, ...SOCIAL_DESTINATION_SLOT_WHERE },
		select: { id: true, createdAt: true },
	});
	return { eligible: publishableSocialAccountIds(tier, accounts), used: accounts.length };
}

/**
 * Refuses unless the Workspace's plan includes publishing and `accountId` is
 * one of its publishable accounts. Account existence, status, and platform are
 * the caller's own checks.
 */
export async function requirePublishableSocialAccount(
	db: SocialAccountReader,
	input: { workspaceId: string; accountId: string; tier: string | null | undefined },
): Promise<void> {
	requirePlanFeature(input.tier, "publishing.schedule");
	const { eligible, used } = await readPublishableSocialAccountIds(db, input.workspaceId, input.tier);
	if (eligible.has(input.accountId)) return;
	throw socialAccountBeyondPlanError(input.tier, used);
}

/** The refusal for an account the plan's slot count leaves out. */
export function socialAccountBeyondPlanError(tier: string | null | undefined, used: number) {
	const currentTier = resolvePricingTier(tier);
	const max = PLAN_CATALOG[currentTier].limits.socialDestinations;
	const requiredTier = lowestTier((plan) => plan.features["publishing.schedule"] && plan.limits.socialDestinations >= used);
	return new PlanRequirementError({
		code: "plan_limit_reached",
		message: `This plan publishes to its ${max} oldest connected social accounts. Disconnect an older account to publish to this one.`,
		currentTier,
		requiredTier,
		limit: "socialDestinations",
		used,
		max,
	});
}

/** Whether a frozen post carries a custom thumbnail (any thumbnail selection freezes its asset). */
export function hasCustomThumbnail(providerSettings: Prisma.JsonObject) {
	return typeof providerSettings.thumbnailAssetId === "string";
}

/**
 * The worker's check immediately before a post's first provider submission:
 * why the Workspace's current plan does not let it go out, or null.
 */
export async function publicationPlanRefusal(
	db: WorkspacePlanReader,
	input: { workspaceId: string; socialAccountId: string | null; customThumbnail: boolean },
): Promise<"publication_plan_required" | "publication_account_beyond_plan" | "publication_thumbnail_plan_required" | null> {
	const workspace = await db.workspace.findUnique({ where: { id: input.workspaceId }, select: { pricingTier: true } });
	const tier = workspace?.pricingTier ?? null;
	if (!hasFeature(tier, "publishing.schedule")) return "publication_plan_required";
	// The post was frozen with its thumbnail; it is never sent without it.
	if (input.customThumbnail && !hasFeature(tier, "publishing.customThumbnails")) return "publication_thumbnail_plan_required";
	if (!input.socialAccountId) return null;
	const { eligible } = await readPublishableSocialAccountIds(db, input.workspaceId, tier);
	return eligible.has(input.socialAccountId) ? null : "publication_account_beyond_plan";
}

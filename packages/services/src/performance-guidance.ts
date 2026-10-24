import { Prisma, type PrismaClient } from "@prisma/client";
import {
	clipCategorySchema,
	PERFORMANCE_GUIDANCE_DIMENSIONS,
	performanceGuidanceSchema,
	type ClipCategory,
	type ClipFacts,
	type FinishingRanking,
	type PerformanceGuidance,
	type PerformanceGuidanceDimension,
	type PerformanceGuidanceGroup,
	type SocialPlatform,
} from "@narriflow/validators";
import {
	categoryLabel,
	durationBandKey,
	durationBandLabel,
	readComparedVideos,
	type PerformanceVideo,
} from "./performance-summary";

/**
 * Performance Guidance: what tends to work for one Workspace's audience.
 * About nightly, a Workspace's recent videos (compared at 7 days, grouped by
 * the clip facts frozen when each was first tracked) are reduced to a lift per
 * category and length band. Each video's views are first divided by its own
 * platform's median, so platforms with very different audiences are never
 * pooled; a group's lift is the median of those ratios, pulled toward 1 by how
 * few clips it has. Moment detection gets one line naming the strongest and
 * weakest groups; Finishing multiplies each clip's score by a bounded factor
 * made from its groups' lifts. Hook strength is not a group: it is already part
 * of the score being nudged. It never changes the scoring scale, and the same
 * data always gives the same guidance.
 */

/** A platform needs this many measured posts before its views are a usable yardstick. */
export const MINIMUM_GUIDANCE_PLATFORM_POSTS = 10;
/** A group needs this many distinct clips before its lift is trusted. */
export const MINIMUM_GUIDANCE_GROUP_POSTS = 10;
/** The Workspace needs this many distinct clips, with clip facts and a 7-day reading, before any guidance. */
export const MINIMUM_GUIDANCE_WORKSPACE_POSTS = 30;
/** Only videos published this recently count, so old taste does not outvote new. */
export const GUIDANCE_WINDOW_DAYS = 180;
/** A lift is pulled toward 1 as n / (n + this), n being the group's distinct clips. */
export const GUIDANCE_SHRINKAGE_CLIPS = 20;
/** Finishing never moves a clip's score by more than this, either way. */
export const MINIMUM_LIFT_FACTOR = 0.8;
export const MAXIMUM_LIFT_FACTOR = 1.25;
/** A clip may only be ranked ahead of another whose plain score is no more than this far above it. */
export const MAXIMUM_REORDER_SCORE_GAP = 15;
/** Guidance is computed again once the last attempt is this old; the worker looks about every 15 minutes. */
export const GUIDANCE_REFRESH_MS = 24 * 60 * 60 * 1000;

const DIMENSIONS = Object.keys(PERFORMANCE_GUIDANCE_DIMENSIONS) as PerformanceGuidanceDimension[];
const round = (value: number, places: number) => {
	const scale = 10 ** places;
	return Math.round(value * scale) / scale;
};
const byText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/** The exact median; `summarizePerformance`'s own rounds to whole views. */
function exactMedian(values: number[]) {
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

// --- Computing ---------------------------------------------------------------

/** `clip` tells one clip's videos apart: a clip posted to several platforms counts once toward a threshold. */
export type GuidanceVideo = PerformanceVideo & { clip: string };

/**
 * Pure. Only videos with frozen clip facts count, because only they can be
 * grouped, and only on a platform with enough measured posts to be a yardstick
 * (and a non-zero median to divide by). Below the Workspace threshold `groups`
 * is empty.
 */
export function computePerformanceGuidance(videos: GuidanceVideo[]): PerformanceGuidance {
	const measured = videos.filter((video): video is GuidanceVideo & { facts: ClipFacts } => video.facts !== null);
	const perPlatform = new Map<SocialPlatform, Array<GuidanceVideo & { facts: ClipFacts }>>();
	for (const video of measured) perPlatform.set(video.platform, [...(perPlatform.get(video.platform) ?? []), video]);

	const platforms = [...perPlatform]
		.map(([platform, posts]) => ({ platform, posts, typical: exactMedian(posts.map((post) => post.views)) }))
		.filter(({ posts, typical }) => posts.length >= MINIMUM_GUIDANCE_PLATFORM_POSTS && typical > 0)
		.sort((left, right) => byText(left.platform, right.platform));
	const observations = platforms.flatMap(({ posts, typical }) =>
		posts.map((post) => ({ clip: post.clip, ratio: post.views / typical, facts: post.facts })),
	);
	const totalPosts = new Set(observations.map((observation) => observation.clip)).size;
	const result: PerformanceGuidance = {
		totalPosts,
		platforms: platforms.map(({ platform, posts, typical }) => ({ platform, posts: posts.length, medianViews: Math.round(typical) })),
		groups: [],
	};
	if (totalPosts < MINIMUM_GUIDANCE_WORKSPACE_POSTS) return result;

	const keyOf: Record<PerformanceGuidanceDimension, (facts: ClipFacts) => string | undefined> = {
		category: (facts) => facts.category,
		duration: (facts) => durationBandKey(facts.durationSec),
	};
	result.groups = DIMENSIONS.flatMap((dimension) => {
		const grouped = new Map<string, typeof observations>();
		for (const observation of observations) {
			const key = keyOf[dimension](observation.facts);
			if (key) grouped.set(key, [...(grouped.get(key) ?? []), observation]);
		}
		return [...grouped]
			.sort(([left], [right]) => byText(left, right))
			.flatMap(([key, group]) => {
				const clips = new Set(group.map((observation) => observation.clip)).size;
				if (clips < MINIMUM_GUIDANCE_GROUP_POSTS) return [];
				const raw = exactMedian(group.map((observation) => observation.ratio));
				const lift = 1 + (raw - 1) * (clips / (clips + GUIDANCE_SHRINKAGE_CLIPS));
				return [{ dimension, key, posts: clips, lift: round(lift, 2) }];
			});
	});
	return result;
}

/** True when the guidance has anything to say. */
export const guidanceQualifies = (guidance: PerformanceGuidance) => guidance.groups.length > 0;

/**
 * The name of a stored group, built from its dimension and key, or null for a
 * key this code does not know. Stored text is never trusted for display.
 */
export function guidanceGroupLabel(group: Pick<PerformanceGuidanceGroup, "dimension" | "key">): string | null {
	if (group.dimension === "category") return clipCategorySchema.safeParse(group.key).success ? categoryLabel(group.key) : null;
	return durationBandLabel(group.key);
}

export type LabelledGuidanceGroup = PerformanceGuidanceGroup & { label: string };

/** Strongest first; ties keep the dimension order, then the key. Unknown keys are dropped. */
export function labelledGroupsByLift(guidance: PerformanceGuidance): LabelledGuidanceGroup[] {
	return guidance.groups
		.flatMap((group) => {
			const label = guidanceGroupLabel(group);
			return label ? [{ ...group, label }] : [];
		})
		.sort(
			(left, right) =>
				right.lift - left.lift ||
				DIMENSIONS.indexOf(left.dimension) - DIMENSIONS.indexOf(right.dimension) ||
				byText(left.key, right.key),
		);
}

// --- Moment detection ----------------------------------------------------------

const describeGroup = (group: LabelledGuidanceGroup) =>
	`${PERFORMANCE_GUIDANCE_DIMENSIONS[group.dimension]} ${group.label} ${round(group.lift, 2)}x`;

/**
 * The one line added to the moment-detection prompt: the top two groups and
 * the bottom one, with their lifts. Null when there is nothing to say. The
 * bottom group is named only when it is not already one of the top two, so a
 * Workspace with two qualifying groups gets no "weakest".
 */
export function guidancePromptLine(guidance: PerformanceGuidance | null): string | null {
	if (!guidance || !guidanceQualifies(guidance)) return null;
	const ranked = labelledGroupsByLift(guidance);
	if (ranked.length === 0) return null;
	const best = ranked.slice(0, 2).map(describeGroup).join(", ");
	const worst = ranked.length > 2 ? `; weakest ${describeGroup(ranked[ranked.length - 1]!)}` : "";
	return `- Audience data (7-day views relative to a typical post on the same platform, among ${guidance.totalPosts} clips you posted from Narriflow): strongest ${best}${worst}. Use it only to break ties between similarly strong moments, and score every moment on the same scale as usual.`;
}

// --- Finishing -----------------------------------------------------------------

export type RankableClip = {
	index: number;
	viralityScore: number;
	category: ClipCategory;
	/** The clip's length as it is exported (`clipExportDurationSec`), the measure its clip facts use. */
	durationSec: number;
};

/** The guidance finishing applies, with when it was computed. */
export type AppliedGuidance = { guidance: PerformanceGuidance; computedAt: Date };

/**
 * A clip's bounded factor: the mean lift of the qualifying groups it falls in,
 * held between 0.8 and 1.25. A clip in no qualifying group keeps factor 1.
 */
export function liftFactor(clip: Pick<RankableClip, "category" | "durationSec">, guidance: PerformanceGuidance) {
	const keys: Record<PerformanceGuidanceDimension, string | undefined> = {
		category: clip.category,
		duration: durationBandKey(clip.durationSec),
	};
	const groups = labelledGroupsByLift(guidance).filter((group) => keys[group.dimension] === group.key);
	if (groups.length === 0) return { factor: 1, groups: [] };
	const mean = groups.reduce((sum, group) => sum + group.lift, 0) / groups.length;
	return {
		factor: round(Math.min(MAXIMUM_LIFT_FACTOR, Math.max(MINIMUM_LIFT_FACTOR, mean)), 3),
		groups,
	};
}

/**
 * Pure. Orders clips for finishing. Without guidance that is the plain score,
 * then detection order. With it, the next clip chosen is the one with the
 * highest score times factor among those within 15 points of the best plain
 * score still waiting, so a bounded factor can reorder close scores but a clip
 * never overtakes one more than 15 points above it. A ranking is returned only
 * when guidance was applied, so the caller can record the factors it used.
 */
export function rankClips<T extends RankableClip>(
	clips: T[],
	applied: AppliedGuidance | null,
): Array<{ clip: T; ranking: FinishingRanking | null }> {
	const waiting = clips
		.map((clip) => {
			if (!applied) return { clip, adjusted: clip.viralityScore, ranking: null };
			const { factor, groups } = liftFactor(clip, applied.guidance);
			return {
				clip,
				adjusted: clip.viralityScore * factor,
				ranking: {
					score: clip.viralityScore,
					factor,
					groups: groups.map((group) => ({
						dimension: group.dimension,
						label: `${PERFORMANCE_GUIDANCE_DIMENSIONS[group.dimension]} ${group.label}`,
						lift: group.lift,
					})),
					guidanceComputedAt: applied.computedAt.toISOString(),
				} satisfies FinishingRanking,
			};
		})
		.sort((left, right) => right.clip.viralityScore - left.clip.viralityScore || left.clip.index - right.clip.index);

	const ranked: Array<{ clip: T; ranking: FinishingRanking | null }> = [];
	while (waiting.length > 0) {
		const window = waiting[0]!.clip.viralityScore - MAXIMUM_REORDER_SCORE_GAP;
		let best = 0;
		// `waiting` is in plain order, so a tie keeps the plain winner.
		for (let next = 1; next < waiting.length && waiting[next]!.clip.viralityScore >= window; next += 1) {
			if (waiting[next]!.adjusted > waiting[best]!.adjusted) best = next;
		}
		const [chosen] = waiting.splice(best, 1);
		ranked.push({ clip: chosen!.clip, ranking: chosen!.ranking });
	}
	return ranked;
}

// --- Storing and reading ---------------------------------------------------------

/** A Date as the UTC `timestamp` the tables store, whatever the session zone. */
const utc = (date: Date) => Prisma.sql`(${date.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;

type StoredRow = { computedAt: Date; totalPosts: number; platforms: unknown; groups: unknown };

/** The stored guidance as this code reads it: groups whose key it no longer knows are dropped. */
function parseStored(row: StoredRow | null | undefined): { guidance: PerformanceGuidance; computedAt: Date } | null {
	if (!row) return null;
	const parsed = performanceGuidanceSchema.safeParse({ totalPosts: row.totalPosts, platforms: row.platforms, groups: row.groups });
	if (!parsed.success) return null;
	const groups = parsed.data.groups.filter((group) => guidanceGroupLabel(group) !== null);
	return { guidance: { ...parsed.data, groups }, computedAt: row.computedAt };
}

/**
 * The guidance in force for a Workspace, or null: the Workspace switched it
 * off, or it has not qualified (never computed, too few clips, or a stored
 * shape this code no longer reads).
 */
export async function readAppliedGuidance(
	prisma: Pick<PrismaClient, "workspace">,
	workspaceId: string,
): Promise<AppliedGuidance | null> {
	const row = await prisma.workspace.findUnique({
		where: { id: workspaceId },
		select: { usePerformanceGuidance: true, performanceGuidance: true },
	});
	if (!row || row.usePerformanceGuidance === false) return null;
	const stored = parseStored(row.performanceGuidance);
	return stored && guidanceQualifies(stored.guidance) ? stored : null;
}

/** What the "What worked" page says about the Workspace's guidance. */
export type GuidanceView = {
	/** The Workspace setting, resolved: on unless switched off. */
	enabled: boolean;
	/** The stored guidance has something to say. */
	qualifies: boolean;
	/** Moment detection and finishing are using it now. */
	applied: boolean;
	computedAt: string | null;
	/** Distinct clips counted at the last computation; null before the first. */
	totalPosts: number | null;
	/** A typical post at 7 days on each measured platform. */
	platforms: PerformanceGuidance["platforms"];
	/** Strongest first. */
	groups: LabelledGuidanceGroup[];
	minimumWorkspacePosts: number;
	minimumGroupPosts: number;
	minimumPlatformPosts: number;
	windowDays: number;
	minimumFactor: number;
	maximumFactor: number;
	maximumScoreGap: number;
};

export async function readGuidanceView(
	prisma: Pick<PrismaClient, "workspace">,
	workspaceId: string,
): Promise<GuidanceView> {
	const row = await prisma.workspace.findUnique({
		where: { id: workspaceId },
		select: { usePerformanceGuidance: true, performanceGuidance: true },
	});
	const enabled = row?.usePerformanceGuidance !== false;
	const stored = parseStored(row?.performanceGuidance);
	const qualifies = Boolean(stored && guidanceQualifies(stored.guidance));
	return {
		enabled,
		qualifies,
		applied: enabled && qualifies,
		computedAt: qualifies && stored ? stored.computedAt.toISOString() : null,
		totalPosts: stored?.guidance.totalPosts ?? null,
		platforms: stored?.guidance.platforms ?? [],
		groups: stored ? labelledGroupsByLift(stored.guidance) : [],
		minimumWorkspacePosts: MINIMUM_GUIDANCE_WORKSPACE_POSTS,
		minimumGroupPosts: MINIMUM_GUIDANCE_GROUP_POSTS,
		minimumPlatformPosts: MINIMUM_GUIDANCE_PLATFORM_POSTS,
		windowDays: GUIDANCE_WINDOW_DAYS,
		minimumFactor: MINIMUM_LIFT_FACTOR,
		maximumFactor: MAXIMUM_LIFT_FACTOR,
		maximumScoreGap: MAXIMUM_REORDER_SCORE_GAP,
	};
}

export interface PerformanceGuidanceDependencies {
	prisma: PrismaClient;
	now?: () => Date;
}

/**
 * The Workspace's guidance, kept fresh. `refreshStale` computes it for
 * Workspaces with enough tracked videos whose last attempt is missing or a day
 * old, oldest first, so every Workspace is recomputed about nightly without all
 * of them at once. A Workspace whose computation fails is stamped as attempted
 * and waits a day like the rest, so it cannot hold up the others. Two workers
 * computing the same Workspace write the same numbers.
 */
export function createPerformanceGuidance(dependencies: PerformanceGuidanceDependencies) {
	const { prisma } = dependencies;
	const now = dependencies.now ?? (() => new Date());

	async function refresh(workspaceId: string): Promise<PerformanceGuidance> {
		const at = now();
		const since = new Date(at.getTime() - GUIDANCE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
		const { measured } = await readComparedVideos(prisma, workspaceId, { since });
		const guidance = computePerformanceGuidance(measured);
		const data = {
			computedAt: at,
			attemptedAt: at,
			totalPosts: guidance.totalPosts,
			platforms: guidance.platforms as Prisma.InputJsonValue,
			groups: guidance.groups as Prisma.InputJsonValue,
		};
		await prisma.performanceGuidance.upsert({
			where: { workspaceId },
			create: { workspaceId, ...data },
			update: data,
		});
		return guidance;
	}

	/** Records a failed try without touching what was last computed. */
	async function markAttempted(workspaceId: string) {
		const at = now();
		await prisma.performanceGuidance.upsert({
			where: { workspaceId },
			create: { workspaceId, computedAt: at, attemptedAt: at, totalPosts: 0, platforms: [], groups: [] },
			update: { attemptedAt: at },
		});
	}

	return {
		refresh,
		async refreshStale(limit = 20): Promise<number> {
			const at = now();
			// The count stops at the threshold, so a Workspace with thousands of
			// videos costs no more than one with thirty.
			const stale = await prisma.$queryRaw<Array<{ workspaceId: string }>>`
				SELECT w."id" AS "workspaceId"
				FROM "Workspace" w
				LEFT JOIN "PerformanceGuidance" g ON g."workspaceId" = w."id"
				WHERE (g."attemptedAt" IS NULL OR g."attemptedAt" <= ${utc(new Date(at.getTime() - GUIDANCE_REFRESH_MS))})
					AND (SELECT COUNT(*) FROM (
						SELECT 1 FROM "TrackedVideo" tv WHERE tv."workspaceId" = w."id" LIMIT ${MINIMUM_GUIDANCE_WORKSPACE_POSTS}
					) capped) >= ${MINIMUM_GUIDANCE_WORKSPACE_POSTS}
				ORDER BY g."attemptedAt" ASC NULLS FIRST, w."id"
				LIMIT ${limit}`;
			let refreshed = 0;
			for (const { workspaceId } of stale) {
				try {
					await refresh(workspaceId);
					refreshed += 1;
				} catch (error) {
					console.warn(
						JSON.stringify({
							level: "error",
							message: "performance_guidance_refresh_failed",
							workspaceId,
							error: error instanceof Error ? error.message : "Unknown error",
						}),
					);
					await markAttempted(workspaceId).catch(() => {});
				}
			}
			return refreshed;
		},
		/** The moment-detection line for a Workspace, or null. */
		async promptLine(workspaceId: string): Promise<string | null> {
			const applied = await readAppliedGuidance(prisma, workspaceId);
			return guidancePromptLine(applied?.guidance ?? null);
		},
	};
}

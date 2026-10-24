import { z } from "zod";
import { clipCategorySchema } from "./clip";
import { socialPlatformSchema } from "./social";

/**
 * Clip facts: the frozen snapshot of what a clip was when its published video
 * was first measured. "What worked" groups by these after the Project is gone,
 * so they carry raw values; bands are derived when read.
 */
export const clipFactsSchema = z.strictObject({
	viralityScore: z.number().int().min(0),
	category: clipCategorySchema,
	hookStrengthScore: z.number().int().min(0),
	durationSec: z.number().nonnegative(),
	aspectRatio: z.enum(["9:16", "1:1", "16:9", "4:5"]),
	platform: socialPlatformSchema,
	/** Hour of day (0 to 23) the video was posted, in the Workspace time zone. */
	postedHour: z.number().int().min(0).max(23),
});
export type ClipFacts = z.infer<typeof clipFactsSchema>;

/**
 * Which platforms Narriflow reads counts back from. Facebook Reels is typed as
 * unavailable: Meta's `video_insights` reference requires `read_insights` and
 * `pages_manage_engagement`, which the Facebook grant doesn't request
 * (`pages_read_engagement` alone doesn't cover it). The rest need another
 * scope, a vetted API, or billing per read.
 */
export const PERFORMANCE_SYNC_SUPPORT = {
	youtube_shorts: { available: true },
	tiktok: { available: true },
	facebook_reels: { available: false, reason: "insights_scopes_required" },
	instagram_reels: { available: false, reason: "insights_scope_required" },
	linkedin: { available: false, reason: "no_vetted_api" },
	x: { available: false, reason: "billed_per_read" },
} as const satisfies Record<
	z.infer<typeof socialPlatformSchema>,
	{ available: boolean; reason?: string }
>;

export function performanceSyncAvailable(
	platform: z.infer<typeof socialPlatformSchema>,
) {
	return PERFORMANCE_SYNC_SUPPORT[platform].available;
}

/**
 * The groupings Performance Guidance compares, in the order it lists them.
 * Hook strength is left out on purpose: it is already 30% of the virality
 * score the guidance would be nudging, so feeding it back would count it twice.
 */
export const PERFORMANCE_GUIDANCE_DIMENSIONS = {
	category: "Category",
	duration: "Length",
} as const;
export type PerformanceGuidanceDimension =
	keyof typeof PERFORMANCE_GUIDANCE_DIMENSIONS;

/**
 * Performance Guidance: what tends to work for one Workspace's audience,
 * computed about nightly from the Workspace's recent Tracked Videos (frozen
 * Clip Facts and 7-day counts). Each video's views are first divided by its own
 * platform's median, so a platform with a 10x audience never drowns another.
 * `lift` is a group's median of those ratios, pulled toward 1 by the group's
 * size, rounded to two places. `posts` counts distinct clips, not videos.
 * `groups` holds only groups with enough clips to trust, and is empty until the
 * Workspace has enough clips overall. Labels are not stored: they are rebuilt
 * from `dimension` and `key` when read.
 */
export const performanceGuidanceSchema = z.strictObject({
	/** Distinct clips with Clip Facts and a 7-day reading on a measured platform. */
	totalPosts: z.number().int().nonnegative(),
	/** The platforms with enough posts to measure, and a typical post on each. */
	platforms: z.array(
		z.strictObject({
			platform: socialPlatformSchema,
			posts: z.number().int().positive(),
			medianViews: z.number().int().positive(),
		}),
	),
	groups: z.array(
		z.strictObject({
			dimension: z.enum(["category", "duration"]),
			key: z.string().min(1),
			posts: z.number().int().positive(),
			lift: z.number().nonnegative(),
		}),
	),
});
export type PerformanceGuidance = z.infer<typeof performanceGuidanceSchema>;
export type PerformanceGuidanceGroup = PerformanceGuidance["groups"][number];

import type { SocialPostMetricsSnapshot } from "@narriflow/validators";

type Counts = Pick<SocialPostMetricsSnapshot, "views" | "likes" | "comments" | "shares">;

const compact = new Intl.NumberFormat("en-US", {
	notation: "compact",
	maximumFractionDigits: 1,
});

/** 1,482,310 reads as 1.5M; small counts stay exact. */
export function formatCount(value: number) {
	return compact.format(value);
}

/**
 * "1.2K views · 56 likes", leaving out a count the platform doesn't report.
 * Zero is a real count and is kept.
 */
export function describeCounts(counts: Counts) {
	const parts = (
		[
			["view", counts.views],
			["like", counts.likes],
			["comment", counts.comments],
			["share", counts.shares],
		] as const
	).flatMap(([noun, value]) =>
		value === null ? [] : [`${formatCount(value)} ${noun}${value === 1 ? "" : "s"}`],
	);
	return parts.join(" · ");
}

/** The latest counts of several posts added together, such as every post of one clip. */
export function sumLatestCounts(
	posts: Array<{ latestMetrics: SocialPostMetricsSnapshot | null }>,
): Counts | null {
	const measured = posts.flatMap((post) => (post.latestMetrics ? [post.latestMetrics] : []));
	if (measured.length === 0) return null;
	const total = (key: keyof Counts) => {
		const values = measured.flatMap((counts) => (counts[key] === null ? [] : [counts[key]]));
		return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
	};
	return {
		views: total("views"),
		likes: total("likes"),
		comments: total("comments"),
		shares: total("shares"),
	};
}

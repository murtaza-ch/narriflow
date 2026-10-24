import type { Prisma, PrismaClient } from "@prisma/client";
import {
	clipFactsSchema,
	type ClipFacts,
	type SocialPlatform,
	type SocialPostMetricsSnapshot,
} from "@narriflow/validators";
import { COMPARISON_SLOT } from "./performance-sync";

/** The newest captured reading of each Tracked Video, as Social Post reads select it. */
export const latestCaptureInclude = {
	select: {
		captures: {
			where: { state: "captured" },
			orderBy: { capturedAt: "desc" },
			take: 1,
			select: {
				views: true,
				likes: true,
				comments: true,
				shares: true,
				saves: true,
				watchTimeSeconds: true,
				capturedAt: true,
			},
		},
	},
} as const satisfies Prisma.SocialPost$trackedVideosArgs;

type CountKey = "views" | "likes" | "comments" | "shares" | "saves" | "watchTimeSeconds";
export type CaptureCounts = Record<CountKey, number | null> & {
	capturedAt: Date | null;
};
export type LatestCaptures = { captures: CaptureCounts[] };

const COUNT_KEYS: CountKey[] = [
	"views",
	"likes",
	"comments",
	"shares",
	"saves",
	"watchTimeSeconds",
];

/**
 * One post's latest counts: the newest capture of each of its videos, summed.
 * A TikTok upload can yield several public videos; every other post has one.
 * A count no video reports stays null.
 */
export function combineLatestCaptures(
	videos: LatestCaptures[],
): SocialPostMetricsSnapshot | null {
	const latest = videos.flatMap((video) => {
		const capture = video.captures[0];
		return capture?.capturedAt ? [{ ...capture, capturedAt: capture.capturedAt }] : [];
	});
	if (latest.length === 0) return null;
	const total = (key: CountKey) => {
		const reported = latest.flatMap((capture) => {
			const value = capture[key];
			return value === null ? [] : [value];
		});
		return reported.length ? reported.reduce((sum, value) => sum + value, 0) : null;
	};
	return {
		...(Object.fromEntries(COUNT_KEYS.map((key) => [key, total(key)])) as Record<
			CountKey,
			number | null
		>),
		capturedAt: new Date(
			Math.max(...latest.map((capture) => capture.capturedAt.getTime())),
		).toISOString(),
	};
}

/** At least this many measured videos before the view compares anything. */
export const MINIMUM_MEASURED_VIDEOS = 5;
/** A group with fewer videos than this is shown but marked as too small to trust. */
export const MINIMUM_GROUP_VIDEOS = 3;

export type PerformanceVideo = {
	platform: SocialPlatform;
	facts: ClipFacts | null;
	views: number;
	likes: number | null;
	comments: number | null;
};

export type PerformanceStat = { total: number; median: number };
export type PerformanceGroup = {
	key: string;
	label: string;
	videos: number;
	enough: boolean;
	views: PerformanceStat;
	likes: PerformanceStat | null;
	comments: PerformanceStat | null;
};
export type PerformanceDimensionId =
	| "category"
	| "hook"
	| "duration"
	| "platform"
	| "hour";
export type PerformanceSummary = {
	measuredVideos: number;
	/** Tracked videos still waiting for their first reading. */
	waitingVideos: number;
	enough: boolean;
	minimumVideos: number;
	minimumGroupVideos: number;
	totals: { views: number; likes: number; comments: number };
	dimensions: Array<{
		id: PerformanceDimensionId;
		title: string;
		groups: PerformanceGroup[];
	}>;
};

const HOOK_BANDS = [
	{ key: "below-60", label: "Below 60", test: (score: number) => score < 60 },
	{ key: "60-79", label: "60 to 79", test: (score: number) => score >= 60 && score < 80 },
	{ key: "80-plus", label: "80 and above", test: (score: number) => score >= 80 },
];

const DURATION_BANDS = [
	{ key: "under-20", label: "Under 20 seconds", test: (sec: number) => sec < 20 },
	{ key: "20-40", label: "20 to 40 seconds", test: (sec: number) => sec >= 20 && sec < 40 },
	{ key: "40-60", label: "40 to 60 seconds", test: (sec: number) => sec >= 40 && sec < 60 },
	{ key: "over-60", label: "Over 60 seconds", test: (sec: number) => sec >= 60 },
];

export function median(values: number[]) {
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2
		? sorted[middle]!
		: Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

/** The length band a clip of this many seconds falls in, and its name; null for a key that is no band. */
export const durationBandKey = (seconds: number) =>
	DURATION_BANDS.find((band) => band.test(seconds))?.key;
export const durationBandLabel = (key: string) =>
	DURATION_BANDS.find((band) => band.key === key)?.label ?? null;
export const categoryLabel = (category: string) =>
	category[0]!.toUpperCase() + category.slice(1);

function stat(values: number[]): PerformanceStat | null {
	return values.length
		? { total: values.reduce((sum, value) => sum + value, 0), median: median(values) }
		: null;
}

function hourLabel(hour: number) {
	const suffix = hour < 12 ? "AM" : "PM";
	return `${hour % 12 === 0 ? 12 : hour % 12} ${suffix}`;
}

function group(
	key: string,
	label: string,
	videos: PerformanceVideo[],
): PerformanceGroup {
	const reported = (pick: (video: PerformanceVideo) => number | null) =>
		videos.flatMap((video) => {
			const value = pick(video);
			return value === null ? [] : [value];
		});
	return {
		key,
		label,
		videos: videos.length,
		enough: videos.length >= MINIMUM_GROUP_VIDEOS,
		views: stat(videos.map((video) => video.views))!,
		likes: stat(reported((video) => video.likes)),
		comments: stat(reported((video) => video.comments)),
	};
}

function bucket(
	videos: PerformanceVideo[],
	keyOf: (video: PerformanceVideo) => { key: string; label: string } | null,
) {
	const buckets = new Map<string, { label: string; videos: PerformanceVideo[] }>();
	for (const video of videos) {
		const target = keyOf(video);
		if (!target) continue;
		const existing = buckets.get(target.key);
		if (existing) existing.videos.push(video);
		else buckets.set(target.key, { label: target.label, videos: [video] });
	}
	return buckets;
}

const byMedianViews = (left: PerformanceGroup, right: PerformanceGroup) =>
	right.views.median - left.views.median || right.videos - left.videos;

/**
 * Totals and medians of each video's latest counts, grouped by the clip facts
 * frozen at first capture. Videos with no facts (their clip was gone before the
 * first reading) still count in the totals and the platform group.
 */
export function summarizePerformance(
	videos: PerformanceVideo[],
	waitingVideos: number,
): PerformanceSummary {
	const bands = <T extends { key: string; label: string }>(
		defs: Array<T & { test: (value: number) => boolean }>,
		pick: (facts: ClipFacts) => number,
	) => {
		const grouped = bucket(videos, (video) => {
			if (!video.facts) return null;
			const value = pick(video.facts);
			return defs.find((def) => def.test(value)) ?? null;
		});
		return defs.flatMap((def) => {
			const found = grouped.get(def.key);
			return found ? [group(def.key, def.label, found.videos)] : [];
		});
	};
	const categories = bucket(videos, (video) =>
		video.facts
			? {
					key: video.facts.category,
					label: categoryLabel(video.facts.category),
				}
			: null,
	);
	const platforms = bucket(videos, (video) => ({
		key: video.platform,
		label: video.platform,
	}));
	const hours = bucket(videos, (video) =>
		video.facts
			? { key: String(video.facts.postedHour), label: hourLabel(video.facts.postedHour) }
			: null,
	);
	const summed = (pick: (video: PerformanceVideo) => number | null) =>
		videos.reduce((sum, video) => sum + (pick(video) ?? 0), 0);

	return {
		measuredVideos: videos.length,
		waitingVideos,
		enough: videos.length >= MINIMUM_MEASURED_VIDEOS,
		minimumVideos: MINIMUM_MEASURED_VIDEOS,
		minimumGroupVideos: MINIMUM_GROUP_VIDEOS,
		totals: {
			views: summed((video) => video.views),
			likes: summed((video) => video.likes),
			comments: summed((video) => video.comments),
		},
		dimensions: [
			{
				id: "category",
				title: "Category",
				groups: [...categories].map(([key, found]) => group(key, found.label, found.videos)).sort(byMedianViews),
			},
			{ id: "hook", title: "Hook strength", groups: bands(HOOK_BANDS, (facts) => facts.hookStrengthScore) },
			{ id: "duration", title: "Length", groups: bands(DURATION_BANDS, (facts) => facts.durationSec) },
			{
				id: "platform",
				title: "Platform",
				groups: [...platforms].map(([key, found]) => group(key, found.label, found.videos)).sort(byMedianViews),
			},
			{
				id: "hour",
				title: "Posted hour",
				groups: [...hours]
					.map(([key, found]) => group(key, found.label, found.videos))
					.sort((left, right) => Number(left.key) - Number(right.key)),
			},
		],
	};
}

/** The most recent videos "What worked" and Performance Guidance compare. */
const COMPARED_VIDEOS = 2_000;

/**
 * A Workspace's videos at the same age: each one's 7-day capture, with the
 * clip facts frozen when it was first tracked. A video still waiting for that
 * capture counts as waiting; one whose 7-day capture was skipped is left out.
 * It reads Tracked Videos, not Projects, so it still counts videos whose
 * Project was deleted. `since` leaves out videos published before it. Each
 * measured video carries `clip`, the clip it is of (a clip posted to several
 * platforms is several videos), or its own identity when that is not known.
 */
export async function readComparedVideos(
	prisma: Pick<PrismaClient, "trackedVideo">,
	workspaceId: string,
	options: { since?: Date } = {},
): Promise<{ measured: Array<PerformanceVideo & { clip: string }>; waiting: number }> {
	const rows = await prisma.trackedVideo.findMany({
		where: { workspaceId, ...(options.since ? { publishedAt: { gte: options.since } } : {}) },
		orderBy: { publishedAt: "desc" },
		take: COMPARED_VIDEOS,
		select: {
			id: true,
			clipId: true,
			platform: true,
			clipFacts: true,
			captures: {
				where: { slot: COMPARISON_SLOT },
				select: { state: true, views: true, likes: true, comments: true },
			},
		},
	});
	const measured: Array<PerformanceVideo & { clip: string }> = [];
	let waiting = 0;
	for (const row of rows) {
		const capture = row.captures[0];
		if (capture?.state === "captured" && capture.views !== null) {
			const facts = clipFactsSchema.safeParse(row.clipFacts);
			measured.push({
				clip: row.clipId ?? `video:${row.id}`,
				platform: row.platform,
				facts: facts.success ? facts.data : null,
				views: capture.views,
				likes: capture.likes,
				comments: capture.comments,
			});
		} else if (capture?.state === "scheduled") {
			waiting += 1;
		}
	}
	return { measured, waiting };
}

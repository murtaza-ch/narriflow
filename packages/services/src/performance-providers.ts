import { SOCIAL_PROVIDER_CAPABILITIES } from "@narriflow/validators";

/** Public counts for one video. A count the platform doesn't report is null. */
export type PlatformCounts = {
	views: number;
	likes: number | null;
	comments: number | null;
	shares: number | null;
	saves: number | null;
	watchTimeSeconds: number | null;
	/** The provider's metrics as returned, kept for the day Meta or Google renames one. */
	raw: Record<string, unknown>;
};

export type PlatformReadResult =
	/** `videos` holds only the IDs the platform returned; a deleted video is absent. */
	| { kind: "read"; apiVersion: string; videos: Map<string, PlatformCounts> }
	/** The token can't read counts: a person has to reconnect the account. */
	| { kind: "grant_unusable"; reason: "authentication_required" | "permission_required" }
	/** `dailyQuota` means a quota that resets on a schedule, so waiting for it costs nothing. */
	| { kind: "rate_limited"; retryAfterMs: number | null; dailyQuota?: true }
	/** A transient failure: network, 5xx, or a response that isn't the documented shape. */
	| { kind: "unavailable" };

/** Platform limits per request: YouTube `videos.list` takes 50 IDs, TikTok `video/query` 20. */
export const PERFORMANCE_BATCH_LIMITS = { youtube_shorts: 50, tiktok: 20 } as const;
export type PerformancePlatform = keyof typeof PERFORMANCE_BATCH_LIMITS;

const MAX_COUNT = 2_147_483_647;

function toCount(value: unknown): number | null {
	const number =
		typeof value === "number"
			? value
			: typeof value === "string" && /^\d+$/.test(value)
				? Number(value)
				: Number.NaN;
	return Number.isFinite(number) && number >= 0
		? Math.min(Math.floor(number), MAX_COUNT)
		: null;
}

function object(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/**
 * YouTube's daily quota resets at 00:00 Pacific time. Waiting for the reset
 * beats retrying into the same wall; the extra minute covers clock skew, and a
 * DST change moves the answer by at most an hour.
 */
export function msUntilQuotaReset(now: Date) {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: "America/Los_Angeles",
		hourCycle: "h23",
		hour: "numeric",
		minute: "numeric",
		second: "numeric",
	}).formatToParts(now);
	const part = (type: string) => Number(parts.find((entry) => entry.type === type)?.value ?? 0);
	const elapsedMs =
		((part("hour") % 24) * 3_600 + part("minute") * 60 + part("second")) * 1_000 +
		(now.getTime() % 1_000);
	return 86_400_000 - elapsedMs + 60_000;
}

function retryAfterMs(response: Response, now: Date) {
	const value = response.headers.get("retry-after");
	if (!value) return null;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
	const date = Date.parse(value);
	return Number.isFinite(date) ? Math.max(0, date - now.getTime()) : null;
}

type ReadInput = {
	fetch: typeof fetch;
	accessToken: string;
	videoIds: string[];
	now: Date;
};

async function send(request: () => Promise<Response>): Promise<Response | null> {
	try {
		return await request();
	} catch {
		return null;
	}
}

async function bodyOf(response: Response) {
	return object(await response.json().catch(() => null));
}

/** YouTube Data API `videos.list?part=statistics`: 1 quota unit for up to 50 IDs. */
export async function readYouTubeStatistics(
	input: ReadInput,
): Promise<PlatformReadResult> {
	const { apiVersion } = SOCIAL_PROVIDER_CAPABILITIES.youtube_shorts;
	const url = `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${input.videoIds.map(encodeURIComponent).join(",")}`;
	const response = await send(() =>
		input.fetch(url, {
			headers: { Authorization: `Bearer ${input.accessToken}` },
			signal: AbortSignal.timeout(15_000),
		}),
	);
	if (!response) return { kind: "unavailable" };
	if (!response.ok) {
		if (response.status === 401) {
			return { kind: "grant_unusable", reason: "authentication_required" };
		}
		if (response.status === 429) {
			return { kind: "rate_limited", retryAfterMs: retryAfterMs(response, input.now) };
		}
		if (response.status === 403) {
			const reason = object(
				(object((await bodyOf(response))?.error)?.errors as unknown[] | undefined)?.[0],
			)?.reason;
			if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") {
				return {
					kind: "rate_limited",
					retryAfterMs: msUntilQuotaReset(input.now),
					dailyQuota: true,
				};
			}
			return reason === "rateLimitExceeded"
				? { kind: "rate_limited", retryAfterMs: retryAfterMs(response, input.now) }
				: { kind: "grant_unusable", reason: "permission_required" };
		}
		return { kind: "unavailable" };
	}
	const body = await bodyOf(response);
	if (!body || !Array.isArray(body.items)) return { kind: "unavailable" };
	const videos = new Map<string, PlatformCounts>();
	for (const item of body.items) {
		const resource = object(item);
		const statistics = object(resource?.statistics);
		const views = toCount(statistics?.viewCount);
		if (typeof resource?.id !== "string" || !statistics || views === null) continue;
		videos.set(resource.id, {
			views,
			likes: toCount(statistics.likeCount),
			comments: toCount(statistics.commentCount),
			shares: null,
			saves: null,
			watchTimeSeconds: null,
			raw: statistics,
		});
	}
	return { kind: "read", apiVersion, videos };
}

const TIKTOK_AUTHENTICATION_CODES = ["access_token_invalid", "access_token_expired"];
const TIKTOK_PERMISSION_CODES = ["scope_not_authorized", "scope_permission_missed"];

/** TikTok `POST /v2/video/query/` (scope `video.list`): up to 20 IDs per request. */
export async function readTikTokStatistics(
	input: ReadInput,
): Promise<PlatformReadResult> {
	const { apiVersion } = SOCIAL_PROVIDER_CAPABILITIES.tiktok;
	const url =
		"https://open.tiktokapis.com/v2/video/query/?fields=id,view_count,like_count,comment_count,share_count";
	const response = await send(() =>
		input.fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${input.accessToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ filters: { video_ids: input.videoIds } }),
			signal: AbortSignal.timeout(15_000),
		}),
	);
	if (!response) return { kind: "unavailable" };
	const body = await bodyOf(response);
	const code = object(body?.error)?.code;
	if (response.status === 429 || code === "rate_limit_exceeded") {
		return { kind: "rate_limited", retryAfterMs: retryAfterMs(response, input.now) };
	}
	if (
		response.status === 401 ||
		TIKTOK_AUTHENTICATION_CODES.includes(String(code))
	) {
		return { kind: "grant_unusable", reason: "authentication_required" };
	}
	if (response.status === 403 || TIKTOK_PERMISSION_CODES.includes(String(code))) {
		return { kind: "grant_unusable", reason: "permission_required" };
	}
	const list = object(body?.data)?.videos;
	if (!response.ok || code !== "ok" || !Array.isArray(list)) {
		return { kind: "unavailable" };
	}
	const videos = new Map<string, PlatformCounts>();
	for (const item of list) {
		const video = object(item);
		const views = toCount(video?.view_count);
		if (typeof video?.id !== "string" || views === null) continue;
		videos.set(video.id, {
			views,
			likes: toCount(video.like_count),
			comments: toCount(video.comment_count),
			shares: toCount(video.share_count),
			saves: null,
			watchTimeSeconds: null,
			raw: {
				view_count: video.view_count,
				like_count: video.like_count,
				comment_count: video.comment_count,
				share_count: video.share_count,
			},
		});
	}
	return { kind: "read", apiVersion, videos };
}

export const PERFORMANCE_READERS = {
	youtube_shorts: readYouTubeStatistics,
	tiktok: readTikTokStatistics,
} as const satisfies Record<
	PerformancePlatform,
	(input: ReadInput) => Promise<PlatformReadResult>
>;

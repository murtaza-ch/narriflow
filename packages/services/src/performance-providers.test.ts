import { describe, expect, test } from "bun:test";
import {
	msUntilQuotaReset,
	PERFORMANCE_BATCH_LIMITS,
	readTikTokStatistics,
	readYouTubeStatistics,
} from "./performance-providers";

const now = new Date("2026-10-24T10:00:00.000Z");

function json(body: unknown, init: ResponseInit = {}) {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
		...init,
	});
}

function recorder(respond: () => Response | Promise<Response>) {
	const requests: Array<{ url: string; init: RequestInit }> = [];
	const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
		requests.push({ url: String(url), init: init ?? {} });
		return respond();
	}) as typeof fetch;
	return { fetcher, requests };
}

const input = (fetcher: typeof fetch, videoIds: string[]) => ({
	fetch: fetcher,
	accessToken: "access-token",
	videoIds,
	now,
});

describe("YouTube statistics", () => {
	// Shape from the videos resource reference: counts are strings, favoriteCount is
	// always "0", dislikeCount appears only for the owner.
	const documented = {
		kind: "youtube#videoListResponse",
		etag: "etag",
		pageInfo: { totalResults: 2, resultsPerPage: 2 },
		items: [
			{
				kind: "youtube#video",
				etag: "a",
				id: "short-1",
				statistics: {
					viewCount: "1482310",
					likeCount: "52744",
					dislikeCount: "1203",
					favoriteCount: "0",
					commentCount: "3381",
				},
			},
			{
				kind: "youtube#video",
				etag: "b",
				id: "short-2",
				// Likes hidden and comments off: those keys are absent.
				statistics: { viewCount: "12", favoriteCount: "0" },
			},
		],
	};

	test("batches the IDs into one authorized videos.list call and parses string counts", async () => {
		const { fetcher, requests } = recorder(() => json(documented));
		const result = await readYouTubeStatistics(input(fetcher, ["short-1", "short-2"]));

		expect(requests).toHaveLength(1);
		expect(requests[0]!.url).toBe(
			"https://www.googleapis.com/youtube/v3/videos?part=statistics&id=short-1,short-2",
		);
		expect((requests[0]!.init.headers as Record<string, string>).Authorization).toBe(
			"Bearer access-token",
		);
		expect(result).toMatchObject({ kind: "read", apiVersion: "v3" });
		if (result.kind !== "read") return;
		expect(result.videos.get("short-1")).toEqual({
			views: 1_482_310,
			likes: 52_744,
			comments: 3_381,
			shares: null,
			saves: null,
			watchTimeSeconds: null,
			raw: documented.items[0]!.statistics,
		});
		// A count the platform withholds is null, not zero.
		expect(result.videos.get("short-2")).toMatchObject({
			views: 12,
			likes: null,
			comments: null,
		});
	});

	test("leaves out a deleted video and an item with no view count", async () => {
		const { fetcher } = recorder(() =>
			json({ items: [{ id: "present", statistics: { viewCount: "5" } }, { id: "malformed", statistics: {} }] }),
		);
		const result = await readYouTubeStatistics(input(fetcher, ["present", "gone", "malformed"]));
		expect(result.kind === "read" && [...result.videos.keys()]).toEqual(["present"]);
	});

	test("clamps a count beyond the 32-bit column", async () => {
		const { fetcher } = recorder(() =>
			json({ items: [{ id: "huge", statistics: { viewCount: "9999999999" } }] }),
		);
		const result = await readYouTubeStatistics(input(fetcher, ["huge"]));
		expect(result.kind === "read" && result.videos.get("huge")?.views).toBe(2_147_483_647);
	});

	test("401 means the grant is no longer valid", async () => {
		const { fetcher } = recorder(() =>
			json({ error: { code: 401, errors: [{ reason: "authError" }] } }, { status: 401 }),
		);
		expect(await readYouTubeStatistics(input(fetcher, ["a"]))).toEqual({
			kind: "grant_unusable",
			reason: "authentication_required",
		});
	});

	test("403 insufficientPermissions needs a reconnect, quota and rate limits back off", async () => {
		const forbidden = (reason: string) =>
			recorder(() => json({ error: { code: 403, errors: [{ reason }] } }, { status: 403 }));
		expect(
			await readYouTubeStatistics(input(forbidden("insufficientPermissions").fetcher, ["a"])),
		).toEqual({ kind: "grant_unusable", reason: "permission_required" });
		expect(
			await readYouTubeStatistics(input(forbidden("rateLimitExceeded").fetcher, ["a"])),
		).toEqual({ kind: "rate_limited", retryAfterMs: null });
		// The daily quota resets at 00:00 Pacific: 03:00 PDT on 2026-10-24 is 21 hours
		// (plus the one-minute margin) away.
		for (const reason of ["quotaExceeded", "dailyLimitExceeded"]) {
			expect(await readYouTubeStatistics(input(forbidden(reason).fetcher, ["a"]))).toEqual({
				kind: "rate_limited",
				retryAfterMs: 21 * 3_600_000 + 60_000,
				dailyQuota: true,
			});
		}
	});

	test("429 honors Retry-After", async () => {
		const { fetcher } = recorder(
			() => new Response("slow down", { status: 429, headers: { "retry-after": "30" } }),
		);
		expect(await readYouTubeStatistics(input(fetcher, ["a"]))).toEqual({
			kind: "rate_limited",
			retryAfterMs: 30_000,
		});
	});

	test("5xx, a network failure and an unexpected body are transient", async () => {
		expect(
			await readYouTubeStatistics(
				input(recorder(() => new Response("", { status: 503 })).fetcher, ["a"]),
			),
		).toEqual({ kind: "unavailable" });
		expect(
			await readYouTubeStatistics(
				input(
					(async () => {
						throw new Error("socket hang up");
					}) as unknown as typeof fetch,
					["a"],
				),
			),
		).toEqual({ kind: "unavailable" });
		expect(
			await readYouTubeStatistics(input(recorder(() => json({ unexpected: true })).fetcher, ["a"])),
		).toEqual({ kind: "unavailable" });
	});
});

describe("TikTok video query", () => {
	// Shape from the /v2/video/query/ reference: data.videos plus an error object
	// whose code is "ok" on success.
	const documented = {
		data: {
			videos: [
				{ id: "7077642457847991554", view_count: 9_120, like_count: 410, comment_count: 12, share_count: 33 },
				{ id: "7080217258529737986", view_count: 7, like_count: 0, comment_count: 0, share_count: 0 },
			],
		},
		error: { code: "ok", message: "", log_id: "20220829194722CBE87ED59D524E727021" },
	};

	test("posts the IDs and the metric fields in one query", async () => {
		const { fetcher, requests } = recorder(() => json(documented));
		const result = await readTikTokStatistics(
			input(fetcher, ["7077642457847991554", "7080217258529737986"]),
		);

		expect(requests).toHaveLength(1);
		expect(requests[0]!.url).toBe(
			"https://open.tiktokapis.com/v2/video/query/?fields=id,view_count,like_count,comment_count,share_count",
		);
		expect(requests[0]!.init.method).toBe("POST");
		expect(JSON.parse(String(requests[0]!.init.body))).toEqual({
			filters: { video_ids: ["7077642457847991554", "7080217258529737986"] },
		});
		expect((requests[0]!.init.headers as Record<string, string>).Authorization).toBe(
			"Bearer access-token",
		);
		expect(result).toMatchObject({ kind: "read", apiVersion: "v2" });
		if (result.kind !== "read") return;
		expect(result.videos.get("7077642457847991554")).toEqual({
			views: 9_120,
			likes: 410,
			comments: 12,
			shares: 33,
			saves: null,
			watchTimeSeconds: null,
			raw: { view_count: 9_120, like_count: 410, comment_count: 12, share_count: 33 },
		});
		// Zero is a real count and stays zero.
		expect(result.videos.get("7080217258529737986")).toMatchObject({ views: 7, likes: 0 });
	});

	test("maps the documented error codes, whatever the HTTP status", async () => {
		const failure = (code: string, status: number) =>
			recorder(() => json({ data: {}, error: { code, message: "x", log_id: "l" } }, { status }));
		expect(
			await readTikTokStatistics(input(failure("access_token_invalid", 401).fetcher, ["1"])),
		).toEqual({ kind: "grant_unusable", reason: "authentication_required" });
		expect(
			await readTikTokStatistics(input(failure("scope_not_authorized", 403).fetcher, ["1"])),
		).toEqual({ kind: "grant_unusable", reason: "permission_required" });
		expect(
			await readTikTokStatistics(input(failure("rate_limit_exceeded", 429).fetcher, ["1"])),
		).toEqual({ kind: "rate_limited", retryAfterMs: null });
		// Some failures answer 200 with only the error code.
		expect(
			await readTikTokStatistics(input(failure("access_token_invalid", 200).fetcher, ["1"])),
		).toEqual({ kind: "grant_unusable", reason: "authentication_required" });
	});

	test("an unknown error, 5xx or missing data is transient", async () => {
		expect(
			await readTikTokStatistics(
				input(
					recorder(() => json({ data: {}, error: { code: "internal_error", message: "", log_id: "l" } }, { status: 500 }))
						.fetcher,
					["1"],
				),
			),
		).toEqual({ kind: "unavailable" });
		expect(
			await readTikTokStatistics(
				input(recorder(() => json({ error: { code: "ok" } })).fetcher, ["1"]),
			),
		).toEqual({ kind: "unavailable" });
	});

	test("a video the platform no longer returns is absent from the result", async () => {
		const { fetcher } = recorder(() => json(documented));
		const result = await readTikTokStatistics(input(fetcher, ["7077642457847991554", "deleted"]));
		expect(result.kind === "read" && result.videos.has("deleted")).toBe(false);
	});
});

test("the quota reset is the next 00:00 in Los Angeles, across the day boundary and DST", () => {
	// 23:30 PDT: half an hour to the reset.
	expect(msUntilQuotaReset(new Date("2026-10-25T06:30:00.000Z"))).toBe(30 * 60_000 + 60_000);
	// 00:00:00 PST (after the November change) is a full day away.
	expect(msUntilQuotaReset(new Date("2026-11-02T08:00:00.000Z"))).toBe(86_400_000 + 60_000);
});

test("batch limits match the platforms' documented maximums", () => {
	expect(PERFORMANCE_BATCH_LIMITS).toEqual({ youtube_shorts: 50, tiktok: 20 });
});

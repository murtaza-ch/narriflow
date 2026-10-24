import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
	clipExportDurationSec,
	clipFactsSchema,
	performanceSyncAvailable,
	type ClipFacts,
	type SocialPlatform,
} from "@narriflow/validators";
import {
	PERFORMANCE_BATCH_LIMITS,
	PERFORMANCE_READERS,
	type PerformancePlatform,
	type PlatformCounts,
} from "./performance-providers";

/** Minutes after publication: about 1 hour, 24 hours, 3 days, 7 days, 28 days. Then it stops. */
export const CAPTURE_OFFSETS_MINUTES = [60, 1_440, 4_320, 10_080, 40_320] as const;

/**
 * "What worked" compares every video at the same age: the 7-day capture. A
 * younger video is waiting for it, so a day-old hit never sits beside a
 * month-old one.
 */
export const COMPARISON_SLOT = CAPTURE_OFFSETS_MINUTES.indexOf(10_080);

const SYNCED_PLATFORMS = (Object.keys(PERFORMANCE_BATCH_LIMITS) as PerformancePlatform[]).filter(
	performanceSyncAvailable,
);
const LEASE_MS = 3 * 60_000;
const MAXIMUM_ATTEMPTS = 10;
const MAXIMUM_BACKOFF_MS = 2 * 60 * 60_000;
const SCHEDULE_BATCH = 200;
const CAPTURE_BATCH = 100;

/** Why a capture was skipped. A skipped capture never fails the Social Post. */
export type PerformanceSkipReason =
	| "account_disconnected"
	| "grant_expired"
	| "permission_missing"
	| "video_unavailable"
	| "rate_limited"
	| "provider_unavailable"
	/** A newer slot of the same video was already due, so this reading would repeat it. */
	| "missed";

export interface PerformanceSyncDependencies {
	prisma: PrismaClient;
	fetch: typeof fetch;
	/** Decrypts the token, refreshing it through the Social OAuth service when due. */
	accounts: { getPublishAccount(accountId: string): Promise<{ accessToken: string }> };
	now?: () => Date;
	log?: (entry: Record<string, unknown>) => void;
}

function backoffMs(attempts: number, retryAfterMs: number | null) {
	return Math.max(retryAfterMs ?? 0, Math.min(MAXIMUM_BACKOFF_MS, 2 * 60_000 * 2 ** attempts));
}

function postedHour(at: Date, timeZone: string) {
	const hour = (zone: string) =>
		new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", hourCycle: "h23" })
			.formatToParts(at)
			.find((part) => part.type === "hour")?.value;
	try {
		return Number(hour(timeZone)) % 24;
	} catch {
		return Number(hour("UTC")) % 24;
	}
}

const ASPECT_RATIOS = {
	ratio_9_16: "9:16",
	ratio_1_1: "1:1",
	ratio_16_9: "16:9",
	ratio_4_5: "4:5",
} as const;

type NewTrackedVideo = {
	id: string;
	socialPostId: string | null;
	platform: SocialPlatform;
	publishedAt: Date;
};

/** A grant the provider rejected on refresh (400 or 401) needs a reconnect, not a retry. */
function isRejectedRefresh(error: { code?: string; status?: number } | null) {
	return (
		error?.code === "social_oauth_http_failed" &&
		(error.status === 400 || error.status === 401)
	);
}

/**
 * Reads view and engagement counts back from the platforms for videos
 * Narriflow published. `scheduleTrackedVideos` turns each verified Published
 * Social Video into a Tracked Video with five Performance Captures and freezes
 * its Clip Facts; `captureDue` claims due captures under a lease, batches them
 * per account, and settles each exactly once as captured or skipped.
 */
export function createPerformanceSync(dependencies: PerformanceSyncDependencies) {
	const { prisma } = dependencies;
	const now = dependencies.now ?? (() => new Date());
	const log = dependencies.log ?? ((entry) => console.warn(JSON.stringify(entry)));

	/** Reads the clip as it was published; null once the Project is gone. */
	async function readClipFacts(
		tx: Prisma.TransactionClient,
		video: NewTrackedVideo,
	): Promise<ClipFacts | null> {
		if (!video.socialPostId) return null;
		const post = await tx.socialPost.findUnique({
			where: { id: video.socialPostId },
			select: {
				workspace: { select: { timezone: true } },
				frozenState: { select: { aspectRatio: true, durationSec: true } },
				clip: {
					select: {
						viralityScore: true,
						hookStrengthScore: true,
						category: true,
						startSec: true,
						endSec: true,
						deletedRanges: true,
						sceneBlocks: true,
					},
				},
			},
		});
		if (!post?.clip || !post.frozenState) return null;
		const parsed = clipFactsSchema.safeParse({
			viralityScore: post.clip.viralityScore,
			category: post.clip.category,
			hookStrengthScore: post.clip.hookStrengthScore,
			durationSec: post.frozenState.durationSec ?? clipExportDurationSec(post.clip),
			aspectRatio: ASPECT_RATIOS[post.frozenState.aspectRatio],
			platform: video.platform,
			postedHour: postedHour(video.publishedAt, post.workspace?.timezone ?? "UTC"),
		});
		return parsed.success ? parsed.data : null;
	}

	/**
	 * Idempotent: a video is tracked once, and its capture slots are unique per
	 * video, so concurrent workers and repeated runs create nothing twice.
	 * Videos older than the last capture slot are ignored, and so is a YouTube
	 * upload the platform reports as private or unlisted. The clip facts are
	 * frozen in the same transaction, within a pass of publication, so a clip
	 * deleted or rescored later can't change or lose them.
	 */
	async function scheduleTrackedVideos() {
		const at = now();
		const oldest = new Date(at.getTime() - Math.max(...CAPTURE_OFFSETS_MINUTES) * 60_000);
		return prisma.$transaction(async (tx) => {
			const created = await tx.$queryRaw<NewTrackedVideo[]>`
				INSERT INTO "TrackedVideo" ("id", "workspaceId", "socialAccountId", "socialPostId", "clipId", "platform", "platformPostId", "publishedAt")
				SELECT gen_random_uuid(), sp."workspaceId", sp."socialAccountId", sp."id", sp."clipId", sp."platform", pv."platformPostId", pv."publishedAt"
				FROM "PublishedSocialVideo" pv
				JOIN "SocialPost" sp ON sp."id" = pv."socialPostId"
				WHERE sp."platform"::text IN (${Prisma.join(SYNCED_PLATFORMS)})
					AND sp."workspaceId" IS NOT NULL
					AND pv."publishedAt" >= ${oldest}
					AND NOT EXISTS (
						SELECT 1 FROM "TrackedVideo" tv
						WHERE tv."workspaceId" = sp."workspaceId"
							AND tv."platform" = sp."platform"
							AND tv."platformPostId" = pv."platformPostId"
					)
					AND NOT EXISTS (
						SELECT 1 FROM "SocialPublicationAttempt" attempt
						JOIN "ProviderReceipt" receipt ON receipt."attemptId" = attempt."id"
						WHERE attempt."socialPostId" = sp."id"
							AND receipt."platformPostId" = pv."platformPostId"
							AND receipt."providerVisibility" IN ('private', 'unlisted')
					)
				ORDER BY pv."publishedAt"
				LIMIT ${SCHEDULE_BATCH}
				ON CONFLICT ("workspaceId", "platform", "platformPostId") DO NOTHING
				RETURNING "id", "socialPostId", "platform", "publishedAt"`;
			await tx.performanceCapture.createMany({
				data: created.flatMap((video) =>
					CAPTURE_OFFSETS_MINUTES.map((minutes, slot) => ({
						trackedVideoId: video.id,
						slot,
						dueAt: new Date(video.publishedAt.getTime() + minutes * 60_000),
					})),
				),
				skipDuplicates: true,
			});
			for (const video of created) {
				const facts = await readClipFacts(tx, video);
				if (facts) {
					await tx.trackedVideo.updateMany({
						where: { id: video.id, clipFactsAt: null },
						data: { clipFacts: facts, clipFactsAt: at },
					});
				}
			}
			return created.length;
		});
	}

	/**
	 * A video whose slots all fell due together (a backfill, a long outage) is
	 * read once, at its newest slot. The older due slots would record the same
	 * counts, so they are skipped as missed.
	 */
	async function skipMissedSlots(at: Date) {
		return prisma.$executeRaw`
			UPDATE "PerformanceCapture" older
			SET "state" = 'skipped', "skipReason" = 'missed'
			WHERE older."state" = 'scheduled'
				AND older."dueAt" <= ${at}
				AND (older."leaseExpiresAt" IS NULL OR older."leaseExpiresAt" <= ${at})
				AND EXISTS (
					SELECT 1 FROM "PerformanceCapture" newer
					WHERE newer."trackedVideoId" = older."trackedVideoId"
						AND newer."slot" > older."slot"
						AND newer."state" = 'scheduled'
						AND newer."dueAt" <= ${at}
				)`;
	}

	/** Claims these captures for one lease token; the winners are returned. */
	async function claim(ids: string[], token: string) {
		const at = now();
		const free = { OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: at } }] };
		const won: string[] = [];
		for (const id of ids) {
			const claimed = await prisma.performanceCapture.updateMany({
				where: { id, state: "scheduled", dueAt: { lte: at }, ...free },
				data: { leaseOwner: token, leaseExpiresAt: new Date(at.getTime() + LEASE_MS) },
			});
			if (claimed.count === 1) won.push(id);
		}
		return won;
	}

	const fenced = (id: string, token: string) => ({
		id,
		state: "scheduled" as const,
		leaseOwner: token,
	});
	const released = { leaseOwner: null, leaseExpiresAt: null };

	async function skip(id: string, token: string, reason: PerformanceSkipReason) {
		const settled = await prisma.performanceCapture.updateMany({
			where: fenced(id, token),
			data: { ...released, state: "skipped", skipReason: reason },
		});
		return settled.count === 1;
	}

	/**
	 * Releases a failed capture to try again later, or skips it once the budget
	 * is spent. Only a skip counts as settled. A daily quota that resets on a
	 * known schedule waits for the reset without spending the budget.
	 */
	async function retryLater(
		capture: { id: string; attempts: number },
		token: string,
		reason: "rate_limited" | "provider_unavailable",
		retryAfterMs: number | null,
		spendsBudget = true,
	) {
		if (spendsBudget && capture.attempts + 1 >= MAXIMUM_ATTEMPTS) {
			return skip(capture.id, token, reason);
		}
		await prisma.performanceCapture.updateMany({
			where: fenced(capture.id, token),
			data: {
				...released,
				...(spendsBudget ? { attempts: { increment: 1 } } : {}),
				dueAt: new Date(
					now().getTime() +
						(spendsBudget ? backoffMs(capture.attempts, retryAfterMs) : (retryAfterMs ?? 0)),
				),
			},
		});
		return false;
	}

	/** Settles a capture as captured. */
	async function settleCaptured(
		capture: { id: string },
		token: string,
		counts: PlatformCounts,
		apiVersion: string,
	) {
		const settled = await prisma.performanceCapture.updateMany({
			where: fenced(capture.id, token),
			data: {
				...released,
				state: "captured",
				capturedAt: now(),
				apiVersion,
				views: counts.views,
				likes: counts.likes,
				comments: counts.comments,
				shares: counts.shares,
				saves: counts.saves,
				watchTimeSeconds: counts.watchTimeSeconds,
				raw: counts.raw as Prisma.InputJsonValue,
			},
		});
		return settled.count === 1;
	}

	/**
	 * Captures every due reading once. Returns how many were settled, captured
	 * or skipped. A platform that rate-limits is left alone for the rest of the
	 * run, and a failure inside one batch retries only that batch.
	 */
	async function captureDue(limit = CAPTURE_BATCH) {
		const at = now();
		let settled = await skipMissedSlots(at);
		const candidates = await prisma.performanceCapture.findMany({
			where: {
				state: "scheduled",
				dueAt: { lte: at },
				OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: at } }],
				trackedVideo: { platform: { in: SYNCED_PLATFORMS } },
			},
			orderBy: { dueAt: "asc" },
			take: limit,
			select: {
				id: true,
				attempts: true,
				trackedVideo: {
					select: {
						socialAccountId: true,
						platform: true,
						platformPostId: true,
					},
				},
			},
		});

		const groups = new Map<string, typeof candidates>();
		for (const candidate of candidates) {
			const key = `${candidate.trackedVideo.platform}:${candidate.trackedVideo.socialAccountId ?? ""}`;
			groups.set(key, [...(groups.get(key) ?? []), candidate]);
		}

		const blocked = new Set<SocialPlatform>();
		const grants = new Map<
			string,
			Promise<{ accessToken: string } | { skip: PerformanceSkipReason }>
		>();

		type Chunk = typeof candidates;
		async function settleChunk(
			chunk: Chunk,
			token: string,
			platform: SocialPlatform,
			socialAccountId: string | null,
		) {
			const settleAll = async (outcome: (row: Chunk[number]) => Promise<boolean>) => {
				for (const row of chunk) {
					if (await outcome(row)) settled += 1;
				}
			};
			const context = { platform, socialAccountId, captures: chunk.length };

			if (!socialAccountId) {
				await settleAll((row) => skip(row.id, token, "account_disconnected"));
				log({ level: "info", message: "performance_capture_skipped", ...context, reason: "account_disconnected" });
				return;
			}
			let grant = grants.get(socialAccountId);
			if (!grant) {
				grant = dependencies.accounts.getPublishAccount(socialAccountId).catch((error: unknown) => {
					const failure = error as { code?: string; status?: number } | null;
					if (failure?.code === "social_account_missing") return { skip: "account_disconnected" as const };
					if (
						failure?.code === "social_account_expired" ||
						failure?.code === "social_account_refresh_missing" ||
						isRejectedRefresh(failure)
					) {
						return { skip: "grant_expired" as const };
					}
					return { skip: "provider_unavailable" as const };
				});
				grants.set(socialAccountId, grant);
			}
			const account = await grant;
			if ("skip" in account) {
				if (account.skip === "provider_unavailable") {
					await settleAll((row) => retryLater(row, token, "provider_unavailable", null));
				} else {
					await settleAll((row) => skip(row.id, token, account.skip));
				}
				log({ level: "warn", message: "performance_capture_account_unavailable", ...context, reason: account.skip });
				return;
			}

			const result = await PERFORMANCE_READERS[platform as PerformancePlatform]({
				fetch: dependencies.fetch,
				accessToken: account.accessToken,
				videoIds: [...new Set(chunk.map((row) => row.trackedVideo.platformPostId))],
				now: now(),
			});

			if (result.kind === "read") {
				let lost = 0;
				await settleAll(async (row) => {
					const counts = result.videos.get(row.trackedVideo.platformPostId);
					const done = counts
						? await settleCaptured(row, token, counts, result.apiVersion)
						: await skip(row.id, token, "video_unavailable");
					if (!done) lost += 1;
					return done;
				});
				log({
					level: lost ? "warn" : "info",
					message: "performance_capture_batch",
					...context,
					returned: result.videos.size,
					...(lost ? { leaseLost: lost } : {}),
				});
			} else if (result.kind === "grant_unusable") {
				const reason = result.reason === "authentication_required" ? "grant_expired" : "permission_missing";
				await settleAll((row) => skip(row.id, token, reason));
				log({ level: "warn", message: "performance_capture_skipped", ...context, reason });
			} else if (result.kind === "rate_limited") {
				blocked.add(platform);
				await settleAll((row) =>
					retryLater(row, token, "rate_limited", result.retryAfterMs, !result.dailyQuota),
				);
				log({ level: "warn", message: "performance_capture_rate_limited", ...context, retryAfterMs: result.retryAfterMs, dailyQuota: result.dailyQuota === true });
			} else {
				await settleAll((row) => retryLater(row, token, "provider_unavailable", null));
				log({ level: "warn", message: "performance_capture_unavailable", ...context });
			}
		}

		for (const rows of groups.values()) {
			const { platform, socialAccountId } = rows[0]!.trackedVideo;
			if (blocked.has(platform)) continue;
			const limitPerCall = PERFORMANCE_BATCH_LIMITS[platform as PerformancePlatform];
			for (let start = 0; start < rows.length; start += limitPerCall) {
				if (blocked.has(platform)) break;
				const token = randomUUID();
				const slice = rows.slice(start, start + limitPerCall);
				const won = new Set(await claim(slice.map((row) => row.id), token));
				const chunk = slice.filter((row) => won.has(row.id));
				if (chunk.length === 0) continue;
				try {
					await settleChunk(chunk, token, platform, socialAccountId);
				} catch (error) {
					// One bad batch must not starve the others or retry forever: spend
					// an attempt on it and move on.
					log({
						level: "error",
						message: "performance_capture_batch_failed",
						platform,
						socialAccountId,
						captures: chunk.length,
						error: error instanceof Error ? error.message : "Unknown error",
					});
					for (const row of chunk) {
						try {
							if (await retryLater(row, token, "provider_unavailable", null)) settled += 1;
						} catch {
							// The lease expires and the capture is claimed again.
						}
					}
				}
			}
		}
		return settled;
	}

	return {
		scheduleTrackedVideos,
		captureDue,
		/** One worker pass: track new videos, then capture what is due. */
		async run() {
			await scheduleTrackedVideos();
			return captureDue();
		},
	};
}

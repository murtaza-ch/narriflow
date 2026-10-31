import {fetchSocialProvider} from "./social-provider-http";
import { createHash, randomUUID } from "node:crypto";
import {
	Prisma,
	type PrismaClient,
	type PerformanceCapture,
	type TrackedVideo,
} from "@prisma/client";
import type { ExecutionDispatchReference } from "@narriflow/validators/execution";
import {
	clipFactsSchema,
	clipExportDurationSec,
	performanceSyncAvailable,
} from "@narriflow/validators";
import { readExecutionAdmission } from "./execution-admission";
import {
	appendExecutionDispatch,
	readExecutionDispatch,
} from "./execution-dispatch";
import {
	collectExecutionDispatch,
	takeExecutionDispatchIds,
} from "./execution-dispatch-runtime";
import { samePublicationDispatch } from "./publication-dispatch";
import { lockPublicationAttempt } from "./publication-locks";
import { CAPTURE_OFFSETS_MINUTES } from "./performance-capture-contract";
import {
	PERFORMANCE_READERS,
	type PerformancePlatform,
	type PlatformReadResult,
} from "./performance-providers";
import {
	interpretYouTubeProcessingStatus,
	type YouTubeStatusResource,
} from "./youtube-receipt-status";
import {
	computePerformanceGuidance,
	GUIDANCE_WINDOW_DAYS,
	MINIMUM_GUIDANCE_WORKSPACE_POSTS,
} from "./performance-guidance";
import { readComparedVideos } from "./performance-summary";
import { executeExecutionPage } from "./execution-page-receipt";
type Tx = Prisma.TransactionClient;
const uuid = "[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}",
	duePattern = new RegExp(`^po1\\.([yc])\\.(${uuid})\\.([a-f0-9]{32})$`),
	watchPattern = new RegExp(
		`^po1\\.([yc])w\\.(${uuid})\\.(${uuid})\\.([1-9][0-9]{0,14})$`,
	),
	guidancePattern = new RegExp(`^po1\\.g\\.(${uuid})\\.([1-9][0-9]{0,14})$`);
const trackingPattern = new RegExp(`^po1\\.t\\.(${uuid})$`);
const restorePattern = new RegExp(`^po1\\.r\\.(${uuid})\\.(0|${uuid})$`);
const DAY = 86400000,
	hash = (v: unknown) =>
		createHash("sha256").update(JSON.stringify(v)).digest("hex");
const clock = async (tx: Tx) =>
	(
		await tx.$queryRaw<
			Array<{ now: Date }>
		>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`
	)[0]!.now;
const receiptInclude = {
	attempt: { include: { socialPost: true, frozenState: true } },
} satisfies Prisma.ProviderReceiptInclude;
type Receipt = Prisma.ProviderReceiptGetPayload<{
	include: typeof receiptInclude;
}>;
type Capture = PerformanceCapture & { trackedVideo: TrackedVideo };
const receiptId = (r: Receipt) =>
	`po1.y.${r.id}.${hash([r.id, r.attemptId, r.platformPostId, r.enrichmentCheckCount, r.enrichmentNextCheckAt?.toISOString() ?? null, r.attempt.processingDeadline.toISOString()]).slice(0, 32)}`;
const captureId = (r: Capture) =>
	`po1.c.${r.id}.${hash([r.id, r.trackedVideoId, r.slot, r.dueAt.toISOString(), r.attempts, r.trackedVideo.platform, r.trackedVideo.platformPostId, r.trackedVideo.socialAccountId]).slice(0, 32)}`;
async function append(tx: Tx, id: string, dueAt: Date) {
	const { epoch } = await readExecutionAdmission(tx);
	const record = await appendExecutionDispatch(tx, {
		deploymentEpoch: epoch,
		generation: 1,
		kind: "maintenance",
		subject: { kind: "maintenance", id },
		inputHash: hash(["publication-observation-v1", id]),
		dueAt,
	});
	collectExecutionDispatch(tx, record.reference.dispatchId);
	return record.reference.dispatchId;
}
async function recover(tx: Tx, id: string, epoch: number) {
	const rows = await tx.executionDispatch.findMany({
		where: {
			deploymentEpoch: epoch,
			kind: "maintenance",
			subjectKind: "maintenance",
			subjectId: id,
			acknowledgedAt: null,
			deadLetteredAt: null,
		},
		take: 2,
		select: { id: true },
	});
	if (rows.length > 1) throw Error("publication_observation_identity_conflict");
	for (const row of rows) collectExecutionDispatch(tx, row.id);
	return rows.map((row) => row.id);
}
export async function appendYouTubeReceiptEnrichment(tx: Tx, id: string) {
	const row = await tx.providerReceipt.findUnique({
		where: { id },
		include: receiptInclude,
	});
	if (
		!row ||
		row.platform !== "youtube_shorts" ||
		row.enrichedAt ||
		row.providerProcessingStatus !== "processing"
	)
		return null;
	const { epoch } = await readExecutionAdmission(tx);
	if (row.attempt.socialPost.deploymentEpoch !== epoch) return null;
	if (row.enrichmentClaimId && row.enrichmentLeaseExpiresAt)
		return append(tx, `po1.yw.${id}.${row.enrichmentClaimId}.${row.enrichmentLeaseExpiresAt.getTime()}`, row.enrichmentLeaseExpiresAt);
	return append(tx, receiptId(row), row.enrichmentNextCheckAt ?? row.createdAt);
}
export async function appendPerformanceCapture(tx: Tx, id: string) {
	const row = await tx.performanceCapture.findUnique({
		where: { id },
		include: { trackedVideo: { include: { socialPost: { select: { deploymentEpoch: true } } } } },
	});
	if (row?.state !== "scheduled") return null;
	const { epoch } = await readExecutionAdmission(tx);
	if (row.trackedVideo.socialPost && row.trackedVideo.socialPost.deploymentEpoch !== epoch) return null;
	if (row.leaseOwner && row.leaseExpiresAt)
		return append(tx, `po1.cw.${id}.${row.leaseOwner}.${row.leaseExpiresAt.getTime()}`, row.leaseExpiresAt);
	return append(tx, captureId(row), row.dueAt);
}
/** One bounded restore cursor revives admitted observations in the new epoch;
 * old provider responses remain fenced by their invocation's captured epoch. */
export async function appendPublicationObservationRestore(
	tx: Tx,
	postId: string,
) {
	return append(tx, `po1.r.${postId}.0`, new Date(0));
}
export async function appendPerformanceGuidance(
	tx: Tx,
	workspaceId: string,
	dueAt?: Date,
) {
	const at =
		dueAt ?? new Date(Math.ceil((await clock(tx)).getTime() / DAY) * DAY);
	return append(tx, `po1.g.${workspaceId}.${at.getTime()}`, at);
}
/** Called only for a provider-verified PublishedSocialVideo. Freezes facts and
 * all five observation obligations in the publication's own transaction. */
export async function trackPublishedVideo(
	tx: Tx,
	input: { socialPostId: string; platformPostId: string },
) {
	const published = await tx.publishedSocialVideo.findUnique({
		where: { socialPostId_platformPostId: input },
		include: {
			socialPost: {
				include: { workspace: true, clip: true, frozenState: true },
			},
		},
	});
	const post = published?.socialPost;
	if (
		!published ||
		!post?.workspaceId ||
		!performanceSyncAvailable(post.platform) ||
		!post.frozenState
	)
		return null;
	const visibility = await tx.providerReceipt.findFirst({
		where: {
			attempt: { socialPostId: post.id },
			platformPostId: published.platformPostId,
			providerVisibility: { in: ["private", "unlisted"] },
		},
		select: { id: true },
	});
	if (visibility) return null;
	const at = await clock(tx);
	if (
		published.publishedAt.getTime() +
			Math.max(...CAPTURE_OFFSETS_MINUTES) * 60000 <
		at.getTime()
	)
		return null;
	let hour = 0;
	try {
		hour =
			Number(
				new Intl.DateTimeFormat("en-US", {
					timeZone: post.workspace?.timezone ?? "UTC",
					hour: "numeric",
					hourCycle: "h23",
				})
					.formatToParts(published.publishedAt)
					.find((p) => p.type === "hour")?.value ?? 0,
			) % 24;
	} catch {}
	const ratio = {
		ratio_9_16: "9:16",
		ratio_1_1: "1:1",
		ratio_16_9: "16:9",
		ratio_4_5: "4:5",
	} as const;
	const facts = post.clip
		? clipFactsSchema.safeParse({
				viralityScore: post.clip.viralityScore,
				category: post.clip.category,
				hookStrengthScore: post.clip.hookStrengthScore,
				durationSec:
					post.frozenState.durationSec ?? clipExportDurationSec(post.clip),
				aspectRatio: ratio[post.frozenState.aspectRatio],
				platform: post.platform,
				postedHour: hour,
			})
		: null;
	const video = await tx.trackedVideo.upsert({
		where: {
			workspaceId_platform_platformPostId: {
				workspaceId: post.workspaceId,
				platform: post.platform,
				platformPostId: published.platformPostId,
			},
		},
		create: {
			workspaceId: post.workspaceId,
			socialAccountId: post.socialAccountId,
			socialPostId: post.id,
			clipId: post.clipId,
			platform: post.platform,
			platformPostId: published.platformPostId,
			publishedAt: published.publishedAt,
			...(facts?.success ? { clipFacts: facts.data, clipFactsAt: at } : {}),
		},
		update: {},
	});
	await tx.performanceCapture.createMany({
		data: CAPTURE_OFFSETS_MINUTES.map((minutes, slot) => ({
			trackedVideoId: video.id,
			slot,
			dueAt: new Date(published.publishedAt.getTime() + minutes * 60000),
		})),
		skipDuplicates: true,
	});
	await append(tx, `po1.t.${video.id}`, new Date(0));
	return video.id;
}
export function isPublicationObservationReference(
	ref: ExecutionDispatchReference,
) {
	return (
		ref.kind === "maintenance" &&
		ref.subject.kind === "maintenance" &&
		(duePattern.test(ref.subject.id) ||
			watchPattern.test(ref.subject.id) ||
			guidancePattern.test(ref.subject.id) ||
			trackingPattern.test(ref.subject.id) ||
			restorePattern.test(ref.subject.id))
	);
}
async function bounded(response: Response) {
	const reader = response.body?.getReader();
	if (!reader)
		return new Response(null, {
			status: response.status,
			headers: response.headers,
		});
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		for (;;) {
			const part = await reader.read();
			if (part.done) break;
			length += part.value.byteLength;
			if (length > 65536)
				throw Error("publication_provider_response_too_large");
			chunks.push(part.value);
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const part of chunks) {
		bytes.set(part, offset);
		offset += part.byteLength;
	}
	return new Response(bytes, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}
const delay = (value: string | null, now: Date) => {
	if (!value) return 0;
	const n = Number(value);
	return Number.isFinite(n) && n >= 0
		? n * 1000
		: Math.max(0, Date.parse(value) - now.getTime()) || 0;
};
type ReceiptOutcome =
	| {
			kind: "terminal";
			status: string;
			failure: string | null;
			visibility?: string | null;
	  }
	| { kind: "retry"; delayMs: number; failure?: string };
export function createPublicationObservations(options: {
	database: PrismaClient;
	fetch: typeof fetch;
	accounts: { getPublishAccount(id: string): Promise<{ accessToken: string }> };
	register(ids: readonly string[]): Promise<void>;
}) {
	const db = options.database;
	const safeFetch = (async (input, init) =>
		bounded(
			await fetchSocialProvider(input,init,options.fetch),
		)) as typeof fetch;
	async function ownedReceipt(
		tx: Tx,
		id: string,
		owner: string,
		epoch: number,
	) {
		if ((await readExecutionAdmission(tx)).epoch !== epoch) return null;
		const initial = await tx.providerReceipt.findUnique({
			where: { id },
			select: { attemptId: true },
		});
		if (!initial) return null;
		await lockPublicationAttempt(tx, initial.attemptId);
		await tx.$queryRaw`SELECT "id" FROM "ProviderReceipt" WHERE "id"=${id}::uuid FOR UPDATE`;
		const row = await tx.providerReceipt.findUnique({
				where: { id },
				include: receiptInclude,
			}),
			at = await clock(tx);
		return row &&
			row.enrichmentClaimId === owner &&
			row.enrichmentLeaseExpiresAt &&
			row.enrichmentLeaseExpiresAt > at &&
			row.attempt.socialPost.deploymentEpoch === epoch &&
			!row.enrichedAt
			? row
			: null;
	}
	async function ownedCapture(
		tx: Tx,
		id: string,
		owner: string,
		epoch: number,
	) {
		if ((await readExecutionAdmission(tx)).epoch !== epoch) return null;
		const initial = await tx.performanceCapture.findUnique({
			where: { id },
			include: { trackedVideo: true },
		});
		if (!initial) return null;
		await tx.$queryRaw`SELECT "id" FROM "Workspace" WHERE "id"=${initial.trackedVideo.workspaceId}::uuid FOR SHARE`;
		await tx.$queryRaw`SELECT "id" FROM "PerformanceCapture" WHERE "id"=${id}::uuid FOR UPDATE`;
		const row = await tx.performanceCapture.findUnique({
				where: { id },
				include: { trackedVideo: true },
			}),
			at = await clock(tx);
		return row &&
			row.state === "scheduled" &&
			row.leaseOwner === owner &&
			row.leaseExpiresAt &&
			row.leaseExpiresAt > at
			? row
			: null;
	}
	async function finishReceipt(
		id: string,
		owner: string,
		epoch: number,
		outcome: ReceiptOutcome,
	) {
		return db.$transaction(async (tx) => {
			const row = await ownedReceipt(tx, id, owner, epoch);
			if (!row) return [];
			const at = await clock(tx),
				retry = outcome.kind === "retry";
			const data: Prisma.ProviderReceiptUpdateInput = {
				enrichmentClaimId: null,
				enrichmentLeaseExpiresAt: null,
				enrichmentCheckCount: { increment: 1 },
			};
			if (retry) {
				data.enrichmentNextCheckAt = new Date(
					at.getTime() +
						Math.max(
							outcome.delayMs,
							Math.min(
								1800000,
								30000 * 2 ** Math.min(row.enrichmentCheckCount, 6),
							),
						),
				);
				if (outcome.failure)
					data.providerProcessingFailureCode = outcome.failure;
			} else {
				data.providerProcessingStatus = outcome.status;
				data.providerProcessingFailureCode = outcome.failure;
				data.enrichedAt = at;
				data.enrichmentNextCheckAt = null;
				if (outcome.visibility !== undefined)
					data.providerVisibility = outcome.visibility;
				if (outcome.failure)
					await tx.socialPost.updateMany({
						where: { id: row.attempt.socialPostId, status: "posted" },
						data: {
							errorCode: outcome.failure,
							errorDisposition:
								outcome.status === "failed" ? "permanent" : "attention",
						},
					});
			}
			await tx.providerReceipt.update({ where: { id }, data });
			if (retry) await appendYouTubeReceiptEnrichment(tx, id);
			else if (outcome.status === "succeeded" && row.platformPostId)
				await trackPublishedVideo(tx, {
					socialPostId: row.attempt.socialPostId,
					platformPostId: row.platformPostId,
				});
			return takeExecutionDispatchIds(tx);
		});
	}
	async function receiptRead(row: Receipt): Promise<ReceiptOutcome> {
		try {
			if (!row.platformPostId || !row.attempt.frozenState.socialAccountId)
				return {
					kind: "terminal",
					status: "unknown",
					failure: "youtube_processing_status_unknown",
				};
			const account = await options.accounts.getPublishAccount(
				row.attempt.frozenState.socialAccountId,
			);
			if (
				!(await db.$transaction(async (tx) => {
					const owned = await ownedReceipt(
						tx,
						row.id,
						row.enrichmentClaimId!,
						row.attempt.socialPost.deploymentEpoch,
					);
					if (!owned) return false;
					return Boolean(
						await tx.socialAccount.findFirst({
							where: {
								id: row.attempt.frozenState.socialAccountId!,
								status: "active",
							},
							select: { id: true },
						}),
					);
				}))
			)
				return {
					kind: "terminal",
					status: "unknown",
					failure: "social_account_reconnect_required",
				};
			const response = await safeFetch(
				`https://www.googleapis.com/youtube/v3/videos?part=status&id=${encodeURIComponent(row.platformPostId)}`,
				{
					headers: { Authorization: `Bearer ${account.accessToken}` },
					signal: AbortSignal.timeout(10000),
				},
			);
			if (!response.ok) {
				let reason = "";
				if (response.status === 403)
					reason =
						(
							(await response
								.clone()
								.json()
								.catch(() => null)) as {
								error?: { errors?: Array<{ reason?: string }> };
							} | null
						)?.error?.errors?.[0]?.reason ?? "";
				if (
					[
						"quotaExceeded",
						"dailyLimitExceeded",
						"uploadLimitExceeded",
					].includes(reason)
				)
					return {
						kind: "retry",
						delayMs: 3600000,
						failure: "youtube_quota_exceeded",
					};
				if (response.status === 429)
					return {
						kind: "retry",
						delayMs: delay(response.headers.get("retry-after"), new Date()),
						failure: "youtube_rate_limit",
					};
				if (response.status === 401 || response.status === 403)
					return {
						kind: "terminal",
						status: "unknown",
						failure:
							response.status === 401
								? "youtube_authentication_required"
								: "youtube_permission_required",
					};
				if (response.status >= 400 && response.status < 500)
					return {
						kind: "terminal",
						status: "unknown",
						failure: "youtube_processing_status_unavailable",
					};
				return { kind: "retry", delayMs: 0 };
			}
			const body = (await response.json()) as {
				items?: YouTubeStatusResource[];
			};
			if (!body.items?.[0]) return { kind: "retry", delayMs: 0 };
			const interpreted = interpretYouTubeProcessingStatus(body.items[0]);
			return interpreted.status === "processing"
				? { kind: "retry", delayMs: 0 }
				: {
						kind: "terminal",
						status: interpreted.status,
						failure: interpreted.failureCode,
						visibility: interpreted.visibility,
					};
		} catch (error) {
			const code = (error as { code?: string })?.code;
			return [
				"social_account_expired",
				"social_account_missing",
				"social_account_refresh_unconfirmed",
				"social_account_refresh_missing",
			].includes(code ?? "")
				? {
						kind: "terminal",
						status: "unknown",
						failure: "social_account_reconnect_required",
					}
				: { kind: "retry", delayMs: 0 };
		}
	}
	async function finishCapture(
		id: string,
		owner: string,
		epoch: number,
		result: PlatformReadResult | { kind: "skip"; reason: string },
	) {
		return db.$transaction(async (tx) => {
			const row = await ownedCapture(tx, id, owner, epoch);
			if (!row) return [];
			const at = await clock(tx);
			let skip: string | null = null,
				retry = false,
				quota = false,
				retryDelay = 0;
			let data: Prisma.PerformanceCaptureUpdateInput = {
				leaseOwner: null,
				leaseExpiresAt: null,
			};
			if (result.kind === "skip") skip = result.reason;
			else if (result.kind === "read") {
				const counts = result.videos.get(row.trackedVideo.platformPostId);
				if (!counts) skip = "video_unavailable";
				else
					data = {
						...data,
						state: "captured",
						capturedAt: at,
						apiVersion: result.apiVersion,
						views: counts.views,
						likes: counts.likes,
						comments: counts.comments,
						shares: counts.shares,
						saves: counts.saves,
						watchTimeSeconds: counts.watchTimeSeconds,
						raw: counts.raw as Prisma.InputJsonValue,
					};
			} else if (result.kind === "grant_unusable")
				skip =
					result.reason === "authentication_required"
						? "grant_expired"
						: "permission_missing";
			else {
				retry = true;
				quota = result.kind === "rate_limited" && result.dailyQuota === true;
				retryDelay =
					result.kind === "rate_limited" ? (result.retryAfterMs ?? 0) : 0;
				if (!quota && row.attempts + 1 >= 10) {
					retry = false;
					skip =
						result.kind === "rate_limited"
							? "rate_limited"
							: "provider_unavailable";
				}
			}
			if (skip) data = { ...data, state: "skipped", skipReason: skip };
			if (retry)
				data = {
					...data,
					...(!quota ? { attempts: { increment: 1 } } : {}),
					dueAt: new Date(
						at.getTime() +
							(quota
								? retryDelay
								: Math.max(
										retryDelay,
										Math.min(7200000, 120000 * 2 ** row.attempts),
									)),
					),
				};
			await tx.performanceCapture.update({ where: { id }, data });
			if (retry) await appendPerformanceCapture(tx, id);
			return takeExecutionDispatchIds(tx);
		});
	}
	async function captureRead(
		row: Capture,
		epoch: number,
	): Promise<PlatformReadResult | { kind: "skip"; reason: string }> {
		const accountId = row.trackedVideo.socialAccountId;
		if (!accountId) return { kind: "skip", reason: "account_disconnected" };
		try {
			const account = await options.accounts.getPublishAccount(accountId);
			if (
				!(await db.$transaction(async (tx) => {
					if (!(await ownedCapture(tx, row.id, row.leaseOwner!, epoch)))
						return false;
					return Boolean(
						await tx.socialAccount.findFirst({
							where: { id: accountId, status: "active" },
							select: { id: true },
						}),
					);
				}))
			)
				return { kind: "skip", reason: "account_disconnected" };
			return await PERFORMANCE_READERS[
				row.trackedVideo.platform as PerformancePlatform
			]({
				fetch: safeFetch,
				accessToken: account.accessToken,
				videoIds: [row.trackedVideo.platformPostId],
				now: new Date(),
			});
		} catch (error) {
			const code = (error as { code?: string })?.code;
			return code === "social_account_missing"
				? { kind: "skip", reason: "account_disconnected" }
				: [
							"social_account_expired",
							"social_account_refresh_missing",
							"social_account_refresh_unconfirmed",
						].includes(code ?? "")
					? { kind: "skip", reason: "grant_expired" }
					: { kind: "unavailable" };
		}
	}
	return {
		async dispatch(reference: ExecutionDispatchReference): Promise<{
			kind: "complete" | "superseded" | "sleep";
			dueAt?: Date;
			dispatchIds: string[];
		}> {
			const prepared = await db.$transaction(async (tx) => {
				const { epoch } = await readExecutionAdmission(tx);
				const ledger = await readExecutionDispatch(tx, reference.dispatchId);
				if (
					!isPublicationObservationReference(reference) ||
					epoch !== reference.deploymentEpoch ||
					!ledger ||
					!samePublicationDispatch(ledger.reference, reference)
				)
					return { kind: "superseded" as const, dispatchIds: [] };
				const at = await clock(tx);
				if (ledger.dueAt > at)
					return {
						kind: "sleep" as const,
						dueAt: ledger.dueAt,
						dispatchIds: [],
					};
				const restoration = restorePattern.exec(reference.subject.id);
				if (restoration) {
					const outcome = await executeExecutionPage(
						tx,
						reference,
						"maintenance-page",
						async () => {
							const post = await tx.socialPost.findUnique({
								where: { id: restoration[1] },
								select: { deploymentEpoch: true },
							});
							if (!post || post.deploymentEpoch !== epoch)
								return { kind: "complete", processed: 0, dispatchIds: [] };
							if (restoration[2] === "0")
								for (const receipt of await tx.providerReceipt.findMany({
									where: {
										attempt: { socialPostId: restoration[1] },
										platform: "youtube_shorts",
										enrichedAt: null,
										providerProcessingStatus: "processing",
									},
									select: { id: true },
									take: 1,
								}))
									await appendYouTubeReceiptEnrichment(tx, receipt.id);
							const videos = await tx.trackedVideo.findMany({
								where: {
									socialPostId: restoration[1],
									...(restoration[2] !== "0"
										? { id: { gt: restoration[2] } }
										: {}),
								},
								orderBy: { id: "asc" },
								take: 33,
								select: { id: true },
							});
							for (const video of videos.slice(0, 32))
								await append(tx, `po1.t.${video.id}`, new Date(0));
							if (videos.length > 32)
								await append(
									tx,
									`po1.r.${restoration[1]}.${videos[31]!.id}`,
									new Date(0),
								);
							return {
								kind: videos.length > 32 ? "continue" : "complete",
								processed: Math.min(32, videos.length),
								dispatchIds: takeExecutionDispatchIds(tx),
							};
						},
					);
					return {
						kind: "complete" as const,
						dispatchIds: outcome.dispatchIds,
					};
				}
				const tracking = trackingPattern.exec(reference.subject.id);
				if (tracking) {
					const outcome = await executeExecutionPage(
						tx,
						reference,
						"maintenance-page",
						async () => {
							const video = await tx.trackedVideo.findUnique({
								where: { id: tracking[1] },
							});
							if (!video)
								return { kind: "complete", processed: 0, dispatchIds: [] };
							for (const capture of await tx.performanceCapture.findMany({
								where: { trackedVideoId: video.id },
								orderBy: { slot: "asc" },
								take: 5,
							}))
								await appendPerformanceCapture(tx, capture.id);
							const enough = await tx.trackedVideo.findMany({
								where: { workspaceId: video.workspaceId },
								select: { id: true },
								take: MINIMUM_GUIDANCE_WORKSPACE_POSTS,
							});
							if (enough.length >= MINIMUM_GUIDANCE_WORKSPACE_POSTS)
								await appendPerformanceGuidance(tx, video.workspaceId);
							return {
								kind: "complete",
								processed: 1,
								dispatchIds: takeExecutionDispatchIds(tx),
							};
						},
					);
					return {
						kind: "complete" as const,
						dispatchIds: outcome.dispatchIds,
					};
				}
				const guidance = guidancePattern.exec(reference.subject.id);
				if (guidance) {
					const outcome = await executeExecutionPage(
						tx,
						reference,
						"maintenance-page",
						async () => {
							await tx.$queryRaw`SELECT "id" FROM "Workspace" WHERE "id"=${guidance[1]}::uuid FOR SHARE`;
							const workspace = await tx.workspace.findUnique({
								where: { id: guidance[1] },
							});
							if (!workspace)
								return { kind: "complete", processed: 0, dispatchIds: [] };
							const { measured } = await readComparedVideos(tx, workspace.id, {
								since: new Date(at.getTime() - GUIDANCE_WINDOW_DAYS * DAY),
							});
							const value = computePerformanceGuidance(measured);
							await tx.performanceGuidance.upsert({
								where: { workspaceId: workspace.id },
								create: {
									workspaceId: workspace.id,
									computedAt: at,
									attemptedAt: at,
									totalPosts: value.totalPosts,
									platforms: value.platforms as Prisma.InputJsonValue,
									groups: value.groups as Prisma.InputJsonValue,
								},
								update: {
									computedAt: at,
									attemptedAt: at,
									totalPosts: value.totalPosts,
									platforms: value.platforms as Prisma.InputJsonValue,
									groups: value.groups as Prisma.InputJsonValue,
								},
							});
							if (
								(
									await tx.trackedVideo.findMany({
										where: {
											workspaceId: workspace.id,
											publishedAt: {
												gte: new Date(
													at.getTime() - GUIDANCE_WINDOW_DAYS * DAY,
												),
											},
										},
										select: { id: true },
										take: MINIMUM_GUIDANCE_WORKSPACE_POSTS,
									})
								).length >= MINIMUM_GUIDANCE_WORKSPACE_POSTS
							)
								await appendPerformanceGuidance(
									tx,
									workspace.id,
									new Date(
										Math.max(
											Number(guidance[2]) + DAY,
											(Math.floor(at.getTime() / DAY) + 1) * DAY,
										),
									),
								);
							return {
								kind: "complete",
								processed: 1,
								dispatchIds: takeExecutionDispatchIds(tx),
							};
						},
					);
					return {
						kind: "complete" as const,
						dispatchIds: outcome.dispatchIds,
					};
				}
				const timer = watchPattern.exec(reference.subject.id),
					due = duePattern.exec(reference.subject.id)!;
				const kind = timer?.[1] ?? due[1]!,
					id = timer?.[2] ?? due[2]!;
				if (kind === "y") {
					const initial = await tx.providerReceipt.findUnique({
						where: { id },
						select: { attemptId: true },
					});
					if (!initial) return { kind: "complete" as const, dispatchIds: [] };
					await lockPublicationAttempt(tx, initial.attemptId);
					await tx.$queryRaw`SELECT "id" FROM "ProviderReceipt" WHERE "id"=${id}::uuid FOR UPDATE`;
					const row = await tx.providerReceipt.findUniqueOrThrow({
						where: { id },
						include: receiptInclude,
					});
					if (
						row.enrichedAt ||
						row.providerProcessingStatus !== "processing" ||
						row.attempt.socialPost.deploymentEpoch !== epoch
					)
						return { kind: "complete" as const, dispatchIds: [] };
					if (timer) {
						if (
							row.enrichmentClaimId !== timer[3] ||
							row.enrichmentLeaseExpiresAt?.getTime() !== Number(timer[4])
						)
							return {
								kind: "complete" as const,
								dispatchIds: await recover(tx, receiptId(row), epoch),
							};
						await tx.providerReceipt.update({
							where: { id },
							data: {
								enrichmentClaimId: null,
								enrichmentLeaseExpiresAt: null,
								enrichmentCheckCount: { increment: 1 },
								enrichmentNextCheckAt: at,
							},
						});
						await appendYouTubeReceiptEnrichment(tx, id);
						return {
							kind: "complete" as const,
							dispatchIds: takeExecutionDispatchIds(tx),
						};
					}
					if (receiptId(row) !== reference.subject.id)
						return {
							kind: "superseded" as const,
							dispatchIds: await recover(tx, receiptId(row), epoch),
						};
					if (row.enrichmentClaimId && row.enrichmentLeaseExpiresAt) {
						const watch = await append(
							tx,
							`po1.yw.${id}.${row.enrichmentClaimId}.${row.enrichmentLeaseExpiresAt.getTime()}`,
							row.enrichmentLeaseExpiresAt,
						);
						return { kind: "complete" as const, dispatchIds: [watch] };
					}
					if (
						row.enrichmentCheckCount >= 100 ||
						row.attempt.processingDeadline <= at ||
						!row.platformPostId ||
						!row.attempt.frozenState.socialAccountId
					) {
						await tx.providerReceipt.update({
							where: { id },
							data: {
								enrichedAt: at,
								providerProcessingStatus: "unknown",
								providerProcessingFailureCode:
									"youtube_processing_status_unknown",
								enrichmentNextCheckAt: null,
							},
						});
						await tx.socialPost.updateMany({
							where: { id: row.attempt.socialPostId, status: "posted" },
							data: {
								errorCode: "youtube_processing_status_unknown",
								errorDisposition: "attention",
							},
						});
						return { kind: "complete" as const, dispatchIds: [] };
					}
					const owner = randomUUID(),
						until = new Date(at.getTime() + 30000);
					await tx.providerReceipt.update({
						where: { id },
						data: { enrichmentClaimId: owner, enrichmentLeaseExpiresAt: until },
					});
					const watch = await append(
						tx,
						`po1.yw.${id}.${owner}.${until.getTime()}`,
						until,
					);
					return {
						kind: "receipt" as const,
						row: {
							...row,
							enrichmentClaimId: owner,
							enrichmentLeaseExpiresAt: until,
						},
						dispatchIds: [watch],
					};
				}
				const row = await tx.performanceCapture.findUnique({
					where: { id },
					include: { trackedVideo: true },
				});
				if (!row) return { kind: "complete" as const, dispatchIds: [] };
				await tx.$queryRaw`SELECT "id" FROM "Workspace" WHERE "id"=${row.trackedVideo.workspaceId}::uuid FOR SHARE`;
				await tx.$queryRaw`SELECT "id" FROM "PerformanceCapture" WHERE "id"=${id}::uuid FOR UPDATE`;
				const current = await tx.performanceCapture.findUniqueOrThrow({
					where: { id },
					include: { trackedVideo: true },
				});
				if (current.state !== "scheduled")
					return { kind: "complete" as const, dispatchIds: [] };
				if (timer) {
					if (
						current.leaseOwner !== timer[3] ||
						current.leaseExpiresAt?.getTime() !== Number(timer[4])
					)
						return {
							kind: "complete" as const,
							dispatchIds: await recover(tx, captureId(current), epoch),
						};
					await tx.performanceCapture.update({
						where: { id },
						data: {
							leaseOwner: null,
							leaseExpiresAt: null,
							attempts: { increment: 1 },
							...(current.attempts + 1 >= 10
								? { state: "skipped", skipReason: "provider_unavailable" }
								: { dueAt: at }),
						},
					});
					await appendPerformanceCapture(tx, id);
					return {
						kind: "complete" as const,
						dispatchIds: takeExecutionDispatchIds(tx),
					};
				}
				if (captureId(current) !== reference.subject.id)
					return {
						kind: "superseded" as const,
						dispatchIds: await recover(tx, captureId(current), epoch),
					};
				if (current.leaseOwner && current.leaseExpiresAt) {
					const watch = await append(
						tx,
						`po1.cw.${id}.${current.leaseOwner}.${current.leaseExpiresAt.getTime()}`,
						current.leaseExpiresAt,
					);
					return { kind: "complete" as const, dispatchIds: [watch] };
				}
				await tx.performanceCapture.updateMany({
					where: {
						trackedVideoId: current.trackedVideoId,
						state: "scheduled",
						slot: { lt: current.slot },
						dueAt: { lte: at },
						OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: at } }],
					},
					data: {
						state: "skipped",
						skipReason: "missed",
						leaseOwner: null,
						leaseExpiresAt: null,
					},
				});
				const newer = await tx.performanceCapture.findFirst({
					where: {
						trackedVideoId: current.trackedVideoId,
						state: "scheduled",
						slot: { gt: current.slot },
						dueAt: { lte: at },
					},
					select: { id: true },
				});
				if (newer) {
					await tx.performanceCapture.update({
						where: { id },
						data: { state: "skipped", skipReason: "missed" },
					});
					return { kind: "complete" as const, dispatchIds: [] };
				}
				if (current.attempts >= 10) {
					await tx.performanceCapture.update({
						where: { id },
						data: { state: "skipped", skipReason: "provider_unavailable" },
					});
					return { kind: "complete" as const, dispatchIds: [] };
				}
				const owner = randomUUID(),
					until = new Date(at.getTime() + 180000);
				await tx.performanceCapture.update({
					where: { id },
					data: { leaseOwner: owner, leaseExpiresAt: until },
				});
				const watch = await append(
					tx,
					`po1.cw.${id}.${owner}.${until.getTime()}`,
					until,
				);
				return {
					kind: "capture" as const,
					row: { ...current, leaseOwner: owner, leaseExpiresAt: until },
					dispatchIds: [watch],
				};
			});
			await options.register(prepared.dispatchIds);
			if (prepared.kind !== "receipt" && prepared.kind !== "capture")
				return prepared;
			const ids =
				prepared.kind === "receipt"
					? await finishReceipt(
							prepared.row.id,
							prepared.row.enrichmentClaimId!,
							reference.deploymentEpoch,
							await receiptRead(prepared.row),
						)
					: await finishCapture(
							prepared.row.id,
							prepared.row.leaseOwner!,
							reference.deploymentEpoch,
							await captureRead(prepared.row, reference.deploymentEpoch),
						);
			await options.register(ids);
			return { kind: "complete", dispatchIds: ids };
		},
	};
}

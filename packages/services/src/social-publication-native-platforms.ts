import type { SocialPlatform } from "@narriflow/validators";
import type {
	PublicationOperationPhase,
	PublicationPlatform,
	PublicationPlatformContext,
	PublicationPlatformInput,
	PublicationPlatformResult,
	PublicationProviderOperation,
} from "./social-publication-platform";
import { structuredSocialPublicationMetrics } from "./social-publication-observability";
import type { SocialPublicationMetrics } from "./social-publication-observability";
import {
	PublicationPlatformConfigurationError,
	createPublicationPlatformRegistry,
} from "./social-publication-platform";
import { SOCIAL_PROVIDER_CAPABILITIES } from "./social-publication-config";

export type NativePublicationMedia = {
	sizeBytes: number;
	fileName: string;
	blob(start?: number, endExclusive?: number): Promise<Blob>;
	cleanup(): Promise<void>;
};

export type NativePublicationDependencies = {
	fetch: typeof fetch;
	media: {
		materialize(
			input: PublicationPlatformInput["media"],
		): Promise<NativePublicationMedia>;
		createScopedAccess(
			input: PublicationPlatformInput["media"],
		): Promise<string>;
	};
	clock: { now(): Date };
	metrics?: SocialPublicationMetrics;
	config: {
		youtubeApiVersion: string;
		youtubeChunkBytes: number;
		metaGraphVersion: string;
		linkedInVersion: string;
		instagramPollAttempts: number;
		instagramPollIntervalMs: number;
		facebookReelsPublishingEnabled?: boolean;
		tiktokPollIntervalMs: number;
		tiktokChunkBytes: number;
		tiktokApiVersion: string;
		xApiVersion: string;
		xChunkBytes: number;
		xMaxMediaBytes: number;
		xRateLimitRetryFloorMs: number;
		xReconciliationMaxPages: number;
	};
};

function providerOperationClass(url: string, init?: RequestInit) {
	const method = init?.method?.toUpperCase() ?? "GET";
	if (/\/initialize(?:\?|$)|initializeUpload/.test(url)) return "initialize";
	if (/\/finalize(?:\?|$)|finalizeUpload/.test(url)) return "finalize";
	if (/\/append(?:\?|$)|\/upload(?:\/|\?|$)/.test(url)) return "upload";
	if (
		/status|creator_info|publishing_limit|\/videos\?|\/media\?/.test(url)
	) {
		return "status";
	}
	if (method === "POST" && /media_publish|\/tweets$|\/posts$|video\/init/.test(url)) {
		return "submission";
	}
	if (method === "PUT") return "upload";
	if (method === "GET") return "reconciliation";
	return "provider_request";
}

function facebookReelsPlatform(
	dependencies: NativePublicationDependencies,
): PublicationPlatform {
	type FacebookReelStatus = {
		status?: {
			video_status?: string;
			uploading_phase?: { status?: string };
			processing_phase?: { status?: string };
			publishing_phase?: { status?: string; publish_status?: string };
		};
	};
	const processingOperation = (videoId: string): PublicationProviderOperation => ({
		kind: "facebook_reel_processing",
		state: { videoId },
	});
	const processingResult = (videoId: string): PublicationPlatformResult => ({
		kind: "pending",
		receiptId: videoId,
		operation: processingOperation(videoId),
		nextCheckAt: pendingAt(dependencies, 15_000),
		submissionStarted: true,
	});
	const statusOutcome = (value: FacebookReelStatus) => {
		const status = value.status;
		if (!status) return "invalid" as const;
		const values = [
			status.video_status,
			status.uploading_phase?.status,
			status.processing_phase?.status,
			status.publishing_phase?.status,
			status.publishing_phase?.publish_status,
		].filter((entry): entry is string => typeof entry === "string")
			.map((entry) => entry.toLowerCase());
		if (values.some((entry) => ["error", "failed", "expired"].includes(entry))) {
			return "failed" as const;
		}
		const publishingComplete = status.publishing_phase?.status?.toLowerCase() === "complete";
		const published = status.publishing_phase?.publish_status?.toLowerCase() === "published";
		const processingComplete = status.processing_phase?.status?.toLowerCase() === "complete";
		const videoReady = ["ready", "published"].includes(status.video_status?.toLowerCase() ?? "");
		if (publishingComplete && published && processingComplete && videoReady) return "published" as const;
		const videoStatus = status.video_status?.toLowerCase() ?? "";
		const hasSubmissionEvidence = Boolean(status.processing_phase || status.publishing_phase) ||
			["processing", "ready", "published"].includes(videoStatus);
		return hasSubmissionEvidence ? "processing" as const : "unsubmitted" as const;
	};
	const hasPublishingEvidence = (value: FacebookReelStatus) => {
		const phaseStatus = value.status?.publishing_phase?.status?.toLowerCase();
		const publishStatus = value.status?.publishing_phase?.publish_status?.toLowerCase();
		return value.status?.video_status?.toLowerCase() === "published" ||
			Boolean(phaseStatus && !["not_started", "not started"].includes(phaseStatus)) ||
			Boolean(publishStatus && !["not_started", "not started"].includes(publishStatus));
	};
	const accepted = (videoId: string): PublicationPlatformResult => ({
		kind: "accepted",
		receipt: {
			receiptId: videoId,
			platformPostId: videoId,
			externalUrl: null,
			metrics: null,
			providerProcessingStatus: "succeeded",
		},
	});
	const assertPublishingEnabled = () => {
		if (!dependencies.config.facebookReelsPublishingEnabled) {
			throw new PublicationPlatformConfigurationError(
				"facebook_reels_rollout_disabled",
				"Facebook Reels publishing is awaiting provider sandbox evidence",
			);
		}
	};
	const uploadAndPublish = async (
		input: PublicationPlatformInput,
		context: PublicationPlatformContext,
		videoId: string,
		uploadUrl: string,
		markSubmitted: () => void,
	): Promise<PublicationPlatformResult> => {
		assertPublishingEnabled();
		const account = requireAccount(input, "facebook_reels");
		requireScopes(account, SOCIAL_PROVIDER_CAPABILITIES.facebook_reels.requiredScopes);
		const duration = SOCIAL_PROVIDER_CAPABILITIES.facebook_reels.durationSec;
		if (input.media.durationSec < duration.min || input.media.durationSec > duration.max) {
			throw new PublicationPlatformConfigurationError(
				"facebook_reel_duration_invalid",
				`Facebook Reel duration must be between ${duration.min} and ${duration.max} seconds`,
			);
		}
		const fileUrl = await dependencies.media.createScopedAccess(input.media);
		// Meta's official Reels Publishing flow: start an upload session, send
		// the hosted file to its upload_url, then finish with PUBLISHED.
		// https://www.postman.com/meta/facebook/documentation/r56bjfd/facebook-api
		await jsonRequest<Record<string, unknown>>(
			dependencies,
			context,
			uploadUrl,
			{
				method: "POST",
				headers: { Authorization: `OAuth ${account.accessToken}`, file_url: fileUrl },
				signal: context.signal,
			},
			"facebook_reel_upload_failed",
			"upload",
		);
		await context.checkpoint({
			kind: "facebook_reel_finish_pending",
			state: { videoId },
		});
		return finishPublish(input, context, videoId, markSubmitted);
	};
	const finishPublish = async (
		input: PublicationPlatformInput,
		context: PublicationPlatformContext,
		videoId: string,
		markSubmitted: () => void,
	): Promise<PublicationPlatformResult> => {
		const account = requireAccount(input, "facebook_reels");
		markSubmitted();
		try {
			await jsonRequest<Record<string, unknown>>(
				dependencies,
				context,
				`https://graph.facebook.com/${dependencies.config.metaGraphVersion}/${account.providerAccountId}/video_reels`,
				{
					method: "POST",
					headers: { "Content-Type": "application/x-www-form-urlencoded" },
					body: new URLSearchParams({
						upload_phase: "finish",
						video_state: "PUBLISHED",
						video_id: videoId,
						description: input.caption,
						access_token: account.accessToken,
					}),
					signal: context.signal,
				},
				"facebook_reel_publish_failed",
				"submission",
			);
			await context.checkpoint({
				kind: "submission_started",
				state: { providerOperation: "facebook_reel_processing", videoId },
			});
		} catch (error) {
			const failure = normalizedFailure(error, true);
			return failure.kind === "unknown"
				? { ...failure, operation: processingOperation(videoId) }
				: failure;
		}
		return processingResult(videoId);
	};

	return {
		capabilities: {
			recovery: "bounded",
			asynchronous: true,
			idempotency: "narriflow",
			requiredScopes: [...SOCIAL_PROVIDER_CAPABILITIES.facebook_reels.requiredScopes],
			capabilityVersion: SOCIAL_PROVIDER_CAPABILITIES.facebook_reels.version,
			apiVersion: dependencies.config.metaGraphVersion,
			// The worker-level provider budget remains the hard ceiling. This
			// platform ceiling must leave room for repeated processing polls after
			// the three-call start/upload/finish handshake.
			maxProviderCalls: 100,
		},
		publish(input, context) {
			return withNativeOutcome(async (markSubmitted) => {
				assertPublishingEnabled();
				const account = requireAccount(input, "facebook_reels");
				requireScopes(account, this.capabilities.requiredScopes);
				const started = await jsonRequest<{ video_id?: string; upload_url?: string }>(
					dependencies,
					context,
					`https://graph.facebook.com/${dependencies.config.metaGraphVersion}/${account.providerAccountId}/video_reels`,
					{
						method: "POST",
						headers: { "Content-Type": "application/x-www-form-urlencoded" },
						body: new URLSearchParams({ upload_phase: "start", access_token: account.accessToken }),
						signal: context.signal,
					},
					"facebook_reel_start_failed",
					"preparation",
				);
				if (!started.video_id || !started.upload_url) {
					throw new ProviderHttpError("facebook_reel_upload_session_missing", "preparation", 502, null);
				}
				await context.checkpoint({ kind: "facebook_reel_upload", state: { videoId: started.video_id, uploadUrl: started.upload_url } });
				return uploadAndPublish(input, context, started.video_id, started.upload_url, markSubmitted);
			});
		},
		resume(input, operation, context) {
			return withNativeOutcome(async (markSubmitted) => {
				assertPublishingEnabled();
				const videoId = operationString(operation.state, "videoId");
				if (operation.kind === "facebook_reel_finish_pending" && videoId) {
					const account = requireAccount(input, "facebook_reels");
					requireScopes(account, this.capabilities.requiredScopes);
					const status = await jsonRequest<FacebookReelStatus>(
						dependencies,
						context,
						`https://graph.facebook.com/${dependencies.config.metaGraphVersion}/${encodeURIComponent(videoId)}?${new URLSearchParams({ fields: "status", access_token: account.accessToken })}`,
						{ method: "GET", signal: context.signal },
						"facebook_reel_status_failed",
						"reconciliation",
					);
					const outcome = statusOutcome(status);
					if (outcome === "published") {
						markSubmitted();
						return accepted(videoId);
					}
					if (hasPublishingEvidence(status)) {
						markSubmitted();
						return processingResult(videoId);
					}
					if (outcome === "failed") {
						return { kind: "failed", failure: { code: "facebook_reel_processing_failed", phase: "reconciliation", disposition: "attention", retryAfterMs: null } };
					}
					return finishPublish(input, context, videoId, markSubmitted);
				}
				const uploadUrl = operationString(operation.state, "uploadUrl");
				if (!videoId || !uploadUrl) {
					return { kind: "failed", failure: { code: "facebook_reel_upload_session_missing", phase: "preparation", disposition: "permanent", retryAfterMs: null } };
				}
				return uploadAndPublish(input, context, videoId, uploadUrl, markSubmitted);
			});
		},
		reconcile(input, operation, context) {
			return withNativeOutcome(async (markSubmitted) => {
				assertPublishingEnabled();
				const account = requireAccount(input, "facebook_reels");
				requireScopes(account, this.capabilities.requiredScopes);
				const videoId = operationString(operation.state, "videoId");
				if ((operation.kind !== "facebook_reel_processing" && operation.kind !== "submission_started") || !videoId) {
					return {
						kind: "failed",
						failure: {
							code: "facebook_reel_checkpoint_invalid",
							phase: "reconciliation",
							disposition: "attention",
							retryAfterMs: null,
						},
					};
				}
				markSubmitted();
				const status = await jsonRequest<FacebookReelStatus>(
					dependencies,
					context,
					`https://graph.facebook.com/${dependencies.config.metaGraphVersion}/${encodeURIComponent(videoId)}?${new URLSearchParams({ fields: "status", access_token: account.accessToken })}`,
					{ method: "GET", signal: context.signal },
					"facebook_reel_status_failed",
					"reconciliation",
				);
				const outcome = statusOutcome(status);
				if (outcome === "published") return accepted(videoId);
				if (outcome === "processing") return processingResult(videoId);
				return {
					kind: "failed",
					failure: {
						code: outcome === "failed"
							? "facebook_reel_processing_failed"
							: "facebook_reel_status_invalid",
						phase: "reconciliation",
						disposition: "attention",
						retryAfterMs: null,
					},
				};
			});
		},
	};
}

function withProviderLatency(
	dependencies: NativePublicationDependencies,
	platform: SocialPlatform,
): NativePublicationDependencies {
	if (!dependencies.metrics) return dependencies;
	return {
		...dependencies,
		fetch: async (input, init) => {
			const url = String(input);
			const startedAt = performance.now();
			let outcome = "error";
			try {
				const response = await dependencies.fetch(input, init);
				outcome = response.ok ? "succeeded" : "http_error";
				return response;
			} finally {
				dependencies.metrics?.observe(
					"social_publication_provider_operation_duration_ms",
					Math.max(0, performance.now() - startedAt),
					{
						platform,
						operation: providerOperationClass(url, init),
						outcome,
					},
				);
			}
		},
	};
}

function xApiVersion(dependencies: NativePublicationDependencies) {
	return dependencies.config.xApiVersion.replace(/^v/, "");
}

class ProviderHttpError extends Error {
	constructor(
		readonly code: string,
		readonly phase: PublicationOperationPhase,
		readonly status: number,
		readonly retryAfterMs: number | null,
	) {
		super(code);
		this.name = "ProviderHttpError";
	}
}

function retryAfterMs(response: Response, now: Date) {
	const value = response.headers.get("retry-after");
	if (!value) return null;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
	const date = Date.parse(value);
	return Number.isFinite(date) ? Math.max(0, date - now.getTime()) : null;
}

function xRetryAfterMs(
	dependencies: NativePublicationDependencies,
	response: Response,
) {
	const providerRetryAfterMs = retryAfterMs(
		response,
		dependencies.clock.now(),
	);
	return response.status === 429
		? Math.max(
				providerRetryAfterMs ?? 0,
				dependencies.config.xRateLimitRetryFloorMs,
			)
		: providerRetryAfterMs;
}

async function jsonRequest<T>(
	dependencies: NativePublicationDependencies,
	context: Pick<PublicationPlatformContext, "providerCall">,
	url: string,
	init: RequestInit,
	errorCode: string,
	phase: PublicationOperationPhase,
): Promise<T> {
	await context.providerCall?.();
	const response = await dependencies.fetch(url, init);
	if (!response.ok) {
		const providerRetryAfterMs = errorCode.startsWith("x_")
			? xRetryAfterMs(dependencies, response)
			: retryAfterMs(response, dependencies.clock.now());
		throw new ProviderHttpError(
			errorCode,
			phase,
			response.status,
			providerRetryAfterMs,
		);
	}
	try {
		return (await response.json()) as T;
	} catch {
		throw new ProviderHttpError(
			`${errorCode}_response_invalid`,
			phase,
			502,
			null,
		);
	}
}

function metadata(input: PublicationPlatformInput) {
	return input.providerSettings as Record<string, unknown>;
}

function accountMetadata(input: PublicationPlatformInput) {
	const value = input.account?.metadata;
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function stringSetting(
	source: Record<string, unknown>,
	keys: readonly string[],
	fallback: string | null = null,
) {
	for (const key of keys) {
		const value = source[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return fallback;
}

function booleanSetting(
	source: Record<string, unknown>,
	keys: readonly string[],
	fallback = false,
) {
	for (const key of keys) {
		const value = source[key];
		if (typeof value === "boolean") return value;
	}
	return fallback;
}

function truncate(value: string, maximum: number) {
	return value.length <= maximum
		? value
		: value.slice(0, maximum - 1).trimEnd();
}

function title(input: PublicationPlatformInput) {
	return truncate(
		input.caption.split(/\r?\n/)[0]?.trim() || "Narriflow clip",
		95,
	);
}

function requireAccount(
	input: PublicationPlatformInput,
	platform: SocialPlatform,
) {
	if (!input.account) {
		throw new PublicationPlatformConfigurationError(
			"social_account_missing",
			"The frozen publication intent does not reference a connected account",
		);
	}
	if (input.account.platform !== platform || input.platform !== platform) {
		throw new PublicationPlatformConfigurationError(
			"social_account_platform_mismatch",
			"The connected account does not match the frozen publication platform",
		);
	}
	return input.account;
}

function requireScopes(
	account: NonNullable<PublicationPlatformInput["account"]>,
	required: readonly string[],
) {
	const missing = required.filter((scope) => !account.scopes.includes(scope));
	if (missing.length > 0) {
		throw new PublicationPlatformConfigurationError(
			"social_account_scope_missing",
			"The connected account does not grant the publication permissions required by this provider",
		);
	}
}

function operationString(
	state: Record<string, unknown>,
	key: string,
): string | null {
	const value = state[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

function operationNumber(
	state: Record<string, unknown>,
	key: string,
): number | null {
	const value = state[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function pendingAt(
	dependencies: NativePublicationDependencies,
	delayMs: number,
) {
	return new Date(dependencies.clock.now().getTime() + Math.max(1, delayMs));
}

function normalizedFailure(
	error: unknown,
	submitted: boolean,
): PublicationPlatformResult {
	if (
		error &&
		typeof error === "object" &&
		"code" in error &&
		error.code === "publication_claim_lost"
	) {
		throw error;
	}
	if (error instanceof DOMException && error.name === "AbortError") throw error;
	const providerCode =
		error instanceof ProviderHttpError
			? error.code === "youtube_quota_exceeded"
				? error.code
				: error.status === 404 && error.code.startsWith("x_media_")
					? "x_media_expired"
				: error.status === 401
				? `${error.code.split("_")[0]}_authentication_required`
				: error.status === 403
					? `${error.code.split("_")[0]}_permission_required`
					: error.status === 429
						? `${error.code.split("_")[0]}_rate_limit`
						: error.code
			: null;
	if (submitted) {
		return {
			kind: "unknown",
			code: providerCode ?? "social_provider_response_lost",
			phase: error instanceof ProviderHttpError ? error.phase : "submission",
			operation: null,
			retryAfterMs:
				error instanceof ProviderHttpError ? error.retryAfterMs : null,
		};
	}
	if (error instanceof ProviderHttpError) {
		const safeRetry =
			error.status === 408 ||
			error.status === 429 ||
			error.status >= 500 ||
			providerCode === "x_media_expired";
		return {
			kind: "failed",
			failure: {
				code: providerCode!,
				phase: error.phase,
				disposition: safeRetry ? "safe_retry" : "permanent",
				retryAfterMs: safeRetry ? error.retryAfterMs : null,
			},
		};
	}
	const code =
		error instanceof PublicationPlatformConfigurationError
			? error.code
			: "social_provider_failed";
	return {
		kind: "failed",
		failure: {
			code,
			phase: "preparation",
			disposition:
				error instanceof PublicationPlatformConfigurationError
					? "permanent"
					: "safe_retry",
			retryAfterMs: null,
		},
	};
}

async function withNativeOutcome(
	operation: (markSubmitted: () => void) => Promise<PublicationPlatformResult>,
) {
	let submitted = false;
	try {
		return await operation(() => {
			submitted = true;
		});
	} catch (error) {
		if (
			error !== null &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "publication_provider_call_budget_exhausted"
		) {
			throw error;
		}
		return normalizedFailure(error, submitted);
	}
}

async function cleanupMaterializedMedia(
	media: NativePublicationMedia,
	input: PublicationPlatformInput,
) {
	try {
		await media.cleanup();
		structuredSocialPublicationMetrics.observe(
			"social_publication_cleanup_total",
			1,
			{ platform: input.platform, outcome: "succeeded" },
		);
	} catch {
		console.warn(
			JSON.stringify({
				level: "warn",
				message: "social_publication_media_cleanup_failed",
				attemptId: input.attemptId,
				platform: input.platform,
			}),
		);
		structuredSocialPublicationMetrics.observe(
			"social_publication_cleanup_total",
			1,
			{ platform: input.platform, outcome: "failed" },
		);
	}
}

type YouTubeVideoResource = {
	id?: string;
	status?: {
		uploadStatus?: string;
		failureReason?: string;
		rejectionReason?: string;
		privacyStatus?: string;
	};
};

function youtubeReceipt(resource: YouTubeVideoResource): PublicationPlatformResult {
	const videoId = resource.id!;
	const uploadStatus = resource.status?.uploadStatus;
	const processingFailed =
		uploadStatus === "failed" ||
		uploadStatus === "rejected" ||
		uploadStatus === "deleted";
	return {
		kind: "accepted",
		receipt: {
			receiptId: videoId,
			platformPostId: videoId,
			externalUrl: `https://www.youtube.com/watch?v=${videoId}`,
			metrics: null,
			providerProcessingStatus:
				uploadStatus === "processed"
					? "succeeded"
					: processingFailed
						? "failed"
						: "processing",
			providerProcessingFailureCode: processingFailed
				? "youtube_processing_failed"
				: null,
			providerVisibility: resource.status?.privacyStatus ?? null,
		},
	};
}

function youtubeUploadedBytes(range: string | null) {
	if (!range) return 0;
	const match = /^bytes=0-(\d+)$/.exec(range.trim());
	if (!match) return null;
	const finalByte = Number(match[1]);
	return Number.isSafeInteger(finalByte) ? finalByte + 1 : null;
}

async function youtubeCompletedResponse(response: Response) {
	try {
		const body = (await response.json()) as YouTubeVideoResource;
		return body.id ? body : null;
	} catch {
		return null;
	}
}

async function youtubeFailureCode(response: Response, fallback: string) {
	if (response.status !== 403) return fallback;
	try {
		const body = (await response.clone().json()) as {
			error?: { errors?: Array<{ reason?: string }> };
		};
		const reason = body.error?.errors?.[0]?.reason;
		if (
			reason === "quotaExceeded" ||
			reason === "dailyLimitExceeded" ||
			reason === "uploadLimitExceeded"
		) {
			return "youtube_quota_exceeded";
		}
	} catch {
		// The stable fallback is safer than retaining an arbitrary provider body.
	}
	return fallback;
}

async function continueYoutubeUpload(
	dependencies: NativePublicationDependencies,
	input: PublicationPlatformInput,
	context: PublicationPlatformContext,
	state: Record<string, unknown>,
	probe: boolean,
): Promise<PublicationPlatformResult> {
	const account = requireAccount(input, "youtube_shorts");
	requireScopes(account, ["https://www.googleapis.com/auth/youtube.upload"]);
	const uploadUrl = operationString(state, "uploadUrl");
	const totalBytes = operationNumber(state, "totalBytes") ?? input.media.sizeBytes;
	if (!uploadUrl || totalBytes !== input.media.sizeBytes) {
		return {
			kind: "unknown",
			code: "youtube_upload_checkpoint_invalid",
			phase: "reconciliation",
			operation: null,
		};
	}
	const media = await dependencies.media.materialize(input.media);
	try {
		let uploadedBytes = operationNumber(state, "uploadedBytes") ?? 0;
		if (probe) {
			await context.providerCall?.();
			const status = await dependencies.fetch(uploadUrl, {
				method: "PUT",
				headers: {
					Authorization: `Bearer ${account.accessToken}`,
					"Content-Length": "0",
					"Content-Range": `bytes */${totalBytes}`,
				},
				signal: context.signal,
			});
			if (status.ok) {
				const video = await youtubeCompletedResponse(status);
				if (!video) {
					throw new ProviderHttpError(
						"youtube_video_id_missing",
						"reconciliation",
						502,
						null,
					);
				}
				return youtubeReceipt(video);
			}
			if (status.status === 404) {
				return {
					kind: "failed",
					failure: {
						code: "youtube_upload_session_expired",
						phase: "reconciliation",
						disposition: "safe_retry",
						retryAfterMs: null,
						safeToRepublishAfterSubmission: true,
					},
				};
			}
			if (status.status !== 308) {
				throw new ProviderHttpError(
					await youtubeFailureCode(status, "youtube_upload_status_failed"),
					"reconciliation",
					status.status,
					retryAfterMs(status, dependencies.clock.now()),
				);
			}
			const providerBytes = youtubeUploadedBytes(status.headers.get("range"));
			if (providerBytes === null || providerBytes > totalBytes) {
				throw new ProviderHttpError(
					"youtube_upload_range_invalid",
					"reconciliation",
					502,
					null,
				);
			}
			uploadedBytes = providerBytes;
		}

		while (uploadedBytes < totalBytes) {
			const end = Math.min(
				uploadedBytes + dependencies.config.youtubeChunkBytes,
				totalBytes,
			);
			await context.providerCall?.();
			const response = await dependencies.fetch(uploadUrl, {
				method: "PUT",
				headers: {
					Authorization: `Bearer ${account.accessToken}`,
					"Content-Type": "video/mp4",
					"Content-Length": String(end - uploadedBytes),
					"Content-Range": `bytes ${uploadedBytes}-${end - 1}/${totalBytes}`,
				},
				body: await media.blob(uploadedBytes, end),
				signal: context.signal,
			});
			if (response.ok) {
				const video = await youtubeCompletedResponse(response);
				if (!video) {
					throw new ProviderHttpError(
						"youtube_video_id_missing",
						"submission",
						502,
						null,
					);
				}
				return youtubeReceipt(video);
			}
			if (response.status !== 308) {
				throw new ProviderHttpError(
					await youtubeFailureCode(response, "youtube_upload_failed"),
					"upload",
					response.status,
					retryAfterMs(response, dependencies.clock.now()),
				);
			}
			const providerBytes = youtubeUploadedBytes(response.headers.get("range"));
			if (providerBytes === null || providerBytes < end || providerBytes > totalBytes) {
				throw new ProviderHttpError(
					"youtube_upload_range_invalid",
					"upload",
					502,
					null,
				);
			}
			uploadedBytes = providerBytes;
			await context.checkpoint({
				kind: "submission_started",
				state: {
					providerOperation: "youtube_resumable_upload",
					uploadUrl,
					uploadedBytes,
					totalBytes,
				},
			});
		}
		throw new ProviderHttpError(
			"youtube_upload_completion_missing",
			"submission",
			502,
			null,
		);
	} finally {
		await cleanupMaterializedMedia(media, input);
	}
}

function youtubePlatform(
	dependencies: NativePublicationDependencies,
): PublicationPlatform {
	return {
		capabilities: {
			recovery: "exact",
			asynchronous: true,
			idempotency: "none",
			requiredScopes: ["https://www.googleapis.com/auth/youtube.upload"],
			capabilityVersion: SOCIAL_PROVIDER_CAPABILITIES.youtube_shorts.version,
			apiVersion: `youtube-${dependencies.config.youtubeApiVersion}`,
			maxProviderCalls: 100,
		},
		publish(input, context) {
			return withNativeOutcome(async (markSubmitted) => {
				const account = requireAccount(input, "youtube_shorts");
				requireScopes(account, this.capabilities.requiredScopes);
				const settings = metadata(input);
				const videoTitle = stringSetting(settings, ["title"], title(input))!;
				const categoryId = stringSetting(settings, ["youtubeCategoryId"], "22")!;
				if (
					input.media.sizeBytes <= 0 ||
					input.caption.length > 5_000 ||
					videoTitle.length < 1 ||
					videoTitle.length > 100 ||
					!/^\d+$/.test(categoryId)
				) {
					throw new PublicationPlatformConfigurationError(
						"youtube_publication_invalid",
						"YouTube publication settings or media facts are invalid",
					);
				}
					const requestedPrivacy = stringSetting(
						settings,
						["youtubePrivacyStatus", "privacyStatus"],
						"public",
					)!;
					if (!["private", "public", "unlisted"].includes(requestedPrivacy)) {
						throw new PublicationPlatformConfigurationError(
							"youtube_privacy_invalid",
							"YouTube privacy must be private, public, or unlisted",
						);
					}
					const privacyStatus = booleanSetting(
						accountMetadata(input),
						["auditEnforcedPrivate", "forcePrivateUploads"],
						false,
					)
						? "private"
						: requestedPrivacy;
					await context.providerCall?.();
					const init = await dependencies.fetch(
						`https://www.googleapis.com/upload/youtube/${dependencies.config.youtubeApiVersion}/videos?uploadType=resumable&part=snippet,status`,
						{
							method: "POST",
							headers: {
								Authorization: `Bearer ${account.accessToken}`,
								"Content-Type": "application/json; charset=UTF-8",
								"X-Upload-Content-Type": "video/mp4",
								"X-Upload-Content-Length": String(input.media.sizeBytes),
							},
							body: JSON.stringify({
								snippet: {
									title: videoTitle,
									description: input.caption,
									categoryId,
								},
								status: {
									privacyStatus,
									selfDeclaredMadeForKids: booleanSetting(
										settings,
										["selfDeclaredMadeForKids"],
										false,
									),
								},
							}),
							signal: context.signal,
						},
					);
					const uploadUrl = init.headers.get("location");
					if (!init.ok || !uploadUrl) {
						throw new ProviderHttpError(
							await youtubeFailureCode(init, "youtube_upload_init_failed"),
							"preparation",
							init.status,
							retryAfterMs(init, dependencies.clock.now()),
						);
					}
					const state = {
						providerOperation: "youtube_resumable_upload",
						uploadUrl,
						uploadedBytes: 0,
						totalBytes: input.media.sizeBytes,
					};
					await context.checkpoint({ kind: "submission_started", state });
					markSubmitted();
				return continueYoutubeUpload(
						dependencies,
						input,
						context,
						state,
						false,
				);
			});
		},
		reconcile(input, operation, context) {
			return withNativeOutcome(async (markSubmitted) => {
				markSubmitted();
				return continueYoutubeUpload(
					dependencies,
					input,
					context,
					operation.state,
					true,
				);
			});
		},
	};
}

async function instagramContainerStatus(
	dependencies: NativePublicationDependencies,
	context: PublicationPlatformContext,
	accessToken: string,
	containerId: string,
	signal: AbortSignal,
) {
	const result = await jsonRequest<{ status_code?: string }>(
			dependencies,
			context,
			`https://graph.facebook.com/${dependencies.config.metaGraphVersion}/${containerId}?${new URLSearchParams(
				{
					fields: "status_code,status",
					access_token: accessToken,
				},
			)}`,
			{ method: "GET", signal },
			"instagram_container_status_failed",
			"preparation",
		);
	const status = result.status_code;
	if (
		status !== "IN_PROGRESS" &&
		status !== "FINISHED" &&
		status !== "PUBLISHED" &&
		status !== "ERROR" &&
		status !== "EXPIRED"
	) {
		throw new ProviderHttpError(
			"instagram_container_status_invalid",
			"reconciliation",
			502,
			null,
		);
	}
	return status;
}

function instagramAccepted(
	containerId: string,
	mediaId: string | null,
	externalUrl: string | null = null,
): PublicationPlatformResult {
	return {
		kind: "accepted",
		receipt: {
			receiptId: containerId,
			platformPostId: mediaId,
			externalUrl,
			metrics: null,
		},
	};
}

async function instagramPermalink(
	dependencies: NativePublicationDependencies,
	context: PublicationPlatformContext,
	accessToken: string,
	mediaId: string,
) {
	try {
		const details = await jsonRequest<{ permalink?: string }>(
			dependencies,
			context,
			`https://graph.facebook.com/${dependencies.config.metaGraphVersion}/${mediaId}?${new URLSearchParams(
				{ fields: "permalink", access_token: accessToken },
			)}`,
			{ method: "GET", signal: context.signal },
			"instagram_permalink_failed",
			"reconciliation",
		);
		return details.permalink ?? null;
	} catch {
		return null;
	}
}

function instagramPlatform(
	dependencies: NativePublicationDependencies,
): PublicationPlatform {
	return {
		capabilities: {
			recovery: "bounded",
			asynchronous: true,
			idempotency: "none",
			requiredScopes: ["instagram_content_publish"],
			capabilityVersion: SOCIAL_PROVIDER_CAPABILITIES.instagram_reels.version,
			apiVersion: dependencies.config.metaGraphVersion,
			maxProviderCalls: dependencies.config.instagramPollAttempts + 5,
		},
		publish(input, context) {
			return withNativeOutcome(async (markSubmitted) => {
				const account = requireAccount(input, "instagram_reels");
				requireScopes(account, this.capabilities.requiredScopes);
				if (input.media.sizeBytes <= 0 || input.caption.length > 2_200) {
					throw new PublicationPlatformConfigurationError(
						"instagram_publication_invalid",
						"Instagram Reel media facts or caption are invalid",
					);
				}
				const settings = metadata(input);
				const accountSettings = accountMetadata(input);
				const userId = stringSetting(
					accountSettings,
					["igUserId"],
					account.providerAccountId,
				)!;
				const currentAccount = await jsonRequest<{ id?: string }>(
					dependencies,
					context,
					`https://graph.facebook.com/${dependencies.config.metaGraphVersion}/${userId}?fields=id&access_token=${encodeURIComponent(account.accessToken)}`,
					{ signal: context.signal },
					"instagram_account_check_failed",
					"preparation",
				);
				if (currentAccount.id !== userId) {
					throw new PublicationPlatformConfigurationError(
						"instagram_account_changed",
						"The connected Instagram professional account no longer matches",
					);
				}
				const publishingLimit = await jsonRequest<{
					data?: Array<{
						quota_usage?: number;
						config?: { quota_total?: number };
					}>;
				}>(
					dependencies,
					context,
					`https://graph.facebook.com/${dependencies.config.metaGraphVersion}/${userId}/content_publishing_limit?fields=quota_usage,config&access_token=${encodeURIComponent(account.accessToken)}`,
					{ signal: context.signal },
					"instagram_publishing_limit_check_failed",
					"preparation",
				);
				const limit = publishingLimit.data?.[0];
				if (
					typeof limit?.quota_usage === "number" &&
					typeof limit.config?.quota_total === "number" &&
					limit.quota_usage >= limit.config.quota_total
				) {
					throw new ProviderHttpError(
						"instagram_publishing_limit_reached",
						"preparation",
						429,
						60 * 60_000,
					);
				}
				const mediaUrl = await dependencies.media.createScopedAccess(
					input.media,
				);
				const container = await jsonRequest<{ id?: string }>(
					dependencies,
					context,
					`https://graph.facebook.com/${dependencies.config.metaGraphVersion}/${userId}/media`,
					{
						method: "POST",
						headers: { "Content-Type": "application/x-www-form-urlencoded" },
						body: new URLSearchParams({
							media_type: "REELS",
							video_url: mediaUrl,
							caption: input.caption,
							share_to_feed: String(
								booleanSetting(settings, ["shareToFeed"], true),
							),
							access_token: account.accessToken,
						}),
						signal: context.signal,
					},
					"instagram_container_create_failed",
					"preparation",
				);
				if (!container.id) {
					throw new ProviderHttpError(
						"instagram_container_missing",
						"preparation",
						502,
						null,
					);
				}
				await context.checkpoint({
					kind: "instagram_container",
					state: { containerId: container.id },
				});
				const containerStatus = await instagramContainerStatus(
					dependencies,
					context,
					account.accessToken,
					container.id,
					context.signal,
				);
				if (containerStatus === "IN_PROGRESS") {
					return {
						kind: "pending",
						receiptId: container.id,
						operation: {
							kind: "instagram_container",
							state: { containerId: container.id, userId },
						},
						nextCheckAt: pendingAt(
							dependencies,
							dependencies.config.instagramPollIntervalMs,
						),
						submissionStarted: false,
					};
				}
				if (containerStatus === "PUBLISHED") {
					return instagramAccepted(container.id, null);
				}
				if (containerStatus === "ERROR" || containerStatus === "EXPIRED") {
					return {
						kind: "failed",
						failure: {
							code:
								containerStatus === "EXPIRED"
									? "instagram_container_expired"
									: "instagram_container_processing_failed",
							phase: "preparation",
							disposition:
								containerStatus === "EXPIRED" ? "safe_retry" : "permanent",
							retryAfterMs: null,
						},
					};
				}
				await context.checkpoint({
					kind: "submission_started",
					state: {
						providerOperation: "instagram_media_publish",
						containerId: container.id,
					},
				});
				markSubmitted();
				const published = await jsonRequest<{ id?: string }>(
					dependencies,
					context,
					`https://graph.facebook.com/${dependencies.config.metaGraphVersion}/${userId}/media_publish`,
					{
						method: "POST",
						headers: { "Content-Type": "application/x-www-form-urlencoded" },
						body: new URLSearchParams({
							creation_id: container.id,
							access_token: account.accessToken,
						}),
						signal: context.signal,
					},
					"instagram_publish_failed",
					"submission",
				);
				if (!published.id) {
					throw new ProviderHttpError(
						"instagram_media_id_missing",
						"submission",
						502,
						null,
					);
				}
				const externalUrl = await instagramPermalink(
					dependencies,
					context,
					account.accessToken,
					published.id,
				);
				return instagramAccepted(container.id, published.id, externalUrl);
			});
		},
		resume(input, operation, context) {
			return withNativeOutcome(async (markSubmitted) => {
				const account = requireAccount(input, "instagram_reels");
				requireScopes(account, this.capabilities.requiredScopes);
				const containerId = operationString(operation.state, "containerId");
				const userId =
					operationString(operation.state, "userId") ??
					stringSetting(
						accountMetadata(input),
						["igUserId"],
						account.providerAccountId,
					)!;
				if (!containerId) {
					return {
						kind: "failed",
						failure: {
							code: "instagram_container_missing",
							phase: "preparation",
							disposition: "permanent",
							retryAfterMs: null,
						},
					};
				}
				const status = await instagramContainerStatus(
					dependencies,
					context,
					account.accessToken,
					containerId,
					context.signal,
				);
				if (status === "PUBLISHED") return instagramAccepted(containerId, null);
				if (status === "IN_PROGRESS") {
					return {
						kind: "pending",
						receiptId: containerId,
						operation: {
							kind: "instagram_container",
							state: { containerId, userId },
						},
						nextCheckAt: pendingAt(
							dependencies,
							dependencies.config.instagramPollIntervalMs,
						),
						submissionStarted: false,
					};
				}
				if (status === "ERROR" || status === "EXPIRED") {
					return {
						kind: "failed",
						failure: {
							code:
								status === "EXPIRED"
									? "instagram_container_expired"
									: "instagram_container_processing_failed",
							phase: "preparation",
							disposition: status === "EXPIRED" ? "safe_retry" : "permanent",
							retryAfterMs: null,
						},
					};
				}
				await context.checkpoint({
					kind: "submission_started",
					state: {
						providerOperation: "instagram_media_publish",
						containerId,
						userId,
					},
				});
				markSubmitted();
				const published = await jsonRequest<{ id?: string }>(
					dependencies,
					context,
					`https://graph.facebook.com/${dependencies.config.metaGraphVersion}/${userId}/media_publish`,
					{
						method: "POST",
						headers: { "Content-Type": "application/x-www-form-urlencoded" },
						body: new URLSearchParams({
							creation_id: containerId,
							access_token: account.accessToken,
						}),
						signal: context.signal,
					},
					"instagram_publish_failed",
					"submission",
				);
				if (!published.id) {
					throw new ProviderHttpError(
						"instagram_media_id_missing",
						"submission",
						502,
						null,
					);
				}
				const externalUrl = await instagramPermalink(
					dependencies,
					context,
					account.accessToken,
					published.id,
				);
				return instagramAccepted(containerId, published.id, externalUrl);
			});
		},
		reconcile(input, operation, context) {
			return withNativeOutcome(async (markSubmitted) => {
				markSubmitted();
				const account = requireAccount(input, "instagram_reels");
				const containerId = operationString(operation.state, "containerId");
				if (!containerId) {
					return {
						kind: "unknown",
						code: "instagram_container_missing",
						phase: "reconciliation",
						operation: null,
					};
				}
				const status = await instagramContainerStatus(
					dependencies,
					context,
					account.accessToken,
					containerId,
					context.signal,
				);
				if (status === "PUBLISHED") return instagramAccepted(containerId, null);
				if (status === "ERROR" || status === "EXPIRED") {
					return {
						kind: "failed",
						failure: {
							code: "instagram_publish_failed",
							phase: "reconciliation",
							disposition: "permanent",
							retryAfterMs: null,
							safeToRepublishAfterSubmission: true,
						},
					};
				}
				return {
					kind: "unknown",
					code: "instagram_publication_not_yet_proven",
					phase: "reconciliation",
					operation,
				};
			});
		},
	};
}

async function tiktokStatus(
	dependencies: NativePublicationDependencies,
	context: PublicationPlatformContext,
	accessToken: string,
	publishId: string,
	signal: AbortSignal,
) {
	const response = await jsonRequest<{
		data?: Record<string, unknown>;
	}>(
		dependencies,
		context,
		`https://open.tiktokapis.com/${dependencies.config.tiktokApiVersion}/post/publish/status/fetch/`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json; charset=UTF-8",
			},
			body: JSON.stringify({ publish_id: publishId }),
			signal,
		},
		"tiktok_status_failed",
		"reconciliation",
	);
	const state = response.data ?? {};
	const postIds =
		state.publicly_available_post_id ?? state.publicaly_available_post_id;
	const platformPostId = Array.isArray(postIds)
		? postIds.find(
				(value): value is string | number =>
					typeof value === "string" || typeof value === "number",
			)
		: postIds;
	return {
		status: String(state.status ?? state.status_code ?? "PROCESSING"),
		failureReason:
			typeof state.fail_reason === "string" ? state.fail_reason : null,
		platformPostId:
			typeof platformPostId === "string" || typeof platformPostId === "number"
				? String(platformPostId)
				: null,
	};
}

function tiktokAccepted(
	input: PublicationPlatformInput,
	publishId: string,
	status: { status: string; platformPostId: string | null },
): PublicationPlatformResult {
	const username = input.account?.handle?.replace(/^@/, "");
	return {
		kind: "accepted",
		receipt: {
			receiptId: publishId,
			platformPostId: status.platformPostId,
			externalUrl:
				status.platformPostId && username
					? `https://www.tiktok.com/@${username}/video/${status.platformPostId}`
					: null,
			metrics: null,
		},
	};
}

async function uploadTikTokChunks(
	dependencies: NativePublicationDependencies,
	context: PublicationPlatformContext,
	local: NativePublicationMedia,
	state: {
		publishId: string;
		uploadUrl: string;
		chunkBytes: number;
		totalChunks: number;
		nextChunk: number;
	},
) {
	for (let index = state.nextChunk; index < state.totalChunks; index += 1) {
		const start = index * state.chunkBytes;
		const end = Math.min(start + state.chunkBytes, local.sizeBytes);
		await context.providerCall?.();
		const upload = await dependencies.fetch(state.uploadUrl, {
			method: "PUT",
			headers: {
				"Content-Type": "video/mp4",
				"Content-Length": String(end - start),
				"Content-Range": `bytes ${start}-${end - 1}/${local.sizeBytes}`,
			},
			body: await local.blob(start, end),
			signal: context.signal,
		});
		if (!upload.ok) {
			throw new ProviderHttpError(
				"tiktok_upload_failed",
				"upload",
				upload.status,
				retryAfterMs(upload, dependencies.clock.now()),
			);
		}
		await context.checkpoint({
			kind: "submission_started",
			lookupKey: `tiktok:${state.publishId}`,
			state: {
				providerOperation: "tiktok_publish",
				publishId: state.publishId,
				uploadUrl: state.uploadUrl,
				nextChunk: index + 1,
				chunkBytes: state.chunkBytes,
				totalChunks: state.totalChunks,
			},
		});
	}
}

function tiktokPollDelayMs(
	dependencies: NativePublicationDependencies,
	completedChecks: number,
) {
	return Math.min(
		30 * 60_000,
		dependencies.config.tiktokPollIntervalMs *
			2 ** Math.min(Math.max(0, completedChecks), 9),
	);
}

function tiktokPlatform(
	dependencies: NativePublicationDependencies,
): PublicationPlatform {
	return {
		capabilities: {
			recovery: "exact",
			asynchronous: true,
			idempotency: "provider",
			requiredScopes: ["video.publish"],
			capabilityVersion: SOCIAL_PROVIDER_CAPABILITIES.tiktok.version,
			apiVersion: `tiktok-${dependencies.config.tiktokApiVersion}`,
			maxProviderCalls: 200,
		},
		publish(input, context) {
			return withNativeOutcome(async (markSubmitted) => {
				const account = requireAccount(input, "tiktok");
				requireScopes(account, this.capabilities.requiredScopes);
				const local = await dependencies.media.materialize(input.media);
				try {
					const settings = metadata(input);
					const creator = await jsonRequest<{
						data?: {
							creator_username?: string;
							privacy_level_options?: string[];
							comment_disabled?: boolean;
							duet_disabled?: boolean;
							stitch_disabled?: boolean;
							max_video_post_duration_sec?: number;
						};
					}>(
						dependencies,
						context,
						`https://open.tiktokapis.com/${dependencies.config.tiktokApiVersion}/post/publish/creator_info/query/`,
						{
							method: "POST",
							headers: {
								Authorization: `Bearer ${account.accessToken}`,
								"Content-Type": "application/json; charset=UTF-8",
							},
							signal: context.signal,
						},
						"tiktok_creator_info_failed",
						"preparation",
					);
					const options = creator.data?.privacy_level_options ?? [];
					const creatorHandle = creator.data?.creator_username?.replace(/^@/, "").toLowerCase();
					const accountHandle = account.handle?.replace(/^@/, "").toLowerCase();
					if (creatorHandle && accountHandle && creatorHandle !== accountHandle) {
						throw new PublicationPlatformConfigurationError(
							"tiktok_creator_account_changed",
							"The TikTok creator account no longer matches the frozen publication account",
						);
					}
					const requested = stringSetting(settings, [
						"tiktokPrivacyLevel",
						"privacyLevel",
					]);
					if (requested && !options.includes(requested)) {
						throw new PublicationPlatformConfigurationError(
							"tiktok_privacy_setting_changed",
							"The selected TikTok privacy setting is no longer available",
						);
					}
					const coverTimestamp = Number(settings.videoCoverTimestampMs ?? 1_000);
					const mediaDurationSec = input.media.durationSec;
					const maximumDurationSec = creator.data?.max_video_post_duration_sec;
					const disableComment = booleanSetting(settings, ["disableComment"], false);
					const disableDuet = booleanSetting(settings, ["disableDuet"], false);
					const disableStitch = booleanSetting(settings, ["disableStitch"], false);
					if (
						(Boolean(creator.data?.comment_disabled) && !disableComment) ||
						(Boolean(creator.data?.duet_disabled) && !disableDuet) ||
						(Boolean(creator.data?.stitch_disabled) && !disableStitch)
					) {
						throw new PublicationPlatformConfigurationError(
							"tiktok_creator_setting_changed",
							"A selected TikTok interaction setting is no longer available",
						);
					}
					if (
						input.media.sizeBytes <= 0 ||
						input.caption.length > 2_200 ||
						!Number.isFinite(coverTimestamp) ||
						coverTimestamp < 0 ||
						!Number.isFinite(mediaDurationSec) ||
						mediaDurationSec <= 0 ||
						coverTimestamp > mediaDurationSec * 1_000 ||
						(maximumDurationSec !== undefined &&
							mediaDurationSec > maximumDurationSec)
					) {
						throw new PublicationPlatformConfigurationError(
							"tiktok_publication_invalid",
							"TikTok media facts, caption, or cover timestamp are invalid",
						);
					}
					const privacyLevel =
						requested && options.includes(requested)
							? requested
							: options.includes("PUBLIC_TO_EVERYONE")
								? "PUBLIC_TO_EVERYONE"
								: (options[0] ?? "SELF_ONLY");
					const chunkSize = Math.min(
						local.sizeBytes,
						dependencies.config.tiktokChunkBytes,
					);
					const totalChunkCount = Math.max(
						1,
						Math.ceil(local.sizeBytes / chunkSize),
					);
					const initialized = await jsonRequest<{
						data?: { upload_url?: string; publish_id?: string };
					}>(
						dependencies,
						context,
						`https://open.tiktokapis.com/${dependencies.config.tiktokApiVersion}/post/publish/video/init/`,
						{
							method: "POST",
							headers: {
								Authorization: `Bearer ${account.accessToken}`,
								"Content-Type": "application/json; charset=UTF-8",
							},
							body: JSON.stringify({
								post_info: {
									title: truncate(input.caption, 2200),
									privacy_level: privacyLevel,
									disable_comment: disableComment,
									disable_duet: disableDuet,
									disable_stitch: disableStitch,
									video_cover_timestamp_ms: coverTimestamp,
									is_aigc: booleanSetting(settings, ["isAigc", "madeWithAi"]),
								},
								source_info: {
									source: "FILE_UPLOAD",
									video_size: local.sizeBytes,
									chunk_size: chunkSize,
									total_chunk_count: totalChunkCount,
								},
							}),
							signal: context.signal,
						},
						"tiktok_publish_init_failed",
						"preparation",
					);
					const uploadUrl = initialized.data?.upload_url;
					const publishId = initialized.data?.publish_id;
					if (!uploadUrl || !publishId) {
						throw new ProviderHttpError(
							"tiktok_upload_url_missing",
							"preparation",
							502,
							null,
						);
					}
					await context.checkpoint({
						kind: "submission_started",
						lookupKey: `tiktok:${publishId}`,
						state: {
							providerOperation: "tiktok_publish",
							publishId,
							uploadUrl,
							nextChunk: 0,
							chunkBytes: chunkSize,
							totalChunks: totalChunkCount,
							privacyLevel,
							disableComment,
							disableDuet,
							disableStitch,
							videoCoverTimestampMs: coverTimestamp,
							isAigc: booleanSetting(settings, ["isAigc", "madeWithAi"]),
						},
					});
					markSubmitted();
					await uploadTikTokChunks(dependencies, context, local, {
						publishId,
						uploadUrl,
						chunkBytes: chunkSize,
						totalChunks: totalChunkCount,
						nextChunk: 0,
					});
					return {
						kind: "pending",
						receiptId: publishId,
						operation: {
							kind: "tiktok_processing",
							lookupKey: `tiktok:${publishId}`,
							state: { publishId, moderationChecks: 0 },
						},
						nextCheckAt: pendingAt(
							dependencies,
							dependencies.config.tiktokPollIntervalMs,
						),
						submissionStarted: true,
					};
				} finally {
					await cleanupMaterializedMedia(local, input);
				}
			});
		},
		reconcile(input, operation, context) {
			return withNativeOutcome(async (markSubmitted) => {
				markSubmitted();
				const account = requireAccount(input, "tiktok");
				requireScopes(account, this.capabilities.requiredScopes);
				const publishId = stringSetting(operation.state, ["publishId"]);
				if (!publishId) {
					return {
						kind: "unknown",
						code: "tiktok_publish_id_missing",
						phase: "reconciliation",
						operation: null,
					};
				}
				const uploadUrl = operationString(operation.state, "uploadUrl");
				const chunkBytes = operationNumber(operation.state, "chunkBytes");
				const totalChunks = operationNumber(operation.state, "totalChunks");
				const nextChunk = operationNumber(operation.state, "nextChunk") ?? 0;
				const moderationChecks =
					operationNumber(operation.state, "moderationChecks") ?? 0;
				if (
					uploadUrl &&
					chunkBytes &&
					totalChunks &&
					nextChunk < totalChunks
				) {
					const local = await dependencies.media.materialize(input.media);
					try {
						await uploadTikTokChunks(dependencies, context, local, {
							publishId,
							uploadUrl,
							chunkBytes,
							totalChunks,
							nextChunk,
						});
					} finally {
						await cleanupMaterializedMedia(local, input);
					}
				}
				const status = await tiktokStatus(
					dependencies,
					context,
					account.accessToken,
					publishId,
					context.signal,
				);
				if (status.status === "PUBLISH_COMPLETE") {
					return tiktokAccepted(input, publishId, status);
				}
				if (status.status === "FAILED") {
					const failureCodes: Record<string, string> = {
						spam_risk: "tiktok_spam_risk",
						spam_risk_too_many_posts: "tiktok_rate_limit",
						spam_risk_user_banned_from_posting:
							"tiktok_account_restricted",
					};
					const rateLimited =
						status.failureReason === "spam_risk_too_many_posts";
					return {
						kind: "failed",
						failure: {
							code: status.failureReason
								? failureCodes[status.failureReason] ?? "tiktok_publish_failed"
								: "tiktok_publish_failed",
							phase: "reconciliation",
							disposition: rateLimited ? "safe_retry" : "permanent",
							retryAfterMs: rateLimited ? 60 * 60_000 : null,
							safeToRepublishAfterSubmission: true,
							evidence: status.failureReason
								? { providerReason: status.failureReason.slice(0, 200) }
								: undefined,
						},
					};
				}
				return {
					kind: "pending",
					receiptId: publishId,
					operation: {
						...operation,
						lookupKey: `tiktok:${publishId}`,
						state: {
							...operation.state,
							publishId,
							moderationChecks: moderationChecks + 1,
						},
					},
					nextCheckAt: new Date(
						dependencies.clock.now().getTime() +
							tiktokPollDelayMs(dependencies, moderationChecks + 1),
					),
				};
			});
		},
	};
}

type LinkedInUploadInstruction = {
	uploadUrl: string;
	firstByte: number;
	lastByte: number;
};

function linkedInUploadState(state: Record<string, unknown>) {
	const instructions = Array.isArray(state.uploadInstructions)
		? state.uploadInstructions.filter(
				(value): value is LinkedInUploadInstruction =>
					typeof value === "object" &&
					value !== null &&
					typeof value.uploadUrl === "string" &&
					typeof value.firstByte === "number" &&
					typeof value.lastByte === "number",
			)
		: [];
	const uploadedPartIds = Array.isArray(state.uploadedPartIds)
		? state.uploadedPartIds.filter(
				(value): value is string => typeof value === "string",
			)
		: [];
	return {
		owner: operationString(state, "owner"),
		videoUrn: operationString(state, "videoUrn"),
		uploadToken: operationString(state, "uploadToken") ?? "",
		instructions,
		uploadedPartIds,
	};
}

async function resumeLinkedInVideoUpload(
	dependencies: NativePublicationDependencies,
	input: PublicationPlatformInput,
	context: PublicationPlatformContext,
	state: Record<string, unknown>,
	materialized?: NativePublicationMedia,
) {
	const parsed = linkedInUploadState(state);
	if (!parsed.owner || !parsed.videoUrn || parsed.instructions.length === 0) {
		throw new PublicationPlatformConfigurationError(
			"linkedin_video_checkpoint_invalid",
			"The durable LinkedIn video checkpoint is incomplete",
		);
	}
	const account = requireAccount(input, "linkedin");
	const headers = {
		Authorization: `Bearer ${account.accessToken}`,
		"Content-Type": "application/json",
		"Linkedin-Version": dependencies.config.linkedInVersion,
		"X-Restli-Protocol-Version": "2.0.0",
	};
	const local = materialized ?? (await dependencies.media.materialize(input.media));
	try {
		for (
			let index = parsed.uploadedPartIds.length;
			index < parsed.instructions.length;
			index += 1
		) {
			const instruction = parsed.instructions[index]!;
			await context.providerCall?.();
			const response = await dependencies.fetch(instruction.uploadUrl, {
				method: "PUT",
				headers: { "Content-Type": "application/octet-stream" },
				body: await local.blob(
					instruction.firstByte,
					instruction.lastByte + 1,
				),
				signal: context.signal,
			});
			if (!response.ok) {
				throw new ProviderHttpError(
					"linkedin_video_upload_failed",
					"upload",
					response.status,
					retryAfterMs(response, dependencies.clock.now()),
				);
			}
			const etag = response.headers.get("etag")?.replace(/^"|"$/g, "");
			if (!etag) {
				throw new ProviderHttpError(
					"linkedin_video_etag_missing",
					"upload",
					502,
					null,
				);
			}
			parsed.uploadedPartIds.push(etag);
			await context.checkpoint({
				kind: "linkedin_video_upload",
				state: {
					owner: parsed.owner,
					videoUrn: parsed.videoUrn,
					uploadToken: parsed.uploadToken,
					uploadInstructions: parsed.instructions,
					uploadedPartIds: parsed.uploadedPartIds,
				},
			});
		}
		await jsonRequest(
			dependencies,
			context,
			"https://api.linkedin.com/rest/videos?action=finalizeUpload",
			{
				method: "POST",
				headers,
				body: JSON.stringify({
					finalizeUploadRequest: {
						video: parsed.videoUrn,
						uploadToken: parsed.uploadToken,
						uploadedPartIds: parsed.uploadedPartIds,
					},
				}),
				signal: context.signal,
			},
			"linkedin_video_finalize_failed",
			"upload",
		);
		return {
			owner: parsed.owner,
			videoUrn: parsed.videoUrn,
			headers,
		};
	} finally {
		if (!materialized) await cleanupMaterializedMedia(local, input);
	}
}

function requireLinkedInOwner(
	input: PublicationPlatformInput,
	account: NonNullable<PublicationPlatformInput["account"]>,
	checkpointOwner?: string | null,
) {
	const owner =
		checkpointOwner ??
		stringSetting(
			accountMetadata(input),
			["ownerUrn"],
			`urn:li:person:${account.providerAccountId}`,
		)!;
	if (!/^urn:li:(person|organization):[^\s]+$/.test(owner)) {
		throw new PublicationPlatformConfigurationError(
			"linkedin_owner_invalid",
			"LinkedIn owner identity is invalid",
		);
	}
	requireScopes(account, [
		owner.startsWith("urn:li:organization:")
			? "w_organization_social"
			: "w_member_social",
	]);
	return owner;
}

function linkedInHeaders(
	dependencies: NativePublicationDependencies,
	accessToken: string,
) {
	return {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		"Linkedin-Version": dependencies.config.linkedInVersion,
		"X-Restli-Protocol-Version": "2.0.0",
	};
}

async function linkedInVideoReadiness(
	dependencies: NativePublicationDependencies,
	context: PublicationPlatformContext,
	accessToken: string,
	videoUrn: string,
) {
	const video = await jsonRequest<{ status?: string }>(
		dependencies,
		context,
		`https://api.linkedin.com/rest/videos/${encodeURIComponent(videoUrn)}`,
		{
			headers: linkedInHeaders(dependencies, accessToken),
			signal: context.signal,
		},
		"linkedin_video_status_failed",
		"upload",
	);
	if (video.status === "AVAILABLE") return "available" as const;
	if (["PROCESSING_FAILED", "FAILED"].includes(video.status ?? "")) {
		return "failed" as const;
	}
	if (["WAITING_UPLOAD", "PROCESSING"].includes(video.status ?? "")) {
		return "processing" as const;
	}
	return "invalid" as const;
}

function linkedInProcessingResult(
	dependencies: NativePublicationDependencies,
	owner: string,
	videoUrn: string,
	processingChecks = 0,
): PublicationPlatformResult {
	const delayMs = Math.min(15 * 60_000, 5_000 * 2 ** Math.min(processingChecks, 8));
	return {
		kind: "pending",
		receiptId: videoUrn,
		operation: {
			kind: "linkedin_video_processing",
			state: { owner, videoUrn, processingChecks },
		},
		nextCheckAt: pendingAt(dependencies, delayMs),
		submissionStarted: false,
	};
}

async function submitLinkedInPost(
	dependencies: NativePublicationDependencies,
	input: PublicationPlatformInput,
	context: PublicationPlatformContext,
	owner: string,
	videoUrn: string,
	markSubmitted: () => void,
): Promise<PublicationPlatformResult> {
	const account = requireAccount(input, "linkedin");
	const settings = metadata(input);
	await context.checkpoint({
		kind: "submission_started",
		state: {
			providerOperation: "linkedin_post",
			videoUrn,
			owner,
			submissionStartedAt: dependencies.clock.now().toISOString(),
		},
	});
	markSubmitted();
	await context.providerCall?.();
	const post = await dependencies.fetch("https://api.linkedin.com/rest/posts", {
		method: "POST",
		headers: linkedInHeaders(dependencies, account.accessToken),
		body: JSON.stringify({
			author: owner,
			commentary: input.caption,
			visibility: stringSetting(settings, ["linkedinVisibility"], "PUBLIC"),
			distribution: {
				feedDistribution: "MAIN_FEED",
				targetEntities: [],
				thirdPartyDistributionChannels: [],
			},
			content: {
				media: {
					title: stringSetting(settings, ["title"], title(input)),
					id: videoUrn,
				},
			},
			lifecycleState: "PUBLISHED",
			isReshareDisabledByAuthor: booleanSetting(settings, [
				"isReshareDisabledByAuthor",
			]),
		}),
		signal: context.signal,
	});
	if (!post.ok) {
		throw new ProviderHttpError(
			"linkedin_post_failed",
			"submission",
			post.status,
			retryAfterMs(post, dependencies.clock.now()),
		);
	}
	const postId = post.headers.get("x-restli-id");
	if (!postId) {
		throw new ProviderHttpError(
			"linkedin_post_id_missing",
			"submission",
			502,
			null,
		);
	}
	return {
		kind: "accepted",
		receipt: {
			receiptId: postId,
			platformPostId: postId,
			externalUrl: `https://www.linkedin.com/feed/update/${postId}/`,
			metrics: null,
		},
	};
}

function linkedInPlatform(
	dependencies: NativePublicationDependencies,
): PublicationPlatform {
	return {
		capabilities: {
			recovery: "bounded",
			asynchronous: true,
			idempotency: "none",
			requiredScopes: [],
			capabilityVersion: SOCIAL_PROVIDER_CAPABILITIES.linkedin.version,
			apiVersion: dependencies.config.linkedInVersion,
			maxProviderCalls: 100,
		},
		publish(input, context) {
			return withNativeOutcome(async (_markSubmitted) => {
				const account = requireAccount(input, "linkedin");
				const settings = metadata(input);
				const owner = requireLinkedInOwner(input, account);
				const visibility = stringSetting(
					settings,
					["linkedinVisibility"],
					"PUBLIC",
				)!;
				const mediaTitle = stringSetting(settings, ["title"], title(input))!;
				if (
					input.media.sizeBytes <= 0 ||
					input.caption.length < 1 ||
					input.caption.length > 3_000 ||
					mediaTitle.length < 1 ||
					mediaTitle.length > 200 ||
					!["PUBLIC", "CONNECTIONS"].includes(visibility)
				) {
					throw new PublicationPlatformConfigurationError(
						"linkedin_publication_invalid",
						"LinkedIn media facts, commentary, or visibility are invalid",
					);
				}
				const local = await dependencies.media.materialize(input.media);
				try {
					const headers = {
						Authorization: `Bearer ${account.accessToken}`,
						"Content-Type": "application/json",
						"Linkedin-Version": dependencies.config.linkedInVersion,
						"X-Restli-Protocol-Version": "2.0.0",
					};
					const initialized = await jsonRequest<{
						value?: {
							video?: string;
							uploadToken?: string;
							uploadInstructions?: Array<{
								uploadUrl?: string;
								firstByte?: number;
								lastByte?: number;
							}>;
						};
					}>(
						dependencies,
						context,
						"https://api.linkedin.com/rest/videos?action=initializeUpload",
						{
							method: "POST",
							headers,
							body: JSON.stringify({
								initializeUploadRequest: {
									owner,
									fileSizeBytes: local.sizeBytes,
									uploadCaptions: false,
									uploadThumbnail: false,
								},
							}),
							signal: context.signal,
						},
						"linkedin_video_init_failed",
						"preparation",
					);
					const videoUrn = initialized.value?.video;
					const instructions = initialized.value?.uploadInstructions ?? [];
					if (!videoUrn || instructions.length === 0) {
						throw new ProviderHttpError(
							"linkedin_video_upload_missing",
							"preparation",
							502,
							null,
						);
					}
					await context.checkpoint({
						kind: "linkedin_video_upload",
						state: {
							videoUrn,
							owner,
							uploadToken: initialized.value?.uploadToken ?? "",
							uploadInstructions: instructions,
							uploadedPartIds: [],
						},
					});
					const resumed = await resumeLinkedInVideoUpload(
						dependencies,
						input,
						context,
						{
							videoUrn,
							owner,
							uploadToken: initialized.value?.uploadToken ?? "",
							uploadInstructions: instructions,
							uploadedPartIds: [],
						},
						local,
					);
					return linkedInProcessingResult(
						dependencies,
						resumed.owner,
						resumed.videoUrn,
					);
				} finally {
					await cleanupMaterializedMedia(local, input);
				}
			});
		},
			resume(input, operation, context) {
				return withNativeOutcome(async (markSubmitted) => {
					const account = requireAccount(input, "linkedin");
					const owner = requireLinkedInOwner(
						input,
						account,
						operationString(operation.state, "owner"),
					);
					if (operation.kind === "linkedin_video_processing") {
						const videoUrn = operationString(operation.state, "videoUrn");
						const processingChecks =
							operationNumber(operation.state, "processingChecks") ?? 0;
						if (!videoUrn) {
							throw new PublicationPlatformConfigurationError(
								"linkedin_video_checkpoint_invalid",
								"The durable LinkedIn video checkpoint is incomplete",
							);
						}
						const readiness = await linkedInVideoReadiness(
							dependencies,
							context,
							account.accessToken,
							videoUrn,
						);
						if (readiness === "failed") {
							return {
								kind: "failed",
								failure: {
									code: "linkedin_video_processing_failed",
									phase: "upload",
									disposition: "permanent",
									retryAfterMs: null,
								},
							};
						}
						if (readiness === "invalid") {
							return {
								kind: "failed",
								failure: {
									code: "linkedin_video_status_invalid",
									phase: "upload",
									disposition: "permanent",
									retryAfterMs: null,
								},
							};
						}
						return readiness === "available"
							? submitLinkedInPost(
									dependencies,
									input,
									context,
									owner,
									videoUrn,
									markSubmitted,
								)
							: linkedInProcessingResult(
									dependencies,
									owner,
									videoUrn,
									processingChecks + 1,
								);
					}
					const resumed = await resumeLinkedInVideoUpload(
					dependencies,
					input,
					context,
					operation.state,
				);
					return linkedInProcessingResult(
						dependencies,
						resumed.owner,
						resumed.videoUrn,
					);
			});
		},
		reconcile(input, operation, context) {
			return withNativeOutcome(async (markSubmitted) => {
				markSubmitted();
				const account = requireAccount(input, "linkedin");
				const owner = operationString(operation.state, "owner");
				const videoUrn = operationString(operation.state, "videoUrn");
				const startedAt = operationString(
					operation.state,
					"submissionStartedAt",
				);
				if (!owner || !videoUrn || !startedAt) {
					return {
						kind: "unknown",
						code: "linkedin_post_checkpoint_invalid",
						phase: "reconciliation",
						operation: null,
					};
				}
				const readScope = owner.startsWith("urn:li:organization:")
					? "r_organization_social"
					: "r_member_social";
				if (!account.scopes.includes(readScope)) {
					return {
						kind: "failed",
						failure: {
							code: "linkedin_reconciliation_permission_missing",
							phase: "reconciliation",
							disposition: "attention",
							retryAfterMs: null,
						},
					};
				}
				const headers = {
					Authorization: `Bearer ${account.accessToken}`,
					"Linkedin-Version": dependencies.config.linkedInVersion,
					"X-Restli-Protocol-Version": "2.0.0",
					"X-RestLi-Method": "FINDER",
				};
				const posts: Array<{
					id?: string;
					author?: string;
					createdAt?: number;
					content?: { media?: { id?: string } };
				}> = [];
				let start = 0;
				let paginationExhausted = false;
				for (let page = 0; page < 5; page += 1) {
					const parameters = new URLSearchParams({
						author: owner,
						q: "author",
						count: "100",
						start: String(start),
						sortBy: "CREATED",
						viewContext: "AUTHOR",
					});
					const response = await jsonRequest<{
					elements?: Array<{
						id?: string;
						author?: string;
						createdAt?: number;
						content?: { media?: { id?: string } };
					}>;
					paging?: { start?: number; count?: number; total?: number };
					}>(
						dependencies,
						context,
						`https://api.linkedin.com/rest/posts?${parameters}`,
						{ method: "GET", headers, signal: context.signal },
						"linkedin_post_lookup_failed",
						"reconciliation",
					);
					const elements = response.elements ?? [];
					posts.push(...elements);
					const pageStart = response.paging?.start ?? start;
					const pageCount = response.paging?.count ?? elements.length;
					const nextStart = pageStart + pageCount;
					const total = response.paging?.total;
					if (
						(typeof total === "number" && nextStart >= total) ||
						(typeof total !== "number" && elements.length < 100)
					) {
						paginationExhausted = true;
						break;
					}
					if (nextStart <= start) break;
					start = nextStart;
				}
				if (!paginationExhausted) {
					return {
						kind: "failed",
						failure: {
							code: "linkedin_reconciliation_window_exceeded",
							phase: "reconciliation",
							disposition: "attention",
							retryAfterMs: null,
						},
					};
				}
				const startedMs = Date.parse(startedAt);
				const windowEnd = dependencies.clock.now().getTime() + 60_000;
				const matches = posts.filter(
					(post) =>
						post.id &&
						post.author === owner &&
						post.content?.media?.id === videoUrn &&
						typeof post.createdAt === "number" &&
						post.createdAt >= startedMs - 60_000 &&
						post.createdAt <= windowEnd,
				);
				if (matches.length === 1) {
					const postId = matches[0]!.id!;
					return {
						kind: "accepted",
						receipt: {
							receiptId: postId,
							platformPostId: postId,
							externalUrl: `https://www.linkedin.com/feed/update/${postId}/`,
							metrics: null,
						},
					};
				}
				if (matches.length > 1) {
					return {
						kind: "failed",
						failure: {
							code: "linkedin_reconciliation_multiple_matches",
							phase: "reconciliation",
							disposition: "attention",
							retryAfterMs: null,
						},
					};
				}
				return {
					kind: "unknown",
					code: "linkedin_publication_not_yet_proven",
					phase: "reconciliation",
					operation,
				};
			});
		},
	};
}

async function xMediaStatus(
	dependencies: NativePublicationDependencies,
	context: PublicationPlatformContext,
	accessToken: string,
	mediaId: string,
	signal: AbortSignal,
) {
	const status = await jsonRequest<{
		data?: {
			processing_info?: { state?: string; check_after_secs?: number };
			expires_after_secs?: number;
		};
	}>(
		dependencies,
		context,
		`https://api.x.com/${xApiVersion(dependencies)}/media/upload?${new URLSearchParams({
			command: "STATUS",
			media_id: mediaId,
		})}`,
		{
			method: "GET",
			headers: { Authorization: `Bearer ${accessToken}` },
			signal,
		},
		"x_media_status_failed",
		"upload",
	);
	return {
		processingInfo: status.data?.processing_info,
		expiresAfterSecs: status.data?.expires_after_secs,
	};
}

async function submitXPost(
	dependencies: NativePublicationDependencies,
	input: PublicationPlatformInput,
	context: PublicationPlatformContext,
	account: NonNullable<PublicationPlatformInput["account"]>,
	mediaId: string,
	mediaKey: string | null,
	markSubmitted: () => void,
): Promise<PublicationPlatformResult> {
	await context.checkpoint({
		kind: "submission_started",
		state: {
			providerOperation: "x_post",
			mediaId,
			mediaKey,
			submissionStartedAt: dependencies.clock.now().toISOString(),
		},
	});
	markSubmitted();
	const body: Record<string, unknown> = {
		text: truncate(input.caption, 280),
		media: { media_ids: [mediaId] },
	};
	if (booleanSetting(metadata(input), ["madeWithAi", "isAigc"])) {
		body.made_with_ai = true;
	}
	const posted = await jsonRequest<{ data?: { id?: string } }>(
		dependencies,
		context,
		`https://api.x.com/${xApiVersion(dependencies)}/tweets`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${account.accessToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: context.signal,
		},
		"x_post_failed",
		"submission",
	);
	if (!posted.data?.id) {
		throw new ProviderHttpError("x_post_id_missing", "submission", 502, null);
	}
	const username = account.handle?.replace(/^@/, "");
	return {
		kind: "accepted",
		receipt: {
			receiptId: posted.data.id,
			platformPostId: posted.data.id,
			externalUrl: username
				? `https://x.com/${username}/status/${posted.data.id}`
				: `https://x.com/i/web/status/${posted.data.id}`,
			metrics: null,
		},
	};
}

async function continueXMediaUpload(
	dependencies: NativePublicationDependencies,
	input: PublicationPlatformInput,
	context: PublicationPlatformContext,
	account: NonNullable<PublicationPlatformInput["account"]>,
	operation: PublicationProviderOperation,
	markSubmitted: () => void,
	materialized?: NativePublicationMedia,
): Promise<PublicationPlatformResult> {
	const mediaId = operationString(operation.state, "mediaId");
	const mediaKey = operationString(operation.state, "mediaKey");
	const chunkBytes =
		operationNumber(operation.state, "chunkBytes") ??
		dependencies.config.xChunkBytes;
	let nextSegment = operationNumber(operation.state, "nextSegment") ?? 0;
	const expiresAt = operationString(operation.state, "expiresAt");
	if (!mediaId || !mediaKey || chunkBytes <= 0) {
		return {
			kind: "failed",
			failure: {
				code: "x_media_checkpoint_invalid",
				phase: "upload",
				disposition: "permanent",
				retryAfterMs: null,
			},
		};
	}
	if (expiresAt && Date.parse(expiresAt) <= dependencies.clock.now().getTime()) {
		return {
			kind: "failed",
			failure: {
				code: "x_media_expired",
				phase: "upload",
				disposition: "safe_retry",
				retryAfterMs: null,
			},
		};
	}
	if (operation.kind === "x_media_processing") {
		const status = await xMediaStatus(
			dependencies,
			context,
			account.accessToken,
			mediaId,
			context.signal,
		);
		const processing = status.processingInfo;
		const refreshedExpiresAt = status.expiresAfterSecs
			? new Date(
					dependencies.clock.now().getTime() + status.expiresAfterSecs * 1000,
				).toISOString()
			: expiresAt;
		if (processing?.state === "failed") {
			return {
				kind: "failed",
				failure: {
					code: "x_media_processing_failed",
					phase: "upload",
					disposition: "permanent",
					retryAfterMs: null,
				},
			};
		}
		if (processing && processing.state !== "succeeded") {
			return {
				kind: "pending",
				receiptId: mediaId,
				operation: {
					...operation,
					state: { ...operation.state, expiresAt: refreshedExpiresAt },
				},
				nextCheckAt: pendingAt(
					dependencies,
					Math.max(1, processing.check_after_secs ?? 5) * 1000,
				),
				submissionStarted: false,
			};
		}
		return submitXPost(
			dependencies,
			input,
			context,
			account,
			mediaId,
			mediaKey,
			markSubmitted,
		);
	}

	const local = materialized ?? (await dependencies.media.materialize(input.media));
	try {
		const chunks = Math.max(1, Math.ceil(local.sizeBytes / chunkBytes));
		for (; nextSegment < chunks; nextSegment += 1) {
			const start = nextSegment * chunkBytes;
			const end = Math.min(start + chunkBytes, local.sizeBytes);
			const form = new FormData();
			form.set("segment_index", String(nextSegment));
			form.set("media", await local.blob(start, end), local.fileName);
			await context.providerCall?.();
			const appended = await dependencies.fetch(
			`https://api.x.com/${xApiVersion(dependencies)}/media/upload/${mediaId}/append`,
				{
					method: "POST",
					headers: { Authorization: `Bearer ${account.accessToken}` },
					body: form,
					signal: context.signal,
				},
			);
			if (!appended.ok) {
				throw new ProviderHttpError(
					"x_media_append_failed",
					"upload",
					appended.status,
					xRetryAfterMs(dependencies, appended),
				);
			}
			await context.checkpoint({
				kind: "x_media_upload",
				state: {
					mediaId,
					mediaKey,
					nextSegment: nextSegment + 1,
					chunkBytes,
					expiresAt,
				},
			});
		}
		const finalized = await jsonRequest<{
			data?: {
				processing_info?: { state?: string; check_after_secs?: number };
				expires_after_secs?: number;
			};
		}>(
			dependencies,
			context,
			`https://api.x.com/${xApiVersion(dependencies)}/media/upload/${mediaId}/finalize`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${account.accessToken}` },
				signal: context.signal,
			},
			"x_media_finalize_failed",
			"upload",
		);
		const processing = finalized.data?.processing_info;
		const finalizedExpiresAt = finalized.data?.expires_after_secs
			? new Date(
					dependencies.clock.now().getTime() +
						finalized.data.expires_after_secs * 1000,
				).toISOString()
			: expiresAt;
		if (processing && processing.state !== "succeeded") {
			if (processing.state === "failed") {
				return {
					kind: "failed",
					failure: {
						code: "x_media_processing_failed",
						phase: "upload",
						disposition: "permanent",
						retryAfterMs: null,
					},
				};
			}
			return {
				kind: "pending",
				receiptId: mediaId,
				operation: {
					kind: "x_media_processing",
					state: { mediaId, mediaKey, expiresAt: finalizedExpiresAt },
				},
				nextCheckAt: pendingAt(
					dependencies,
					Math.max(1, processing.check_after_secs ?? 5) * 1000,
				),
				submissionStarted: false,
			};
		}
		return submitXPost(
			dependencies,
			input,
			context,
			account,
			mediaId,
			mediaKey,
			markSubmitted,
		);
	} finally {
		if (!materialized) await cleanupMaterializedMedia(local, input);
	}
}

function xPlatform(
	dependencies: NativePublicationDependencies,
): PublicationPlatform {
	return {
		capabilities: {
			recovery: "bounded",
			asynchronous: true,
			idempotency: "none",
			requiredScopes: ["tweet.write", "media.write"],
			capabilityVersion: SOCIAL_PROVIDER_CAPABILITIES.x.version,
			apiVersion: `x-${dependencies.config.xApiVersion}`,
			maxProviderCalls: 100,
		},
		publish(input, context) {
			return withNativeOutcome(async (markSubmitted) => {
				const account = requireAccount(input, "x");
				requireScopes(account, this.capabilities.requiredScopes);
				if (
					input.media.sizeBytes <= 0 ||
					input.media.sizeBytes > dependencies.config.xMaxMediaBytes ||
					input.caption.length > 280
				) {
					throw new PublicationPlatformConfigurationError(
						"x_publication_invalid",
						"X media facts or Post text are invalid",
					);
				}
				const local = await dependencies.media.materialize(input.media);
				try {
					const initialized = await jsonRequest<{
						data?: { id?: string; media_key?: string; expires_after_secs?: number };
					}>(
						dependencies,
						context,
						`https://api.x.com/${xApiVersion(dependencies)}/media/upload/initialize`,
						{
							method: "POST",
							headers: {
								Authorization: `Bearer ${account.accessToken}`,
								"Content-Type": "application/json",
							},
							body: JSON.stringify({
								media_category: "tweet_video",
								media_type: "video/mp4",
								total_bytes: local.sizeBytes,
								shared: false,
							}),
							signal: context.signal,
						},
						"x_media_init_failed",
						"preparation",
					);
					const mediaId = initialized.data?.id;
					const mediaKey = initialized.data?.media_key;
					const expiresAt = initialized.data?.expires_after_secs
						? new Date(
								dependencies.clock.now().getTime() +
									initialized.data.expires_after_secs * 1000,
							).toISOString()
						: null;
					if (!mediaId || !mediaKey) {
						throw new ProviderHttpError(
							"x_media_identity_missing",
							"preparation",
							502,
							null,
						);
					}
					await context.checkpoint({
						kind: "x_media_upload",
						state: {
							mediaId,
							mediaKey,
							nextSegment: 0,
							chunkBytes: dependencies.config.xChunkBytes,
							expiresAt,
						},
					});
					return continueXMediaUpload(
						dependencies,
						input,
						context,
						account,
						{
							kind: "x_media_upload",
							state: {
								mediaId,
								mediaKey,
								nextSegment: 0,
								chunkBytes: dependencies.config.xChunkBytes,
								expiresAt,
							},
						},
						markSubmitted,
						local,
					);
				} finally {
					await cleanupMaterializedMedia(local, input);
				}
			});
		},
		resume(input, operation, context) {
			return withNativeOutcome(async (markSubmitted) => {
				const account = requireAccount(input, "x");
				requireScopes(account, this.capabilities.requiredScopes);
				return continueXMediaUpload(
					dependencies,
					input,
					context,
					account,
					operation,
					markSubmitted,
				);
			});
		},
		reconcile(input, operation, context) {
			return withNativeOutcome(async (markSubmitted) => {
				markSubmitted();
				const account = requireAccount(input, "x");
				const mediaKey = operationString(operation.state, "mediaKey");
				const startedAt = operationString(
					operation.state,
					"submissionStartedAt",
				);
				if (!mediaKey || !startedAt) {
					return {
						kind: "unknown",
						code: "x_post_checkpoint_invalid",
						phase: "reconciliation",
						operation: null,
					};
				}
				if (
					!account.scopes.includes("tweet.read") ||
					!account.scopes.includes("users.read")
				) {
					return {
						kind: "failed",
						failure: {
							code: "x_reconciliation_permission_missing",
							phase: "reconciliation",
							disposition: "attention",
							retryAfterMs: null,
						},
					};
				}
				const posts: Array<{
					id?: string;
					created_at?: string;
					attachments?: { media_keys?: string[] };
				}> = [];
				let nextToken: string | undefined;
				let paginationExhausted = false;
				for (
					let page = 0;
					page < dependencies.config.xReconciliationMaxPages;
					page += 1
				) {
					const params = new URLSearchParams({
						max_results: "100",
						"tweet.fields": "created_at,attachments",
						expansions: "attachments.media_keys",
						start_time: new Date(Date.parse(startedAt) - 60_000).toISOString(),
					});
					if (nextToken) params.set("pagination_token", nextToken);
					const response = await jsonRequest<{
						data?: Array<{
							id?: string;
							created_at?: string;
							attachments?: { media_keys?: string[] };
						}>;
						meta?: { next_token?: string };
					}>(
						dependencies,
						context,
						`https://api.x.com/${xApiVersion(dependencies)}/users/${encodeURIComponent(account.providerAccountId)}/tweets?${params}`,
						{
							method: "GET",
							headers: { Authorization: `Bearer ${account.accessToken}` },
							signal: context.signal,
						},
						"x_timeline_lookup_failed",
						"reconciliation",
					);
					posts.push(...(response.data ?? []));
					nextToken = response.meta?.next_token;
					if (!nextToken) {
						paginationExhausted = true;
						break;
					}
				}
				if (!paginationExhausted) {
					return {
						kind: "failed",
						failure: {
							code: "x_reconciliation_window_exceeded",
							phase: "reconciliation",
							disposition: "attention",
							retryAfterMs: null,
						},
					};
				}
				const startedMs = Date.parse(startedAt);
				const windowEnd = dependencies.clock.now().getTime() + 60_000;
				const matches = posts.filter((post) => {
					const created = post.created_at ? Date.parse(post.created_at) : Number.NaN;
					return (
						post.id &&
						post.attachments?.media_keys?.includes(mediaKey) &&
						Number.isFinite(created) &&
						created >= startedMs - 60_000 &&
						created <= windowEnd
					);
				});
				if (matches.length === 1) {
					const postId = matches[0]!.id!;
					const username = account.handle?.replace(/^@/, "");
					return {
						kind: "accepted",
						receipt: {
							receiptId: postId,
							platformPostId: postId,
							externalUrl: username
								? `https://x.com/${username}/status/${postId}`
								: `https://x.com/i/web/status/${postId}`,
							metrics: null,
						},
					};
				}
				if (matches.length > 1) {
					return {
						kind: "failed",
						failure: {
							code: "x_reconciliation_multiple_matches",
							phase: "reconciliation",
							disposition: "attention",
							retryAfterMs: null,
						},
					};
				}
				return {
					kind: "unknown",
					code: "x_publication_not_yet_proven",
					phase: "reconciliation",
					operation,
				};
			});
		},
	};
}

export function createNativePublicationPlatformRegistry(
	dependencies: NativePublicationDependencies,
) {
	return createPublicationPlatformRegistry({
		youtube_shorts: youtubePlatform(
			withProviderLatency(dependencies, "youtube_shorts"),
		),
		instagram_reels: instagramPlatform(
			withProviderLatency(dependencies, "instagram_reels"),
		),
		facebook_reels: facebookReelsPlatform(
			withProviderLatency(dependencies, "facebook_reels"),
		),
		tiktok: tiktokPlatform(withProviderLatency(dependencies, "tiktok")),
		linkedin: linkedInPlatform(withProviderLatency(dependencies, "linkedin")),
		x: xPlatform(withProviderLatency(dependencies, "x")),
	});
}

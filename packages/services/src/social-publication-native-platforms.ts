import type { SocialPlatform } from "@narriflow/validators";
import type {
	PublicationOperationPhase,
	PublicationPlatform,
	PublicationPlatformContext,
	PublicationPlatformInput,
	PublicationPlatformResult,
} from "./social-publication-platform";
import {
	PublicationPlatformConfigurationError,
	createPublicationPlatformRegistry,
} from "./social-publication-platform";

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
	config: {
		youtubeChunkBytes: number;
		metaGraphVersion: string;
		linkedInVersion: string;
		instagramPollAttempts: number;
		instagramPollIntervalMs: number;
		tiktokPollIntervalMs: number;
		tiktokChunkBytes: number;
		xChunkBytes: number;
	};
};

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
		throw new ProviderHttpError(
			errorCode,
			phase,
			response.status,
			retryAfterMs(response, dependencies.clock.now()),
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
	if (submitted) {
		if (
			error instanceof ProviderHttpError &&
			error.status >= 400 &&
			error.status < 500 &&
			error.status !== 408 &&
			error.status !== 429
		) {
			return {
				kind: "failed",
				failure: {
					code: error.code,
					phase: error.phase,
					disposition: "permanent",
					retryAfterMs: null,
					safeToRepublishAfterSubmission: true,
				},
			};
		}
		return {
			kind: "unknown",
			code:
				error instanceof ProviderHttpError
					? error.code
					: "social_provider_response_lost",
			phase: error instanceof ProviderHttpError ? error.phase : "submission",
			operation: null,
		};
	}
	if (error instanceof ProviderHttpError) {
		const safeRetry =
			error.status === 408 || error.status === 429 || error.status >= 500;
		return {
			kind: "failed",
			failure: {
				code: error.code,
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
	} catch {
		console.warn(
			JSON.stringify({
				level: "warn",
				message: "social_publication_media_cleanup_failed",
				attemptId: input.attemptId,
				platform: input.platform,
			}),
		);
	}
}

function youtubeReceipt(videoId: string): PublicationPlatformResult {
	return {
		kind: "accepted",
		receipt: {
			receiptId: videoId,
			platformPostId: videoId,
			externalUrl: `https://www.youtube.com/watch?v=${videoId}`,
			metrics: null,
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
		const body = (await response.json()) as { id?: string };
		return body.id ?? null;
	} catch {
		return null;
	}
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
				const videoId = await youtubeCompletedResponse(status);
				if (!videoId) {
					throw new ProviderHttpError(
						"youtube_video_id_missing",
						"reconciliation",
						502,
						null,
					);
				}
				return youtubeReceipt(videoId);
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
					"youtube_upload_status_failed",
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
				const videoId = await youtubeCompletedResponse(response);
				if (!videoId) {
					throw new ProviderHttpError(
						"youtube_video_id_missing",
						"submission",
						502,
						null,
					);
				}
				return youtubeReceipt(videoId);
			}
			if (response.status !== 308) {
				throw new ProviderHttpError(
					"youtube_upload_failed",
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
			apiVersion: "youtube-v3",
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
						"https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
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
							"youtube_upload_init_failed",
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

function instagramPlatform(
	dependencies: NativePublicationDependencies,
): PublicationPlatform {
	return {
		capabilities: {
			recovery: "bounded",
			asynchronous: true,
			idempotency: "none",
			requiredScopes: ["instagram_content_publish"],
			apiVersion: dependencies.config.metaGraphVersion,
			maxProviderCalls: dependencies.config.instagramPollAttempts + 3,
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
				let externalUrl: string | null = null;
				try {
					const details = await jsonRequest<{ permalink?: string }>(
						dependencies,
						context,
						`https://graph.facebook.com/${dependencies.config.metaGraphVersion}/${published.id}?${new URLSearchParams(
							{
								fields: "permalink",
								access_token: account.accessToken,
							},
						)}`,
						{ method: "GET", signal: context.signal },
						"instagram_permalink_failed",
						"reconciliation",
					);
					externalUrl = details.permalink ?? null;
				} catch {
					externalUrl = null;
				}
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
				return instagramAccepted(containerId, published.id);
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
		"https://open.tiktokapis.com/v2/post/publish/status/fetch/",
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

function tiktokPlatform(
	dependencies: NativePublicationDependencies,
): PublicationPlatform {
	return {
		capabilities: {
			recovery: "exact",
			asynchronous: true,
			idempotency: "provider",
			requiredScopes: ["video.publish"],
			apiVersion: "tiktok-v2",
			maxProviderCalls: 100,
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
						};
					}>(
						dependencies,
						context,
						"https://open.tiktokapis.com/v2/post/publish/creator_info/query/",
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
					if (
						input.media.sizeBytes <= 0 ||
						input.caption.length > 2_200 ||
						!Number.isFinite(coverTimestamp) ||
						coverTimestamp < 0
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
						"https://open.tiktokapis.com/v2/post/publish/video/init/",
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
									disable_comment: booleanSetting(
										settings,
										["disableComment"],
										Boolean(creator.data?.comment_disabled),
									),
									disable_duet: booleanSetting(
										settings,
										["disableDuet"],
										Boolean(creator.data?.duet_disabled),
									),
									disable_stitch: booleanSetting(
										settings,
										["disableStitch"],
										Boolean(creator.data?.stitch_disabled),
									),
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
						},
					});
					markSubmitted();
					for (let index = 0; index < totalChunkCount; index += 1) {
						const start = index * chunkSize;
						const end = Math.min(start + chunkSize, local.sizeBytes);
						await context.providerCall?.();
						const upload = await dependencies.fetch(uploadUrl, {
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
							lookupKey: `tiktok:${publishId}`,
							state: {
								providerOperation: "tiktok_publish",
								publishId,
								uploadUrl,
								nextChunk: index + 1,
								chunkBytes: chunkSize,
								totalChunks: totalChunkCount,
							},
						});
					}
					return {
						kind: "pending",
						receiptId: publishId,
						operation: {
							kind: "tiktok_processing",
							lookupKey: `tiktok:${publishId}`,
							state: { publishId },
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
				let nextChunk = operationNumber(operation.state, "nextChunk") ?? 0;
				if (
					uploadUrl &&
					chunkBytes &&
					totalChunks &&
					nextChunk < totalChunks
				) {
					const local = await dependencies.media.materialize(input.media);
					try {
						for (; nextChunk < totalChunks; nextChunk += 1) {
							const start = nextChunk * chunkBytes;
							const end = Math.min(start + chunkBytes, local.sizeBytes);
							await context.providerCall?.();
							const upload = await dependencies.fetch(uploadUrl, {
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
								lookupKey: `tiktok:${publishId}`,
								state: {
									providerOperation: "tiktok_publish",
									publishId,
									uploadUrl,
									nextChunk: nextChunk + 1,
									chunkBytes,
									totalChunks,
								},
							});
						}
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
					return {
						kind: "failed",
						failure: {
							code: "tiktok_publish_failed",
							phase: "reconciliation",
							disposition: "permanent",
							retryAfterMs: null,
						},
					};
				}
				return {
					kind: "pending",
					receiptId: publishId,
					operation: {
						...operation,
						lookupKey: `tiktok:${publishId}`,
					},
					nextCheckAt: new Date(
						dependencies.clock.now().getTime() +
							dependencies.config.tiktokPollIntervalMs,
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
	const local = await dependencies.media.materialize(input.media);
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
		await cleanupMaterializedMedia(local, input);
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
			metadata(input),
			["linkedinOwnerUrn"],
			stringSetting(
				accountMetadata(input),
				["ownerUrn"],
				`urn:li:person:${account.providerAccountId}`,
			),
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

function linkedInPlatform(
	dependencies: NativePublicationDependencies,
): PublicationPlatform {
	return {
		capabilities: {
			recovery: "bounded",
			asynchronous: true,
			idempotency: "none",
			requiredScopes: [],
			apiVersion: dependencies.config.linkedInVersion,
			maxProviderCalls: 100,
		},
		publish(input, context) {
			return withNativeOutcome(async (markSubmitted) => {
				const account = requireAccount(input, "linkedin");
				const settings = metadata(input);
				const owner = requireLinkedInOwner(input, account);
				const visibility = stringSetting(
					settings,
					["linkedinVisibility"],
					"PUBLIC",
				)!;
				if (
					input.media.sizeBytes <= 0 ||
					input.caption.length < 1 ||
					input.caption.length > 3_000 ||
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
					const uploadedPartIds: string[] = [];
					for (const instruction of instructions) {
						if (
							!instruction.uploadUrl ||
							typeof instruction.firstByte !== "number" ||
							typeof instruction.lastByte !== "number"
						) {
							throw new ProviderHttpError(
								"linkedin_video_upload_invalid",
								"upload",
								502,
								null,
							);
						}
						await context.providerCall?.();
						const upload = await dependencies.fetch(instruction.uploadUrl, {
							method: "PUT",
							headers: { "Content-Type": "application/octet-stream" },
							body: await local.blob(
								instruction.firstByte,
								instruction.lastByte + 1,
							),
							signal: context.signal,
						});
						if (!upload.ok) {
							throw new ProviderHttpError(
								"linkedin_video_upload_failed",
								"upload",
								upload.status,
								retryAfterMs(upload, dependencies.clock.now()),
							);
						}
						const etag = upload.headers.get("etag")?.replace(/^"|"$/g, "");
						if (!etag) {
							throw new ProviderHttpError(
								"linkedin_video_etag_missing",
								"upload",
								502,
								null,
							);
						}
						uploadedPartIds.push(etag);
						await context.checkpoint({
							kind: "linkedin_video_upload",
							state: {
								videoUrn,
								owner,
								uploadToken: initialized.value?.uploadToken ?? "",
								uploadInstructions: instructions,
								uploadedPartIds,
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
									video: videoUrn,
									uploadToken: initialized.value?.uploadToken ?? "",
									uploadedPartIds,
								},
							}),
							signal: context.signal,
						},
						"linkedin_video_finalize_failed",
						"upload",
					);
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
					const post = await dependencies.fetch(
						"https://api.linkedin.com/rest/posts",
						{
							method: "POST",
							headers,
							body: JSON.stringify({
								author: owner,
								commentary: input.caption,
								visibility,
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
						},
					);
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
							externalUrl: postId
								? `https://www.linkedin.com/feed/update/${postId}/`
								: null,
							metrics: null,
						},
					};
				} finally {
					await cleanupMaterializedMedia(local, input);
				}
			});
		},
		resume(input, operation, context) {
			return withNativeOutcome(async (markSubmitted) => {
				const account = requireAccount(input, "linkedin");
				requireLinkedInOwner(
					input,
					account,
					operationString(operation.state, "owner"),
				);
				const resumed = await resumeLinkedInVideoUpload(
					dependencies,
					input,
					context,
					operation.state,
				);
				await context.checkpoint({
					kind: "submission_started",
					state: {
						providerOperation: "linkedin_post",
						videoUrn: resumed.videoUrn,
						owner: resumed.owner,
						submissionStartedAt: dependencies.clock.now().toISOString(),
					},
				});
				markSubmitted();
				await context.providerCall?.();
				const settings = metadata(input);
				const post = await dependencies.fetch(
					"https://api.linkedin.com/rest/posts",
					{
						method: "POST",
						headers: resumed.headers,
						body: JSON.stringify({
							author: resumed.owner,
							commentary: input.caption,
							visibility: stringSetting(
								settings,
								["linkedinVisibility"],
								"PUBLIC",
							),
							distribution: {
								feedDistribution: "MAIN_FEED",
								targetEntities: [],
								thirdPartyDistributionChannels: [],
							},
							content: {
								media: {
									title: stringSetting(settings, ["title"], title(input)),
									id: resumed.videoUrn,
								},
							},
							lifecycleState: "PUBLISHED",
							isReshareDisabledByAuthor: booleanSetting(settings, [
								"isReshareDisabledByAuthor",
							]),
						}),
						signal: context.signal,
					},
				);
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
				const parameters = new URLSearchParams({
					author: owner,
					q: "author",
					count: "100",
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
				}>(
					dependencies,
					context,
					`https://api.linkedin.com/rest/posts?${parameters}`,
					{ method: "GET", headers, signal: context.signal },
					"linkedin_post_lookup_failed",
					"reconciliation",
				);
				const startedMs = Date.parse(startedAt);
				const windowEnd = dependencies.clock.now().getTime() + 60_000;
				const matches = (response.elements ?? []).filter(
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
		};
	}>(
		dependencies,
		context,
		`https://api.x.com/2/media/upload?${new URLSearchParams({
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
	return status.data?.processing_info;
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
		"https://api.x.com/2/tweets",
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

function xPlatform(
	dependencies: NativePublicationDependencies,
): PublicationPlatform {
	return {
		capabilities: {
			recovery: "bounded",
			asynchronous: true,
			idempotency: "none",
			requiredScopes: ["tweet.write", "media.write"],
			apiVersion: "x-v2",
			maxProviderCalls: 100,
		},
		publish(input, context) {
			return withNativeOutcome(async (markSubmitted) => {
				const account = requireAccount(input, "x");
				requireScopes(account, this.capabilities.requiredScopes);
				if (input.media.sizeBytes <= 0 || input.caption.length > 280) {
					throw new PublicationPlatformConfigurationError(
						"x_publication_invalid",
						"X media facts or Post text are invalid",
					);
				}
				const local = await dependencies.media.materialize(input.media);
				try {
					const initialized = await jsonRequest<{
						data?: { id?: string; media_key?: string };
					}>(
						dependencies,
						context,
						"https://api.x.com/2/media/upload/initialize",
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
					if (!mediaId) {
						throw new ProviderHttpError(
							"x_media_id_missing",
							"preparation",
							502,
							null,
						);
					}
					await context.checkpoint({
						kind: "x_media_upload",
						state: {
							mediaId,
							mediaKey: initialized.data?.media_key ?? null,
							nextSegment: 0,
							chunkBytes: dependencies.config.xChunkBytes,
						},
					});
					const chunks = Math.max(
						1,
						Math.ceil(local.sizeBytes / dependencies.config.xChunkBytes),
					);
					for (let index = 0; index < chunks; index += 1) {
						const start = index * dependencies.config.xChunkBytes;
						const end = Math.min(
							start + dependencies.config.xChunkBytes,
							local.sizeBytes,
						);
						const form = new FormData();
						form.set("segment_index", String(index));
						form.set("media", await local.blob(start, end), local.fileName);
						await context.providerCall?.();
						const appended = await dependencies.fetch(
							`https://api.x.com/2/media/upload/${mediaId}/append`,
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
								retryAfterMs(appended, dependencies.clock.now()),
							);
						}
						await context.checkpoint({
							kind: "x_media_upload",
							state: {
								mediaId,
								mediaKey: initialized.data?.media_key ?? null,
								nextSegment: index + 1,
								chunkBytes: dependencies.config.xChunkBytes,
							},
						});
					}
					const finalized = await jsonRequest<{
						data?: {
							processing_info?: { state?: string; check_after_secs?: number };
						};
					}>(
						dependencies,
						context,
						`https://api.x.com/2/media/upload/${mediaId}/finalize`,
						{
							method: "POST",
							headers: { Authorization: `Bearer ${account.accessToken}` },
							signal: context.signal,
						},
						"x_media_finalize_failed",
						"upload",
					);
					const processing = finalized.data?.processing_info;
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
								state: {
									mediaId,
									mediaKey: initialized.data?.media_key ?? null,
								},
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
						initialized.data?.media_key ?? null,
						markSubmitted,
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
				const mediaId = operationString(operation.state, "mediaId");
				const mediaKey = operationString(operation.state, "mediaKey");
				const chunkBytes =
					operationNumber(operation.state, "chunkBytes") ??
					dependencies.config.xChunkBytes;
				let nextSegment = operationNumber(operation.state, "nextSegment") ?? 0;
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
				if (operation.kind === "x_media_processing") {
					const processing = await xMediaStatus(
						dependencies,
						context,
						account.accessToken,
						mediaId,
						context.signal,
					);
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
							operation,
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
				const local = await dependencies.media.materialize(input.media);
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
							`https://api.x.com/2/media/upload/${mediaId}/append`,
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
								retryAfterMs(appended, dependencies.clock.now()),
							);
						}
						await context.checkpoint({
							kind: "x_media_upload",
							state: {
								mediaId,
								mediaKey,
								nextSegment: nextSegment + 1,
								chunkBytes,
							},
						});
					}
					const finalized = await jsonRequest<{
						data?: {
							processing_info?: {
								state?: string;
								check_after_secs?: number;
							};
						};
					}>(
						dependencies,
						context,
						`https://api.x.com/2/media/upload/${mediaId}/finalize`,
						{
							method: "POST",
							headers: { Authorization: `Bearer ${account.accessToken}` },
							signal: context.signal,
						},
						"x_media_finalize_failed",
						"upload",
					);
					const processing = finalized.data?.processing_info;
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
								state: { mediaId, mediaKey },
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
					await cleanupMaterializedMedia(local, input);
				}
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
				const params = new URLSearchParams({
					max_results: "100",
					"tweet.fields": "created_at,attachments",
					expansions: "attachments.media_keys",
					start_time: new Date(Date.parse(startedAt) - 60_000).toISOString(),
				});
				const response = await jsonRequest<{
					data?: Array<{
						id?: string;
						created_at?: string;
						attachments?: { media_keys?: string[] };
					}>;
				}>(
					dependencies,
					context,
					`https://api.x.com/2/users/${encodeURIComponent(account.providerAccountId)}/tweets?${params}`,
					{
						method: "GET",
						headers: { Authorization: `Bearer ${account.accessToken}` },
						signal: context.signal,
					},
					"x_timeline_lookup_failed",
					"reconciliation",
				);
				const startedMs = Date.parse(startedAt);
				const windowEnd = dependencies.clock.now().getTime() + 60_000;
				const matches = (response.data ?? []).filter((post) => {
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
		youtube_shorts: youtubePlatform(dependencies),
		instagram_reels: instagramPlatform(dependencies),
		tiktok: tiktokPlatform(dependencies),
		linkedin: linkedInPlatform(dependencies),
		x: xPlatform(dependencies),
	});
}

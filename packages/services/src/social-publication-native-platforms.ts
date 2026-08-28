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
	sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
	random(): number;
	clock: { now(): Date };
	config: {
		metaGraphVersion: string;
		linkedInVersion: string;
		instagramPollAttempts: number;
		instagramPollIntervalMs: number;
		tiktokPollAttempts: number;
		tiktokPollIntervalMs: number;
		tiktokChunkBytes: number;
		xPollAttempts: number;
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

function youtubePlatform(
	dependencies: NativePublicationDependencies,
): PublicationPlatform {
	return {
		capabilities: {
			recovery: "none",
			asynchronous: false,
			idempotency: "none",
			requiredScopes: ["https://www.googleapis.com/auth/youtube.upload"],
			apiVersion: "youtube-v3",
			maxProviderCalls: 3,
		},
		publish(input, context) {
			return withNativeOutcome(async (markSubmitted) => {
				const account = requireAccount(input, "youtube_shorts");
				const media = await dependencies.media.materialize(input.media);
				try {
					const settings = metadata(input);
					await context.providerCall?.();
					const init = await dependencies.fetch(
						"https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
						{
							method: "POST",
							headers: {
								Authorization: `Bearer ${account.accessToken}`,
								"Content-Type": "application/json; charset=UTF-8",
								"X-Upload-Content-Type": "video/mp4",
								"X-Upload-Content-Length": String(media.sizeBytes),
							},
							body: JSON.stringify({
								snippet: {
									title: stringSetting(settings, ["title"], title(input)),
									description: input.caption,
									categoryId: stringSetting(
										settings,
										["youtubeCategoryId"],
										"22",
									),
								},
								status: {
									privacyStatus: stringSetting(
										settings,
										["youtubePrivacyStatus", "privacyStatus"],
										"public",
									),
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
					await context.checkpoint({
						kind: "submission_started",
						state: { providerOperation: "youtube_resumable_upload", uploadUrl },
					});
					markSubmitted();
					const uploaded = await jsonRequest<{ id?: string }>(
						dependencies,
						context,
						uploadUrl,
						{
							method: "PUT",
							headers: {
								"Content-Type": "video/mp4",
								"Content-Length": String(media.sizeBytes),
							},
							body: await media.blob(),
							signal: context.signal,
						},
						"youtube_upload_failed",
						"submission",
					);
					if (!uploaded.id) {
						throw new ProviderHttpError(
							"youtube_video_id_missing",
							"submission",
							502,
							null,
						);
					}
					return {
						kind: "accepted",
						receipt: {
							receiptId: uploaded.id,
							platformPostId: uploaded.id,
							externalUrl: `https://www.youtube.com/watch?v=${uploaded.id}`,
							metrics: null,
						},
					};
				} finally {
					await cleanupMaterializedMedia(media, input);
				}
			});
		},
	};
}

async function waitForInstagramContainer(
	dependencies: NativePublicationDependencies,
	context: PublicationPlatformContext,
	accessToken: string,
	containerId: string,
	signal: AbortSignal,
) {
	for (
		let attempt = 0;
		attempt < dependencies.config.instagramPollAttempts;
		attempt += 1
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
		if (result.status_code === "FINISHED") return;
		if (result.status_code === "ERROR" || result.status_code === "EXPIRED") {
			throw new ProviderHttpError(
				"instagram_container_processing_failed",
				"preparation",
				400,
				null,
			);
		}
		await dependencies.sleep(
			dependencies.config.instagramPollIntervalMs,
			signal,
		);
	}
	throw new ProviderHttpError(
		"instagram_container_processing_timeout",
		"preparation",
		504,
		null,
	);
}

function instagramPlatform(
	dependencies: NativePublicationDependencies,
): PublicationPlatform {
	return {
		capabilities: {
			recovery: "none",
			asynchronous: false,
			idempotency: "none",
			requiredScopes: ["instagram_content_publish"],
			apiVersion: dependencies.config.metaGraphVersion,
			maxProviderCalls: dependencies.config.instagramPollAttempts + 3,
		},
		publish(input, context) {
			return withNativeOutcome(async (markSubmitted) => {
				const account = requireAccount(input, "instagram_reels");
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
				await waitForInstagramContainer(
					dependencies,
					context,
					account.accessToken,
					container.id,
					context.signal,
				);
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
				return {
					kind: "accepted",
					receipt: {
						receiptId: container.id,
						platformPostId: published.id,
						externalUrl,
						metrics: null,
					},
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
	return {
		status: String(state.status ?? state.status_code ?? "PROCESSING"),
		platformPostId:
			typeof state.publicly_available_post_id === "string"
				? state.publicly_available_post_id
				: typeof state.publicaly_available_post_id === "string"
					? state.publicaly_available_post_id
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
									video_cover_timestamp_ms: Number(
										settings.videoCoverTimestampMs ?? 1000,
									),
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
						state: {
							providerOperation: "tiktok_publish",
							publishId,
							uploadUrl,
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
					}
					for (
						let attempt = 0;
						attempt < dependencies.config.tiktokPollAttempts;
						attempt += 1
					) {
						await dependencies.sleep(
							dependencies.config.tiktokPollIntervalMs,
							context.signal,
						);
						const status = await tiktokStatus(
							dependencies,
							context,
							account.accessToken,
							publishId,
							context.signal,
						);
						if (
							status.status === "PUBLISH_COMPLETE" ||
							status.status === "SEND_TO_USER_INBOX"
						) {
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
					}
					return {
						kind: "pending",
						receiptId: publishId,
						operation: {
							kind: "tiktok_processing",
							state: { publishId },
						},
						nextCheckAt: new Date(
							dependencies.clock.now().getTime() +
								dependencies.config.tiktokPollIntervalMs,
						),
					};
				} finally {
					await cleanupMaterializedMedia(local, input);
				}
			});
		},
		reconcile(input, operation, context) {
			return withNativeOutcome(async () => {
				const account = requireAccount(input, "tiktok");
				const publishId = stringSetting(operation.state, ["publishId"]);
				if (!publishId) {
					return {
						kind: "unknown",
						code: "tiktok_publish_id_missing",
						phase: "reconciliation",
						operation: null,
					};
				}
				const status = await tiktokStatus(
					dependencies,
					context,
					account.accessToken,
					publishId,
					context.signal,
				);
				if (
					status.status === "PUBLISH_COMPLETE" ||
					status.status === "SEND_TO_USER_INBOX"
				) {
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
					operation,
					nextCheckAt: new Date(
						dependencies.clock.now().getTime() +
							dependencies.config.tiktokPollIntervalMs,
					),
				};
			});
		},
	};
}

function linkedInPlatform(
	dependencies: NativePublicationDependencies,
): PublicationPlatform {
	return {
		capabilities: {
			recovery: "none",
			asynchronous: false,
			idempotency: "none",
			requiredScopes: ["w_member_social"],
			apiVersion: dependencies.config.linkedInVersion,
			maxProviderCalls: 100,
		},
		publish(input, context) {
			return withNativeOutcome(async (markSubmitted) => {
				const account = requireAccount(input, "linkedin");
				const local = await dependencies.media.materialize(input.media);
				try {
					const settings = metadata(input);
					const owner = stringSetting(
						settings,
						["linkedinOwnerUrn"],
						stringSetting(
							accountMetadata(input),
							["ownerUrn"],
							`urn:li:person:${account.providerAccountId}`,
						),
					)!;
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
						state: { videoUrn },
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
						state: { providerOperation: "linkedin_post", videoUrn, owner },
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
					return {
						kind: "accepted",
						receipt: {
							receiptId: postId ?? videoUrn,
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
	};
}

async function waitForXMedia(
	dependencies: NativePublicationDependencies,
	context: PublicationPlatformContext,
	accessToken: string,
	mediaId: string,
	initial: { state?: string; check_after_secs?: number } | undefined,
	signal: AbortSignal,
) {
	let processing = initial;
	for (
		let attempt = 0;
		attempt < dependencies.config.xPollAttempts;
		attempt += 1
	) {
		if (!processing || processing.state === "succeeded") return;
		if (processing.state === "failed") {
			throw new ProviderHttpError(
				"x_media_processing_failed",
				"upload",
				400,
				null,
			);
		}
		await dependencies.sleep(
			Math.max(1, processing.check_after_secs ?? 5) * 1000,
			signal,
		);
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
		processing = status.data?.processing_info;
	}
	throw new ProviderHttpError(
		"x_media_processing_timeout",
		"upload",
		504,
		null,
	);
}

function xPlatform(
	dependencies: NativePublicationDependencies,
): PublicationPlatform {
	return {
		capabilities: {
			recovery: "none",
			asynchronous: false,
			idempotency: "none",
			requiredScopes: ["tweet.write", "media.write"],
			apiVersion: "x-v2",
			maxProviderCalls: 100,
		},
		publish(input, context) {
			return withNativeOutcome(async (markSubmitted) => {
				const account = requireAccount(input, "x");
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
						state: { mediaId, mediaKey: initialized.data?.media_key ?? null },
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
					await waitForXMedia(
						dependencies,
						context,
						account.accessToken,
						mediaId,
						finalized.data?.processing_info,
						context.signal,
					);
					await context.checkpoint({
						kind: "submission_started",
						state: {
							providerOperation: "x_post",
							mediaId,
							mediaKey: initialized.data?.media_key ?? null,
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
						throw new ProviderHttpError(
							"x_post_id_missing",
							"submission",
							502,
							null,
						);
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
				} finally {
					await cleanupMaterializedMedia(local, input);
				}
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

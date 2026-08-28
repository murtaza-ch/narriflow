import { describe, expect, test } from "bun:test";
import type { SocialPlatform } from "@narriflow/validators";
import { createNativePublicationPlatformRegistry } from "./social-publication-native-platforms";
import type { PublicationPlatformInput } from "./social-publication-platform";

const CONTRACT_FIXTURE = (await Bun.file(
	new URL("./__fixtures__/social-publication/native-provider-contracts.json", import.meta.url),
).json()) as {
	instagram: {
		account: { id: string };
		withinLimit: unknown;
		atLimit: unknown;
	};
	tiktok: { providerDisabled: unknown; rateFailure: unknown };
	linkedin: { processing: unknown; available: unknown; failed: unknown };
	x: { processing: unknown; failed: unknown };
};

const PLATFORM_SCOPES: Record<SocialPlatform, string[]> = {
	youtube_shorts: ["https://www.googleapis.com/auth/youtube.upload"],
	instagram_reels: ["instagram_content_publish"],
	tiktok: ["video.publish"],
	linkedin: ["w_member_social", "r_member_social"],
	x: ["tweet.write", "media.write", "tweet.read", "users.read"],
};

function json(value: unknown, init: ResponseInit = {}) {
	return new Response(JSON.stringify(value), {
		status: 200,
		headers: { "Content-Type": "application/json", ...init.headers },
		...init,
	});
}

function input(platform: SocialPlatform): PublicationPlatformInput {
	return {
		attemptId: "attempt-1",
		idempotencyKey: "publication-attempt-1",
		socialPostId: "post-1",
		projectId: "project-1",
		platform,
		caption: "Approved caption",
		scheduledFor: new Date("2026-08-28T10:00:00.000Z"),
		providerSettings: {
			title: "Approved title",
			youtubePrivacyStatus: "unlisted",
			shareToFeed: false,
			linkedinVisibility: "CONNECTIONS",
			madeWithAi: true,
			tiktokPrivacyLevel: "PUBLIC_TO_EVERYONE",
			mediaDurationSec: 1,
			videoCoverTimestampMs: 500,
		},
		account: {
			id: "account-1",
			userId: "user-1",
			platform,
			providerAccountId: "provider-account-1",
			displayName: "Creator",
			handle: "@creator",
			accessToken: "access-token",
			scopes: PLATFORM_SCOPES[platform],
			metadata:
				platform === "instagram_reels"
					? { igUserId: "instagram-user-1" }
					: platform === "linkedin"
						? { ownerUrn: "urn:li:person:creator" }
						: null,
		},
		media: {
			storageKey: "private/export.mp4",
			fileName: "export.mp4",
			contentType: "video/mp4",
			sizeBytes: 8,
			durationSec: 1,
			aspectRatio: "9:16",
		},
	};
}

function harness(
	responses: Response[],
	cleanupFails = false,
	metrics?: {
		observe(
			name: string,
			value: number,
			attributes?: Record<string, string | number | boolean | undefined>,
		): void;
	},
) {
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	let cleanups = 0;
	const registry = createNativePublicationPlatformRegistry({
		fetch: async (url, init) => {
			requests.push({ url: String(url), init });
			const next = responses.shift();
			if (!next) throw new Error(`No response scripted for ${String(url)}`);
			return next;
		},
		media: {
			async materialize(media) {
				return {
					sizeBytes: media.sizeBytes,
					fileName: media.fileName,
					blob: async (start = 0, end = media.sizeBytes) =>
						new Blob([new Uint8Array(end - start)]),
					cleanup: async () => {
						cleanups += 1;
						if (cleanupFails) throw new Error("temporary cleanup failure");
					},
				};
			},
			createScopedAccess: async () =>
				"https://media.example/scoped/export.mp4?grant=short",
		},
		clock: { now: () => new Date("2026-08-28T10:00:00.000Z") },
		metrics,
		config: {
			youtubeApiVersion: "v3",
			youtubeChunkBytes: 8,
			metaGraphVersion: "v24.0",
			linkedInVersion: "202608",
			instagramPollAttempts: 2,
			instagramPollIntervalMs: 1,
			tiktokPollIntervalMs: 1,
			tiktokChunkBytes: 8,
			tiktokApiVersion: "v2",
			xApiVersion: "v2",
			xChunkBytes: 8,
			xMaxMediaBytes: 512 * 1024 * 1024,
			xRateLimitRetryFloorMs: 60_000,
			xReconciliationMaxPages: 5,
		},
	});
	return {
		registry,
		requests,
		cleanupCount: () => cleanups,
	};
}

async function publish(
	platform: SocialPlatform,
	responses: Response[],
	cleanupFails = false,
) {
	const state = harness(responses, cleanupFails);
	const checkpoints: Array<{ kind: string; state: Record<string, unknown> }> = [];
	const result = await state.registry.get(platform).publish(input(platform), {
		signal: new AbortController().signal,
		checkpoint: async (operation) =>
			checkpoints.push({
				kind: operation.kind,
				state: operation.state as Record<string, unknown>,
			}),
	});
	return { ...state, result, checkpoints };
}

describe("native publication adapters", () => {
	test("preserves the YouTube upload request and receipt", async () => {
		const state = await publish("youtube_shorts", [
			json(
				{},
				{ headers: { Location: "https://youtube-upload.example/session" } },
			),
			json({ id: "youtube-video-1" }),
		]);
		expect(state.result).toMatchObject({
			kind: "accepted",
			receipt: {
				receiptId: "youtube-video-1",
				externalUrl: "https://www.youtube.com/watch?v=youtube-video-1",
				providerProcessingStatus: "processing",
			},
		});
		expect(state.checkpoints.map((checkpoint) => checkpoint.kind)).toEqual([
			"submission_started",
		]);
		expect(JSON.parse(String(state.requests[0]!.init?.body))).toMatchObject({
			snippet: { title: "Approved title", description: "Approved caption" },
			status: { privacyStatus: "unlisted" },
		});
		expect(state.cleanupCount()).toBe(1);
	});

	test("retains an accepted YouTube receipt when the final resource reports processing failure", async () => {
		const state = await publish("youtube_shorts", [
			json({}, { headers: { Location: "https://youtube-upload.example/session" } }),
			json({
				id: "youtube-video-rejected",
				status: {
					uploadStatus: "rejected",
					rejectionReason: "duplicate",
					privacyStatus: "private",
				},
			}),
		]);

		expect(state.result).toMatchObject({
			kind: "accepted",
			receipt: {
				receiptId: "youtube-video-rejected",
				providerProcessingStatus: "failed",
				providerProcessingFailureCode: "youtube_processing_failed",
				providerVisibility: "private",
			},
		});
	});

	test("does not discard accepted YouTube evidence when local cleanup fails", async () => {
		const state = await publish(
			"youtube_shorts",
			[
				json(
					{},
					{ headers: { Location: "https://youtube-upload.example/session" } },
				),
				json({ id: "youtube-video-cleanup-safe" }),
			],
			true,
		);

		expect(state.result).toMatchObject({
			kind: "accepted",
			receipt: { receiptId: "youtube-video-cleanup-safe" },
		});
		expect(state.cleanupCount()).toBe(1);
	});

	test("does not treat a generic post-submission 4xx as proof of non-publication", async () => {
		const state = await publish("youtube_shorts", [
			json(
				{},
				{ headers: { Location: "https://youtube-upload.example/session" } },
			),
			new Response(null, { status: 403 }),
		]);

		expect(state.result).toMatchObject({
			kind: "unknown",
			code: "youtube_permission_required",
			phase: "upload",
		});
	});

	test("preserves Instagram container, publish, and permalink behavior", async () => {
		const state = await publish("instagram_reels", [
			json({ id: "instagram-user-1" }),
			json({ data: [{ quota_usage: 1, config: { quota_total: 50 } }] }),
			json({ id: "container-1" }),
			json({ status_code: "FINISHED" }),
			json({ id: "instagram-post-1" }),
			json({ permalink: "https://instagram.example/reel/1" }),
		]);
		expect(state.result).toMatchObject({
			kind: "accepted",
			receipt: {
				receiptId: "container-1",
				platformPostId: "instagram-post-1",
				externalUrl: "https://instagram.example/reel/1",
			},
		});
		expect(state.checkpoints.map((checkpoint) => checkpoint.kind)).toEqual([
			"instagram_container",
			"submission_started",
		]);
		expect(String(state.requests[2]!.init?.body)).toContain(
			"caption=Approved+caption",
		);
		expect(String(state.requests[2]!.init?.body)).toContain(
			"share_to_feed=false",
		);
	});

	test("preserves TikTok creator settings, upload, and accepted receipt", async () => {
		const state = await publish("tiktok", [
			json({
				data: {
					creator_username: "creator",
					privacy_level_options: ["PUBLIC_TO_EVERYONE"],
				},
			}),
			json({
				data: {
					upload_url: "https://tiktok-upload.example/session",
					publish_id: "publish-1",
				},
			}),
			new Response(null, { status: 204 }),
			json({
				data: {
					status: "PUBLISH_COMPLETE",
					publicaly_available_post_id: [7_654_321],
				},
			}),
		]);
		expect(state.result).toMatchObject({
			kind: "pending",
			receiptId: "publish-1",
		});
		if (state.result.kind !== "pending") throw new Error("expected pending");
		const reconciled = await state.registry.get("tiktok").reconcile!(
			input("tiktok"),
			state.result.operation,
			{
				signal: new AbortController().signal,
				checkpoint: async () => undefined,
			},
		);
		expect(reconciled).toMatchObject({
			kind: "accepted",
			receipt: {
				receiptId: "publish-1",
				platformPostId: "7654321",
				externalUrl: "https://www.tiktok.com/@creator/video/7654321",
			},
		});
		expect(state.checkpoints.map((checkpoint) => checkpoint.kind)).toEqual([
			"submission_started",
			"submission_started",
		]);
		expect(state.cleanupCount()).toBe(1);
	});

	test("preserves LinkedIn multipart upload and post receipt", async () => {
		const state = await publish("linkedin", [
			json({
				value: {
					video: "urn:li:video:1",
					uploadToken: "upload-token",
					uploadInstructions: [
						{
							uploadUrl: "https://linkedin-upload.example/part",
							firstByte: 0,
							lastByte: 7,
						},
					],
				},
			}),
			new Response(null, { status: 201, headers: { ETag: '"part-1"' } }),
			json({}),
			json({ status: "AVAILABLE" }),
			new Response(null, {
				status: 201,
				headers: { "x-restli-id": "urn:li:share:1" },
			}),
		]);
		expect(state.result).toMatchObject({
			kind: "pending",
			operation: { kind: "linkedin_video_processing" },
		});
		if (state.result.kind !== "pending") throw new Error("expected pending");
		const result = await state.registry.get("linkedin").resume!(
			input("linkedin"),
			state.result.operation,
			{
				signal: new AbortController().signal,
				checkpoint: async (operation) =>
					state.checkpoints.push({
						kind: operation.kind,
						state: operation.state as Record<string, unknown>,
					}),
			},
		);
		expect(result).toMatchObject({
			kind: "accepted",
			receipt: {
				platformPostId: "urn:li:share:1",
				externalUrl: "https://www.linkedin.com/feed/update/urn:li:share:1/",
			},
		});
		expect(state.checkpoints.map((checkpoint) => checkpoint.kind)).toEqual([
			"linkedin_video_upload",
			"linkedin_video_upload",
			"submission_started",
		]);
		expect(JSON.parse(String(state.requests[4]!.init?.body))).toMatchObject({
			commentary: "Approved caption",
			visibility: "CONNECTIONS",
			content: { media: { id: "urn:li:video:1", title: "Approved title" } },
		});
		expect(state.cleanupCount()).toBe(1);
	});

	test("preserves X media upload, caption limit, and post receipt", async () => {
		const state = await publish("x", [
			json({ data: { id: "media-1", media_key: "media-key-1" } }),
			new Response(null, { status: 204 }),
			json({ data: {} }),
			json({ data: { id: "x-post-1" } }),
		]);
		expect(state.result).toMatchObject({
			kind: "accepted",
			receipt: {
				receiptId: "x-post-1",
				externalUrl: "https://x.com/creator/status/x-post-1",
			},
		});
		expect(state.checkpoints.map((checkpoint) => checkpoint.kind)).toEqual([
			"x_media_upload",
			"x_media_upload",
			"submission_started",
		]);
		expect(JSON.parse(String(state.requests[3]!.init?.body))).toEqual({
			text: "Approved caption",
			media: { media_ids: ["media-1"] },
			made_with_ai: true,
		});
		expect(state.cleanupCount()).toBe(1);
	});

	test("attributes provider latency to the adapter and specific operation", async () => {
		const observed: Array<{
			name: string;
			attributes?: Record<string, string | number | boolean | undefined>;
		}> = [];
		const metrics = {
			observe(
				name: string,
				_value: number,
				attributes?: Record<string, string | number | boolean | undefined>,
			) {
				observed.push({ name, attributes });
			},
		};
		const xState = harness(
			[
				json({ data: { id: "media-1", media_key: "media-key-1" } }),
				new Response(null, { status: 204 }),
				json({ data: {} }),
				json({ data: { id: "x-post-1" } }),
			],
			false,
			metrics,
		);
		await xState.registry.get("x").publish(input("x"), {
			signal: new AbortController().signal,
			checkpoint: async () => {},
		});
		expect(observed).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					attributes: expect.objectContaining({
						platform: "x",
						operation: "initialize",
					}),
				}),
				expect.objectContaining({
					attributes: expect.objectContaining({
						platform: "x",
						operation: "finalize",
					}),
				}),
			]),
		);

		observed.length = 0;
		const linkedInState = harness(
			[
				json({
					value: {
						video: "urn:li:video:1",
						uploadToken: "upload-token",
						uploadInstructions: [
							{
								uploadUrl: "https://provider-upload.example/part",
								firstByte: 0,
								lastByte: 7,
							},
						],
					},
				}),
				new Response(null, { status: 201, headers: { ETag: '"part-1"' } }),
				json({}),
				json({ status: "PROCESSING" }),
			],
			false,
			metrics,
		);
		await linkedInState.registry.get("linkedin").publish(input("linkedin"), {
			signal: new AbortController().signal,
			checkpoint: async () => {},
		});
		expect(observed).toContainEqual(
			expect.objectContaining({
				attributes: expect.objectContaining({
					platform: "linkedin",
					operation: "upload",
				}),
			}),
		);
	});

	test("resumes the same YouTube session from the provider byte range", async () => {
		const state = harness([
			new Response(null, {
				status: 308,
				headers: { Range: "bytes=0-3" },
			}),
			json({ id: "youtube-video-resumed" }, { status: 201 }),
		]);
		const platform = state.registry.get("youtube_shorts");
		const result = await platform.reconcile!(
			input("youtube_shorts"),
			{
				kind: "submission_started",
				state: {
					providerOperation: "youtube_resumable_upload",
					uploadUrl: "https://youtube-upload.example/session",
					uploadedBytes: 0,
					totalBytes: 8,
				},
			},
			{
				signal: new AbortController().signal,
				checkpoint: async () => undefined,
			},
		);

		expect(result).toMatchObject({
			kind: "accepted",
			receipt: { receiptId: "youtube-video-resumed" },
		});
		expect(state.requests[0]).toMatchObject({
			url: "https://youtube-upload.example/session",
			init: { method: "PUT" },
		});
		expect(state.requests[0]!.init?.headers).toMatchObject({
			"Content-Range": "bytes */8",
		});
		expect(state.requests[1]!.init?.headers).toMatchObject({
			"Content-Range": "bytes 4-7/8",
		});
	});

	test("recovers a published Instagram container after a lost media_publish response", async () => {
		const state = harness([json({ status_code: "PUBLISHED" })]);
		const result = await state.registry.get("instagram_reels").reconcile!(
			input("instagram_reels"),
			{
				kind: "submission_started",
				state: {
					providerOperation: "instagram_media_publish",
					containerId: "container-lost-response",
				},
			},
			{
				signal: new AbortController().signal,
				checkpoint: async () => undefined,
			},
		);

		expect(result).toEqual({
			kind: "accepted",
			receipt: {
				receiptId: "container-lost-response",
				platformPostId: null,
				externalUrl: null,
				metrics: null,
			},
		});
		expect(state.requests).toHaveLength(1);
	});

	test("releases TikTok moderation to durable provider processing", async () => {
		const state = await publish("tiktok", [
			json({
				data: {
					creator_username: "creator",
					privacy_level_options: ["PUBLIC_TO_EVERYONE"],
				},
			}),
			json({
				data: {
					upload_url: "https://tiktok-upload.example/session",
					publish_id: "publish-pending",
				},
			}),
			new Response(null, { status: 204 }),
		]);

		expect(state.result).toMatchObject({
			kind: "pending",
			receiptId: "publish-pending",
			operation: {
				kind: "tiktok_processing",
				state: { publishId: "publish-pending", moderationChecks: 0 },
			},
		});
		expect(state.requests).toHaveLength(3);
	});

	test("treats TikTok's FAILED moderation result as definitive republish evidence", async () => {
		const state = harness([json({ data: { status: "FAILED" } })]);
		const result = await state.registry.get("tiktok").reconcile!(
			input("tiktok"),
			{
				kind: "tiktok_processing",
				lookupKey: "tiktok:publish-failed",
				state: { publishId: "publish-failed", moderationChecks: 12 },
			},
			{ signal: new AbortController().signal, checkpoint: async () => undefined },
		);

		expect(result).toMatchObject({
			kind: "failed",
			failure: {
				code: "tiktok_publish_failed",
				disposition: "permanent",
				safeToRepublishAfterSubmission: true,
			},
		});
	});

	test("resumes TikTok upload from the checkpointed chunk index", async () => {
		const state = harness([
			new Response(null, { status: 204 }),
			json({ data: { status: "PROCESSING_UPLOAD" } }),
		]);
		const result = await state.registry.get("tiktok").reconcile!(
			input("tiktok"),
			{
				kind: "submission_started",
				state: {
					providerOperation: "tiktok_publish",
					publishId: "publish-resumed",
					uploadUrl: "https://tiktok-upload.example/session",
					nextChunk: 1,
					chunkBytes: 4,
					totalChunks: 2,
				},
			},
			{
				signal: new AbortController().signal,
				checkpoint: async () => undefined,
			},
		);

		expect(result).toMatchObject({
			kind: "pending",
			receiptId: "publish-resumed",
			operation: { state: { moderationChecks: 1 } },
			nextCheckAt: new Date("2026-08-28T10:00:00.002Z"),
		});
		expect(state.requests[0]!.url).toBe(
			"https://tiktok-upload.example/session",
		);
		expect(state.requests[0]!.init?.headers).toMatchObject({
			"Content-Range": "bytes 4-7/8",
		});
	});

	test("reconciles a lost LinkedIn Post response by exact author and video URN", async () => {
		const state = harness([
			json({
				elements: [
					{
						id: "urn:li:share:exact",
						author: "urn:li:person:creator",
						createdAt: new Date("2026-08-28T10:00:05.000Z").getTime(),
						content: { media: { id: "urn:li:video:exact" } },
					},
				],
				paging: { links: [] },
			}),
		]);
		const result = await state.registry.get("linkedin").reconcile!(
			input("linkedin"),
			{
				kind: "submission_started",
				state: {
					providerOperation: "linkedin_post",
					videoUrn: "urn:li:video:exact",
					owner: "urn:li:person:creator",
					submissionStartedAt: "2026-08-28T10:00:00.000Z",
				},
			},
			{
				signal: new AbortController().signal,
				checkpoint: async () => undefined,
			},
		);

		expect(result).toMatchObject({
			kind: "accepted",
			receipt: { platformPostId: "urn:li:share:exact" },
		});
		expect(state.requests[0]!.url).toContain("q=author");
	});

	test("resumes LinkedIn multipart upload from checkpointed completed parts", async () => {
		const state = harness([
			new Response(null, { status: 201, headers: { ETag: '"part-2"' } }),
			json({}),
			json({ status: "AVAILABLE" }),
			new Response(null, {
				status: 201,
				headers: { "x-restli-id": "urn:li:share:resumed" },
			}),
		]);
		const checkpoints: string[] = [];
		const pending = await state.registry.get("linkedin").resume!(
			input("linkedin"),
			{
				kind: "linkedin_video_upload",
				state: {
					videoUrn: "urn:li:video:resumed",
					owner: "urn:li:person:creator",
					uploadToken: "upload-token",
					uploadInstructions: [
						{ uploadUrl: "https://linkedin-upload.example/part-1", firstByte: 0, lastByte: 3 },
						{ uploadUrl: "https://linkedin-upload.example/part-2", firstByte: 4, lastByte: 7 },
					],
					uploadedPartIds: ["part-1"],
				},
			},
			{
				signal: new AbortController().signal,
				checkpoint: async (operation) => checkpoints.push(operation.kind),
			},
		);

		expect(pending).toMatchObject({
			kind: "pending",
			operation: { kind: "linkedin_video_processing" },
		});
		if (pending.kind !== "pending") throw new Error("expected pending");
		const result = await state.registry.get("linkedin").resume!(
			input("linkedin"),
			pending.operation,
			{
				signal: new AbortController().signal,
				checkpoint: async (operation) => checkpoints.push(operation.kind),
			},
		);
		expect(result).toMatchObject({
			kind: "accepted",
			receipt: { platformPostId: "urn:li:share:resumed" },
		});
		expect(state.requests[0]!.url).toBe(
			"https://linkedin-upload.example/part-2",
		);
		expect(checkpoints).toContain("submission_started");
	});

	test("reconciles a lost X create response by exact attached media key", async () => {
		const state = harness([
			json({
				data: [
					{
						id: "x-post-exact",
						created_at: "2026-08-28T10:00:05.000Z",
						attachments: { media_keys: ["media-key-exact"] },
					},
				],
				meta: {},
			}),
		]);
		const result = await state.registry.get("x").reconcile!(
			input("x"),
			{
				kind: "submission_started",
				state: {
					providerOperation: "x_post",
					mediaId: "media-exact",
					mediaKey: "media-key-exact",
					submissionStartedAt: "2026-08-28T10:00:00.000Z",
				},
			},
			{
				signal: new AbortController().signal,
				checkpoint: async () => undefined,
			},
		);

		expect(result).toMatchObject({
			kind: "accepted",
			receipt: { platformPostId: "x-post-exact" },
		});
		expect(state.requests[0]!.url).toContain(
			"expansions=attachments.media_keys",
		);
	});

	test("resumes X chunk upload from the durable segment index", async () => {
		const state = harness([
			new Response(null, { status: 204 }),
			json({ data: {} }),
			json({ data: { id: "x-post-resumed" } }),
		]);
		const result = await state.registry.get("x").resume!(
			input("x"),
			{
				kind: "x_media_upload",
				state: {
					mediaId: "media-resumed",
					mediaKey: "media-key-resumed",
					nextSegment: 1,
					chunkBytes: 4,
				},
			},
			{
				signal: new AbortController().signal,
				checkpoint: async () => undefined,
			},
		);

		expect(result).toMatchObject({
			kind: "accepted",
			receipt: { platformPostId: "x-post-resumed" },
		});
		expect(state.requests[0]!.url).toBe(
			"https://api.x.com/2/media/upload/media-resumed/append",
		);
		const form = state.requests[0]!.init?.body as FormData;
		expect(form.get("segment_index")).toBe("1");
	});

	test("applies the configured X rate-limit floor to chunk uploads", async () => {
		const observed: Array<{
			name: string;
			attributes?: Record<string, string | number | boolean | undefined>;
		}> = [];
		const state = harness([new Response(null, { status: 429 })], false, {
			observe(name, _value, attributes) {
				observed.push({ name, attributes });
			},
		});
		const result = await state.registry.get("x").resume!(
			input("x"),
			{
				kind: "x_media_upload",
				state: {
					mediaId: "media-id",
					mediaKey: "media-key",
					nextSegment: 0,
					chunkBytes: 8,
				},
			},
			{ signal: new AbortController().signal, checkpoint: async () => {} },
		);
		expect(result).toMatchObject({
			kind: "failed",
			failure: {
				code: "x_rate_limit",
				disposition: "safe_retry",
				retryAfterMs: 60_000,
			},
		});
		expect(observed).toContainEqual({
			name: "social_publication_provider_operation_duration_ms",
			attributes: {
				platform: "x",
				operation: "upload",
				outcome: "http_error",
			},
		});
	});

	test("checks X media processing without replaying upload segments", async () => {
		const state = harness([
			json({ data: { processing_info: { state: "succeeded" } } }),
			json({ data: { id: "x-post-after-processing" } }),
		]);
		const result = await state.registry.get("x").resume!(
			input("x"),
			{
				kind: "x_media_processing",
				state: {
					mediaId: "media-processing",
					mediaKey: "media-key-processing",
				},
			},
			{
				signal: new AbortController().signal,
				checkpoint: async () => undefined,
			},
		);

		expect(result).toMatchObject({
			kind: "accepted",
			receipt: { platformPostId: "x-post-after-processing" },
		});
		expect(state.requests.map((request) => request.url)).toEqual([
			"https://api.x.com/2/media/upload?command=STATUS&media_id=media-processing",
			"https://api.x.com/2/tweets",
		]);
		expect(state.cleanupCount()).toBe(0);
	});

	test("rejects an X upload identity without a media key before checkpointing", async () => {
		const state = await publish("x", [json({ data: { id: "media-without-key" } })]);

		expect(state.result).toMatchObject({
			kind: "failed",
			failure: {
				code: "x_media_identity_missing",
				phase: "preparation",
				disposition: "safe_retry",
			},
		});
		expect(state.checkpoints).toHaveLength(0);
		expect(state.requests).toHaveLength(1);
	});

	test("enforces YouTube audit privacy before initiating a resumable upload", async () => {
		const state = harness([
			json({}, { headers: { Location: "https://youtube-upload.example/audit" } }),
			json({ id: "youtube-private" }),
		]);
		const request = input("youtube_shorts");
		request.account!.metadata = { auditEnforcedPrivate: true };
		const result = await state.registry.get("youtube_shorts").publish(request, {
			signal: new AbortController().signal,
			checkpoint: async () => undefined,
		});

		expect(result).toMatchObject({ kind: "accepted" });
		expect(JSON.parse(String(state.requests[0]!.init?.body))).toMatchObject({
			status: { privacyStatus: "private" },
		});
	});

	test("rejects a stale TikTok creator privacy choice without initializing a post", async () => {
		const state = harness([
			json({ data: { privacy_level_options: ["SELF_ONLY"] } }),
		]);
		const request = input("tiktok");
		request.providerSettings = {
			...request.providerSettings,
			tiktokPrivacyLevel: "PUBLIC_TO_EVERYONE",
		};
		const result = await state.registry.get("tiktok").publish(request, {
			signal: new AbortController().signal,
			checkpoint: async () => undefined,
		});

		expect(result).toMatchObject({
			kind: "failed",
			failure: {
				code: "tiktok_privacy_setting_changed",
				disposition: "permanent",
			},
		});
		expect(state.requests).toHaveLength(1);
	});

	test("publishes for a LinkedIn organization with the organization write scope", async () => {
		const state = harness([
			json({
				value: {
					video: "urn:li:video:org",
					uploadToken: "org-upload-token",
					uploadInstructions: [
						{
							uploadUrl: "https://linkedin-upload.example/org-part",
							firstByte: 0,
							lastByte: 7,
						},
					],
				},
			}),
			new Response(null, { status: 201, headers: { ETag: '"org-part"' } }),
			json({}),
			json({ status: "AVAILABLE" }),
			new Response(null, {
				status: 201,
				headers: { "x-restli-id": "urn:li:share:org" },
			}),
		]);
		const request = input("linkedin");
		request.account!.scopes = ["w_organization_social", "r_organization_social"];
		request.account!.metadata = { ownerUrn: "urn:li:organization:123" };
		const pending = await state.registry.get("linkedin").publish(request, {
			signal: new AbortController().signal,
			checkpoint: async () => undefined,
		});
		expect(pending).toMatchObject({
			kind: "pending",
			operation: { kind: "linkedin_video_processing" },
		});
		if (pending.kind !== "pending") throw new Error("expected pending");
		const result = await state.registry.get("linkedin").resume!(
			request,
			pending.operation,
			{
				signal: new AbortController().signal,
				checkpoint: async () => undefined,
			},
		);
		expect(result).toMatchObject({
			kind: "accepted",
			receipt: { platformPostId: "urn:li:share:org" },
		});
		expect(JSON.parse(String(state.requests[0]!.init?.body))).toMatchObject({
			initializeUploadRequest: { owner: "urn:li:organization:123" },
		});
	});

	test("uses the connected LinkedIn identity and rejects an oversized frozen title before upload", async () => {
		const invalidState = harness([]);
		const invalid = input("linkedin");
		invalid.providerSettings = {
			...invalid.providerSettings,
			title: "x".repeat(201),
			linkedinOwnerUrn: "urn:li:organization:attacker-controlled",
		};
		expect(
			await invalidState.registry.get("linkedin").publish(invalid, {
				signal: new AbortController().signal,
				checkpoint: async () => {},
			}),
		).toMatchObject({
			kind: "failed",
			failure: { code: "linkedin_publication_invalid" },
		});
		expect(invalidState.requests).toHaveLength(0);

		const validState = harness([
			json({
				value: {
					video: "urn:li:video:1",
					uploadToken: "token",
					uploadInstructions: [
						{
							uploadUrl: "https://linkedin-upload.example/part",
							firstByte: 0,
							lastByte: 7,
						},
					],
				},
			}),
		]);
		const valid = input("linkedin");
		valid.providerSettings = {
			...valid.providerSettings,
			linkedinOwnerUrn: "urn:li:organization:attacker-controlled",
		};
		await validState.registry.get("linkedin").publish(valid, {
			signal: new AbortController().signal,
			checkpoint: async () => {},
		});
		const body = JSON.parse(String(validState.requests[0]?.init?.body)) as {
			initializeUploadRequest?: { owner?: string };
		};
		expect(body.initializeUploadRequest?.owner).toBe("urn:li:person:creator");
	});

	test("contains LinkedIn and X ambiguity when exact lookup permission is absent", async () => {
		const linkedinState = harness([]);
		const linkedinInput = input("linkedin");
		linkedinInput.account!.scopes = ["w_member_social"];
		const linkedin = await linkedinState.registry.get("linkedin").reconcile!(
			linkedinInput,
			{
				kind: "submission_started",
				state: {
					owner: "urn:li:person:creator",
					videoUrn: "urn:li:video:1",
					submissionStartedAt: "2026-08-28T10:00:00.000Z",
				},
			},
			{ signal: new AbortController().signal, checkpoint: async () => undefined },
		);
		expect(linkedin).toMatchObject({
			kind: "failed",
			failure: { code: "linkedin_reconciliation_permission_missing", disposition: "attention" },
		});

		const xState = harness([]);
		const xInput = input("x");
		xInput.account!.scopes = ["tweet.write", "media.write"];
		const x = await xState.registry.get("x").reconcile!(
			xInput,
			{
				kind: "submission_started",
				state: {
					mediaKey: "media-key",
					submissionStartedAt: "2026-08-28T10:00:00.000Z",
				},
			},
			{ signal: new AbortController().signal, checkpoint: async () => undefined },
		);
		expect(x).toMatchObject({
			kind: "failed",
			failure: { code: "x_reconciliation_permission_missing", disposition: "attention" },
		});
	});

	test("rejects overlong X text rather than silently truncating the approved post", async () => {
		const state = harness([]);
		const request = input("x");
		request.caption = "x".repeat(281);
		const result = await state.registry.get("x").publish(request, {
			signal: new AbortController().signal,
			checkpoint: async () => undefined,
		});

		expect(result).toMatchObject({
			kind: "failed",
			failure: { code: "x_publication_invalid", disposition: "permanent" },
		});
		expect(state.requests).toHaveLength(0);
	});

	test("refuses an Instagram container when the professional account changed", async () => {
		const state = await publish("instagram_reels", [
			json({ id: "different-instagram-user" }),
		]);

		expect(state.result).toMatchObject({
			kind: "failed",
			failure: {
				code: "instagram_account_changed",
				phase: "preparation",
				disposition: "permanent",
			},
		});
		expect(state.requests).toHaveLength(1);
	});

	test("refuses an Instagram container when the publishing limit is exhausted", async () => {
		const state = await publish("instagram_reels", [
			json(CONTRACT_FIXTURE.instagram.account),
			json(CONTRACT_FIXTURE.instagram.atLimit),
		]);

		expect(state.result).toMatchObject({
			kind: "failed",
			failure: {
				code: "instagram_rate_limit",
				phase: "preparation",
				disposition: "safe_retry",
				retryAfterMs: 3_600_000,
			},
		});
		expect(state.requests).toHaveLength(2);
	});

	test.each([
		["ERROR", "instagram_container_processing_failed"],
		["EXPIRED", "instagram_container_expired"],
	] as const)("maps Instagram %s container status without publishing", async (status, code) => {
		const state = await publish("instagram_reels", [
			json(CONTRACT_FIXTURE.instagram.account),
			json(CONTRACT_FIXTURE.instagram.withinLimit),
			json({ id: "container-failed" }),
			json({ status_code: status }),
		]);

		expect(state.result).toMatchObject({
			kind: "failed",
			failure: { code },
		});
		expect(state.requests).toHaveLength(4);
	});

	test("rejects TikTok interaction settings that changed after scheduling", async () => {
		const state = await publish("tiktok", [
			json(CONTRACT_FIXTURE.tiktok.providerDisabled),
		]);

		expect(state.result).toMatchObject({
			kind: "failed",
			failure: { code: "tiktok_creator_setting_changed" },
		});
		expect(state.requests).toHaveLength(1);
	});

	test("normalizes a TikTok provider failure reason without losing retry policy", async () => {
		const state = harness([json(CONTRACT_FIXTURE.tiktok.rateFailure)]);
		const result = await state.registry.get("tiktok").reconcile!(
			input("tiktok"),
			{
				kind: "submission_started",
				state: { publishId: "publish-rate", creatorHandle: "creator" },
			},
			{ signal: new AbortController().signal, checkpoint: async () => undefined },
		);

		expect(result).toMatchObject({
			kind: "failed",
			failure: {
				code: "tiktok_rate_limit",
				disposition: "safe_retry",
				retryAfterMs: 60 * 60_000,
				safeToRepublishAfterSubmission: true,
			},
		});
	});

	test("keeps LinkedIn video processing durable before Post creation", async () => {
		const state = harness([json(CONTRACT_FIXTURE.linkedin.processing)]);
		const result = await state.registry.get("linkedin").resume!(
			input("linkedin"),
			{
				kind: "linkedin_video_processing",
				state: { owner: "urn:li:person:creator", videoUrn: "urn:li:video:processing" },
			},
			{ signal: new AbortController().signal, checkpoint: async () => undefined },
		);

		expect(result).toMatchObject({
			kind: "pending",
			operation: { kind: "linkedin_video_processing" },
			submissionStarted: false,
		});
		expect(state.requests).toHaveLength(1);
	});

	test("settles LinkedIn video processing failure without creating a Post", async () => {
		const state = harness([json(CONTRACT_FIXTURE.linkedin.failed)]);
		const result = await state.registry.get("linkedin").resume!(
			input("linkedin"),
			{
				kind: "linkedin_video_processing",
				state: { owner: "urn:li:person:creator", videoUrn: "urn:li:video:failed" },
			},
			{ signal: new AbortController().signal, checkpoint: async () => undefined },
		);

		expect(result).toMatchObject({
			kind: "failed",
			failure: { code: "linkedin_video_processing_failed" },
		});
		expect(state.requests).toHaveLength(1);
	});

	test("paginates LinkedIn reconciliation before settling one exact match", async () => {
		const unrelated = Array.from({ length: 1 }, (_, index) => ({
			id: `urn:li:share:unrelated-${index}`,
			author: "urn:li:person:creator",
			createdAt: new Date("2026-08-28T10:00:05.000Z").getTime(),
			content: { media: { id: `urn:li:video:unrelated-${index}` } },
		}));
		const state = harness([
			json({ elements: unrelated, paging: { start: 0, count: 100, total: 101 } }),
			json({
				elements: [{
					id: "urn:li:share:page-two",
					author: "urn:li:person:creator",
					createdAt: new Date("2026-08-28T10:00:05.000Z").getTime(),
					content: { media: { id: "urn:li:video:exact-page-two" } },
				}],
				paging: { start: 100, count: 1, total: 101 },
			}),
		]);
		const result = await state.registry.get("linkedin").reconcile!(
			input("linkedin"),
			{
				kind: "submission_started",
				state: {
					owner: "urn:li:person:creator",
					videoUrn: "urn:li:video:exact-page-two",
					submissionStartedAt: "2026-08-28T10:00:00.000Z",
				},
			},
			{ signal: new AbortController().signal, checkpoint: async () => undefined },
		);

		expect(result).toMatchObject({
			kind: "accepted",
			receipt: { platformPostId: "urn:li:share:page-two" },
		});
		expect(state.requests[1]!.url).toContain("start=100");
	});

	test("reserves Instagram call budget for validation, publish, and permalink", () => {
		const state = harness([]);
		expect(state.registry.get("instagram_reels").capabilities.maxProviderCalls).toBe(7);
	});

	test("paginates X reconciliation before settling one exact media key", async () => {
		const state = harness([
			json({ data: [], meta: { next_token: "page-two" } }),
			json({
				data: [{
					id: "x-page-two",
					created_at: "2026-08-28T10:00:05.000Z",
					attachments: { media_keys: ["media-key-page-two"] },
				}],
				meta: {},
			}),
		]);
		const result = await state.registry.get("x").reconcile!(
			input("x"),
			{
				kind: "submission_started",
				state: {
					mediaKey: "media-key-page-two",
					submissionStartedAt: "2026-08-28T10:00:00.000Z",
				},
			},
			{ signal: new AbortController().signal, checkpoint: async () => undefined },
		);

		expect(result).toMatchObject({
			kind: "accepted",
			receipt: { platformPostId: "x-page-two" },
		});
		expect(state.requests[1]!.url).toContain("pagination_token=page-two");
	});

	test("keeps zero-match LinkedIn and X reconciliation nonterminal", async () => {
		const linkedinState = harness([
			json({ elements: [], paging: { start: 0, count: 0, total: 0 } }),
		]);
		const linkedin = await linkedinState.registry.get("linkedin").reconcile!(
			input("linkedin"),
			{
				kind: "submission_started",
				state: {
					owner: "urn:li:person:creator",
					videoUrn: "urn:li:video:missing",
					submissionStartedAt: "2026-08-28T10:00:00.000Z",
				},
			},
			{ signal: new AbortController().signal, checkpoint: async () => undefined },
		);
		expect(linkedin).toMatchObject({
			kind: "unknown",
			code: "linkedin_publication_not_yet_proven",
		});

		const xState = harness([json({ data: [], meta: {} })]);
		const x = await xState.registry.get("x").reconcile!(
			input("x"),
			{
				kind: "submission_started",
				state: {
					mediaKey: "media-key-missing",
					submissionStartedAt: "2026-08-28T10:00:00.000Z",
				},
			},
			{ signal: new AbortController().signal, checkpoint: async () => undefined },
		);
		expect(x).toMatchObject({
			kind: "unknown",
			code: "x_publication_not_yet_proven",
		});
	});

	test("contains multiple exact LinkedIn and X reconciliation matches", async () => {
		const createdAt = new Date("2026-08-28T10:00:05.000Z");
		const linkedinState = harness([
			json({
				elements: ["one", "two"].map((id) => ({
					id: `urn:li:share:${id}`,
					author: "urn:li:person:creator",
					createdAt: createdAt.getTime(),
					content: { media: { id: "urn:li:video:duplicate" } },
				})),
				paging: { start: 0, count: 2, total: 2 },
			}),
		]);
		const linkedin = await linkedinState.registry.get("linkedin").reconcile!(
			input("linkedin"),
			{
				kind: "submission_started",
				state: {
					owner: "urn:li:person:creator",
					videoUrn: "urn:li:video:duplicate",
					submissionStartedAt: "2026-08-28T10:00:00.000Z",
				},
			},
			{ signal: new AbortController().signal, checkpoint: async () => undefined },
		);
		expect(linkedin).toMatchObject({
			kind: "failed",
			failure: {
				code: "linkedin_reconciliation_multiple_matches",
				disposition: "attention",
			},
		});

		const xState = harness([
			json({
				data: ["one", "two"].map((id) => ({
					id: `x-${id}`,
					created_at: createdAt.toISOString(),
					attachments: { media_keys: ["media-key-duplicate"] },
				})),
				meta: {},
			}),
		]);
		const x = await xState.registry.get("x").reconcile!(
			input("x"),
			{
				kind: "submission_started",
				state: {
					mediaKey: "media-key-duplicate",
					submissionStartedAt: "2026-08-28T10:00:00.000Z",
				},
			},
			{ signal: new AbortController().signal, checkpoint: async () => undefined },
		);
		expect(x).toMatchObject({
			kind: "failed",
			failure: {
				code: "x_reconciliation_multiple_matches",
				disposition: "attention",
			},
		});
	});

	test("proves a YouTube session expiry before allowing republish", async () => {
		const state = harness([new Response(null, { status: 404 })]);
		const result = await state.registry.get("youtube_shorts").reconcile!(
			input("youtube_shorts"),
			{
				kind: "submission_started",
				state: {
					uploadUrl: "https://youtube-upload.example/expired",
					uploadedBytes: 0,
					totalBytes: 8,
				},
			},
			{ signal: new AbortController().signal, checkpoint: async () => undefined },
		);
		expect(result).toMatchObject({
			kind: "failed",
			failure: {
				code: "youtube_upload_session_expired",
				disposition: "safe_retry",
				safeToRepublishAfterSubmission: true,
			},
		});
	});

	test("contains a malformed completed YouTube response after submission", async () => {
		const state = await publish("youtube_shorts", [
			json({}, { headers: { Location: "https://youtube-upload.example/malformed" } }),
			json({ status: { uploadStatus: "processed" } }),
		]);
		expect(state.result).toMatchObject({
			kind: "unknown",
			code: "youtube_video_id_missing",
			phase: "submission",
		});
	});
});

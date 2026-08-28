import { describe, expect, test } from "bun:test";
import type { SocialPlatform } from "@narriflow/validators";
import { createNativePublicationPlatformRegistry } from "./social-publication-native-platforms";
import type { PublicationPlatformInput } from "./social-publication-platform";

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
		},
		account: {
			id: "account-1",
			userId: "user-1",
			platform,
			providerAccountId: "provider-account-1",
			displayName: "Creator",
			handle: "@creator",
			accessToken: "access-token",
			scopes: [],
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
			aspectRatio: "9:16",
		},
	};
}

function harness(responses: Response[], cleanupFails = false) {
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
		sleep: async () => undefined,
		random: () => 0.5,
		clock: { now: () => new Date("2026-08-28T10:00:00.000Z") },
		config: {
			metaGraphVersion: "v24.0",
			linkedInVersion: "202608",
			instagramPollAttempts: 2,
			instagramPollIntervalMs: 1,
			tiktokPollAttempts: 2,
			tiktokPollIntervalMs: 1,
			tiktokChunkBytes: 8,
			xPollAttempts: 2,
			xChunkBytes: 8,
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
	const checkpoints: string[] = [];
	const result = await state.registry.get(platform).publish(input(platform), {
		signal: new AbortController().signal,
		checkpoint: async (operation) => checkpoints.push(operation.kind),
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
			},
		});
		expect(state.checkpoints).toEqual(["submission_started"]);
		expect(JSON.parse(String(state.requests[0]!.init?.body))).toMatchObject({
			snippet: { title: "Approved title", description: "Approved caption" },
			status: { privacyStatus: "unlisted" },
		});
		expect(state.cleanupCount()).toBe(1);
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

	test("preserves Instagram container, publish, and permalink behavior", async () => {
		const state = await publish("instagram_reels", [
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
		expect(state.checkpoints).toEqual([
			"instagram_container",
			"submission_started",
		]);
		expect(String(state.requests[0]!.init?.body)).toContain(
			"caption=Approved+caption",
		);
		expect(String(state.requests[0]!.init?.body)).toContain(
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
					publicly_available_post_id: "tiktok-post-1",
				},
			}),
		]);
		expect(state.result).toMatchObject({
			kind: "accepted",
			receipt: {
				receiptId: "publish-1",
				platformPostId: "tiktok-post-1",
				externalUrl: "https://www.tiktok.com/@creator/video/tiktok-post-1",
			},
		});
		expect(state.checkpoints).toEqual(["submission_started"]);
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
			new Response(null, {
				status: 201,
				headers: { "x-restli-id": "urn:li:share:1" },
			}),
		]);
		expect(state.result).toMatchObject({
			kind: "accepted",
			receipt: {
				platformPostId: "urn:li:share:1",
				externalUrl: "https://www.linkedin.com/feed/update/urn:li:share:1/",
			},
		});
		expect(state.checkpoints).toEqual([
			"linkedin_video_upload",
			"submission_started",
		]);
		expect(JSON.parse(String(state.requests[3]!.init?.body))).toMatchObject({
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
		expect(state.checkpoints).toEqual(["x_media_upload", "submission_started"]);
		expect(JSON.parse(String(state.requests[3]!.init?.body))).toEqual({
			text: "Approved caption",
			media: { media_ids: ["media-1"] },
			made_with_ai: true,
		});
		expect(state.cleanupCount()).toBe(1);
	});
});

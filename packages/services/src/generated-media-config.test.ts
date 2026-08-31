import { describe, expect, test } from "bun:test";

import { generatedMediaConfigFromEnv } from "./generated-media-config";

describe("generatedMediaConfigFromEnv", () => {
	test("fails image generation closed unless rollout, key, and configured model are present", () => {
		expect(generatedMediaConfigFromEnv({}).image).toEqual({
			enabled: false,
			reason: "image_rollout_disabled",
		});
		expect(
			generatedMediaConfigFromEnv({
				NARRIFLOW_WRITES_GENERATED_MEDIA: "1",
				NARRIFLOW_WRITES_GENERATED_IMAGES: "1",
				OPENAI_API_KEY: "test-key",
			}).image,
		).toEqual({ enabled: false, reason: "openai_image_model_missing" });
	});

	test("binds image generation to the configured model without a model fallback", () => {
		expect(
			generatedMediaConfigFromEnv({
				NARRIFLOW_WRITES_GENERATED_MEDIA: "1",
				NARRIFLOW_WRITES_GENERATED_IMAGES: "1",
				OPENAI_API_KEY: "test-key",
				OPENAI_IMAGE_MODEL: "deployment-selected-model",
			}).image,
		).toMatchObject({
			enabled: true,
			provider: "openai-image",
			model: "deployment-selected-model",
		});
	});

	test("binds metered allowance and abuse ceilings independently", () => {
		expect(
			generatedMediaConfigFromEnv({
				NARRIFLOW_WRITES_GENERATED_MEDIA: "1",
				NARRIFLOW_WRITES_GENERATED_IMAGES: "1",
				OPENAI_API_KEY: "test-key",
				OPENAI_IMAGE_MODEL: "deployment-selected-model",
				GENERATED_IMAGE_DAILY_USAGE_LIMIT: "7",
				GENERATED_IMAGE_DAILY_ABUSE_LIMIT: "11",
			}).image,
		).toMatchObject({
			dailyUsageLimit: 7,
			dailyAbuseLimit: 11,
		});
	});

	test("keeps video independently disabled until every entry-gate setting is named", () => {
		const base = {
			NARRIFLOW_WRITES_GENERATED_MEDIA: "1",
			NARRIFLOW_WRITES_GENERATED_VIDEOS: "1",
			GENERATED_VIDEO_PROVIDER: "approved-video",
			GENERATED_VIDEO_MODEL: "deployment-video-alias",
			GENERATED_VIDEO_MAX_DURATION_SEC: "8",
			GENERATED_VIDEO_MAX_CONCURRENCY: "2",
		};
		expect(generatedMediaConfigFromEnv(base).video).toEqual({
			enabled: false,
			reason: "video_usage_units_missing",
		});
		expect(
			generatedMediaConfigFromEnv({
				...base,
				GENERATED_VIDEO_USAGE_UNITS: "6",
				GENERATED_VIDEO_MAX_OUTPUT_BYTES: "67108864",
			}).video,
		).toEqual({
			enabled: true,
			provider: "approved-video",
			model: "deployment-video-alias",
			maxDurationSec: 8,
			maxConcurrency: 2,
			usageUnits: 6,
			dailyUsageLimit: 60,
			dailyAbuseLimit: 120,
			maxOutputBytes: 67_108_864,
			supportedAspectRatios: ["9:16", "1:1", "16:9"],
		});
	});

	test("fails video closed when its configured aspect-ratio contract is empty", () => {
		expect(
			generatedMediaConfigFromEnv({
				NARRIFLOW_WRITES_GENERATED_MEDIA: "1",
				NARRIFLOW_WRITES_GENERATED_VIDEOS: "1",
				GENERATED_VIDEO_PROVIDER: "approved-video",
				GENERATED_VIDEO_MODEL: "deployment-video-alias",
				GENERATED_VIDEO_MAX_DURATION_SEC: "8",
				GENERATED_VIDEO_MAX_CONCURRENCY: "2",
				GENERATED_VIDEO_USAGE_UNITS: "6",
				GENERATED_VIDEO_MAX_OUTPUT_BYTES: "67108864",
				GENERATED_VIDEO_ASPECT_RATIOS: "3:2,cinema",
			}).video,
		).toEqual({ enabled: false, reason: "video_aspect_ratios_invalid" });
	});
});

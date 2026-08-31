import type {
	GeneratedMediaAspectRatio,
} from "@narriflow/validators";

import type { GeneratedMediaConfig } from "./generated-media";
import {
	DEFAULT_GENERATION_DAILY_ABUSE_LIMIT_UNITS,
	DEFAULT_GENERATION_DAILY_LIMIT_UNITS,
} from "./generation-usage";

type Environment = Readonly<Record<string, string | undefined>>;

function enabled(value: string | undefined) {
	return value?.trim() === "1";
}

function positiveInteger(value: string | undefined): number | null {
	if (!value?.trim()) return null;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function configured(value: string | undefined) {
	const result = value?.trim();
	return result ? result : null;
}

export function generatedMediaUsageLimitsFromEnv(env: Environment = process.env) {
	return {
		image: {
			usageUnits: positiveInteger(env.GENERATED_IMAGE_USAGE_UNITS) ?? 1,
			dailyUsageLimit:
				positiveInteger(env.GENERATED_IMAGE_DAILY_USAGE_LIMIT) ??
				DEFAULT_GENERATION_DAILY_LIMIT_UNITS.image,
			dailyAbuseLimit:
				positiveInteger(env.GENERATED_IMAGE_DAILY_ABUSE_LIMIT) ??
				DEFAULT_GENERATION_DAILY_ABUSE_LIMIT_UNITS.image,
		},
		video: {
			usageUnits: positiveInteger(env.GENERATED_VIDEO_USAGE_UNITS) ?? 6,
			dailyUsageLimit:
				positiveInteger(env.GENERATED_VIDEO_DAILY_USAGE_LIMIT) ??
				DEFAULT_GENERATION_DAILY_LIMIT_UNITS.video,
			dailyAbuseLimit:
				positiveInteger(env.GENERATED_VIDEO_DAILY_ABUSE_LIMIT) ??
				DEFAULT_GENERATION_DAILY_ABUSE_LIMIT_UNITS.video,
		},
	} as const;
}

export function generatedMediaConfigFromEnv(
	env: Environment = process.env,
): GeneratedMediaConfig {
	const programEnabled = enabled(env.NARRIFLOW_WRITES_GENERATED_MEDIA);
	const usageLimits = generatedMediaUsageLimitsFromEnv(env);
	let image: GeneratedMediaConfig["image"];
	if (!programEnabled || !enabled(env.NARRIFLOW_WRITES_GENERATED_IMAGES)) {
		image = { enabled: false, reason: "image_rollout_disabled" };
	} else if (!configured(env.OPENAI_API_KEY)) {
		image = { enabled: false, reason: "openai_api_key_missing" };
	} else if (!configured(env.OPENAI_IMAGE_MODEL)) {
		image = { enabled: false, reason: "openai_image_model_missing" };
	} else {
		image = {
			enabled: true,
			provider: "openai-image",
			model: configured(env.OPENAI_IMAGE_MODEL)!,
			maxConcurrency:
				positiveInteger(env.GENERATED_IMAGE_MAX_CONCURRENCY) ?? 2,
			...usageLimits.image,
			maxOutputBytes:
				positiveInteger(env.GENERATED_IMAGE_MAX_OUTPUT_BYTES) ??
				16 * 1024 * 1024,
			supportedAspectRatios: ["9:16", "1:1", "16:9"],
		};
	}

	let video: GeneratedMediaConfig["video"];
	if (!programEnabled || !enabled(env.NARRIFLOW_WRITES_GENERATED_VIDEOS)) {
		video = { enabled: false, reason: "video_rollout_disabled" };
	} else if (!configured(env.GENERATED_VIDEO_PROVIDER)) {
		video = { enabled: false, reason: "video_provider_missing" };
	} else if (!configured(env.GENERATED_VIDEO_MODEL)) {
		video = { enabled: false, reason: "video_model_missing" };
	} else if (!positiveInteger(env.GENERATED_VIDEO_MAX_DURATION_SEC)) {
		video = { enabled: false, reason: "video_max_duration_missing" };
	} else if (!positiveInteger(env.GENERATED_VIDEO_MAX_CONCURRENCY)) {
		video = { enabled: false, reason: "video_max_concurrency_missing" };
	} else if (!positiveInteger(env.GENERATED_VIDEO_USAGE_UNITS)) {
		video = { enabled: false, reason: "video_usage_units_missing" };
	} else if (!positiveInteger(env.GENERATED_VIDEO_MAX_OUTPUT_BYTES)) {
		video = { enabled: false, reason: "video_max_output_bytes_missing" };
	} else {
		const supportedAspectRatios = (
			configured(env.GENERATED_VIDEO_ASPECT_RATIOS)?.split(",") ?? [
				"9:16",
				"1:1",
				"16:9",
			]
		)
			.map((value) => value.trim())
			.filter((value): value is GeneratedMediaAspectRatio =>
				["9:16", "1:1", "16:9", "4:5"].includes(value),
			);
		video =
			supportedAspectRatios.length === 0
				? { enabled: false, reason: "video_aspect_ratios_invalid" }
				: {
						enabled: true,
						provider: configured(env.GENERATED_VIDEO_PROVIDER)!,
						model: configured(env.GENERATED_VIDEO_MODEL)!,
						maxDurationSec: positiveInteger(
							env.GENERATED_VIDEO_MAX_DURATION_SEC,
						)!,
						maxConcurrency: positiveInteger(
							env.GENERATED_VIDEO_MAX_CONCURRENCY,
						)!,
						...usageLimits.video,
						maxOutputBytes: positiveInteger(
							env.GENERATED_VIDEO_MAX_OUTPUT_BYTES,
						)!,
						supportedAspectRatios,
					};
	}

	return {
		image,
		video,
		terminalPromptRetentionMs:
			positiveInteger(env.GENERATED_MEDIA_PROMPT_RETENTION_MS) ??
			30 * 24 * 60 * 60 * 1000,
	};
}

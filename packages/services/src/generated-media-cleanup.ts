import {
	adoptUnclaimedMediaCleanupObligation,
	type MediaCleanupObligationInput,
	type UnclaimedMediaCleanupAdoptionStore,
} from "./media-cleanup";

export const GENERATED_MEDIA_PROVISIONAL_CLEANUP_DELAY_MS =
	24 * 60 * 60 * 1000;

const providerResultKeyPattern =
	/^generated-media\/provider-results\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/i;

export async function adoptGeneratedMediaAssetUpload(
	store: UnclaimedMediaCleanupAdoptionStore,
	objectKey: string,
	now: Date,
) {
	if (!objectKey.startsWith("generated-media/assets/")) {
		throw new Error("generated_media_asset_cleanup_key_invalid");
	}
	return adoptUnclaimedMediaCleanupObligation(
		store,
		{
			origin: "generated_media_ingestion",
			cleanupClass: "generated_media_asset_upload",
			objectKey,
		},
		now,
		"generated_media_asset_referenced",
	);
}

export async function adoptGeneratedMediaProviderResult(
	store: UnclaimedMediaCleanupAdoptionStore,
	objectKey: string,
	now: Date,
) {
	if (!providerResultKeyPattern.test(objectKey)) return null;
	return adoptUnclaimedMediaCleanupObligation(
		store,
		{
			origin: "generated_media_ingestion",
			cleanupClass: "generated_media_provider_result",
			objectKey,
		},
		now,
		"generated_media_result_referenced",
	);
}

export function generatedMediaAssetUploadObligation(input: {
	projectId: string;
	clipId: string | null;
	objectKey: string;
	now: Date;
}): MediaCleanupObligationInput {
	if (!input.objectKey.startsWith("generated-media/assets/")) {
		throw new Error("generated_media_asset_cleanup_key_invalid");
	}
	return {
		origin: "generated_media_ingestion",
		cleanupClass: "generated_media_asset_upload",
		projectId: input.projectId,
		clipId: input.clipId,
		objectKey: input.objectKey,
		nextAttemptAt: new Date(
			input.now.getTime() + GENERATED_MEDIA_PROVISIONAL_CLEANUP_DELAY_MS,
		),
	};
}

export function generatedMediaProviderResultObligation(
	objectKey: string,
	now: Date,
): MediaCleanupObligationInput | null {
	if (!providerResultKeyPattern.test(objectKey)) return null;
	return {
		origin: "generated_media_ingestion",
		cleanupClass: "generated_media_provider_result",
		objectKey,
		nextAttemptAt: new Date(
			now.getTime() + GENERATED_MEDIA_PROVISIONAL_CLEANUP_DELAY_MS,
		),
	};
}

export function generatedMediaRetirementObligation(input: {
	kind: "redundant_asset" | "consumed_provider_result";
	projectId: string;
	clipId: string | null;
	objectKey: string;
	now: Date;
}): MediaCleanupObligationInput | null {
	if (
		input.kind === "redundant_asset" &&
		!input.objectKey.startsWith("generated-media/assets/")
	) {
		return null;
	}
	if (
		input.kind === "consumed_provider_result" &&
		!providerResultKeyPattern.test(input.objectKey)
	) {
		return null;
	}
	return {
		origin: "generated_media_ingestion",
		cleanupClass:
			input.kind === "redundant_asset"
				? "generated_media_redundant_asset"
				: "generated_media_consumed_provider_result",
		projectId: input.projectId,
		clipId: input.clipId,
		objectKey: input.objectKey,
		nextAttemptAt: input.now,
	};
}

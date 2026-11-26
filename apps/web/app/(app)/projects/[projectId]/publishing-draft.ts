import {
	type PublishingDraft,
	type ClipSnapshot,
	type ClipExportSnapshot,
	type PricingTier,
	type SocialPlatform,
	SOCIAL_PROVIDER_CAPABILITIES,
	hasFeature,
} from "@narriflow/validators";

// Access storage only when the client session opens, never during rendering.
export const browserPublishingStorage = {
	getItem: (key: string) => window.localStorage.getItem(key),
	setItem: (key: string, value: string) => window.localStorage.setItem(key, value),
	removeItem: (key: string) => window.localStorage.removeItem(key),
};
export function publishingDraftKey(clipId: string, accountId: string) {
	return `${clipId}:${accountId}`;
}
export function blankPublishingDraft(
	clip: ClipSnapshot,
	platform: SocialPlatform,
): PublishingDraft {
	return {
		caption: "",
		title: clip.title ?? "",
		variantId: null,
		deliveryMode: "direct",
		settings:
			platform === "youtube_shorts"
				? { youtubePrivacyStatus: "public" }
				: platform === "instagram_reels"
					? { shareToFeed: true }
					: platform === "linkedin"
						? { linkedinVisibility: "PUBLIC" }
						: {},
		thumbnail: null,
		revision: clip.editorRevision,
		reviewedRevision: clip.editorRevision,
		edited: false,
		generated: false,
		editVersion: 0,
	};
}
export function applyGeneratedDescription(
	draft: PublishingDraft,
	version: number,
	generated: {
		id: string;
		caption: string;
		hashtags: string[];
		title: string | null;
	},
): PublishingDraft {
	if (draft.editVersion !== version) return draft;
	return {
		...draft,
		variantId: generated.id,
		caption: [generated.caption, generated.hashtags.join(" ")]
			.filter(Boolean)
			.join("\n\n"),
		title: generated.title ?? "",
		generated: true,
		edited: false,
	};
}
/** The exports this plan may post. An export made while Free keeps its
 * watermark and the server refuses to post it for a plan whose exports are
 * clean, so the composer leaves it out and offers to prepare the video. */
export function postableExports(
	exports: ClipExportSnapshot[],
	tier: PricingTier,
): ClipExportSnapshot[] {
	return hasFeature(tier, "export.noWatermark")
		? exports.filter((item) => !item.watermark)
		: exports;
}
export function currentPublicationExport(
	clip: ClipSnapshot,
	platform: SocialPlatform,
	exports: ClipExportSnapshot[],
	preferredExportId?: string,
) {
	const candidates = exports.filter(
		(e) =>
			e.clipId === clip.id &&
			e.editorRevision === clip.editorRevision &&
			!e.isOlderVersion,
	);
	if (preferredExportId)
		candidates.sort(
			(a, b) =>
				Number(b.id === preferredExportId) - Number(a.id === preferredExportId),
		);
	for (const item of candidates) {
		const variant = item.variants.find(
			(v) =>
				v.hasAsset &&
				SOCIAL_PROVIDER_CAPABILITIES[platform].aspectRatios.some(
					(r) => r === v.aspectRatio,
				),
		);
		if (variant) return { export: item, variant };
	}
	return null;
}

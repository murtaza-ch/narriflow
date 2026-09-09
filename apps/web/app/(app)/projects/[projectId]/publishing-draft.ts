import { z } from "zod";
import {
	socialDeliveryModeSchema,
	socialThumbnailSelectionSchema,
	publishingTimingSchema,
	type ClipSnapshot,
	type ClipExportSnapshot,
	type SocialPlatform,
	SOCIAL_PROVIDER_CAPABILITIES,
} from "@narriflow/validators";

export const publishingDraftSchema = z.object({
	caption: z.string(),
	title: z.string(),
	variantId: z.string().nullable(),
	deliveryMode: socialDeliveryModeSchema,
	settings: z.record(z.string(), z.unknown()),
	thumbnail: socialThumbnailSelectionSchema.nullable(),
	revision: z.number().int(),
	edited: z.boolean(),
	generated: z.boolean(),
	editVersion: z.number().int(),
	reviewedRevision: z.number().int(),
});
export type PublishingDraft = z.infer<typeof publishingDraftSchema>;
export const savedPublishingSchema = z.object({
	drafts: z.record(z.string(), publishingDraftSchema),
	accountIds: z.array(z.string()),
	timing: publishingTimingSchema,
});
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
export class PublishingRequestError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code?: string,
	) {
		super(message);
	}
}
export async function publishingRequest<T>(
	url: string,
	body?: unknown,
	method = body === undefined ? "GET" : "POST",
): Promise<T> {
	const response = await fetch(url, {
		method,
		cache: "no-store",
		headers:
			body === undefined ? undefined : { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const payload = await response.json().catch(() => null);
	if (!response.ok)
		throw new PublishingRequestError(
			payload?.message ??
				payload?.issues?.[0]?.message ??
				"The request could not be completed. Please try again.",
			response.status,
			payload?.error ?? payload?.code,
		);
	return payload as T;
}

import { SOCIAL_PROVIDER_CAPABILITIES, type ClipExportSnapshot, type ClipSnapshot, type SocialPlatform } from "@narriflow/validators";
import { currentPublicationExport } from "./publishing-draft";

/** What a clip's video is doing right now. Only `failed` carries an export, the one Retry video requeues. */
export type ClipRenderState =
	| { kind: "none" }
	| { kind: "queued" }
	| { kind: "rendering" }
	| { kind: "ready" }
	| { kind: "failed"; exportId: string };

export const CLIP_RENDER_STATE_LABELS: Record<ClipRenderState["kind"], string> = {
	none: "No video",
	queued: "Queued",
	rendering: "Rendering",
	ready: "Video ready",
	failed: "Failed",
};

export function clipRenderInFlight(state: ClipRenderState) {
	return state.kind === "queued" || state.kind === "rendering";
}

/**
 * A clip's render state among the Project's exports for the chosen platforms.
 * A usable video outranks everything: nothing stops the post. Next comes a
 * render that will produce one, then a failure that can be retried. Exports in
 * a format no chosen platform takes never count, so a 16:9 Studio export cannot
 * hold the button on Rendering or offer a retry that would not help. With no
 * account chosen, any format counts.
 *
 * `requested` marks a request the server has not answered yet, which reads as
 * queued. It never hides a video that already exists.
 */
export function clipRenderState(
	clip: ClipSnapshot,
	exports: ClipExportSnapshot[],
	platforms: SocialPlatform[],
	options: { requested?: boolean; preferredExportId?: string } = {},
): ClipRenderState {
	const current = exports
		.filter((item) => item.clipId === clip.id && item.editorRevision === clip.editorRevision && !item.isOlderVersion)
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	const usable = platforms.length
		? platforms.every((platform) => currentPublicationExport(clip, platform, current, options.preferredExportId))
		: current.some((item) => item.variants.some((variant) => variant.hasAsset));
	if (usable) return { kind: "ready" };

	const fits = (aspectRatio: string) =>
		!platforms.length ||
		platforms.some((platform) => SOCIAL_PROVIDER_CAPABILITIES[platform].aspectRatios.some((ratio) => ratio === aspectRatio));
	const relevant = current.filter((item) => item.variants.some((variant) => fits(variant.aspectRatio)));
	if (relevant.some((item) => item.status === "rendering")) return { kind: "rendering" };
	if (options.requested || relevant.some((item) => item.status === "queued")) return { kind: "queued" };
	const failed = relevant.find((item) =>
		item.status === "failed" ||
		(item.status === "partial_ready" && item.variants.some((variant) => variant.status === "failed" && fits(variant.aspectRatio))));
	return failed ? { kind: "failed", exportId: failed.id } : { kind: "none" };
}

/** One line for the whole selection, or null when one clip or nothing is worth saying. */
export function renderSummary(states: ClipRenderState[]): string | null {
	if (states.length < 2) return null;
	const count = (test: (state: ClipRenderState) => boolean) => states.filter(test).length;
	const failed = count((state) => state.kind === "failed");
	const rendering = count(clipRenderInFlight);
	const ready = count((state) => state.kind === "ready");
	const lead = rendering
		? `${rendering} of ${states.length} videos rendering`
		: ready
			? `${ready} of ${states.length} videos ready`
			: null;
	if (lead) return failed ? `${lead} · ${failed} failed` : lead;
	return failed ? `${failed} of ${states.length} videos failed` : null;
}

/** The rail's readiness line, which leaves the video to the render state beside it. */
export function clipReviewLabel(render: ClipRenderState, otherIssues: number, accountCount: number): string | null {
	if (!accountCount) return null;
	if (otherIssues) return "Needs review";
	return render.kind === "ready" ? "Ready" : null;
}

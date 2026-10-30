import type { Intent } from "@narriflow/api-client";
import { type ClipsClient, clipCommands } from "@narriflow/api-client/clips";
import {
	type ClipAspectRatio,
	type ClipRenderResolution,
	hasUserErrorMessage,
	userErrorMessage,
} from "@narriflow/validators";

/**
 * What the Clips tab says about renders, read from the clips' own variants. The
 * variants are the truth a user acts on: a failed run never hides clips that
 * exist, and Retry re-queues exactly the variants that failed.
 */

/** The failed variants that one render request can retry: the endpoint takes one format and resolution per call. */
export interface RenderRetryGroup {
	aspectRatio: ClipAspectRatio;
	resolution: ClipRenderResolution;
	clipIds: string[];
}

export interface RenderStatus {
	failedCount: number;
	/** Code of the first failed variant; the notice explains it in product words. */
	errorCode: string | null;
	groups: RenderRetryGroup[];
	inFlightCount: number;
}

interface ClipWithVariants {
	id: string;
	renderVariants: readonly {
		aspectRatio: ClipAspectRatio;
		resolution: ClipRenderResolution;
		status: string;
		errorCode: string | null;
	}[];
}

export function deriveRenderStatus(clips: readonly ClipWithVariants[]): RenderStatus {
	const groups = new Map<string, RenderRetryGroup>();
	let failedCount = 0;
	let inFlightCount = 0;
	let errorCode: string | null = null;
	for (const clip of clips) {
		for (const variant of clip.renderVariants) {
			if (variant.status === "pending" || variant.status === "rendering") inFlightCount += 1;
			if (variant.status !== "failed") continue;
			failedCount += 1;
			errorCode ??= variant.errorCode;
			const key = `${variant.aspectRatio}:${variant.resolution}`;
			const group = groups.get(key) ?? {
				aspectRatio: variant.aspectRatio,
				resolution: variant.resolution,
				clipIds: [],
			};
			group.clipIds.push(clip.id);
			groups.set(key, group);
		}
	}
	return { failedCount, errorCode, groups: [...groups.values()], inFlightCount };
}

/** A failed render's own code in product words; an unmapped render code still says what failed. */
export function renderFailureMessage(code: string | null | undefined): string {
	if (code && hasUserErrorMessage(code)) return userErrorMessage(code) ?? RENDER_FAILED_FALLBACK;
	return RENDER_FAILED_FALLBACK;
}

/** Render failures that rendering again cannot fix: the file itself has to be replaced. */
const NEW_SOURCE_RENDER_CODES: ReadonlySet<string> = new Set(["hdr_dolby_vision_unsupported"]);

export function renderFailureNeedsNewSource(code: string | null | undefined): boolean {
	return code != null && NEW_SOURCE_RENDER_CODES.has(code);
}

const RENDER_FAILED_FALLBACK = "A clip failed to render. Try rendering it again.";

export function renderFailureHeadline(failedCount: number): string {
	return failedCount === 1 ? "1 render failed" : `${failedCount} renders failed`;
}

/** The most clips one render request accepts. */
const RENDER_REQUEST_CLIP_LIMIT = 50;

/**
 * Re-queues each failed group through the render endpoint. Each request keeps its
 * own intent, so a retry after a lost response replays the render that was
 * accepted; a group's intent ends once the API confirms it.
 */
export async function retryFailedRenders({
	clips,
	projectId,
	groups,
	intents,
	createIntent,
}: {
	clips: ClipsClient;
	projectId: string;
	groups: readonly RenderRetryGroup[];
	intents: Map<string, Intent<unknown>>;
	createIntent: () => Intent<unknown>;
}): Promise<void> {
	for (const group of groups) {
		for (let start = 0; start < group.clipIds.length; start += RENDER_REQUEST_CLIP_LIMIT) {
			const input = {
				clipIds: group.clipIds.slice(start, start + RENDER_REQUEST_CLIP_LIMIT),
				aspectRatios: [group.aspectRatio],
				resolution: group.resolution,
			};
			const slot = `${group.aspectRatio}:${group.resolution}:${start}`;
			const intent = intents.get(slot) ?? createIntent();
			intents.set(slot, intent);
			await clipCommands.render(clips, projectId, input, intent.keyFor(input));
			intent.complete();
			intents.delete(slot);
		}
	}
}

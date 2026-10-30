"use client";
import { SOCIAL_POST_STATUS_LABELS } from "@/lib/social-post-status";
import { describeCounts, sumLatestCounts } from "@/lib/performance-format";
import { usePublishing } from "./publishing-provider";

import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { skipToken, useMutation, useQuery } from "@tanstack/react-query";
import { ApiError, invalidateScoped, type Intent } from "@narriflow/api-client";
import { invalidateWorkspaceUsage } from "@narriflow/api-client/workspace";
import {
	clipCommands,
	clipMutationOptions,
	clipQueries,
	invalidateAfterClipChange,
	invalidateProjectClips,
} from "@narriflow/api-client/clips";
import { MediaWell } from "@narriflow/ui/components/media-well";
import { EditClipLengthDialog } from "./edit-clip-length-dialog";
import { Button, IconButton } from "@narriflow/ui/components/button";
import { Spinner } from "@narriflow/ui/components/spinner";
import { Checkbox } from "@narriflow/ui/components/checkbox";
import { useConfirm } from "@narriflow/ui/components/confirm-dialog";
import {
	clipAspectRatioOptions,
	type ClipAspectRatio,
	type ClipSnapshot,
} from "@narriflow/validators";
import { Box, Flex, SimpleGrid, Stack, Text } from "@chakra-ui/react";
import {
	AlertTriangle,
	Check,
	ChevronDown,
	Clapperboard,
	Download,
	Pencil,
	Scissors,
	Share2,
} from "lucide-react";
import { formatDuration, formatTimecode } from "@/lib/format";
import {
	clipMediaPayloadForClip,
	clipMediaDescriptorFromPayload,
	playableMediaUrl,
	intentIn,
	requireClipApi,
	useClipApi,
} from "@/lib/clip-media";
import { ClipActionsMenu } from "./clip-actions-menu";
import { ClipVideo } from "./clip-video";
import { clipActionErrorCopy, failureNeedsStateRefetch } from "./clip-action-error-copy";
import { renderFailureMessage } from "./render-status";
import { LockedButton } from "../../_components/upgrade";

/** Width/height of the tallest preview format — the media stage's shape. */
const PREVIEW_STAGE_RATIO = Math.min(
	...clipAspectRatioOptions.map((option) => option.width / option.height),
);

/** Each platform's score, with the fit tag detection marks a strong match with. */
const PLATFORMS = [
	{ fit: "tiktok", score: "tiktokScore", label: "TikTok" },
	{ fit: "youtube_shorts", score: "youtubeScore", label: "YouTube Shorts" },
	{ fit: "instagram_reels", score: "instagramScore", label: "Instagram Reels" },
] as const;

/** Consecutive lines from one speaker read as one turn, not sentence fragments. */
function speakerTurns(slice: ClipSnapshot["transcriptSlice"]) {
	const turns: { key: string; speakerLabel: string; startSec: number; text: string }[] = [];
	for (const utterance of slice) {
		const last = turns.at(-1);
		if (last && last.speakerLabel === utterance.speakerLabel) {
			last.text = `${last.text} ${utterance.text}`;
		} else {
			turns.push({
				key: `${utterance.index}-${utterance.startSec}`,
				speakerLabel: utterance.speakerLabel,
				startSec: utterance.startSec,
				text: utterance.text,
			});
		}
	}
	return turns;
}

function getInitialAspectRatio(clip: ClipSnapshot): ClipAspectRatio {
	const preferred = clip.renderVariants.find(
		(render) => render.aspectRatio === "9:16" && render.hasAsset,
	);
	if (preferred) return preferred.aspectRatio;
	const firstAvailable = clip.renderVariants.find((render) => render.hasAsset);
	return firstAvailable?.aspectRatio ?? "9:16";
}

/** A clip with no render for the requested format yet: the row waits for one instead of failing. */
const RENDER_PENDING_CODES = new Set(["clip_render_not_found", "clip_render_not_ready"]);

/** Signed preview URLs stay valid for an hour; a row keeps the one it has this long, like the playback it feeds. */
const PREVIEW_STALE_MS = 5 * 60 * 1000;
/** A failing player renews its grant at most this often. */
const PREVIEW_RENEW_MIN_MS = 10_000;
const PREVIEWS_UNAVAILABLE_KEY = ["nf", "clips", "previews", "unavailable"] as const;

function isRenderQueueResponse(payload: unknown): boolean {
	if (!payload || typeof payload !== "object") return false;
	const value = payload as Record<string, unknown>;
	return (
		typeof value.workflowRunId === "string" &&
		value.workflowRunId.length > 0 &&
		typeof value.acceptedAt === "string" &&
		!Number.isNaN(Date.parse(value.acceptedAt)) &&
		typeof value.initialSeq === "number" &&
		Number.isInteger(value.initialSeq) &&
		value.initialSeq >= 0
	);
}

function SubScoreBar({ label, value }: { label: string; value: number }) {
	return (
		<Flex align="center" gap="2" fontSize="12px">
			<Text color="fg.muted" w="60px" flexShrink={0}>
				{label}
			</Text>
			<Box flex="1" h="3px" bg="bg.muted" borderRadius="full" overflow="hidden">
				<Box
					h="full"
					borderRadius="full"
					bg="accent.solid"
					w={`${value}%`}
					animation="meter-fill"
				/>
			</Box>
			<Text color="fg.subtle" w="24px" textAlign="right" fontVariantNumeric="tabular-nums">
				{value}
			</Text>
		</Flex>
	);
}

function WellPlaceholder({
	loading,
	aspectCss,
	caption,
}: {
	loading?: boolean;
	aspectCss: string;
	caption: string;
}) {
	return (
		<Flex
			w="full"
			h="full"
			direction="column"
			align="center"
			justify="center"
			gap="2"
			px="2"
		>
			<Box
				position="relative"
				w="40px"
				borderWidth="1px"
				borderStyle="dashed"
				borderColor="studio.borderControl"
				borderRadius="l1"
				overflow="hidden"
				css={{ aspectRatio: aspectCss }}
				aria-hidden="true"
			>
				<Box position="absolute" inset="0" color="studio.border">
					<svg
						width="100%"
						height="100%"
						viewBox="0 0 100 100"
						preserveAspectRatio="none"
						aria-hidden="true"
						focusable="false"
					>
						<line
							x1="0"
							y1="0"
							x2="100"
							y2="100"
							stroke="currentColor"
							strokeWidth="1"
							vectorEffect="non-scaling-stroke"
						/>
						<line
							x1="100"
							y1="0"
							x2="0"
							y2="100"
							stroke="currentColor"
							strokeWidth="1"
							vectorEffect="non-scaling-stroke"
						/>
					</svg>
				</Box>
				{loading && (
					<Flex position="absolute" inset="0" align="center" justify="center">
						<Spinner size="xs" />
					</Flex>
				)}
			</Box>
			<Text
				fontSize="12px"
				color="studio.fgSubtle"
				textAlign="center"
			>
				{caption}
			</Text>
		</Flex>
	);
}

/**
 * Disabled-but-hoverable trigger for the Publish tooltip. A native
 * `disabled` button suppresses pointer events in most browsers, which would
 * kill hover — this renders the visual disabled state without the attribute
 * so the tooltip still opens on hover/focus.
 */
export interface ClipRowProps {
	clip: ClipSnapshot;
	projectId: string;
	/** Immutable virality rank (1-based), or null for the caption-only
	 *  pseudo-clip row (no rank/score/why-this-clip framing). */
	rank: number | null;
	compact: boolean;
	selected: boolean;
	onToggleSelect: (clipId: string, selected: boolean) => void;
	/** Presigned source video for the Trim/Extend preview pane; null once the
	 *  source is purged (the dialog degrades to transcript-only). */
	sourceVideoUrl: string | null;
	/** Role and workspace status allow changes; otherwise the row only views and downloads. */
	canEdit: boolean;
}

export function ClipRow({
	clip,
	rank,
	compact,
	selected,
	onToggleSelect,
	sourceVideoUrl,
	canEdit,
}: ClipRowProps) {
	const publishing = usePublishing();
	const clipPosts = publishing.posts.filter((post) => post.clipId === clip.id);
	const router = useRouter();
	const api = useClipApi();
	const { confirm, dialog } = useConfirm();
	const [reasoningExpanded, setReasoningExpanded] = useState(false);
	const [transcriptExpanded, setTranscriptExpanded] = useState(false);
	const searchParams = useSearchParams();
	const isGallery = searchParams.get("view") !== "desk";
	const [editingBoundaries, setEditingBoundaries] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);
	const [selectedAspectRatio, setSelectedAspectRatio] =
		useState<ClipAspectRatio>(() => getInitialAspectRatio(clip));
	const [queuedAspectRatios, setQueuedAspectRatios] = useState<
		ClipAspectRatio[]
	>([]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the clip identity or render variants change.
	useEffect(() => {
		setSelectedAspectRatio(getInitialAspectRatio(clip));
		setQueuedAspectRatios([]);
	}, [clip.id, clip.renderVariants]);

	const renderVariantMap = new Map(
		clip.renderVariants.map((render) => [render.aspectRatio, render]),
	);
	const selectedVariant = renderVariantMap.get(selectedAspectRatio) ?? null;
	const selectedOption =
		clipAspectRatioOptions.find(
			(option) => option.value === selectedAspectRatio,
		) ?? clipAspectRatioOptions[0]!;
	const selectedStatus = queuedAspectRatios.includes(selectedAspectRatio)
		? "rendering"
		: (selectedVariant?.status ?? "missing");
	const selectedVariantHasAsset =
		Boolean(selectedVariant?.hasAsset) &&
		!queuedAspectRatios.includes(selectedAspectRatio);

	// "Always show something playable": every row asks for its Project's preview
	// grants (one shared request per format), and refetches when this clip's
	// render readiness changes. Grants expire, so they are never persisted.
	const previewOptions = api
		? clipQueries.previews(api.clips, api.scope, clip.projectId, { aspectRatio: selectedAspectRatio })
		: null;
	const previews = useQuery({
		queryKey: previewOptions?.queryKey ?? PREVIEWS_UNAVAILABLE_KEY,
		queryFn: previewOptions?.queryFn ?? skipToken,
		staleTime: PREVIEW_STALE_MS,
		// A tab resumed after the grants went stale renews them; the player keeps a playing URL until it pauses.
	});
	const { dataUpdatedAt, refetch: refetchPreviews } = previews;
	// A media failure usually means the grant expired. Renew it, but not in a loop when the media is truly gone.
	const renewPreviewGrant = useCallback(() => {
		if (Date.now() - dataUpdatedAt > PREVIEW_RENEW_MIN_MS) void refetchPreviews();
	}, [dataUpdatedAt, refetchPreviews]);
	const previewReadiness = [
		clip.hasPreview,
		selectedVariantHasAsset,
		selectedVariant?.status,
		selectedVariant?.completedAt,
	].join("|");
	const seenPreviewReadiness = useRef(previewReadiness);
	useEffect(() => {
		if (seenPreviewReadiness.current === previewReadiness) return;
		seenPreviewReadiness.current = previewReadiness;
		if (api) void invalidateScoped(api.queryClient, api.scope, "clips", "previews", { id: clip.projectId });
	}, [previewReadiness, api, clip.projectId]);

	const preview = useMemo(() => {
		const idle: { url: string | null; isProxy: boolean; offsetSec: number; pending: boolean; error: string | null } = {
			url: null,
			isProxy: false,
			offsetSec: 0,
			pending: false,
			error: null,
		};
		if (previews.error) {
			if (previews.error instanceof ApiError && RENDER_PENDING_CODES.has(previews.error.code)) {
				return { ...idle, pending: true };
			}
			return { ...idle, error: clipActionErrorCopy(previews.error, "Could not load this preview.") };
		}
		if (!previews.data) return idle;
		const payload = clipMediaPayloadForClip(previews.data, clip.id);
		if (!payload) return { ...idle, pending: true };
		const descriptor = clipMediaDescriptorFromPayload(payload);
		if (!descriptor) return { ...idle, error: "Could not load this preview." };
		return {
			...idle,
			url: descriptor.downloadUrl,
			isProxy: descriptor.isPreviewProxy,
			offsetSec: descriptor.previewStartSec,
		};
	}, [previews.data, previews.error, clip.id]);
	const previewUrl = preview.url;
	const previewIsProxy = preview.isProxy;
	const previewOffsetSec = preview.offsetSec;
	const previewLoading = previews.isPending && previews.fetchStatus !== "idle";
	const previewPending = preview.pending;
	const previewError = preview.error;
	useEffect(() => {
		if (previews.error && !preview.pending) {
			console.warn(JSON.stringify({ level: "error", message: "clip_preview_load_failed" }));
		}
	}, [previews.error, preview.pending]);

	// One intent per requested format: a retry after a timeout or lost response
	// replays the queued render instead of queuing another.
	const renderIntent = useRef<Intent<unknown> | null>(null);
	const renderFormat = useMutation({
		...clipMutationOptions,
		mutationFn: async (aspectRatio: ClipAspectRatio) => {
			const { runtime, clips, scope, queryClient } = requireClipApi(api);
			const input = { clipIds: [clip.id], aspectRatios: [aspectRatio] };
			const intent = intentIn(renderIntent, runtime);
			const result: unknown = await clipCommands.render(clips, clip.projectId, input, intent.keyFor(input));
			if (!isRenderQueueResponse(result)) {
				// It may have queued: let the domain state say so, and keep the key for the retry.
				await invalidateProjectClips(queryClient, scope, clip.projectId);
				throw new Error("incomplete_render_response");
			}
			intent.complete();
			await invalidateAfterClipChange(queryClient, scope, clip.projectId);
		},
	});

	async function queueRender(aspectRatio: ClipAspectRatio) {
		setSelectedAspectRatio(aspectRatio);
		setQueuedAspectRatios((current) =>
			current.includes(aspectRatio) ? current : [...current, aspectRatio],
		);
		setActionError(null);
		let accepted = false;

		try {
			await renderFormat.mutateAsync(aspectRatio);
			accepted = true;
		} catch (error) {
			console.warn(JSON.stringify({ level: "error", message: "clip_render_queue_failed" }));
			if (error instanceof Error && error.message === "incomplete_render_response") {
				setActionError("The render may have queued, but the response was incomplete.");
			} else {
				setActionError(clipActionErrorCopy(error, "Could not queue this render."));
				if (api && failureNeedsStateRefetch(error)) void invalidateProjectClips(api.queryClient, api.scope, clip.projectId);
			}
		} finally {
			if (!accepted) {
				setQueuedAspectRatios((current) =>
					current.filter((value) => value !== aspectRatio),
				);
			}
		}
	}

	async function handleRenderWithConfirm(aspectRatio: ClipAspectRatio) {
		const isRetry = renderVariantMap.get(aspectRatio)?.status === "failed";
		const confirmed = await confirm({
			title: isRetry
				? `Retry the ${aspectRatio} render?`
				: `Queue a ${aspectRatio} render?`,
			description:
				"Rendering burns captions into a new video file and uses render capacity on your plan.",
			confirmLabel: isRetry ? "Retry render" : "Queue render",
		});
		if (!confirmed) return;
		await queueRender(aspectRatio);
	}

	const [sharing, setSharing] = useState(false);
	// One intent per prepared video: a retry after a lost response replays the
	// export that was already started.
	const exportIntent = useRef<Intent<unknown> | null>(null);
	/**
	 * Share opens the clip's export page (link, publish, review, downloads).
	 * It reuses the clip's current export when there is one; otherwise an
	 * editor can render one, after the same capacity confirm as Render.
	 */
	async function openShare() {
		setSharing(true);
		setActionError(null);
		try {
			const { runtime, exports, scope, queryClient } = requireClipApi(api);
			const exportPage = (exportId: string) =>
				`/projects/${clip.projectId}/clips/${clip.id}/exports/${exportId}`;
			// A failed or malformed lookup is not "no export": it throws, and nothing offers to render.
			const lookup = await exports.projects[":id"].exports.current
				.$get({ param: { id: clip.projectId } })
				.then((response) => response.json());
			const mine = lookup.exports.filter((item) => item.clipId === clip.id);
			const current =
				mine.find((item) => item.variants.some((variant) => variant.aspectRatio === selectedAspectRatio)) ?? mine[0];
			if (current) {
				router.push(exportPage(current.id));
				return;
			}
			if (!canEdit) {
				setActionError("Nothing to share yet. An editor needs to render this clip first.");
				return;
			}
			const confirmed = await confirm({
				title: `Prepare a ${selectedAspectRatio} video to share?`,
				description:
					"Rendering burns captions into a shareable video and uses render capacity on your plan.",
				confirmLabel: "Render and share",
			});
			if (!confirmed) return;
			const input = {
				expectedRevision: clip.editorRevision,
				aspectRatios: [selectedAspectRatio],
				resolution: publishing.config.can1080pExport ? ("1080p" as const) : ("720p" as const),
			};
			const intent = intentIn(exportIntent, runtime);
			const created = await exports.projects[":id"].clips[":clipId"].exports
				.$post(
					{ param: { id: clip.projectId, clipId: clip.id }, json: input },
					{ headers: { "Idempotency-Key": intent.keyFor(input) } },
				)
				.then((response) => response.json());
			intent.complete();
			// The new export spends render capacity and shows on the Project's exports.
			void Promise.all([
				invalidateScoped(queryClient, scope, "exports"),
				invalidateWorkspaceUsage(queryClient, scope),
			]);
			router.push(exportPage(created.export.id));
		} catch (error) {
			setActionError(clipActionErrorCopy(error, "Could not open sharing. Try again."));
		} finally {
			setSharing(false);
		}
	}

	const [downloading, setDownloading] = useState(false);
	/** A download is a short-lived grant: ask for a fresh one, then let the browser fetch the media directly (no Clerk token). */
	async function downloadSelected() {
		if (downloading) return;
		setDownloading(true);
		setActionError(null);
		try {
			const { clips, scope, queryClient } = requireClipApi(api);
			const grant = await queryClient.fetchQuery({
				...clipQueries.downloadGrant(clips, scope, clip.projectId, clip.id, { aspectRatio: selectedAspectRatio }),
				staleTime: 0,
			});
			const url = playableMediaUrl(grant.downloadUrl);
			if (!url) throw new Error("invalid_download_grant");
			window.location.assign(url);
		} catch (error) {
			console.warn(JSON.stringify({ level: "error", message: "clip_download_failed" }));
			setActionError(clipActionErrorCopy(error, "Could not start this download."));
		} finally {
			setDownloading(false);
		}
	}

	const studioHref = `/projects/${clip.projectId}/clips/${clip.id}/studio`;
	const visibleError = actionError ?? previewError;
	const isCaptionOnly = rank === null;
	// The preview is the thing being judged, so it takes the room the wider
	// container frees up — but only in comfortable mode. A 9:16 preview is the
	// tallest element in the row at any width, so it sets row height outright:
	// measured, every extra 8px of preview width costs ~14px of row height, and
	// widening compact previews to 148px took rows from 269px to 340px. That is
	// precisely the density the compact toggle exists to protect, so compact
	// stays fixed and comfortable absorbs the new width.
	const mediaW = compact
		? { base: "144px", md: "108px" }
		: { base: "180px", md: "180px", xl: "200px" };

	// Readable measure for the prose blocks. Unconstrained, "Why this clip" ran
	// the full 1000px content width — ~120 characters per line, well past the
	// 45–75 the eye tracks comfortably.
	const measure = "68ch";

	const postCounts = sumLatestCounts(clipPosts);
	const postStatuses = [
		...new Set(clipPosts.map((post) => SOCIAL_POST_STATUS_LABELS[post.status])),
		...(postCounts ? [describeCounts(postCounts)] : []),
	].join(" · ");
	const renderBusy =
		selectedStatus === "pending" || selectedStatus === "rendering";

	// Gallery cards pin selection and score to the card's top corners, either
	// side of the centred preview. Desk rows put the preview at the card's
	// left edge, so there they ride on the footage instead.
	const selectBox = !isCaptionOnly && canEdit && (
		<Box
			position="absolute"
			top={isGallery ? "4" : "2"}
			insetStart={isGallery ? "4" : "2"}
			zIndex="1"
			lineHeight="0"
			{...(isGallery
				? {}
				: // Graphite chip — the checkbox sits on footage of any brightness.
					{ p: "1", borderRadius: "l1", bg: "rgba(14, 16, 19, 0.72)" })}
		>
			<Checkbox
				checked={selected}
				onCheckedChange={(checked) => onToggleSelect(clip.id, checked)}
				aria-label={`Select clip ${rank}`}
			/>
		</Box>
	);
	const scoreBadge = !isCaptionOnly && (
		<Stack
			position="absolute"
			top={isGallery ? "4" : "2"}
			insetEnd={isGallery ? "4" : "2"}
			zIndex="1"
			gap="1"
			align="flex-end"
			pointerEvents="none"
			{...(isGallery
				? {}
				: { px: "1.5", py: "1", borderRadius: "l1", bg: "rgba(14, 16, 19, 0.72)" })}
		>
			<Text
				fontSize="20px"
				fontWeight="600"
				lineHeight="1"
				fontVariantNumeric="tabular-nums"
				color={isGallery ? "accent.fg" : "studio.accentFg"}
			>
				{clip.viralityScore}
			</Text>
			<Text
				fontSize="10px"
				fontWeight="500"
				lineHeight="1"
				color={isGallery ? "fg.subtle" : "studio.fgMuted"}
			>
				Virality
			</Text>
		</Stack>
	);

	return (
		<Box
			data-clip-card
			position="relative"
			borderRadius="l3"
			borderWidth="1px"
			borderColor="border.card"
			mb="4"
			p={compact ? "3" : "5"}
			transition="background 120ms ease"
			bg={selected ? "accent.subtle" : "bg.panel"}
			_hover={{ bg: selected ? "accent.subtle" : "bg.subtle" }}
		>
			{isGallery && selectBox}
			{isGallery && scoreBadge}
			<Flex
				data-clip-body
				gap={{ base: "4", md: "6" }}
				align="stretch"
				direction={{ base: "column", md: "row" }}
			>
				<Box
					data-clip-media
					flexShrink={0}
					w={mediaW}
					alignSelf={{ base: "center", md: "flex-start" }}
				>
					{/* Stage sized for the tallest format, so switching formats reframes
					    the preview in place instead of moving everything below it. */}
					<Flex
						w="full"
						aspectRatio={PREVIEW_STAGE_RATIO}
						align="center"
						justify="center"
					>
						<MediaWell
							ratio={selectedOption.width / selectedOption.height}
							w="full"
							maxH="full"
							// With a preview, the player draws its own duration chip.
							timecode={previewUrl ? undefined : formatDuration(clip.durationSec)}
							borderWidth="0"
						>
							{previewUrl ? (
								<ClipVideo
									src={previewUrl}
									onMediaError={renewPreviewGrant}
									startSec={
										previewIsProxy
											? Math.max(0, clip.startSec - previewOffsetSec)
											: 0
									}
									endSec={
										previewIsProxy
											? Math.max(0, clip.endSec - previewOffsetSec)
											: clip.durationSec
									}
								/>
							) : (
								<WellPlaceholder
									loading={previewLoading}
									aspectCss={selectedOption.css}
									caption={
										previewLoading
											? "Loading…"
											: previewPending
												? selectedStatus === "failed"
													? "Render failed"
													: "Preparing preview…"
												: "Unavailable"
									}
								/>
							)}
							{!isGallery && selectBox}
							{!isGallery && scoreBadge}
						</MediaWell>
					</Flex>

					{/* Format picker — a recessed track of frames drawn to each ratio;
					    the frame's stroke says whether that format is rendered. */}
					<Flex
						w="fit-content"
						mx="auto"
						mt="2.5"
						p="0.5"
						gap="0.5"
						borderRadius="l2"
						bg="bg.soft"
						role="radiogroup"
						aria-label="Preview format"
					>
						{clipAspectRatioOptions.map((option) => {
							const variant = renderVariantMap.get(option.value);
							const isSelected = option.value === selectedAspectRatio;
							const isQueued = queuedAspectRatios.includes(option.value);
							const status = isQueued
								? "rendering"
								: (variant?.status ?? "missing");
							const isAvailable = Boolean(variant?.hasAsset) && !isQueued;
							const isInFlight = status === "pending" || status === "rendering";
							const isFailed = status === "failed" && !isAvailable && !isInFlight;
							const statusLabel = isInFlight
								? "rendering"
								: isAvailable
									? "rendered"
									: isFailed
										? "render failed"
										: "not rendered";

							return (
								<Flex
									key={option.value}
									as="button"
									role="radio"
									aria-checked={isSelected}
									aria-label={`${option.label}, ${statusLabel}`}
									title={`${option.value} · ${statusLabel}`}
									align="center"
									gap="1"
									h="6"
									px="1.5"
									borderRadius="l1"
									bg={isSelected ? "accent.subtle" : "transparent"}
									color={isSelected || isAvailable ? "fg" : "fg.subtle"}
									cursor="pointer"
									transition="background 120ms ease, color 120ms ease"
									_hover={{ color: "fg", bg: isSelected ? "accent.subtle" : "bg.softHover" }}
									onClick={() => setSelectedAspectRatio(option.value)}
								>
									{isInFlight ? (
										<Spinner size="xs" />
									) : (
										<RatioFrame
											ratioW={option.iconW}
											ratioH={option.iconH}
											tone={
												isFailed
													? "danger"
													: isSelected
														? "accent"
														: isAvailable
															? "neutral"
															: "missing"
											}
											filled={isAvailable}
										/>
									)}
									<Text textStyle="data" fontSize="10px" lineHeight="1">
										{option.value}
									</Text>
								</Flex>
							);
						})}
					</Flex>
				</Box>

				{/* Right — content */}
				<Stack data-clip-copy flex="1" minW="0" w="full" gap="4">
					<Flex align="flex-start" gap="2" maxW={`calc(${measure} + 200px)`}>
						<Box minW="0" flex="1">
							<Text textStyle="eyebrow" color="fg.subtle" mb="1">
								{!isCaptionOnly && `Clip ${String(rank).padStart(2, "0")} · `}
								<Box
									as="span"
									textTransform="capitalize"
									color={clip.category === "hook" ? "accent.fg" : undefined}
								>
									{clip.category}
								</Box>
							</Text>
							<Link href={studioHref}>
								<Text
									fontSize={compact ? "sm" : "18px"}
									fontWeight="550"
									color="fg"
									lineHeight="1.35"
									lineClamp={compact ? 1 : 2}
									textDecoration="underline"
									textDecorationColor="transparent"
									textUnderlineOffset="3px"
									transition="text-decoration-color 120ms ease"
									_hover={{ textDecorationColor: "border.emphasized" }}
								>
									{isCaptionOnly
										? "Captioned video"
										: (clip.title ?? clip.hookText)}
								</Text>
							</Link>
							<Text mt="1" textStyle="data" fontSize="12px" color="fg.timecode">
								{formatTimecode(clip.startSec)} – {formatTimecode(clip.endSec)}
								<Box as="span" color="fg.subtle">
									{" · "}
									{formatDuration(clip.durationSec)}
								</Box>
							</Text>
							{/* No out-of-preferred-range warning here: detection now sizes
                  each clip to its story arc on purpose (durations outside
                  30-60s are already priced into the virality score via
                  durationOptimality), so a warning would flag healthy clips.
                  The 30-60s duration FILTER in clips-panel.tsx remains. */}
						</Box>

						{/* Overflow actions — rename (manual + AI), duplicate, delete.
                  Offered on the caption-only row too: it is a real clip with a
                  real title and a real rendered file, so it renames, duplicates
                  and deletes exactly like any other. */}
						{canEdit ? (
							<ClipActionsMenu
								projectId={clip.projectId}
								clipId={clip.id}
								title={clip.title}
								fallbackTitle={isCaptionOnly ? "Captioned video" : clip.hookText}
							/>
						) : null}
					</Flex>

					{(!isCaptionOnly || clip.transcriptSlice.length > 0) && (
						<Box>
							{!isCaptionOnly && (
								<DetailDisclosure
									label="Why this clip works"
									expanded={reasoningExpanded}
									onToggle={() => setReasoningExpanded((v) => !v)}
								>
									<Stack gap="4" pb="4">
										<Text
											fontSize="sm"
											color="fg.muted"
											lineHeight="1.7"
											maxW={measure}
										>
											{clip.reasoning}
										</Text>
										{clip.payoffText ? (
											<Box maxW={measure} px="3.5" py="3" borderRadius="l2" bg="bg.soft">
												<Text textStyle="eyebrow" color="fg.subtle" mb="1">
													Payoff
												</Text>
												<Text fontSize="sm" color="fg" lineHeight="1.6">
													“{clip.payoffText}”
												</Text>
											</Box>
										) : null}
										{/* Two columns where the row is wide enough, so the scores read at a glance. */}
										<SimpleGrid
											columns={{ base: 1, lg: isGallery ? 1 : 2 }}
											columnGap="8"
											rowGap="1.5"
											maxW={measure}
										>
											<SubScoreBar label="Hook" value={clip.hookStrengthScore} />
											<SubScoreBar
												label="Emotion"
												value={clip.emotionalIntensityScore}
											/>
											<SubScoreBar
												label="Story"
												value={clip.storyCompletenessScore}
											/>
											<SubScoreBar label="Pacing" value={clip.pacingScore} />
											<SubScoreBar
												label="Duration"
												value={clip.durationOptimalityScore}
											/>
										</SimpleGrid>
										<Flex gap="2" wrap="wrap" align="center">
											<Text fontSize="12px" color="fg.subtle" me="1">
												Platform fit
											</Text>
											{PLATFORMS.map((platform) => {
												const strong = clip.platformFit.includes(platform.fit);
												return (
													<Flex
														key={platform.fit}
														align="center"
														gap="1.5"
														h="6"
														px="2.5"
														borderRadius="full"
														bg={strong ? "accent.subtle" : "bg.soft"}
														color={strong ? "accent.fg" : "fg.muted"}
														fontSize="12px"
														title={strong ? `A strong fit for ${platform.label}` : undefined}
													>
														{strong ? <Check size={11} aria-label="Strong fit" /> : null}
														{platform.label}
														<Text
															as="span"
															fontWeight="600"
															fontVariantNumeric="tabular-nums"
															color={strong ? "accent.fg" : "fg"}
														>
															{clip[platform.score]}
														</Text>
													</Flex>
												);
											})}
										</Flex>
									</Stack>
								</DetailDisclosure>
							)}

							{clip.transcriptSlice.length > 0 && (
								<DetailDisclosure
									label="Transcript"
									expanded={transcriptExpanded}
									onToggle={() => setTranscriptExpanded((v) => !v)}
									collapsedPreview={
										isGallery ? null : (
											<Flex gap="1.5" align="baseline" maxW={measure} pb="3">
												<Text
													textStyle="data"
													fontSize="12px"
													color="fg.timecode"
													flexShrink={0}
												>
													{formatTimecode(clip.transcriptSlice[0]!.startSec)}
												</Text>
												<Text
													fontSize="sm"
													color="fg.muted"
													lineHeight="1.8"
													lineClamp={compact ? 2 : 4}
												>
													{clip.transcriptSlice
														.map((utterance) => utterance.text)
														.join(" ")}
												</Text>
											</Flex>
										)
									}
								>
									<Stack maxH="16rem" gap="3" overflowY="auto" pb="4" pe="2">
										{speakerTurns(clip.transcriptSlice).map((turn) => (
											<Box key={turn.key}>
												<Flex gap="1.5" align="center" mb="1">
													<Text fontSize="12px" fontWeight="500" color="fg">
														{turn.speakerLabel}
													</Text>
													<Text
														textStyle="data"
														fontSize="12px"
														color="fg.timecode"
													>
														{formatTimecode(turn.startSec)}
													</Text>
												</Flex>
												<Text
													fontSize="sm"
													lineHeight="1.7"
													color="fg.muted"
													maxW={measure}
												>
													{turn.text}
												</Text>
											</Box>
										))}
									</Stack>
								</DetailDisclosure>
							)}
						</Box>
					)}

					{renderBusy && (
						<Flex align="center" gap="2">
							<Spinner size="xs" />
							<Text fontSize="12px" color="fg.muted">
								{selectedStatus === "pending"
									? `${selectedAspectRatio} render is queued`
									: `${selectedAspectRatio} render is processing`}
							</Text>
						</Flex>
					)}
					{selectedStatus === "failed" && selectedVariant?.errorCode ? (
						<Flex align="center" gap="1.5" color="danger.fg">
							<AlertTriangle size={12} aria-hidden />
							<Text fontSize="12px">
								{renderFailureMessage(selectedVariant.errorCode)}
							</Text>
						</Flex>
					) : null}

					{/* Action row — Publish leads, file and editor actions follow,
              Trim/Extend closes the row as an icon. */}
					<Stack gap="2" pt="4" mt="auto" data-clip-actions>
						<Flex gap="2" align="center">
							{!canEdit ? null : publishing.config.publishingUpgrade ? (
								<LockedButton size="sm" prompt={publishing.config.publishingUpgrade}>
									Publish
								</LockedButton>
							) : (
								<Button size="sm" onClick={() => publishing.compose([clip.id])}>
									Publish
								</Button>
							)}
							<Button size="sm" variant="subtle" asChild>
								<Link href={studioHref}>
									<Pencil size={16} />
									Edit
								</Link>
							</Button>
							{selectedVariantHasAsset ? (
								<Button
									size="sm"
									variant="subtle"
									disabled={downloading}
									onClick={() => void downloadSelected()}
								>
									{downloading ? <Spinner size="xs" /> : <Download size={16} />}
									Download
								</Button>
							) : !canEdit ? null : (
								<Button
									size="sm"
									variant="subtle"
									disabled={renderBusy}
									onClick={() => handleRenderWithConfirm(selectedAspectRatio)}
								>
									{renderBusy ? <Spinner size="xs" /> : <Clapperboard size={16} />}
									{selectedStatus === "failed" ? "Retry render" : "Render"}
								</Button>
							)}
							<IconButton
								size="sm"
								variant="ghost"
								ms="auto"
								aria-label="Share clip"
								title="Share: link, publish, review, downloads"
								disabled={sharing}
								onClick={() => void openShare()}
							>
								{sharing ? <Spinner size="xs" /> : <Share2 size={16} />}
							</IconButton>
							{canEdit ? (
								<IconButton
									size="sm"
									variant="ghost"
									aria-label="Trim or extend clip"
									title="Trim / Extend"
									onClick={() => setEditingBoundaries(true)}
								>
									<Scissors size={16} />
								</IconButton>
							) : null}
						</Flex>
						{clipPosts.length > 0 && (
							<Flex align="center" gap="2" minW="0">
								<Text fontSize="xs" color="fg.muted" truncate>
									{postStatuses}
								</Text>
								<Button
									size="2xs"
									variant="ghost"
									flexShrink={0}
									onClick={() => publishing.viewPosts([clip.id])}
								>
									View posts ({clipPosts.length})
								</Button>
							</Flex>
						)}
					</Stack>

					<EditClipLengthDialog
						projectId={clip.projectId}
						clipId={clip.id}
						clipTitle={clip.title}
						initialStartSec={clip.startSec}
						initialEndSec={clip.endSec}
						wholeSource={clip.wholeSource}
						sourceVideoUrl={sourceVideoUrl}
						// Auto-reframe re-renders what the clip already had; a clip with
						// no renders yet reframes into the row's selected format.
						renderAspectRatios={
							clip.renderVariants.filter((v) => v.hasAsset).length > 0
								? [
										...new Set(
											clip.renderVariants
												.filter((v) => v.hasAsset)
												.map((v) => v.aspectRatio),
										),
									]
								: [selectedAspectRatio]
						}
						open={editingBoundaries}
						onOpenChange={setEditingBoundaries}
					/>

					{visibleError ? (
						<Flex role="alert" align="center" gap="1.5" color="danger.fg">
							<AlertTriangle size={12} aria-hidden />
							<Text fontSize="xs">{visibleError}</Text>
						</Flex>
					) : null}
				</Stack>
			</Flex>
			{dialog}
		</Box>
	);
}

/** One hairline-ruled, full-width expandable row in the card's detail list. */
function DetailDisclosure({
	label,
	expanded,
	onToggle,
	collapsedPreview,
	children,
}: {
	label: string;
	expanded: boolean;
	onToggle: () => void;
	collapsedPreview?: ReactNode;
	children: ReactNode;
}) {
	return (
		<Box borderTopWidth="1px" borderColor="border.subtle">
			<Flex
				as="button"
				w="full"
				align="center"
				justify="space-between"
				py="2.5"
				fontSize="13px"
				fontWeight="500"
				color="fg.muted"
				cursor="pointer"
				transition="color 120ms ease"
				_hover={{ color: "fg" }}
				aria-expanded={expanded}
				onClick={onToggle}
			>
				{label}
				<Box
					asChild
					color="fg.subtle"
					transition="transform 150ms ease"
					transform={expanded ? "rotate(180deg)" : undefined}
				>
					<ChevronDown size={14} />
				</Box>
			</Flex>
			{expanded ? children : collapsedPreview}
		</Box>
	);
}

/** A tiny frame drawn to an aspect ratio — the format picker's glyph. */
function RatioFrame({
	ratioW,
	ratioH,
	tone,
	filled,
}: {
	ratioW: number;
	ratioH: number;
	tone: "accent" | "neutral" | "missing" | "danger";
	filled: boolean;
}) {
	const scale = 11 / Math.max(ratioW, ratioH);
	const stroke = {
		accent: "accent.solid",
		neutral: "fg.muted",
		missing: "fg.subtle",
		danger: "danger.fg",
	}[tone];
	return (
		<Box
			aria-hidden="true"
			flexShrink={0}
			w={`${Math.round(ratioW * scale)}px`}
			h={`${Math.round(ratioH * scale)}px`}
			borderRadius="2px"
			borderWidth="1.5px"
			// Dashed always means "not rendered yet", selected or not.
			borderStyle={filled || tone === "danger" ? "solid" : "dashed"}
			borderColor={stroke}
			bg={filled ? `${stroke}/25` : "transparent"}
		/>
	);
}

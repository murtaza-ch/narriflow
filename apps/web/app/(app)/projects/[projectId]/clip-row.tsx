"use client";
import { SOCIAL_POST_STATUS_LABELS } from "@/lib/social-post-status";
import { usePublishing } from "./publishing-provider";

import type { ReactNode, SyntheticEvent } from "react";
import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { MediaWell } from "@narriflow/ui/components/media-well";
import { EditClipLengthDialog } from "./edit-clip-length-dialog";
import { Button, IconButton } from "@narriflow/ui/components/button";
import { Spinner } from "@narriflow/ui/components/spinner";
import { Checkbox } from "@narriflow/ui/components/checkbox";
import { useConfirm } from "@narriflow/ui/components/confirm-dialog";
import {
	clipAspectRatioOptions,
	userErrorMessage,
	type ClipAspectRatio,
	type ClipSnapshot,
} from "@narriflow/validators";
import { Box, Flex, HStack, Stack, Text } from "@chakra-ui/react";
import {
	AlertTriangle,
	ChevronDown,
	Clapperboard,
	Download,
	Pencil,
	Scissors,
} from "lucide-react";
import { formatDuration, formatTimecode } from "@/lib/format";
import {
	clipFileDownloadPath,
	clipMediaPayloadForClip,
	clipMediaDescriptorFromPayload,
	loadClipPreview,
} from "@/lib/clip-media";
import { ClipActionsMenu } from "./clip-actions-menu";

/** Width/height of the tallest preview format — the media stage's shape. */
const PREVIEW_STAGE_RATIO = Math.min(
	...clipAspectRatioOptions.map((option) => option.width / option.height),
);

const platformLabels = [
	{ key: "tiktokScore" as const, label: "TikTok" },
	{ key: "youtubeScore" as const, label: "YouTube" },
	{ key: "instagramScore" as const, label: "Instagram" },
];

const platformFitLabels: Record<string, string> = {
	tiktok: "TikTok",
	youtube_shorts: "Shorts",
	instagram_reels: "Reels",
};

function getInitialAspectRatio(clip: ClipSnapshot): ClipAspectRatio {
	const preferred = clip.renderVariants.find(
		(render) => render.aspectRatio === "9:16" && render.hasAsset,
	);
	if (preferred) return preferred.aspectRatio;
	const firstAvailable = clip.renderVariants.find((render) => render.hasAsset);
	return firstAvailable?.aspectRatio ?? "9:16";
}

function readPayloadString(payload: unknown, key: string): string | null {
	if (!payload || typeof payload !== "object") return null;
	const value = (payload as Record<string, unknown>)[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

function apiErrorCopy(payload: unknown, fallback: string): string {
	const errorCode = readPayloadString(payload, "error");
	return (
		userErrorMessage(errorCode) ??
		readPayloadString(payload, "message") ??
		fallback
	);
}

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

/**
 * Preview player for one clip segment.
 *
 * Only rows at or near the viewport are allowed to touch the network. A
 * project renders every clip at once (10 by default), and each preview is a
 * cross-origin R2 object, so `preload="metadata"` on all of them put ten
 * simultaneous range requests in flight on mount — they contend, none of them
 * paints a first frame, and the wells sit empty exactly as long as the slowest
 * one takes. Loading two or three at a time instead means the visible clips
 * paint promptly and offscreen ones cost nothing until scrolled to.
 *
 * The `#t=` media fragment is what actually puts a frame on screen: the
 * browser seeks to the clip's in-point while loading metadata, natively,
 * instead of waiting for `loadedmetadata` to round-trip through React. The
 * handlers below stay as the fallback for browsers that ignore the fragment,
 * and to loop back to the in-point at the end.
 */
function ClipVideo({
	src,
	startSec,
	endSec,
}: {
	src: string;
	startSec: number;
	endSec: number;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [shouldLoad, setShouldLoad] = useState(false);

	useEffect(() => {
		const element = containerRef.current;
		if (!element) return;

		// No IntersectionObserver (or SSR-hydrated older browser) — fall back to
		// the previous always-load behaviour rather than showing nothing.
		if (typeof IntersectionObserver === "undefined") {
			setShouldLoad(true);
			return;
		}

		const observer = new IntersectionObserver(
			(entries) => {
				if (!entries.some((entry) => entry.isIntersecting)) return;
				setShouldLoad(true);
				observer.disconnect();
			},
			// Start a row early so scrolling lands on a painted frame, not a gap.
			{ rootMargin: "300px" },
		);

		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	return (
		<Box ref={containerRef} w="full" h="full">
			{/* biome-ignore lint/a11y/useMediaCaption: preview player for a clip segment; no caption/VTT source is available in this component. */}
			<video
				src={`${src}#t=${startSec},${endSec}`}
				controls
				preload={shouldLoad ? "metadata" : "none"}
				style={{
					width: "100%",
					height: "100%",
					display: "block",
					objectFit: "contain",
				}}
				onLoadedMetadata={(event: SyntheticEvent<HTMLVideoElement>) => {
					const video = event.currentTarget;
					if (video.currentTime < startSec) video.currentTime = startSec;
				}}
				onTimeUpdate={(event: SyntheticEvent<HTMLVideoElement>) => {
					const video = event.currentTarget;
					if (video.currentTime >= endSec) {
						video.pause();
						video.currentTime = startSec;
					}
				}}
			/>
		</Box>
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
}

export function ClipRow({
	clip,
	rank,
	compact,
	selected,
	onToggleSelect,
	sourceVideoUrl,
}: ClipRowProps) {
	const publishing = usePublishing();
	const clipPosts = publishing.posts.filter((post) => post.clipId === clip.id);
	const router = useRouter();
	const { confirm, dialog } = useConfirm();
	const [, startTransition] = useTransition();
	const [reasoningExpanded, setReasoningExpanded] = useState(false);
	const [transcriptExpanded, setTranscriptExpanded] = useState(false);
	const searchParams = useSearchParams();
	const isGallery = searchParams.get("view") !== "desk";
	const [editingBoundaries, setEditingBoundaries] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);
	const [selectedAspectRatio, setSelectedAspectRatio] =
		useState<ClipAspectRatio>(() => getInitialAspectRatio(clip));
	const [previewUrl, setPreviewUrl] = useState<string | null>(null);
	const [previewIsProxy, setPreviewIsProxy] = useState(false);
	const [previewOffsetSec, setPreviewOffsetSec] = useState(0);
	const [previewLoading, setPreviewLoading] = useState(false);
	const [previewPending, setPreviewPending] = useState(false);
	const [previewError, setPreviewError] = useState<string | null>(null);
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

	// Same "always show something playable" preview-fetch effect as the
	// original ClipCard — see there for the full rationale on hasPreview
	// being in the deps.
	// biome-ignore lint/correctness/useExhaustiveDependencies: asset readiness fields intentionally retrigger the preview fetch.
	useEffect(() => {
		let cancelled = false;

		const loadPreview = async () => {
			setPreviewLoading(true);
			setPreviewError(null);
			setPreviewPending(false);
			try {
				const result = await loadClipPreview(
					`/api/projects/${clip.projectId}/clips/previews?aspectRatio=${encodeURIComponent(selectedAspectRatio)}`,
				);

				if (!result.ok) {
					const message = readPayloadString(result.payload, "message");
					if (
						message === "clip render not found" ||
						message === "clip has not been rendered for this aspect ratio"
					) {
						if (!cancelled) {
							setPreviewUrl(null);
							setPreviewPending(true);
						}
						return;
					}
					console.warn(
						JSON.stringify({
							level: "error",
							message: "clip_preview_load_failed",
							status: result.status,
						}),
					);
					if (!cancelled) {
						setPreviewUrl(null);
						setPreviewError(
							apiErrorCopy(result.payload, "Could not load this preview."),
						);
					}
					return;
				}

				const payload = clipMediaPayloadForClip(result.payload, clip.id);
				if (!payload) {
					if (!cancelled) {
						setPreviewUrl(null);
						setPreviewPending(true);
					}
					return;
				}

				const descriptor = clipMediaDescriptorFromPayload(payload);
				if (!descriptor) {
					console.warn(
						JSON.stringify({
							level: "error",
							message: "clip_preview_load_failed_invalid_response",
						}),
					);
					if (!cancelled) {
						setPreviewUrl(null);
						setPreviewError("Could not load this preview.");
					}
					return;
				}

				if (!cancelled) {
					setPreviewUrl(descriptor.downloadUrl);
					setPreviewIsProxy(descriptor.isPreviewProxy);
					setPreviewOffsetSec(descriptor.previewStartSec);
				}
			} catch {
				console.warn(
					JSON.stringify({
						level: "error",
						message: "clip_preview_load_failed",
					}),
				);
				if (!cancelled) {
					setPreviewUrl(null);
					setPreviewError("Could not load this preview.");
				}
			} finally {
				if (!cancelled) setPreviewLoading(false);
			}
		};

		void loadPreview();
		return () => {
			cancelled = true;
		};
	}, [
		clip.id,
		clip.projectId,
		clip.hasPreview,
		selectedAspectRatio,
		selectedVariantHasAsset,
		selectedVariant?.status,
		selectedVariant?.completedAt,
	]);

	async function queueRender(aspectRatio: ClipAspectRatio) {
		setSelectedAspectRatio(aspectRatio);
		setQueuedAspectRatios((current) =>
			current.includes(aspectRatio) ? current : [...current, aspectRatio],
		);
		setActionError(null);
		let accepted = false;

		try {
			const response = await fetch(
				`/api/projects/${clip.projectId}/clips/render`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"idempotency-key": crypto.randomUUID(),
					},
					body: JSON.stringify({
						clipIds: [clip.id],
						aspectRatios: [aspectRatio],
					}),
				},
			);
			const payload: unknown = await response.json().catch(() => null);

			if (!response.ok) {
				console.warn(
					JSON.stringify({
						level: "error",
						message: "clip_render_queue_failed",
						status: response.status,
					}),
				);
				setActionError(apiErrorCopy(payload, "Could not queue this render."));
				return;
			}
			if (!isRenderQueueResponse(payload)) {
				console.warn(
					JSON.stringify({
						level: "error",
						message: "clip_render_queue_invalid_response",
					}),
				);
				setActionError(
					"The render may have queued, but the response was incomplete.",
				);
				return;
			}

			accepted = true;
			startTransition(() => router.refresh());
		} catch {
			console.warn(
				JSON.stringify({ level: "error", message: "clip_render_queue_failed" }),
			);
			setActionError("Could not queue this render.");
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

	const postStatuses = [
		...new Set(clipPosts.map((post) => SOCIAL_POST_STATUS_LABELS[post.status])),
	].join(" · ");
	const renderBusy =
		selectedStatus === "pending" || selectedStatus === "rendering";

	// Gallery cards pin selection and score to the card's top corners, either
	// side of the centred preview. Desk rows put the preview at the card's
	// left edge, so there they ride on the footage instead.
	const selectBox = !isCaptionOnly && (
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
							// A playing preview's controls sit where the chip would; the
							// duration moves to the copy column's timecode line instead.
							timecode={previewUrl ? undefined : formatDuration(clip.durationSec)}
							borderWidth="0"
						>
							{previewUrl ? (
								<ClipVideo
									src={previewUrl}
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
						<ClipActionsMenu
							projectId={clip.projectId}
							clipId={clip.id}
							title={clip.title}
							fallbackTitle={isCaptionOnly ? "Captioned video" : clip.hookText}
						/>
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
											{clip.payoffText ? ` Payoff: ${clip.payoffText}` : ""}
										</Text>
										<Stack gap="1.5" maxW={measure}>
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
										</Stack>
										<HStack gap="3" wrap="wrap">
											{platformLabels.map(({ key, label }) => (
												<HStack key={key} gap="1">
													<Text fontSize="12px" color="fg.muted">
														{label}
													</Text>
													<Text
														fontSize="12px"
														fontWeight="600"
														fontVariantNumeric="tabular-nums"
														color="fg"
													>
														{clip[key]}
													</Text>
												</HStack>
											))}
											{clip.platformFit.map((platform) => (
												<Text key={platform} textStyle="eyebrow" color="fg.subtle">
													{platformFitLabels[platform] ?? platform}
												</Text>
											))}
										</HStack>
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
									<Stack maxH="9rem" gap="0" overflowY="auto" pb="2">
										{clip.transcriptSlice.map((utterance, index) => (
											<Box
												key={`${utterance.index}-${utterance.startSec}`}
												py="1.5"
												borderTopWidth={index > 0 ? "1px" : "0"}
												borderColor="border.subtle"
											>
												<Flex gap="1.5" align="center" mb="0.5">
													<Text fontSize="12px" fontWeight="500" color="fg">
														{utterance.speakerLabel}
													</Text>
													<Text
														textStyle="data"
														fontSize="12px"
														color="fg.timecode"
													>
														{formatTimecode(utterance.startSec)}
													</Text>
												</Flex>
												<Text
													fontSize="xs"
													lineHeight="1.5"
													color="fg"
													maxW={measure}
												>
													{utterance.text}
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
								Render failed: {userErrorMessage(selectedVariant.errorCode)}
							</Text>
						</Flex>
					) : null}

					{/* Action row — Publish leads, file and editor actions follow,
              Trim/Extend closes the row as an icon. */}
					<Stack gap="2" pt="4" mt="auto" data-clip-actions>
						<Flex gap="2" align="center">
							<Button
								size="sm"
								disabled={!publishing.config.canPublish}
								onClick={() => publishing.compose([clip.id])}
							>
								Publish
							</Button>
							<Button size="sm" variant="subtle" asChild>
								<Link href={studioHref}>
									<Pencil size={16} />
									Edit
								</Link>
							</Button>
							{selectedVariantHasAsset ? (
								<Button size="sm" variant="subtle" asChild>
									<a
										href={clipFileDownloadPath(
											clip.projectId,
											clip.id,
											selectedAspectRatio,
										)}
										download
									>
										<Download size={16} />
										Download
									</a>
								</Button>
							) : (
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
								aria-label="Trim or extend clip"
								title="Trim / Extend"
								onClick={() => setEditingBoundaries(true)}
							>
								<Scissors size={16} />
							</IconButton>
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

"use client";

import { PlanLimitNotice } from "../../../../../../_components/plan-limit-notice";
import { LockedButton, useUpgrade, type UpgradePrompt } from "../../../../../../_components/upgrade";
import { upgradePromptFromFailure } from "@/lib/authenticated-request-browser";
import { browserFailureFromApiError } from "@/lib/publishing-client";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CLIENT_ERROR_CODES, isApiError, type WorkspaceScope } from "@narriflow/api-client/core";
import {
	type ClipExportDetailData,
	createExportsClient,
	exportCommands,
	exportQueries,
	fetchSubtitleFile,
	fetchTimelineArchive,
	invalidateAfterExportChange,
} from "@narriflow/api-client/exports";
import { useProgressStream } from "@narriflow/api-client/progress";
import { clearProjectAccess } from "@narriflow/api-client/projects";
import { useApiRuntime, useWorkspaceScope } from "@/app/_components/api-provider";
import Link from "next/link";
import { Box, Flex, Grid, HStack, Image, Portal, Stack, Text, Tooltip } from "@chakra-ui/react";
import {
	AlertTriangle,
	ArrowLeft,
	Check,
	Clapperboard,
	Clock3,
	Copy,
	Download,
	FileText,
	Film,
	Info,
	Link2,
	Lock,
	RefreshCw,
	Send,
	ShieldCheck,
	UserCheck,
} from "lucide-react";
import { Button, IconButton } from "@narriflow/ui/components/button";
import { Progress } from "@narriflow/ui/components/progress";
import { SegmentedControl } from "@narriflow/ui/components/segmented-control";
import { Spinner } from "@narriflow/ui/components/spinner";
import type { ClipExportSnapshot } from "@narriflow/validators";
import { formatDateTime, formatDuration } from "@/lib/format";

const ACTIVE_STATUSES = new Set(["queued", "rendering", "partial_ready"]);

const TIMELINE_DOWNLOADS = [
	{ format: "xmeml", label: "Premiere", hint: "XML timeline" },
	{ format: "fcpxml", label: "Final Cut, Resolve", hint: "FCPXML timeline" },
	{ format: "edl", label: "EDL", hint: "Any editor" },
] as const;

type TimelineTarget = (typeof TIMELINE_DOWNLOADS)[number]["format"] | "source";

/** Older than this, a snapshot's signed file URLs are close to their 15-minute expiry. */
const SNAPSHOT_RESUME_AGE_MS = 10 * 60_000;
/** The stream is the signal; this only covers a stream that is down or a change it does not publish. */
const ACTIVE_FALLBACK_POLL_MS = 10_000;

function saveFile(url: string, fileName: string) {
	const link = document.createElement("a");
	link.href = url;
	link.download = fileName;
	document.body.appendChild(link);
	link.click();
	link.remove();
}

function formatBytes(value: number | null): string {
	if (value === null || value < 0) return "—";
	if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
	return `${(value / (1024 * 1024)).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

function statusCopy(status: ClipExportSnapshot["status"]) {
	switch (status) {
		case "ready":
			return {
				label: "Ready",
				detail: "Every format is ready.",
			};
		case "partial_ready":
			return {
				label: "Partially ready",
				detail: "Some formats are ready; retry the rest.",
			};
		case "failed":
			return {
				label: "Failed",
				detail: "No format finished rendering.",
			};
		case "rendering":
			return {
				label: "Rendering",
				detail: "Rendering your saved version.",
			};
		default:
			return {
				label: "Queued",
				detail: "Waiting for a render slot.",
			};
	}
}

export function ExportDeliveryClient({
	initialExport,
	initialSeq,
	timelineRequirement,
	timelineUpgrade,
	canEdit,
	publishingUpgrade,
	canSendForReview,
	reviewUpgrade,
}: {
	initialExport: ClipExportSnapshot;
	initialSeq: number;
	/** Why the plan can't download editor timelines, computed server-side; `null` when it can. */
	timelineRequirement: string | null;
	/** The plan that unlocks timelines; `null` when the plan already allows them. */
	timelineUpgrade: UpgradePrompt | null;
	/** Role and workspace status allow links, retries and publishing; downloads stay open to every member. */
	canEdit: boolean;
	/** What unlocks publishing; `null` when the plan already publishes. */
	publishingUpgrade: UpgradePrompt | null;
	/** Role allows starting a review round (`review.manage`). */
	canSendForReview: boolean;
	/** What unlocks review rooms; `null` when the plan has them. */
	reviewUpgrade: UpgradePrompt | null;
}) {
	const { openUpgrade } = useUpgrade();
	const runtime = useApiRuntime();
	const selectedScope = useWorkspaceScope();
	if (!selectedScope) throw new Error("The export page requires a selected Workspace");
	const scope: WorkspaceScope = selectedScope;
	const queryClient = useQueryClient();
	const client = useMemo(() => createExportsClient(runtime.transport.scoped(scope)), [runtime.transport, scope]);
	const { projectId, clipId } = initialExport;
	const detailOptions = exportQueries.detail(client, scope, projectId, clipId, initialExport.id);
	const [selectedVariantId, setSelectedVariantId] = useState(
		initialExport.variants.find((variant) => variant.hasAsset)?.id ??
			initialExport.variants[0]?.id ??
			"",
	);
	const [sharePath, setSharePath] = useState<string | null>(null);
	const [action, setAction] = useState<"share" | "retry" | "revoke" | null>(
		null,
	);
	const [actionError, setActionError] = useState<string | null>(null);
	const [timelineTarget, setTimelineTarget] = useState<TimelineTarget | null>(null);
	const [timelineError, setTimelineError] = useState<string | null>(null);
	const [timelineNote, setTimelineNote] = useState<string | null>(null);
	const [subtitleFormat, setSubtitleFormat] = useState<"srt" | "vtt" | null>(null);
	const lastSeqRef = useRef(initialSeq);

	// The export is the screen's cached read; this view only observes it, so a cache
	// reset on lost access (below) swaps the page for the screen's own recovery
	// instead of re-seeding the old snapshot. The shared
	// progress hub refreshes it behind its throttle (terminal outcomes at once);
	// the fallback poll and a reconnect cover a stream that is down.
	const detail = useQuery({
		...detailOptions,
		refetchOnMount: false,
		refetchOnWindowFocus: false,
		refetchInterval: (query) =>
			query.state.data && ACTIVE_STATUSES.has(query.state.data.status) ? ACTIVE_FALLBACK_POLL_MS : false,
	});
	// The last good read; the screen unmounts this view in the render where the read is gone.
	const lastRead = useRef<ClipExportDetailData>({ ...initialExport, lastSeq: initialSeq } as ClipExportDetailData);
	if (detail.data) lastRead.current = detail.data;
	const { lastSeq: _lastSeq, ...data } = lastRead.current;
	const active = ACTIVE_STATUSES.has(data.status);
	const refetchDetail = detail.refetch;
	const refresh = useCallback(async () => {
		await refetchDetail();
	}, [refetchDetail]);

	// A newer snapshot may carry a format that finished: keep the choice on a file that exists.
	useEffect(() => {
		setSelectedVariantId((current) =>
			data.variants.some((variant) => variant.id === current && variant.hasAsset)
				? current
				: (data.variants.find((variant) => variant.hasAsset)?.id ?? current),
		);
	}, [data.variants]);

	// Snapshot file URLs expire in 15 minutes: after a long absence (a hidden
	// tab, a sleeping laptop) read the export again before anyone clicks one.
	const dataUpdatedAt = useRef(detail.dataUpdatedAt);
	dataUpdatedAt.current = detail.dataUpdatedAt;
	useEffect(() => {
		const onVisible = () => {
			if (document.visibilityState === "visible" && Date.now() - dataUpdatedAt.current > SNAPSHOT_RESUME_AGE_MS) {
				void refetchDetail();
			}
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => document.removeEventListener("visibilitychange", onVisible);
	}, [refetchDetail]);

	// Access ended or the stream was refused: clear what the Project showed and re-read the
	// export, whose own answer (missing, forbidden) drives the screen.
	const reread = useCallback(() => {
		void clearProjectAccess(queryClient, scope, projectId);
	}, [queryClient, scope, projectId]);
	useProgressStream(runtime, scope, projectId, {
		enabled: active,
		sinceSeq: lastSeqRef.current,
		onEvent: (event) => {
			lastSeqRef.current = Math.max(lastSeqRef.current, event.seq);
		},
		// Events may have been missed while disconnected, and file URLs may have aged.
		onOpen: ({ reconnected }) => {
			if (reconnected) void refresh();
		},
		onRevoked: reread,
		onFatal: (error) => {
			if (error.code !== CLIENT_ERROR_CODES.scopeChanged) reread();
		},
	});

	const selected =
		data.variants.find((variant) => variant.id === selectedVariantId) ??
		data.variants.find((variant) => variant.hasAsset) ??
		data.variants[0];
	const copy = statusCopy(data.status);
	const hasReady = data.variants.some((variant) => variant.hasAsset);
	// The review composer only lists exports that are fully ready, so a rendering or
	// partially ready export would open it with nothing picked.
	const reviewable = data.status === "ready" && hasReady;
	const hasFailed = data.variants.some(
		(variant) => variant.status === "failed",
	);
	const shareUrl = useMemo(
		() =>
			sharePath && typeof window !== "undefined"
				? `${window.location.origin}${sharePath}`
				: null,
		[sharePath],
	);

	async function createShareLink() {
		setAction("share");
		setActionError(null);
		try {
			const link = await exportCommands.createShareLink(client, projectId, clipId, data.id, 7);
			if (!link.path) throw new Error("share_failed");
			setSharePath(link.path);
			void invalidateAfterExportChange(queryClient, scope, projectId);
			await navigator.clipboard.writeText(`${window.location.origin}${link.path}`);
		} catch {
			setActionError("The private link could not be created. Try again.");
		} finally {
			setAction(null);
		}
	}

	async function copyShareLink() {
		if (!shareUrl) return;
		try {
			await navigator.clipboard.writeText(shareUrl);
		} catch {
			setActionError(
				"Copy was blocked by the browser. Select the link manually.",
			);
		}
	}

	async function revokeLinks() {
		setAction("revoke");
		setActionError(null);
		try {
			await exportCommands.revokeShareLinks(client, projectId, clipId, data.id);
			setSharePath(null);
			void invalidateAfterExportChange(queryClient, scope, projectId);
		} catch {
			setActionError("Share links could not be revoked. Try again.");
		} finally {
			setAction(null);
		}
	}

	async function retry() {
		setAction("retry");
		setActionError(null);
		try {
			const next = await exportCommands.retry(client, projectId, clipId, data.id);
			// Show the requeued formats at once; the invalidation below re-reads the rest (credits, lists).
			queryClient.setQueryData(detailOptions.queryKey, { ...(next as ClipExportSnapshot), lastSeq: lastSeqRef.current });
			void invalidateAfterExportChange(queryClient, scope, projectId);
		} catch {
			setActionError("The failed variants could not be requeued. Try again.");
		} finally {
			setAction(null);
		}
	}

	async function downloadSubtitles(format: "srt" | "vtt") {
		setSubtitleFormat(format);
		setActionError(null);
		try {
			const file = await fetchSubtitleFile(client, projectId, clipId, data.id, format);
			const url = URL.createObjectURL(file.blob);
			saveFile(url, file.fileName);
			setTimeout(() => URL.revokeObjectURL(url), 60_000);
		} catch {
			setActionError("The subtitles could not be downloaded. Try again.");
		} finally {
			setSubtitleFormat(null);
		}
	}

	// The timeline ZIP is fetched, not linked, so a refusal shows its message
	// instead of downloading an error page, and the revision shown is the one
	// the response was cut from.
	async function downloadTimeline(target: TimelineTarget) {
		setTimelineTarget(target);
		setTimelineError(null);
		setTimelineNote(null);
		try {
			if (target === "source") {
				const grant = await exportCommands.timelineSourceGrant(client, projectId, clipId);
				saveFile(grant.downloadUrl, grant.fileName);
				setTimelineNote(`Downloading ${grant.fileName}.`);
				return;
			}
			const archive = await fetchTimelineArchive(client, projectId, clipId, target);
			const url = URL.createObjectURL(archive.blob);
			saveFile(url, archive.fileName);
			setTimeout(() => URL.revokeObjectURL(url), 60_000);
			setTimelineNote(
				`Downloaded ${archive.fileName}${archive.editorRevision !== null ? `, cut from edit v${archive.editorRevision}` : ""}.`,
			);
		} catch (failure) {
			if (isApiError(failure) && failure.status === 402) {
				const prompt = upgradePromptFromFailure(browserFailureFromApiError(failure));
				if (prompt) openUpgrade(prompt);
			}
			setTimelineError(
				isApiError(failure) && failure.message ? failure.message : "The timeline could not be downloaded. Try again.",
			);
		} finally {
			setTimelineTarget(null);
		}
	}

	const timelineLocked = timelineRequirement !== null;
	const videoRef = useRef<HTMLVideoElement>(null);
	const ambientRef = useRef<HTMLCanvasElement>(null);
	useAmbientGlow(videoRef, ambientRef, selected?.previewUrl ?? selected?.downloadUrl ?? null);

	const ratio =
		selected?.aspectRatio === "9:16"
			? 9 / 16
			: selected?.aspectRatio === "1:1"
				? 1
				: selected?.aspectRatio === "4:5"
					? 4 / 5
					: 16 / 9;

	const facts = [
		selected?.aspectRatio,
		data.resolution,
		selected?.durationSec ? formatDuration(selected.durationSec) : null,
		selected?.sizeBytes ? formatBytes(selected.sizeBytes) : null,
		data.watermark ? "Watermark" : null,
	].filter((fact): fact is string => Boolean(fact));

	return (
		// Same layout as the Studio it opens from: separate panels on the frame,
		// 8px apart — a header, the preview, and one side panel.
		<Flex
			direction="column"
			minH="100dvh"
			h={{ lg: "100dvh" }}
			bg="bg.sidebar"
			p={{ base: "0", md: "2" }}
			gap="2"
		>
			<Flex
				as="header"
				h="56px"
				flexShrink={0}
				align="center"
				justify="space-between"
				gap="3"
				px="3"
				bg="bg"
				borderRadius={{ base: "0", md: "12px" }}
			>
				<HStack gap="2" minW="0">
					<Button asChild variant="ghost" size="sm">
						<Link
							href={`/projects/${data.projectId}/clips/${data.clipId}/studio`}
						>
							<ArrowLeft size={16} /> Studio
						</Link>
					</Button>
					<Text fontSize="15px" fontWeight="500" truncate>
						{data.clipTitle}
					</Text>
					<Text fontSize="13px" color="fg.subtle" truncate display={{ base: "none", md: "block" }}>
						{data.projectTitle}
					</Text>
				</HStack>
			</Flex>

			{data.isOlderVersion ? (
				<Flex
					align={{ base: "flex-start", sm: "center" }}
					direction={{ base: "column", sm: "row" }}
					justify="space-between"
					gap="3"
					px="5"
					py="3"
					bg="bg"
					borderRadius={{ base: "0", md: "12px" }}
				>
					<Flex gap="3" align="center">
						<Mark tone="warning">
							<Clock3 size={16} />
						</Mark>
						<Box>
							<Text fontWeight="500" fontSize="14px">
								A newer version exists
							</Text>
							<Text fontSize="13px" color="fg.muted">
								This export stays on v{data.editorRevision}; the Studio is on v{data.currentEditorRevision}.
							</Text>
						</Box>
					</Flex>
					<Button asChild size="sm" variant="subtle">
						<Link
							href={`/projects/${data.projectId}/clips/${data.clipId}/studio`}
						>
							Export newer version
						</Link>
					</Button>
				</Flex>
			) : null}

			<Flex flex="1" minH="0" gap="2" direction={{ base: "column", lg: "row" }}>
				{/* Preview panel — the video at its own aspect ratio, sized to the
				    height, over a soft glow drawn from its own frames. */}
				<Flex
					position="relative"
					flex="1"
					minW="0"
					direction="column"
					align="center"
					justify="center"
					gap="5"
					p={{ base: "4", md: "8" }}
					bg="bg"
					borderRadius={{ base: "0", md: "12px" }}
					overflow="hidden"
				>
					<Box
						asChild
						position="absolute"
						inset="0"
						w="full"
						h="full"
						opacity={0.4}
						pointerEvents="none"
						style={{ filter: "blur(72px) saturate(1.2)", transform: "scale(1.2)" }}
					>
						<canvas ref={ambientRef} width={48} height={48} aria-hidden />
					</Box>

					{/* The player takes the height the panel has left, at the video's own shape. */}
					<Flex position="relative" flex={{ lg: "1" }} minH="0" w="full" maxH="820px" justify="center">
					<Box
						position="relative"
						aspectRatio={ratio}
						h={{ base: "auto", lg: "full" }}
						w={{ base: "full", lg: "auto" }}
						maxW={{ base: "420px", lg: "full" }}
						borderRadius="l3"
						overflow="hidden"
						bg="studio.canvas"
					>
						{selected?.downloadUrl ? (
							<Box asChild w="full" h="full">
								{/* biome-ignore lint/a11y/useMediaCaption: This is the final rendered export, which already burns the user's configured captions into the video. */}
								<video
									ref={videoRef}
									controls
									controlsList="nodownload noplaybackrate"
									playsInline
									preload="metadata"
									src={selected.previewUrl ?? selected.downloadUrl}
									aria-label={`${selected.aspectRatio} exported video`}
								/>
							</Box>
						) : (
							<Flex
								h="full"
								minH="320px"
								align="center"
								justify="center"
								direction="column"
								gap="3"
								px="6"
								textAlign="center"
								color="studio.fgMuted"
							>
								{data.status === "failed" ? (
									<AlertTriangle size={24} />
								) : (
									<Spinner size="md" />
								)}
								<Text fontSize="13px">
									{data.status === "failed"
										? "Render failed"
										: `Rendering · ${data.progress}%`}
								</Text>
							</Flex>
						)}
					</Box>
					</Flex>

					{/* Only a choice when there is one to make. */}
					{data.variants.length > 1 ? (
						<SegmentedControl
							position="relative"
							aria-label="Export format"
							value={selected?.id ?? ""}
							onValueChange={setSelectedVariantId}
							items={data.variants.map((variant) => ({
								value: variant.id,
								disabled: !variant.hasAsset,
								label: (
									<Flex align="center" gap="1.5">
										{variant.status === "failed" ? (
											<AlertTriangle size={13} />
										) : variant.status !== "completed" ? (
											<Clock3 size={13} />
										) : null}
										{variant.aspectRatio}
									</Flex>
								),
							}))}
						/>
					) : null}
				</Flex>

				{/* Side panel — status, facts, then what to do with the export */}
				<Stack
					w={{ base: "full", lg: "380px" }}
					flexShrink={0}
					gap="6"
					p="5"
					bg="bg"
					borderRadius={{ base: "0", md: "12px" }}
					overflowY="auto"
				>
					<Stack gap="4">
						<Flex align="center" gap="3">
							<Mark tone={data.status === "failed" ? "danger" : data.status === "partial_ready" ? "warning" : "accent"}>
								{data.status === "ready" ? (
									<Check size={18} strokeWidth={2.5} />
								) : data.status === "failed" || data.status === "partial_ready" ? (
									<AlertTriangle size={17} />
								) : (
									<Spinner size="xs" />
								)}
							</Mark>
							<Box flex="1" minW="0">
								<Text fontSize="17px" fontWeight="550" letterSpacing="-0.01em">
									{copy.label}
								</Text>
								<Text fontSize="12px" color="fg.muted">
									{data.status === "ready"
										? formatDateTime(data.completedAt ?? data.createdAt)
										: copy.detail}
								</Text>
							</Box>
							{active ? (
								<Text fontSize="13px" fontVariantNumeric="tabular-nums" color="fg.muted">
									{data.progress}%
								</Text>
							) : null}
						</Flex>
						{active ? (
							<Box
								role="progressbar"
								aria-label="Export progress"
								aria-valuemin={0}
								aria-valuemax={100}
								aria-valuenow={data.progress}
							>
								<Progress value={data.progress} />
							</Box>
						) : null}
						{hasFailed && canEdit ? (
							<Button
								variant="subtle"
								size="sm"
								alignSelf="flex-start"
								disabled={action === "retry"}
								onClick={() => void retry()}
							>
								{action === "retry" ? <Spinner size="xs" /> : <RefreshCw size={14} />}
								Retry failed formats
							</Button>
						) : null}

						<Flex gap="1.5" wrap="wrap">
							<InfoTip label="Later edits make a new version, so this export and its links never change.">
								<Fact>
									<Lock size={11} /> v{data.editorRevision}
								</Fact>
							</InfoTip>
							{facts.map((fact) => (
								<Fact key={fact}>{fact}</Fact>
							))}
						</Flex>
					</Stack>

					<Button
						asChild={Boolean(selected?.downloadUrl)}
						colorPalette="brand"
						disabled={!selected?.downloadUrl}
						w="full"
						size="lg"
					>
						{selected?.downloadUrl ? (
							<a
								href={selected.downloadUrl}
								download={`narriflow-${selected.aspectRatio.replace(":", "x")}.mp4`}
							>
								<Download size={17} /> Download video
							</a>
						) : (
							<>
								<Download size={17} /> Download when ready
							</>
						)}
					</Button>

					{canEdit ? (
						<Section title="Share">
							<Grid templateColumns="1fr 1fr" gap="2">
								<Tile
									icon={action === "share" ? <Spinner size="xs" /> : <Link2 size={16} />}
									label="Private link"
									hint="Expires in 7 days"
									disabled={!hasReady || action === "share"}
									onClick={() => void createShareLink()}
								/>
								{publishingUpgrade ? (
									<LockedButton {...TILE_PROPS} prompt={publishingUpgrade}>
										<TileBody icon={<Send size={16} />} label="Publish" hint="To your socials" />
									</LockedButton>
								) : (
									<Button {...TILE_PROPS} asChild={hasReady} disabled={!hasReady}>
										{hasReady ? (
											<Link href={`/projects/${data.projectId}?publishClip=${data.clipId}&publishExport=${data.id}`}>
												<TileBody icon={<Send size={16} />} label="Publish" hint="To your socials" />
											</Link>
										) : (
											<TileBody icon={<Send size={16} />} label="Publish" hint="To your socials" />
										)}
									</Button>
								)}
								{canSendForReview ? (
									reviewUpgrade ? (
										<LockedButton {...TILE_PROPS} gridColumn="span 2" prompt={reviewUpgrade}>
											<TileBody icon={<UserCheck size={16} />} label="Send for review" hint="Get a client's approval" />
										</LockedButton>
									) : (
										<Button {...TILE_PROPS} gridColumn="span 2" asChild={reviewable} disabled={!reviewable}>
											{reviewable ? (
												// The project's review composer opens with this export picked
												// (same `exportId:variantIds` format as encodeReviewSelection).
												<Link
													href={`/projects/${data.projectId}?tab=review&reviewSelection=${encodeURIComponent(
														`${data.id}:${data.variants
															.filter((variant) => variant.hasAsset)
															.map((variant) => variant.id)
															.join(",")}`,
													)}`}
												>
													<TileBody icon={<UserCheck size={16} />} label="Send for review" hint="Get a client's approval" />
												</Link>
											) : (
												<TileBody
													icon={<UserCheck size={16} />}
													label="Send for review"
													hint={data.status === "ready" ? "Get a client's approval" : "Available once the export is ready"}
												/>
											)}
										</Button>
									)
								) : null}
							</Grid>
							{shareUrl ? (
								<Flex align="center" gap="2" mt="2" ps="3" pe="1" py="1" bg="accent.subtle" borderRadius="l2">
									<ShieldCheck size={14} color="var(--chakra-colors-accent-fg)" />
									<Text fontSize="12px" color="accent.fg" flex="1" minW="0" truncate title={shareUrl}>
										{shareUrl.replace(/^https?:\/\//, "")}
									</Text>
									<IconButton size="xs" variant="ghost" aria-label="Copy the private link" onClick={() => void copyShareLink()}>
										<Copy size={13} />
									</IconButton>
									<Button size="xs" variant="ghost" disabled={action === "revoke"} onClick={() => void revokeLinks()}>
										Revoke
									</Button>
								</Flex>
							) : null}
							{actionError ? <ErrorLine>{actionError}</ErrorLine> : null}
						</Section>
					) : null}

					<Section title="Subtitles">
						<Grid templateColumns="1fr 1fr" gap="2">
							{(
								[
									["srt", "SRT", "Most editors"],
									["vtt", "VTT", "Web players"],
								] as const
							).map(([format, label, hint]) =>
								hasReady ? (
									<Button
										key={format}
										{...TILE_PROPS}
										disabled={subtitleFormat !== null}
										onClick={() => void downloadSubtitles(format)}
									>
										<TileBody
											icon={subtitleFormat === format ? <Spinner size="xs" /> : <FileText size={16} />}
											label={label}
											hint={hint}
										/>
									</Button>
								) : (
									<Button key={format} {...TILE_PROPS} disabled>
										<TileBody icon={<FileText size={16} />} label={label} hint={hint} />
									</Button>
								),
							)}
						</Grid>
					</Section>

					<Section
						title="Edit in your own editor"
						info="Cuts the original video at the clip's current edit. Put the video beside the timeline before opening it. Scenes and overlays aren't included; the ZIP has the captions as SRT."
					>
						<Grid templateColumns="1fr 1fr" gap="2">
							{[...TIMELINE_DOWNLOADS, { format: "source", label: "Original video", hint: "Source cut" } as const].map(
								({ format, label, hint }) => {
									const icon = timelineIcon(timelineTarget === format, format);
									return timelineLocked && timelineUpgrade ? (
										<LockedButton key={format} {...TILE_PROPS} prompt={timelineUpgrade}>
											<TileBody icon={icon} label={label} hint={hint} />
										</LockedButton>
									) : (
										<Tile
											key={format}
											icon={icon}
											label={label}
											hint={hint}
											disabled={timelineTarget !== null || timelineLocked}
											onClick={() => void downloadTimeline(format)}
										/>
									);
								},
							)}
						</Grid>
						<PlanLimitNotice message={timelineRequirement} upgrade={timelineUpgrade} />
						{timelineNote ? (
							<Text fontSize="12px" color="fg.muted" role="status" mt="2">
								{timelineNote}
							</Text>
						) : null}
						{timelineError ? <ErrorLine>{timelineError}</ErrorLine> : null}
					</Section>
				</Stack>
			</Flex>
		</Flex>
	);
}

/**
 * Paints the playing video, shrunk, onto a canvas that the page blurs into
 * a soft glow behind the player (an "ambient mode"). A cross-origin video
 * taints the canvas, which only stops reading pixels back, never drawing.
 */
function useAmbientGlow(
	videoRef: React.RefObject<HTMLVideoElement | null>,
	canvasRef: React.RefObject<HTMLCanvasElement | null>,
	src: string | null,
) {
	// biome-ignore lint/correctness/useExhaustiveDependencies: src re-binds the listeners to the new video source.
	useEffect(() => {
		const video = videoRef.current;
		const canvas = canvasRef.current;
		const context = canvas?.getContext("2d");
		if (!video || !canvas || !context) return;
		const paint = () => {
			if (video.readyState < 2) return;
			try {
				context.drawImage(video, 0, 0, canvas.width, canvas.height);
			} catch {
				// A frame that can't be drawn leaves the last glow in place.
			}
		};
		const events = ["loadeddata", "seeked", "timeupdate"] as const;
		for (const event of events) video.addEventListener(event, paint);
		// The first frame can be ready before it can be drawn, and a paused
		// video sends no more events, so a slow repaint (48x48, twice a
		// second) also keeps the glow honest.
		const repaint = setInterval(paint, 500);
		paint();
		return () => {
			clearInterval(repaint);
			for (const event of events) video.removeEventListener(event, paint);
		};
	}, [videoRef, canvasRef, src]);
}

function timelineIcon(busy: boolean, format: TimelineTarget) {
	if (busy) return <Spinner size="xs" />;
	if (format === "xmeml") return <EditorMark name="Premiere" light="premiere.svg" />;
	// One FCPXML opens in both; Final Cut's icon isn't licensed for this, so Resolve's mark stands in.
	if (format === "fcpxml") return <EditorMark name="DaVinci Resolve" light="davinci-resolve-light.svg" dark="davinci-resolve-dark.svg" />;
	return format === "source" ? <Clapperboard size={16} /> : <Film size={16} />;
}

/** An editor's own icon (public/images/editors), with a dark-mode file when the mark is one colour. */
function EditorMark({ name, light, dark }: { name: string; light: string; dark?: string }) {
	return (
		<Box boxSize="5" flexShrink={0} aria-hidden>
			<Image src={`/images/editors/${light}`} alt={name} boxSize="full" objectFit="contain" _dark={dark ? { display: "none" } : undefined} />
			{dark ? (
				<Image src={`/images/editors/${dark}`} alt={name} boxSize="full" objectFit="contain" display="none" _dark={{ display: "block" }} />
			) : null}
		</Box>
	);
}

/** A round status mark: the colour says the state before the words do. */
function Mark({ tone, children }: { tone: "accent" | "warning" | "danger"; children: ReactNode }) {
	return (
		<Flex
			boxSize="10"
			flexShrink={0}
			borderRadius="full"
			align="center"
			justify="center"
			bg={`${tone}.subtle`}
			color={`${tone}.fg`}
			aria-hidden
		>
			{children}
		</Flex>
	);
}

/** One fact about the export as a soft chip. */
function Fact({ children }: { children: ReactNode }) {
	return (
		<Flex
			align="center"
			gap="1"
			h="6"
			px="2.5"
			borderRadius="full"
			bg="bg.soft"
			color="fg.muted"
			fontSize="12px"
			fontVariantNumeric="tabular-nums"
		>
			{children}
		</Flex>
	);
}

/** A labelled group of actions, with its longer explanation behind an ⓘ. */
function Section({ title, info, children }: { title: string; info?: string; children: ReactNode }) {
	return (
		<Box>
			<Flex align="center" gap="1.5" mb="2.5">
				<Text textStyle="eyebrow" color="fg.muted">
					{title}
				</Text>
				{info ? (
					<InfoTip label={info}>
						<Flex
							as="button"
							aria-label={info}
							boxSize="5"
							align="center"
							justify="center"
							borderRadius="full"
							color="fg.subtle"
							cursor="help"
							_hover={{ color: "fg" }}
							_focusVisible={{ outline: "2px solid", outlineColor: "accent.solid" }}
						>
							<Info size={13} aria-hidden />
						</Flex>
					</InfoTip>
				) : null}
			</Flex>
			{children}
		</Box>
	);
}

function InfoTip({ label, children }: { label: string; children: ReactNode }) {
	return (
		<Tooltip.Root openDelay={150} closeDelay={0} positioning={{ placement: "top" }}>
			<Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
			<Portal>
				<Tooltip.Positioner>
					<Tooltip.Content bg="bg.muted" color="fg" borderRadius="l2" boxShadow="none" px="3" py="2" fontSize="12px" maxW="280px">
						{label}
					</Tooltip.Content>
				</Tooltip.Positioner>
			</Portal>
		</Tooltip.Root>
	);
}

/** Action tiles share one shape: a soft card with an icon, a label and a
 *  hint; a locked tile's upgrade gem lands at the end of the row. */
const TILE_PROPS = {
	variant: "subtle",
	h: "auto",
	minH: "14",
	px: "3",
	py: "2.5",
	borderRadius: "l2",
	justifyContent: "flex-start",
	gap: "2.5",
	whiteSpace: "normal",
	textAlign: "start",
} as const;

function TileBody({ icon, label, hint }: { icon: ReactNode; label: string; hint: string }) {
	return (
		<>
			<Flex color="fg.muted" flexShrink={0} align="center">
				{icon}
			</Flex>
			<Box flex="1" minW="0">
				<Text fontSize="13px" fontWeight="500" color="fg" lineHeight="1.3">
					{label}
				</Text>
				<Text fontSize="11px" color="fg.subtle" fontWeight="400" lineHeight="1.3">
					{hint}
				</Text>
			</Box>
		</>
	);
}

function Tile({
	icon,
	label,
	hint,
	disabled,
	onClick,
}: {
	icon: ReactNode;
	label: string;
	hint: string;
	disabled?: boolean;
	onClick: () => void;
}) {
	return (
		<Button {...TILE_PROPS} disabled={disabled} onClick={onClick}>
			<TileBody icon={icon} label={label} hint={hint} />
		</Button>
	);
}

function ErrorLine({ children }: { children: ReactNode }) {
	return (
		<Flex mt="2" gap="2" color="danger.fg" role="alert">
			<Box flexShrink={0} mt="0.5">
				<AlertTriangle size={14} />
			</Box>
			<Text fontSize="12px">{children}</Text>
		</Flex>
	);
}

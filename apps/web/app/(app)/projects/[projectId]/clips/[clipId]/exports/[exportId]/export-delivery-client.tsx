"use client";

import { PlanLimitNotice } from "../../../../../../_components/plan-limit-notice";
import { LockedButton, useUpgrade, type UpgradePrompt } from "../../../../../../_components/upgrade";
import { upgradePromptFromFailure } from "@/lib/authenticated-request-browser";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Box, Flex, Grid, HStack, Stack, Text } from "@chakra-ui/react";
import {
	AlertTriangle,
	ArrowLeft,
	Check,
	Clock3,
	Copy,
	Download,
	ExternalLink,
	FileText,
	Film,
	Link2,
	RefreshCw,
	ShieldCheck,
} from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { MediaWell } from "@narriflow/ui/components/media-well";
import { Progress } from "@narriflow/ui/components/progress";
import { Spinner } from "@narriflow/ui/components/spinner";
import { StatusBadge } from "@narriflow/ui/components/status-badge";
import type { ClipExportSnapshot } from "@narriflow/validators";
import { formatDateTime, formatDuration } from "@/lib/format";
import {
	parseWorkflowAuthorizationControl,
	recoverFromWorkflowAuthorizationLoss,
} from "@/lib/workflow-stream-authorization";

const ACTIVE_STATUSES = new Set(["queued", "rendering", "partial_ready"]);

const TIMELINE_DOWNLOADS = [
	{ format: "xmeml", label: "Premiere" },
	{ format: "fcpxml", label: "Final Cut, Resolve" },
	{ format: "edl", label: "EDL" },
] as const;

type TimelineTarget = (typeof TIMELINE_DOWNLOADS)[number]["format"] | "source";

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
				detail: "Every requested variant is ready to deliver.",
			};
		case "partial_ready":
			return {
				label: "Partially ready",
				detail: "Ready variants are available; failed ones can be retried.",
			};
		case "failed":
			return {
				label: "Failed",
				detail: "No variant completed. Retry the failed render.",
			};
		case "rendering":
			return {
				label: "Rendering",
				detail: "Your saved version is rendering in the background.",
			};
		default:
			return {
				label: "Queued",
				detail: "Your export is waiting for render capacity.",
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
}) {
	const { openUpgrade } = useUpgrade();
	const [data, setData] = useState(initialExport);
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
	const lastSeqRef = useRef(initialSeq);

	const clipPath = `/api/projects/${data.projectId}/clips/${data.clipId}`;
	const apiPath = `${clipPath}/exports/${data.id}`;
	const refresh = useCallback(async () => {
		const response = await fetch(apiPath, { cache: "no-store" });
		if (!response.ok) return;
		const next = (await response.json()) as ClipExportSnapshot;
		setData(next);
		setSelectedVariantId((current) =>
			next.variants.some(
				(variant) => variant.id === current && variant.hasAsset,
			)
				? current
				: (next.variants.find((variant) => variant.hasAsset)?.id ?? current),
		);
	}, [apiPath]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: initialSeq intentionally reconnects the stream from a new server cursor.
	useEffect(() => {
		if (!ACTIVE_STATUSES.has(data.status)) return;
		let fallback: ReturnType<typeof setInterval> | null = null;
		const source = new EventSource(
			`/api/stream/${data.projectId}?sinceSeq=${lastSeqRef.current}`,
		);
		const onUpdate = (event: MessageEvent<string>) => {
			try {
				const payload = JSON.parse(event.data) as {
					stage?: unknown;
					seq?: unknown;
				};
				if (typeof payload.seq === "number") {
					lastSeqRef.current = Math.max(lastSeqRef.current, payload.seq);
				}
				if (payload.stage !== "clip_rendering") return;
			} catch {
				return;
			}
			void refresh();
		};
		const onAuthorizationRevoked = (event: MessageEvent<string>) => {
			source.close();
			const control = parseWorkflowAuthorizationControl(event.data);
			if (control) {
				recoverFromWorkflowAuthorizationLoss(
					control,
					`${window.location.pathname}${window.location.search}`,
				);
			} else {
				window.location.reload();
			}
		};
		source.addEventListener("workflow.stage.updated", onUpdate);
		source.addEventListener("authorization.revoked", onAuthorizationRevoked);
		source.onerror = () => {
			source.close();
			if (fallback !== null) clearInterval(fallback);
			fallback = setInterval(() => {
				if (document.visibilityState === "visible") void refresh();
			}, 5_000);
		};
		fallback = setInterval(() => {
			if (document.visibilityState === "visible") void refresh();
		}, 10_000);
		return () => {
			source.removeEventListener("workflow.stage.updated", onUpdate);
			source.removeEventListener(
				"authorization.revoked",
				onAuthorizationRevoked,
			);
			source.close();
			if (fallback !== null) clearInterval(fallback);
		};
	}, [data.projectId, data.status, initialSeq, refresh]);

	const selected =
		data.variants.find((variant) => variant.id === selectedVariantId) ??
		data.variants.find((variant) => variant.hasAsset) ??
		data.variants[0];
	const copy = statusCopy(data.status);
	const hasReady = data.variants.some((variant) => variant.hasAsset);
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
			const response = await fetch(`${apiPath}/share-links`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ expiresInDays: 7 }),
			});
			const body = await response.json().catch(() => null);
			if (!response.ok || !body?.path) throw new Error("share_failed");
			setSharePath(body.path);
			await navigator.clipboard.writeText(
				`${window.location.origin}${body.path}`,
			);
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
			const response = await fetch(`${apiPath}/share-links`, {
				method: "DELETE",
			});
			if (!response.ok) throw new Error("revoke_failed");
			setSharePath(null);
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
			const response = await fetch(`${apiPath}/retry`, { method: "POST" });
			if (!response.ok) throw new Error("retry_failed");
			const next = (await response.json()) as ClipExportSnapshot;
			if (next) setData(next);
		} catch {
			setActionError("The failed variants could not be requeued. Try again.");
		} finally {
			setAction(null);
		}
	}

	// The timeline ZIP is fetched, not linked, so a refusal shows its message
	// instead of downloading an error page, and the revision shown is the one
	// the response was cut from.
	async function downloadTimeline(target: TimelineTarget) {
		setTimelineTarget(target);
		setTimelineError(null);
		setTimelineNote(null);
		let failure = "The timeline could not be downloaded. Try again.";
		try {
			const response = await fetch(
				target === "source" ? `${clipPath}/timeline-source` : `${clipPath}/timeline/${target}`,
				{ cache: "no-store" },
			);
			if (!response.ok) {
				const body = await response.json().catch(() => null);
				if (typeof body?.message === "string") failure = body.message;
				if (response.status === 402 && body) {
					const prompt = upgradePromptFromFailure(body);
					if (prompt) openUpgrade(prompt);
				}
				throw new Error(failure);
			}
			if (target === "source") {
				const grant = (await response.json()) as { downloadUrl: string; fileName: string };
				saveFile(grant.downloadUrl, grant.fileName);
				setTimelineNote(`Downloading ${grant.fileName}.`);
				return;
			}
			const fileName = /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") ?? "")?.[1] ?? "timeline.zip";
			const url = URL.createObjectURL(await response.blob());
			saveFile(url, fileName);
			setTimeout(() => URL.revokeObjectURL(url), 60_000);
			const revision = response.headers.get("X-Editor-Revision");
			setTimelineNote(`Downloaded ${fileName}${revision ? `, cut from edit v${revision}` : ""}.`);
		} catch {
			setTimelineError(failure);
		} finally {
			setTimelineTarget(null);
		}
	}

	const timelineLocked = timelineRequirement !== null;

	const ratio =
		selected?.aspectRatio === "9:16"
			? 9 / 16
			: selected?.aspectRatio === "1:1"
				? 1
				: selected?.aspectRatio === "4:5"
					? 4 / 5
					: 16 / 9;

	return (
		// Same layout as the Studio it opens from: separate panels on the frame,
		// 8px apart — a header, the preview, and one side panel.
		<Flex
			direction="column"
			minH="100dvh"
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
					<Text fontSize="16px" fontWeight="500" truncate>
						{data.clipTitle}
					</Text>
				</HStack>
				{data.status === "ready" ? null : (
					<StatusBadge
						status={data.status === "failed" ? "failed" : "processing"}
						label={copy.label}
					/>
				)}
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
					<Box>
						<Text fontWeight="500" fontSize="14px">
							A newer editor version exists
						</Text>
						<Text fontSize="13px" color="fg.muted">
							This delivery stays pinned to version {data.editorRevision}.
							Open Studio to export version {data.currentEditorRevision}.
						</Text>
					</Box>
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
				{/* Preview panel — the video at its own aspect ratio, sized to the height */}
				<Flex
					flex="1"
					minW="0"
					direction="column"
					align="center"
					justify="center"
					gap="4"
					p={{ base: "4", md: "6" }}
					bg="bg"
					borderRadius={{ base: "0", md: "12px" }}
				>
					<MediaWell
						ratio={ratio}
						h={{ base: "auto", lg: "min(calc(100dvh - 200px), 820px)" }}
						w={{ base: "full", lg: "auto" }}
						maxW="full"
						timecode={
							selected?.durationSec
								? formatDuration(selected.durationSec)
								: undefined
						}
					>
						{selected?.downloadUrl ? (
							<Box asChild w="full" h="full" bg="studio.canvas">
								{/* biome-ignore lint/a11y/useMediaCaption: This is the final rendered export, which already burns the user's configured captions into the video. */}
								<video
									controls
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
										: "Rendering your saved version"}
								</Text>
							</Flex>
						)}
					</MediaWell>

					<Flex gap="2" wrap="wrap" justify="center" aria-label="Export variants">
						{data.variants.map((variant) => (
							<Button
								key={variant.id}
								size="sm"
								variant="subtle"
								borderWidth="2px"
								borderColor={
									variant.id === selected?.id ? "accent.solid" : "transparent"
								}
								bg={variant.id === selected?.id ? "accent.subtle" : undefined}
								color="fg"
								disabled={!variant.hasAsset}
								onClick={() => setSelectedVariantId(variant.id)}
								aria-pressed={variant.id === selected?.id}
							>
								{variant.status === "completed" ? (
									<Check size={14} />
								) : variant.status === "failed" ? (
									<AlertTriangle size={14} />
								) : (
									<Clock3 size={14} />
								)}
								{variant.aspectRatio}
							</Button>
						))}
					</Flex>
				</Flex>

				{/* Side panel — status, details and actions on one surface */}
				<Stack
					w={{ base: "full", lg: "380px" }}
					flexShrink={0}
					gap="6"
					p="5"
					bg="bg"
					borderRadius={{ base: "0", md: "12px" }}
					overflowY="auto"
				>
					<Stack gap="3">
						<Flex align="baseline" justify="space-between" gap="3">
							<Text fontSize="20px" fontWeight="500">
								{copy.label}
							</Text>
							<Text fontSize="13px" fontVariantNumeric="tabular-nums" color="fg.muted">
								{data.progress}%
							</Text>
						</Flex>
						<Box
							role="progressbar"
							aria-label="Export progress"
							aria-valuemin={0}
							aria-valuemax={100}
							aria-valuenow={data.progress}
						>
							<Progress value={data.progress} />
						</Box>
						<Text fontSize="13px" color="fg.muted">
							{copy.detail}
						</Text>
					</Stack>

					<Grid templateColumns="1fr 1fr" columnGap="4" rowGap="4">
						{(
							[
								["Version", `v${data.editorRevision}`],
								["Created", formatDateTime(data.createdAt)],
								["Resolution", data.resolution],
								["Watermark", data.watermark ? "Included" : "None"],
							] as const
						).map(([label, value]) => (
							<Box key={label}>
								<Text textStyle="eyebrow" color="fg.muted">
									{label}
								</Text>
								<Text fontSize="14px" mt="0.5" fontVariantNumeric="tabular-nums">
									{value}
								</Text>
							</Box>
						))}
					</Grid>

					<Stack gap="2">
						<Button
							asChild={Boolean(selected?.downloadUrl)}
							colorPalette="brand"
							disabled={!selected?.downloadUrl}
							w="full"
							size="md"
						>
							{selected?.downloadUrl ? (
								<a
									href={selected.downloadUrl}
									download={`narriflow-${selected.aspectRatio.replace(":", "x")}.mp4`}
								>
									<Download size={16} /> Download {selected.aspectRatio} ·{" "}
									{formatBytes(selected.sizeBytes)}
								</a>
							) : (
								<>
									<Download size={16} /> Download when ready
								</>
							)}
						</Button>
						<Flex gap="2">
							{(["srt", "vtt"] as const).map((format) => (
								<Button key={format} asChild={hasReady} variant="subtle" size="md" flex="1" disabled={!hasReady}>
									{hasReady ? (
										<a href={`${apiPath}/subtitles/${format}`} download>
											<FileText size={16} /> {format.toUpperCase()} subtitles
										</a>
									) : (
										<>
											<FileText size={16} /> {format.toUpperCase()} subtitles
										</>
									)}
								</Button>
							))}
						</Flex>
						{canEdit ? (
							<>
								<Button
									variant="subtle"
									size="md"
									w="full"
									disabled={!hasReady || action === "share"}
									onClick={() => void createShareLink()}
								>
									{action === "share" ? (
										<Spinner size="xs" />
									) : (
										<Link2 size={16} />
									)}
									Create 7-day private link
								</Button>
								{publishingUpgrade ? (
									<LockedButton variant="subtle" size="md" w="full" prompt={publishingUpgrade}>
										<ExternalLink size={16} /> Publish to social
									</LockedButton>
								) : (
									<Button asChild variant="subtle" size="md" w="full" disabled={!hasReady}>
										<Link
											href={`/projects/${data.projectId}?publishClip=${data.clipId}&publishExport=${data.id}`}
										>
											<ExternalLink size={16} /> Publish to social
										</Link>
									</Button>
								)}
							</>
						) : null}
						<Stack gap="2" mt="2">
							<Text textStyle="eyebrow" color="fg.muted">
								Edit in your own editor
							</Text>
							<Flex gap="2">
								{TIMELINE_DOWNLOADS.map(({ format, label }) => (
									timelineLocked && timelineUpgrade ? (
										<LockedButton key={format} variant="subtle" size="md" flex="1" prompt={timelineUpgrade}>
											<Film size={16} /> {label}
										</LockedButton>
									) : (
										<Button
											key={format}
											variant="subtle"
											size="md"
											flex="1"
											disabled={timelineTarget !== null || timelineLocked}
											onClick={() => void downloadTimeline(format)}
										>
											{timelineTarget === format ? <Spinner size="xs" /> : <Film size={16} />}{" "}
											{label}
										</Button>
									)
								))}
							</Flex>
							{timelineLocked && timelineUpgrade ? (
								<LockedButton variant="subtle" size="md" w="full" prompt={timelineUpgrade}>
									<Download size={16} /> Original video
								</LockedButton>
							) : (
								<Button
									variant="subtle"
									size="md"
									w="full"
									disabled={timelineTarget !== null || timelineLocked}
									onClick={() => void downloadTimeline("source")}
								>
									{timelineTarget === "source" ? <Spinner size="xs" /> : <Download size={16} />}{" "}
									Original video
								</Button>
							)}
							<PlanLimitNotice message={timelineRequirement} upgrade={timelineUpgrade} />
							<Text fontSize="12px" color="fg.muted">
								Cuts the original video at the clip&apos;s current edit. Put the
								video beside the timeline before opening it. Scenes and overlays
								are not included; the ZIP has the captions as SRT.
							</Text>
							{timelineNote ? (
								<Text fontSize="12px" color="fg.muted" role="status">
									{timelineNote}
								</Text>
							) : null}
							{timelineError ? (
								<Flex gap="2" color="danger.fg" role="alert">
									<AlertTriangle size={14} />
									<Text fontSize="12px">{timelineError}</Text>
								</Flex>
							) : null}
						</Stack>
						{hasFailed && canEdit ? (
							<Button
								variant="subtle"
								size="md"
								w="full"
								disabled={action === "retry"}
								onClick={() => void retry()}
							>
								{action === "retry" ? (
									<Spinner size="xs" />
								) : (
									<RefreshCw size={16} />
								)}{" "}
								Retry failed variants
							</Button>
						) : null}

						{shareUrl ? (
							<Box mt="2" p="3" bg="bg.soft" borderRadius="l2">
								<Flex align="center" gap="2" mb="2">
									<ShieldCheck size={14} />
									<Text fontSize="13px" fontWeight="500">
										Private link copied
									</Text>
								</Flex>
								<Text fontSize="12px" color="fg.muted" wordBreak="break-all">
									{shareUrl}
								</Text>
								<Flex gap="2" mt="3">
									<Button
										size="sm"
										variant="subtle"
										onClick={() => void copyShareLink()}
									>
										<Copy size={14} /> Copy again
									</Button>
									{canEdit ? (
										<Button
											size="sm"
											variant="ghost"
											disabled={action === "revoke"}
											onClick={() => void revokeLinks()}
										>
											Revoke all
										</Button>
									) : null}
								</Flex>
							</Box>
						) : null}
						{actionError ? (
							<Flex mt="1" gap="2" color="danger.fg" role="alert">
								<AlertTriangle size={14} />
								<Text fontSize="12px">{actionError}</Text>
							</Flex>
						) : null}
					</Stack>

					{/* Quiet note at the foot of the panel, not a box */}
					<Flex gap="2.5" align="flex-start" mt="auto" color="fg.subtle">
						<Box flexShrink={0} mt="0.5">
							<Film size={14} />
						</Box>
						<Text fontSize="12px" lineHeight="1.5">
							Immutable delivery: later edits create a new version, so this
							export and its links never silently change.
						</Text>
					</Flex>
				</Stack>
			</Flex>
		</Flex>
	);
}

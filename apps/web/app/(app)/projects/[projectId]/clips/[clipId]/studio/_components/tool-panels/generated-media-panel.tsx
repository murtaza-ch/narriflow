"use client";

import {
	Box,
	Button,
	Flex,
	Image,
	NativeSelect,
	SimpleGrid,
	Stack,
	Text,
	Textarea,
	chakra,
} from "@chakra-ui/react";
import { Spinner } from "@narriflow/ui/components/spinner";
import type {
	GeneratedMediaAspectRatio,
	GeneratedMediaKind,
	GeneratedMediaStyle,
	GeneratedMediaStudioListResult,
} from "@narriflow/validators";
import {
	Download,
	Check,
	AlertTriangle,
	Film,
	Image as ImageIcon,
	Library,
	RefreshCw,
	Sparkles,
	Trash2,
	X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
	buildGeneratedMediaInsertionIntent,
	resolveGeneratedMediaSubmissionIdentity,
	type GeneratedMediaInsertionAsset,
	type GeneratedMediaInsertionIntent,
	type GeneratedMediaSubmissionIdentity,
} from "./generated-media-actions";
import type {
	GeneratedMediaPromptSource,
	GeneratedMediaStudioSubmitDraft,
} from "./generated-media-studio-model";

export interface GeneratedMediaGalleryItem {
	id: string;
	kind: GeneratedMediaKind;
	status:
		| "queued"
		| "running"
		| "waiting"
		| "reconciliation_required"
		| "completed"
		| "failed"
		| "rejected"
		| "cancelled";
	errorCode: string | null;
	moderationOutcome: "pending" | "passed" | "rejected";
	assetAvailability:
		| "available"
		| "deleted"
		| "missing"
		| "storage_unavailable"
		| "not_ready";
	savedToActiveBrandProfile: boolean;
	asset: (GeneratedMediaInsertionAsset & {
		title: string;
		accessUrl: string;
	}) | null;
}

export interface GeneratedMediaPanelProps {
	projectId: string;
	clipId: string;
	basePlayheadSec: number;
	baseDurationSec: number;
	compositePlayheadSec: number;
	compositeDurationSec: number;
	promptSources: readonly GeneratedMediaPromptSource[];
	jobs: readonly GeneratedMediaGalleryItem[];
	selectedBrollPlacementId: string | null;
	activeBrandProfile: { id: string; name: string } | null;
	usage: GeneratedMediaStudioListResult["usage"] | null;
	imageAvailable: boolean;
	videoAvailable: boolean;
	supportedImageRatios?: readonly GeneratedMediaAspectRatio[];
	supportedVideoRatios?: readonly GeneratedMediaAspectRatio[];
	supportedVideoDurations?: readonly number[];
	onGenerate: (input: GeneratedMediaStudioSubmitDraft) => Promise<void>;
	onRefresh: () => Promise<void> | void;
	onCancel: (jobId: string) => Promise<void>;
	onInsert: (intent: GeneratedMediaInsertionIntent) => Promise<void>;
	onSaveToBrand: (jobId: string) => Promise<void>;
	onDownload: (jobId: string) => Promise<void> | void;
	onDelete: (jobId: string) => Promise<void>;
}

const styles: readonly GeneratedMediaStyle[] = [
	"photographic",
	"editorial",
	"illustrated",
	"graphic",
	"minimal",
];

function statusCopy(item: GeneratedMediaGalleryItem) {
	if (item.status === "queued") return "Queued";
	if (item.status === "running") return "Generating";
	if (item.status === "waiting") return "Waiting for provider";
	if (item.status === "reconciliation_required") {
		return "Provider outcome needs reconciliation";
	}
	if (item.status === "rejected") return "Couldn’t generate this prompt";
	if (item.status === "cancelled") return "Cancelled";
	if (item.status === "failed") return "Generation failed";
	if (item.asset) return "Ready to place";
	if (item.assetAvailability === "deleted") return "Deleted from the media library";
	if (item.assetAvailability === "missing") return "Generated asset is missing";
	if (item.assetAvailability === "storage_unavailable") {
		return "Storage is temporarily unavailable";
	}
	return "Finalizing asset";
}

function statusColor(item: GeneratedMediaGalleryItem) {
	if (item.status === "completed") return "studio.accent";
	if (item.status === "failed" || item.status === "rejected") return "danger.fg";
	return "studio.fgSubtle";
}

function ResultCard({
	item,
	basePlayheadSec,
	baseDurationSec,
	compositePlayheadSec,
	compositeDurationSec,
	selectedBrollPlacementId,
	activeBrandProfile,
	busyAction,
	onAction,
	onCancel,
	onDownload,
	onInsert,
	onSaveToBrand,
	onDelete,
}: {
	item: GeneratedMediaGalleryItem;
	basePlayheadSec: number;
	baseDurationSec: number;
	compositePlayheadSec: number;
	compositeDurationSec: number;
	busyAction: string | null;
	onAction: (
		key: string,
		action: () => Promise<void> | void,
	) => Promise<void>;
	onCancel: (jobId: string) => Promise<void>;
	onDownload: (jobId: string) => Promise<void> | void;
	onInsert: (intent: GeneratedMediaInsertionIntent) => Promise<void>;
	onSaveToBrand: (jobId: string) => Promise<void>;
	onDelete: (jobId: string) => Promise<void>;
	selectedBrollPlacementId: string | null;
	activeBrandProfile: { id: string; name: string } | null;
}) {
	const active = busyAction?.startsWith(`${item.id}:`) ?? false;
	const [confirmDelete, setConfirmDelete] = useState(false);
	return (
		<Box
			borderTopWidth="1px"
			borderBottomWidth="1px"
			borderColor="studio.border"
			borderLeftWidth="3px"
			borderLeftColor={statusColor(item)}
			py="3"
			ps="3"
		>
			<Flex align="center" gap="2" mb="3">
				<Box color="studio.fgMuted">
					{item.kind === "video" ? <Film size={14} /> : <ImageIcon size={14} />}
				</Box>
				<Box flex="1" minW="0">
					<Text fontSize="12px" color="studio.fg" fontWeight="600">
						{item.asset?.title ?? (item.kind === "video" ? "Generated video" : "Generated image")}
					</Text>
					<Text fontSize="10px" color="studio.fgSubtle" textStyle="data">
						{statusCopy(item)}
					</Text>
				</Box>
				{active && <Spinner size="xs" />}
			</Flex>

			{item.asset && (
				<Box layerStyle="well" overflow="hidden" mb="3" aspectRatio="16 / 10">
					{item.kind === "video" ? (
						<chakra.video
							src={item.asset.accessUrl}
							controls
							muted
							playsInline
							preload="metadata"
							w="full"
							h="full"
							objectFit="cover"
							aria-label={`Preview ${item.asset.title}`}
						/>
					) : (
						<Image
							src={item.asset.accessUrl}
							alt={item.asset.title}
							w="full"
							h="full"
							objectFit="cover"
						/>
					)}
				</Box>
			)}

			{item.asset ? (
				<Stack gap="2">
					<SimpleGrid columns={2} gap="2">
						<Button
							size="xs"
							variant="outline"
							disabled={active}
							onClick={() =>
								onAction(`${item.id}:broll`, () =>
									onInsert(
										buildGeneratedMediaInsertionIntent({
											action: "broll",
											asset: item.asset!,
											basePlayheadSec,
											baseDurationSec,
											compositePlayheadSec,
											compositeDurationSec,
										}),
									),
								)
							}
						>
							Insert at playhead
						</Button>
						<Button
							size="xs"
							variant="outline"
							disabled={active || !selectedBrollPlacementId}
							title={
								selectedBrollPlacementId
									? "Replace the selected bounded B-roll placement"
									: "Select a B-roll item on the timeline first"
							}
							onClick={() =>
								onAction(`${item.id}:replace`, () =>
									onInsert(
										buildGeneratedMediaInsertionIntent({
											action: "replace_broll",
											asset: item.asset!,
											basePlayheadSec,
											baseDurationSec,
											compositePlayheadSec,
											compositeDurationSec,
											selectedBrollPlacementId,
										}),
									),
								)
							}
						>
							Replace B-roll
						</Button>
					</SimpleGrid>
					<Button
						size="xs"
						variant="outline"
						disabled={active}
						onClick={() =>
							onAction(`${item.id}:scene`, () =>
								onInsert(
									buildGeneratedMediaInsertionIntent({
										action: "scene_block",
										asset: item.asset!,
									basePlayheadSec,
									baseDurationSec,
									compositePlayheadSec,
									compositeDurationSec,
									}),
								),
							)
						}
					>
						Add as scene
					</Button>
					<Flex gap="1" justify="space-between">
						<Button
							size="xs"
							variant="ghost"
							disabled={active || !activeBrandProfile || item.savedToActiveBrandProfile}
							title={item.savedToActiveBrandProfile
								? `Saved to ${activeBrandProfile?.name ?? "the active Brand Profile"}`
								: activeBrandProfile
									? `Save to ${activeBrandProfile.name}`
									: "Assign an active Brand Profile to this project first"}
							aria-label={item.savedToActiveBrandProfile
								? `${item.asset.title} saved to Brand Profile`
								: `Save ${item.asset.title} to Brand Profile`}
							onClick={() => onAction(`${item.id}:brand`, () => onSaveToBrand(item.id))}
						>
							{item.savedToActiveBrandProfile ? <Check size={13} /> : <Library size={13} />}
							{item.savedToActiveBrandProfile
								? `Saved to ${activeBrandProfile?.name ?? "brand"}`
								: "Save to brand"}
						</Button>
						<Button size="xs" variant="ghost" disabled={active} aria-label={`Download ${item.asset.title}`} onClick={() => onAction(`${item.id}:download`, () => onDownload(item.id))}><Download size={13} /></Button>
						<Button size="xs" variant="ghost" color="danger.fg" disabled={active} aria-label={`Delete ${item.asset.title}`} title="Delete from the media library" onClick={() => setConfirmDelete(true)}><Trash2 size={13} /></Button>
					</Flex>
					{confirmDelete && (
						<Box layerStyle="well" p="2">
							<Text fontSize="11px" color="studio.fgMuted" mb="2">
								Remove this result from the media library? Existing timeline placements stay available. Live Brand Profile or publishing use must be removed first.
							</Text>
							<Flex justify="flex-end" gap="2">
								<Button size="2xs" variant="ghost" onClick={() => setConfirmDelete(false)}>Keep asset</Button>
								<Button size="2xs" variant="outline" color="danger.fg" aria-label={`Confirm delete ${item.asset.title}`} onClick={() => void onAction(`${item.id}:delete`, () => onDelete(item.id)).then(() => setConfirmDelete(false))}>Delete asset</Button>
							</Flex>
						</Box>
					)}
				</Stack>
			) : (item.status === "queued" || item.status === "running" || item.status === "waiting") ? (
				<Button size="xs" variant="ghost" aria-label={`Cancel generation ${item.id}`} onClick={() => onCancel(item.id)}>
					<X size={13} /> Cancel
				</Button>
			) : item.status === "rejected" ? (
				<Text fontSize="11px" color="studio.fgMuted">
					Edit the prompt and try a different direction. Narriflow won’t rewrite a blocked prompt.
				</Text>
			) : null}
		</Box>
	);
}

export function GeneratedMediaPanel(props: GeneratedMediaPanelProps) {
	const sources = useMemo<readonly GeneratedMediaPromptSource[]>(
		() =>
			props.promptSources.length > 0
				? props.promptSources
				: [
						{
							id: "manual",
							label: "Manual prompt",
							origin: { kind: "manual", sourceIds: [] },
							prompt: "",
							derivedContext: null,
						},
					],
		[props.promptSources],
	);
	const [sourceId, setSourceId] = useState(sources[0]!.id);
	const source = sources.find((candidate) => candidate.id === sourceId) ?? sources[0]!;
	const [prompt, setPrompt] = useState(source.prompt);
	const [derivedContext, setDerivedContext] = useState(source.derivedContext);
	const [kind, setKind] = useState<GeneratedMediaKind>("image");
	const [aspectRatio, setAspectRatio] = useState<GeneratedMediaAspectRatio>("9:16");
	const [style, setStyle] = useState<GeneratedMediaStyle>("editorial");
	const [durationSec, setDurationSec] = useState(6);
	const [submitting, setSubmitting] = useState(false);
	const [busyAction, setBusyAction] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const submissionIdentity = useRef<GeneratedMediaSubmissionIdentity | null>(null);
	const configuredRatios =
		kind === "video"
			? props.supportedVideoRatios ?? ["9:16"]
			: props.supportedImageRatios ?? ["9:16", "1:1", "16:9"];
	const ratios =
		configuredRatios.length > 0 ? configuredRatios : (["9:16"] as const);
	const effectiveAspectRatio = ratios.includes(aspectRatio)
		? aspectRatio
		: ratios[0]!;
	const videoDurations =
		props.supportedVideoDurations && props.supportedVideoDurations.length > 0
			? props.supportedVideoDurations
			: [4, 6, 8];
	const effectiveDurationSec = videoDurations.includes(durationSec)
		? durationSec
		: videoDurations[0]!;
	const usage = props.usage?.[kind] ?? null;
	const usageAvailable =
		usage === null ||
		(usage.allowance.availableUnits > 0 && usage.dailyAbuse.availableUnits > 0);
	const kindAvailable = kind === "image" ? props.imageAvailable : props.videoAvailable;

	useEffect(() => {
		if (sources.some((candidate) => candidate.id === sourceId)) return;
		const next = sources[0];
		if (!next) return;
		setSourceId(next.id);
		setPrompt(next.prompt);
		setDerivedContext(next.derivedContext);
		submissionIdentity.current = null;
	}, [sourceId, sources]);

	function chooseSource(nextId: string) {
		const next = sources.find((candidate) => candidate.id === nextId);
		if (!next) return;
		setSourceId(next.id);
		setPrompt(next.prompt);
		setDerivedContext(next.derivedContext);
	}

	async function generate() {
		if (!prompt.trim() || !kindAvailable || !usageAvailable) return;
		const draft = {
			projectId: props.projectId,
			clipId: props.clipId,
			kind,
			prompt: prompt.trim(),
			includeDerivedContext: derivedContext !== null,
			promptOrigin: source.origin,
			aspectRatio: effectiveAspectRatio,
			style,
			durationSec: kind === "video" ? effectiveDurationSec : null,
			title: null,
		} satisfies Omit<GeneratedMediaStudioSubmitDraft, "idempotencyKey">;
		const signature = JSON.stringify(draft);
		submissionIdentity.current = resolveGeneratedMediaSubmissionIdentity({
			previous: submissionIdentity.current,
			signature,
			createIdempotencyKey: () => crypto.randomUUID(),
		});
		const { idempotencyKey } = submissionIdentity.current;
		setSubmitting(true);
		setError(null);
		try {
			await props.onGenerate({
				idempotencyKey,
				...draft,
			});
			submissionIdentity.current = null;
		} catch (failure) {
			setError(
				failure instanceof Error && failure.message === "generated_media_usage_exhausted"
					? "No generation units are available for this workspace right now."
					: failure instanceof Error &&
						failure.message === "generated_media_prompt_source_revision_conflict"
						? "Studio changed before the transcript context was captured. Review the selection, then generate again."
						: "Generation couldn’t be confirmed. Retry safely with this prompt.",
			);
			return;
		} finally {
			setSubmitting(false);
		}
		try {
			await props.onRefresh();
		} catch {
			setError("Generation started. Refresh results to see its progress.");
		}
	}

	async function runAction(
		key: string,
		operation: () => Promise<void> | void,
		after?: () => Promise<void> | void,
	) {
		setBusyAction(key);
		setError(null);
		try {
			await operation();
			await after?.();
		} catch (failure) {
			setError(
				failure instanceof Error && failure.message === "generated_media_asset_in_use"
					? "This asset is still used by a Brand Profile, Scene Template, or scheduled post. Remove that live use, then try again."
					: "That action didn’t finish. The generated asset is unchanged.",
			);
		} finally {
			setBusyAction(null);
		}
	}

	return (
		<Stack gap="5" px="4" py="4">
			<Box>
				<Flex align="baseline" justify="space-between" mb="2">
					<Text textStyle="eyebrow" color="studio.fgMuted">Generate visual</Text>
					<Text textStyle="data" fontSize="10px" color="studio.timecode">No automatic placement</Text>
				</Flex>
				<Flex borderTopWidth="1px" borderBottomWidth="1px" borderColor="studio.border">
					<Button flex="1" size="xs" borderRadius="0" variant="ghost" aria-pressed={kind === "image"} bg={kind === "image" ? "studio.raised" : "transparent"} color={kind === "image" ? "studio.accentFg" : "studio.fgMuted"} disabled={!props.imageAvailable} title={props.imageAvailable ? undefined : "Image generation is not enabled for this workspace"} onClick={() => props.imageAvailable && setKind("image")}><ImageIcon size={13} /> {props.imageAvailable ? "Still" : "Still gated"}</Button>
					<Button flex="1" size="xs" borderRadius="0" variant="ghost" aria-pressed={kind === "video"} bg={kind === "video" ? "studio.raised" : "transparent"} color={kind === "video" ? "studio.accentFg" : "studio.fgMuted"} disabled={!props.videoAvailable} title={props.videoAvailable ? undefined : "Video generation is not enabled for this workspace"} onClick={() => props.videoAvailable && setKind("video")}><Film size={13} /> {props.videoAvailable ? "Video" : "Video gated"}</Button>
				</Flex>
			</Box>

			<Stack gap="2">
				<Text as="label" textStyle="eyebrow" color="studio.fgSubtle">Prompt source</Text>
				<NativeSelect.Root size="sm">
					<NativeSelect.Field aria-label="Prompt source" value={sourceId} onChange={(event) => chooseSource(event.currentTarget.value)}>
						{sources.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
					</NativeSelect.Field>
					<NativeSelect.Indicator />
				</NativeSelect.Root>
			</Stack>

			{source.notice && (
				<Flex
					role="status"
					gap="2"
					align="flex-start"
					borderLeftWidth="3px"
					borderLeftColor="studio.accent"
					bg="studio.raised"
					px="3"
					py="2"
					color="studio.fgMuted"
				>
					<Box mt="0.5" color="studio.accentFg"><AlertTriangle size={12} /></Box>
					<Text fontSize="11px" lineHeight="1.45">{source.notice}</Text>
				</Flex>
			)}

			{derivedContext && (
				<Box layerStyle="well" p="3">
					<Flex justify="space-between" gap="3" mb="1">
						<Text textStyle="eyebrow" color="studio.fgSubtle">Transcript context</Text>
						<Button size="2xs" variant="ghost" onClick={() => setDerivedContext(null)}><X size={11} /> Remove context</Button>
					</Flex>
					<Text fontSize="11px" lineHeight="1.5" color="studio.fgMuted" lineClamp={4}>{derivedContext}</Text>
				</Box>
			)}

			<Stack gap="2">
				<Text as="label" textStyle="eyebrow" color="studio.fgSubtle">Editable prompt</Text>
				<Textarea aria-label="Generation prompt" value={prompt} onChange={(event) => setPrompt(event.currentTarget.value.slice(0, 4_000))} minH="112px" resize="vertical" borderColor="studio.border" />
				<Flex justify="space-between"><Text fontSize="10px" color="studio.fgSubtle">Describe subject, setting, framing, and light.</Text><Text textStyle="data" fontSize="10px" color="studio.timecode">{prompt.length}/4000</Text></Flex>
			</Stack>

			<SimpleGrid columns={kind === "video" ? 3 : 2} gap="2">
				<Stack gap="1">
					<Text as="label" textStyle="eyebrow" color="studio.fgSubtle">Format</Text>
					<NativeSelect.Root size="xs"><NativeSelect.Field aria-label="Generated media format" value={effectiveAspectRatio} onChange={(event) => setAspectRatio(event.currentTarget.value as GeneratedMediaAspectRatio)}>{ratios.map((ratio) => <option key={ratio} value={ratio}>{ratio}</option>)}</NativeSelect.Field><NativeSelect.Indicator /></NativeSelect.Root>
				</Stack>
				<Stack gap="1">
					<Text as="label" textStyle="eyebrow" color="studio.fgSubtle">Direction</Text>
					<NativeSelect.Root size="xs"><NativeSelect.Field aria-label="Generated media style" value={style} onChange={(event) => setStyle(event.currentTarget.value as GeneratedMediaStyle)}>{styles.map((value) => <option key={value} value={value}>{value}</option>)}</NativeSelect.Field><NativeSelect.Indicator /></NativeSelect.Root>
				</Stack>
				{kind === "video" && <Stack gap="1"><Text as="label" textStyle="eyebrow" color="studio.fgSubtle">Length</Text><NativeSelect.Root size="xs"><NativeSelect.Field aria-label="Generated video duration" value={effectiveDurationSec} onChange={(event) => setDurationSec(Number(event.currentTarget.value))}>{videoDurations.map((value) => <option key={value} value={value}>{value}s</option>)}</NativeSelect.Field><NativeSelect.Indicator /></NativeSelect.Root></Stack>}
			</SimpleGrid>

			<Button variant="solid" colorPalette="accent" disabled={!prompt.trim() || submitting || !kindAvailable || !usageAvailable} onClick={generate}>
				{submitting ? <Spinner size="xs" /> : <Sparkles size={15} />} Generate {kind}
			</Button>
			{usage && (
				<Text textStyle="data" fontSize="10px" color={usageAvailable ? "studio.timecode" : "danger.fg"}>
					{usageAvailable
						? `${Math.min(usage.allowance.availableUnits, usage.dailyAbuse.availableUnits)} units available`
						: "Generation allowance exhausted"}
				</Text>
			)}
			{error && <Text role="alert" fontSize="11px" color="danger.fg">{error}</Text>}

			<Box aria-live="polite">
				<Flex align="center" justify="space-between" mb="2">
					<Text textStyle="eyebrow" color="studio.fgMuted">Results · {props.jobs.length}</Text>
					<Button size="xs" variant="ghost" aria-label="Refresh generated media results" onClick={() => props.onRefresh()}><RefreshCw size={12} /> Refresh</Button>
				</Flex>
				{props.jobs.length === 0 ? (
					<Box layerStyle="well" p="4"><Text fontSize="12px" color="studio.fgMuted">Generated results stay here when you close Studio. Nothing is placed until you choose an action.</Text></Box>
				) : (
					<Stack gap="3">
						{props.jobs.map((item) => (
							<ResultCard
								key={item.id}
								item={item}
								basePlayheadSec={props.basePlayheadSec}
								baseDurationSec={props.baseDurationSec}
								compositePlayheadSec={props.compositePlayheadSec}
								compositeDurationSec={props.compositeDurationSec}
								selectedBrollPlacementId={props.selectedBrollPlacementId}
								activeBrandProfile={props.activeBrandProfile}
								busyAction={busyAction}
								onCancel={(jobId) => runAction(`${jobId}:cancel`, () => props.onCancel(jobId), props.onRefresh)}
								onDownload={props.onDownload}
								onInsert={props.onInsert}
								onSaveToBrand={props.onSaveToBrand}
								onDelete={props.onDelete}
								onAction={(key, operation) => runAction(key, operation, key.endsWith(":download") ? undefined : props.onRefresh)}
							/>
						))}
					</Stack>
				)}
			</Box>
		</Stack>
	);
}

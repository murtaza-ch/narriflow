"use client";
import { usePublishing } from "./publishing-provider";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import type {
	ClipAspectRatio,
	ClipPlatformTarget,
	ClipSnapshot,
} from "@narriflow/validators";
import {
	Box,
	Flex,
	Grid,
	Popover,
	Portal,
	Stack,
	Text,
	VisuallyHidden,
} from "@chakra-ui/react";
import { Button, IconButton } from "@narriflow/ui/components/button";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import { Select } from "@narriflow/ui/components/select";
import { Checkbox } from "@narriflow/ui/components/checkbox";
import { SegmentedControl } from "@narriflow/ui/components/segmented-control";
import { Filter, LayoutGrid, PanelsTopLeft } from "lucide-react";
import { computeClipRanks } from "@/lib/project-state";
import { ClipRow } from "./clip-row";
import { CampaignCommandBar } from "./campaign-command-bar";
import {
	deriveCampaignCommandState,
	type CampaignActionAvailability,
} from "./campaign-command-state";
import {
	clearCampaignSelection,
	persistCampaignSelection,
	restoreCampaignSelection,
} from "./campaign-selection";

const durationItems = [
	{ value: "all", label: "All durations" },
	{ value: "preferred", label: "30–60s" },
	{ value: "short", label: "Under 30s" },
	{ value: "long", label: "Over 60s" },
];

const scoreItems = [
	{ value: "all", label: "All scores" },
	{ value: "high", label: "85+" },
	{ value: "review", label: "Below 85" },
];

const platformItems = [
	{ value: "all", label: "All platforms" },
	{ value: "tiktok", label: "TikTok" },
	{ value: "youtube_shorts", label: "YouTube Shorts" },
	{ value: "instagram_reels", label: "Instagram Reels" },
];

const sortItems = [
	{ value: "virality", label: "Virality" },
	{ value: "hook", label: "Hook strength" },
	{ value: "duration", label: "Duration" },
	{ value: "timeline", label: "Timeline order" },
];

type SortKey = "virality" | "hook" | "duration" | "timeline";

function sortClips(clips: ClipSnapshot[], sort: SortKey): ClipSnapshot[] {
	const sorted = [...clips];
	switch (sort) {
		case "hook":
			sorted.sort(
				(a, b) =>
					b.hookStrengthScore - a.hookStrengthScore || a.index - b.index,
			);
			break;
		case "duration":
			sorted.sort((a, b) => b.durationSec - a.durationSec || a.index - b.index);
			break;
		case "timeline":
			sorted.sort((a, b) => a.index - b.index);
			break;
		default:
			sorted.sort(
				(a, b) => b.viralityScore - a.viralityScore || a.index - b.index,
			);
	}
	return sorted;
}

export function ClipsPanel({
	clips,
	projectId,
	mode,
	isFreeTier,
	can1080pExport,
	defaultAspectRatio,
	sourceVideoUrl,
	actionAvailability,
	campaignOperationsEnabled = false,
}: {
	clips: ClipSnapshot[];
	projectId: string;
	/** Presigned source video for the Trim/Extend preview pane; null once the
	 *  source is purged (the dialog degrades to transcript-only). */
	sourceVideoUrl: string | null;
	/** Caption-only mode renders exactly one pseudo-clip with no rank, score,
	 *  or "why this clip" framing — a fundamentally different, simpler view. */
	mode: "clip" | "caption_only";
	isFreeTier: boolean;
	/** vizard-parity Phase C export options — whether the owner's plan can
	 *  render at 1080p (billing.service's hasFeature(tier, "export.1080p")),
	 *  computed server-side. Gates the "Render selected" popover's resolution
	 *  picker. */
	can1080pExport: boolean;
	/** The committed content pack's `defaultAspectRatio` — preselects the
	 *  bulk "Render selected" popover with this format instead of always
	 *  defaulting to 9:16. Caption-only always renders 16:9 regardless of
	 *  this value (see the RenderClipsButton call below). */
	defaultAspectRatio: ClipAspectRatio;
	actionAvailability: CampaignActionAvailability;
	campaignOperationsEnabled?: boolean;
}) {
	const [categoryFilter, setCategoryFilter] = useState("all");
	const [durationFilter, setDurationFilter] = useState("all");
	const [platformFilter, setPlatformFilter] = useState("all");
	const [scoreFilter, setScoreFilter] = useState("all");
	const [sort, setSort] = useState<SortKey>("virality");
	const pathname = usePathname();
	const searchParams = useSearchParams();
	const view = searchParams.get("view") === "desk" ? "desk" : "gallery";

	function changeView(value: string) {
		const params = new URLSearchParams(searchParams.toString());
		params.set("view", value === "gallery" ? "gallery" : "desk");
		window.history.pushState(null, "", `${pathname}?${params}`);
	}
	const publishing = usePublishing();
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
	const [selectionRestored, setSelectionRestored] = useState(false);
	const [activeRailId, setActiveRailId] = useState<string | null>(null);
	const rowRefs = useRef(new Map<string, HTMLDivElement>());
	const availableClipIdsKey = useMemo(
		() =>
			clips
				.map((clip) => clip.id)
				.sort()
				.join(","),
		[clips],
	);

	useEffect(() => {
		setSelectionRestored(false);
		setSelectedIds(
			restoreCampaignSelection(
				window.sessionStorage,
				projectId,
				availableClipIdsKey ? availableClipIdsKey.split(",") : [],
			),
		);
		setSelectionRestored(true);
	}, [availableClipIdsKey, projectId]);

	useEffect(() => {
		if (!selectionRestored) return;
		persistCampaignSelection(window.sessionStorage, projectId, selectedIds);
	}, [projectId, selectedIds, selectionRestored]);

	// Immutable virality rank — the clip's position in [viralityScore desc,
	// index asc] ordering, computed ONCE from the full, unfiltered clip list.
	// Never re-derive this from a sorted/filtered array position: that
	// renumbers on every toolbar interaction.
	// NOTE: this reads `clips` in full, so rank is only stable as long as the
	// full clip list is loaded client-side. If clips ever paginate, this must
	// move server-side (rank computed once over the full ordered set and
	// returned per-clip) — recomputing per-page here would renumber on every
	// page load.
	const ranks = useMemo(() => computeClipRanks(clips), [clips]);

	const categories = useMemo(
		() => [...new Set(clips.map((clip) => clip.category))].sort(),
		[clips],
	);
	const categoryItems = useMemo(
		() => [
			{ value: "all", label: "All categories" },
			...categories.map((category) => ({ value: category, label: category })),
		],
		[categories],
	);

	const filteredClips = useMemo(
		() =>
			clips.filter((clip) => {
				if (categoryFilter !== "all" && clip.category !== categoryFilter)
					return false;
				if (
					platformFilter !== "all" &&
					!clip.platformFit.includes(platformFilter as ClipPlatformTarget)
				) {
					return false;
				}
				if (
					durationFilter === "preferred" &&
					(clip.durationSec < 30 || clip.durationSec > 60)
				) {
					return false;
				}
				if (durationFilter === "short" && clip.durationSec >= 30) return false;
				if (durationFilter === "long" && clip.durationSec <= 60) return false;
				if (scoreFilter === "high" && clip.viralityScore < 85) return false;
				if (scoreFilter === "review" && clip.viralityScore >= 85) return false;
				return true;
			}),
		[categoryFilter, clips, durationFilter, platformFilter, scoreFilter],
	);

	const sortedClips = useMemo(
		() => sortClips(filteredClips, sort),
		[filteredClips, sort],
	);
	const campaignState = useMemo(
		() =>
			deriveCampaignCommandState({
				clips,
				selectedIds,
				defaultAspectRatio,
				actionAvailability,
			}),
		[actionAvailability, clips, defaultAspectRatio, selectedIds],
	);

	const hasActiveFilters =
		categoryFilter !== "all" ||
		durationFilter !== "all" ||
		platformFilter !== "all" ||
		scoreFilter !== "all";
	const activeFilterCount = [
		categoryFilter,
		durationFilter,
		platformFilter,
		scoreFilter,
	].filter((v) => v !== "all").length;

	function clearFilters() {
		setCategoryFilter("all");
		setDurationFilter("all");
		setPlatformFilter("all");
		setScoreFilter("all");
	}

	function toggleSelect(clipId: string, selected: boolean) {
		setSelectedIds((current) => {
			const next = new Set(current);
			if (selected) next.add(clipId);
			else next.delete(clipId);
			return next;
		});
	}

	const allVisibleSelected =
		sortedClips.length > 0 &&
		sortedClips.every((clip) => selectedIds.has(clip.id));

	function toggleSelectAll(selected: boolean) {
		setSelectedIds((current) => {
			const next = new Set(current);
			for (const clip of sortedClips) {
				if (selected) next.add(clip.id);
				else next.delete(clip.id);
			}
			return next;
		});
	}

	function clearSelection() {
		clearCampaignSelection(window.sessionStorage);
		setSelectedIds(new Set());
	}

	// Scrollspy for the left jump rail — highlights the row nearest the top
	// of the viewport as the user scrolls.
	useEffect(() => {
		if (mode === "caption_only") return;
		const rows = sortedClips.flatMap((clip) => {
			const element = rowRefs.current.get(clip.id);
			return element ? [[clip.id, element] as const] : [];
		});
		if (rows.length === 0) return;

		let frame = 0;
		function updateActiveClip() {
			frame = 0;
			const anchor = Math.max(100, window.innerHeight * 0.25);
			const current =
				rows.find(
					([, element]) => element.getBoundingClientRect().bottom > anchor,
				) ?? rows.at(-1);
			setActiveRailId(current?.[0] ?? null);
		}
		function scheduleUpdate() {
			if (!frame) frame = window.requestAnimationFrame(updateActiveClip);
		}
		updateActiveClip();
		window.addEventListener("scroll", scheduleUpdate, { passive: true });
		window.addEventListener("resize", scheduleUpdate);
		return () => {
			window.cancelAnimationFrame(frame);
			window.removeEventListener("scroll", scheduleUpdate);
			window.removeEventListener("resize", scheduleUpdate);
		};
	}, [mode, sortedClips]);

	if (clips.length === 0) {
		return null;
	}

	// Caption-only: exactly one pseudo-clip, no rank/score/toolbar/rail.
	if (mode === "caption_only") {
		const clip = clips[0]!;
		return (
			<Box>
				<Text textStyle="eyebrow" color="fg.subtle" mb="2">
					Captioned Video
				</Text>
				<Box layerStyle="band">
					<ClipRow
						clip={clip}
						projectId={projectId}
						rank={null}
						compact={false}
						selected={false}
						onToggleSelect={() => {}}
						sourceVideoUrl={sourceVideoUrl}
					/>
				</Box>
			</Box>
		);
	}

	return (
		<Box>
			<Box>
				{/* Toolbar */}
				<Flex
					align="center"
					justify="space-between"
					gap="3"
					wrap="wrap"
					pb="3"
					mb="1"
				>
					<Flex align="center" gap="3" wrap="wrap">
						<SegmentedControl
							items={[
								{
									value: "gallery",
									label: (
										<span title="Gallery">
											<LayoutGrid size={16} aria-hidden="true" />
											<VisuallyHidden>Gallery</VisuallyHidden>
										</span>
									),
								},
								{
									value: "desk",
									label: (
										<span title="Review desk">
											<PanelsTopLeft size={16} aria-hidden="true" />
											<VisuallyHidden>Review desk</VisuallyHidden>
										</span>
									),
								},
							]}
							value={view}
							onValueChange={changeView}
							aria-label="Clip layout"
							size="sm"
						/>
						<Box w="152px">
							<Select
								items={sortItems}
								value={sort}
								onValueChange={(v) => setSort(v as SortKey)}
								size="sm"
								aria-label="Sort clips"
							/>
						</Box>
						<Popover.Root positioning={{ placement: "bottom-start" }}>
							<Popover.Trigger asChild>
								<IconButton
									size="sm"
									variant="outline"
									aria-label={
										activeFilterCount > 0
											? `Filters (${activeFilterCount} active)`
											: "Filters"
									}
									title="Filters"
									color="fg.muted"
									_hover={{ bg: "bg.muted", color: "fg" }}
								>
									<Filter size={16} aria-hidden="true" />
								</IconButton>
							</Popover.Trigger>
							<Portal>
								<Popover.Positioner>
									<Popover.Content minW="260px" p="3">
										<Stack gap="2.5">
											<Text textStyle="eyebrow" color="fg.subtle">
												Filters
											</Text>
											<Select
												items={categoryItems}
												value={categoryFilter}
												onValueChange={setCategoryFilter}
												size="sm"
												aria-label="Filter by category"
											/>
											<Select
												items={durationItems}
												value={durationFilter}
												onValueChange={setDurationFilter}
												size="sm"
												aria-label="Filter by duration"
											/>
											<Select
												items={scoreItems}
												value={scoreFilter}
												onValueChange={setScoreFilter}
												size="sm"
												aria-label="Filter by score"
											/>
											<Select
												items={platformItems}
												value={platformFilter}
												onValueChange={setPlatformFilter}
												size="sm"
												aria-label="Filter by platform"
											/>
											{hasActiveFilters && (
												<Button
													variant="ghost"
													size="sm"
													onClick={clearFilters}
													alignSelf="flex-start"
												>
													Clear filters
												</Button>
											)}
										</Stack>
									</Popover.Content>
								</Popover.Positioner>
							</Portal>
						</Popover.Root>
					</Flex>

					{/* Selection is project-scoped and the command bar owns the view's
              one solid, state-aware campaign action. */}
					<Flex align="center" gap="2" flexShrink={0}>
						<Checkbox
							checked={allVisibleSelected}
							onCheckedChange={(checked) => toggleSelectAll(checked)}
							aria-label="Select all visible clips"
						>
							<Text fontSize="12px" color="fg.muted">
								{selectedIds.size > 0
									? `${selectedIds.size} selected`
									: "Select all"}
							</Text>
						</Checkbox>
						{selectedIds.size > 0 && (
							<Button
								size="sm"
								variant="outline"
								disabled={!publishing.config.canPublish}
								onClick={() =>
									publishing.compose(
										sortedClips
											.filter((clip) => selectedIds.has(clip.id))
											.map((clip) => clip.id),
									)
								}
							>
								Publish selected
							</Button>
						)}
						<CampaignCommandBar
							projectId={projectId}
							state={campaignState}
							defaultAspectRatio={defaultAspectRatio}
							isFreeTier={isFreeTier}
							can1080pExport={can1080pExport}
							campaignOperationsEnabled={campaignOperationsEnabled}
							onClear={clearSelection}
						/>
					</Flex>
				</Flex>

				{filteredClips.length === 0 ? (
					<EmptyState
						icon={<Filter size={24} />}
						title="No clips match your filters"
						description="Try a different duration, score, or category."
						action={
							hasActiveFilters ? (
								<Button variant="outline" size="sm" onClick={clearFilters}>
									Clear filters
								</Button>
							) : undefined
						}
					/>
				) : (
					<Grid
						data-clips-layout
						templateColumns={{ base: "1fr", xl: "210px minmax(0, 1fr)" }}
						gap="6"
						alignItems="start"
						pt="3"
					>
						{/* Left jump rail — ≥xl only */}
						<Box
							data-clip-index
							display={{ base: "none", xl: "block" }}
							position="sticky"
							top="20"
							alignSelf="flex-start"
						>
							<Text fontSize="10px" color="fg.subtle" mb="3" px="2">
								In this project · {sortedClips.length}
							</Text>
							<Stack gap="2" maxH="calc(100vh - 160px)" overflowY="auto">
								{sortedClips.map((clip) => {
									const rank = ranks.get(clip.id) ?? 0;
									const isActive = activeRailId === clip.id;
									return (
										<Box
											key={clip.id}
											as="button"
											onClick={() => {
												rowRefs.current.get(clip.id)?.scrollIntoView({
													behavior: "smooth",
													block: "start",
												});
											}}
											display="flex"
											alignItems="center"
											gap="2"
											minH="48px"
											p="2"
											borderRadius="l2"
											bg={isActive ? "bg.muted" : "transparent"}
											w="full"
											cursor="pointer"
											aria-label={`Jump to clip ${rank}`}
											aria-current={isActive ? "true" : undefined}
											_hover={{ bg: "bg.muted" }}
										>
											<Text
												textStyle="data"
												fontSize="11px"
												fontWeight={isActive ? "600" : "500"}
												color={isActive ? "accent.fg" : "fg.subtle"}
												transition="color 120ms ease"
											>
												{rank}
											</Text>
											<Text
												fontSize="xs"
												color={isActive ? "fg" : "fg.muted"}
												lineClamp={2}
												textAlign="left"
											>
												{clip.title || clip.hookText}
											</Text>
										</Box>
									);
								})}
							</Stack>
						</Box>

						{/* Ranked clip cards. */}
						<Stack data-clip-list gap="0">
							{sortedClips.map((clip) => (
								<Box
									key={clip.id}
									data-clip-id={clip.id}
									scrollMarginTop="20"
									ref={(el: HTMLDivElement | null) => {
										if (el) rowRefs.current.set(clip.id, el);
										else rowRefs.current.delete(clip.id);
									}}
								>
									<ClipRow
										clip={clip}
										projectId={projectId}
										rank={ranks.get(clip.id) ?? null}
										compact={false}
										selected={selectedIds.has(clip.id)}
										onToggleSelect={toggleSelect}
										sourceVideoUrl={sourceVideoUrl}
									/>
								</Box>
							))}
						</Stack>
					</Grid>
				)}
			</Box>
		</Box>
	);
}

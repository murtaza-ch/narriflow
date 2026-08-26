"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ClipAspectRatio,
  ClipPlatformTarget,
  ClipSnapshot,
} from "@narriflow/validators";
import { Box, Flex, Grid, Popover, Portal, Stack, Text } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import { GhostFrame } from "@narriflow/ui/components/ghost-frame";
import { Select } from "@narriflow/ui/components/select";
import { Checkbox } from "@narriflow/ui/components/checkbox";
import { SegmentedControl } from "@narriflow/ui/components/segmented-control";
import { Filter } from "lucide-react";
import { computeClipRanks } from "@/lib/project-state";
import { ClipRow } from "./clip-row";
import { RenderClipsButton } from "./render-clips-button";

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
      sorted.sort((a, b) => b.hookStrengthScore - a.hookStrengthScore || a.index - b.index);
      break;
    case "duration":
      sorted.sort((a, b) => b.durationSec - a.durationSec || a.index - b.index);
      break;
    case "timeline":
      sorted.sort((a, b) => a.index - b.index);
      break;
    default:
      sorted.sort((a, b) => b.viralityScore - a.viralityScore || a.index - b.index);
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
}) {
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [durationFilter, setDurationFilter] = useState("all");
  const [platformFilter, setPlatformFilter] = useState("all");
  const [scoreFilter, setScoreFilter] = useState("all");
  const [sort, setSort] = useState<SortKey>("virality");
  const [density, setDensity] = useState<"comfortable" | "compact">("compact");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [activeRailId, setActiveRailId] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

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
        if (categoryFilter !== "all" && clip.category !== categoryFilter) return false;
        if (
          platformFilter !== "all" &&
          !clip.platformFit.includes(platformFilter as ClipPlatformTarget)
        ) {
          return false;
        }
        if (durationFilter === "preferred" && (clip.durationSec < 30 || clip.durationSec > 60)) {
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

  const sortedClips = useMemo(() => sortClips(filteredClips, sort), [filteredClips, sort]);

  const hasActiveFilters =
    categoryFilter !== "all" ||
    durationFilter !== "all" ||
    platformFilter !== "all" ||
    scoreFilter !== "all";
  const activeFilterCount = [categoryFilter, durationFilter, platformFilter, scoreFilter].filter(
    (v) => v !== "all",
  ).length;

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
    sortedClips.length > 0 && sortedClips.every((clip) => selectedIds.has(clip.id));

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

  // Scrollspy for the left jump rail — highlights the row nearest the top
  // of the viewport as the user scrolls.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sortedClips intentionally rebuilds observation for the rendered row set.
  useEffect(() => {
    if (mode === "caption_only") return;
    const rows = [...rowRefs.current.entries()];
    if (rows.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible.length > 0) {
          setActiveRailId(visible[0]!.target.getAttribute("data-clip-id"));
        }
      },
      { rootMargin: "-15% 0px -70% 0px", threshold: 0 },
    );

    for (const [, el] of rows) observer.observe(el);
    return () => observer.disconnect();
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
      <Text textStyle="eyebrow" color="fg.subtle" mb="2">
        AI Clips
      </Text>
      <Box layerStyle="band">
        {/* Toolbar */}
        <Flex align="center" justify="space-between" gap="3" wrap="wrap" pb="3" mb="1" borderBottomWidth="1px" borderColor="border.subtle">
          <Flex align="center" gap="3" wrap="wrap">
            <Text textStyle="data" fontSize="12px" color="fg.subtle">
              {clips.length} clip{clips.length === 1 ? "" : "s"}
            </Text>
            <Box w="152px">
              <Select
                items={sortItems}
                value={sort}
                onValueChange={(v) => setSort(v as SortKey)}
                size="sm"
                aria-label="Sort clips"
              />
            </Box>
            <SegmentedControl
              items={[
                { value: "compact", label: "Compact" },
                { value: "comfortable", label: "Comfortable" },
              ]}
              value={density}
              onValueChange={(v) => setDensity(v as "compact" | "comfortable")}
              size="sm"
            />
            <Popover.Root positioning={{ placement: "bottom-start" }}>
              <Popover.Trigger asChild>
                <Button size="sm" variant="outline">
                  <Filter size={12} />
                  <Text ms="1">Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}</Text>
                </Button>
              </Popover.Trigger>
              <Portal>
                <Popover.Positioner>
                  <Popover.Content layerStyle="panel" boxShadow="cardHover" minW="260px" p="3">
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
                        <Button variant="ghost" size="xs" onClick={clearFilters} alignSelf="flex-start">
                          Clear filters
                        </Button>
                      )}
                    </Stack>
                  </Popover.Content>
                </Popover.Positioner>
              </Portal>
            </Popover.Root>
          </Flex>

          {/* Bulk selection — the only bulk action is Render selected. The
              view's single solid ultramarine button. */}
          <Flex align="center" gap="2" flexShrink={0}>
            <Checkbox
              checked={allVisibleSelected}
              onCheckedChange={(checked) => toggleSelectAll(checked)}
              aria-label="Select all visible clips"
            >
              <Text fontSize="12px" color="fg.muted">
                {selectedIds.size > 0 ? `${selectedIds.size} selected` : "Select all"}
              </Text>
            </Checkbox>
            {/* Always the "clip" mode's default — caption-only returns its
                own, bulk-toolbar-free view above (`mode === "caption_only"`
                early return) and never reaches this button, so its
                mandatory 16:9 render is untouched by this preselect. */}
            <RenderClipsButton
              projectId={projectId}
              disabled={selectedIds.size === 0}
              buttonLabel={`Render selected${selectedIds.size > 0 ? ` (${selectedIds.size})` : ""}`}
              isFreeTier={isFreeTier}
              can1080pExport={can1080pExport}
              clipIds={[...selectedIds]}
              size="sm"
              defaultAspectRatio={defaultAspectRatio}
            />
          </Flex>
        </Flex>

        {filteredClips.length === 0 ? (
          <Flex direction="column" align="center" gap="4" py="10">
            <GhostFrame ratio={9 / 16} size="72px" />
            <Text fontSize="sm" color="fg.muted">
              No clips match these filters.
            </Text>
            {hasActiveFilters && (
              <Button variant="outline" size="xs" onClick={clearFilters}>
                Clear filters
              </Button>
            )}
          </Flex>
        ) : (
          <Grid templateColumns={{ base: "1fr", xl: "44px 1fr" }} gap="4" alignItems="start" pt="3">
            {/* Left jump rail — ≥xl only */}
            <Box
              display={{ base: "none", xl: "block" }}
              position="sticky"
              top="4"
              alignSelf="flex-start"
            >
              {/* Drawn index, not floating chips: a hairline rule with a 3px
                  tick per clip, echoing the status stripe on the rows it
                  points at. The old 36px bordered boxes read as a detached
                  column of buttons — ten of them stacked 414px tall against
                  2690px of rows, which is a lot of chrome for a jump nav. */}
              <Stack
                gap="0"
                maxH="calc(100vh - 160px)"
                overflowY="auto"
                borderInlineStartWidth="1px"
                borderColor="border.subtle"
              >
                {sortedClips.map((clip) => {
                  const rank = ranks.get(clip.id) ?? 0;
                  const isActive = activeRailId === clip.id;
                  return (
                    <Box
                      key={clip.id}
                      as="button"
                      onClick={() => {
                        rowRefs.current.get(clip.id)?.scrollIntoView({ behavior: "smooth", block: "center" });
                      }}
                      display="flex"
                      alignItems="center"
                      gap="2"
                      h="30px"
                      w="full"
                      cursor="pointer"
                      aria-label={`Jump to clip ${rank}`}
                      aria-current={isActive ? "true" : undefined}
                      _hover={{ "& > [data-tick]": { bg: "border.emphasized" } }}
                    >
                      <Box
                        data-tick
                        w="3px"
                        h="14px"
                        flexShrink={0}
                        bg={isActive ? "accent.solid" : "border"}
                        transition="background 120ms ease"
                      />
                      <Text
                        textStyle="data"
                        fontSize="11px"
                        fontWeight={isActive ? "600" : "500"}
                        color={isActive ? "accent.fg" : "fg.subtle"}
                        transition="color 120ms ease"
                      >
                        {rank}
                      </Text>
                    </Box>
                  );
                })}
              </Stack>
            </Box>

            {/* Ranked rows — hairline separators + 3px status stripe */}
            <Stack gap="0" borderTopWidth="1px" borderColor="border.subtle">
              {sortedClips.map((clip) => (
                <Box
                  key={clip.id}
                  data-clip-id={clip.id}
                  ref={(el: HTMLDivElement | null) => {
                    if (el) rowRefs.current.set(clip.id, el);
                    else rowRefs.current.delete(clip.id);
                  }}
                >
                  <ClipRow
                    clip={clip}
                    projectId={projectId}
                    rank={ranks.get(clip.id) ?? null}
                    compact={density === "compact"}
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

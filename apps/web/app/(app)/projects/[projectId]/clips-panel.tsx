"use client";

import { useMemo, useState } from "react";
import type { ClipPlatformTarget, ClipSnapshot } from "@narriflow/validators";
import { Box, Flex, Grid, Text } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import { GhostFrame } from "@narriflow/ui/components/ghost-frame";
import { Select } from "@narriflow/ui/components/select";
import { ClipCard } from "./clip-card";

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

export function ClipsPanel({
  clips,
  sourceVideoUrl,
  sourceType,
}: {
  clips: ClipSnapshot[];
  sourceVideoUrl: string | null;
  sourceType: "upload" | "youtube" | "rss" | "link";
}) {
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [durationFilter, setDurationFilter] = useState("all");
  const [platformFilter, setPlatformFilter] = useState("all");
  const [scoreFilter, setScoreFilter] = useState("all");
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
        if (categoryFilter !== "all" && clip.category !== categoryFilter) {
          return false;
        }

        if (
          platformFilter !== "all" &&
          !clip.platformFit.includes(platformFilter as ClipPlatformTarget)
        ) {
          return false;
        }

        if (durationFilter === "preferred" && (clip.durationSec < 30 || clip.durationSec > 60)) {
          return false;
        }

        if (durationFilter === "short" && clip.durationSec >= 30) {
          return false;
        }

        if (durationFilter === "long" && clip.durationSec <= 60) {
          return false;
        }

        if (scoreFilter === "high" && clip.viralityScore < 85) {
          return false;
        }

        if (scoreFilter === "review" && clip.viralityScore >= 85) {
          return false;
        }

        return true;
      }),
    [categoryFilter, clips, durationFilter, platformFilter, scoreFilter],
  );
  const acceptedCount = clips.filter((c) => c.status === "accepted").length;
  const renderedCount = clips.filter(
    (c) => c.renderVariants.some((render) => render.hasAsset),
  ).length;
  const averageDuration =
    clips.length > 0
      ? clips.reduce((sum, clip) => sum + clip.durationSec, 0) / clips.length
      : 0;
  const hasActiveFilters =
    categoryFilter !== "all" ||
    durationFilter !== "all" ||
    platformFilter !== "all" ||
    scoreFilter !== "all";

  if (clips.length === 0) {
    return null;
  }

  function clearFilters() {
    setCategoryFilter("all");
    setDurationFilter("all");
    setPlatformFilter("all");
    setScoreFilter("all");
  }

  return (
    <Box>
      {/* Band rhythm: eyebrow → 1.5px rule → content */}
      <Text textStyle="eyebrow" color="fg.subtle" mb="2">
        AI Clips
      </Text>
      <Box layerStyle="band">
      {/* Caption directly under the rule; run stats mono on the same baseline */}
      <Flex align="baseline" justify="space-between" gap="3" wrap="wrap" mb="4">
        <Text fontSize="12.5px" color="fg.subtle">
          Ranked by virality score. Accept, reject, or adjust boundaries.
        </Text>
        <Text textStyle="data" fontSize="11px" color="fg.subtle">
          {clips.length} generated
          {acceptedCount > 0 && ` · ${acceptedCount} accepted`}
          {renderedCount > 0 && ` · ${renderedCount}/${clips.length} with renders`}
          {` · avg ${averageDuration.toFixed(1)}s`}
        </Text>
      </Flex>

      {/* Filter row — compact selects, mono counter right-aligned on the same line */}
      <Flex
        gap="2"
        wrap="wrap"
        align="center"
        pb="3"
        mb="5"
        borderBottomWidth="1px"
        borderColor="border.subtle"
      >
        <Box w="132px">
          <Select
            items={categoryItems}
            value={categoryFilter}
            onValueChange={setCategoryFilter}
            size="sm"
            aria-label="Filter by category"
          />
        </Box>
        <Box w="118px">
          <Select
            items={durationItems}
            value={durationFilter}
            onValueChange={setDurationFilter}
            size="sm"
            aria-label="Filter by duration"
          />
        </Box>
        <Box w="106px">
          <Select
            items={scoreItems}
            value={scoreFilter}
            onValueChange={setScoreFilter}
            size="sm"
            aria-label="Filter by score"
          />
        </Box>
        <Box w="136px">
          <Select
            items={platformItems}
            value={platformFilter}
            onValueChange={setPlatformFilter}
            size="sm"
            aria-label="Filter by platform"
          />
        </Box>
        <Text ms="auto" textStyle="data" fontSize="11px" color="fg.subtle">
          {filteredClips.length}/{clips.length} shown
        </Text>
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
        <Grid
          templateColumns={{
            base: "1fr",
            sm: "repeat(2, minmax(0, 1fr))",
            lg: "repeat(3, minmax(0, 1fr))",
          }}
          gap="4"
          alignItems="start"
        >
          {filteredClips.map((clip) => (
            <ClipCard
              key={clip.id}
              clip={clip}
              sourceVideoUrl={sourceVideoUrl}
              sourceType={sourceType}
            />
          ))}
        </Grid>
      )}
      </Box>
    </Box>
  );
}

"use client";

import { useMemo, useState } from "react";
import type { ClipPlatformTarget, ClipSnapshot } from "@narriflow/validators";
import { Stack, Box, Flex, Text } from "@chakra-ui/react";
import { ClipCard } from "./clip-card";

export function ClipsPanel({
  clips,
  sourceVideoUrl,
  sourceType,
}: {
  clips: ClipSnapshot[];
  sourceVideoUrl: string | null;
  sourceType: "upload" | "youtube" | "rss";
}) {
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [durationFilter, setDurationFilter] = useState("all");
  const [platformFilter, setPlatformFilter] = useState("all");
  const [scoreFilter, setScoreFilter] = useState("all");
  const categories = useMemo(
    () => [...new Set(clips.map((clip) => clip.category))].sort(),
    [clips],
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

  if (clips.length === 0) {
    return null;
  }

  return (
    <Box borderRadius="12px" borderWidth="1px" borderColor="border" bg="bg.panel" p="20px">
      <Stack gap="16px">
        <Flex align="center" justify="space-between" gap="8px">
          <Box>
            <Flex align="center" gap="8px">
              <Text fontSize="14px" fontWeight="500" color="fg">
                AI Clips
              </Text>
              <Text fontSize="12px" color="fg.muted">
                {clips.length} generated
                {acceptedCount > 0 && ` · ${acceptedCount} accepted`}
                {renderedCount > 0 &&
                  ` · ${renderedCount}/${clips.length} with renders`}
                {` · avg ${averageDuration.toFixed(1)}s`}
              </Text>
            </Flex>
            <Text mt="2px" fontSize="12px" color="fg.subtle">
              Ranked by virality score. Accept, reject, or adjust boundaries.
            </Text>
          </Box>
        </Flex>

        <Flex gap="8px" flexWrap="wrap">
          <select
            value={categoryFilter}
            onChange={(event) => setCategoryFilter(event.target.value)}
            style={{
              padding: "6px 8px",
              borderRadius: "6px",
              border: "1px solid var(--chakra-colors-border)",
              background: "transparent",
              color: "inherit",
              fontSize: "12px",
            }}
          >
            <option value="all">All categories</option>
            {categories.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
          <select
            value={durationFilter}
            onChange={(event) => setDurationFilter(event.target.value)}
            style={{
              padding: "6px 8px",
              borderRadius: "6px",
              border: "1px solid var(--chakra-colors-border)",
              background: "transparent",
              color: "inherit",
              fontSize: "12px",
            }}
          >
            <option value="all">All durations</option>
            <option value="preferred">30-60s</option>
            <option value="short">Under 30s</option>
            <option value="long">Over 60s</option>
          </select>
          <select
            value={scoreFilter}
            onChange={(event) => setScoreFilter(event.target.value)}
            style={{
              padding: "6px 8px",
              borderRadius: "6px",
              border: "1px solid var(--chakra-colors-border)",
              background: "transparent",
              color: "inherit",
              fontSize: "12px",
            }}
          >
            <option value="all">All scores</option>
            <option value="high">85+</option>
            <option value="review">Below 85</option>
          </select>
          <select
            value={platformFilter}
            onChange={(event) => setPlatformFilter(event.target.value)}
            style={{
              padding: "6px 8px",
              borderRadius: "6px",
              border: "1px solid var(--chakra-colors-border)",
              background: "transparent",
              color: "inherit",
              fontSize: "12px",
            }}
          >
            <option value="all">All platforms</option>
            <option value="tiktok">TikTok</option>
            <option value="youtube_shorts">YouTube Shorts</option>
            <option value="instagram_reels">Instagram Reels</option>
          </select>
          <Text alignSelf="center" fontSize="12px" color="fg.muted">
            {filteredClips.length}/{clips.length} shown
          </Text>
        </Flex>

        <Box borderRadius="8px" borderWidth="1px" borderColor="border" overflowX="auto">
          <Box as="table" w="full" fontSize="12px">
            <Box as="thead" bg="bg.muted">
              <Box as="tr">
                {["#", "Time", "Dur", "Score", "Hook", "Payoff"].map((header) => (
                  <Box key={header} as="th" textAlign="left" px="10px" py="8px" color="fg.muted">
                    {header}
                  </Box>
                ))}
              </Box>
            </Box>
            <Box as="tbody">
              {filteredClips.map((clip, index) => (
                <Box key={clip.id} as="tr" borderTopWidth={index > 0 ? "1px" : "0"} borderColor="border">
                  <Box as="td" px="10px" py="8px" color="fg.subtle">{clip.index + 1}</Box>
                  <Box as="td" px="10px" py="8px" fontFamily="mono" color="fg.subtle">
                    {clip.startSec.toFixed(1)}-{clip.endSec.toFixed(1)}
                  </Box>
                  <Box as="td" px="10px" py="8px" color="fg">{clip.durationSec.toFixed(1)}s</Box>
                  <Box as="td" px="10px" py="8px" color="fg">{clip.viralityScore}</Box>
                  <Box as="td" px="10px" py="8px" minW="18rem" color="fg">{clip.hookText}</Box>
                  <Box as="td" px="10px" py="8px" minW="14rem" color="fg.muted">
                    {clip.payoffText ?? clip.reasoning}
                  </Box>
                </Box>
              ))}
            </Box>
          </Box>
        </Box>

        <Stack gap="12px">
          {filteredClips.map((clip) => (
            <ClipCard key={clip.id} clip={clip} sourceVideoUrl={sourceVideoUrl} sourceType={sourceType} />
          ))}
        </Stack>
      </Stack>
    </Box>
  );
}

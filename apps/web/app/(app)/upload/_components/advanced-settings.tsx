"use client";

import { useState } from "react";
import { Box, chakra, Flex, Grid, Stack, Text } from "@chakra-ui/react";
import { ChevronDown, Minus, Plus } from "lucide-react";
import { IconButton } from "@narriflow/ui/components/button";
import type { ClipPlatformTarget } from "@narriflow/validators";
import { SocialPlatformMark } from "@/lib/social-platform-mark";
import { ChoiceChip } from "../../_shared/choice-chip";
import { ToneChips } from "../../_shared/tone-chips";

const platformOptions = [
  { value: "tiktok", label: "TikTok", short: "TikTok" },
  { value: "youtube_shorts", label: "YouTube Shorts", short: "Shorts" },
  { value: "instagram_reels", label: "Instagram Reels", short: "Reels" },
] as const;

const CLIP_COUNT_MIN = 3;
const CLIP_COUNT_MAX = 30;

interface AdvancedSettingsProps {
  platformTargets: ClipPlatformTarget[];
  onPlatformTargetsChange: (value: ClipPlatformTarget[]) => void;
  clipCountTarget: number;
  onClipCountTargetChange: (value: number) => void;
  toneConstraints: string;
  onToneConstraintsChange: (value: string) => void;
}

/** Optional generation preferences shared by every import source. */
export function AdvancedSettings({
  platformTargets,
  onPlatformTargetsChange,
  clipCountTarget,
  onClipCountTargetChange,
  toneConstraints,
  onToneConstraintsChange,
}: AdvancedSettingsProps) {
  const [open, setOpen] = useState(false);

  const togglePlatform = (value: ClipPlatformTarget) => {
    onPlatformTargetsChange(
      platformTargets.includes(value)
        ? platformTargets.filter((target) => target !== value)
        : [...platformTargets, value],
    );
  };
  const setCount = (value: number) =>
    onClipCountTargetChange(Math.min(CLIP_COUNT_MAX, Math.max(CLIP_COUNT_MIN, Math.round(value))));
  // The collapsed row says what's set, so most people never need to open it.
  const summary = [
    platformTargets.length === platformOptions.length
      ? "All platforms"
      : platformOptions
          .filter((option) => platformTargets.includes(option.value))
          .map((option) => option.short)
          .join(", ") || "No platform",
    `${clipCountTarget} clips`,
  ].join(" · ");

  return (
    <Box>
      <chakra.button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        display="flex"
        alignItems="center"
        gap="2"
        w="full"
        minH="44px"
        px="3"
        borderRadius="l2"
        bg="bg.soft"
        fontSize="14px"
        color="fg"
        cursor="pointer"
        transition="background 120ms ease"
        _hover={{ bg: "bg.softHover" }}
      >
        Advanced
        <Text as="span" ms="auto" fontSize="13px" color="fg.muted" truncate>
          {summary}
        </Text>
        <Box
          color="fg.muted"
          flexShrink={0}
          transform={open ? "rotate(180deg)" : undefined}
          transition="transform 200ms cubic-bezier(0.22, 1, 0.36, 1)"
        >
          <ChevronDown size={15} />
        </Box>
      </chakra.button>

      {open && (
        <Stack gap="5" px="1" pt="4" animation="fade-up">
          <Box>
            <Text textStyle="eyebrow" color="fg.muted" mb="2">
              Platform targets
            </Text>
            {/* The same named values the old checkboxes carried. */}
            {platformTargets.map((target) => (
              <input key={target} type="hidden" name="platformTargets" value={target} />
            ))}
            <Flex gap="2" flexWrap="wrap" role="group" aria-label="Platform targets">
              {platformOptions.map((option) => {
                const on = platformTargets.includes(option.value);
                return (
                  <ChoiceChip
                    key={option.value}
                    on={on}
                   
                    onToggle={() => togglePlatform(option.value)}
                    icon={
                      <Box opacity={on ? 1 : 0.45} filter={on ? undefined : "grayscale(1)"} transition="opacity 120ms ease, filter 120ms ease">
                        <SocialPlatformMark platform={option.value} size="5" />
                      </Box>
                    }
                  >
                    {option.label}
                  </ChoiceChip>
                );
              })}
            </Flex>
          </Box>

          <Grid templateColumns={{ base: "1fr", sm: "auto 1fr" }} gap="5" alignItems="start">
            <Box>
              <Text textStyle="eyebrow" color="fg.muted" mb="2">
                Clip count
              </Text>
              <Flex align="center" gap="1" h="9" px="1" borderRadius="full" bg="bg.soft" w="fit-content">
                <IconButton
                  size="xs"
                  variant="ghost"
                  borderRadius="full"
                  aria-label="Fewer clips"
                  disabled={clipCountTarget <= CLIP_COUNT_MIN}
                  onClick={() => setCount(clipCountTarget - 1)}
                >
                  <Minus size={14} />
                </IconButton>
                <Text
                  as="output"
                  aria-live="polite"
                  aria-label={`${clipCountTarget} clips`}
                  minW="7"
                  textAlign="center"
                  fontSize="14px"
                  fontWeight="500"
                  fontVariantNumeric="tabular-nums"
                >
                  {clipCountTarget}
                </Text>
                <IconButton
                  size="xs"
                  variant="ghost"
                  borderRadius="full"
                  aria-label="More clips"
                  disabled={clipCountTarget >= CLIP_COUNT_MAX}
                  onClick={() => setCount(clipCountTarget + 1)}
                >
                  <Plus size={14} />
                </IconButton>
              </Flex>
              <input type="hidden" name="clipCountTarget" value={clipCountTarget} />
            </Box>
            <Box minW="0">
              <Text textStyle="eyebrow" color="fg.muted" mb="2">
                Tone preferences
              </Text>
              <input type="hidden" name="toneConstraints" value={toneConstraints} />
              <ToneChips value={toneConstraints} onChange={onToneConstraintsChange} />
            </Box>
          </Grid>
        </Stack>
      )}
    </Box>
  );
}

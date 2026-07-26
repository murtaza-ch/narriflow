"use client";

import { useState, useEffect, useMemo } from "react";
import { Box, Flex, Text } from "@chakra-ui/react";
import { useReducedMotion } from "framer-motion";
import type { CaptionPreset } from "@narriflow/validators";
import type { NamedCaptionPreset } from "./caption-presets";
import { CaptionCue } from "../caption-style-engine";
import type { CaptionWord } from "../use-current-caption";

// ─── Preview words — the shared engine styles + animates them ────────────────

const PREVIEW_WORDS: CaptionWord[] = [
  { word: "To", isActive: false },
  { word: "get", isActive: true },
  { word: "started", isActive: false },
];

function getAccentColor(preset: CaptionPreset): string {
  return preset.glowColor ?? preset.highlightBoxColor ?? preset.highlightColor;
}

// ─── Preset Card ─────────────────────────────────────────────────────────────

export function PresetCard({
  namedPreset,
  isSelected,
  onClick,
}: {
  namedPreset: NamedCaptionPreset;
  isSelected: boolean;
  onClick: () => void;
}) {
  const reducedMotion = useReducedMotion() ?? false;
  const [loopKey, setLoopKey] = useState(0);

  useEffect(() => {
    // Reduced motion: no replay loop — the cue renders a static final frame.
    if (reducedMotion || namedPreset.preset.animation === "breathe") return;
    const interval = setInterval(() => setLoopKey((k) => k + 1), 2800);
    return () => clearInterval(interval);
  }, [namedPreset.preset.animation, reducedMotion]);

  // Subtle tint from the preset's own (user-facing) accent color over the
  // graphite card ground.
  const accent = getAccentColor(namedPreset.preset);
  const cardBg = useMemo(() => {
    const r = parseInt(accent.slice(1, 3), 16);
    const g = parseInt(accent.slice(3, 5), 16);
    const b = parseInt(accent.slice(5, 7), 16);
    return `linear-gradient(145deg, rgba(${r},${g},${b},0.06) 0%, var(--chakra-colors-studio-surface) 70%)`;
  }, [accent]);

  return (
    <Box
      as="button"
      onClick={onClick}
      cursor="pointer"
      w="100%"
      aria-pressed={isSelected}
    >
      <Flex
        direction="column"
        align="center"
        justify="center"
        h="82px"
        borderRadius="l3"
        border="1.5px solid"
        borderColor={isSelected ? "studio.accent" : "studio.border"}
        overflow="hidden"
        transition="border-color 120ms ease"
        _hover={{
          borderColor: isSelected ? "studio.accentFg" : "studio.borderStrong",
        }}
        style={{ background: cardBg }}
      >
        <CaptionCue
          preset={namedPreset.preset}
          words={PREVIEW_WORDS}
          fontSize={14}
          scale={0.6}
          mode="preview"
          cueKey={loopKey}
          gapPx={5}
          reducedMotion={reducedMotion}
        />
      </Flex>
      <Text
        mt="5px"
        fontSize="11px"
        color={isSelected ? "studio.accentFg" : "studio.fgMuted"}
        fontWeight={isSelected ? "600" : "500"}
        textAlign="center"
        truncate
      >
        {namedPreset.name}
      </Text>
    </Box>
  );
}

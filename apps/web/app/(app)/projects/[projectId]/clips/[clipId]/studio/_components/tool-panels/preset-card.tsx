"use client";

import { useState, useEffect, useMemo } from "react";
import { Box, Flex, Text } from "@chakra-ui/react";
import { motion } from "framer-motion";
import type { CaptionPreset } from "@narriflow/validators";
import type { NamedCaptionPreset } from "./caption-presets";

// ─── Preview text per preset — vary to show off each style ───────────────────

const PREVIEW_WORDS: [string, string, string] = ["To", "get", "started"];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hexToRgba(hex: string, opacity: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${opacity})`;
}

function getAccentColor(preset: CaptionPreset): string {
  return preset.glowColor ?? preset.highlightBoxColor ?? preset.highlightColor;
}

// ─── Motion Props ────────────────────────────────────────────────────────────

function getPreviewMotionProps(
  animation: string,
  isActive: boolean,
  index: number,
): Record<string, unknown> {
  const stagger = index * 0.12;

  switch (animation) {
    case "blur-in":
      return {
        initial: { filter: "blur(8px)", opacity: 0 },
        animate: { filter: "blur(0px)", opacity: 1 },
        transition: { duration: 0.4, ease: "easeOut", delay: stagger },
      };
    case "grow":
      return {
        initial: { scale: 0.2, opacity: 0 },
        animate: { scale: 1, opacity: 1 },
        transition: { type: "spring", stiffness: 260, damping: 18, delay: stagger },
      };
    case "breathe":
      return isActive
        ? {
            animate: { scale: [1, 1.12, 1] },
            transition: { repeat: Infinity, duration: 1.4, ease: "easeInOut" },
          }
        : {};
    case "soft-landing":
      return {
        initial: { y: -14, opacity: 0 },
        animate: { y: 0, opacity: 1 },
        transition: { duration: 0.45, ease: [0.22, 1, 0.36, 1], delay: stagger },
      };
    case "glitch":
      return {
        initial: { opacity: 0 },
        animate: { opacity: 1, x: [0, -3, 4, -2, 0], skewX: [0, -6, 3, -2, 0] },
        transition: { duration: 0.35, delay: stagger },
      };
    case "seamless-bounce":
      return {
        initial: { y: 10, opacity: 0, scale: 0.92 },
        animate: { y: 0, opacity: 1, scale: 1 },
        transition: { type: "spring", stiffness: 300, damping: 14, delay: stagger },
      };
    case "bounce":
      return {
        initial: { y: 10, opacity: 0 },
        animate: { y: 0, opacity: 1 },
        transition: { type: "spring", stiffness: 400, damping: 10, delay: stagger },
      };
    case "karaoke":
      return isActive
        ? { initial: { scale: 0.95 }, animate: { scale: 1.05 }, transition: { duration: 0.15 } }
        : { initial: { opacity: 0.5 }, animate: { opacity: 1 }, transition: { duration: 0.2, delay: stagger } };
    case "word-by-word":
      return {
        initial: { opacity: 0.35 },
        animate: { opacity: 1 },
        transition: { duration: 0.25, delay: stagger },
      };
    default:
      return {};
  }
}

// ─── Text Shadow Builder ─────────────────────────────────────────────────────

function buildTextShadow(preset: CaptionPreset, scale: number): string | undefined {
  const parts: string[] = [];
  const ow = Math.max(1, Math.round(preset.outlineWidth * scale));

  if (preset.outlineWidth > 0) {
    for (let x = -ow; x <= ow; x++) {
      for (let y = -ow; y <= ow; y++) {
        if (x === 0 && y === 0) continue;
        parts.push(`${x}px ${y}px 0 ${preset.outlineColor}`);
      }
    }
  }

  if (preset.shadow) {
    parts.push("0 1px 5px rgba(0,0,0,0.85)");
  }

  if (preset.glowColor) {
    const intensity = Math.round((preset.glowIntensity ?? 8) * scale);
    parts.push(`0 0 ${intensity}px ${preset.glowColor}`);
    parts.push(`0 0 ${intensity * 2}px ${preset.glowColor}55`);
    parts.push(`0 0 ${intensity * 3}px ${preset.glowColor}22`);
  }

  return parts.length > 0 ? parts.join(", ") : undefined;
}

// ─── Apply text transform to preview words ───────────────────────────────────

function transformWord(word: string, transform?: string): string {
  switch (transform) {
    case "uppercase": return word.toUpperCase();
    case "lowercase": return word.toLowerCase();
    case "capitalize": return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    default: return word;
  }
}

// ─── Animated Preview ────────────────────────────────────────────────────────

function AnimatedPreview({
  preset,
  loopKey,
}: {
  preset: CaptionPreset;
  loopKey: number;
}) {
  const textShadow = buildTextShadow(preset, 0.6);
  const activeIndex = 1;
  const hasBackdrop = !!preset.backgroundColor;
  const hasHighlightBox = !!preset.highlightBoxColor;
  const transform = preset.textTransform ?? "uppercase";

  return (
    <Box position="relative" display="inline-flex" alignItems="center" justifyContent="center" px="2px">
      {/* Backdrop pill */}
      {hasBackdrop && (
        <Box
          position="absolute"
          inset="-4px -8px"
          borderRadius="5px"
          pointerEvents="none"
          style={{
            backgroundColor: hexToRgba(
              preset.backgroundColor!,
              preset.backgroundOpacity ?? 0.6,
            ),
          }}
        />
      )}

      <Flex gap="5px" align="center" justify="center" position="relative" zIndex={1}>
        {PREVIEW_WORDS.map((word, i) => {
          const isActive = i === activeIndex;
          const motionProps = getPreviewMotionProps(preset.animation, isActive, i);
          const showBox = hasHighlightBox && isActive;
          const displayWord = transformWord(word, transform);

          return (
            <Box key={`${loopKey}-${i}`} position="relative" display="inline-flex">
              {/* Highlight box */}
              {showBox && (
                <Box
                  position="absolute"
                  inset="-2px -4px"
                  borderRadius="3px"
                  pointerEvents="none"
                  style={{
                    backgroundColor: hexToRgba(
                      preset.highlightBoxColor!,
                      preset.highlightBoxOpacity ?? 1,
                    ),
                  }}
                />
              )}

              <motion.span
                {...motionProps}
                style={{
                  position: "relative",
                  zIndex: 1,
                  fontSize: "14px",
                  fontWeight: preset.bold ? "900" : "600",
                  letterSpacing: `${preset.letterSpacing ?? 0.04}em`,
                  color: isActive ? preset.highlightColor : preset.primaryColor,
                  fontFamily: `"${preset.fontName}", Impact, sans-serif`,
                  textShadow,
                  display: "inline-block",
                  lineHeight: 1.3,
                }}
              >
                {displayWord}
              </motion.span>
            </Box>
          );
        })}
      </Flex>
    </Box>
  );
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
  const [loopKey, setLoopKey] = useState(0);

  useEffect(() => {
    if (namedPreset.preset.animation === "breathe") return;
    const interval = setInterval(() => setLoopKey((k) => k + 1), 2800);
    return () => clearInterval(interval);
  }, [namedPreset.preset.animation]);

  // Subtle accent tint on the card background
  const accent = getAccentColor(namedPreset.preset);
  const cardBg = useMemo(() => {
    const r = parseInt(accent.slice(1, 3), 16);
    const g = parseInt(accent.slice(3, 5), 16);
    const b = parseInt(accent.slice(5, 7), 16);
    return `linear-gradient(145deg, rgba(${r},${g},${b},0.06) 0%, #1a1a1a 70%)`;
  }, [accent]);

  return (
    <Box
      as="button"
      onClick={onClick}
      cursor="pointer"
      w="100%"
      transition="all 180ms"
      _hover={{ transform: "translateY(-1px)" }}
    >
      <Flex
        direction="column"
        align="center"
        justify="center"
        h="82px"
        borderRadius="10px"
        border="1.5px solid"
        borderColor={isSelected ? "#6366F1" : "#262626"}
        overflow="hidden"
        transition="all 180ms"
        _hover={{
          borderColor: isSelected ? "#818cf8" : "#3a3a3a",
          boxShadow: isSelected ? "0 0 12px rgba(99,102,241,0.25)" : undefined,
        }}
        style={{ background: cardBg }}
      >
        <AnimatedPreview preset={namedPreset.preset} loopKey={loopKey} />
      </Flex>
      <Text
        mt="5px"
        fontSize="10px"
        color={isSelected ? "#a5b4fc" : "#666"}
        fontWeight={isSelected ? "600" : "500"}
        textAlign="center"
        truncate
      >
        {namedPreset.name}
      </Text>
    </Box>
  );
}

"use client";

import { Box, chakra, Flex, Text } from "@chakra-ui/react";
import { Check } from "lucide-react";
import {
  CAPTION_CHUNK_SIZE,
  CAPTION_POSITION_Y_DEFAULTS,
  captionPresetOptions,
  type CaptionPreset,
  type CaptionPresetId,
} from "@narriflow/validators";

/*
 * Horizontal-scroll 9:16 preview cards, one per caption preset. Rendering
 * approach mirrors the marketing preset showcase
 * (`app/(marketing)/_components/preset-strip.tsx`) but static (no word
 * cycling — a dozen animated cards in a scroll rail is not worth the perf
 * cost) and selectable. Only CAPTION_CHUNK_SIZE and the preset data itself
 * come from @narriflow/validators — the cue model is never forked.
 */

const SAMPLE_PHRASE = ["make", "it", "pop"];

function wordStyle(preset: CaptionPreset, active: boolean): React.CSSProperties {
  const shadows: string[] = [];
  if (preset.outlineWidth > 0) {
    shadows.push(`0 0 2px ${preset.outlineColor}`, `0 1px 2px ${preset.outlineColor}`);
  }
  if (preset.glowColor && (preset.glowIntensity ?? 0) > 0) {
    shadows.push(`0 0 ${Math.max(3, (preset.glowIntensity ?? 0) / 2)}px ${preset.glowColor}`);
  }

  const style: React.CSSProperties = {
    color: active && !preset.highlightBoxColor ? preset.highlightColor : preset.primaryColor,
    textShadow: shadows.length > 0 ? shadows.join(", ") : undefined,
  };

  if (active && preset.highlightBoxColor) {
    style.backgroundColor = preset.highlightBoxColor;
    style.opacity = preset.highlightBoxOpacity ?? 1;
    style.borderRadius = "2px";
    style.padding = "0 3px";
  }

  return style;
}

const cue = SAMPLE_PHRASE.slice(0, CAPTION_CHUNK_SIZE);

export function CaptionPresetGallery({
  value,
  onChange,
}: {
  value: CaptionPresetId;
  onChange: (id: CaptionPresetId) => void;
}) {
  return (
    <Flex
      gap="3"
      overflowX="auto"
      pb="1"
      css={{
        scrollbarWidth: "thin",
        scrollbarColor: "var(--chakra-colors-border-emphasized) transparent",
      }}
    >
      {captionPresetOptions.map((option) => {
        const selected = value === option.id;
        // captionPresetOptions is declared `as const` — each element's
        // `preset.position` etc. is preserved as that one preset's literal
        // value rather than the full CaptionPreset union. Widen explicitly
        // (same shape, just a wider type) so downstream ternaries over
        // `position` type-check across every preset, not just one.
        const preset = option.preset as CaptionPreset | null;
        return (
          <chakra.button
            key={option.id}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(option.id as CaptionPresetId)}
            flexShrink={0}
            w="92px"
            textAlign="left"
            cursor="pointer"
          >
            <Box
              aspectRatio={9 / 16}
              bg="studio.canvas"
              borderWidth={selected ? "1.5px" : "1px"}
              borderColor={selected ? "accent.solid" : "border"}
              borderRadius="l2"
              position="relative"
              overflow="hidden"
              transition="border-color 120ms ease"
            >
              {preset ? (
                <Flex
                  position="absolute"
                  left="0"
                  right="0"
                  // Same cue-model anchor the studio caption overlay reads
                  // (`CAPTION_POSITION_Y_DEFAULTS`, a top-percent, center-
                  // anchored value) — never a preview-only guess at bottom
                  // offsets per position.
                  top={`${preset.positionY ?? CAPTION_POSITION_Y_DEFAULTS[preset.position]}%`}
                  style={{ transform: "translateY(-50%)" }}
                  justify="center"
                  align="baseline"
                  gap="2px"
                  flexWrap="wrap"
                  px="1.5"
                >
                  {cue.map((word, wordIdx) => (
                    <Text
                      key={`${option.id}-${wordIdx}`}
                      fontSize={`${Math.max(7, Math.round(preset.fontSize / 4.2))}px`}
                      lineHeight="1.3"
                      fontWeight={preset.bold ? "700" : "500"}
                      textTransform={preset.textTransform}
                      letterSpacing={`${preset.letterSpacing}em`}
                      style={wordStyle(preset, wordIdx === 0)}
                    >
                      {word}
                    </Text>
                  ))}
                </Flex>
              ) : (
                <Flex
                  align="center"
                  justify="center"
                  position="absolute"
                  inset="0"
                  p="2"
                >
                  <Text
                    fontSize="9px"
                    color="studio.fgMuted"
                    textAlign="center"
                    lineHeight="1.4"
                  >
                    Uses your brand template
                  </Text>
                </Flex>
              )}
              {selected && (
                <Flex
                  position="absolute"
                  top="1.5"
                  right="1.5"
                  boxSize="16px"
                  align="center"
                  justify="center"
                  bg="accent.solid"
                  borderRadius="full"
                  color="accent.contrast"
                >
                  <Check size={10} strokeWidth={3} />
                </Flex>
              )}
            </Box>
            <Text mt="1.5" fontSize="10.5px" color="fg.muted" truncate>
              {option.name}
            </Text>
          </chakra.button>
        );
      })}
    </Flex>
  );
}

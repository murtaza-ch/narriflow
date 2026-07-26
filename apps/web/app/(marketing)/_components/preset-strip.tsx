"use client";

import { useEffect, useMemo, useState } from "react";
import { Box, Flex, SimpleGrid, Stack, Text } from "@chakra-ui/react";
import {
  CAPTION_CHUNK_SIZE,
  getCaptionPresetById,
  type CaptionPreset,
} from "@narriflow/validators";

/*
 * Caption-preset showcase: several REAL presets from @narriflow/validators
 * rendering the same looping phrase. Preset color values are user-facing
 * caption styles — the sanctioned literal-hex exception. Tiles sit on the
 * mode-invariant studio graphite so caption colors read as they do on video.
 */

const PHRASE = "captions that stop the scroll";
const WORDS = PHRASE.split(" ");
const WORD_TICK_MS = 380;

const SHOWCASE_IDS = ["karaoke", "highlighter", "fire", "street", "electric", "minimal"];

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

export function PresetStrip() {
  const presets = useMemo(
    () =>
      SHOWCASE_IDS.flatMap((id) => {
        const named = getCaptionPresetById(id);
        return named ? [named] : [];
      }),
    [],
  );
  const [wordIndex, setWordIndex] = useState(0);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setWordIndex(1);
      return;
    }
    const timer = setInterval(() => {
      setWordIndex((current) => (current + 1) % WORDS.length);
    }, WORD_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const cueStart = Math.floor(wordIndex / CAPTION_CHUNK_SIZE) * CAPTION_CHUNK_SIZE;
  const cue = WORDS.slice(cueStart, cueStart + CAPTION_CHUNK_SIZE);
  const activeInCue = wordIndex - cueStart;

  return (
    <SimpleGrid columns={{ base: 2, sm: 3, lg: 6 }} gap="4" w="full">
      {presets.map(({ id, name, preset }, index) => (
        <Stack key={id} gap="2">
          <Box
            aspectRatio={9 / 16}
            bg="studio.canvas"
            borderWidth="1px"
            borderColor="border"
            borderRadius="l2"
            position="relative"
            overflow="hidden"
            aria-hidden="true"
          >
            <Flex
              position="absolute"
              left="0"
              right="0"
              bottom={preset.position === "center" ? "46%" : preset.position === "top" ? "82%" : "16%"}
              justify="center"
              align="baseline"
              gap="3px"
              flexWrap="wrap"
              px="1.5"
            >
              {cue.map((word, wordIdx) => (
                <Text
                  key={`${cueStart}-${wordIdx}`}
                  fontSize={`${Math.max(9, Math.round(preset.fontSize / 3.4))}px`}
                  lineHeight="1.35"
                  fontWeight={preset.bold ? "700" : "500"}
                  textTransform={preset.textTransform}
                  letterSpacing={`${preset.letterSpacing}em`}
                  style={wordStyle(preset, wordIdx === activeInCue)}
                >
                  {word}
                </Text>
              ))}
            </Flex>
          </Box>
          <Flex align="baseline" justify="space-between" gap="2">
            <Text textStyle="eyebrow" color="fg.muted">
              {name}
            </Text>
            <Text textStyle="data" fontSize="11px" color="fg.subtle">
              {String(index + 1).padStart(2, "0")}
            </Text>
          </Flex>
        </Stack>
      ))}
    </SimpleGrid>
  );
}

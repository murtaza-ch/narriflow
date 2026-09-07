"use client";

import { resolveCaptionFontFamily } from "../../projects/[projectId]/clips/[clipId]/studio/_components/caption-style-engine";
import { useRef } from "react";
import Image from "next/image";
import { Box, chakra, Flex, Stack, Text } from "@chakra-ui/react";
import { Check, ChevronLeft, ChevronRight, Palette } from "lucide-react";
import {
  CAPTION_CHUNK_SIZE,
  CAPTION_POSITION_Y_DEFAULTS,
  captionPresetOptions,
  type CaptionPreset,
  type CaptionPresetId,
} from "@narriflow/validators";

// Static caption samples use the same preset data and cue anchors as export.
const SAMPLE_PHRASE = ["make", "it", "pop"];
const PREVIEW_IMAGE_NAMES: Partial<Record<CaptionPresetId, string>> = {
  karaoke: "caption-preview",
  fire: "fire-studio",
};

function wordStyle(
  preset: CaptionPreset,
  active: boolean,
): React.CSSProperties {
  const shadows: string[] = [];
  if (preset.outlineWidth > 0) {
    shadows.push(
      `0 0 2px ${preset.outlineColor}`,
      `0 1px 2px ${preset.outlineColor}`,
    );
  }
  if (preset.glowColor && (preset.glowIntensity ?? 0) > 0) {
    shadows.push(
      `0 0 ${Math.max(3, (preset.glowIntensity ?? 0) / 2)}px ${preset.glowColor}`,
    );
  }

  const style: React.CSSProperties = {
    color:
      active && !preset.highlightBoxColor
        ? preset.highlightColor
        : preset.primaryColor,
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
  const railRef = useRef<HTMLDivElement>(null);
  const selectedName = captionPresetOptions.find(
    (option) => option.id === value,
  )?.name;
  return (
    <Stack gap="3">
      <Flex align="center" justify="space-between" gap="3">
        <Box>
          <Text as="h2" fontSize="14px" fontWeight="600">
            Caption style
          </Text>
          <Text fontSize="11px" color="fg.muted" mt="1">
            {selectedName} selected · Sample preview
          </Text>
        </Box>
        <Flex gap="1.5">
          {([-1, 1] as const).map((direction) => (
            <chakra.button
              key={direction}
              type="button"
              aria-label={
                direction === -1
                  ? "Previous caption styles"
                  : "Next caption styles"
              }
              onClick={() =>
                railRef.current?.scrollBy({
                  left: direction * 300,
                  behavior: window.matchMedia(
                    "(prefers-reduced-motion: reduce)",
                  ).matches
                    ? "instant"
                    : "smooth",
                })
              }
              boxSize="30px"
              rounded="full"
              borderWidth="1px"
              borderColor="border.control"
              display="flex"
              alignItems="center"
              justifyContent="center"
              color="fg.muted"
              cursor="pointer"
              _hover={{ bg: "bg.muted", color: "fg" }}
              _focusVisible={{
                outline: "2px solid",
                outlineColor: "accent.solid",
                outlineOffset: "2px",
              }}
            >
              {direction === -1 ? (
                <ChevronLeft size={15} />
              ) : (
                <ChevronRight size={15} />
              )}
            </chakra.button>
          ))}
        </Flex>
      </Flex>
      <Flex
        ref={railRef}
        gap="3"
        overflowX="auto"
        pb="2"
        px="0.5"
        pt="0.5"
        css={{
          scrollbarWidth: "none",
          msOverflowStyle: "none",
          "&::-webkit-scrollbar": { display: "none" },
          scrollSnapType: "x proximity",
        }}
      >
        {captionPresetOptions.map((option) => {
          const selected = value === option.id;
          const preset = option.preset as CaptionPreset | null;
          return (
            <chakra.button
              key={option.id}
              type="button"
              aria-label={option.name}
              aria-pressed={selected}
              onClick={() => onChange(option.id as CaptionPresetId)}
              flexShrink={0}
              w={{ base: "120px", md: "128px" }}
              textAlign="left"
              cursor="pointer"
              rounded="xl"
              scrollSnapAlign="start"
              _focusVisible={{
                outline: "2px solid",
                outlineColor: "accent.solid",
                outlineOffset: "2px",
              }}
            >
              <Box
                aspectRatio={9 / 16}
                bg="studio.canvas"
                borderWidth="2px"
                borderColor={selected ? "accent.solid" : "transparent"}
                rounded="xl"
                position="relative"
                overflow="hidden"
                transition="border-color 150ms ease"
                _hover={{ borderColor: "accent.solid" }}
              >
                {preset ? (
                  <>
                    <Image
                      src={`/images/upload/${PREVIEW_IMAGE_NAMES[option.id] ?? option.id}.webp`}
                      alt=""
                      fill
                      sizes="128px"
                      style={{ objectFit: "cover" }}
                    />
                    <Box
                      position="absolute"
                      inset="0"
                      bg="linear-gradient(180deg, rgba(0,0,0,.08) 35%, rgba(0,0,0,.30) 100%)"
                    />
                    <Flex
                      position="absolute"
                      left="0"
                      right="0"
                      top={`${preset.positionY ?? CAPTION_POSITION_Y_DEFAULTS[preset.position]}%`}
                      transform="translateY(-50%)"
                      justify="center"
                      align="baseline"
                      gap="2px"
                      flexWrap="wrap"
                      px="1.5"
                    >
                      {cue.map((word, wordIdx) => (
                        <Text
                          key={`${option.id}-${wordIdx}`}
                          fontSize={`${Math.max(10, Math.round(preset.fontSize / 3))}px`}
                          lineHeight="1.3"
                          fontFamily={resolveCaptionFontFamily(preset.fontName)}
                          fontWeight={preset.bold ? "700" : "500"}
                          textTransform={preset.textTransform}
                          letterSpacing={`${preset.letterSpacing}em`}
                          style={wordStyle(preset, wordIdx === 0)}
                        >
                          {word}
                        </Text>
                      ))}
                    </Flex>
                  </>
                ) : (
                  <Stack
                    position="absolute"
                    inset="0"
                    align="center"
                    justify="center"
                    gap="4"
                    p="3"
                    bg="accent.subtle"
                    color="accent.fg"
                  >
                    <Flex
                      boxSize="44px"
                      borderWidth="1px"
                      borderColor="accent.emphasized"
                      rounded="xl"
                      align="center"
                      justify="center"
                    >
                      <Palette size={22} strokeWidth={1.5} />
                    </Flex>
                    <Text fontSize="13px" fontWeight="550" textAlign="center">
                      Your brand,
                      <br />
                      every clip.
                    </Text>
                    <Text
                      fontSize="10px"
                      color="fg.muted"
                      textAlign="center"
                      lineHeight="1.6"
                    >
                      Use the template selected during import.
                    </Text>
                  </Stack>
                )}
                {selected && (
                  <Flex
                    position="absolute"
                    top="2"
                    right="2"
                    boxSize="20px"
                    align="center"
                    justify="center"
                    bg="accent.solid"
                    rounded="full"
                    color="accent.contrast"
                  >
                    <Check size={12} strokeWidth={3} />
                  </Flex>
                )}
              </Box>
              <Flex align="center" justify="space-between" pt="2" px="0.5">
                <Text
                  fontSize="12px"
                  fontWeight={selected ? "600" : "450"}
                  color={selected ? "accent.fg" : "fg.muted"}
                >
                  {option.name}
                </Text>
              </Flex>
            </chakra.button>
          );
        })}
      </Flex>
    </Stack>
  );
}

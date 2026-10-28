"use client";

import { useRef } from "react";
import { Box, chakra, Flex, Stack, Text } from "@chakra-ui/react";
import { Check, ChevronLeft, ChevronRight, Palette } from "lucide-react";
import {
  CAPTION_POSITION_Y_DEFAULTS,
  captionPresetOptions,
  type CaptionPresetId,
  type NamedCaptionPreset,
} from "@narriflow/validators";
import { CaptionPresetPreview } from "./caption-preset-preview";

export function CaptionPresetGallery({
  value,
  onChange,
}: {
  value: CaptionPresetId;
  onChange: (id: CaptionPresetId) => void;
}) {
  const railRef = useRef<HTMLDivElement>(null);
  return (
    <Stack gap="3">
      <Flex align="center" justify="space-between" gap="3">
        <Box>
          <Text as="h2" fontSize="16px" fontWeight="500">
            Caption style
          </Text>
          <Text fontSize="12px" color="fg.subtle" mt="1">
            Sample preview
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
              boxSize="32px"
              rounded="full"
              bg="bg.soft"
              display="flex"
              alignItems="center"
              justifyContent="center"
              color="fg.muted"
              cursor="pointer"
              _hover={{ bg: "bg.softHover", color: "fg" }}
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
          const namedPreset = option.preset ? (option as NamedCaptionPreset) : null;
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
              >
                {namedPreset ? (
                  <CaptionPresetPreview
                    namedPreset={namedPreset}
                    aspectRatio="9 / 16"
                    captionTopPct={namedPreset.preset.positionY ?? CAPTION_POSITION_Y_DEFAULTS[namedPreset.preset.position]}
                    boost={1.3}
                    imageSizes="128px"
                  />
                ) : (
                  <Stack
                    position="absolute"
                    inset="0"
                    align="center"
                    justify="center"
                    gap="4"
                    p="3"
                    bg="bg.subtle"
                    color="fg"
                  >
                    <Box color="fg.muted">
                      <Palette size={20} strokeWidth={1.75} />
                    </Box>
                    <Text fontSize="13px" fontWeight="500" textAlign="center">
                      Your brand,
                      <br />
                      every clip.
                    </Text>
                    <Text
                      fontSize="12px"
                      color="fg.muted"
                      textAlign="center"
                      lineHeight="1.5"
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

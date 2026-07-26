"use client";

import { useEffect, useMemo, useState } from "react";
import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { MediaWell } from "@narriflow/ui/components/media-well";
import { CAPTION_CHUNK_SIZE, getCaptionPresetById } from "@narriflow/validators";
import { formatTimecode } from "@/lib/format";

/*
 * Live hero mock: the studio editor rendering a real caption-cue loop.
 * Cue chunking uses the actual shared cue model (CAPTION_CHUNK_SIZE) and a
 * real preset from @narriflow/validators — the "preview = export" promise,
 * demonstrated. Chrome sits on the mode-invariant studio.* graphite ramp;
 * caption colors are real preset values (the sanctioned literal exception).
 */

const SCRIPT =
  "the best moment of your podcast is buried forty minutes in narriflow finds it scores it and captions it";

const WORDS = SCRIPT.split(" ");
const CLIP_DURATION_SECONDS = 96;
const WORD_TICK_MS = 340;

const PRESET = getCaptionPresetById("karaoke")!.preset;

function chunkWords(words: string[]): string[][] {
  const cues: string[][] = [];
  for (let i = 0; i < words.length; i += CAPTION_CHUNK_SIZE) {
    cues.push(words.slice(i, i + CAPTION_CHUNK_SIZE));
  }
  return cues;
}

export function HeroDemo() {
  const cues = useMemo(() => chunkWords(WORDS), []);
  const [wordIndex, setWordIndex] = useState(0);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      // Hold a representative frame instead of looping.
      setWordIndex(Math.floor(WORDS.length / 2));
      return;
    }
    const timer = setInterval(() => {
      setWordIndex((current) => (current + 1) % WORDS.length);
    }, WORD_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const cueIndex = Math.floor(wordIndex / CAPTION_CHUNK_SIZE);
  const activeInCue = wordIndex % CAPTION_CHUNK_SIZE;
  const progress = (wordIndex + 1) / WORDS.length;
  const playheadSeconds = Math.floor(progress * CLIP_DURATION_SECONDS);

  return (
    <MediaWell ratio={16 / 9} w="full" borderColor="border.emphasized" aria-hidden="true">
      <Flex direction="column" h="full">
        {/* Editor chrome bar */}
        <Flex
          align="center"
          gap="1.5"
          px="3.5"
          h="34px"
          flexShrink={0}
          borderBottomWidth="1px"
          borderColor="studio.border"
          bg="studio.surface"
        >
          <Box w="7px" h="7px" borderRadius="full" bg="studio.raised" />
          <Box w="7px" h="7px" borderRadius="full" bg="studio.raised" />
          <Box w="7px" h="7px" borderRadius="full" bg="studio.raised" />
          <Text textStyle="data" fontSize="10.5px" color="studio.fgSubtle" ms="2">
            studio — clip_04.mp4
          </Text>
          <Text textStyle="data" fontSize="10.5px" color="studio.timecode" ms="auto">
            {formatTimecode(playheadSeconds)}
          </Text>
        </Flex>

        <Flex flex="1" minH="0">
          {/* Transcript column — real cue text, active cue marked */}
          <Stack
            display={{ base: "none", md: "flex" }}
            w="190px"
            flexShrink={0}
            borderRightWidth="1px"
            borderColor="studio.border"
            p="3.5"
            gap="2"
            overflow="hidden"
          >
            <Text textStyle="eyebrow" color="studio.fgSubtle" mb="0.5">
              Transcript
            </Text>
            {cues.map((cue, index) => (
              <Flex key={index} gap="2" align="center">
                <Box
                  w="2px"
                  alignSelf="stretch"
                  bg={index === cueIndex ? "studio.accent" : "transparent"}
                  flexShrink={0}
                />
                <Text
                  textStyle="data"
                  fontSize="10px"
                  lineHeight="1.5"
                  color={index === cueIndex ? "studio.fg" : "studio.fgSubtle"}
                  transition="color 120ms ease"
                  truncate
                >
                  {cue.join(" ")}
                </Text>
              </Flex>
            ))}
          </Stack>

          {/* Vertical canvas with the live caption cue */}
          <Flex flex="1" align="center" justify="center" position="relative" py="3.5">
            {/* Score cluster — bare mono numeral + 24px meter */}
            <Stack position="absolute" top="3.5" right="3.5" gap="1" align="flex-end">
              <Text textStyle="eyebrow" color="studio.fgSubtle">
                Score
              </Text>
              <Text textStyle="data" fontSize="16px" fontWeight="600" color="studio.fg" lineHeight="1">
                87
              </Text>
              <Box w="24px" h="3px" bg="studio.raised" borderRadius="full" overflow="hidden">
                <Box h="full" w="87%" bg="studio.accent" borderRadius="full" />
              </Box>
            </Stack>

            <Box
              w="118px"
              h="100%"
              maxH="200px"
              borderRadius="l2"
              bg="studio.canvas"
              borderWidth="1px"
              borderColor="studio.borderStrong"
              position="relative"
              overflow="hidden"
            >
              {/* Caption cue — real preset values (karaoke) */}
              <Flex
                position="absolute"
                left="0"
                right="0"
                bottom="14%"
                justify="center"
                gap="3px"
                flexWrap="wrap"
                px="1.5"
              >
                {(cues[cueIndex] ?? []).map((word, index) => (
                  <Text
                    key={`${cueIndex}-${index}`}
                    fontSize="10px"
                    lineHeight="1.3"
                    fontWeight={PRESET.bold ? "700" : "500"}
                    textTransform={PRESET.textTransform}
                    letterSpacing={`${PRESET.letterSpacing}em`}
                    style={{
                      color: index === activeInCue ? PRESET.highlightColor : PRESET.primaryColor,
                      textShadow:
                        PRESET.outlineWidth > 0
                          ? `0 0 2px ${PRESET.outlineColor}, 0 1px 2px ${PRESET.outlineColor}`
                          : undefined,
                    }}
                  >
                    {word}
                  </Text>
                ))}
              </Flex>
            </Box>
          </Flex>
        </Flex>

        {/* Timeline bar with a live playhead */}
        <Flex
          h="30px"
          flexShrink={0}
          borderTopWidth="1px"
          borderColor="studio.border"
          bg="studio.surface"
          px="3.5"
          align="center"
          gap="3"
        >
          <Text textStyle="data" fontSize="10px" color="studio.timecode" flexShrink={0}>
            {formatTimecode(playheadSeconds)}
          </Text>
          <Box position="relative" w="full" h="3px" borderRadius="full" bg="studio.raised">
            <Box
              position="absolute"
              left="0"
              top="0"
              bottom="0"
              width={`${Math.round(progress * 100)}%`}
              borderRadius="full"
              bg="studio.accent"
              transition="width 340ms linear"
            />
          </Box>
          <Text textStyle="data" fontSize="10px" color="studio.fgMuted" flexShrink={0}>
            {formatTimecode(CLIP_DURATION_SECONDS)}
          </Text>
        </Flex>
      </Flex>
    </MediaWell>
  );
}

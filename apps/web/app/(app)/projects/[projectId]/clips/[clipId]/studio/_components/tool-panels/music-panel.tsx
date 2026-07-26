"use client";

import { useState } from "react";
import { Box, Flex, Text, Stack, Input, Slider } from "@chakra-ui/react";
import { Link2, Music, Volume2, X } from "lucide-react";
import { useStudio } from "../studio-shell";

export function MusicPanel() {
  const { studioEdits, setStudioEdits } = useStudio();
  const [url, setUrl] = useState(studioEdits.music.url ?? "");
  const [title, setTitle] = useState(studioEdits.music.title ?? "");
  const [volume, setVolume] = useState(studioEdits.music.volume);

  const applyMusic = () => {
    const trimmedUrl = url.trim();
    setStudioEdits((prev) => ({
      ...prev,
      music: {
        url: trimmedUrl ? trimmedUrl : null,
        title: title.trim() || null,
        volume,
        startOffsetSec: 0,
      },
    }));
  };

  const clearMusic = () => {
    setUrl("");
    setTitle("");
    setStudioEdits((prev) => ({
      ...prev,
      music: { url: null, title: null, volume: 35, startOffsetSec: 0 },
    }));
  };

  return (
    <Stack gap="14px" p="12px">
      <Box>
        <Text textStyle="eyebrow" color="studio.fgMuted" mb="6px">
          Music URL
        </Text>
        <Flex
          align="center"
          gap="8px"
          px="10px"
          h="34px"
          borderRadius="l2"
          bg="studio.subtle"
          borderWidth="1px"
          borderColor="studio.borderControl"
          _focusWithin={{ borderColor: "studio.ring" }}
          transition="border-color 120ms ease"
        >
          <Box color="studio.fgSubtle" flexShrink={0}>
            <Link2 size={13} />
          </Box>
          <Input
            aria-label="Music URL"
            placeholder="https://example.com/background.mp3"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            size="xs"
            flex="1"
            fontSize="12px"
            color="studio.fg"
            css={{ border: "none", outline: "none", background: "transparent", boxShadow: "none" }}
            _placeholder={{ color: "studio.fgSubtle" }}
          />
        </Flex>
      </Box>

      <Box>
        <Text textStyle="eyebrow" color="studio.fgMuted" mb="6px">
          Track label
        </Text>
        <Input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Background bed"
          size="sm"
          bg="studio.subtle"
          borderColor="studio.borderControl"
          color="studio.fg"
          fontSize="12px"
          _placeholder={{ color: "studio.fgSubtle" }}
          _focusVisible={{ borderColor: "studio.ring", boxShadow: "none" }}
        />
      </Box>

      <Box
        p="12px"
        bg="studio.subtle"
        borderRadius="l2"
        borderWidth="1px"
        borderColor="studio.border"
      >
        <Flex align="center" gap="8px">
          <Box color="studio.fgMuted" flexShrink={0}>
            <Volume2 size={14} />
          </Box>
          <Slider.Root
            aria-label={["Music volume"]}
            value={[volume]}
            min={0}
            max={100}
            onValueChange={(event) => setVolume(event.value[0] ?? 35)}
            size="sm"
            colorPalette="accent"
            flex="1"
          >
            <Slider.Control>
              <Slider.Track>
                <Slider.Range />
              </Slider.Track>
              <Slider.Thumbs />
            </Slider.Control>
          </Slider.Root>
          <Text textStyle="data" fontSize="11px" color="studio.fgMuted" w="34px" textAlign="right">
            {volume}%
          </Text>
        </Flex>
      </Box>

      {studioEdits.music.url ? (
        <Flex
          pl="10px"
          pr="10px"
          py="8px"
          borderRadius="l2"
          bg="success.950"
          borderWidth="1px"
          borderColor="success.800"
          borderLeftWidth="3px"
          borderLeftColor="success.400"
          align="center"
          justify="space-between"
        >
          <Flex align="center" gap="6px" minW="0" color="success.400">
            <Music size={13} />
            <Text fontSize="11px" color="success.400" fontWeight="600" overflow="hidden" whiteSpace="nowrap" textOverflow="ellipsis">
              {studioEdits.music.title ?? "Music applied"}
            </Text>
          </Flex>
          <Box
            as="button"
            aria-label="Remove music"
            color="studio.fgMuted"
            cursor="pointer"
            _hover={{ color: "studio.fg" }}
            transition="color 120ms ease"
            onClick={clearMusic}
          >
            <X size={13} />
          </Box>
        </Flex>
      ) : null}

      {/* Secondary action — Export owns the view's solid button */}
      <Flex
        as="button"
        align="center"
        justify="center"
        h="34px"
        borderRadius="l2"
        bg="studio.raised"
        borderWidth="1px"
        borderColor="studio.borderStrong"
        color="studio.fg"
        fontSize="12px"
        fontWeight="600"
        cursor="pointer"
        gap="6px"
        _hover={{ borderColor: "studio.fgSubtle" }}
        transition="border-color 120ms ease"
        onClick={applyMusic}
      >
        <Music size={13} />
        Apply music
      </Flex>
    </Stack>
  );
}

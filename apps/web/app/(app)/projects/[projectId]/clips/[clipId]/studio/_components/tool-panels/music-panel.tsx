"use client";

import { useState } from "react";
import { Box, Flex, Text, Stack, Input, Slider } from "@chakra-ui/react";
import { Search, Play, Pause, Music, Volume2 } from "lucide-react";

const GENRES = ["Upbeat", "Cinematic", "Chill", "Dramatic", "Electronic", "Acoustic"];

const TRACKS = [
  { id: "1", title: "Summer Vibes",    duration: "2:34", bpm: 128, genre: "Upbeat" },
  { id: "2", title: "Epic Moment",     duration: "3:12", bpm: 96,  genre: "Cinematic" },
  { id: "3", title: "Lo-fi Afternoon", duration: "4:01", bpm: 85,  genre: "Chill" },
  { id: "4", title: "Rising Action",   duration: "2:48", bpm: 110, genre: "Dramatic" },
  { id: "5", title: "Synthwave Night", duration: "3:22", bpm: 120, genre: "Electronic" },
  { id: "6", title: "Acoustic Dream",  duration: "3:45", bpm: 75,  genre: "Acoustic" },
];

export function MusicPanel() {
  const [query, setQuery] = useState("");
  const [activeGenre, setActiveGenre] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [volume, setVolume] = useState(70);

  const filtered = TRACKS.filter((t) => {
    const matchQ = t.title.toLowerCase().includes(query.toLowerCase());
    const matchG = activeGenre ? t.genre === activeGenre : true;
    return matchQ && matchG;
  });

  return (
    <Stack gap="0">
      {/* Search */}
      <Box p="12px" pb="8px">
        <Flex
          align="center"
          gap="8px"
          px="10px"
          h="34px"
          borderRadius="7px"
          bg="#1a1a1a"
          border="1px solid #2a2a2a"
        >
          <Search size={13} color="#555" />
          <Input
            placeholder="Search music..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            size="xs"
            flex="1"
            fontSize="12px"
            color="#ccc"
            css={{ border: "none", outline: "none", background: "transparent", boxShadow: "none" }}
            _placeholder={{ color: "#555" }}
          />
        </Flex>
      </Box>

      {/* Genre chips */}
      <Box
        overflowX="auto"
        px="12px"
        pb="8px"
        css={{
          "&::-webkit-scrollbar": { display: "none" },
        }}
      >
        <Flex gap="5px" w="max-content">
          {GENRES.map((g) => (
            <Box
              key={g}
              as="button"
              px="10px"
              py="4px"
              borderRadius="99px"
              bg={activeGenre === g ? "rgba(99,102,241,0.15)" : "#1a1a1a"}
              border="1px solid"
              borderColor={activeGenre === g ? "#6366F1" : "#2a2a2a"}
              color={activeGenre === g ? "#a5b4fc" : "#666"}
              fontSize="11px"
              fontWeight="500"
              cursor="pointer"
              onClick={() => setActiveGenre(activeGenre === g ? null : g)}
              whiteSpace="nowrap"
              transition="all 150ms"
            >
              {g}
            </Box>
          ))}
        </Flex>
      </Box>

      {/* Track list */}
      <Stack gap="2px" px="12px" pb="12px">
        {filtered.map((track) => {
          const isPlaying = playingId === track.id;
          return (
            <Flex
              key={track.id}
              align="center"
              gap="10px"
              px="10px"
              py="9px"
              borderRadius="7px"
              bg={isPlaying ? "rgba(99,102,241,0.08)" : "transparent"}
              border="1px solid"
              borderColor={isPlaying ? "#6366F1" : "transparent"}
              cursor="pointer"
              transition="all 150ms"
              _hover={{ bg: "#1a1a1a" }}
              onClick={() => setPlayingId(isPlaying ? null : track.id)}
            >
              <Flex
                w="28px"
                h="28px"
                align="center"
                justify="center"
                borderRadius="full"
                bg={isPlaying ? "#6366F1" : "#1e1e1e"}
                flexShrink={0}
                transition="all 150ms"
              >
                {isPlaying
                  ? <Pause size={12} color="white" />
                  : <Play size={12} color="#888" />
                }
              </Flex>
              <Box flex="1" minW="0">
                <Text fontSize="12px" fontWeight="500" color={isPlaying ? "#a5b4fc" : "#ccc"} overflow="hidden" whiteSpace="nowrap" textOverflow="ellipsis">
                  {track.title}
                </Text>
                <Text fontSize="10px" color="#555">
                  {track.bpm} BPM · {track.genre}
                </Text>
              </Box>
              <Text fontSize="11px" color="#555" fontFamily="mono">
                {track.duration}
              </Text>
            </Flex>
          );
        })}

        {filtered.length === 0 && (
          <Flex direction="column" align="center" py="24px" gap="8px">
            <Music size={24} color="#333" />
            <Text fontSize="12px" color="#444">No tracks found</Text>
          </Flex>
        )}
      </Stack>

      {/* Volume control */}
      <Box
        mx="12px"
        mb="12px"
        p="12px"
        bg="#1a1a1a"
        borderRadius="8px"
        border="1px solid #252525"
      >
        <Flex align="center" gap="8px">
          <Volume2 size={14} color="#555" />
          <Slider.Root
            value={[volume]}
            min={0}
            max={100}
            onValueChange={(e) => setVolume(e.value[0]!)}
            size="sm"
            colorPalette="purple"
            flex="1"
          >
            <Slider.Control>
              <Slider.Track>
                <Slider.Range />
              </Slider.Track>
              <Slider.Thumbs />
            </Slider.Control>
          </Slider.Root>
          <Text fontSize="11px" color="#666" fontFamily="mono" w="28px" textAlign="right">
            {volume}%
          </Text>
        </Flex>
      </Box>
    </Stack>
  );
}

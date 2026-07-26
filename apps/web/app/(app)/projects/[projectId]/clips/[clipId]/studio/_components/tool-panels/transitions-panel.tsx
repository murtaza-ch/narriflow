"use client";

import { useState } from "react";
import { Box, Flex, Text, Stack, Slider } from "@chakra-ui/react";
import { Zap } from "lucide-react";
import { useStudio } from "../studio-shell";

const TRANSITIONS = [
  { id: "none", label: "Cut" },
  { id: "fade", label: "Fade" },
  { id: "dip-white", label: "Dip White" },
] as const;

export function TransitionsPanel() {
  const { studioEdits, setStudioEdits } = useStudio();
  const [selected, setSelected] = useState(studioEdits.transition.type);
  const [duration, setDuration] = useState(studioEdits.transition.durationSec);

  return (
    <Stack gap="16px" p="12px">
      {/* Transition grid */}
      <Box>
        <Text textStyle="eyebrow" color="studio.fgMuted" mb="10px">
          Style
        </Text>
        <Box
          display="grid"
          style={{ gridTemplateColumns: "repeat(3, 1fr)", gap: "6px" }}
        >
          {TRANSITIONS.map((t) => {
            const isActive = selected === t.id;
            return (
              <Flex
                key={t.id}
                as="button"
                aria-pressed={isActive}
                direction="column"
                align="center"
                justify="center"
                gap="6px"
                py="14px"
                borderRadius="l2"
                bg={isActive ? "studio.raised" : "studio.subtle"}
                border="1px solid"
                borderColor={isActive ? "studio.accent" : "studio.border"}
                cursor="pointer"
                onClick={() => setSelected(t.id)}
                transition="background 120ms ease, border-color 120ms ease"
                _hover={{ borderColor: isActive ? "studio.accent" : "studio.borderStrong" }}
              >
                <Text fontSize="11px" color={isActive ? "studio.accentFg" : "studio.fgMuted"} fontWeight="500">
                  {t.label}
                </Text>
              </Flex>
            );
          })}
        </Box>
      </Box>

      {/* Duration */}
      <Box>
        <Flex align="center" justify="space-between" mb="8px">
          <Text textStyle="eyebrow" color="studio.fgMuted">
            Duration
          </Text>
          <Text textStyle="data" fontSize="11px" color="studio.timecode">{duration.toFixed(1)}s</Text>
        </Flex>
        <Slider.Root
          aria-label={["Transition duration"]}
          value={[duration]}
          min={0.1}
          max={1.5}
          step={0.05}
          onValueChange={(e) => setDuration(e.value[0]!)}
          size="sm"
          colorPalette="accent"
          w="100%"
        >
          <Slider.Control>
            <Slider.Track>
              <Slider.Range />
            </Slider.Track>
            <Slider.Thumbs />
          </Slider.Control>
        </Slider.Root>
        <Flex justify="space-between" mt="4px">
          <Text textStyle="data" fontSize="10.5px" color="studio.fgSubtle">0.1s</Text>
          <Text textStyle="data" fontSize="10.5px" color="studio.fgSubtle">1.5s</Text>
        </Flex>
      </Box>

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
        onClick={() =>
          setStudioEdits((prev) => ({
            ...prev,
            transition: { type: selected, durationSec: duration },
          }))
        }
      >
        <Zap size={13} />
        Apply transition
      </Flex>
    </Stack>
  );
}

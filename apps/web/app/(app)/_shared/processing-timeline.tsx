"use client";

import { Box, Flex, Slider, Text } from "@chakra-ui/react";
import { formatTimecode } from "@/lib/format";

interface ProcessingTimelineProps {
  durationSec: number | null;
  startSec: number;
  endSec: number;
  disabled?: boolean;
  hasSource?: boolean;
  onChange: (start: number, end: number) => void;
}

/**
 * Dual-handle trim range for the processing timeframe ("credit saver").
 * Built on the Chakra v3 Slider in range mode: two thumbs, keyboard
 * nudging (arrow keys, Home/End) and per-thumb aria labels come from the
 * slider machine; a minimum 1-second gap is enforced between the handles.
 */
export function ProcessingTimeline({
  durationSec,
  startSec,
  endSec,
  disabled,
  hasSource,
  onChange,
}: ProcessingTimelineProps) {
  const max = durationSec && durationSec > 0 ? durationSec : 0;
  // Keep the slider well-formed while duration is unknown: full-range
  // handles on a unit track, interaction off.
  const sliderMax = max > 0 ? max : 1;
  const interactive = !disabled && max > 0;

  const start = Math.min(Math.max(0, startSec), sliderMax);
  const end = max > 0 ? Math.min(Math.max(start, endSec), sliderMax) : sliderMax;

  const showDetecting = disabled && hasSource && !durationSec;

  return (
    <Box opacity={disabled ? 0.5 : 1}>
      <Flex justify="space-between" align="center" mb="10px">
        <Flex align="center" gap="8px">
          <Text textStyle="eyebrow" color="fg.subtle">
            Processing timeframe
          </Text>
          {showDetecting && (
            <Flex align="center" gap="6px">
              <Box w="6px" h="6px" borderRadius="1px" bg="accent.solid" />
              <Text fontSize="11px" fontFamily="mono" color="fg.subtle">
                Detecting duration…
              </Text>
            </Flex>
          )}
        </Flex>
      </Flex>
      <Text fontSize="11px" color="fg.muted" mb="10px" lineHeight="1.5">
        Narrows what we analyze for clips. Your plan is charged for the full
        source length.
      </Text>

      <Box pt="8px" pb="4px" px="2px">
        <Slider.Root
          width="100%"
          value={[start, end]}
          min={0}
          max={sliderMax}
          step={1}
          minStepsBetweenThumbs={1}
          disabled={!interactive}
          aria-label={["Start time", "End time"]}
          getAriaValueText={({ value }) => formatTimecode(value)}
          onValueChange={(details) => {
            const [nextStart, nextEnd] = details.value;
            if (nextStart === undefined || nextEnd === undefined) return;
            onChange(Math.max(0, nextStart), Math.min(sliderMax, nextEnd));
          }}
        >
          <Slider.Control>
            <Slider.Track bg="bg.muted" h="3px" borderRadius="full">
              <Slider.Range bg="accent.solid" />
            </Slider.Track>
            <Slider.Thumb
              index={0}
              boxSize="14px"
              borderRadius="full"
              bg="bg"
              borderWidth="1.5px"
              borderColor="border.control"
              boxShadow="card"
              cursor={interactive ? "grab" : "not-allowed"}
              _active={{ cursor: interactive ? "grabbing" : "not-allowed" }}
            >
              <Slider.HiddenInput />
            </Slider.Thumb>
            <Slider.Thumb
              index={1}
              boxSize="14px"
              borderRadius="full"
              bg="bg"
              borderWidth="1.5px"
              borderColor="border.control"
              boxShadow="card"
              cursor={interactive ? "grab" : "not-allowed"}
              _active={{ cursor: interactive ? "grabbing" : "not-allowed" }}
            >
              <Slider.HiddenInput />
            </Slider.Thumb>
          </Slider.Control>
        </Slider.Root>

        <Flex justify="space-between" mt="12px">
          <Box
            px="10px"
            py="4px"
            fontSize="11px"
            textStyle="data"
            color="fg"
            bg="bg.subtle"
            borderRadius="l1"
            borderWidth="1px"
            borderColor="border"
          >
            {formatTimecode(startSec)}
          </Box>
          <Box
            px="10px"
            py="4px"
            fontSize="11px"
            textStyle="data"
            color="fg"
            bg="bg.subtle"
            borderRadius="l1"
            borderWidth="1px"
            borderColor="border"
          >
            {formatTimecode(endSec)}
          </Box>
        </Flex>
      </Box>
    </Box>
  );
}

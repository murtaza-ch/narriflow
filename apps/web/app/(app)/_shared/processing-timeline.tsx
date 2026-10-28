"use client";

import { useState } from "react";
import { Box, chakra, Flex, Slider, Text } from "@chakra-ui/react";
import { formatDuration, formatTimecode } from "@/lib/format";
import { ChoiceChip } from "./choice-chip";

interface ProcessingTimelineProps {
  durationSec: number | null;
  startSec: number;
  endSec: number;
  disabled?: boolean;
  hasSource?: boolean;
  /** Frames from across the source, drawn as a film strip behind the range. */
  frames?: string[];
  onChange: (start: number, end: number) => void;
}

/** Shortcuts worth a tap: only offered when they'd be a real part of the source. */
const PRESET_SEC = 10 * 60;

/**
 * Dual-handle trim range for the processing timeframe ("credit saver").
 * Built on the Chakra v3 Slider in range mode: two thumbs, keyboard
 * nudging (arrow keys, Home/End) and per-thumb aria labels come from the
 * slider machine; a minimum 1-second gap is enforced between the handles.
 * Drawn like an editor's trim bar: the source as a strip, the part outside
 * the range dimmed, grab handles at either end.
 */
export function ProcessingTimeline({
  durationSec,
  startSec,
  endSec,
  disabled,
  hasSource,
  frames = [],
  onChange,
}: ProcessingTimelineProps) {
  const max = durationSec && durationSec > 0 ? durationSec : 0;
  // Keep the slider well-formed while duration is unknown: full-range
  // handles on a unit track, interaction off.
  const sliderMax = max > 0 ? max : 1;
  const interactive = !disabled && max > 0;

  const start = Math.min(Math.max(0, startSec), sliderMax);
  const end = max > 0 ? Math.min(Math.max(start, endSec), sliderMax) : sliderMax;
  const startPct = (start / sliderMax) * 100;
  const endPct = (end / sliderMax) * 100;
  const whole = max > 0 && start <= 0 && end >= max;

  const showDetecting = disabled && hasSource && !durationSec;
  // A frame that fails to load leaves the strip's soft fill, not a broken image.
  const [brokenFrames, setBrokenFrames] = useState<string[]>([]);
  const strip = frames.filter((frame) => !brokenFrames.includes(frame));

  const presets =
    max > PRESET_SEC * 1.2
      ? [
          { label: "Whole video", range: [0, max] as const },
          { label: "First 10 min", range: [0, PRESET_SEC] as const },
          { label: "Last 10 min", range: [max - PRESET_SEC, max] as const },
        ]
      : [];

  return (
    <Box opacity={disabled ? 0.5 : 1}>
      <Flex justify="space-between" align="center" gap="3" mb="1">
        <Text fontSize="14px" fontWeight="500" color="fg">
          Part of the video
        </Text>
        {showDetecting ? (
          <Text fontSize="12px" color="fg.subtle">
            Detecting length…
          </Text>
        ) : max > 0 ? (
          <Text
            fontSize="12px"
            fontWeight="500"
            px="2"
            py="0.5"
            borderRadius="full"
            bg={whole ? "bg.soft" : "accent.subtle"}
            color={whole ? "fg.muted" : "accent.fg"}
            fontVariantNumeric="tabular-nums"
          >
            {whole ? `All ${formatDuration(max)}` : `${formatDuration(end - start)} of ${formatDuration(max)}`}
          </Text>
        ) : null}
      </Flex>
      <Text fontSize="12px" color="fg.muted" mb="4">
        Clips come only from this part. Credits cover the whole video.
      </Text>

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
        <Slider.Control position="relative" h="12">
          {/* The source as a strip: frames when there are any, a soft fill otherwise. */}
          <Flex position="absolute" inset="0" borderRadius="l2" overflow="hidden" bg="bg.soft" pointerEvents="none">
            {strip.length === 0 ? <Ruler /> : null}
            {strip.map((frame) => (
              <chakra.img
                key={frame}
                src={frame}
                alt=""
                flex="1"
                minW="0"
                h="full"
                objectFit="cover"
                onError={() => setBrokenFrames((current) => [...current, frame])}
              />
            ))}
            {/* What's left out of the range dims away. */}
            <Box position="absolute" top="0" bottom="0" left="0" bg="blackAlpha.700" style={{ width: `${startPct}%` }} />
            <Box position="absolute" top="0" bottom="0" right="0" bg="blackAlpha.700" style={{ width: `${100 - endPct}%` }} />
          </Flex>
          <Slider.Track h="full" bg="transparent">
            <Slider.Range bg="accent.solid/15" />
          </Slider.Track>
          {[0, 1].map((index) => (
            <Slider.Thumb
              key={index}
              index={index}
              w="3"
              h="12"
              borderRadius="4px"
              bg="accent.solid"
              display="flex"
              alignItems="center"
              justifyContent="center"
              cursor={interactive ? "ew-resize" : "not-allowed"}
              _focusVisible={{ outline: "2px solid", outlineColor: "accent.fg", outlineOffset: "2px" }}
            >
              <Box w="2px" h="4" borderRadius="full" bg="accent.contrast" opacity={0.85} />
              <Slider.HiddenInput />
            </Slider.Thumb>
          ))}
        </Slider.Control>
      </Slider.Root>

      <Flex justify="space-between" align="center" mt="3" gap="2">
        <TimeChip>{formatTimecode(start)}</TimeChip>
        <TimeChip>{formatTimecode(max > 0 ? end : endSec)}</TimeChip>
      </Flex>

      {presets.length > 0 && interactive ? (
        <Flex gap="1.5" wrap="wrap" mt="3">
          {presets.map((preset) => {
            const active = Math.round(preset.range[0]) === Math.round(start) && Math.round(preset.range[1]) === Math.round(end);
            return (
              <ChoiceChip
                key={preset.label}
                on={active}
                showMark={false}
                onToggle={() => onChange(Math.max(0, preset.range[0]), Math.min(max, preset.range[1]))}
              >
                {preset.label}
              </ChoiceChip>
            );
          })}
        </Flex>
      ) : null}
    </Box>
  );
}

const RULER_TICKS = 48;

/** With no frames to show, the strip reads as a timeline: even ticks, a taller one every sixth. */
function Ruler() {
  return (
    <Flex position="absolute" inset="0" align="center" justify="space-between" px="3" aria-hidden>
      {Array.from({ length: RULER_TICKS + 1 }, (_, index) => (
        <Box
          key={index}
          w="1px"
          h={index % 6 === 0 ? "45%" : "22%"}
          borderRadius="full"
          bg={index % 6 === 0 ? "fg.subtle" : "border.emphasized"}
        />
      ))}
    </Flex>
  );
}

function TimeChip({ children }: { children: string }) {
  return (
    <Box px="2.5" py="1" fontSize="12px" textStyle="data" color="fg" bg="bg.soft" borderRadius="l1">
      {children}
    </Box>
  );
}

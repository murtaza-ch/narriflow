"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Flex, Text } from "@chakra-ui/react";
import { formatTimecode } from "../_lib/format-time";

interface ProcessingTimelineProps {
  durationSec: number | null;
  startSec: number;
  endSec: number;
  disabled?: boolean;
  hasSource?: boolean;
  onChange: (start: number, end: number) => void;
}

const HANDLE_WIDTH = 14;

export function ProcessingTimeline({
  durationSec,
  startSec,
  endSec,
  disabled,
  hasSource,
  onChange,
}: ProcessingTimelineProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState<"start" | "end" | null>(null);

  const max = durationSec && durationSec > 0 ? durationSec : 0;
  const startPct = max > 0 ? (startSec / max) * 100 : 0;
  const endPct = max > 0 ? (endSec / max) * 100 : 100;

  const positionToSeconds = useCallback(
    (clientX: number): number => {
      const track = trackRef.current;
      if (!track || max <= 0) return 0;
      const rect = track.getBoundingClientRect();
      const ratio = (clientX - rect.left) / rect.width;
      const clamped = Math.min(1, Math.max(0, ratio));
      return Math.round(clamped * max);
    },
    [max],
  );

  useEffect(() => {
    if (!dragging) return;

    function onPointerMove(event: PointerEvent) {
      const sec = positionToSeconds(event.clientX);
      if (dragging === "start") {
        const next = Math.min(sec, endSec - 1);
        onChange(Math.max(0, next), endSec);
      } else {
        const next = Math.max(sec, startSec + 1);
        onChange(startSec, Math.min(max, next));
      }
    }

    function onPointerUp() {
      setDragging(null);
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [dragging, endSec, max, onChange, positionToSeconds, startSec]);

  function handlePointerDown(handle: "start" | "end") {
    return (event: React.PointerEvent) => {
      if (disabled) return;
      event.preventDefault();
      setDragging(handle);
    };
  }

  const showDetecting = disabled && hasSource && !durationSec;

  return (
    <Box opacity={disabled ? 0.5 : 1}>
      <Flex justify="space-between" align="center" mb="10px">
        <Flex align="center" gap="8px">
          <Text fontSize="13px" fontWeight="500" color="fg">
            Processing timeframe
          </Text>
          {showDetecting && (
            <Text fontSize="11px" color="fg.subtle">
              Detecting duration…
            </Text>
          )}
        </Flex>
        <Box
          px="8px"
          py="2px"
          fontSize="11px"
          fontWeight="500"
          color="success.fg"
          bg="success.subtle"
          borderRadius="999px"
        >
          Credit saver
        </Box>
      </Flex>

      <Box position="relative" pt="18px" pb="22px" px="2px">
        <Box
          ref={trackRef}
          position="relative"
          height="6px"
          bg="bg.muted"
          borderRadius="999px"
          cursor={disabled ? "not-allowed" : "default"}
        >
          <Box
            position="absolute"
            top="0"
            bottom="0"
            left={`${startPct}%`}
            right={`${100 - endPct}%`}
            bg="accent.solid"
            borderRadius="999px"
          />

          <Box
            position="absolute"
            top="50%"
            left={`${startPct}%`}
            transform={`translate(-50%, -50%)`}
            width={`${HANDLE_WIDTH}px`}
            height={`${HANDLE_WIDTH}px`}
            borderRadius="999px"
            bg="bg"
            borderWidth="2px"
            borderColor="accent.solid"
            cursor={disabled ? "not-allowed" : "grab"}
            onPointerDown={handlePointerDown("start")}
            _active={{ cursor: "grabbing" }}
            boxShadow="0 1px 4px rgba(0,0,0,0.15)"
            touchAction="none"
          />
          <Box
            position="absolute"
            top="50%"
            left={`${endPct}%`}
            transform={`translate(-50%, -50%)`}
            width={`${HANDLE_WIDTH}px`}
            height={`${HANDLE_WIDTH}px`}
            borderRadius="999px"
            bg="bg"
            borderWidth="2px"
            borderColor="accent.solid"
            cursor={disabled ? "not-allowed" : "grab"}
            onPointerDown={handlePointerDown("end")}
            _active={{ cursor: "grabbing" }}
            boxShadow="0 1px 4px rgba(0,0,0,0.15)"
            touchAction="none"
          />
        </Box>

        <Flex justify="space-between" mt="14px">
          <Box
            px="10px"
            py="4px"
            fontSize="11px"
            color="fg"
            bg="bg.subtle"
            borderRadius="6px"
            borderWidth="1px"
            borderColor="border"
            fontVariantNumeric="tabular-nums"
          >
            {formatTimecode(startSec)}
          </Box>
          <Box
            px="10px"
            py="4px"
            fontSize="11px"
            color="fg"
            bg="bg.subtle"
            borderRadius="6px"
            borderWidth="1px"
            borderColor="border"
            fontVariantNumeric="tabular-nums"
          >
            {formatTimecode(endSec)}
          </Box>
        </Flex>
      </Box>

      <input type="hidden" name="processingStartSec" value={String(startSec)} />
      <input type="hidden" name="processingEndSec" value={String(endSec)} />
    </Box>
  );
}

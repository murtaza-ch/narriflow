"use client";

import { useEffect, useRef, useState } from "react";
import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { AlertTriangle, Film, Play } from "lucide-react";
import { Spinner } from "@narriflow/ui/components/spinner";
import { formatDuration } from "@/lib/format";

/**
 * The export itself as its thumbnail: the first frame of the rendered file,
 * loaded only once the card is on screen, playing muted while hovered.
 * Before a file exists it shows the render's progress or failure instead.
 */
export function ExportPreview({
  src,
  ratio,
  status,
  progress,
  compact = false,
}: {
  /** The ready variant's file, or `null` while none is ready. */
  src: string | null;
  /** The frame's width over height, e.g. 9/16. */
  ratio: number;
  status: "queued" | "rendering" | "partial_ready" | "ready" | "failed";
  progress: number;
  /** Small list-row thumbnail: no chips, no hover playback. */
  compact?: boolean;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [visible, setVisible] = useState(false);
  const [duration, setDuration] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const element = frame.current;
    if (!element || !src) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: "200px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [src]);

  function play() {
    if (compact || !video.current) return;
    void video.current.play().then(() => setPlaying(true)).catch(() => undefined);
  }
  function stop() {
    if (!video.current) return;
    video.current.pause();
    video.current.currentTime = 0.1;
    setPlaying(false);
  }

  const rendering = status === "queued" || status === "rendering";
  return (
    <Box
      ref={frame}
      position="relative"
      w="full"
      h="full"
      bg="studio.canvas"
      overflow="hidden"
      onMouseEnter={play}
      onMouseLeave={stop}
    >
      {src && visible ? (
        <video
          ref={video}
          src={`${src}#t=0.1`}
          muted
          playsInline
          loop
          preload="metadata"
          onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
          style={{ width: "100%", height: "100%", objectFit: ratio < 1 ? "cover" : "contain", display: "block" }}
        />
      ) : (
        <Stack position="absolute" inset="0" align="center" justify="center" gap="2" color="studio.fgMuted" px="3" textAlign="center">
          {rendering ? (
            <>
              <Spinner size={compact ? "xs" : "sm"} />
              {compact ? null : (
                <Text fontSize="12px" fontVariantNumeric="tabular-nums">
                  {status === "queued" ? "Queued" : `Rendering ${progress}%`}
                </Text>
              )}
            </>
          ) : status === "failed" ? (
            <>
              <AlertTriangle size={compact ? 14 : 18} />
              {compact ? null : <Text fontSize="12px">Render failed</Text>}
            </>
          ) : (
            <Film size={compact ? 14 : 20} />
          )}
        </Stack>
      )}

      {rendering && !compact ? (
        <Box position="absolute" left="3" right="3" bottom="3" h="4px" borderRadius="full" bg="studio.raised" overflow="hidden">
          <Box h="full" borderRadius="full" bg="studio.accent" transition="width 400ms ease" style={{ width: `${Math.max(4, progress)}%` }} />
        </Box>
      ) : null}

      {src && !compact && !playing ? (
        <Flex
          position="absolute"
          inset="0"
          align="center"
          justify="center"
          opacity="0"
          transition="opacity 150ms ease"
          _groupHover={{ opacity: 1 }}
          pointerEvents="none"
        >
          <Flex boxSize="10" borderRadius="full" bg="studio.scrim" color="studio.fg" align="center" justify="center" backdropFilter="blur(6px)">
            <Play size={16} fill="currentColor" style={{ marginLeft: 2 }} />
          </Flex>
        </Flex>
      ) : null}

      {duration && !compact ? (
        <Box
          position="absolute"
          bottom="2"
          right="2"
          px="1.5"
          py="0.5"
          borderRadius="l1"
          bg="studio.scrim"
          color="studio.timecode"
          textStyle="data"
          fontSize="11px"
          pointerEvents="none"
        >
          {formatDuration(duration)}
        </Box>
      ) : null}
    </Box>
  );
}

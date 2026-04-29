"use client";

import { useEffect, useId, useMemo, useRef } from "react";
import { Box, Flex, Text } from "@chakra-ui/react";
import { Play } from "lucide-react";
import { extractYoutubeId, youtubeThumbnailUrl } from "../../projects/_lib/youtube";

type YtPlayer = {
  getDuration: () => number;
  destroy: () => void;
};

type YtNamespace = {
  Player: new (
    target: HTMLElement | string,
    config: {
      videoId: string;
      playerVars?: Record<string, string | number>;
      host?: string;
      events?: {
        onReady?: (event: { target: YtPlayer }) => void;
      };
    },
  ) => YtPlayer;
};

declare global {
  interface Window {
    YT?: YtNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

const YT_SCRIPT_SRC = "https://www.youtube.com/iframe_api";
let ytApiPromise: Promise<YtNamespace> | null = null;

function loadYoutubeApi(): Promise<YtNamespace> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("YT api unavailable on server"));
  }
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (ytApiPromise) return ytApiPromise;

  ytApiPromise = new Promise((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      if (window.YT?.Player) resolve(window.YT);
      else reject(new Error("YT api initialised without Player"));
    };

    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${YT_SCRIPT_SRC}"]`,
    );
    if (existing) return;

    const script = document.createElement("script");
    script.src = YT_SCRIPT_SRC;
    script.async = true;
    script.onerror = () => reject(new Error("Failed to load YouTube IFrame API"));
    document.head.appendChild(script);
  });

  return ytApiPromise;
}

interface VideoPreviewProps {
  source:
    | { kind: "file"; file: File }
    | { kind: "youtube"; url: string }
    | {
        kind: "rss";
        thumbnailUrl?: string | null;
        title?: string | null;
        durationSeconds?: number | null;
      }
    | null;
  onDurationKnown: (seconds: number) => void;
}

function YoutubePreview({
  videoId,
  onDurationKnown,
}: {
  videoId: string;
  onDurationKnown: (seconds: number) => void;
}) {
  const playerHostId = useId();
  const playerRef = useRef<YtPlayer | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadYoutubeApi()
      .then((YT) => {
        if (cancelled) return;
        const target = document.getElementById(playerHostId);
        if (!target) return;
        playerRef.current = new YT.Player(target, {
          videoId,
          host: "https://www.youtube-nocookie.com",
          playerVars: { rel: 0, modestbranding: 1, playsinline: 1 },
          events: {
            onReady: (event) => {
              const seconds = event.target.getDuration();
              if (Number.isFinite(seconds) && seconds > 0) {
                onDurationKnown(Math.floor(seconds));
              }
            },
          },
        });
      })
      .catch(() => {
        // Fallback: leave duration unknown; user can still proceed without trim.
      });

    return () => {
      cancelled = true;
      try {
        playerRef.current?.destroy();
      } catch {
        // ignore
      }
      playerRef.current = null;
    };
  }, [videoId, playerHostId, onDurationKnown]);

  return (
    <Box
      position="relative"
      borderRadius="12px"
      overflow="hidden"
      borderWidth="1px"
      borderColor="border"
      bg="black"
      style={{ aspectRatio: "16 / 9" }}
    >
      <Box
        id={playerHostId}
        position="absolute"
        inset="0"
        width="100%"
        height="100%"
      />
    </Box>
  );
}

export function VideoPreview({ source, onDurationKnown }: VideoPreviewProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const objectUrl = useMemo(() => {
    if (source?.kind === "file") return URL.createObjectURL(source.file);
    return null;
  }, [source]);

  // Forward RSS-known duration upward so the timeline becomes interactive.
  useEffect(() => {
    if (
      source?.kind === "rss" &&
      typeof source.durationSeconds === "number" &&
      source.durationSeconds > 0
    ) {
      onDurationKnown(Math.floor(source.durationSeconds));
    }
  }, [source, onDurationKnown]);

  useEffect(() => {
    if (!objectUrl) return;
    return () => URL.revokeObjectURL(objectUrl);
  }, [objectUrl]);

  if (!source) {
    return (
      <Flex
        align="center"
        justify="center"
        direction="column"
        gap="6px"
        h="220px"
        borderRadius="12px"
        bg="bg.subtle"
        borderWidth="1px"
        borderColor="border"
        borderStyle="dashed"
      >
        <Box color="fg.subtle">
          <Play size={22} />
        </Box>
        <Text fontSize="12px" color="fg.subtle">
          Add a source to preview
        </Text>
      </Flex>
    );
  }

  if (source.kind === "file" && objectUrl) {
    return (
      <Box
        borderRadius="12px"
        overflow="hidden"
        borderWidth="1px"
        borderColor="border"
        bg="black"
      >
        <video
          ref={videoRef}
          src={objectUrl}
          controls
          preload="metadata"
          onLoadedMetadata={(event) => {
            const duration = event.currentTarget.duration;
            if (Number.isFinite(duration)) {
              onDurationKnown(Math.floor(duration));
            }
          }}
          style={{ width: "100%", display: "block", maxHeight: "320px" }}
        />
      </Box>
    );
  }

  if (source.kind === "youtube") {
    const id = extractYoutubeId(source.url);
    if (!id) {
      return (
        <Box
          h="160px"
          borderRadius="12px"
          bg="bg.subtle"
          borderWidth="1px"
          borderColor="border"
          p="14px"
        >
          <Text fontSize="13px" color="fg.muted">
            Paste a valid YouTube link to preview the video.
          </Text>
        </Box>
      );
    }
    return <YoutubePreview videoId={id} onDurationKnown={onDurationKnown} />;
  }

  if (source.kind === "rss") {
    return (
      <Flex
        gap="14px"
        p="14px"
        borderRadius="12px"
        bg="bg.subtle"
        borderWidth="1px"
        borderColor="border"
      >
        {source.thumbnailUrl ? (
          <Box
            w="120px"
            h="120px"
            borderRadius="8px"
            overflow="hidden"
            flexShrink={0}
            bg="black"
          >
            <img
              src={source.thumbnailUrl}
              alt={source.title ?? "Episode artwork"}
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
          </Box>
        ) : null}
        <Box>
          <Text fontSize="11px" color="fg.subtle" mb="4px" textTransform="uppercase" letterSpacing="0.04em">
            RSS episode
          </Text>
          <Text fontSize="14px" fontWeight="600" color="fg">
            {source.title ?? "Selected episode"}
          </Text>
          <Text fontSize="12px" color="fg.muted" mt="6px">
            We will fetch this episode and run your generation settings on it.
          </Text>
        </Box>
      </Flex>
    );
  }

  return null;
}

export const youtubePreviewThumbnail = youtubeThumbnailUrl;

"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Box, Flex, Text } from "@chakra-ui/react";
import { Link2, Play, FileVideo } from "lucide-react";
import { MediaWell } from "@narriflow/ui/components/media-well";
import { GhostFrame } from "@narriflow/ui/components/ghost-frame";
import type { LinkProviderId } from "@narriflow/validators";
import { LINK_PROVIDERS } from "@narriflow/validators";
import { attachLocalMediaPreview } from "../_lib/local-media-preview";
import { formatTimecode } from "@/lib/format";
import {
  extractYoutubeId,
  youtubeThumbnailUrl,
} from "../../projects/_lib/youtube";

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
    script.onerror = () =>
      reject(new Error("Failed to load YouTube IFrame API"));
    document.head.appendChild(script);
  });

  return ytApiPromise;
}

interface VideoPreviewProps {
  source:
    | { kind: "file"; file: File }
    | { kind: "link"; url: string; provider: LinkProviderId }
    | {
        kind: "rss";
        thumbnailUrl?: string | null;
        title?: string | null;
        durationSeconds?: number | null;
      }
    | null;
  onDurationKnown: (seconds: number) => void;
  /** Detected source duration — rendered as the MediaWell timecode chip. */
  durationSec?: number | null;
}

function linkProviderLabel(provider: LinkProviderId): string {
  return LINK_PROVIDERS.find((p) => p.id === provider)?.label ?? "Link";
}

/** Neutral placeholder for link providers other than YouTube — no
 *  client-side preview is possible before import runs. */
function LinkPreview({
  url,
  provider,
}: {
  url: string;
  provider: LinkProviderId;
}) {
  return (
    <Flex gap="4" p="4" layerStyle="well" align="flex-start">
      <MediaWell ratio={1} w="64px" flexShrink={0}>
        <Flex
          align="center"
          justify="center"
          position="absolute"
          inset="0"
          color="studio.fgMuted"
        >
          <Link2 size={20} strokeWidth={1.75} />
        </Flex>
      </MediaWell>
      <Box minW="0">
        <Text textStyle="eyebrow" color="fg.subtle" mb="1">
          {linkProviderLabel(provider)}
        </Text>
        <Text fontSize="13px" color="fg" truncate>
          {url}
        </Text>
        <Text fontSize="12px" color="fg.muted" mt="1.5">
          Preview appears after import — the video is fetched and its duration
          detected during processing.
        </Text>
      </Box>
    </Flex>
  );
}

function YoutubePreview({
  videoId,
  onDurationKnown,
  durationSec,
}: {
  videoId: string;
  onDurationKnown: (seconds: number) => void;
  durationSec?: number | null;
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
    <MediaWell
      ratio={16 / 9}
      timecode={durationSec ? formatTimecode(durationSec) : undefined}
    >
      <Box
        id={playerHostId}
        position="absolute"
        inset="0"
        width="100%"
        height="100%"
      />
    </MediaWell>
  );
}

function LocalVideoPreview({
  file,
  onDurationKnown,
  durationSec,
}: {
  file: File;
  onDurationKnown: (seconds: number) => void;
  durationSec?: number | null;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    setUnavailable(false);
    const detach = attachLocalMediaPreview(video, file);
    const timeout = window.setTimeout(() => {
      if (video.readyState === 0) setUnavailable(true);
    }, 15000);
    return () => {
      window.clearTimeout(timeout);
      detach();
    };
  }, [file]);
  return (
    <MediaWell
      ratio={16 / 9}
      timecode={durationSec ? formatTimecode(durationSec) : undefined}
    >
      {/* biome-ignore lint/a11y/useMediaCaption: source preview precedes transcription; no captions exist yet. */}
      <video
        ref={videoRef}
        controls
        playsInline
        preload="metadata"
        onError={() => setUnavailable(true)}
        onLoadedMetadata={(event) => {
          const seconds = event.currentTarget.duration;
          if (Number.isFinite(seconds) && seconds > 0) {
            setUnavailable(false);
            onDurationKnown(Math.floor(seconds));
          }
        }}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "contain",
        }}
      />
      {unavailable && (
        <Flex
          role="status"
          position="absolute"
          inset="0"
          direction="column"
          align="center"
          justify="center"
          gap="2"
          p="3"
          bg="studio.canvas"
          color="studio.fgMuted"
          textAlign="center"
        >
          <FileVideo size={22} />
          <Text fontSize="11px">Browser preview unavailable.</Text>
          <Text fontSize="10px">You can still upload this file.</Text>
        </Flex>
      )}
    </MediaWell>
  );
}

export function VideoPreview({
  source,
  onDurationKnown,
  durationSec,
}: VideoPreviewProps) {
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

  if (!source) {
    return (
      <Flex align="center" justify="center" py="8">
        <GhostFrame ratio={16 / 9} size="220px">
          <Flex direction="column" align="center" gap="2">
            <Play size={18} strokeWidth={1.75} />
            <Text textStyle="eyebrow" color="fg.subtle">
              Add a source to preview
            </Text>
          </Flex>
        </GhostFrame>
      </Flex>
    );
  }

  if (source.kind === "file") {
    return (
      <LocalVideoPreview
        file={source.file}
        onDurationKnown={onDurationKnown}
        durationSec={durationSec}
      />
    );
  }

  if (source.kind === "link" && source.provider === "youtube") {
    const id = extractYoutubeId(source.url);
    if (!id) {
      return (
        <Box layerStyle="well" p="4">
          <Text fontSize="13px" color="fg.muted">
            Paste a valid YouTube link to preview the video.
          </Text>
        </Box>
      );
    }
    return (
      <YoutubePreview
        videoId={id}
        onDurationKnown={onDurationKnown}
        durationSec={durationSec}
      />
    );
  }

  if (source.kind === "link") {
    return <LinkPreview url={source.url} provider={source.provider} />;
  }

  if (source.kind === "rss") {
    return (
      <Flex gap="4" p="4" layerStyle="well" align="flex-start">
        {source.thumbnailUrl ? (
          <MediaWell ratio={1} w="96px" flexShrink={0}>
            <img
              src={source.thumbnailUrl}
              alt={source.title ?? "Episode artwork"}
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                objectFit: "cover",
              }}
            />
          </MediaWell>
        ) : null}
        <Box minW="0">
          <Text textStyle="eyebrow" color="fg.subtle" mb="1">
            RSS episode
          </Text>
          <Text fontSize="14px" textStyle="title" color="fg">
            {source.title ?? "Selected episode"}
          </Text>
          <Text fontSize="12px" color="fg.muted" mt="1.5">
            We will fetch this episode and run your generation settings on it.
          </Text>
        </Box>
      </Flex>
    );
  }

  return null;
}

export const youtubePreviewThumbnail = youtubeThumbnailUrl;

"use client";

import { useEffect, useRef, useState } from "react";
import { Box, Flex, Stack, Text, chakra } from "@chakra-ui/react";
import { AudioLines, Pause, Play } from "lucide-react";
import { Spinner } from "@narriflow/ui/components/spinner";
import { toaster } from "@narriflow/ui/components/toaster";
import { formatDuration } from "@/lib/format";
import { failureMessage, useBrandApi } from "./brand-api";
import { MembershipRemoveButton } from "./profile-membership";

/** One shared <audio> per list: starting a track stops the one before it. */
export function useAudioPreview() {
  const { queries, queryClient } = useBrandApi();
  const audio = useRef<HTMLAudioElement | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const element = new Audio();
    element.preload = "none";
    const onTime = () => setProgress(element.duration ? element.currentTime / element.duration : 0);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => {
      setPlaying(false);
      setProgress(0);
    };
    element.addEventListener("timeupdate", onTime);
    element.addEventListener("play", onPlay);
    element.addEventListener("pause", onPause);
    element.addEventListener("ended", onEnded);
    audio.current = element;
    return () => {
      element.pause();
      element.removeEventListener("timeupdate", onTime);
      element.removeEventListener("play", onPlay);
      element.removeEventListener("pause", onPause);
      element.removeEventListener("ended", onEnded);
      audio.current = null;
    };
  }, []);

  // Each start supersedes the one before; a superseded request's result is dropped.
  const request = useRef(0);
  async function toggle(id: string) {
    const element = audio.current;
    if (!element) return;
    if (activeId === id && loadingId !== id) {
      if (element.paused) await element.play().catch(() => undefined);
      else element.pause();
      return;
    }
    const ticket = ++request.current;
    element.pause();
    setActiveId(id);
    setProgress(0);
    setLoadingId(id);
    try {
      // A short-lived signed link, refetched on every start.
      const { url } = await queryClient.fetchQuery(queries.audioPlaybackUrl(id));
      if (ticket !== request.current) return;
      element.src = url;
      await element.play();
    } catch (error) {
      // A newer start pauses this one, which rejects its play() with AbortError.
      if (ticket !== request.current || (error instanceof DOMException && error.name === "AbortError")) return;
      setActiveId(null);
      toaster.create({ type: "error", title: "Couldn't play this audio", description: failureMessage(error) });
    } finally {
      if (ticket === request.current) setLoadingId(null);
    }
  }
  return { activeId, loadingId, playing, progress, toggle };
}

export type AudioPreview = ReturnType<typeof useAudioPreview>;

export function PlayButton({ id, title, preview }: { id: string; title: string; preview: AudioPreview }) {
  const active = preview.activeId === id;
  const isPlaying = active && preview.playing;
  return (
    <chakra.button
      type="button"
      aria-label={isPlaying ? `Pause ${title}` : `Play ${title}`}
      onClick={() => void preview.toggle(id)}
      boxSize="9"
      flexShrink={0}
      display="inline-flex"
      alignItems="center"
      justifyContent="center"
      borderRadius="full"
      bg={active ? "accent.subtle" : "bg.soft"}
      color={active ? "accent.fg" : "fg"}
      cursor="pointer"
      transition="background 120ms ease, color 120ms ease"
      _hover={{ bg: active ? "accent.muted" : "bg.softHover" }}
    >
      {preview.loadingId === id ? <Spinner size="xs" /> : isPlaying ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" style={{ marginLeft: 2 }} />}
    </chakra.button>
  );
}

export function ProfileAudioList({
  profileId,
  audio,
  canRemove,
}: {
  profileId: string;
  audio: { id: string; title: string; kind: string; durationSec: number }[];
  canRemove: boolean;
}) {
  const preview = useAudioPreview();
  return (
    <Stack gap="2">
      {audio.map((track) => {
        const active = preview.activeId === track.id;
        return (
          <Flex key={track.id} align="center" gap="4" px="3" py="3" bg="bg.subtle" borderWidth="1px" borderColor="border.card" borderRadius="l2">
            <PlayButton id={track.id} title={track.title} preview={preview} />
            <Stack gap="1.5" flex="1" minW="0">
              <Flex align="center" gap="2" minW="0">
                <Text fontSize="14px" fontWeight="500" truncate>
                  {track.title}
                </Text>
                <Flex align="center" gap="1" flexShrink={0} px="1.5" h="5" borderRadius="6px" bg="bg.soft" color="fg.muted" fontSize="11px" fontWeight="500">
                  <AudioLines size={11} />
                  {track.kind === "sfx" ? "Sound effect" : "Music"}
                </Flex>
              </Flex>
              <Box h="3px" borderRadius="full" bg="bg.soft" overflow="hidden" opacity={active ? 1 : 0.6}>
                <Box h="full" bg="accent.solid" borderRadius="full" transition="width 250ms linear" style={{ width: `${active ? preview.progress * 100 : 0}%` }} />
              </Box>
            </Stack>
            <Text textStyle="data" fontSize="12px" color="fg.timecode" flexShrink={0}>
              {formatDuration(track.durationSec)}
            </Text>
            {canRemove ? <MembershipRemoveButton profileId={profileId} kind="audio" resourceId={track.id} label={track.title} /> : null}
          </Flex>
        );
      })}
    </Stack>
  );
}

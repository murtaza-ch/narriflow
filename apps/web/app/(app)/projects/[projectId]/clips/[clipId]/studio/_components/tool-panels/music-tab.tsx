"use client";

import { useEffect, useState } from "react";
import { Box, Flex, Text, Stack, Input, Slider } from "@chakra-ui/react";
import { Check, ChevronDown, Link2, Music, Pause, Play, X } from "lucide-react";
import { formatDuration } from "@/lib/format";
import { useStudio } from "../studio-shell";
import { useAudioAssetList, type AudioAssetListRow } from "./audio-library";
import type { usePreviewPlayer } from "./audio-library";

interface MusicTabProps {
  reloadKey: number;
  player: ReturnType<typeof usePreviewPlayer>;
}

function MoodChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <Flex
      as="button"
      aria-pressed={active}
      align="center"
      px="10px"
      h="26px"
      borderRadius="l2"
      bg={active ? "studio.raised" : "studio.subtle"}
      border="1px solid"
      borderColor={active ? "studio.accent" : "studio.border"}
      color={active ? "studio.accentFg" : "studio.fgMuted"}
      fontSize="11px"
      fontWeight="500"
      cursor="pointer"
      whiteSpace="nowrap"
      textTransform="capitalize"
      transition="background 120ms ease, border-color 120ms ease, color 120ms ease"
      _hover={{ borderColor: active ? "studio.accent" : "studio.borderStrong" }}
      onClick={onClick}
    >
      {label}
    </Flex>
  );
}

function TrackRow({
  asset,
  isSelected,
  isPreviewing,
  onTogglePreview,
  onUse,
}: {
  asset: AudioAssetListRow;
  isSelected: boolean;
  isPreviewing: boolean;
  onTogglePreview: () => void;
  onUse: () => void;
}) {
  return (
    <Flex
      align="center"
      gap="8px"
      p="8px"
      borderRadius="l2"
      bg={isSelected ? "studio.raised" : "studio.subtle"}
      border="1px solid"
      borderColor={isSelected ? "studio.accent" : "studio.border"}
      transition="background 120ms ease, border-color 120ms ease"
    >
      <Box
        as="button"
        aria-label={isPreviewing ? `Pause ${asset.title}` : `Preview ${asset.title}`}
        flexShrink={0}
        w="26px"
        h="26px"
        display="flex"
        alignItems="center"
        justifyContent="center"
        borderRadius="full"
        bg="studio.raised"
        borderWidth="1px"
        borderColor="studio.borderStrong"
        color="studio.fg"
        cursor="pointer"
        _hover={{ borderColor: "studio.accent" }}
        transition="border-color 120ms ease"
        onClick={onTogglePreview}
      >
        {isPreviewing ? <Pause size={11} fill="currentColor" /> : <Play size={11} fill="currentColor" />}
      </Box>
      <Stack gap="0" minW="0" flex="1">
        <Text fontSize="12px" color="studio.fg" fontWeight="500" truncate>
          {asset.title}
        </Text>
        <Text textStyle="data" fontSize="10.5px" color="studio.fgMuted">
          {formatDuration(asset.durationSec)}
          {asset.scope === "user" ? " · uploaded" : ""}
        </Text>
      </Stack>
      <Box
        as="button"
        aria-pressed={isSelected}
        flexShrink={0}
        h="24px"
        px="10px"
        borderRadius="l2"
        borderWidth="1px"
        borderColor={isSelected ? "studio.accent" : "studio.borderControl"}
        bg={isSelected ? "studio.raised" : "studio.subtle"}
        color={isSelected ? "studio.accentFg" : "studio.fgMuted"}
        fontSize="10.5px"
        fontWeight="600"
        cursor="pointer"
        _hover={{ borderColor: "studio.accent" }}
        transition="background 120ms ease, border-color 120ms ease, color 120ms ease"
        onClick={onUse}
      >
        {isSelected ? (
          <Flex align="center" gap="4px">
            <Check size={11} /> Using
          </Flex>
        ) : (
          "Use"
        )}
      </Box>
    </Flex>
  );
}

// L8: the "Start at" slider's ceiling. The picked track's own duration is
// the ideal max (below, via `assets.find`), but that lookup only succeeds
// when the track is still visible under the CURRENT mood filter — a pasted
// URL track has no known duration at all. This is the fallback for both
// cases: generous enough for the overwhelming majority of background music
// tracks without letting the slider's usable range balloon to something
// unusable for a track that's actually only a couple of minutes long.
const START_OFFSET_FALLBACK_MAX_SEC = 600;

export function MusicTab({ reloadKey, player }: MusicTabProps) {
  const { studioEdits, setStudioEdits, endCoalesce } = useStudio();
  const music = studioEdits.music;

  const [mood, setMood] = useState<string | null>(null);
  const { assets, moodTags, loading, error } = useAudioAssetList("music", mood, reloadKey);

  // L8 (vizard-parity.md "Music/SFX library" plan scope): `startOffsetSec`
  // is already live end-to-end (studio preview loop-seeks by it, the worker
  // seeds `atrim=start=` from it) but had no control in this panel — the
  // only way to set it was hand-editing the document. Best-effort duration
  // ceiling from the currently-loaded (mood-filtered) asset list; falls
  // back to a fixed ceiling when the picked track isn't in it (pasted URL,
  // or filtered out by the current mood chip).
  const selectedAssetDurationSec = assets.find((asset) => asset.id === music.assetId)?.durationSec;
  const startOffsetMaxSec =
    selectedAssetDurationSec && selectedAssetDurationSec > 0
      ? Math.max(1, Math.ceil(selectedAssetDurationSec))
      : START_OFFSET_FALLBACK_MAX_SEC;

  const [showLinkInput, setShowLinkInput] = useState(false);
  const [urlDraft, setUrlDraft] = useState(music.url ?? "");
  const [titleDraft, setTitleDraft] = useState(music.title ?? "");

  // Resync drafts whenever the document's own music object changes identity
  // (undo/redo/reset all produce a NEW object; unrelated studioEdits changes
  // preserve the same reference) — same fix pattern every other panel here
  // uses so an in-progress edit can't go stale after an undo.
  useEffect(() => {
    setUrlDraft(music.url ?? "");
    setTitleDraft(music.title ?? "");
  }, [music]);

  const updateMusic = (patch: Partial<typeof music>, coalesceKey?: string) =>
    setStudioEdits((prev) => ({ ...prev, music: { ...prev.music, ...patch } }), coalesceKey);

  const applyTrack = (asset: AudioAssetListRow) => {
    updateMusic({ assetId: asset.id, title: asset.title, url: asset.playbackUrl });
  };

  const clearMusic = () => {
    setUrlDraft("");
    setTitleDraft("");
    setShowLinkInput(false);
    // L9: intentionally clears only assetId/title/url, NOT volume/fades/
    // ducking/startOffsetSec — picking a new track afterwards keeps
    // whatever mix settings the user already dialed in, rather than
    // resetting to schema defaults every time (a deliberate behavior
    // change vs. the old panel, which had no persistent settings to lose).
    updateMusic({ assetId: null, title: null, url: null });
  };

  const applyLink = () => {
    const trimmedUrl = urlDraft.trim();
    updateMusic({
      assetId: null,
      url: trimmedUrl ? trimmedUrl : null,
      title: titleDraft.trim() || null,
    });
  };

  return (
    <Stack gap="14px" p="12px">
      {moodTags.length > 0 ? (
        <Box>
          <Text textStyle="eyebrow" color="studio.fgMuted" mb="6px">
            Mood
          </Text>
          <Flex gap="6px" wrap="wrap">
            <MoodChip label="All" active={mood === null} onClick={() => setMood(null)} />
            {moodTags.map((tag) => (
              <MoodChip key={tag} label={tag} active={mood === tag} onClick={() => setMood(tag)} />
            ))}
          </Flex>
        </Box>
      ) : null}

      <Box maxH="260px" overflowY="auto">
        <Stack gap="6px">
          {loading ? (
            <Text fontSize="12px" color="studio.fgMuted" py="8px">
              Loading tracks…
            </Text>
          ) : error ? (
            <Text fontSize="12px" color="danger.400" py="8px">
              {error}
            </Text>
          ) : assets.length === 0 ? (
            <Text fontSize="12px" color="studio.fgMuted" py="8px">
              No tracks match this mood yet.
            </Text>
          ) : (
            assets.map((asset) => (
              <TrackRow
                key={asset.id}
                asset={asset}
                isSelected={music.assetId === asset.id}
                isPreviewing={player.playingId === asset.id}
                onTogglePreview={() => player.toggle(asset.id, asset.playbackUrl)}
                onUse={() => applyTrack(asset)}
              />
            ))
          )}
        </Stack>
      </Box>

      {music.url ? (
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
            <Text fontSize="11px" color="success.400" fontWeight="600" truncate>
              {music.title ?? "Music applied"}
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
      ) : (
        <Box>
          <Flex
            as="button"
            align="center"
            gap="5px"
            color="studio.fgMuted"
            fontSize="11px"
            fontWeight="500"
            cursor="pointer"
            _hover={{ color: "studio.fg" }}
            transition="color 120ms ease"
            onClick={() => setShowLinkInput((v) => !v)}
          >
            <Link2 size={12} />
            Paste a link instead
            <ChevronDown
              size={12}
              style={{ transform: showLinkInput ? "rotate(180deg)" : undefined, transition: "transform 120ms ease" }}
            />
          </Flex>
          {showLinkInput ? (
            <Stack gap="8px" mt="8px">
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
                <Input
                  aria-label="Music URL"
                  placeholder="https://example.com/background.mp3"
                  value={urlDraft}
                  onChange={(event) => setUrlDraft(event.target.value)}
                  size="xs"
                  flex="1"
                  fontSize="12px"
                  color="studio.fg"
                  css={{ border: "none", outline: "none", background: "transparent", boxShadow: "none" }}
                  _placeholder={{ color: "studio.fgSubtle" }}
                />
              </Flex>
              <Input
                value={titleDraft}
                onChange={(event) => setTitleDraft(event.target.value)}
                placeholder="Track label (optional)"
                size="sm"
                bg="studio.subtle"
                borderColor="studio.borderControl"
                color="studio.fg"
                fontSize="12px"
                _placeholder={{ color: "studio.fgSubtle" }}
                _focusVisible={{ borderColor: "studio.ring", boxShadow: "none" }}
              />
              <Flex
                as="button"
                align="center"
                justify="center"
                h="30px"
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
                onClick={applyLink}
              >
                Apply link
              </Flex>
            </Stack>
          ) : null}
        </Box>
      )}

      <Box
        p="12px"
        bg="studio.subtle"
        borderRadius="l2"
        borderWidth="1px"
        borderColor="studio.border"
      >
        <Flex align="center" gap="8px">
          <Text fontSize="11px" color="studio.fgMuted" w="52px" flexShrink={0}>
            Volume
          </Text>
          <Slider.Root
            aria-label={["Music volume"]}
            value={[music.volume]}
            min={0}
            max={100}
            onValueChange={(event) => updateMusic({ volume: event.value[0] ?? music.volume }, "music-volume")}
            onValueChangeEnd={endCoalesce}
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
            {music.volume}%
          </Text>
        </Flex>
      </Box>

      <Box
        p="12px"
        bg="studio.subtle"
        borderRadius="l2"
        borderWidth="1px"
        borderColor="studio.border"
      >
        <Flex align="center" gap="8px">
          <Text fontSize="11px" color="studio.fgMuted" w="52px" flexShrink={0}>
            Start at
          </Text>
          <Slider.Root
            aria-label={["Music start offset"]}
            value={[Math.min(music.startOffsetSec, startOffsetMaxSec)]}
            min={0}
            max={startOffsetMaxSec}
            step={0.5}
            onValueChange={(event) =>
              updateMusic({ startOffsetSec: event.value[0] ?? music.startOffsetSec }, "music-start-offset")
            }
            onValueChangeEnd={endCoalesce}
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
            {music.startOffsetSec.toFixed(1)}s
          </Text>
        </Flex>
      </Box>

      <Box>
        <Text textStyle="eyebrow" color="studio.fgMuted" mb="6px">
          Fades
        </Text>
        <Stack
          gap="10px"
          p="12px"
          bg="studio.subtle"
          borderRadius="l2"
          borderWidth="1px"
          borderColor="studio.border"
        >
          <Flex align="center" gap="8px">
            <Text fontSize="11px" color="studio.fgMuted" w="52px" flexShrink={0}>
              Fade in
            </Text>
            <Slider.Root
              aria-label={["Music fade in"]}
              value={[music.fadeInSec]}
              min={0}
              max={5}
              step={0.1}
              onValueChange={(event) => updateMusic({ fadeInSec: event.value[0] ?? 0 }, "music-fade-in")}
              onValueChangeEnd={endCoalesce}
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
              {music.fadeInSec.toFixed(1)}s
            </Text>
          </Flex>
          <Flex align="center" gap="8px">
            <Text fontSize="11px" color="studio.fgMuted" w="52px" flexShrink={0}>
              Fade out
            </Text>
            <Slider.Root
              aria-label={["Music fade out"]}
              value={[music.fadeOutSec]}
              min={0}
              max={5}
              step={0.1}
              onValueChange={(event) => updateMusic({ fadeOutSec: event.value[0] ?? 0 }, "music-fade-out")}
              onValueChangeEnd={endCoalesce}
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
              {music.fadeOutSec.toFixed(1)}s
            </Text>
          </Flex>
        </Stack>
      </Box>

      <Flex
        align="center"
        justify="space-between"
        p="12px"
        bg="studio.subtle"
        borderRadius="l2"
        borderWidth="1px"
        borderColor="studio.border"
      >
        <Stack gap="2px">
          <Text fontSize="12px" color="studio.fg" fontWeight="500">
            Duck under speech
          </Text>
          <Text fontSize="10.5px" color="studio.fgSubtle">
            Automatically lowers the music while someone is talking.
          </Text>
        </Stack>
        <Box
          as="button"
          aria-pressed={music.ducking}
          aria-label={music.ducking ? "Disable ducking" : "Enable ducking"}
          flexShrink={0}
          h="22px"
          px="9px"
          borderRadius="l2"
          borderWidth="1px"
          borderColor={music.ducking ? "studio.accent" : "studio.borderControl"}
          bg={music.ducking ? "studio.raised" : "studio.subtle"}
          color={music.ducking ? "studio.accentFg" : "studio.fgMuted"}
          fontSize="10.5px"
          fontWeight="600"
          cursor="pointer"
          transition="background 120ms ease, border-color 120ms ease, color 120ms ease"
          _hover={{ borderColor: music.ducking ? "studio.accent" : "studio.fgSubtle" }}
          onClick={() => updateMusic({ ducking: !music.ducking })}
        >
          {music.ducking ? "On" : "Off"}
        </Box>
      </Flex>
    </Stack>
  );
}

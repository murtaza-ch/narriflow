"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Flex, Input, Slider, Stack, Text } from "@chakra-ui/react";
import type { ReactNode } from "react";
import { softFieldProps, studioSliderCss } from "./panel-ui";
import { ChevronDown, Link2, Music, SlidersHorizontal, X } from "lucide-react";
import { toaster } from "@narriflow/ui/components/toaster";
import { formatDuration } from "@/lib/format";
import { useStudio } from "../studio-shell";
import type { StudioMusicBlock } from "@narriflow/validators";
import { addMusicTrack, patchMusicBlock, selectedOrOnlyBlock, type MusicTrack } from "../music-blocks";
import {
  brandAudioRows,
  resolveAudioPlaybackUrl,
  useAudioApi,
  useAudioAttributions,
  type AudioAssetListRow,
  type PreviewPlayer,
} from "./audio-library";
import { AudioBrowser, type AudioBrowserLabels } from "./audio-list";
import { AUDIO_CREDIT_HINT, audioCreditAssetIds } from "./audio-credits";
import { CopyCreditButton } from "./credit-copy";

interface MusicTabProps {
  player: PreviewPlayer;
  onOpenUploads: () => void;
}

const MUSIC_LABELS: AudioBrowserLabels = {
  searchLabel: "music",
  searchPlaceholder: "Search music…",
  clearSearchLabel: "Clear music search",
  loadingLabel: "Loading music",
  emptyTitle: "No music yet",
  emptyHint: "Free-to-use tracks will show up here.",
  savedTitle: "No saved tracks",
  savedHint: "Star a track and it collects here.",
  uploadLabel: "Upload a track",
  emptyIcon: <Music size={18} />,
};

/** One collapsible group: a soft header row, its content flowing below when open. */
function Disclosure({
  icon,
  label,
  open,
  onToggle,
  children,
}: {
  icon: ReactNode;
  label: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <Stack gap="3">
      <Flex
        as="button"
        aria-expanded={open}
        align="center"
        justify="space-between"
        h="40px"
        px="3"
        bg="studio.subtle"
        borderRadius="12px"
        color="studio.fg"
        fontSize="13px"
        fontWeight="500"
        cursor="pointer"
        transition="background 120ms ease"
        _hover={{ bg: "studio.surface" }}
        onClick={onToggle}
      >
        <Flex align="center" gap="2.5">
          <Box color="studio.fgMuted">{icon}</Box>
          {label}
        </Flex>
        <Box color="studio.fgMuted" transform={open ? "rotate(180deg)" : undefined} transition="transform 120ms ease">
          <ChevronDown size={14} />
        </Box>
      </Flex>
      {open ? children : null}
    </Stack>
  );
}

export function MusicTab({ player, onOpenUploads }: MusicTabProps) {
  const audioApi = useAudioApi();
  const {
    studioEdits,
    setStudioEdits,
    endCoalesce,
    brandAudio,
    selectedMusicBlockId,
    selectMusicBlock,
    deselectMusicBlock,
    playbackClock,
    compositeToBaseEdited,
    editedTimeMap,
  } = useStudio(
    "studioEdits",
    "setStudioEdits",
    "endCoalesce",
    "brandAudio",
    "selectedMusicBlockId",
    "selectMusicBlock",
    "deselectMusicBlock",
    "playbackClock",
    "compositeToBaseEdited",
    "editedTimeMap",
  );
  const music = studioEdits.music;
  const selectedBlock = selectedOrOnlyBlock(music.blocks, selectedMusicBlockId);
  // The latest document, for work that finishes after an await.
  const studioEditsRef = useRef(studioEdits);
  studioEditsRef.current = studioEdits;
  const creditAssetIds = useMemo(() => audioCreditAssetIds(studioEdits), [studioEdits]);
  const attributions = useAudioAttributions(creditAssetIds);
  const [showMix, setShowMix] = useState(music.blocks.length > 0);
  const [showLinkInput, setShowLinkInput] = useState(false);
  const [urlDraft, setUrlDraft] = useState("");
  const [titleDraft, setTitleDraft] = useState("");
  const applyRequest = useRef(0);

  useEffect(() => () => { applyRequest.current++; }, []);

  const brandRows = useMemo(() => brandAudioRows(brandAudio.music, "music"), [brandAudio.music]);
  const updateMusic = (patch: Partial<typeof music>, coalesceKey?: string) =>
    setStudioEdits((prev) => ({ ...prev, music: { ...prev.music, ...patch } }), coalesceKey);

  const updateBlock = (patch: Partial<StudioMusicBlock>, field: string) => {
    if (!selectedBlock) return;
    const id = selectedBlock.id;
    setStudioEdits(
      (prev) => ({
        ...prev,
        music: { ...prev.music, blocks: patchMusicBlock(prev.music.blocks, id, patch) },
      }),
      `music-block-${id}-${field}`,
    );
  };

  const removeBlock = (id: string) => {
    applyRequest.current++;
    updateMusic({ blocks: studioEditsRef.current.music.blocks.filter((block) => block.id !== id) });
    if (selectedMusicBlockId === id) deselectMusicBlock();
  };

  /** What "Use" does depends on the playhead: see `addMusicTrack`. */
  const placeTrack = (track: MusicTrack) => {
    const blocks = studioEditsRef.current.music.blocks;
    const playheadSec = compositeToBaseEdited(playbackClock.getSnapshot());
    const result = addMusicTrack(blocks, track, playheadSec, editedTimeMap.editedDurationSec, crypto.randomUUID());
    if (result.kind === "no-room") {
      toaster.create({
        type: "info",
        title: "No room for a track here",
        description: "Move the playhead to open space, or trim the next block.",
      });
      return false;
    }
    if (result.kind === "limit") {
      toaster.create({
        type: "info",
        title: "The music lane is full",
        description: "Delete a block to add another track.",
      });
      return false;
    }
    updateMusic({ blocks: result.blocks });
    selectMusicBlock(result.blockId);
    setShowMix(true);
    return true;
  };

  const applyTrack = async (asset: AudioAssetListRow) => {
    const request = ++applyRequest.current;
    try {
      // A curated track is a stable public URL; only uploads need a fresh signed link.
      const url = asset.previewUrl ?? await resolveAudioPlaybackUrl(asset.id, audioApi);
      if (request !== applyRequest.current) return;
      placeTrack({ assetId: asset.id, title: asset.title, url });
    } catch {
      if (request !== applyRequest.current) return;
      toaster.create({ type: "error", title: "Couldn't apply this track", description: "Please try again." });
    }
  };

  const applyLink = () => {
    applyRequest.current++;
    const trimmedUrl = urlDraft.trim();
    if (!/^https?:\/\/\S+$/i.test(trimmedUrl)) {
      toaster.create({ type: "error", title: "Enter a full link", description: "It should start with https://." });
      return;
    }
    if (placeTrack({ assetId: null, url: trimmedUrl, title: titleDraft.trim() || null })) {
      setUrlDraft("");
      setTitleDraft("");
    }
  };

  const blockCredit = (selectedBlock?.assetId && attributions.get(selectedBlock.assetId)) || null;

  const rowAction = (asset: AudioAssetListRow) => ({
    ariaLabel: selectedBlock?.assetId === asset.id ? `${asset.title} is in use` : `Use ${asset.title}`,
    selected: selectedBlock?.assetId === asset.id,
    onClick: () => void applyTrack(asset),
  });

  return (
    <Flex direction="column" flex="1" gap="4" px="5" pt="4" pb="4">
      <AudioBrowser
        kind="music"
        labels={MUSIC_LABELS}
        player={player}
        brandRows={brandRows}
        onOpenUploads={onOpenUploads}
        rowAction={rowAction}
        onFavoriteFailed={() => toaster.create({ type: "error", title: "Couldn't update Saved tracks" })}
      />

      {selectedBlock ? (
        <Stack gap="2" p="2" pe="3" bg="studio.subtle" borderRadius="12px">
        <Flex align="center" justify="space-between" gap="2">
          <Flex align="center" gap="3" minW="0">
            <Flex boxSize="32px" flexShrink={0} align="center" justify="center" borderRadius="full" bg="studio.accentSubtle" color="studio.accentFg">
              <Music size={15} />
            </Flex>
            <Stack gap="0" minW="0">
              <Text fontSize="13px" color="studio.fg" fontWeight="500" truncate>
                {selectedBlock.title ?? "Music applied"}
              </Text>
              <Text fontSize="12px" color="studio.fgSubtle" fontVariantNumeric="tabular-nums">
                {formatDuration(selectedBlock.startSec)} to{" "}
                {selectedBlock.endSec === null ? "end" : formatDuration(selectedBlock.endSec)}
                {music.blocks.length > 1 ? ` · ${music.blocks.length} blocks` : ""}
              </Text>
            </Stack>
          </Flex>
          <Flex
            as="button"
            aria-label="Remove music block"
            minW="24px"
            minH="24px"
            align="center"
            justify="center"
            color="studio.fgMuted"
            cursor="pointer"
            _hover={{ color: "studio.fg" }}
            onClick={() => removeBlock(selectedBlock.id)}
          >
            <X size={14} />
          </Flex>
        </Flex>
        {blockCredit ? (
          <Flex align="center" justify="space-between" gap="3" pl="44px">
            <Stack gap="0" minW="0">
              <Text fontSize="12px" color="studio.fg" fontWeight="500">Credit required</Text>
              <Text fontSize="12px" color="studio.fgSubtle">{AUDIO_CREDIT_HINT}</Text>
            </Stack>
            <CopyCreditButton text={blockCredit} label="Copy credit" />
          </Flex>
        ) : null}
        </Stack>
      ) : music.blocks.length > 1 ? (
        <Text fontSize="12px" color="studio.fgSubtle" px="1">
          Select a block on the timeline to edit its volume and fades.
        </Text>
      ) : null}

      <Disclosure icon={<Link2 size={14} />} label="Paste a link instead" open={showLinkInput} onToggle={() => setShowLinkInput((value) => !value)}>
        <Stack gap="2">
          <Input
            aria-label="Music URL"
            placeholder="https://example.com/background.mp3"
            value={urlDraft}
            onChange={(event) => setUrlDraft(event.target.value)}
            size="sm"
            h="40px"
            fontSize="13px"
            {...softFieldProps}
          />
          <Flex gap="2">
            <Input
              aria-label="Track label"
              placeholder="Track label"
              value={titleDraft}
              onChange={(event) => setTitleDraft(event.target.value)}
              size="sm"
              h="40px"
              fontSize="13px"
              {...softFieldProps}
            />
            <Flex
              as="button"
              align="center"
              justify="center"
              px="4"
              borderRadius="10px"
              bg="studio.fg"
              color="studio.canvas"
              fontSize="13px"
              fontWeight="500"
              cursor="pointer"
              onClick={applyLink}
            >
              Apply
            </Flex>
          </Flex>
        </Stack>
      </Disclosure>

      <Disclosure icon={<SlidersHorizontal size={14} />} label="Mix" open={showMix} onToggle={() => setShowMix((value) => !value)}>
        <Stack gap="4" px="1">
          {selectedBlock
            ? ([
                ["Volume", selectedBlock.volume, 0, 100, 1, "%", "Music volume", "volume", (value: number) => ({ volume: value })],
                ["Fade in", selectedBlock.fadeInSec, 0, 5, 0.1, "s", "Music fade in", "fade-in", (value: number) => ({ fadeInSec: value })],
                ["Fade out", selectedBlock.fadeOutSec, 0, 5, 0.1, "s", "Music fade out", "fade-out", (value: number) => ({ fadeOutSec: value })],
              ] as const).map(([label, value, min, max, step, suffix, aria, field, toPatch]) => (
                <Flex key={label} align="center" gap="3">
                  <Text fontSize="13px" color="studio.fgMuted" w="56px" flexShrink={0}>{label}</Text>
                  <Slider.Root
                    aria-label={[aria]}
                    value={[value]}
                    min={min}
                    max={max}
                    step={step}
                    onValueChange={(event) => updateBlock(toPatch(event.value[0] ?? value), field)}
                    onValueChangeEnd={endCoalesce}
                    size="sm"
                    css={studioSliderCss}
                    flex="1"
                  >
                    <Slider.Control><Slider.Track><Slider.Range /></Slider.Track><Slider.Thumbs /></Slider.Control>
                  </Slider.Root>
                  <Text textStyle="data" fontSize="12px" color="studio.fgMuted" w="44px" textAlign="right">
                    {suffix === "%" ? Math.round(value) : value.toFixed(1)}{suffix}
                  </Text>
                </Flex>
              ))
            : (
              <Text fontSize="12px" color="studio.fgSubtle">
                {music.blocks.length === 0
                  ? "Add a track to set its volume and fades."
                  : "Select a block on the timeline to set its volume and fades."}
              </Text>
            )}
          <Flex align="center" justify="space-between" gap="3" pt="1">
            <Stack gap="0">
              <Text fontSize="13px" color="studio.fg" fontWeight="500">Duck under speech</Text>
              <Text fontSize="12px" color="studio.fgSubtle">Lower music while people talk.</Text>
            </Stack>
            <Flex
              as="button"
              aria-pressed={music.ducking}
              aria-label={music.ducking ? "Disable ducking" : "Enable ducking"}
              h="28px"
              minW="48px"
              px="3"
              align="center"
              justify="center"
              borderRadius="full"
              bg={music.ducking ? "studio.accent" : "studio.raised"}
              color={music.ducking ? "white" : "studio.fgMuted"}
              fontSize="12px"
              fontWeight="500"
              cursor="pointer"
              transition="background 120ms ease, color 120ms ease"
              onClick={() => updateMusic({ ducking: !music.ducking }, undefined)}
            >
              {music.ducking ? "On" : "Off"}
            </Flex>
          </Flex>
        </Stack>
      </Disclosure>
    </Flex>
  );
}

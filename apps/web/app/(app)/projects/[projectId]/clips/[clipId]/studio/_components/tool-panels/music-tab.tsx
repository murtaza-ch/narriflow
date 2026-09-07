"use client";

import { useEffect, useMemo, useState } from "react";
import { Box, Flex, Image, Input, Slider, Stack, Text } from "@chakra-ui/react";
import {
  Check,
  ChevronDown,
  Link2,
  LoaderCircle,
  Music,
  Pause,
  Play,
  Plus,
  Search,
  SlidersHorizontal,
  Star,
  Upload,
  X,
} from "lucide-react";
import { toaster } from "@narriflow/ui/components/toaster";
import { formatDuration } from "@/lib/format";
import { useStudio } from "../studio-shell";
import {
  useAudioAssetList,
  type AudioAssetListRow,
  type PreviewPlayer,
} from "./audio-library";
import { filterAudioAssets } from "./audio-library-filter";

interface MusicTabProps {
  reloadKey: number;
  player: PreviewPlayer;
  onOpenUploads: () => void;
}

const START_OFFSET_FALLBACK_MAX_SEC = 600;

function CategoryChip({
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
      flexShrink={0}
      h="26px"
      px="10px"
      borderRadius="full"
      bg={active ? "studio.accent" : "studio.subtle"}
      borderWidth="1px"
      borderColor={active ? "studio.accent" : "studio.border"}
      color={active ? "accent.contrast" : "studio.fgMuted"}
      fontSize="10.5px"
      fontWeight="600"
      textTransform="capitalize"
      cursor="pointer"
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
  player,
  selected,
  onUse,
  onFavorite,
}: {
  asset: AudioAssetListRow;
  player: PreviewPlayer;
  selected: boolean;
  onUse: () => void;
  onFavorite: () => void;
}) {
  const active = player.activeId === asset.id;
  const playing = active && player.isPlaying;
  const loading = player.loadingId === asset.id;
  const duration = active && player.duration > 0 ? player.duration : asset.durationSec;

  return (
    <Stack
      gap="0"
      p="7px"
      bg={active || selected ? "studio.raised" : "transparent"}
      borderWidth="1px"
      borderColor={selected ? "studio.accent" : active ? "studio.borderStrong" : "transparent"}
      borderRadius="l2"
      transition="background 120ms ease, border-color 120ms ease"
      _hover={{ bg: "studio.raised", borderColor: selected ? "studio.accent" : "studio.border" }}
    >
      <Flex align="center" gap="8px">
        <Box position="relative" w="40px" h="40px" flexShrink={0} overflow="hidden" borderRadius="l2">
          <Image
            src="/images/audio/music-cover.png"
            alt=""
            w="full"
            h="full"
            objectFit="cover"
          />
          <Flex
            as="button"
            aria-label={playing ? `Pause ${asset.title}` : `Preview ${asset.title}`}
            position="absolute"
            inset="0"
            align="center"
            justify="center"
            color="white"
            bg="blackAlpha.400"
            cursor="pointer"
            _hover={{ bg: "blackAlpha.600" }}
            onClick={() => player.toggle(asset.id, asset.playbackUrl)}
          >
            {loading ? (
              <Box animation="spin">
                <LoaderCircle size={15} />
              </Box>
            ) : playing ? (
              <Pause size={15} fill="currentColor" />
            ) : (
              <Play size={15} fill="currentColor" />
            )}
          </Flex>
        </Box>

        <Stack gap="1px" minW="0" flex="1">
          <Text fontSize="11.5px" color="studio.fg" fontWeight="500" truncate>
            {asset.title}
          </Text>
          <Text textStyle="data" fontSize="10px" color="studio.fgMuted">
            {formatDuration(asset.durationSec)}
            {asset.scope === "user" ? " · upload" : ""}
          </Text>
        </Stack>

        <Flex align="center" gap="3px" flexShrink={0}>
          <Flex
            as="button"
            aria-label={asset.favorited ? `Remove ${asset.title} from Saved` : `Save ${asset.title}`}
            aria-pressed={asset.favorited}
            w="25px"
            h="25px"
            align="center"
            justify="center"
            borderRadius="full"
            color={asset.favorited ? "warning.fg" : "studio.fgMuted"}
            cursor="pointer"
            _hover={{ bg: "studio.subtle", color: asset.favorited ? "warning.fg" : "studio.fg" }}
            onClick={onFavorite}
          >
            <Star size={13} fill={asset.favorited ? "currentColor" : "none"} />
          </Flex>
          <Flex
            as="button"
            aria-label={selected ? `${asset.title} is in use` : `Use ${asset.title}`}
            aria-pressed={selected}
            w="25px"
            h="25px"
            align="center"
            justify="center"
            borderRadius="full"
            bg={selected ? "studio.accent" : "studio.subtle"}
            borderWidth="1px"
            borderColor={selected ? "studio.accent" : "studio.borderControl"}
            color={selected ? "accent.contrast" : "studio.fgMuted"}
            cursor="pointer"
            _hover={{ borderColor: "studio.accent" }}
            onClick={onUse}
          >
            {selected ? <Check size={13} /> : <Plus size={13} />}
          </Flex>
        </Flex>
      </Flex>

      {active ? (
        <Flex align="center" gap="7px" mt="7px" pl="48px">
          <Slider.Root
            aria-label={[`${asset.title} preview position`]}
            value={[Math.min(player.currentTime, Math.max(duration, 0))]}
            min={0}
            max={Math.max(duration, 0.01)}
            step={0.05}
            onValueChange={(event) => player.seek(event.value[0] ?? 0)}
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
          <Text textStyle="data" fontSize="9.5px" color="studio.fgMuted" whiteSpace="nowrap">
            {formatDuration(player.currentTime)} / {formatDuration(duration)}
          </Text>
        </Flex>
      ) : null}
    </Stack>
  );
}

export function MusicTab({ reloadKey, player, onOpenUploads }: MusicTabProps) {
  const { studioEdits, setStudioEdits, endCoalesce } = useStudio("studioEdits", "setStudioEdits", "endCoalesce");
  const music = studioEdits.music;
  const { assets, moodTags, loading, error, setFavorite } = useAudioAssetList(
    "music",
    null,
    reloadKey,
  );
  const [category, setCategory] = useState("all");
  const [search, setSearch] = useState("");
  const [showMix, setShowMix] = useState(Boolean(music.url));
  const [showLinkInput, setShowLinkInput] = useState(false);
  const [urlDraft, setUrlDraft] = useState(music.url ?? "");
  const [titleDraft, setTitleDraft] = useState(music.title ?? "");

  useEffect(() => {
    setUrlDraft(music.url ?? "");
    setTitleDraft(music.title ?? "");
  }, [music]);

  const visibleAssets = useMemo(() => {
    return filterAudioAssets(assets, { category, search, activeId: player.activeId });
  }, [assets, category, player.activeId, search]);

  const selectedAssetDurationSec = assets.find((asset) => asset.id === music.assetId)?.durationSec;
  const startOffsetMaxSec =
    selectedAssetDurationSec && selectedAssetDurationSec > 0
      ? Math.max(1, Math.ceil(selectedAssetDurationSec))
      : START_OFFSET_FALLBACK_MAX_SEC;

  const updateMusic = (patch: Partial<typeof music>, coalesceKey?: string) =>
    setStudioEdits((prev) => ({ ...prev, music: { ...prev.music, ...patch } }), coalesceKey);

  const applyTrack = (asset: AudioAssetListRow) => {
    updateMusic({ assetId: asset.id, title: asset.title, url: asset.playbackUrl });
    setShowMix(true);
  };

  const clearMusic = () => {
    setUrlDraft("");
    setTitleDraft("");
    setShowLinkInput(false);
    updateMusic({ assetId: null, title: null, url: null });
  };

  const applyLink = () => {
    const trimmedUrl = urlDraft.trim();
    updateMusic({ assetId: null, url: trimmedUrl || null, title: titleDraft.trim() || null });
    if (trimmedUrl) setShowMix(true);
  };

  const toggleFavorite = async (asset: AudioAssetListRow) => {
    try {
      await setFavorite(asset.id, !asset.favorited);
    } catch {
      toaster.create({ type: "error", title: "Couldn't update Saved tracks" });
    }
  };

  return (
    <Stack gap="10px" p="12px">
      <Flex align="center" gap="7px">
        <Flex
          align="center"
          gap="7px"
          h="34px"
          px="10px"
          flex="1"
          bg="studio.subtle"
          borderWidth="1px"
          borderColor="studio.borderControl"
          borderRadius="l2"
          _focusWithin={{ borderColor: "studio.ring" }}
        >
          <Search size={14} />
          <Input
            aria-label="Search music"
            placeholder="Search music…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            p="0"
            border="0"
            outline="0"
            bg="transparent"
            fontSize="11.5px"
            color="studio.fg"
            _focusVisible={{ boxShadow: "none" }}
            _placeholder={{ color: "studio.fgSubtle" }}
          />
          {search ? (
            <Flex as="button" aria-label="Clear music search" onClick={() => setSearch("")}>
              <X size={12} />
            </Flex>
          ) : null}
        </Flex>
        <Flex
          as="button"
          aria-label="Open audio uploads"
          w="34px"
          h="34px"
          align="center"
          justify="center"
          borderRadius="l2"
          bg="studio.subtle"
          borderWidth="1px"
          borderColor="studio.borderControl"
          color="studio.fgMuted"
          cursor="pointer"
          _hover={{ borderColor: "studio.borderStrong", color: "studio.fg" }}
          onClick={onOpenUploads}
        >
          <Upload size={14} />
        </Flex>
      </Flex>

      <Flex gap="6px" overflowX="auto" pb="2px" css={{ scrollbarWidth: "none" }}>
        <CategoryChip label="All" active={category === "all"} onClick={() => setCategory("all")} />
        <CategoryChip label="Saved" active={category === "saved"} onClick={() => setCategory("saved")} />
        {moodTags.map((tag) => (
          <CategoryChip key={tag} label={tag} active={category === tag} onClick={() => setCategory(tag)} />
        ))}
      </Flex>

      <Box maxH="330px" overflowY="auto" pr="2px">
        <Stack gap="3px">
          {loading ? (
            <Flex align="center" gap="7px" py="18px" justify="center" color="studio.fgMuted">
              <Box animation="spin">
                <LoaderCircle size={14} />
              </Box>
              <Text fontSize="11px">Loading music…</Text>
            </Flex>
          ) : error ? (
            <Text fontSize="11px" color="studio.danger" py="14px" textAlign="center">
              {error}
            </Text>
          ) : visibleAssets.length === 0 ? (
            <Stack align="center" gap="5px" py="22px" px="12px" textAlign="center">
              <Music size={18} />
              <Text fontSize="11.5px" color="studio.fgMuted">
                {category === "saved"
                  ? "Save tracks with the star and they’ll collect here."
                  : search
                    ? "No music matches this search."
                    : "No royalty-free music has been added yet."}
              </Text>
              {!search && category !== "saved" ? (
                <Flex
                  as="button"
                  align="center"
                  gap="5px"
                  color="studio.accentFg"
                  fontSize="10.5px"
                  fontWeight="600"
                  cursor="pointer"
                  onClick={onOpenUploads}
                >
                  <Upload size={12} /> Upload a track
                </Flex>
              ) : null}
            </Stack>
          ) : (
            visibleAssets.map((asset) => (
              <TrackRow
                key={asset.id}
                asset={asset}
                player={player}
                selected={music.assetId === asset.id}
                onUse={() => applyTrack(asset)}
                onFavorite={() => void toggleFavorite(asset)}
              />
            ))
          )}
        </Stack>
      </Box>

      {music.url ? (
        <Flex
          align="center"
          justify="space-between"
          gap="8px"
          px="10px"
          py="8px"
          bg="studio.raised"
          borderWidth="1px"
          borderColor="studio.accent"
          borderLeftWidth="3px"
          borderRadius="l2"
        >
          <Flex align="center" gap="6px" minW="0">
            <Music size={13} />
            <Text fontSize="10.5px" color="studio.fg" fontWeight="600" truncate>
              {music.title ?? "Music applied"}
            </Text>
          </Flex>
          <Flex as="button" aria-label="Remove music" color="studio.fgMuted" onClick={clearMusic}>
            <X size={13} />
          </Flex>
        </Flex>
      ) : null}

      <Flex
        as="button"
        align="center"
        justify="space-between"
        color="studio.fgMuted"
        fontSize="10.5px"
        fontWeight="600"
        cursor="pointer"
        onClick={() => setShowLinkInput((value) => !value)}
      >
        <Flex align="center" gap="5px">
          <Link2 size={12} /> Paste a link instead
        </Flex>
        <ChevronDown size={12} style={{ transform: showLinkInput ? "rotate(180deg)" : undefined }} />
      </Flex>
      {showLinkInput ? (
        <Stack gap="7px">
          <Input
            aria-label="Music URL"
            placeholder="https://example.com/background.mp3"
            value={urlDraft}
            onChange={(event) => setUrlDraft(event.target.value)}
            size="sm"
            bg="studio.subtle"
            borderColor="studio.borderControl"
            fontSize="11px"
          />
          <Flex gap="7px">
            <Input
              aria-label="Track label"
              placeholder="Track label"
              value={titleDraft}
              onChange={(event) => setTitleDraft(event.target.value)}
              size="sm"
              bg="studio.subtle"
              borderColor="studio.borderControl"
              fontSize="11px"
            />
            <Flex
              as="button"
              align="center"
              justify="center"
              px="10px"
              borderRadius="l2"
              bg="studio.accent"
              color="accent.contrast"
              fontSize="10.5px"
              fontWeight="600"
              onClick={applyLink}
            >
              Apply
            </Flex>
          </Flex>
        </Stack>
      ) : null}

      <Flex
        as="button"
        align="center"
        justify="space-between"
        h="32px"
        px="9px"
        bg="studio.subtle"
        borderWidth="1px"
        borderColor="studio.border"
        borderRadius="l2"
        color="studio.fgMuted"
        fontSize="10.5px"
        fontWeight="600"
        cursor="pointer"
        onClick={() => setShowMix((value) => !value)}
      >
        <Flex align="center" gap="6px">
          <SlidersHorizontal size={12} /> Mix & timing
        </Flex>
        <ChevronDown size={12} style={{ transform: showMix ? "rotate(180deg)" : undefined }} />
      </Flex>

      {showMix ? (
        <Stack gap="10px" p="10px" bg="studio.subtle" borderWidth="1px" borderColor="studio.border" borderRadius="l2">
          {([
            ["Volume", music.volume, 0, 100, 1, "%", "Music volume", "music-volume"],
            ["Start", Math.min(music.startOffsetSec, startOffsetMaxSec), 0, startOffsetMaxSec, 0.5, "s", "Music start offset", "music-start-offset"],
            ["Fade in", music.fadeInSec, 0, 5, 0.1, "s", "Music fade in", "music-fade-in"],
            ["Fade out", music.fadeOutSec, 0, 5, 0.1, "s", "Music fade out", "music-fade-out"],
          ] as const).map(([label, value, min, max, step, suffix, aria, coalesceKey]) => (
            <Flex key={label} align="center" gap="8px">
              <Text fontSize="10.5px" color="studio.fgMuted" w="44px" flexShrink={0}>{label}</Text>
              <Slider.Root
                aria-label={[aria]}
                value={[value]}
                min={min}
                max={max}
                step={step}
                onValueChange={(event) => {
                  const next = event.value[0] ?? value;
                  if (label === "Volume") updateMusic({ volume: next }, coalesceKey);
                  else if (label === "Start") updateMusic({ startOffsetSec: next }, coalesceKey);
                  else if (label === "Fade in") updateMusic({ fadeInSec: next }, coalesceKey);
                  else updateMusic({ fadeOutSec: next }, coalesceKey);
                }}
                onValueChangeEnd={endCoalesce}
                size="sm"
                colorPalette="accent"
                flex="1"
              >
                <Slider.Control><Slider.Track><Slider.Range /></Slider.Track><Slider.Thumbs /></Slider.Control>
              </Slider.Root>
              <Text textStyle="data" fontSize="10px" color="studio.fgMuted" w="36px" textAlign="right">
                {suffix === "%" ? Math.round(value) : value.toFixed(1)}{suffix}
              </Text>
            </Flex>
          ))}
          <Flex align="center" justify="space-between" pt="2px">
            <Stack gap="0">
              <Text fontSize="10.5px" color="studio.fg" fontWeight="600">Duck under speech</Text>
              <Text fontSize="9.5px" color="studio.fgSubtle">Lower music while people talk.</Text>
            </Stack>
            <Flex
              as="button"
              aria-pressed={music.ducking}
              aria-label={music.ducking ? "Disable ducking" : "Enable ducking"}
              h="22px"
              px="8px"
              align="center"
              borderRadius="l2"
              borderWidth="1px"
              borderColor={music.ducking ? "studio.accent" : "studio.borderControl"}
              color={music.ducking ? "studio.accentFg" : "studio.fgMuted"}
              fontSize="10px"
              fontWeight="600"
              onClick={() => updateMusic({ ducking: !music.ducking })}
            >
              {music.ducking ? "On" : "Off"}
            </Flex>
          </Flex>
        </Stack>
      ) : null}
    </Stack>
  );
}

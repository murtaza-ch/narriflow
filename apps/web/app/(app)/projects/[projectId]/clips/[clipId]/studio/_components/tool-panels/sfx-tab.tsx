"use client";

import { useMemo, useState } from "react";
import { Box, Flex, Image, Input, Slider, Stack, Text } from "@chakra-ui/react";
import {
  AlertTriangle,
  LoaderCircle,
  Pause,
  Play,
  Plus,
  Search,
  Sparkles,
  Star,
  Upload,
  X,
} from "lucide-react";
import { toaster } from "@narriflow/ui";
import { formatDuration, formatTimecode } from "@/lib/format";
import { useStudio } from "../studio-shell";
import {
  useAudioAssetList,
  type AudioAssetListRow,
  type PreviewPlayer,
} from "./audio-library";
import { filterAudioAssets } from "./audio-library-filter";

const MAX_SFX_PLACEMENTS = 20;

interface SfxTabProps {
  reloadKey: number;
  player: PreviewPlayer;
  onOpenUploads: () => void;
}

function FilterChip({
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
      onClick={onClick}
    >
      {label}
    </Flex>
  );
}

function SfxRow({
  asset,
  player,
  disabled,
  onAdd,
  onFavorite,
}: {
  asset: AudioAssetListRow;
  player: PreviewPlayer;
  disabled: boolean;
  onAdd: () => void;
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
      bg={active ? "studio.raised" : "transparent"}
      borderWidth="1px"
      borderColor={active ? "studio.borderStrong" : "transparent"}
      borderRadius="l2"
      _hover={{ bg: "studio.raised", borderColor: "studio.border" }}
    >
      <Flex align="center" gap="8px">
        <Box position="relative" w="40px" h="40px" flexShrink={0} overflow="hidden" borderRadius="l2">
          <Image src="/images/audio/sfx-cover.png" alt="" w="full" h="full" objectFit="cover" />
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
              <Box animation="spin"><LoaderCircle size={15} /></Box>
            ) : playing ? (
              <Pause size={15} fill="currentColor" />
            ) : (
              <Play size={15} fill="currentColor" />
            )}
          </Flex>
        </Box>
        <Stack gap="1px" minW="0" flex="1">
          <Text fontSize="11.5px" color="studio.fg" fontWeight="500" truncate>{asset.title}</Text>
          <Text textStyle="data" fontSize="10px" color="studio.fgMuted">
            {formatDuration(asset.durationSec)}{asset.scope === "user" ? " · upload" : ""}
          </Text>
        </Stack>
        <Flex align="center" gap="3px">
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
            _hover={{ bg: "studio.subtle", color: asset.favorited ? "warning.fg" : "studio.fg" }}
            onClick={onFavorite}
          >
            <Star size={13} fill={asset.favorited ? "currentColor" : "none"} />
          </Flex>
          <Flex
            as="button"
            aria-label={`Add ${asset.title} at playhead`}
            aria-disabled={disabled}
            w="25px"
            h="25px"
            align="center"
            justify="center"
            borderRadius="full"
            bg="studio.accent"
            color="accent.contrast"
            opacity={disabled ? 0.45 : 1}
            cursor={disabled ? "not-allowed" : "pointer"}
            onClick={disabled ? undefined : onAdd}
          >
            <Plus size={13} />
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
            <Slider.Control><Slider.Track><Slider.Range /></Slider.Track><Slider.Thumbs /></Slider.Control>
          </Slider.Root>
          <Text textStyle="data" fontSize="9.5px" color="studio.fgMuted" whiteSpace="nowrap">
            {formatDuration(player.currentTime)} / {formatDuration(duration)}
          </Text>
        </Flex>
      ) : null}
    </Stack>
  );
}

export function SfxTab({ reloadKey, player, onOpenUploads }: SfxTabProps) {
  const { studioEdits, setStudioEdits, endCoalesce, playbackClock } = useStudio("studioEdits", "setStudioEdits", "endCoalesce", "playbackClock");
  const { assets, moodTags, loading, error, setFavorite } = useAudioAssetList("sfx", null, reloadKey);
  const [category, setCategory] = useState("all");
  const [search, setSearch] = useState("");
  const placements = studioEdits.sfx;
  const atCap = placements.length >= MAX_SFX_PLACEMENTS;

  const visibleAssets = useMemo(() => {
    return filterAudioAssets(assets, { category, search, activeId: player.activeId });
  }, [assets, category, player.activeId, search]);

  const addAtPlayhead = (asset: AudioAssetListRow) => {
    if (atCap) return;
    const startSec = Math.max(0, playbackClock.getSnapshot());
    setStudioEdits((prev) => ({
      ...prev,
      sfx: [
        ...prev.sfx,
        { id: crypto.randomUUID(), assetId: asset.id, title: asset.title, startSec, volume: 80 },
      ],
    }));
    toaster.create({
      type: "success",
      title: `${asset.title} added`,
      description: `Placed at ${formatTimecode(startSec)}.`,
    });
  };

  const updatePlacementVolume = (id: string, volume: number) =>
    setStudioEdits(
      (prev) => ({
        ...prev,
        sfx: prev.sfx.map((placement) => placement.id === id ? { ...placement, volume } : placement),
      }),
      `sfx-volume-${id}`,
    );

  const toggleFavorite = async (asset: AudioAssetListRow) => {
    try {
      await setFavorite(asset.id, !asset.favorited);
    } catch {
      toaster.create({ type: "error", title: "Couldn't update Saved effects" });
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
            aria-label="Search sound effects"
            placeholder="Search effects…"
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
          {search ? <Flex as="button" aria-label="Clear effect search" onClick={() => setSearch("")}><X size={12} /></Flex> : null}
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
          _hover={{ borderColor: "studio.borderStrong", color: "studio.fg" }}
          onClick={onOpenUploads}
        >
          <Upload size={14} />
        </Flex>
      </Flex>

      <Flex gap="6px" overflowX="auto" pb="2px" css={{ scrollbarWidth: "none" }}>
        <FilterChip label="All" active={category === "all"} onClick={() => setCategory("all")} />
        <FilterChip label="Saved" active={category === "saved"} onClick={() => setCategory("saved")} />
        {moodTags.map((tag) => <FilterChip key={tag} label={tag} active={category === tag} onClick={() => setCategory(tag)} />)}
      </Flex>

      {atCap ? (
        <Flex align="center" gap="6px" color="warning.fg">
          <AlertTriangle size={12} />
          <Text fontSize="10px">Remove an effect before adding another.</Text>
        </Flex>
      ) : null}

      <Box maxH="300px" overflowY="auto" pr="2px">
        <Stack gap="3px">
          {loading ? (
            <Flex align="center" gap="7px" py="18px" justify="center" color="studio.fgMuted">
              <Box animation="spin"><LoaderCircle size={14} /></Box>
              <Text fontSize="11px">Loading effects…</Text>
            </Flex>
          ) : error ? (
            <Text fontSize="11px" color="studio.danger" py="14px" textAlign="center">{error}</Text>
          ) : visibleAssets.length === 0 ? (
            <Stack align="center" gap="5px" py="22px" px="12px" textAlign="center">
              <Sparkles size={18} />
              <Text fontSize="11.5px" color="studio.fgMuted">
                {category === "saved"
                  ? "Save effects with the star and they’ll collect here."
                  : search
                    ? "No effects match this search."
                    : "No royalty-free effects have been added yet."}
              </Text>
              {!search && category !== "saved" ? (
                <Flex as="button" align="center" gap="5px" color="studio.accentFg" fontSize="10.5px" fontWeight="600" onClick={onOpenUploads}>
                  <Upload size={12} /> Upload an effect
                </Flex>
              ) : null}
            </Stack>
          ) : visibleAssets.map((asset) => (
            <SfxRow
              key={asset.id}
              asset={asset}
              player={player}
              disabled={atCap}
              onAdd={() => addAtPlayhead(asset)}
              onFavorite={() => void toggleFavorite(asset)}
            />
          ))}
        </Stack>
      </Box>

      <Box pt="3px">
        <Text textStyle="eyebrow" color="studio.fgMuted" mb="6px">
          On this clip · {placements.length}/{MAX_SFX_PLACEMENTS}
        </Text>
        {placements.length === 0 ? (
          <Text fontSize="10.5px" color="studio.fgSubtle">Effects are added at the playhead.</Text>
        ) : (
          <Stack gap="6px">
            {[...placements].sort((a, b) => a.startSec - b.startSec).map((placement) => (
              <Stack key={placement.id} gap="6px" p="9px" bg="studio.subtle" borderWidth="1px" borderColor="studio.border" borderRadius="l2">
                <Flex align="center" justify="space-between" gap="8px">
                  <Flex align="center" gap="7px" minW="0">
                    <Text textStyle="data" fontSize="10px" color="studio.timecode">{formatTimecode(placement.startSec)}</Text>
                    <Text fontSize="10.5px" color="studio.fg" fontWeight="500" truncate>{placement.title ?? "Sound effect"}</Text>
                  </Flex>
                  <Flex
                    as="button"
                    aria-label={`Remove ${placement.title ?? "sound effect"}`}
                    color="studio.fgMuted"
                    _hover={{ color: "studio.danger" }}
                    onClick={() => setStudioEdits((prev) => ({ ...prev, sfx: prev.sfx.filter((item) => item.id !== placement.id) }))}
                  >
                    <X size={12} />
                  </Flex>
                </Flex>
                <Flex align="center" gap="8px">
                  <Slider.Root
                    aria-label={[`${placement.title ?? "Sound effect"} volume`]}
                    value={[placement.volume]}
                    min={0}
                    max={100}
                    onValueChange={(event) => updatePlacementVolume(placement.id, event.value[0] ?? placement.volume)}
                    onValueChangeEnd={endCoalesce}
                    size="sm"
                    colorPalette="accent"
                    flex="1"
                  >
                    <Slider.Control><Slider.Track><Slider.Range /></Slider.Track><Slider.Thumbs /></Slider.Control>
                  </Slider.Root>
                  <Text textStyle="data" fontSize="10px" color="studio.fgMuted" w="32px" textAlign="right">{placement.volume}%</Text>
                </Flex>
              </Stack>
            ))}
          </Stack>
        )}
      </Box>
    </Stack>
  );
}

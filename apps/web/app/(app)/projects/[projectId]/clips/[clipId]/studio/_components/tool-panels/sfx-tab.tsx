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
import { toaster } from "@narriflow/ui/components/toaster";
import { STUDIO_EDIT_LIMITS } from "@narriflow/validators";
import { formatDuration, formatTimecode } from "@/lib/format";
import { useStudio } from "../studio-shell";
import {
  brandAudioRows,
  useAudioAssetList,
  type AudioAssetListRow,
  type PreviewPlayer,
} from "./audio-library";
import { brandAudioFirst, filterAudioAssets } from "./audio-library-filter";
import { chipProps, PanelEmpty, SectionLabel, softFocusWithin, studioSliderCss } from "./panel-ui";
import { AudioListError, AudioPager } from "./music-tab";

const MAX_SFX_PLACEMENTS = STUDIO_EDIT_LIMITS.sfx;

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
      textTransform="capitalize"
      cursor="pointer"
      {...chipProps(active)}
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
  /** Omitted for brand effects, which can't be starred. */
  onFavorite?: () => void;
}) {
  const active = player.activeId === asset.id;
  const playing = active && player.isPlaying;
  const loading = player.loadingId === asset.id;
  const duration = active && player.duration > 0 ? player.duration : asset.durationSec;

  return (
    <Stack
      gap="0"
      p="2"
      bg={active ? "studio.subtle" : "transparent"}
      borderRadius="12px"
      transition="background 120ms ease"
      _hover={{ bg: "studio.subtle" }}
    >
      <Flex align="center" gap="8px">
        <Box position="relative" w="44px" h="44px" flexShrink={0} overflow="hidden" borderRadius="8px">
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
            onClick={() => player.toggle(asset)}
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
          <Text fontSize="13px" color="studio.fg" fontWeight="500" truncate>{asset.title}</Text>
          <Text fontVariantNumeric="tabular-nums" fontSize="12px" color="studio.fgMuted">
            {formatDuration(asset.durationSec)}{asset.scope === "user" ? " · upload" : ""}
          </Text>
        </Stack>
        <Flex align="center" gap="3px">
          {onFavorite ? (
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
          ) : null}
          <Flex
            as="button"
            aria-label={`Add ${asset.title} at playhead`}
            aria-disabled={disabled}
            w="32px"
            h="32px"
            align="center"
            justify="center"
            borderRadius="full"
            bg="studio.raised"
            color="studio.fg"
            _hover={{ bg: "studio.fg", color: "studio.canvas" }}
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
            css={studioSliderCss}
            flex="1"
          >
            <Slider.Control><Slider.Track><Slider.Range /></Slider.Track><Slider.Thumbs /></Slider.Control>
          </Slider.Root>
          <Text fontVariantNumeric="tabular-nums" fontSize="12px" color="studio.fgMuted" whiteSpace="nowrap">
            {formatDuration(player.currentTime)} / {formatDuration(duration)}
          </Text>
        </Flex>
      ) : null}
    </Stack>
  );
}

export function SfxTab({ reloadKey, player, onOpenUploads }: SfxTabProps) {
  const { studioEdits, setStudioEdits, endCoalesce, playbackClock, brandAudio } = useStudio("studioEdits", "setStudioEdits", "endCoalesce", "playbackClock", "brandAudio");
  const [category, setCategory] = useState("all");
  const [search, setSearch] = useState("");
  const { assets, moodTags, loading, error, retry, setFavorite, hasMore, loadingMore, loadMoreError, loadMore } = useAudioAssetList(
    "sfx",
    category === "all" || category === "saved" ? null : category,
    reloadKey,
    { search, favorited: category === "saved" ? true : undefined },
  );
  const placements = studioEdits.sfx;
  const atCap = placements.length >= MAX_SFX_PLACEMENTS;

  const visibleAssets = useMemo(() => {
    const active = player.activeAsset;
    const rows = active?.kind === "sfx" && !assets.some((asset) => asset.id === active.id) ? [...assets, active] : assets;
    return filterAudioAssets(rows, { category, search, activeId: player.activeId });
  }, [assets, category, player.activeId, player.activeAsset, search]);

  const brandRows = useMemo(() => brandAudioRows(brandAudio.sfx, "sfx"), [brandAudio.sfx]);
  const groups = useMemo(
    () => brandAudioFirst(brandRows, visibleAssets, { category, search }),
    [brandRows, visibleAssets, category, search],
  );

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
    <Stack gap="4" px="5" pt="4" pb="4">
      <Flex align="center" gap="2">
        <Flex
          align="center"
          gap="2.5"
          h="40px"
          px="3"
          flex="1"
          bg="studio.subtle"
          borderRadius="10px"
          color="studio.fgSubtle"
          _focusWithin={softFocusWithin}
        >
          <Search size={14} />
          <Input
            aria-label="Search sound effects"
            placeholder="Search effects…"
            maxLength={120}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            p="0"
            border="0"
            outline="0"
            bg="transparent"
            fontSize="14px"
            color="studio.fg"
            _focusVisible={{ boxShadow: "none" }}
            _placeholder={{ color: "studio.fgSubtle" }}
          />
          {search ? <Flex as="button" aria-label="Clear effect search" minW="24px" minH="24px" align="center" justify="center" onClick={() => setSearch("")}><X size={12} /></Flex> : null}
        </Flex>
        <Flex
          as="button"
          aria-label="Open audio uploads"
          title="Upload audio"
          boxSize="40px"
          flexShrink={0}
          align="center"
          justify="center"
          borderRadius="10px"
          bg="studio.subtle"
          color="studio.fgMuted"
          cursor="pointer"
          transition="background 120ms ease, color 120ms ease"
          _hover={{ bg: "studio.raised", color: "studio.fg" }}
          onClick={onOpenUploads}
        >
          <Upload size={14} />
        </Flex>
      </Flex>

      <Flex gap="2" overflowX="auto" css={{ scrollbarWidth: "none" }}>
        <FilterChip label="All" active={category === "all"} onClick={() => setCategory("all")} />
        <FilterChip label="Saved" active={category === "saved"} onClick={() => setCategory("saved")} />
        {moodTags.map((tag) => <FilterChip key={tag} label={tag} active={category === tag} onClick={() => setCategory(tag)} />)}
      </Flex>

      {atCap ? (
        <Flex align="center" gap="2" px="3" py="2.5" bg="studio.subtle" borderRadius="10px" color="warning.fg">
          <AlertTriangle size={13} />
          <Text fontSize="12px">Remove an effect before adding another.</Text>
        </Flex>
      ) : null}

      <Box maxH="300px" overflowY="auto" mx="-1" px="1">
        <Stack gap="1">
          {groups.brand.length > 0 ? (
            <>
              <Text fontSize="12px" fontWeight="500" color="studio.fgSubtle" px="2" pb="1">Brand</Text>
              {groups.brand.map((asset) => (
                <SfxRow
                  key={asset.id}
                  asset={asset}
                  player={player}
                  disabled={atCap}
                  onAdd={() => addAtPlayhead(asset)}
                />
              ))}
              {groups.library.length > 0 ? (
                <Text fontSize="12px" fontWeight="500" color="studio.fgSubtle" px="2" pt="3" pb="1">Library</Text>
              ) : null}
            </>
          ) : null}
          {loading ? (
            <Flex align="center" gap="2" py="6" justify="center" color="studio.fgMuted">
              <Box animation="spin"><LoaderCircle size={14} /></Box>
              <Text fontSize="13px">Loading effects…</Text>
            </Flex>
          ) : error ? (
            <AudioListError message={error} onRetry={retry} />
          ) : groups.library.length === 0 && groups.brand.length === 0 ? (
            <PanelEmpty
              icon={<Sparkles size={18} />}
              title={category === "saved" ? "No saved effects" : search ? "No matches" : "No effects yet"}
              actions={
                !search && category !== "saved" ? (
                  <Flex as="button" minH="28px" minW="24px" px="3" align="center" gap="1.5" borderRadius="8px" bg="studio.raised" color="studio.fg" fontSize="13px" fontWeight="500" cursor="pointer" _hover={{ bg: "studio.borderStrong" }} onClick={onOpenUploads}>
                    <Upload size={13} /> Upload an effect
                  </Flex>
                ) : null
              }
            >
              {category === "saved"
                ? "Star an effect and it collects here."
                : search
                  ? "Try a different search."
                  : "Royalty-free effects will show up here."}
            </PanelEmpty>
          ) : groups.library.map((asset) => (
            <SfxRow
              key={asset.id}
              asset={asset}
              player={player}
              disabled={atCap}
              onAdd={() => addAtPlayhead(asset)}
              onFavorite={() => void toggleFavorite(asset)}
            />
          ))}
          <AudioPager error={loadMoreError} hasMore={hasMore} loading={loadingMore} onLoadMore={loadMore} />
        </Stack>
      </Box>

      <Box>
        <SectionLabel action={<Text textStyle="data" fontSize="12px" color="studio.fgSubtle">{placements.length}/{MAX_SFX_PLACEMENTS}</Text>}>
          On this clip
        </SectionLabel>
        {placements.length === 0 ? (
          <Flex align="center" h="40px" px="3" bg="studio.subtle" borderRadius="12px" color="studio.fgSubtle" fontSize="13px">
            Effects are added at the playhead.
          </Flex>
        ) : (
          <Stack gap="2">
            {[...placements].sort((a, b) => a.startSec - b.startSec).map((placement) => (
              <Stack key={placement.id} gap="3" p="3" bg="studio.subtle" borderRadius="12px">
                <Flex align="center" justify="space-between" gap="2">
                  <Flex align="center" gap="2" minW="0">
                    <Text textStyle="data" fontSize="12px" color="studio.timecode">{formatTimecode(placement.startSec)}</Text>
                    <Text fontSize="13px" color="studio.fg" fontWeight="500" truncate>{placement.title ?? "Sound effect"}</Text>
                  </Flex>
                  <Flex
                    as="button"
                    aria-label={`Remove ${placement.title ?? "sound effect"}`}
                    minW="24px"
                    minH="24px"
                    align="center"
                    justify="center"
                    color="studio.fgMuted"
                    cursor="pointer"
                    _hover={{ color: "studio.danger" }}
                    onClick={() => setStudioEdits((prev) => ({ ...prev, sfx: prev.sfx.filter((item) => item.id !== placement.id) }))}
                  >
                    <X size={14} />
                  </Flex>
                </Flex>
                <Flex align="center" gap="3">
                  <Slider.Root
                    aria-label={[`${placement.title ?? "Sound effect"} volume`]}
                    value={[placement.volume]}
                    min={0}
                    max={100}
                    onValueChange={(event) => updatePlacementVolume(placement.id, event.value[0] ?? placement.volume)}
                    onValueChangeEnd={endCoalesce}
                    size="sm"
                    css={studioSliderCss}
                    flex="1"
                  >
                    <Slider.Control><Slider.Track><Slider.Range /></Slider.Track><Slider.Thumbs /></Slider.Control>
                  </Slider.Root>
                  <Text textStyle="data" fontSize="12px" color="studio.fgMuted" w="40px" textAlign="right">{placement.volume}%</Text>
                </Flex>
              </Stack>
            ))}
          </Stack>
        )}
      </Box>
    </Stack>
  );
}

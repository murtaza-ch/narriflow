"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Flex, Image, Input, Slider, Stack, Text } from "@chakra-ui/react";
import { chipProps, softFieldProps, studioSliderCss, softFocusWithin } from "./panel-ui";
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
  brandAudioRows,
  useAudioAssetList,
  resolveAudioPlaybackUrl,
  type AudioAssetListRow,
  type PreviewPlayer,
} from "./audio-library";
import { brandAudioFirst, filterAudioAssets } from "./audio-library-filter";

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
      textTransform="capitalize"
      cursor="pointer"
      transition="background 120ms ease, border-color 120ms ease, color 120ms ease"
      {...chipProps(active)}
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
  /** Omitted for brand tracks, which can't be starred. */
  onFavorite?: () => void;
}) {
  const active = player.activeId === asset.id;
  const playing = active && player.isPlaying;
  const loading = player.loadingId === asset.id;
  const duration = active && player.duration > 0 ? player.duration : asset.durationSec;

  return (
    <Stack
      gap="0"
      p="8px"
      bg={active || selected ? "studio.subtle" : "transparent"}
      borderWidth="2px"
      borderColor={selected ? "studio.accent" : "transparent"}
      borderRadius="10px"
      transition="background 120ms ease, border-color 120ms ease"
      _hover={{ bg: "studio.subtle" }}
    >
      <Flex align="center" gap="8px">
        <Box position="relative" w="44px" h="44px" flexShrink={0} overflow="hidden" borderRadius="8px">
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
            onClick={() => player.toggle(asset)}
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
          <Text fontSize="13px" color="studio.fg" fontWeight="500" truncate>
            {asset.title}
          </Text>
          <Text fontVariantNumeric="tabular-nums" fontSize="12px" color="studio.fgMuted">
            {formatDuration(asset.durationSec)}
            {asset.scope === "user" ? " · upload" : ""}
          </Text>
        </Stack>

        <Flex align="center" gap="3px" flexShrink={0}>
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
            aria-label={selected ? `${asset.title} is in use` : `Use ${asset.title}`}
            aria-pressed={selected}
            w="32px"
            h="32px"
            align="center"
            justify="center"
            borderRadius="full"
            bg={selected ? "studio.accent" : "studio.raised"}
            color={selected ? "studio.canvas" : "studio.fg"}
            cursor="pointer"
            _hover={selected ? undefined : { bg: "studio.borderStrong" }}
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
            css={studioSliderCss}
            flex="1"
          >
            <Slider.Control>
              <Slider.Track>
                <Slider.Range />
              </Slider.Track>
              <Slider.Thumbs />
            </Slider.Control>
          </Slider.Root>
          <Text fontVariantNumeric="tabular-nums" fontSize="12px" color="studio.fgMuted" whiteSpace="nowrap">
            {formatDuration(player.currentTime)} / {formatDuration(duration)}
          </Text>
        </Flex>
      ) : null}
    </Stack>
  );
}

export function MusicTab({ reloadKey, player, onOpenUploads }: MusicTabProps) {
  const { studioEdits, setStudioEdits, endCoalesce, brandAudio } = useStudio("studioEdits", "setStudioEdits", "endCoalesce", "brandAudio");
  const music = studioEdits.music;
  const [category, setCategory] = useState("all");
  const [search, setSearch] = useState("");
  const { assets, moodTags, loading, error, retry, setFavorite, hasMore, loadingMore, loadMoreError, loadMore } = useAudioAssetList(
    "music",
    category === "all" || category === "saved" ? null : category,
    reloadKey,
    { search, favorited: category === "saved" ? true : undefined },
  );
  const [showMix, setShowMix] = useState(Boolean(music.assetId || music.url));
  const [showLinkInput, setShowLinkInput] = useState(false);
  const [urlDraft, setUrlDraft] = useState(music.url ?? "");
  const [titleDraft, setTitleDraft] = useState(music.title ?? "");
  const applyRequest = useRef(0);

  useEffect(() => () => { applyRequest.current++; }, []);

  useEffect(() => {
    setUrlDraft(music.url ?? "");
    setTitleDraft(music.title ?? "");
  }, [music]);

  const visibleAssets = useMemo(() => {
    const active = player.activeAsset;
    const rows = active?.kind === "music" && !assets.some((asset) => asset.id === active.id) ? [...assets, active] : assets;
    return filterAudioAssets(rows, { category, search, activeId: player.activeId });
  }, [assets, category, player.activeId, player.activeAsset, search]);

  const brandRows = useMemo(() => brandAudioRows(brandAudio.music, "music"), [brandAudio.music]);
  const groups = useMemo(
    () => brandAudioFirst(brandRows, visibleAssets, { category, search }),
    [brandRows, visibleAssets, category, search],
  );

  const selectedAssetDurationSec = [...brandRows, ...assets].find((asset) => asset.id === music.assetId)?.durationSec;
  const startOffsetMaxSec =
    selectedAssetDurationSec && selectedAssetDurationSec > 0
      ? Math.max(1, Math.ceil(selectedAssetDurationSec))
      : START_OFFSET_FALLBACK_MAX_SEC;

  const updateMusic = (patch: Partial<typeof music>, coalesceKey?: string) =>
    setStudioEdits((prev) => ({ ...prev, music: { ...prev.music, ...patch } }), coalesceKey);

  const applyTrack = async (asset: AudioAssetListRow) => {
    const request = ++applyRequest.current;
    try {
      const url = await resolveAudioPlaybackUrl(asset.id);
      if (request !== applyRequest.current) return;
      updateMusic({ assetId: asset.id, title: asset.title, url });
      setShowMix(true);
    } catch {
      if (request !== applyRequest.current) return;
      toaster.create({ type: "error", title: "Couldn't apply this track", description: "Please try again." });
    }
  };

  const clearMusic = () => {
    applyRequest.current++;
    setUrlDraft("");
    setTitleDraft("");
    setShowLinkInput(false);
    updateMusic({ assetId: null, title: null, url: null });
  };

  const applyLink = () => {
    applyRequest.current++;
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
    <Stack gap="14px" px="20px" pt="16px" pb="16px">
      <Flex align="center" gap="8px">
        <Flex
          align="center"
          gap="10px"
          h="40px"
          px="12px"
          flex="1"
          bg="studio.subtle"
          borderRadius="10px"
          color="studio.fgSubtle"
          _focusWithin={softFocusWithin}
        >
          <Search size={14} />
          <Input
            aria-label="Search music"
            placeholder="Search music…"
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
          {search ? (
            <Flex as="button" aria-label="Clear music search" minW="24px" minH="24px" align="center" justify="center" onClick={() => setSearch("")}>
              <X size={12} />
            </Flex>
          ) : null}
        </Flex>
        <Flex
          as="button"
          aria-label="Open audio uploads"
          w="40px"
          h="40px"
          align="center"
          justify="center"
          borderRadius="10px"
          bg="studio.subtle"
          color="studio.fgMuted"
          cursor="pointer"
          _hover={{ bg: "studio.raised", color: "studio.fg" }}
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
          {groups.brand.length > 0 ? (
            <>
              <Text fontSize="12px" fontWeight="500" color="studio.fgMuted" px="8px" pb="2px">Brand</Text>
              {groups.brand.map((asset) => (
                <TrackRow
                  key={asset.id}
                  asset={asset}
                  player={player}
                  selected={music.assetId === asset.id}
                  onUse={() => void applyTrack(asset)}
                />
              ))}
              {groups.library.length > 0 ? (
                <Text fontSize="12px" fontWeight="500" color="studio.fgMuted" px="8px" pt="8px" pb="2px">Library</Text>
              ) : null}
            </>
          ) : null}
          {loading ? (
            <Flex align="center" gap="7px" py="18px" justify="center" color="studio.fgMuted">
              <Box animation="spin">
                <LoaderCircle size={14} />
              </Box>
              <Text fontSize="13px">Loading music…</Text>
            </Flex>
          ) : error ? (
            <Stack align="center" gap="6px" py="14px" role="alert">
              <Text fontSize="12px" color="studio.danger" textAlign="center">{error}</Text>
              <Flex as="button" minH="24px" px="8px" align="center" color="studio.fg" fontSize="13px" onClick={retry}>
                Retry
              </Flex>
            </Stack>
          ) : groups.library.length === 0 && groups.brand.length === 0 ? (
            <Stack align="center" gap="8px" py="28px" px="12px" textAlign="center">
              <Music size={20} />
              <Text fontSize="13px" color="studio.fgMuted" lineHeight="1.5">
                {category === "saved"
                  ? "Save tracks with the star and they’ll collect here."
                  : search
                    ? "No music matches this search."
                    : "No royalty-free music has been added yet."}
              </Text>
              {!search && category !== "saved" ? (
                <Flex
                  as="button"
                  minH="24px"
                  minW="24px"
                  align="center"
                  gap="5px"
                  color="studio.fg"
                  fontSize="13px"
                  fontWeight="500"
                  cursor="pointer"
                  onClick={onOpenUploads}
                >
                  <Upload size={12} /> Upload a track
                </Flex>
              ) : null}
            </Stack>
          ) : (
            groups.library.map((asset) => (
              <TrackRow
                key={asset.id}
                asset={asset}
                player={player}
                selected={music.assetId === asset.id}
                onUse={() => void applyTrack(asset)}
                onFavorite={() => void toggleFavorite(asset)}
              />
            ))
          )}
          {loadMoreError ? (
            <Stack align="center" gap="6px" role="alert">
              <Text fontSize="12px" color="studio.danger">{loadMoreError}</Text>
              <Flex as="button" minH="24px" minW="24px" px="8px" align="center" fontSize="13px" onClick={loadMore}>Retry</Flex>
            </Stack>
          ) : hasMore ? (
            <Flex as="button" minH="32px" minW="24px" align="center" justify="center" fontSize="13px" aria-disabled={loadingMore} onClick={loadingMore ? undefined : loadMore}>
              {loadingMore ? "Loading…" : "Load more"}
            </Flex>
          ) : null}
        </Stack>
      </Box>

      {music.assetId || music.url ? (
        <Flex
          align="center"
          justify="space-between"
          gap="8px"
          px="14px"
          py="12px"
          bg="studio.subtle"
          borderRadius="10px"
        >
          <Flex align="center" gap="10px" minW="0">
            <Music size={15} />
            <Text fontSize="13px" color="studio.fg" fontWeight="500" truncate>
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
        fontSize="13px"
        fontWeight="500"
        cursor="pointer"
        _hover={{ color: "studio.fg" }}
        onClick={() => setShowLinkInput((value) => !value)}
      >
        <Flex align="center" gap="8px">
          <Link2 size={14} /> Paste a link instead
        </Flex>
        <ChevronDown size={14} style={{ transform: showLinkInput ? "rotate(180deg)" : undefined }} />
      </Flex>
      {showLinkInput ? (
        <Stack gap="7px">
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
          <Flex gap="7px">
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
              px="16px"
              borderRadius="10px"
              bg="studio.fg"
              color="studio.canvas"
              fontSize="13px"
              fontWeight="500"
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
        h="40px"
        px="12px"
        bg="studio.subtle"
        borderRadius="10px"
        color="studio.fg"
        fontSize="13px"
        fontWeight="500"
        cursor="pointer"
        _hover={{ bg: "studio.raised" }}
        onClick={() => setShowMix((value) => !value)}
      >
        <Flex align="center" gap="8px">
          <SlidersHorizontal size={14} /> Mix & timing
        </Flex>
        <ChevronDown size={14} style={{ transform: showMix ? "rotate(180deg)" : undefined }} />
      </Flex>

      {showMix ? (
        <Stack gap="14px" p="14px" bg="studio.subtle" borderRadius="10px">
          {([
            ["Volume", music.volume, 0, 100, 1, "%", "Music volume", "music-volume"],
            ["Start", Math.min(music.startOffsetSec, startOffsetMaxSec), 0, startOffsetMaxSec, 0.5, "s", "Music start offset", "music-start-offset"],
            ["Fade in", music.fadeInSec, 0, 5, 0.1, "s", "Music fade in", "music-fade-in"],
            ["Fade out", music.fadeOutSec, 0, 5, 0.1, "s", "Music fade out", "music-fade-out"],
          ] as const).map(([label, value, min, max, step, suffix, aria, coalesceKey]) => (
            <Flex key={label} align="center" gap="8px">
              <Text fontSize="12px" color="studio.fgMuted" w="56px" flexShrink={0}>{label}</Text>
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
                css={studioSliderCss}
                flex="1"
              >
                <Slider.Control><Slider.Track><Slider.Range /></Slider.Track><Slider.Thumbs /></Slider.Control>
              </Slider.Root>
              <Text fontVariantNumeric="tabular-nums" fontSize="12px" color="studio.fgMuted" w="40px" textAlign="right">
                {suffix === "%" ? Math.round(value) : value.toFixed(1)}{suffix}
              </Text>
            </Flex>
          ))}
          <Flex align="center" justify="space-between" pt="2px">
            <Stack gap="0">
              <Text fontSize="13px" color="studio.fg" fontWeight="500">Duck under speech</Text>
              <Text fontSize="12px" color="studio.fgSubtle">Lower music while people talk.</Text>
            </Stack>
            <Flex
              as="button"
              aria-pressed={music.ducking}
              aria-label={music.ducking ? "Disable ducking" : "Enable ducking"}
              h="30px"
              px="14px"
              align="center"
              borderRadius="full"
              bg={music.ducking ? "studio.accent" : "studio.raised"}
              color={music.ducking ? "studio.canvas" : "studio.fgMuted"}
              fontSize="12px"
              fontWeight="500"
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

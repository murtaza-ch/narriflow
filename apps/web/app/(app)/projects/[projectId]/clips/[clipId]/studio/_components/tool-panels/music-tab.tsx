"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Flex, Image, Input, Slider, Stack, Text } from "@chakra-ui/react";
import type { ReactNode } from "react";
import { chipProps, PanelEmpty, softFieldProps, softFocusWithin, studioSliderCss } from "./panel-ui";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Link2,
  LoaderCircle,
  Music,
  Pause,
  Play,
  Plus,
  RotateCw,
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
      {...chipProps(active)}
      onClick={onClick}
    >
      {label}
    </Flex>
  );
}

const softActionProps = {
  as: "button",
  minH: "28px",
  minW: "24px",
  px: "3",
  align: "center",
  gap: "1.5",
  borderRadius: "8px",
  bg: "studio.raised",
  color: "studio.fg",
  fontSize: "13px",
  fontWeight: "500",
  cursor: "pointer",
  _hover: { bg: "studio.borderStrong" },
} as const;

/** A library list that failed to load: one message and a retry, in the panels' empty-state style. */
export function AudioListError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Box role="alert">
      <PanelEmpty
        icon={<AlertTriangle size={18} />}
        title={message}
        actions={
          <Flex {...softActionProps} onClick={onRetry}>
            <RotateCw size={13} />
            Retry
          </Flex>
        }
      />
    </Box>
  );
}

/** The foot of a paged list: a failed next page with its retry, or the Load more button. */
export function AudioPager({
  error,
  hasMore,
  loading,
  onLoadMore,
}: {
  error: string | null;
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
}) {
  if (error) {
    return (
      <Flex role="alert" align="center" justify="space-between" gap="3" px="3" py="2" bg="studio.subtle" borderRadius="12px">
        <Flex align="center" gap="2" color="studio.danger" minW="0">
          <Box flexShrink={0}><AlertTriangle size={13} /></Box>
          <Text fontSize="12px">{error}</Text>
        </Flex>
        <Flex {...softActionProps} onClick={onLoadMore}>Retry</Flex>
      </Flex>
    );
  }
  if (!hasMore) return null;
  return (
    <Flex
      as="button"
      minH="36px"
      minW="24px"
      align="center"
      justify="center"
      borderRadius="10px"
      bg="studio.subtle"
      color="studio.fgMuted"
      fontSize="13px"
      fontWeight="500"
      cursor="pointer"
      _hover={{ bg: "studio.surface", color: "studio.fg" }}
      aria-disabled={loading}
      onClick={loading ? undefined : onLoadMore}
    >
      {loading ? "Loading…" : "Load more"}
    </Flex>
  );
}

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
      p="2"
      bg={selected ? "studio.accentSubtle" : active ? "studio.subtle" : "transparent"}
      borderRadius="12px"
      transition="background 120ms ease"
      _hover={{ bg: selected ? "studio.accentSubtle" : "studio.subtle" }}
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
            color={selected ? "white" : "studio.fg"}
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
        <CategoryChip label="All" active={category === "all"} onClick={() => setCategory("all")} />
        <CategoryChip label="Saved" active={category === "saved"} onClick={() => setCategory("saved")} />
        {moodTags.map((tag) => (
          <CategoryChip key={tag} label={tag} active={category === tag} onClick={() => setCategory(tag)} />
        ))}
      </Flex>

      <Box maxH="330px" overflowY="auto" mx="-1" px="1">
        <Stack gap="1">
          {groups.brand.length > 0 ? (
            <>
              <Text fontSize="12px" fontWeight="500" color="studio.fgSubtle" px="2" pb="1">Brand</Text>
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
                <Text fontSize="12px" fontWeight="500" color="studio.fgSubtle" px="2" pt="3" pb="1">Library</Text>
              ) : null}
            </>
          ) : null}
          {loading ? (
            <Flex align="center" gap="2" py="6" justify="center" color="studio.fgMuted">
              <Box animation="spin">
                <LoaderCircle size={14} />
              </Box>
              <Text fontSize="13px">Loading music…</Text>
            </Flex>
          ) : error ? (
            <AudioListError message={error} onRetry={retry} />
          ) : groups.library.length === 0 && groups.brand.length === 0 ? (
            <PanelEmpty
              icon={<Music size={18} />}
              title={category === "saved" ? "No saved tracks" : search ? "No matches" : "No music yet"}
              actions={
                !search && category !== "saved" ? (
                  <Flex {...softActionProps} onClick={onOpenUploads}>
                    <Upload size={13} /> Upload a track
                  </Flex>
                ) : null
              }
            >
              {category === "saved"
                ? "Star a track and it collects here."
                : search
                  ? "Try a different search."
                  : "Royalty-free tracks will show up here."}
            </PanelEmpty>
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
          <AudioPager error={loadMoreError} hasMore={hasMore} loading={loadingMore} onLoadMore={loadMore} />
        </Stack>
      </Box>

      {music.assetId || music.url ? (
        <Flex align="center" justify="space-between" gap="2" p="2" pe="3" bg="studio.subtle" borderRadius="12px">
          <Flex align="center" gap="3" minW="0">
            <Flex boxSize="32px" flexShrink={0} align="center" justify="center" borderRadius="full" bg="studio.accentSubtle" color="studio.accentFg">
              <Music size={15} />
            </Flex>
            <Text fontSize="13px" color="studio.fg" fontWeight="500" truncate>
              {music.title ?? "Music applied"}
            </Text>
          </Flex>
          <Flex as="button" aria-label="Remove music" minW="24px" minH="24px" align="center" justify="center" color="studio.fgMuted" cursor="pointer" _hover={{ color: "studio.fg" }} onClick={clearMusic}>
            <X size={14} />
          </Flex>
        </Flex>
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

      <Disclosure icon={<SlidersHorizontal size={14} />} label="Mix & timing" open={showMix} onToggle={() => setShowMix((value) => !value)}>
        <Stack gap="4" px="1">
          {([
            ["Volume", music.volume, 0, 100, 1, "%", "Music volume", "music-volume"],
            ["Start", Math.min(music.startOffsetSec, startOffsetMaxSec), 0, startOffsetMaxSec, 0.5, "s", "Music start offset", "music-start-offset"],
            ["Fade in", music.fadeInSec, 0, 5, 0.1, "s", "Music fade in", "music-fade-in"],
            ["Fade out", music.fadeOutSec, 0, 5, 0.1, "s", "Music fade out", "music-fade-out"],
          ] as const).map(([label, value, min, max, step, suffix, aria, coalesceKey]) => (
            <Flex key={label} align="center" gap="3">
              <Text fontSize="13px" color="studio.fgMuted" w="56px" flexShrink={0}>{label}</Text>
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
              <Text textStyle="data" fontSize="12px" color="studio.fgMuted" w="44px" textAlign="right">
                {suffix === "%" ? Math.round(value) : value.toFixed(1)}{suffix}
              </Text>
            </Flex>
          ))}
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
              onClick={() => updateMusic({ ducking: !music.ducking })}
            >
              {music.ducking ? "On" : "Off"}
            </Flex>
          </Flex>
        </Stack>
      </Disclosure>
    </Stack>
  );
}

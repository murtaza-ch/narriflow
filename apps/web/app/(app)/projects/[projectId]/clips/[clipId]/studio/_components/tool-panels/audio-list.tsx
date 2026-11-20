"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Box, Flex, Input, Slider, Stack, Text } from "@chakra-ui/react";
import {
  AlertTriangle,
  Check,
  LoaderCircle,
  Pause,
  Play,
  Plus,
  RotateCw,
  Search,
  Star,
  Upload,
  X,
} from "lucide-react";
import { formatDuration } from "@/lib/format";

/** Short sounds read in seconds ("0.4s"), so a sub-second effect never shows as 0:00. */
export function formatAssetDuration(durationSec: number): string {
  if (durationSec > 0 && durationSec < 10) return `${durationSec.toFixed(1)}s`;
  return formatDuration(durationSec);
}
import { audioArt } from "./audio-art";
import {
  type AudioAssetListRow,
  type PreviewPlayer,
  useAudioLibrary,
} from "./audio-library";
import { brandAudioFirst, filterAudioAssets, pinActiveAudio } from "./audio-library-filter";
import { chipProps, PanelEmpty, softFocusWithin, studioSliderCss } from "./panel-ui";

const SEARCH_DEBOUNCE_MS = 250;
const SKELETON_ROWS = 8;
/** How far ahead of the end of the list the next page is requested. */
const PREFETCH_MARGIN = "400px 0px";

/** The value after it has stopped changing for `delayMs`. */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

export const softActionProps = {
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

function CategoryChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
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

// Actions sit over the row's right edge and appear on hover or focus; a track
// that is saved, in use or being previewed keeps its marks visible.
const REVEAL_CSS = {
  "& [data-reveal]": { opacity: 0, pointerEvents: "none" },
  "&:hover [data-reveal], &:focus-within [data-reveal], & [data-reveal][data-pinned]": {
    opacity: 1,
    pointerEvents: "auto",
  },
} as const;

export interface AudioRowAction {
  ariaLabel: string;
  /** The track is already part of the clip. */
  selected?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

/**
 * One library track, Vizard-style: a square cover (a gradient from the asset
 * id) with the play/pause control on it, the title, then duration, artist and
 * a credit hint for CC BY tracks. Save and Use appear on hover.
 */
export function AudioRow({
  asset,
  player,
  use,
  onFavorite,
}: {
  asset: AudioAssetListRow;
  player: PreviewPlayer;
  use: AudioRowAction;
  /** Omitted for brand tracks, which can't be starred. */
  onFavorite?: () => void;
}) {
  const active = player.activeId === asset.id;
  const playing = active && player.isPlaying;
  const loading = player.loadingId === asset.id;
  const duration = active && player.duration > 0 ? player.duration : asset.durationSec;
  const art = useMemo(() => audioArt(asset.id), [asset.id]);
  const rowBg = use.selected ? "studio.accentSubtle" : active ? "studio.subtle" : "transparent";
  const hoverBg = use.selected ? "studio.accentSubtle" : "studio.subtle";

  return (
    <Stack
      gap="0"
      p="2"
      bg={rowBg}
      borderRadius="12px"
      transition="background 120ms ease"
      _hover={{ bg: hoverBg }}
      css={REVEAL_CSS}
    >
      <Flex align="center" gap="10px" position="relative">
        <Box
          position="relative"
          w="44px"
          h="44px"
          flexShrink={0}
          overflow="hidden"
          borderRadius="8px"
          style={{ background: art.background }}
        >
          <Flex
            as="button"
            aria-label={playing ? `Pause ${asset.title}` : `Preview ${asset.title}`}
            position="absolute"
            inset="0"
            align="center"
            justify="center"
            color="white"
            bg={active ? "blackAlpha.300" : "transparent"}
            cursor="pointer"
            _hover={{ bg: "blackAlpha.500" }}
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
          <Flex align="center" gap="1.5" minW="0" fontSize="12px" color="studio.fgMuted">
            <Text as="span" flexShrink={0} fontVariantNumeric="tabular-nums">
              {formatAssetDuration(asset.durationSec)}
            </Text>
            {asset.artist ? (
              <Text as="span" truncate minW="0">
                · {asset.artist}
              </Text>
            ) : null}
            {asset.scope === "user" ? (
              <Text as="span" flexShrink={0}>
                · upload
              </Text>
            ) : null}
            {asset.attribution ? (
              <Text
                as="span"
                flexShrink={0}
                px="1.5"
                lineHeight="16px"
                borderRadius="4px"
                bg="studio.raised"
                color="studio.fgMuted"
                fontSize="10.5px"
                fontWeight="500"
                title="Credit required. Copy it from the track card after you add it."
              >
                Credit
              </Text>
            ) : null}
          </Flex>
        </Stack>

        <Flex
          data-reveal
          data-pinned={active || use.selected || undefined}
          position="absolute"
          insetEnd="0"
          top="50%"
          transform="translateY(-50%)"
          align="center"
          gap="3px"
          ps="2"
          borderRadius="full"
          bg={use.selected ? "studio.accentSubtle" : "studio.subtle"}
          transition="opacity 120ms ease"
        >
          {onFavorite ? (
            <Flex
              as="button"
              data-pinned={asset.favorited || undefined}
              aria-label={asset.favorited ? `Remove ${asset.title} from Saved` : `Save ${asset.title}`}
              aria-pressed={asset.favorited}
              w="25px"
              h="25px"
              align="center"
              justify="center"
              borderRadius="full"
              color={asset.favorited ? "warning.fg" : "studio.fgMuted"}
              cursor="pointer"
              _hover={{ bg: "studio.raised", color: asset.favorited ? "warning.fg" : "studio.fg" }}
              onClick={onFavorite}
            >
              <Star size={13} fill={asset.favorited ? "currentColor" : "none"} />
            </Flex>
          ) : null}
          <Flex
            as="button"
            aria-label={use.ariaLabel}
            aria-pressed={use.selected}
            aria-disabled={use.disabled}
            w="32px"
            h="32px"
            align="center"
            justify="center"
            borderRadius="full"
            bg={use.selected ? "studio.accent" : "studio.raised"}
            color={use.selected ? "white" : "studio.fg"}
            opacity={use.disabled ? 0.45 : 1}
            cursor={use.disabled ? "not-allowed" : "pointer"}
            _hover={use.selected || use.disabled ? undefined : { bg: "studio.borderStrong" }}
            onClick={use.disabled ? undefined : use.onClick}
          >
            {use.selected ? <Check size={13} /> : <Plus size={13} />}
          </Flex>
        </Flex>
      </Flex>

      {active ? (
        <Flex align="center" gap="7px" mt="7px" pl="54px">
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

/** Placeholder rows for the very first load of a list. */
export function AudioRowSkeletons({ label }: { label: string }) {
  const shimmer = {
    background:
      "linear-gradient(90deg, var(--chakra-colors-studio-subtle) 25%, var(--chakra-colors-studio-surface) 50%, var(--chakra-colors-studio-subtle) 75%)",
    backgroundSize: "200% 100%",
  };
  return (
    <Stack gap="1" role="status" aria-label={label}>
      {Array.from({ length: SKELETON_ROWS }, (_, index) => (
        <Flex key={index} align="center" gap="10px" p="2">
          <Box w="44px" h="44px" borderRadius="8px" flexShrink={0} animation="shimmer" style={shimmer} />
          <Stack gap="6px" flex="1">
            <Box h="12px" w={`${55 + ((index * 17) % 30)}%`} borderRadius="4px" animation="shimmer" style={shimmer} />
            <Box h="10px" w="28%" borderRadius="4px" animation="shimmer" style={shimmer} />
          </Stack>
        </Flex>
      ))}
    </Stack>
  );
}

/**
 * The list's scroll area: it fills the room the panel leaves and scrolls
 * inside. When the end comes within ~400px an observer asks for the next page,
 * so there is no "Load more" button; a failed page shows its retry.
 */
export function AudioScrollList({
  children,
  canLoadMore,
  loadingMore,
  loadMoreError,
  onLoadMore,
  compact = false,
}: {
  children: ReactNode;
  /** More pages exist and no request is in flight: the observer is armed only then. */
  canLoadMore: boolean;
  loadingMore: boolean;
  loadMoreError: string | null;
  onLoadMore: () => void;
  /** Sized by its rows, up to a cap, instead of filling the panel. */
  compact?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef(onLoadMore);
  loadMoreRef.current = onLoadMore;

  // A fresh observer reports the sentinel's state straight away, so a page that
  // arrives while the end is still near chains into the next one.
  useEffect(() => {
    const root = rootRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel || !canLoadMore) return;
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMoreRef.current();
      },
      { root, rootMargin: PREFETCH_MARGIN },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [canLoadMore]);

  return (
    <Box
      ref={rootRef}
      flex={compact ? "none" : "1 1 0"}
      minH={compact ? "0" : "240px"}
      maxH={compact ? "280px" : undefined}
      overflowY="auto"
      mx="-1"
      px="1"
      css={{
        "&::-webkit-scrollbar": { width: "4px" },
        "&::-webkit-scrollbar-thumb": { background: "var(--chakra-colors-studio-raised)", borderRadius: "4px" },
      }}
    >
      <Stack gap="1">
        {children}
        <Box ref={sentinelRef} h="1px" aria-hidden />
        {loadMoreError ? (
          <Flex role="alert" align="center" justify="space-between" gap="3" px="3" py="2" bg="studio.subtle" borderRadius="12px">
            <Flex align="center" gap="2" color="studio.danger" minW="0">
              <Box flexShrink={0}>
                <AlertTriangle size={13} />
              </Box>
              <Text fontSize="12px">{loadMoreError}</Text>
            </Flex>
            <Flex {...softActionProps} onClick={onLoadMore}>
              Retry
            </Flex>
          </Flex>
        ) : loadingMore ? (
          <Flex align="center" justify="center" gap="2" py="3" color="studio.fgMuted">
            <Box animation="spin">
              <LoaderCircle size={13} />
            </Box>
            <Text fontSize="12px">Loading more…</Text>
          </Flex>
        ) : null}
      </Stack>
    </Box>
  );
}

export interface AudioBrowserLabels {
  /** "music" / "effects": used in the search placeholder and empty states. */
  searchLabel: string;
  searchPlaceholder: string;
  clearSearchLabel: string;
  loadingLabel: string;
  emptyTitle: string;
  emptyHint: string;
  savedTitle: string;
  savedHint: string;
  uploadLabel: string;
  emptyIcon: ReactNode;
}

/**
 * Search, mood chips and the track list, shared by the Music and Sound effects
 * tabs. Renders as siblings so a tab can put its own blocks around the list;
 * the list is the one part that grows.
 */
export function AudioBrowser({
  kind,
  labels,
  player,
  brandRows,
  notice,
  onOpenUploads,
  rowAction,
  onFavoriteFailed,
}: {
  kind: "music" | "sfx";
  labels: AudioBrowserLabels;
  player: PreviewPlayer;
  brandRows: AudioAssetListRow[];
  notice?: ReactNode;
  onOpenUploads: () => void;
  rowAction: (asset: AudioAssetListRow) => AudioRowAction;
  onFavoriteFailed: () => void;
}) {
  const [category, setCategory] = useState("all");
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search.trim(), SEARCH_DEBOUNCE_MS);
  const list = useAudioLibrary({
    kind,
    mood: category === "all" || category === "saved" ? null : category,
    search: debouncedSearch,
    favorited: category === "saved" ? true : undefined,
  });

  const visibleAssets = useMemo(() => {
    // Until the server's rows for this filter land, narrow the previous rows
    // locally so typing and chips answer at once; after that they are the server's.
    const current = list.settled && debouncedSearch === search.trim()
      ? list.assets
      : filterAudioAssets(list.assets, { category, search, activeId: null });
    const active = player.activeAsset?.kind === kind ? player.activeAsset : null;
    return pinActiveAudio(current, active);
  }, [list.assets, list.settled, category, debouncedSearch, search, player.activeAsset, kind]);

  const groups = useMemo(
    () => brandAudioFirst(brandRows, visibleAssets, { category, search }),
    [brandRows, visibleAssets, category, search],
  );

  const toggleFavorite = async (asset: AudioAssetListRow) => {
    try {
      await list.setFavorite(asset.id, !asset.favorited);
    } catch {
      onFavoriteFailed();
    }
  };

  const empty = groups.library.length === 0 && groups.brand.length === 0;
  const tracksLabel = labels.searchLabel;

  return (
    <>
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
            aria-label={`Search ${tracksLabel}`}
            placeholder={labels.searchPlaceholder}
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
            <Flex
              as="button"
              aria-label={labels.clearSearchLabel}
              minW="24px"
              minH="24px"
              align="center"
              justify="center"
              onClick={() => setSearch("")}
            >
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

      <Flex gap="2" overflowX="auto" flexShrink={0} css={{ scrollbarWidth: "none" }}>
        <CategoryChip label="All" active={category === "all"} onClick={() => setCategory("all")} />
        <CategoryChip label="Saved" active={category === "saved"} onClick={() => setCategory("saved")} />
        {list.moodTags.map((tag) => (
          <CategoryChip key={tag} label={tag} active={category === tag} onClick={() => setCategory(tag)} />
        ))}
      </Flex>

      {notice}

      <AudioScrollList
        canLoadMore={list.canLoadMore}
        loadingMore={list.loadingMore}
        loadMoreError={list.loadMoreError}
        onLoadMore={list.loadMore}
      >
        {groups.brand.length > 0 ? (
          <>
            <Text fontSize="12px" fontWeight="500" color="studio.fgSubtle" px="2" pb="1">
              Brand
            </Text>
            {groups.brand.map((asset) => (
              <AudioRow key={asset.id} asset={asset} player={player} use={rowAction(asset)} />
            ))}
            {groups.library.length > 0 ? (
              <Text fontSize="12px" fontWeight="500" color="studio.fgSubtle" px="2" pt="3" pb="1">
                Library
              </Text>
            ) : null}
          </>
        ) : null}
        {list.loading ? (
          <AudioRowSkeletons label={labels.loadingLabel} />
        ) : list.error ? (
          <AudioListError message={list.error} onRetry={list.retry} />
        ) : empty ? (
          <PanelEmpty
            icon={labels.emptyIcon}
            title={category === "saved" ? labels.savedTitle : search ? "No matches" : labels.emptyTitle}
            actions={
              !search && category !== "saved" ? (
                <Flex {...softActionProps} onClick={onOpenUploads}>
                  <Upload size={13} /> {labels.uploadLabel}
                </Flex>
              ) : null
            }
          >
            {category === "saved" ? labels.savedHint : search ? "Try a different search." : labels.emptyHint}
          </PanelEmpty>
        ) : (
          groups.library.map((asset) => (
            <AudioRow
              key={asset.id}
              asset={asset}
              player={player}
              use={rowAction(asset)}
              onFavorite={() => void toggleFavorite(asset)}
            />
          ))
        )}
      </AudioScrollList>
    </>
  );
}

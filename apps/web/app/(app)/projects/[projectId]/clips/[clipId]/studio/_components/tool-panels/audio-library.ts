"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { scopedKey, type WorkspaceScope } from "@narriflow/api-client";
import { type BrandApi, type BrandClient, brandClientFor, brandMutations, brandQueries } from "@narriflow/api-client/brand";
import {
  type InfiniteData,
  infiniteQueryOptions,
  keepPreviousData,
  type QueryClient,
  useInfiniteQuery,
  useQueries,
} from "@tanstack/react-query";
import { type InferResponseType, parseResponse } from "hono/client";
import type { AudioAssetKindInput, BrandAudioReference } from "@narriflow/validators";
import { toaster } from "@narriflow/ui/components/toaster";
import { useApiRuntime, useWorkspaceScope } from "@/app/_components/api-provider";
import { orderMoodTags } from "./audio-library-filter";

/** One row of the Music/SFX library, as the API lists it. */
export type AudioAssetListRow = InferResponseType<BrandClient["audio-assets"]["$get"], 200>["assets"][number];

/** The transport + selected Workspace the audio helpers call the Brand API with. */
export function useAudioApi(): BrandApi | null {
  const runtime = useApiRuntime();
  const scope = useWorkspaceScope();
  return useMemo(() => (scope ? { transport: runtime.transport, scope } : null), [runtime, scope]);
}

/** One page of the list, as the API returns it. */
export type AudioAssetPage = InferResponseType<BrandClient["audio-assets"]["$get"], 200>;

export const AUDIO_PAGE_SIZE = 40;
/** A page is cheap to keep: favourites are patched in place and uploads invalidate, so a stale refetch of every loaded page is never needed on a tab switch. */
const AUDIO_LIST_STALE_MS = 5 * 60_000;
const AUDIO_LIST_GC_MS = 30 * 60_000;
const LIST_RESOURCE = "audio-assets-pages";

export interface AudioListFilters {
  kind: AudioAssetKindInput;
  mood?: string | null;
  search?: string;
  scope?: "all" | "user";
  favorited?: boolean;
}

/** Only what narrows the list: an unfiltered list has the same key wherever it is asked for. */
function listFilters(filters: AudioListFilters): Record<string, string | boolean> {
  const query: Record<string, string | boolean> = { kind: filters.kind };
  if (filters.mood) query.mood = filters.mood;
  const search = filters.search?.trim();
  if (search) query.search = search;
  if (filters.scope) query.scope = filters.scope;
  if (filters.favorited !== undefined) query.favorited = filters.favorited;
  return query;
}

function listKeyPrefix(scope: WorkspaceScope): unknown[] {
  return scopedKey(scope, "brand", LIST_RESOURCE) as unknown[];
}

/**
 * The library list as an infinite query: one entry per filter, `nextOffset`
 * continues it. Keyed under the Brand domain, so the Brand Kit's own
 * invalidation reaches it too.
 */
export function audioListQuery(api: BrandApi | null, filters: AudioListFilters) {
  const query = listFilters(filters);
  return infiniteQueryOptions({
    queryKey: (api ? scopedKey(api.scope, "brand", LIST_RESOURCE, query) : ["nf-audio-unscoped", query]) as unknown[],
    queryFn: ({ pageParam, signal }) => {
      if (!api) throw new Error("Couldn't load the audio library.");
      const params: Record<string, string> = { limit: String(AUDIO_PAGE_SIZE), offset: String(pageParam) };
      for (const [name, value] of Object.entries(query)) params[name] = String(value);
      return parseResponse(
        brandClientFor(api)["audio-assets"].$get({ query: params as { kind: AudioAssetKindInput } }, { init: { signal } }),
      );
    },
    initialPageParam: 0,
    getNextPageParam: (last: AudioAssetPage) => last.nextOffset ?? undefined,
    staleTime: AUDIO_LIST_STALE_MS,
    gcTime: AUDIO_LIST_GC_MS,
    refetchOnWindowFocus: false,
  });
}

/**
 * Warms the first page of curated music and sound effects, so opening the
 * panel paints rows from the cache. Called once when the Studio mounts.
 */
export function usePrefetchAudioLibrary(): void {
  const runtime = useApiRuntime();
  const api = useAudioApi();
  useEffect(() => {
    if (!api) return;
    for (const kind of ["music", "sfx"] as const) {
      const options = audioListQuery(api, { kind });
      // A list already loaded (maybe several pages deep) stays as it is: a one-page prefetch would trim it.
      if (runtime.queryClient.getQueryData(options.queryKey) !== undefined) continue;
      void runtime.queryClient.prefetchInfiniteQuery({ ...options, pages: 1 });
    }
  }, [api, runtime]);
}

/** Marks every cached library list stale: after an upload or a delete. */
export function invalidateAudioLibrary(queryClient: QueryClient, scope: WorkspaceScope): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: listKeyPrefix(scope) });
}

type AudioListCache = InfiniteData<AudioAssetPage, number>;

function patchFavorite(queryClient: QueryClient, scope: WorkspaceScope, assetId: string, favorited: boolean) {
  queryClient.setQueriesData<AudioListCache>({ queryKey: listKeyPrefix(scope) }, (data) =>
    data && {
      ...data,
      pages: data.pages.map((page) => ({
        ...page,
        assets: page.assets.map((asset) => (asset.id === assetId ? { ...asset, favorited } : asset)),
      })),
    },
  );
}

/** The favourite flag the cache currently shows for an asset, if any cached list has it. */
function cachedFavorite(queryClient: QueryClient, scope: WorkspaceScope, assetId: string): boolean | undefined {
  for (const [, data] of queryClient.getQueriesData<AudioListCache>({ queryKey: listKeyPrefix(scope) })) {
    for (const page of data?.pages ?? []) {
      const asset = page.assets.find((row) => row.id === assetId);
      if (asset) return asset.favorited;
    }
  }
  return undefined;
}

export interface AudioLibraryList {
  assets: AudioAssetListRow[];
  /** Every tag the library offers for this kind, in the curated chip order. */
  moodTags: string[];
  /** A cold first load: nothing to show yet, not even a previous filter's rows. */
  loading: boolean;
  error: string | null;
  retry: () => void;
  /** False while the rows still belong to the previous filter. */
  settled: boolean;
  /** More pages exist and nothing is in flight, so asking for the next one now is safe. */
  canLoadMore: boolean;
  loadingMore: boolean;
  loadMoreError: string | null;
  loadMore: () => void;
  setFavorite: (assetId: string, favorited: boolean) => Promise<void>;
}

/**
 * A filter change keeps the previous rows on screen until the new ones land
 * (`settled` is false meanwhile), so only the very first load shows a skeleton.
 */
export function useAudioLibrary(filters: AudioListFilters): AudioLibraryList {
  const runtime = useApiRuntime();
  const api = useAudioApi();
  const { queryClient } = runtime;
  const query = useInfiniteQuery(
    { ...audioListQuery(api, filters), enabled: api !== null, placeholderData: keepPreviousData },
    queryClient,
  );
  const { data, isFetching, isFetchingNextPage, hasNextPage, fetchNextPage, refetch } = query;

  const assets = useMemo(() => {
    const rows = new Map<string, AudioAssetListRow>();
    for (const page of data?.pages ?? []) for (const asset of page.assets) if (!rows.has(asset.id)) rows.set(asset.id, asset);
    return [...rows.values()];
  }, [data]);
  const moodTags = useMemo(() => orderMoodTags(filters.kind, data?.pages[0]?.moodTags ?? []), [data, filters.kind]);

  const settled = !query.isPlaceholderData;
  const loadMore = useCallback(() => {
    // fetchNextPage restarts a request already in flight, so only ask when idle.
    if (hasNextPage && settled && !isFetching) void fetchNextPage();
  }, [hasNextPage, settled, isFetching, fetchNextPage]);

  const setFavorite = useCallback(async (assetId: string, favorited: boolean) => {
    if (!api) throw new Error("Couldn't update Saved tracks.");
    // Roll back to what the cache showed before this write, not to the inverse of the request.
    const previous = cachedFavorite(queryClient, api.scope, assetId) ?? !favorited;
    patchFavorite(queryClient, api.scope, assetId, favorited);
    try {
      const mutations = brandMutations(api);
      await (favorited ? mutations.favoriteAudio(assetId) : mutations.unfavoriteAudio(assetId));
    } catch (error) {
      patchFavorite(queryClient, api.scope, assetId, previous);
      throw error;
    }
    // Saved lists gain or lose the row; mark them stale, refetching when next shown.
    void queryClient.invalidateQueries({
      queryKey: listKeyPrefix(api.scope),
      predicate: (entry) => (entry.queryKey.at(-1) as { favorited?: boolean } | undefined)?.favorited === true,
      refetchType: "none",
    });
  }, [api, queryClient]);

  return {
    assets,
    moodTags,
    loading: api === null || (query.isPending && !data),
    error: query.isError && !data ? "Couldn't load the audio library." : null,
    retry: () => void refetch(),
    settled,
    canLoadMore: Boolean(hasNextPage) && settled && !isFetching && !query.isFetchNextPageError,
    loadingMore: isFetchingNextPage,
    loadMoreError: query.isFetchNextPageError ? "Couldn't load more audio." : null,
    loadMore,
    setFavorite,
  };
}

/** A credit never changes for a track, so one lookup serves the whole session. */
const ATTRIBUTION_STALE_MS = 30 * 60_000;

function attributionMap(results: ReadonlyArray<{ data?: { attribution?: string | null } }>, ids: readonly string[]) {
  const attributions = new Map<string, string | null>();
  results.forEach((result, index) => {
    const id = ids[index];
    if (id !== undefined && result.data) attributions.set(id, result.data.attribution ?? null);
  });
  return attributions;
}

/**
 * The credit of each given asset, by id, from the playback-url endpoint: one
 * deduped, cached lookup per asset, independent of which library pages were
 * ever loaded. An asset still loading, or that failed, owes nothing yet.
 */
export function useAudioAttributions(assetIds: readonly string[]): ReadonlyMap<string, string | null> {
  const runtime = useApiRuntime();
  const api = useAudioApi();
  // Keyed by content, so an unrelated edit that rebuilds the caller's array rebuilds nothing here.
  const idsKey = [...new Set(assetIds)].sort().join(",");
  const ids = useMemo(() => (idsKey ? idsKey.split(",") : []), [idsKey]);
  const queries = useMemo(
    () =>
      api
        ? ids.map((id) => ({
            ...brandQueries(api).audioPlaybackUrl(id),
            staleTime: ATTRIBUTION_STALE_MS,
            refetchOnWindowFocus: false,
          }))
        : [],
    [api, ids],
  );
  const combine = useCallback((results: Parameters<typeof attributionMap>[0]) => attributionMap(results, ids), [ids]);
  return useQueries({ queries, combine }, runtime.queryClient);
}

/** Each user action refreshes the short-lived URL through the existing endpoint. */
export async function resolveAudioPlaybackUrl(assetId: string, api: BrandApi | null): Promise<string> {
  try {
    if (!api) throw new Error("no workspace");
    const response = await brandClientFor(api)["audio-assets"][":id"]["playback-url"].$get({ param: { id: assetId } });
    const body = await response.json();
    if (!("url" in body)) throw new Error("no url");
    return body.url;
  } catch {
    throw new Error("Couldn't load this audio. Please try again.");
  }
}

/** The playback URL and duration the Studio preview needs; null when it cannot be resolved. */
export async function fetchAudioPlayback(
  api: BrandApi | null,
  assetId: string,
): Promise<{ url?: string; durationSec?: number } | null> {
  if (!api) return null;
  try {
    const response = await brandClientFor(api)["audio-assets"][":id"]["playback-url"].$get({ param: { id: assetId } });
    const body = await response.json();
    return "url" in body ? body : null;
  } catch {
    return null;
  }
}

export interface PreviewPlayer {
  /** Attach to the panel's single hidden `<audio>` element. */
  audioRef: RefObject<HTMLAudioElement | null>;
  /** The row currently loaded in the shared player, even when paused. */
  activeId: string | null;
  activeAsset: AudioAssetListRow | null;
  isPlaying: boolean;
  loadingId: string | null;
  currentTime: number;
  duration: number;
  /** Click handler for a row's play/pause button: starts this row (pausing
   *  whatever was previously playing since there's only one shared element),
   *  or pauses it if it's already the active row. */
  toggle: (asset: AudioAssetListRow) => void;
  seek: (seconds: number) => void;
}

/**
 * One `<audio>` element shared across an entire tool panel so previewing a
 * track always pauses whatever was playing before it (library tracks, SFX
 * one-shots — never more than one preview at once). Mirrors the single-
 * `<audio>` pattern video-preview.tsx already uses for the music preview
 * bed, at panel scope instead of stage scope.
 */
export function usePreviewPlayer(): PreviewPlayer {
  const api = useAudioApi();
  const audioRef = useRef<HTMLAudioElement>(null);
  const activeIdRef = useRef<string | null>(null);
  const playbackRequest = useRef(0);
  const [activeAsset, setActiveAsset] = useState<AudioAssetListRow | null>(null);
  const activeId = activeAsset?.id ?? null;
  const [isPlaying, setIsPlaying] = useState(false);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const syncTime = () => setCurrentTime(Number.isFinite(audio.currentTime) ? audio.currentTime : 0);
    const syncDuration = () => setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
    const handleEnded = () => {
      setIsPlaying(false);
      setCurrentTime(0);
    };
    const handlePlaying = () => {
      setIsPlaying(true);
      setLoadingId(null);
    };
    const handlePause = () => setIsPlaying(false);
    const handleWaiting = () => setLoadingId(activeIdRef.current);
    const handleError = () => {
      setIsPlaying(false);
      setLoadingId(null);
    };
    audio.addEventListener("timeupdate", syncTime);
    audio.addEventListener("loadedmetadata", syncDuration);
    audio.addEventListener("durationchange", syncDuration);
    audio.addEventListener("ended", handleEnded);
    audio.addEventListener("playing", handlePlaying);
    audio.addEventListener("pause", handlePause);
    audio.addEventListener("waiting", handleWaiting);
    audio.addEventListener("error", handleError);
    return () => {
      playbackRequest.current++;
      audio.removeEventListener("timeupdate", syncTime);
      audio.removeEventListener("loadedmetadata", syncDuration);
      audio.removeEventListener("durationchange", syncDuration);
      audio.removeEventListener("ended", handleEnded);
      audio.removeEventListener("playing", handlePlaying);
      audio.removeEventListener("pause", handlePause);
      audio.removeEventListener("waiting", handleWaiting);
      audio.removeEventListener("error", handleError);
    };
  }, []);

  const toggle = useCallback(async (asset: AudioAssetListRow) => {
    const { id } = asset;
    const audio = audioRef.current;
    if (!audio) return;
    const request = ++playbackRequest.current;
    if (activeIdRef.current === id && !audio.paused) {
      audio.pause();
      setLoadingId(null);
      return;
    }
    const resumeAt = activeIdRef.current === id ? audio.currentTime : 0;
    audio.pause();
    activeIdRef.current = id;
    setActiveAsset(asset);
    setIsPlaying(false);
    setCurrentTime(resumeAt);
    setDuration(0);
    setLoadingId(id);
    try {
      // A curated row carries its public URL: play it in this same click, with no API call.
      const url = asset.previewUrl ?? await resolveAudioPlaybackUrl(id, api);
      if (request !== playbackRequest.current) return;
      audio.src = url;
      audio.load();
      audio.currentTime = resumeAt;
      await audio.play();
    } catch {
      if (request !== playbackRequest.current) return;
      setIsPlaying(false);
      setLoadingId(null);
      toaster.create({ type: "error", title: "Couldn't preview this audio", description: "Please try again." });
    }
  }, [api]);

  const seek = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const next = Math.max(0, Math.min(seconds, Number.isFinite(audio.duration) ? audio.duration : seconds));
    audio.currentTime = next;
    setCurrentTime(next);
  }, []);

  return { audioRef, activeId, activeAsset, isPlaying, loadingId, currentTime, duration, toggle, seek };
}

/** The Project's brand tracks as library rows, so the shared player and row
 *  components handle them like any other track. */
export function brandAudioRows(
  tracks: readonly BrandAudioReference[],
  kind: AudioAssetKindInput,
): AudioAssetListRow[] {
  return tracks.map((track) => ({
    id: track.assetId,
    kind,
    scope: "curated",
    title: track.title,
    moodTags: [],
    durationSec: track.durationSec,
    favorited: false,
    previewUrl: null,
    artist: null,
    license: null,
    attribution: null,
  }));
}

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { type BrandApi, type BrandClient, brandClientFor, brandMutations } from "@narriflow/api-client/brand";
import type { InferResponseType } from "hono/client";
import type { AudioAssetKindInput, BrandAudioReference } from "@narriflow/validators";
import { toaster } from "@narriflow/ui/components/toaster";
import { useApiRuntime, useWorkspaceScope } from "@/app/_components/api-provider";

/** One row of the Music/SFX library, as the API lists it. */
export type AudioAssetListRow = InferResponseType<BrandClient["audio-assets"]["$get"], 200>["assets"][number];

/** The transport + selected Workspace the audio helpers call the Brand API with. */
export function useAudioApi(): BrandApi | null {
  const runtime = useApiRuntime();
  const scope = useWorkspaceScope();
  return useMemo(() => (scope ? { transport: runtime.transport, scope } : null), [runtime, scope]);
}

interface AudioAssetPage {
  assets: AudioAssetListRow[];
  moodTags: string[];
  nextOffset: number | null;
}

interface UseAudioAssetListResult {
  assets: AudioAssetListRow[];
  moodTags: string[];
  loading: boolean;
  error: string | null;
  retry: () => void;
  hasMore: boolean;
  loadingMore: boolean;
  loadMoreError: string | null;
  loadMore: () => void;
  setFavorite: (assetId: string, favorited: boolean) => Promise<void>;
}

/** Pages reset when filters or the caller's library version change. */
export function useAudioAssetList(
  kind: AudioAssetKindInput,
  mood: string | null,
  reloadKey: number,
  options: { search?: string; scope?: "all" | "user"; favorited?: boolean } = {},
): UseAudioAssetListResult {
  const { search, scope, favorited } = options;
  const api = useAudioApi();
  const [assets, setAssets] = useState<AudioAssetListRow[]>([]);
  const [moodTags, setMoodTags] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const generation = useRef(0);
  const pendingPage = useRef<number | null>(null);
  const [retryVersion, setRetryVersion] = useState(0);
  const retry = useCallback(() => setRetryVersion((version) => version + 1), []);

  const fetchPage = useCallback(async (offset: number): Promise<AudioAssetPage> => {
    if (!api) throw new Error("Couldn't load the audio library.");
    const query: { kind: AudioAssetKindInput } & Record<string, string> = { kind, limit: "30", offset: String(offset) };
    if (mood) query.mood = mood;
    if (search?.trim()) query.search = search.trim();
    if (scope) query.scope = scope;
    if (favorited !== undefined) query.favorited = String(favorited);
    try {
      const response = await brandClientFor(api)["audio-assets"].$get({ query });
      return await response.json();
    } catch {
      throw new Error("Couldn't load the audio library.");
    }
  }, [api, kind, mood, search, scope, favorited]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is an explicit caller-controlled refetch trigger.
  useEffect(() => {
    const current = ++generation.current;
    pendingPage.current = null;
    setLoading(true);
    setLoadingMore(false);
    setAssets([]);
    setNextOffset(null);
    setError(null);
    setLoadMoreError(null);
    void fetchPage(0).then((page) => {
      if (current !== generation.current) return;
      setAssets(page.assets);
      setMoodTags(page.moodTags);
      setNextOffset(page.nextOffset);
    }).catch(() => {
      if (current === generation.current) setError("Couldn't load the audio library.");
    }).finally(() => {
      if (current === generation.current) setLoading(false);
    });
    return () => { generation.current++; };
  }, [fetchPage, reloadKey, retryVersion]);

  const loadMore = useCallback(() => {
    if (nextOffset === null || loading || pendingPage.current !== null) return;
    const current = generation.current;
    pendingPage.current = current;
    setLoadingMore(true);
    setLoadMoreError(null);
    void fetchPage(nextOffset).then((page) => {
      if (current !== generation.current) return;
      setAssets((previous) => {
        const ids = new Set(previous.map((asset) => asset.id));
        return [...previous, ...page.assets.filter((asset) => !ids.has(asset.id))];
      });
      setNextOffset(page.nextOffset);
    }).catch(() => {
      if (current === generation.current) setLoadMoreError("Couldn't load more audio.");
    }).finally(() => {
      if (current !== generation.current) return;
      pendingPage.current = null;
      setLoadingMore(false);
    });
  }, [fetchPage, nextOffset, loading]);

  const setFavorite = useCallback(async (assetId: string, favorited: boolean) => {
    const previous = assets.find((asset) => asset.id === assetId)?.favorited ?? false;
    setAssets((current) => current.map((asset) => asset.id === assetId ? { ...asset, favorited } : asset));
    try {
      if (!api) throw new Error("Couldn't update Saved tracks.");
      const mutations = brandMutations(api);
      await (favorited ? mutations.favoriteAudio(assetId) : mutations.unfavoriteAudio(assetId));
    } catch (error) {
      setAssets((current) => current.map((asset) => asset.id === assetId ? { ...asset, favorited: previous } : asset));
      throw error;
    }
  }, [api, assets]);

  return { assets, moodTags, loading, error, retry, hasMore: nextOffset !== null, loadingMore, loadMoreError, loadMore, setFavorite };
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
      const url = await resolveAudioPlaybackUrl(id, api);
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
  }));
}

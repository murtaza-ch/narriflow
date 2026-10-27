"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { AudioAssetListRow } from "@narriflow/services";
import type { AudioAssetKindInput } from "@narriflow/validators";
import { toaster } from "@narriflow/ui/components/toaster";

export type { AudioAssetListRow };

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
    const params = new URLSearchParams({ kind, limit: "30", offset: String(offset) });
    if (mood) params.set("mood", mood);
    if (search?.trim()) params.set("search", search.trim());
    if (scope) params.set("scope", scope);
    if (favorited !== undefined) params.set("favorited", String(favorited));
    const response = await fetch(`/api/audio-assets?${params.toString()}`);
    if (!response.ok) throw new Error("Couldn't load the audio library.");
    return response.json();
  }, [kind, mood, search, scope, favorited]);

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
      const response = await fetch(`/api/audio-assets/${assetId}/favorite`, {
        method: favorited ? "PUT" : "DELETE",
      });
      if (!response.ok) throw new Error("Couldn't update Saved tracks.");
    } catch (error) {
      setAssets((current) => current.map((asset) => asset.id === assetId ? { ...asset, favorited: previous } : asset));
      throw error;
    }
  }, [assets]);

  return { assets, moodTags, loading, error, retry, hasMore: nextOffset !== null, loadingMore, loadMoreError, loadMore, setFavorite };
}

/** Each user action refreshes the short-lived URL through the existing endpoint. */
export async function resolveAudioPlaybackUrl(assetId: string): Promise<string> {
  const response = await fetch(`/api/audio-assets/${assetId}/playback-url`);
  if (!response.ok) throw new Error("Couldn't load this audio. Please try again.");
  const source = await response.json() as { url: string };
  return source.url;
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
      const url = await resolveAudioPlaybackUrl(id);
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
  }, []);

  const seek = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const next = Math.max(0, Math.min(seconds, Number.isFinite(audio.duration) ? audio.duration : seconds));
    audio.currentTime = next;
    setCurrentTime(next);
  }, []);

  return { audioRef, activeId, activeAsset, isPlaying, loadingId, currentTime, duration, toggle, seek };
}

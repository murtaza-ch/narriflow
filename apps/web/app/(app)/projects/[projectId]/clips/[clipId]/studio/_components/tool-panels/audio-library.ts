"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { AudioAssetListRow } from "@narriflow/services";
import type { AudioAssetKindInput } from "@narriflow/validators";

export type { AudioAssetListRow };

interface UseAudioAssetListResult {
  assets: AudioAssetListRow[];
  moodTags: string[];
  loading: boolean;
  error: string | null;
  setFavorite: (assetId: string, favorited: boolean) => Promise<void>;
}

/**
 * Music/SFX library (docs/plans/vizard-parity.md "Music/SFX library").
 * Fetches `GET /api/audio-assets` for one `kind`, refetching whenever `kind`,
 * `mood`, or `reloadKey` changes. `reloadKey` lets a sibling tab (the
 * Uploads tab, after a finalize or delete) force every open list to refresh
 * without a shared cache layer — the library is small enough (~120-200
 * curated rows per the plan) that a full refetch on change is cheap.
 */
export function useAudioAssetList(
  kind: AudioAssetKindInput,
  mood: string | null,
  reloadKey: number,
): UseAudioAssetListResult {
  const [assets, setAssets] = useState<AudioAssetListRow[]>([]);
  const [moodTags, setMoodTags] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is an explicit caller-controlled refetch trigger.
  useEffect(() => {
    let canceled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ kind });
        if (mood) params.set("mood", mood);
        const res = await fetch(`/api/audio-assets?${params.toString()}`);
        if (!res.ok) throw new Error("Couldn't load the audio library.");
        const data = (await res.json()) as {
          assets: AudioAssetListRow[];
          moodTags: string[];
        };
        if (canceled) return;
        setAssets(data.assets);
        setMoodTags(data.moodTags);
      } catch (e) {
        if (!canceled) {
          setError(e instanceof Error ? e.message : "Couldn't load the audio library.");
        }
      } finally {
        if (!canceled) setLoading(false);
      }
    }
    void load();
    return () => {
      canceled = true;
    };
  }, [kind, mood, reloadKey]);

  const setFavorite = useCallback(async (assetId: string, favorited: boolean) => {
    let previous = false;
    setAssets((current) =>
      current.map((asset) => {
        if (asset.id !== assetId) return asset;
        previous = asset.favorited;
        return { ...asset, favorited };
      }),
    );

    try {
      const response = await fetch(`/api/audio-assets/${assetId}/favorite`, {
        method: favorited ? "PUT" : "DELETE",
      });
      if (!response.ok) throw new Error("Couldn't update Saved tracks.");
    } catch (error) {
      setAssets((current) =>
        current.map((asset) =>
          asset.id === assetId ? { ...asset, favorited: previous } : asset,
        ),
      );
      throw error;
    }
  }, []);

  return { assets, moodTags, loading, error, setFavorite };
}

export interface PreviewPlayer {
  /** Attach to the panel's single hidden `<audio>` element. */
  audioRef: RefObject<HTMLAudioElement | null>;
  /** The row currently loaded in the shared player, even when paused. */
  activeId: string | null;
  isPlaying: boolean;
  loadingId: string | null;
  currentTime: number;
  duration: number;
  /** Click handler for a row's play/pause button: starts this row (pausing
   *  whatever was previously playing since there's only one shared element),
   *  or pauses it if it's already the active row. */
  toggle: (id: string, url: string) => void;
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
  const [activeId, setActiveId] = useState<string | null>(null);
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

  const toggle = useCallback((id: string, url: string) => {
    const audio = audioRef.current;
    if (!audio) return;
    if (activeIdRef.current === id) {
      if (audio.paused) {
        setLoadingId(id);
        void audio.play().catch(() => {
          setIsPlaying(false);
          setLoadingId(null);
        });
      } else {
        audio.pause();
      }
      return;
    }
    activeIdRef.current = id;
    setActiveId(id);
    setCurrentTime(0);
    setDuration(0);
    setLoadingId(id);
    if (audio.src !== url) {
      audio.src = url;
      audio.load();
    }
    audio.currentTime = 0;
    void audio.play().catch(() => {
      setIsPlaying(false);
      setLoadingId(null);
    });
  }, []);

  const seek = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const next = Math.max(0, Math.min(seconds, Number.isFinite(audio.duration) ? audio.duration : seconds));
    audio.currentTime = next;
    setCurrentTime(next);
  }, []);

  return { audioRef, activeId, isPlaying, loadingId, currentTime, duration, toggle, seek };
}

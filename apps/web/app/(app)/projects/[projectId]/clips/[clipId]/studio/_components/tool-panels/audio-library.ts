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

  return { assets, moodTags, loading, error };
}

interface PreviewPlayer {
  /** Attach to the panel's single hidden `<audio>` element. */
  audioRef: RefObject<HTMLAudioElement | null>;
  /** The row id currently playing (or paused mid-track), or null. */
  playingId: string | null;
  /** Click handler for a row's play/pause button: starts this row (pausing
   *  whatever was previously playing since there's only one shared element),
   *  or pauses it if it's already the active row. */
  toggle: (id: string, url: string) => void;
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
  const [playingId, setPlayingId] = useState<string | null>(null);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const handleEnded = () => setPlayingId(null);
    audio.addEventListener("ended", handleEnded);
    return () => audio.removeEventListener("ended", handleEnded);
  }, []);

  const toggle = useCallback((id: string, url: string) => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playingId === id) {
      audio.pause();
      setPlayingId(null);
      return;
    }
    if (audio.src !== url) audio.src = url;
    audio.currentTime = 0;
    void audio.play().catch(() => {
      setPlayingId(null);
    });
    setPlayingId(id);
  }, [playingId]);

  return { audioRef, playingId, toggle };
}

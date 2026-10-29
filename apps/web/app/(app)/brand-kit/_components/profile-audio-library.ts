"use client";

import { useQueries } from "@tanstack/react-query";
import { useState } from "react";
import type { AudioAssetKindInput } from "@narriflow/validators";
import { uploadAudioFile } from "@/lib/audio-upload";
import { type BrandData, useBrandApi } from "./brand-api";

const PAGE_SIZE = 30;

export type AudioLibraryRow = BrandData<"audioAssets">["assets"][number];

/**
 * The Music/SFX library one page at a time (`nextOffset` continues it). The
 * pages are ordinary cached reads, so reopening the picker shows the last
 * results while it refreshes.
 */
export function useAudioLibrary(kind: AudioAssetKindInput, search: string) {
  const { queries } = useBrandApi();
  const trimmed = search.trim();
  // The page count belongs to one filter; a new kind or search starts again at the first page.
  const [paging, setPaging] = useState({ filter: "", pages: 1 });
  const filter = `${kind}\u0000${trimmed}`;
  const pages = paging.filter === filter ? paging.pages : 1;

  const results = useQueries({
    queries: Array.from({ length: pages }, (_, index) =>
      queries.audioAssets({ kind, limit: PAGE_SIZE, offset: index * PAGE_SIZE, ...(trimmed ? { search: trimmed } : {}) }),
    ),
  });
  const last = results[results.length - 1];
  const first = results[0];
  const nextOffset = last?.data?.nextOffset ?? null;
  const assets = results.flatMap((result) => result.data?.assets ?? []);
  return {
    assets,
    loading: first?.isPending ?? true,
    error: first?.isError && !first.data ? "Couldn't load the audio library." : null,
    retry: () => void first?.refetch(),
    hasMore: nextOffset !== null,
    loadingMore: pages > 1 && (last?.isPending ?? false),
    loadMore: () => {
      if (nextOffset !== null) setPaging({ filter, pages: pages + 1 });
    },
  };
}

/** Uploads one file into the Workspace's audio library straight to storage and returns the new asset. Errors carry user-facing copy. */
export function useAudioUpload() {
  const { mutations } = useBrandApi();
  return (file: File, kind: AudioAssetKindInput): Promise<{ id: string }> => uploadAudioFile(file, kind, mutations);
}

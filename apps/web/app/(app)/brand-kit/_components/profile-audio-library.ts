"use client";

import { useQueries } from "@tanstack/react-query";
import { useState } from "react";
import { AUDIO_UPLOAD_MAX_BYTES, audioUploadContentTypeSchema, type AudioAssetKindInput } from "@narriflow/validators";
import { AUDIO_UPLOAD_MAX_MB } from "@/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/tool-panels/audio-upload";
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

type AudioContentType = ReturnType<typeof audioUploadContentTypeSchema.parse>;

const EXTENSION_CONTENT_TYPE: Record<string, AudioContentType> = { mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4" };

/** Browsers disagree about `File.type` for audio; fall back to the extension when the reported type isn't accepted. */
function contentTypeOf(file: File): AudioContentType | null {
  const reported = audioUploadContentTypeSchema.safeParse(file.type);
  if (reported.success) return reported.data;
  const extension = file.name.split(".").pop()?.toLowerCase();
  return extension ? (EXTENSION_CONTENT_TYPE[extension] ?? null) : null;
}

const READ_DURATION_TIMEOUT_MS = 15_000;

/** Reads the duration in the browser with a throwaway `<audio>`; some oddly muxed files never fire an event, so it is bounded. */
function readAudioDuration(file: File): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio(url);
    const done = (seconds: number) => {
      URL.revokeObjectURL(url);
      clearTimeout(timeout);
      resolve(seconds);
    };
    const timeout = setTimeout(() => done(0), READ_DURATION_TIMEOUT_MS);
    audio.addEventListener("loadedmetadata", () => done(Number.isFinite(audio.duration) ? audio.duration : 0));
    audio.addEventListener("error", () => done(0));
  });
}

/** Uploads one file into the Workspace's audio library straight to storage and returns the new asset. Errors carry user-facing copy. */
export function useAudioUpload() {
  const { mutations } = useBrandApi();
  return async function uploadAudioFile(file: File, kind: AudioAssetKindInput): Promise<{ id: string }> {
    if (file.size > AUDIO_UPLOAD_MAX_BYTES) throw new Error(`Audio uploads are capped at ${AUDIO_UPLOAD_MAX_MB}MB.`);
    const contentType = contentTypeOf(file);
    if (!contentType) throw new Error("Upload an MP3, WAV, or M4A file.");

    const durationSec = await readAudioDuration(file);
    const presigned = await mutations.presignAudioUpload({ contentType, sizeBytes: file.size });
    const uploaded = await fetch(presigned.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": presigned.contentType },
      body: file,
    });
    if (!uploaded.ok) throw new Error(`Upload failed (${uploaded.status})`);

    const dot = file.name.lastIndexOf(".");
    const title = (dot > 0 ? file.name.slice(0, dot) : file.name).slice(0, 120) || "Untitled";
    return mutations.finalizeAudioUpload({
      key: presigned.key,
      kind,
      title,
      durationSec,
      sizeBytes: file.size,
    });
  };
}

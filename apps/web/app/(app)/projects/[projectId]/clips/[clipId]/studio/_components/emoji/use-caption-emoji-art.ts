"use client";

import { useEffect, useMemo, useState } from "react";
import type { CaptionEmojiArt } from "@narriflow/caption-emoji/art";

type LoadArt = (ids: readonly string[]) => Promise<ReadonlyMap<string, CaptionEmojiArt>>;

export interface CaptionEmojiArtCache {
  /** The loaded art of `ids`; an id still loading, or not in the catalog, is left out. */
  readonly artFor: (ids: readonly string[]) => Map<string, CaptionEmojiArt>;
  /** True while any of `ids` has not been asked for and answered. */
  readonly pending: (ids: readonly string[]) => boolean;
  /** Loads the ids not loaded or loading yet, one request for them all; resolves when every id has an answer. */
  readonly load: (ids: readonly string[]) => Promise<void>;
}

/**
 * A session cache of emoji art. Each id is requested once: ids already answered (art or unknown id)
 * are not asked again, and an id in flight joins its request. A failed request leaves its ids
 * unanswered so the next `load` tries again.
 */
export function createCaptionEmojiArtCache(loadArt: LoadArt): CaptionEmojiArtCache {
  const art = new Map<string, CaptionEmojiArt>();
  const answered = new Set<string>();
  const inFlight = new Map<string, Promise<void>>();
  return {
    artFor: (ids) => {
      const found = new Map<string, CaptionEmojiArt>();
      for (const id of ids) {
        const entry = art.get(id);
        if (entry) found.set(id, entry);
      }
      return found;
    },
    pending: (ids) => ids.some((id) => !answered.has(id)),
    load: (ids) => {
      const missing = [...new Set(ids)].filter((id) => !answered.has(id) && !inFlight.has(id));
      if (missing.length > 0) {
        const request = loadArt(missing)
          .then((loaded) => {
            for (const [id, entry] of loaded) art.set(id, entry);
            for (const id of missing) answered.add(id);
          })
          .catch(() => undefined)
          .finally(() => {
            for (const id of missing) inFlight.delete(id);
          });
        for (const id of missing) inFlight.set(id, request);
      }
      return Promise.all(ids.flatMap((id) => inFlight.get(id) ?? [])).then(() => undefined);
    },
  };
}

// The art (and the catalog index it reads) is a dynamic import: neither is in the Studio's first chunks.
const sessionArt = createCaptionEmojiArtCache((ids) => import("@narriflow/caption-emoji/art").then((module) => module.loadCaptionEmojiArt(ids)));

/** Loads art into the session cache ahead of need (the picker's first screen while the section is idle). */
export function preloadCaptionEmojiArt(ids: readonly string[]): Promise<void> {
  return sessionArt.load(ids);
}

const NO_IDS: readonly string[] = [];

/** How long after a failed art request the hook asks once more, ms. */
export const CAPTION_EMOJI_ART_RETRY_MS = 3000;

/**
 * Loads `ids` into `cache`, and once more after `retryMs` when some are still unanswered (a shard
 * that failed to load may load a moment later); never more than that, so an offline Studio does not
 * loop. A later mount asks again on its own. `onAnswer` runs after each request that settles while
 * not cancelled. Returns the cancel.
 */
export function loadCaptionEmojiArtWithRetry(
  cache: CaptionEmojiArtCache,
  ids: readonly string[],
  onAnswer: () => void,
  retryMs: number = CAPTION_EMOJI_ART_RETRY_MS,
  timers: { readonly set: (run: () => void, ms: number) => unknown; readonly clear: (timer: unknown) => void } = {
    set: (run, ms) => setTimeout(run, ms),
    clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  },
): () => void {
  let live = true;
  let timer: unknown = null;
  const attempt = (retries: number) => {
    void cache.load(ids).then(() => {
      if (!live) return;
      onAnswer();
      if (retries > 0 && cache.pending(ids)) timer = timers.set(() => attempt(retries - 1), retryMs);
    });
  };
  attempt(1);
  return () => {
    live = false;
    if (timer !== null) timers.clear(timer);
  };
}

/**
 * The art of the emoji ids a clip draws, loaded on demand and cached for the session, and whether
 * some of it is still loading. The map changes only when the ids or the loaded set change. A failed
 * load is tried once more after a short wait, and again on the next mount.
 */
export function useCaptionEmojiArt(ids: readonly string[], cache: CaptionEmojiArtCache = sessionArt): {
  readonly art: ReadonlyMap<string, CaptionEmojiArt>;
  readonly pending: boolean;
} {
  const key = [...new Set(ids)].sort().join("\0");
  const wanted = useMemo(() => (key === "" ? NO_IDS : key.split("\0")), [key]);
  const [loads, setLoads] = useState(0);
  const pending = cache.pending(wanted);
  useEffect(() => {
    if (!cache.pending(wanted)) return;
    return loadCaptionEmojiArtWithRetry(cache, wanted, () => setLoads((count) => count + 1));
  }, [cache, wanted]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `loads` counts answered requests
  const art = useMemo(() => cache.artFor(wanted), [cache, wanted, loads]);
  return { art, pending };
}

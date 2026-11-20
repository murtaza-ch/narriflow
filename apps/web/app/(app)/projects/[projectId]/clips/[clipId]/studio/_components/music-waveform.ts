import { computePeaks } from "./music-blocks";

export interface TrackPeaks {
  /** 0..1 amplitude per bucket across the whole track. */
  peaks: Float32Array;
  durationSec: number;
}

const PEAK_BUCKETS = 1200;
// Decoding holds the whole track in memory; a track this large keeps its flat
// block instead. The decode runs at a low sample rate, so this is generous.
const MAX_DECODE_BYTES = 24 * 1024 * 1024;
const DECODE_SAMPLE_RATE = 8000;
const FAILURE_RETRY_MS = 60_000;
const MAX_CACHED_TRACKS = 16;

const cache = new Map<string, Promise<TrackPeaks | null>>();
const failedAt = new Map<string, number>();

/** A source the loader may try, in order; resolving to null means "no URL". */
export type PeaksUrlSource = () => Promise<string | null>;

async function decodePeaks(url: string): Promise<TrackPeaks> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`audio_fetch_${response.status}`);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_DECODE_BYTES) throw new Error("audio_too_large");
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_DECODE_BYTES) throw new Error("audio_too_large");
  const context = new OfflineAudioContext(1, 1, DECODE_SAMPLE_RATE);
  const decoded = await context.decodeAudioData(bytes);
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) =>
    decoded.getChannelData(index),
  );
  return { peaks: computePeaks(channels, PEAK_BUCKETS), durationSec: decoded.duration };
}

/**
 * Best-effort decoded waveform for one track, cached by `key` (the asset id,
 * or the pasted link) for the session. Sources are tried in order, so a
 * stored URL whose presign expired falls through to a freshly resolved one.
 * Any failure (CORS, an undecodable file, a missing API) resolves to null and
 * the block keeps its flat fill; a failure is retried after a minute.
 */
export function loadTrackPeaks(
  key: string,
  sources: readonly PeaksUrlSource[],
): Promise<TrackPeaks | null> {
  const cached = cache.get(key);
  if (cached) return cached;
  const lastFailure = failedAt.get(key);
  if (lastFailure !== undefined && Date.now() - lastFailure < FAILURE_RETRY_MS) {
    return Promise.resolve(null);
  }
  const request = (async () => {
    if (typeof OfflineAudioContext === "undefined") return null;
    for (const source of sources) {
      try {
        const url = await source();
        if (url) return await decodePeaks(url);
      } catch {
        // Try the next source.
      }
    }
    return null;
  })();
  cache.set(key, request);
  if (cache.size > MAX_CACHED_TRACKS) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  void request.then((result) => {
    if (result) return;
    cache.delete(key);
    failedAt.set(key, Date.now());
  });
  return request;
}

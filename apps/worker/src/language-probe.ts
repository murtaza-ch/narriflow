import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  normalizeProviderLanguageCode,
  SCRIBE_MODEL_ID,
  type SourceLanguageCodeValue,
} from "@narriflow/validators";
import { HTTP_SOURCE_RW_TIMEOUT_US, type WorkerProcessModule } from "./worker-process";

/**
 * Bounded source-language probe (spec D6): when the owner left the language on
 * Auto, listen to three short windows of the source, ask Scribe what language
 * it is, and pin that language for the real transcription only when the
 * answer is trustworthy.
 *
 * Why pin at all: Scribe's own auto mode on a full file mixed Urdu and Hindi
 * script and dropped 85% of the Tamil speech while still detecting the
 * language correctly; the same files transcribed with the language pinned
 * were clean. Detection on a short, evenly sampled excerpt is reliable;
 * auto-mode transcription of a long file is not.
 *
 * The thresholds below are heuristics, not provider guarantees. A wrong pin is
 * worse than no pin (the whole transcript comes back in the wrong language),
 * so a pin needs all three: a confident detection, enough recognised words to
 * mean something (music or silence at 20/50/80% can yield a confident guess
 * from two words), and a language the product can caption.
 *
 * Some languages share one spoken form and differ only in script (Hindi and
 * Urdu: an Urdu podcast probed as `hin` at 0.97). Audio cannot decide the
 * script, so the probe pins what it hears like any other language: one
 * consistent script for the whole transcript, which Auto mode does not give.
 * Users who need the other script choose it in the language picker; there is
 * deliberately no per-language exception here (owner: not region-specific).
 *
 * A probe failure never fails the run: every problem returns `pinned: null`
 * and the caller transcribes in Auto. Only cancellation propagates.
 */
export const PROBE_MIN_DURATION_SEC = 60;
export const PROBE_WINDOW_SEC = 20;
export const PROBE_WINDOW_CENTERS = [0.2, 0.5, 0.8] as const;
export const PROBE_MIN_LANGUAGE_PROBABILITY = 0.8;
export const PROBE_MIN_WORDS = 15;

const FFMPEG_DEADLINE_MS = 90_000;
const SCRIBE_TIMEOUT_MS = 60_000;
const SCRIBE_ENDPOINT = "https://api.elevenlabs.io/v1/speech-to-text";

export interface LanguageProbeWindow {
  startSec: number;
  durationSec: number;
}

export interface LanguageProbeResult {
  /** Canonical registry code to pin, or null to transcribe in Auto. */
  pinned: SourceLanguageCodeValue | null;
  /** The provider's language code as returned, when the call got that far. */
  detected: string | null;
  probability: number | null;
  /** Count of `type: "word"` tokens in the probe transcript. */
  wordCount: number;
  /** Why the probe pinned or did not (log-safe, never raw provider text). */
  reason: string;
}

export interface LanguageProbeOptions {
  /** Presigned HTTPS URL of the source; ffmpeg range-reads it, nothing is downloaded whole. */
  sourceUrl: string;
  durationSeconds: number;
  signal: AbortSignal;
  workerProcess: WorkerProcessModule;
  /** Defaults to `ELEVENLABS_API_KEY`. */
  apiKey?: string;
  /** Test seam; defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/**
 * Three non-overlapping windows centred at 20/50/80% of the duration, clamped
 * inside the source. Null below the probe threshold. At exactly 60 s the
 * windows tile the source (0-20, 20-40, 40-60); from about 67 s up the
 * centred windows no longer touch.
 */
export function selectProbeWindows(durationSeconds: number): LanguageProbeWindow[] | null {
  if (!Number.isFinite(durationSeconds) || durationSeconds < PROBE_MIN_DURATION_SEC) return null;
  const last = durationSeconds - PROBE_WINDOW_SEC;
  const starts = PROBE_WINDOW_CENTERS.map((center) =>
    Math.min(Math.max(durationSeconds * center - PROBE_WINDOW_SEC / 2, 0), last),
  );
  // Push each window past the previous one, then pull back from the end.
  for (let i = 1; i < starts.length; i++) {
    starts[i] = Math.max(starts[i]!, starts[i - 1]! + PROBE_WINDOW_SEC);
  }
  const lastIndex = starts.length - 1;
  starts[lastIndex] = Math.min(starts[lastIndex]!, last);
  for (let i = lastIndex - 1; i >= 0; i--) {
    starts[i] = Math.min(starts[i]!, starts[i + 1]! - PROBE_WINDOW_SEC);
  }
  return starts.map((start) => ({
    startSec: Math.round(start * 1000) / 1000,
    durationSec: PROBE_WINDOW_SEC,
  }));
}

/** The pin decision for a Scribe response; `reason` is "pinned" on success. */
export function decideProbePin(response: {
  languageCode: string | null;
  probability: number | null;
  wordCount: number;
}): { pinned: SourceLanguageCodeValue | null; reason: string } {
  const { languageCode, probability, wordCount } = response;
  if (!languageCode) return { pinned: null, reason: "no_language_detected" };
  if (probability === null || probability < PROBE_MIN_LANGUAGE_PROBABILITY) {
    return { pinned: null, reason: "low_language_probability" };
  }
  if (wordCount < PROBE_MIN_WORDS) return { pinned: null, reason: "too_few_words" };
  const canonical = normalizeProviderLanguageCode(languageCode);
  if (!canonical) return { pinned: null, reason: "language_not_in_catalog" };
  return { pinned: canonical, reason: "pinned" };
}

/** One ffmpeg process: an input-seeked window per input, concatenated to mono 16 kHz WAV. */
export function buildProbeFfmpegArgs(
  sourceUrl: string,
  windows: readonly LanguageProbeWindow[],
  outputPath: string,
): string[] {
  const inputs = windows.flatMap((window) => [
    "-rw_timeout",
    String(HTTP_SOURCE_RW_TIMEOUT_US),
    "-ss",
    String(window.startSec),
    "-t",
    String(window.durationSec),
    "-i",
    sourceUrl,
  ]);
  const labels = windows.map((_, index) => `[${index}:a:0]`).join("");
  return [
    "-y",
    "-nostdin",
    ...inputs,
    "-filter_complex",
    `${labels}concat=n=${windows.length}:v=0:a=1,aresample=16000[a]`,
    "-map",
    "[a]",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    outputPath,
  ];
}

const unpinned = (
  reason: string,
  detail: Partial<Pick<LanguageProbeResult, "detected" | "probability" | "wordCount">> = {},
): LanguageProbeResult => ({
  pinned: null,
  detected: detail.detected ?? null,
  probability: detail.probability ?? null,
  wordCount: detail.wordCount ?? 0,
  reason,
});

export async function probeSourceLanguage(options: LanguageProbeOptions): Promise<LanguageProbeResult> {
  const { signal } = options;
  signal.throwIfAborted();
  const windows = selectProbeWindows(options.durationSeconds);
  if (!windows) return unpinned("source_too_short");
  const apiKey = options.apiKey ?? process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return unpinned("provider_not_configured");

  try {
    const audio = await options.workerProcess.withScratchDirectory("narriflow-language-probe-", async (directory) => {
      const outputPath = join(directory, "probe.wav");
      await options.workerProcess.execute({
        command: "ffmpeg",
        args: buildProbeFfmpegArgs(options.sourceUrl, windows, outputPath),
        signal,
        deadlineMs: FFMPEG_DEADLINE_MS,
      });
      return readFile(outputPath);
    });
    return await detectLanguage(audio, apiKey, signal, options.fetch ?? fetch);
  } catch (error) {
    // Cancellation is the caller's, not a probe failure.
    signal.throwIfAborted();
    return unpinned(error instanceof ProbeHttpError ? error.reason : "probe_failed");
  }
}

class ProbeHttpError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

async function detectLanguage(
  audio: Buffer,
  apiKey: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<LanguageProbeResult> {
  const form = new FormData();
  form.set("model_id", SCRIBE_MODEL_ID);
  form.set("tag_audio_events", "false");
  form.set("timestamps_granularity", "word");
  form.set("file", new Blob([new Uint8Array(audio)], { type: "audio/wav" }), "probe.wav");

  const response = await fetchImpl(SCRIBE_ENDPOINT, {
    method: "POST",
    headers: { "xi-api-key": apiKey },
    body: form,
    signal: AbortSignal.any([signal, AbortSignal.timeout(SCRIBE_TIMEOUT_MS)]),
  });
  if (!response.ok) throw new ProbeHttpError(`provider_http_${response.status}`);

  const body = (await response.json()) as {
    language_code?: unknown;
    language_probability?: unknown;
    words?: unknown;
  };
  const languageCode = typeof body.language_code === "string" ? body.language_code : null;
  const probability = typeof body.language_probability === "number" ? body.language_probability : null;
  const wordCount = Array.isArray(body.words)
    ? body.words.filter((token) => (token as { type?: unknown } | null)?.type === "word").length
    : 0;
  const decision = decideProbePin({ languageCode, probability, wordCount });
  return { ...decision, detected: languageCode, probability, wordCount };
}

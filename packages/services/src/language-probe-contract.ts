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
import { normalizeProviderLanguageCode, type SourceLanguageCodeValue } from "@narriflow/validators";

export const PROBE_MIN_DURATION_SEC = 60;
export const PROBE_WINDOW_SEC = 20;
export const PROBE_WINDOW_CENTERS = [0.2, 0.5, 0.8] as const;
export const PROBE_MIN_LANGUAGE_PROBABILITY = 0.8;
export const PROBE_MIN_WORDS = 15;
export const LANGUAGE_PROBE_MAX_BYTES = 2_000_000;

export interface LanguageProbeResult {
  pinned: SourceLanguageCodeValue | null;
  detected: string | null;
  probability: number | null;
  wordCount: number;
  reason: string;
}

/** The existing product pin policy, shared by control and native adapters. */
export function decideProbePin(response: { languageCode: string | null; probability: number | null; wordCount: number }): { pinned: SourceLanguageCodeValue | null; reason: string } {
  const { languageCode, probability, wordCount } = response;
  if (!languageCode) return { pinned: null, reason: "no_language_detected" };
  if (probability === null || probability < PROBE_MIN_LANGUAGE_PROBABILITY) return { pinned: null, reason: "low_language_probability" };
  if (wordCount < PROBE_MIN_WORDS) return { pinned: null, reason: "too_few_words" };
  const canonical = normalizeProviderLanguageCode(languageCode);
  if (!canonical) return { pinned: null, reason: "language_not_in_catalog" };
  return { pinned: canonical, reason: "pinned" };
}

export interface LanguageProbeWindow {
  startSec: number;
  durationSec: number;
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


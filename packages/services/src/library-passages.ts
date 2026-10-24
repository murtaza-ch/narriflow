import { createHash } from "node:crypto";
import type { TranscriptUtterance } from "@narriflow/validators";

/** A passage closes at the first utterance boundary past the minimum, and
 * never grows past the maximum unless one utterance is longer than that. */
export const PASSAGE_MIN_MS = 30_000;
export const PASSAGE_MAX_MS = 60_000;

export interface TranscriptPassageDraft {
  startMs: number;
  endMs: number;
  text: string;
  /** Identifies this exact span and wording, so unchanged passages keep their
   * embedding when a transcript is indexed again. */
  contentHash: string;
}

type TimedUtterance = Pick<TranscriptUtterance, "startSec" | "endSec" | "text">;

function toMs(seconds: number) {
  return Math.round(seconds * 1000);
}

function passageHash(startMs: number, endMs: number, text: string) {
  return createHash("sha256").update(`${startMs}:${endMs}:${text}`).digest("hex");
}

/** Groups a transcript's utterances into passages of about 30 to 60 seconds.
 * Pure and deterministic: the same utterances always give the same passages. */
export function chunkUtterances(utterances: readonly TimedUtterance[]): TranscriptPassageDraft[] {
  const passages: TranscriptPassageDraft[] = [];
  let startMs = 0;
  let endMs = 0;
  let parts: string[] = [];

  const close = () => {
    if (parts.length === 0) return;
    const text = parts.join(" ");
    passages.push({ startMs, endMs, text, contentHash: passageHash(startMs, endMs, text) });
    parts = [];
  };

  for (const utterance of utterances) {
    const text = utterance.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const utteranceStartMs = toMs(utterance.startSec);
    const utteranceEndMs = Math.max(utteranceStartMs, toMs(utterance.endSec));
    if (parts.length > 0 && utteranceEndMs - startMs > PASSAGE_MAX_MS) close();
    if (parts.length === 0) {
      startMs = utteranceStartMs;
      endMs = utteranceEndMs;
    } else {
      endMs = Math.max(endMs, utteranceEndMs);
    }
    parts.push(text);
    if (endMs - startMs >= PASSAGE_MIN_MS) close();
  }
  close();
  return passages;
}

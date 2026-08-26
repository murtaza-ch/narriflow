import {
  splitUtterancesIntoSentences,
  type TranscriptUtterance,
} from "@narriflow/validators";

/**
 * In-studio trim (vizard-parity.md Phase B step 13) — the client-side word
 * source for the timeline's drag-to-trim handles. Deliberately a SEPARATE
 * module from `edit-clip-length-dialog.tsx`'s own transcript cache rather
 * than an import from it: that dialog is out of this change's scope (the
 * project page keeps using it unmodified), so this only LIFTS the same
 * fetch-once/session-cache/flatten shape rather than sharing code with it.
 * If the two ever need to converge, the natural move is extracting a shared
 * module BOTH import from — not editing the dialog to import this one.
 */

export interface TrimWord {
  word: string;
  startSec: number;
  endSec: number;
}

export interface TrimTranscript {
  /** The FULL project transcript, sentence-split and flattened to a single
   *  word list in source-time order — the drag-snap surface. */
  words: TrimWord[];
  /** The raw (un-split) utterances exactly as the server returns them —
   *  what `buildTranscriptSliceForWindow` expects (it does its own
   *  `splitUtterancesIntoSentences` internally, matching the server's own
   *  boundary paths; splitting here too would be redundant). */
  rawUtterances: TranscriptUtterance[];
  /** The last word's end — used as the "source duration" ceiling for how
   *  far a trim handle may extend, mirroring what
   *  `edit-clip-length-dialog.tsx`'s own `sourceDurationSec` does. */
  sourceDurationSec: number;
}

const transcriptCache = new Map<string, TrimTranscript>();
const transcriptPromises = new Map<string, Promise<TrimTranscript>>();

function flattenWords(utterances: TranscriptUtterance[]): TrimWord[] {
  const words: TrimWord[] = [];
  for (const utterance of utterances) {
    if (utterance.words.length > 0) {
      for (const word of utterance.words) {
        words.push({ word: word.word, startSec: word.startSec, endSec: word.endSec });
      }
    } else {
      words.push({
        word: utterance.text,
        startSec: utterance.startSec,
        endSec: utterance.endSec,
      });
    }
  }
  return words;
}

/** Fetches and flattens the full project transcript once per project,
 *  session-cached (module-level, like the dialog's own cache) so the second
 *  handle grab — or a reopen of the studio in the same tab — is instant. */
export function loadTrimTranscript(projectId: string): Promise<TrimTranscript> {
  const cached = transcriptCache.get(projectId);
  if (cached) return Promise.resolve(cached);

  let pending = transcriptPromises.get(projectId);
  if (!pending) {
    pending = fetch(`/api/projects/${projectId}/transcript/utterances`)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`transcript fetch failed (${response.status})`);
        }
        return response.json() as Promise<{ utterances: TranscriptUtterance[] }>;
      })
      .then((snapshot) => {
        const rawUtterances = snapshot.utterances ?? [];
        const words = flattenWords(splitUtterancesIntoSentences(rawUtterances));
        const result: TrimTranscript = {
          words,
          rawUtterances,
          sourceDurationSec: words.at(-1)?.endSec ?? 0,
        };
        transcriptCache.set(projectId, result);
        transcriptPromises.delete(projectId);
        return result;
      })
      .catch((err) => {
        transcriptPromises.delete(projectId);
        throw err;
      });
    transcriptPromises.set(projectId, pending);
  }
  return pending;
}

/** Fire-and-forget warmup — call on pointerdown of a trim handle so the drag
 *  itself never blocks on the fetch. */
export function prefetchTrimTranscript(projectId: string) {
  void loadTrimTranscript(projectId).catch(() => {});
}

/** Index of the word whose START (edge "start") or END (edge "end") is
 *  closest to `sec` — the snap target for a trim handle's drag position. */
export function nearestWordBoundary(
  words: TrimWord[],
  sec: number,
  edge: "start" | "end",
): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < words.length; i++) {
    const t = edge === "start" ? words[i]!.startSec : words[i]!.endSec;
    const d = Math.abs(t - sec);
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  }
  return words.length > 0 ? (edge === "start" ? words[best]!.startSec : words[best]!.endSec) : sec;
}

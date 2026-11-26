import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EditorDocument, TranscriptUtterance } from "@narriflow/validators";
import { ARABIC } from "./fixtures-ar";
import { ENGLISH } from "./fixtures-en";
import { HINDI } from "./fixtures-hi";
import { MOMENTS } from "./fixtures-moments";
import { NEGATION } from "./fixtures-negation";
import { URDU } from "./fixtures-ur";

// The transcripts the emoji relevance evaluation tags: written ones in four languages (one sentence
// per line, word times synthesised deterministically) and the real clips under
// `.scratch/motion-captions/out/real` when they are present (untracked local files).

export interface EvalScript {
  readonly id: string;
  /** The language the evaluation reports the transcript under. */
  readonly language: "en" | "ur" | "hi" | "ar";
  readonly genre: string;
  readonly title: string;
  /** One sentence per line. */
  readonly text: string;
}

export interface EvalTranscript {
  readonly id: string;
  readonly language: string;
  readonly genre: string;
  readonly title: string | null;
  /** What the Studio route would send as the project's language (null when the project has none). */
  readonly languageCode: string | null;
  /** The clip whose kept words are tagged, as `suggestClipEmojis` reads it. */
  readonly document: Pick<EditorDocument, "transcriptSlice" | "clipStartSec" | "clipEndSec" | "deletedRanges" | "censorSegments">;
}

export const WRITTEN_SCRIPTS: readonly EvalScript[] = [...ENGLISH, ...URDU, ...HINDI, ...ARABIC, ...MOMENTS, ...NEGATION];

/** About 150 words a minute: a word lasts 0.18 s plus 35 ms a letter, 40 ms between words, 0.4 s between sentences. */
export function timedUtterances(text: string): TranscriptUtterance[] {
  let t = 0.4;
  return text.split("\n").map((line) => line.trim()).filter(Boolean).map((sentence, index) => {
    const words = sentence.split(/\s+/).map((word, at) => {
      const duration = 0.18 + 0.035 * word.replace(/[^\p{L}\p{N}]/gu, "").length;
      const timed = { word, startSec: Math.round(t * 1000) / 1000, endSec: Math.round((t + duration) * 1000) / 1000, confidence: 1, spaceBefore: at > 0 };
      t += duration + (/[,،]$/.test(word) ? 0.18 : 0.04);
      return timed;
    });
    t += 0.4;
    return { index, speaker: 0, speakerLabel: "Speaker 1", startSec: words[0]!.startSec, endSec: words.at(-1)!.endSec, confidence: 1, text: sentence, words };
  });
}

export function writtenTranscript(script: EvalScript): EvalTranscript {
  const transcriptSlice = timedUtterances(script.text);
  return {
    id: script.id, language: script.language, genre: script.genre, title: script.title, languageCode: script.language,
    document: { transcriptSlice, clipStartSec: 0, clipEndSec: transcriptSlice.at(-1)!.endSec + 1, deletedRanges: [], censorSegments: [] },
  };
}

/** The real clips and the language each is reported under (the transcripts mix scripts). */
export const REAL_CLIPS = [
  { id: "en-waveform", language: "en", genre: "podcast (real)" },
  { id: "owner-halftone", language: "en", genre: "podcast (real)" },
  { id: "urdu-direction", language: "ur", genre: "tech review (real)" },
  { id: "hi-matte", language: "hi", genre: "tech review (real)" },
] as const;

/** A real clip's editor document and its meta (title, project language) when the files exist. */
export function realTranscript(root: string, clip: (typeof REAL_CLIPS)[number]): EvalTranscript | null {
  const dir = join(root, ".scratch/motion-captions/out/real", clip.id);
  if (!existsSync(join(dir, "document.json"))) return null;
  const document = JSON.parse(readFileSync(join(dir, "document.json"), "utf8")) as EvalTranscript["document"];
  const meta = existsSync(join(dir, "meta.json"))
    ? (JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as { title?: string; project?: { languageCode?: string | null } })
    : {};
  return {
    id: clip.id, language: clip.language, genre: clip.genre, title: meta.title ?? null, languageCode: meta.project?.languageCode ?? null,
    document: { ...document, deletedRanges: document.deletedRanges ?? [], censorSegments: document.censorSegments ?? [] },
  };
}

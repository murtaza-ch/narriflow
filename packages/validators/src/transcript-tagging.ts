import type { TranscriptUtterance, TranscriptWord } from "./transcript";
import { splitUtterancesIntoSentences } from "./utterance-split";

// The transcript chunking AI word taggers share (filler tagging and emoji
// tagging): sentence-split chunks of numbered tokens, rendered so that the
// transcript's text cannot forge the prompt's structure.

export interface TranscriptTaggingToken {
  speaker: number | null;
  word: TranscriptWord;
  /** The token's sentence: its line's place in the chunk ("S0: ..." lines, from 0). */
  line: number;
}
export interface TranscriptTaggingChunk {
  tokens: TranscriptTaggingToken[];
  /** The user message, or null when the chunk's text could forge prompt structure. */
  prompt: string | null;
}

// Rendering separates tokens with spaces, ids with ":" and lines with "\n".
// A token containing whitespace, a line or paragraph separator or a control
// character could forge that structure ("um 17:go"), so its whole chunk goes
// untagged (no measured transcript token has one). A colon inside a token
// ("sagte:", "10:30"; in 8-19% of measured chunks) is shown as a fullwidth
// colon so it cannot read as an id separator; letters, which acceptance
// compares, are unchanged. Format characters such as ZWNJ stay (Persian).
// The emoji tagger's caption lines (emoji-tagging.ts) share both rules.
const FORGES_STRUCTURE = /[\s\p{Z}\p{Cc}]/u;
/** Whether a transcript word could forge a tagging prompt's structure: its whole request is then never sent. */
export const forgesTaggingStructure = (text: string): boolean => FORGES_STRUCTURE.test(text);
/** A transcript word as a tagging prompt shows it: a colon fullwidth, so it cannot read as a separator. */
export const shownTaggingToken = (text: string): string => text.replaceAll(":", "：");

/** Sentence-split chunks of at most `maxWords` words; a token's id is its index in its chunk. */
export function chunkTranscriptForTagging(utterances: TranscriptUtterance[], languageCode: string, maxWords: number): TranscriptTaggingChunk[] {
  const chunks: TranscriptTaggingChunk[] = [];
  let lines: { speaker: number | null; words: TranscriptWord[] }[] = [];
  let count = 0;
  const flush = () => {
    if (count === 0) return;
    const tokens = lines.flatMap((line, at) => line.words.map((word) => ({ speaker: line.speaker, word, line: at })));
    const unsafe = tokens.some((token) => forgesTaggingStructure(token.word.word));
    let id = 0;
    const body = lines.map((line) => `S${line.speaker ?? "?"}: ${line.words.map((word) => `${id++}:${shownTaggingToken(word.word)}`).join(" ")}`).join("\n");
    chunks.push({ tokens, prompt: unsafe ? null : `Language: ${languageCode}\nTokens:\n${body}` });
    lines = [];
    count = 0;
  };
  for (const sentence of splitUtterancesIntoSentences(utterances)) {
    const words = sentence.words.filter((word) => word.word.length > 0);
    if (words.length === 0) continue;
    if (count + words.length > maxWords) flush();
    lines.push({ speaker: sentence.speaker, words });
    count += words.length;
    if (count >= maxWords) flush();
  }
  flush();
  return chunks;
}

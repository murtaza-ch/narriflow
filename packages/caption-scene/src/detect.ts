import type { SceneCue } from "./input";

/**
 * Free-signal detectors the templates read: pauses, list ordinals and totals, numbers inside words,
 * speech rate and the punchline. Ported from the samples (`53-index`, `33-bulletin`, `54-velocity`,
 * `52-punchline`, `20-lyrics`), which read only word texts and timings: no model, no cost.
 */

const lastWordEnd = (cue: SceneCue) => cue.words[cue.words.length - 1]!.endMs;

/** Silence before a cue's first word (since the previous cue's last word), ms; 0 for the first cue. */
export function pauseBeforeMs(cues: readonly SceneCue[], index: number): number {
  const previous = cues[index - 1];
  return previous ? Math.max(0, cues[index]!.startMs - lastWordEnd(previous)) : 0;
}

/** Silence after a cue's last word until the next cue starts, ms; infinite for the last cue. */
export function pauseAfterMs(cues: readonly SceneCue[], index: number): number {
  const next = cues[index + 1];
  return next ? next.startMs - lastWordEnd(cues[index]!) : Number.POSITIVE_INFINITY;
}

/** Lyrics: a pause longer than this shows the breathing dots, ms. */
export const LYRICS_BREAK_MS = 700;

// ─── Lists ("three mistakes ... first ... second ... so") ───────────────────

const NUMBER_WORDS: Readonly<Record<string, number>> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const LIST_NOUNS = /^(things|tips|ways|reasons|steps|mistakes|rules|lessons)$/;
const ORDINALS: Readonly<Record<string, number>> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };
const NEXT_WORDS = /^(next|then|finally|lastly)$/;
const normalise = (text: string) => text.toLowerCase().replace(/[^a-z0-9']/g, "");

export type ListEvent =
  | { readonly type: "total"; readonly n: number; readonly cue: number; readonly word: number; readonly atMs: number }
  | { readonly type: "item"; readonly n: number; readonly cue: number; readonly word: number; readonly atMs: number }
  | { readonly type: "end"; readonly cue: number; readonly word: number; readonly atMs: number };

export interface ListDetection {
  readonly events: readonly ListEvent[];
  /** The announced total, or null when the cues announce no list. */
  readonly total: number | null;
  /** Per cue: a list is open while it is on screen. */
  readonly listOpen: readonly boolean[];
}

/**
 * A word that ends a phrase: it closes with . , ? ! : ; ... (a closing quote or bracket may follow). Cues are cut by
 * word count, so "first" or "next" that starts a phrase is cue-initial in the sample but often mid-cue in a real clip.
 */
const PHRASE_END = /[.,?!:;…]["'”’)\]]*$/;
/** A word that ends a sentence. The end of a list needs this, not a comma: "it works, so you..." is no conclusion. */
const SENTENCE_END = /[.?!…]["'”’)\]]*$/;

/**
 * The total from "N <things>", items from ordinals and next-words ("first", "next") that start a phrase (cue-initial,
 * or right after a word that ends one: `first,` / `... channel. First,`), the end at a "so" or "that's" that is
 * cue-initial or follows a sentence end (`... done. So,`; a comma does not end a list: "it works, so ...").
 * A stray "first" inside a sentence ("the first time I") starts no phrase and counts for nothing.
 */
export function detectList(cues: readonly SceneCue[]): ListDetection {
  const events: ListEvent[] = [];
  const listOpen: boolean[] = [];
  let total = 0;
  let n = 0;
  cues.forEach((cue, cueAt) => {
    cue.words.forEach((word, at) => {
      const key = normalise(word.text);
      const following = cue.words[at + 1] ? normalise(cue.words[at + 1]!.text) : "";
      const count = NUMBER_WORDS[key] ?? (Number(key) || 0);
      const startsPhrase = at === 0 || PHRASE_END.test(cue.words[at - 1]!.text);
      if (count > 0 && LIST_NOUNS.test(following) && total === 0) {
        total = count;
        events.push({ type: "total", n: total, cue: cueAt, word: at, atMs: word.startMs });
      } else if (total > 0 && startsPhrase && (ORDINALS[key] !== undefined || NEXT_WORDS.test(key))) {
        n = ORDINALS[key] ?? n + 1;
        events.push({ type: "item", n, cue: cueAt, word: at, atMs: word.startMs });
      } else if (total > 0 && (at === 0 || SENTENCE_END.test(cue.words[at - 1]!.text)) && /^(so|that's)$/.test(key)) {
        events.push({ type: "end", cue: cueAt, word: at, atMs: word.startMs });
        total = -1;
      }
    });
    listOpen.push(events.length > 0 && events[events.length - 1]!.type !== "end");
  });
  const first = events.find((event) => event.type === "total");
  return { events, total: first && first.type === "total" ? first.n : null, listOpen };
}

// ─── Numbers inside words ───────────────────────────────────────────────────

export interface NumberInWord {
  readonly pre: string;
  readonly value: number;
  readonly decimals: number;
  readonly post: string;
}

/** `"312%"` → `{ pre: "", value: 312, decimals: 0, post: "%" }`; `"$4.2M"` → `{ pre: "$", value: 4.2, decimals: 1, post: "M" }`. */
export function parseNumberInWord(text: string): NumberInWord | null {
  const match = text.match(/^([^\d]*)(\d+(?:\.\d+)?)(.*)$/);
  if (!match) return null;
  return { pre: match[1]!, value: Number(match[2]), decimals: (match[2]!.split(".")[1] ?? "").length, post: match[3]! };
}

/** The text of a counting number at `progress` 0..1 of its way up (`312%` at 0.5 reads `156%`). */
export function countUpText(number: NumberInWord, progress: number): string {
  return `${number.pre}${(number.value * progress).toFixed(number.decimals)}${number.post}`;
}

// ─── Speech rate ────────────────────────────────────────────────────────────

export interface SpeechRate {
  /** Words per second over the cue's spoken span (plus 150 ms). */
  readonly rate: number;
  /** Lean as a skew factor: -0.1 at 2.5 words/s, steeper when faster, clamped to [-0.32, -0.08]. */
  readonly lean: number;
  /** Speed lines: none under 2.5 words/s, two under 3.5, else four. */
  readonly lines: 0 | 2 | 4;
}

export function speechRate(cue: SceneCue): SpeechRate {
  const spokenSec = (lastWordEnd(cue) - cue.startMs) / 1000;
  const rate = cue.words.length / (spokenSec + 0.15);
  const lean = Math.min(-0.08, Math.max(-0.32, -0.1 - 0.05 * (rate - 2.5)));
  return { rate, lean, lines: rate < 2.5 ? 0 : rate < 3.5 ? 2 : 4 };
}

// ─── Punchline ──────────────────────────────────────────────────────────────

export interface Punchline {
  readonly punch: boolean;
  /** Silence before the cue, ms. */
  readonly gapBeforeMs: number;
  /** The cue leaves this early when the next one is a punchline, so its drumroll has the stage; else the cue's end. */
  readonly showUntilMs: number;
}

/** A short line after a real pause that ends a sentence (or is followed by another long pause). */
export function detectPunchlines(cues: readonly SceneCue[]): Punchline[] {
  const punch = cues.map((cue, index) => {
    const gap = pauseBeforeMs(cues, index);
    const after = pauseAfterMs(cues, index);
    const text = cue.words.map((word) => word.text).join(" ");
    return { gapBeforeMs: gap, punch: gap >= 550 && cue.words.length <= 4 && (/[.!?]$/.test(text) || after >= 400) };
  });
  return cues.map((cue, index) => ({ ...punch[index]!, showUntilMs: punch[index + 1]?.punch ? lastWordEnd(cue) + 170 : cue.endMs }));
}

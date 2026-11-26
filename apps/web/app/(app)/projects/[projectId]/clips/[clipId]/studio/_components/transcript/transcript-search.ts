// Search over the subtitle rows. Matching folds case and compatibility forms, ignores Arabic
// diacritics and tatweel, and treats the Arabic and Urdu forms of yeh, kaf and heh as one letter, so
// Urdu typed on an Arabic keyboard still finds its words. Ranges point into the original text.

const ARABIC_MARKS = /[\u064B-\u065F\u0670\u0640]/u;
const LETTER_FOLDS: Record<string, string> = { "\u064A": "\u06CC", "\u0649": "\u06CC", "\u0643": "\u06A9", "\u0647": "\u06C1" };

interface Folded {
  readonly text: string;
  /** For each UTF-16 unit of `text`, the index in the original string of the character it came from. */
  readonly from: readonly number[];
  /** For each UTF-16 unit of `text`, the end index of that character in the original string. */
  readonly to: readonly number[];
}

function fold(text: string): Folded {
  let folded = "";
  const from: number[] = [];
  const to: number[] = [];
  let at = 0;
  for (const char of text) {
    const end = at + char.length;
    if (!ARABIC_MARKS.test(char)) {
      const out = (LETTER_FOLDS[char] ?? char).normalize("NFKC").toLowerCase();
      for (let unit = 0; unit < out.length; unit++) {
        from.push(at);
        to.push(end);
      }
      folded += out;
    }
    at = end;
  }
  return { text: folded, from, to };
}

export function normalizeSearchQuery(query: string): string {
  return fold(query.trim()).text;
}

/** `[start, end)` ranges of every match of an already normalized query in `text`. */
export function searchMatches(text: string, query: string): [number, number][] {
  if (!query) return [];
  const folded = fold(text);
  const ranges: [number, number][] = [];
  let at = folded.text.indexOf(query);
  while (at >= 0) {
    // A match ends after the marks on its last letter.
    let end = folded.to[at + query.length - 1]!;
    while (end < text.length && ARABIC_MARKS.test(text[end]!)) end++;
    ranges.push([folded.from[at]!, end]);
    at = folded.text.indexOf(query, at + query.length);
  }
  return ranges;
}

/** The rows whose text holds the query, in order; every row when the query is empty. */
export function filterRows<T extends { readonly text: string }>(rows: readonly T[], query: string): readonly T[] {
  return query ? rows.filter((row) => fold(row.text).text.includes(query)) : rows;
}

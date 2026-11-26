import type { CaptionEmojiEntry, CaptionEmojiGroup, CaptionEmojiRef as CatalogEmojiRef } from "@narriflow/caption-emoji/index";
import type { CaptionEmojiRef } from "@narriflow/validators";

// The picker's pure parts: search over the catalog, the groups, the section and row layout the
// virtual grid draws, grid keyboard moves, the skin tone a pick takes, and the per-browser recents.

/** Lower case, no apostrophes or emoji selectors, everything but letters and digits a single space. */
export function searchableText(value: string): string {
  return value
    .toLowerCase()
    .replace(/️/g, "")
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const STOP_WORDS = new Set(["a", "an", "and", "at", "for", "i", "im", "in", "is", "it", "me", "my", "of", "on", "so", "that", "the", "this", "to", "was", "we", "you", "your"]);
const PICTOGRAPH = /\p{Extended_Pictographic}/u;
const SELECTORS = /[️\u{1F3FB}-\u{1F3FF}]/gu;

export interface EmojiSearch {
  readonly entries: readonly CaptionEmojiEntry[];
  readonly tokens: readonly (readonly string[])[];
  readonly names: readonly string[];
  readonly glyphs: readonly string[];
}

export function buildEmojiSearch(entries: readonly CaptionEmojiEntry[], groups: readonly CaptionEmojiGroup[]): EmojiSearch {
  const groupNames = new Map(groups.map((group) => [group.id, searchableText(group.name)]));
  return {
    entries,
    names: entries.map((entry) => searchableText(entry.name)),
    glyphs: entries.map((entry) => entry.glyph.replace(SELECTORS, "")),
    tokens: entries.map((entry) => [...new Set([...searchableText(entry.name).split(" "), ...entry.keywords.map(searchableText), ...(groupNames.get(entry.group) ?? "").split(" ")])].filter(Boolean)),
  };
}

/** A skin tone said in a query, as the pack names its tone variants ("Waving hand: dark skin tone"). */
const TONE_PHRASE = /(?:^| )(medium light|medium dark|light|medium|dark) skin tone(?= |$)/;
const TONE_BY_NAME: Record<string, number> = { light: 1, "medium light": 2, medium: 3, "medium dark": 4, dark: 5 };

/**
 * The skin tone a query names, or null: a pasted emoji's skin-tone modifier, or a tone variant's
 * name ("dark skin tone"). The picker switches to it, so the variant is what a pick stores.
 */
export function captionEmojiQueryTone(query: string, refForGlyph: (glyph: string) => CatalogEmojiRef | null): number | null {
  const raw = query.trim();
  if (PICTOGRAPH.test(raw)) return refForGlyph(raw)?.tone ?? null;
  const named = TONE_PHRASE.exec(searchableText(raw))?.[1];
  return named ? TONE_BY_NAME[named]! : null;
}

/**
 * Designs matching a query, best first. A query holding an emoji finds the design for it (a badge
 * by its pair; skin-tone and gender variants map as the AI's glyphs do) and the phrase badges that
 * contain it. A query naming a skin tone ("Waving hand: dark skin tone") searches the designs that
 * have tones with the rest of it. Otherwise every word must begin a word of the name, keywords or
 * group; the exact name first, then exact words and names that start with the query, single
 * designs before badges, then catalog order.
 */
export function searchCaptionEmojis(search: EmojiSearch, query: string, refForGlyph: (glyph: string) => CatalogEmojiRef | null): CaptionEmojiEntry[] {
  const raw = query.trim();
  if (raw === "") return [...search.entries];
  if (PICTOGRAPH.test(raw)) {
    const exact = refForGlyph(raw)?.id;
    const glyph = raw.replace(SELECTORS, "");
    return search.entries.filter((entry, at) => entry.id === exact || (entry.kind === "phrase" && search.glyphs[at]!.includes(glyph)))
      .sort((left, right) => Number(right.id === exact) - Number(left.id === exact));
  }
  const toned = TONE_PHRASE.test(searchableText(raw));
  const phrase = searchableText(raw).replace(TONE_PHRASE, " ").trim();
  if (toned && phrase === "") return search.entries.filter((entry) => entry.hasTones);
  const words = phrase.split(" ").filter(Boolean);
  const terms = words.filter((word) => !STOP_WORDS.has(word));
  const wanted = terms.length > 0 ? terms : words;
  if (wanted.length === 0) return [];
  const scored: { entry: CaptionEmojiEntry; score: number; at: number }[] = [];
  search.entries.forEach((entry, at) => {
    if (toned && !entry.hasTones) return;
    const tokens = search.tokens[at]!;
    let score = 0;
    for (const term of wanted) {
      let best = 0;
      for (const token of tokens) {
        if (token === term) {
          best = 3;
          break;
        }
        if (token.startsWith(term)) best = 2;
      }
      if (best === 0) return;
      score += best;
    }
    if (search.names[at] === phrase) score += 10;
    else if (search.names[at]!.startsWith(phrase)) score += 2;
    if (entry.kind === "single") score += 0.5;
    scored.push({ entry, score, at });
  });
  return scored.sort((left, right) => right.score - left.score || left.at - right.at).map((item) => item.entry);
}

// ─── Layout ────────────────────────────────────────────────────────────────

const GROUP_ORDER = ["smileys", "people", "hands", "animals-and-nature", "food-and-drink", "activities", "travel-and-places", "objects", "symbols", "phrases"];

/** Every design in its group, the groups in the picker's order (people and hands near the faces, phrases last). */
export function captionEmojiPickerGroups(entries: readonly CaptionEmojiEntry[], groups: readonly CaptionEmojiGroup[]): PickerSection[] {
  const rank = (id: string) => (GROUP_ORDER.includes(id) ? GROUP_ORDER.indexOf(id) : GROUP_ORDER.length);
  return [...groups].sort((left, right) => rank(left.id) - rank(right.id))
    .map((group) => ({ id: group.id, label: group.name, items: entries.filter((entry) => entry.group === group.id) }));
}

export interface PickerSection {
  readonly id: string;
  readonly label: string;
  readonly items: readonly CaptionEmojiEntry[];
}

export type PickerRow =
  | { readonly kind: "header"; readonly section: string; readonly label: string; readonly top: number; readonly height: number }
  | { readonly kind: "cells"; readonly section: string; readonly first: number; readonly items: readonly CaptionEmojiEntry[]; readonly top: number; readonly height: number };

export interface PickerLayout {
  readonly rows: readonly PickerRow[];
  /** Every item in visual order; a cell's index in this list is its keyboard position. */
  readonly items: readonly CaptionEmojiEntry[];
  /** The row of each item. */
  readonly rowOf: readonly number[];
  readonly height: number;
  /** Top of each section's header, for the group tabs. */
  readonly sectionTops: ReadonlyMap<string, number>;
}

export function pickerLayout(sections: readonly PickerSection[], columns: number, sizes: { readonly header: number; readonly row: number }): PickerLayout {
  const rows: PickerRow[] = [];
  const items: CaptionEmojiEntry[] = [];
  const rowOf: number[] = [];
  const sectionTops = new Map<string, number>();
  let top = 0;
  for (const section of sections) {
    if (section.items.length === 0) continue;
    sectionTops.set(section.id, top);
    rows.push({ kind: "header", section: section.id, label: section.label, top, height: sizes.header });
    top += sizes.header;
    for (let start = 0; start < section.items.length; start += columns) {
      const slice = section.items.slice(start, start + columns);
      for (const item of slice) {
        items.push(item);
        rowOf.push(rows.length);
      }
      rows.push({ kind: "cells", section: section.id, first: items.length - slice.length, items: slice, top, height: sizes.row });
      top += sizes.row;
    }
  }
  return { rows, items, rowOf, height: top, sectionTops };
}

/** Rows that intersect `[scrollTop, scrollTop + viewport)` widened by `overscan` px each way, as `[first, end)`. */
export function visibleRows(layout: PickerLayout, scrollTop: number, viewport: number, overscan: number): readonly [number, number] {
  const from = scrollTop - overscan;
  const to = scrollTop + viewport + overscan;
  let low = 0;
  let high = layout.rows.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    const row = layout.rows[mid]!;
    if (row.top + row.height <= from) low = mid + 1;
    else high = mid;
  }
  let end = low;
  while (end < layout.rows.length && layout.rows[end]!.top < to) end += 1;
  return [low, end];
}

export type GridMove = "left" | "right" | "up" | "down" | "home" | "end";

/** The item a grid key moves to from `index`: left and right run through the list; up and down keep the column, clamped to the row's last cell. */
export function moveInGrid(layout: PickerLayout, index: number, move: GridMove): number {
  const count = layout.items.length;
  if (count === 0) return -1;
  if (index < 0) return 0;
  if (move === "home") return 0;
  if (move === "end") return count - 1;
  if (move === "left") return Math.max(0, index - 1);
  if (move === "right") return Math.min(count - 1, index + 1);
  const row = layout.rows[layout.rowOf[index]!] as Extract<PickerRow, { kind: "cells" }>;
  const column = index - row.first;
  let at = layout.rowOf[index]! + (move === "down" ? 1 : -1);
  while (at >= 0 && at < layout.rows.length && layout.rows[at]!.kind !== "cells") at += move === "down" ? 1 : -1;
  const target = layout.rows[at];
  if (!target || target.kind !== "cells") return index;
  return target.first + Math.min(column, target.items.length - 1);
}

// ─── Per-browser memory ────────────────────────────────────────────────────

const RECENTS_KEY = "narriflow-caption-emoji-recents";
export const RECENT_LIMIT = 16;

/** Ids most recent first; storage may be unavailable (private browsing), so every read and write can fail quietly. */
export function readRecentEmojis(): string[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(RECENTS_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string").slice(0, RECENT_LIMIT) : [];
  } catch {
    return [];
  }
}

export function withRecentEmoji(recents: readonly string[], id: string): string[] {
  return [id, ...recents.filter((other) => other !== id)].slice(0, RECENT_LIMIT);
}

export function writeRecentEmojis(recents: readonly string[]): void {
  try {
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(recents));
  } catch {
    // Recents are a convenience; without storage they last the session.
  }
}

/**
 * The tone the picker opens at: the emoji's own when it has one (chosen by hand), else the clip's
 * Skin tone (the preset's `emojiTone`), the tone its AI emojis are drawn in.
 */
export function pickerStartTone(current: Pick<CaptionEmojiRef, "tone"> | null, presetTone: number | undefined): number {
  return current?.tone ?? presetTone ?? 0;
}

/**
 * The stored ref for a pick. A design with skin stores the tone it was picked in, the default
 * yellow (0) included: a hand-picked tone never follows the Skin tone setting later. Other designs
 * store none.
 */
export function pickedEmojiRef(entry: Pick<CaptionEmojiEntry, "id" | "hasTones">, tone: number): CaptionEmojiRef {
  return entry.hasTones && Number.isInteger(tone) && tone >= 0 && tone <= 5 ? { id: entry.id, tone } : { id: entry.id };
}

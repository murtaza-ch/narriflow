export interface FilterableAudioAsset {
  id: string;
  title: string;
  moodTags: string[];
  favorited: boolean;
}

/** Shared Music/SFX filtering, including Vizard's useful active-preview pin. */
export function filterAudioAssets<T extends FilterableAudioAsset>(
  assets: T[],
  options: { category: string; search: string; activeId: string | null },
): T[] {
  const needle = options.search.trim().toLowerCase();
  const matches = assets.filter((asset) => {
    if (options.category === "saved" && !asset.favorited) return false;
    if (
      options.category !== "all" &&
      options.category !== "saved" &&
      !asset.moodTags.includes(options.category)
    ) {
      return false;
    }
    return (
      !needle ||
      `${asset.title} ${asset.moodTags.join(" ")}`.toLowerCase().includes(needle)
    );
  });

  const active = assets.find((asset) => asset.id === options.activeId);
  if (active && !matches.some((asset) => asset.id === active.id)) {
    return [...matches, active];
  }
  return matches;
}

/**
 * The Brand group leads the "All" view (never a category or Saved view) and
 * follows the search. Tracks shown there are not repeated in the library list.
 */
export function brandAudioFirst<T extends FilterableAudioAsset>(
  brand: T[],
  library: T[],
  options: { category: string; search: string },
): { brand: T[]; library: T[] } {
  if (options.category !== "all") return { brand: [], library };
  const shown = filterAudioAssets(brand, { ...options, activeId: null });
  const shownIds = new Set(shown.map((asset) => asset.id));
  return { brand: shown, library: library.filter((asset) => !shownIds.has(asset.id)) };
}

/** The library's mood chips follow one fixed order per kind; the catalog's order, not the alphabet. */
const MOOD_ORDER = {
  music: [
    "Popular", "Upbeat", "Happy", "Chill", "Funny", "Cinematic", "Epic",
    "Suspense", "Dark", "Romantic", "Jazz", "Electronic", "World", "Ambient",
  ],
  sfx: [
    "Whoosh", "Impact", "Pop", "Click", "Notification", "Success", "Fail",
    "Cash", "Magic", "Sci-fi", "Cartoon", "Crowd", "Ambience", "Foley",
  ],
} as const;

/** Known tags in the curated order, then unknown tags alphabetically. Case is ignored when matching and kept in the result. */
export function orderMoodTags(kind: keyof typeof MOOD_ORDER, tags: readonly string[]): string[] {
  const order: readonly string[] = MOOD_ORDER[kind];
  const rank = (tag: string) => {
    const index = order.findIndex((known) => known.toLowerCase() === tag.toLowerCase());
    return index === -1 ? order.length : index;
  };
  const unique = new Map<string, string>();
  for (const tag of tags) if (!unique.has(tag.toLowerCase())) unique.set(tag.toLowerCase(), tag);
  return [...unique.values()].sort(
    (a, b) => rank(a) - rank(b) || a.localeCompare(b, undefined, { sensitivity: "base" }),
  );
}

/** The row being previewed stays reachable even when the list no longer contains it. */
export function pinActiveAudio<T extends { id: string }>(
  rows: T[],
  active: T | null,
): T[] {
  return active && !rows.some((row) => row.id === active.id) ? [...rows, active] : rows;
}

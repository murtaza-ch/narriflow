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

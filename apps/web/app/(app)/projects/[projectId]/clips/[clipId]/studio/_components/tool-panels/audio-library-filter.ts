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

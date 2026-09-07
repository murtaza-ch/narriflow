export type PreviewAudioAssetResolution =
  | { state: "pending" | "failed" }
  | { state: "available"; url: string; durationSec: number };

export type PreviewAudioAssetResolutionMap = Record<
  string,
  PreviewAudioAssetResolution
>;

export function reconcileSelectedAudioAssets(
  current: PreviewAudioAssetResolutionMap,
  selectedAssetIds: readonly string[],
): PreviewAudioAssetResolutionMap {
  return Object.fromEntries(
    selectedAssetIds.map((id) => [
      id,
      current[id] ?? { state: "pending" as const },
    ]),
  );
}

export function adoptResolvedAudioAssets(
  current: PreviewAudioAssetResolutionMap,
  arrivals: ReadonlyArray<readonly [string, PreviewAudioAssetResolution]>,
): PreviewAudioAssetResolutionMap {
  let next = current;
  for (const [id, resolution] of arrivals) {
    if (!(id in current)) continue;
    if (next === current) next = { ...current };
    next[id] = resolution;
  }
  return next;
}

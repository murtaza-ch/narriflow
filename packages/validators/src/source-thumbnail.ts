/** Dashboard images, independent of publishing thumbnails. Dimensions include padding. */
export const SOURCE_THUMBNAIL_VARIANTS = [
  { role: "source_thumbnail_small", width: 480, height: 270, targetBytes: 40_000 },
  { role: "source_thumbnail_large", width: 960, height: 540, targetBytes: 100_000 },
] as const;
export type SourceThumbnailRole = (typeof SOURCE_THUMBNAIL_VARIANTS)[number]["role"];
export const SOURCE_THUMBNAIL_MAX_BYTES = 256 * 1024;
export function isSourceThumbnailRole(role: string): role is SourceThumbnailRole {
  return SOURCE_THUMBNAIL_VARIANTS.some((variant) => variant.role === role);
}
export function sourceThumbnailTime(durationSec: number) {
  return Math.min(1, durationSec / 2);
}

export interface PexelsUser {
  id: number;
  name: string;
  url: string;
}

export interface PexelsVideoFile {
  link: string;
  width: number | null;
  height: number | null;
  quality: string | null;
  file_type: string | null;
}

export interface PexelsVideo {
  id: number;
  width: number;
  height: number;
  duration: number;
  /** The Pexels page URL for this specific video — used as the attribution source link. */
  url: string;
  /** Thumbnail, used by the studio picker's result grid. */
  image: string;
  user: PexelsUser | null;
  video_files: PexelsVideoFile[];
}

export interface BrollAttribution {
  authorName: string | null;
  authorUrl: string | null;
  pageUrl: string | null;
  pexelsId: number;
}

export interface BrollClip {
  id: number;
  width: number;
  height: number;
  durationSec: number;
  downloadUrl: string;
  attribution: BrollAttribution;
}

export interface BrollSearchResult {
  id: number;
  image: string;
  width: number;
  height: number;
  durationSec: number;
  downloadUrl: string;
  authorName: string | null;
  authorUrl: string | null;
  pageUrl: string | null;
}

/** Picks the smallest mp4 at/above the target width, else the largest available. */
export function pickPexelsFile(
  files: PexelsVideoFile[],
  targetWidth: number,
): PexelsVideoFile | null {
  const mp4s = files.filter(
    (f) => f.link && (f.file_type === "video/mp4" || f.link.includes(".mp4")),
  );
  const pool = mp4s.length > 0 ? mp4s : files.filter((f) => f.link);
  if (pool.length === 0) return null;
  const atLeast = pool
    .filter((f) => (f.width ?? 0) >= targetWidth)
    .sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  if (atLeast.length > 0) return atLeast[0]!;
  return [...pool].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]!;
}

/**
 * Chooses the best video for a target frame: prefers videos long enough for a
 * cutaway and closest to the target orientation, and surfaces the attribution
 * (author name/url + the video's own Pexels page URL) alongside the pick.
 */
export function selectBestPexelsVideo(
  videos: PexelsVideo[],
  targetWidth: number,
  targetHeight: number,
  minDurationSec = 2,
): BrollClip | null {
  const targetPortrait = targetHeight >= targetWidth;
  const ranked = videos
    .filter((v) => v.duration >= minDurationSec && v.video_files?.length > 0)
    .sort((a, b) => {
      const aMatch = a.height >= a.width === targetPortrait ? 0 : 1;
      const bMatch = b.height >= b.width === targetPortrait ? 0 : 1;
      return aMatch - bMatch;
    });

  for (const video of ranked) {
    const file = pickPexelsFile(video.video_files, targetWidth);
    if (file) {
      return {
        id: video.id,
        width: video.width,
        height: video.height,
        durationSec: video.duration,
        downloadUrl: file.link,
        attribution: {
          authorName: video.user?.name ?? null,
          authorUrl: video.user?.url ?? null,
          pageUrl: video.url ?? null,
          pexelsId: video.id,
        },
      };
    }
  }
  return null;
}


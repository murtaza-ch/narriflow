const YT_RE =
  /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|v\/))([A-Za-z0-9_-]{11})/;

export function extractYoutubeId(
  ...inputs: Array<string | null | undefined>
): string | null {
  for (const url of inputs) {
    if (!url) continue;
    const match = url.match(YT_RE);
    if (match && match[1]) return match[1];
  }
  return null;
}

export function youtubeThumbnailUrl(id: string, quality: "max" | "hq" = "max") {
  const file = quality === "max" ? "maxresdefault.jpg" : "hqdefault.jpg";
  return `https://i.ytimg.com/vi/${id}/${file}`;
}

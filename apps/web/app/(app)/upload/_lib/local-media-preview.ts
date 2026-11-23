import { sourceThumbnailTime, SOURCE_THUMBNAIL_MAX_BYTES } from "@narriflow/validators/source-thumbnail";

/** Own the URL and player attachment for one effect lifetime, including Strict Mode replay. */
export function attachLocalMediaPreview(
  media: Pick<HTMLMediaElement, "src" | "load" | "removeAttribute">,
  file: File,
) {
  const url = URL.createObjectURL(file);
  media.src = url;
  media.load();
  return () => {
    media.removeAttribute("src");
    media.load();
    URL.revokeObjectURL(url);
  };
}
/** Best-effort local image. Its entire decode/seek/encode lifetime is bounded;
 * callers keep uploading even when this browser cannot decode the source. */
export function extractLocalVideoThumbnail(file: File, signal: AbortSignal): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const video = document.createElement("video");
    const sourceUrl = URL.createObjectURL(file);
    let settled = false;
    let drawing = false;
    let target: number | null = null;
    const finish = (blob?: Blob) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", cancel);
      video.onloadedmetadata = video.onloadeddata = video.onseeked = video.onerror = null;
      video.pause();
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(sourceUrl);
      if (blob) resolve(blob);
      else reject(new Error("local_thumbnail_unavailable"));
    };
    const cancel = () => finish();
    const timeout = setTimeout(cancel, 8_000);
    signal.addEventListener("abort", cancel, { once: true });
    const draw = () => {
      if (settled || drawing || target === null || video.seeking || video.readyState < 2 || Math.abs(video.currentTime - target) > 0.05) return;
      if (!video.videoWidth || !video.videoHeight) { finish(); return; }
      drawing = true;
      try {
        const scale = Math.min(1, 960 / video.videoWidth, 540 / video.videoHeight);
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        const context = canvas.getContext("2d");
        if (!context) { finish(); return; }
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => {
          if (settled) return;
          if (blob?.type === "image/webp" && blob.size <= SOURCE_THUMBNAIL_MAX_BYTES) finish(blob);
          else {
            try { canvas.toBlob((jpeg) => finish(jpeg && jpeg.size <= SOURCE_THUMBNAIL_MAX_BYTES ? jpeg : undefined), "image/jpeg", 0.8); }
            catch { finish(); }
          }
        }, "image/webp", 0.8);
      } catch { finish(); }
    };
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    video.onerror = cancel;
    video.onloadedmetadata = () => {
      if (!Number.isFinite(video.duration) || video.duration <= 0) { finish(); return; }
      target = sourceThumbnailTime(video.duration);
      try { video.currentTime = target; draw(); }
      catch { finish(); }
    };
    video.onloadeddata = draw;
    video.onseeked = draw;
    video.src = sourceUrl;
    video.load();
  });
}

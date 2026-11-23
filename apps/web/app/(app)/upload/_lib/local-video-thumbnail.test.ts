import { expect, mock, test } from "bun:test";
import { extractLocalVideoThumbnail } from "./local-media-preview";

async function withMedia(run: (fixture: ReturnType<typeof fixture>) => Promise<void>) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  const media = fixture();
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: (tag: string) => tag === "video" ? media.video : media.canvas } });
  try { await run(media); }
  finally {
    if (original) Object.defineProperty(globalThis, "document", original);
    else Reflect.deleteProperty(globalThis, "document");
  }
}
function fixture() {
  const draw = mock(() => {});
  let encoder: BlobCallback | null = null;
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: draw }), toBlob: (callback: BlobCallback) => { encoder = callback; } };
  const video = {
    duration: 2, videoWidth: 3840, videoHeight: 2160, readyState: 0, seeking: false, currentTime: 0,
    src: "", preload: "", muted: false, playsInline: false,
    onloadedmetadata: null as (() => void) | null, onloadeddata: null as (() => void) | null,
    onseeked: null as (() => void) | null, onerror: null as (() => void) | null,
    load: mock(() => {}), pause: mock(() => {}), removeAttribute: () => { video.src = ""; },
  };
  return { video, canvas, draw, encode: () => encoder?.(new Blob(["encoded"], { type: "image/webp" })) };
}

test("metadata cannot capture an undecoded frame; decoded footage is resized before encoding and the source is released", () => withMedia(async ({ video, canvas, draw, encode }) => {
  const pending = extractLocalVideoThumbnail(new File(["video"], "source.mp4"), new AbortController().signal);
  const sourceUrl = video.src;
  video.readyState = 1; video.onloadedmetadata?.();
  expect(video.currentTime).toBe(1); expect(draw).not.toHaveBeenCalled();
  video.readyState = 2; video.onseeked?.();
  expect(canvas.width).toBe(960); expect(canvas.height).toBe(540); expect(draw).toHaveBeenCalledTimes(1);
  encode(); expect((await pending).type).toBe("image/webp");
  expect(video.src).toBe(""); expect(video.pause).toHaveBeenCalled();
  await expect(fetch(sourceUrl)).rejects.toThrow();
}));

test("cancelling a replaced file releases its source and ignores a late encoder callback", () => withMedia(async ({ video, encode }) => {
  const controller = new AbortController();
  const pending = extractLocalVideoThumbnail(new File(["video"], "source.mp4"), controller.signal);
  video.readyState = 2; video.onloadedmetadata?.(); video.onseeked?.();
  const sourceUrl = video.src;
  controller.abort();
  await expect(pending).rejects.toThrow("local_thumbnail_unavailable");
  encode(); expect(video.src).toBe(""); expect(video.onseeked).toBeNull();
  await expect(fetch(sourceUrl)).rejects.toThrow();
}));

test("an unsupported codec degrades without retaining the file URL", () => withMedia(async ({ video, draw }) => {
  const pending = extractLocalVideoThumbnail(new File(["video"], "source.mov"), new AbortController().signal);
  video.onerror?.();
  await expect(pending).rejects.toThrow("local_thumbnail_unavailable");
  expect(draw).not.toHaveBeenCalled(); expect(video.src).toBe("");
}));

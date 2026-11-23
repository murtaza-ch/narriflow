import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { SOURCE_THUMBNAIL_MAX_BYTES, SOURCE_THUMBNAIL_VARIANTS, sourceThumbnailTime } from "@narriflow/validators/source-thumbnail";
import { createWorkerProcessModule } from "./worker-process";

/** Decode only a few frames, at bounded dimensions, through the shared process owner. */
export async function generateSourceThumbnails(input: { sourcePath: string; durationSec: number; outputDirectory: string }, signal: AbortSignal) {
  const process = createWorkerProcessModule();
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  const times = [...new Set([sourceThumbnailTime(input.durationSec), Math.min(5, input.durationSec * 0.1), input.durationSec / 2, 0])];
  let frame: Buffer | undefined;
  for (const time of times) {
    bounded.throwIfAborted();
    try {
      const result = await process.execute({ command: "ffmpeg", signal: bounded, deadlineMs: 15_000,
        captureStdout: true, maxStdoutBytes: 4 * 1024 * 1024,
        args: ["-hide_banner", "-loglevel", "error", "-nostdin", "-max_alloc", "268435456", "-protocol_whitelist", "file,pipe",
          "-ss", time.toFixed(6), "-threads", "2", "-i", input.sourcePath, "-map", "0:V:0", "-frames:v", "1", "-an", "-threads", "2",
          "-vf", "scale=w='max(1,min(iw*sar,min(960,540*dar)))':h='max(1,trunc(ow/dar))',setsar=1", "-f", "image2pipe", "-c:v", "png", "pipe:1"] });
      if (result.stdout.length === 0) continue;
      const stats = await sharp(result.stdout, { limitInputPixels: 960 * 540 }).stats();
      frame = result.stdout;
      // A bounded retry avoids black opening frames. Zero also covers valid
      // one-frame videos, where seeking forward can yield no subsequent frame.
      if (stats.channels.slice(0, 3).some((channel) => channel.mean > 18)) break;
    } catch {
      bounded.throwIfAborted();
    }
  }
  if (!frame) throw new Error("source_thumbnail_unavailable");
  const variants = [];
  for (const variant of SOURCE_THUMBNAIL_VARIANTS) {
    bounded.throwIfAborted();
    const image = () => sharp(frame, { limitInputPixels: 960 * 540 })
      .resize(variant.width, variant.height, { fit: "contain", withoutEnlargement: true, background: "#0e1013" });
    let bytes = await image().webp({ quality: 80, effort: 3 }).toBuffer();
    if (bytes.length > variant.targetBytes) bytes = await image().webp({ quality: 65, effort: 3 }).toBuffer();
    if (bytes.length > SOURCE_THUMBNAIL_MAX_BYTES) throw new Error("source_thumbnail_too_large");
    bounded.throwIfAborted();
    const path = join(input.outputDirectory, `${variant.role}.webp`);
    await writeFile(path, bytes, { flag: "wx", mode: 0o400 });
    variants.push({ role: variant.role, path, byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  return { variants };
}

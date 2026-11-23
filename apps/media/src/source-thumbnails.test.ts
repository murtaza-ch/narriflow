import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { generateSourceThumbnails } from "./source-thumbnails";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture(filter: string) {
  const directory = await mkdtemp(join(tmpdir(), "source-thumbnails-")); directories.push(directory);
  const sourcePath = join(directory, "source.mp4");
  const process = Bun.spawn(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-f", "lavfi", "-i", filter,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-threads", "1", sourcePath], { stdout: "pipe", stderr: "pipe" });
  const error = await new Response(process.stderr).text();
  expect(await process.exited, error).toBe(0);
  return { sourcePath, outputDirectory: directory };
}

test("a short portrait source produces bounded WebP variants with padding and no enlarged footage", async () => {
  const input = await fixture("color=c=blue:s=120x240:r=10:d=0.4");
  const result = await generateSourceThumbnails({ ...input, durationSec: 0.4 }, new AbortController().signal);
  expect(result.variants).toHaveLength(2);
  for (const [index, variant] of result.variants.entries()) {
    const bytes = await readFile(variant.path);
    const metadata = await sharp(bytes).metadata();
    expect(metadata).toMatchObject({ format: "webp", width: index === 0 ? 480 : 960, height: index === 0 ? 270 : 540 });
    expect(bytes.length).toBeLessThan(index === 0 ? 40_000 : 100_000);
    const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
    const center = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels;
    expect(data[center + 2]!).toBeGreaterThan(200);
    // Pixel 100 px from center is outside the original 120 px-wide footage.
    expect(data[center + 100 * info.channels + 2]!).toBeLessThan(40);
  }
});

test("black opening frames are skipped using bounded later samples", async () => {
  const input = await fixture("color=c=black:s=320x180:r=10:d=2[a];color=c=red:s=320x180:r=10:d=2[b];[a][b]concat=n=2:v=1:a=0");
  const result = await generateSourceThumbnails({ ...input, durationSec: 4 }, new AbortController().signal);
  const { data, info } = await sharp(result.variants[0]!.path).raw().toBuffer({ resolveWithObject: true });
  const center = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels;
  expect(data[center]!).toBeGreaterThan(200);
});

test("cancelled extraction cannot publish an image", async () => {
  const input = await fixture("color=c=blue:s=32x24:r=10:d=0.2");
  const controller = new AbortController(); controller.abort();
  await expect(generateSourceThumbnails({ ...input, durationSec: 0.2 }, controller.signal)).rejects.toThrow();
  await expect(readFile(join(input.outputDirectory, "source_thumbnail_small.webp"))).rejects.toThrow();
});

test("a valid single-frame video still gets an image when forward seeks yield no frame", async () => {
  const input = await fixture("color=c=green:s=64x48:r=1:d=1");
  const result = await generateSourceThumbnails({ ...input, durationSec: 1 }, new AbortController().signal);
  expect(result.variants).toHaveLength(2);
  expect(await sharp(result.variants[0]!.path).metadata()).toMatchObject({ format: "webp", width: 480, height: 270 });
});

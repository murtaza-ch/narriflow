/**
 * Bounded check that the native pieces the API calls actually work in this
 * image: real font metadata, argon2 passcode hashing, a sharp + ffprobe visual
 * probe and an FFmpeg thumbnail extraction. No network, no database, no secrets.
 *
 *   bun run --cwd apps/api smoke:native        (repo root /app, API workdir /app/apps/api)
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import ffprobe from "@ffprobe-installer/ffprobe";
import { hash, verify } from "@node-rs/argon2";
import { create as parseFont } from "fontkit";
import sharp from "sharp";

const run = promisify(execFile);
const STEP_TIMEOUT_MS = 20_000;
const FONT_PATH = new URL("../../../packages/caption-fonts/fonts/Anton-Regular.ttf", import.meta.url);

async function bounded<T>(name: string, work: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} exceeded ${STEP_TIMEOUT_MS} ms`)), STEP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fontMetadata(): Promise<string> {
  const font = parseFont(Buffer.from(await readFile(FONT_PATH)));
  if (!("familyName" in font) || !font.familyName || font.numGlyphs < 10) {
    throw new Error("font metadata is incomplete");
  }
  return `${font.familyName} (${font.numGlyphs} glyphs)`;
}

async function passcodeHashing(): Promise<string> {
  // The review service's parameters: argon2id, 64 MiB, three passes.
  const encoded = await hash("smoke-passcode", {
    algorithm: 2,
    memoryCost: 65_536,
    timeCost: 3,
    parallelism: 1,
    outputLen: 32,
  });
  if (!(await verify(encoded, "smoke-passcode")) || (await verify(encoded, "wrong"))) {
    throw new Error("argon2 verify disagreed with hash");
  }
  return "argon2id hash and verify";
}

async function visualProbe(dir: string): Promise<string> {
  const png = join(dir, "probe.png");
  await sharp({ create: { width: 64, height: 48, channels: 3, background: "#336699" } })
    .png()
    .toFile(png);
  const meta = await sharp(png).metadata();
  const { stdout } = await run(
    ffprobe.path,
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height", "-of", "json", png],
    { timeout: STEP_TIMEOUT_MS },
  );
  const stream = (JSON.parse(stdout) as { streams?: Array<{ width?: number; height?: number }> }).streams?.[0];
  if (meta.width !== 64 || stream?.width !== 64 || stream?.height !== 48) {
    throw new Error("sharp and ffprobe disagree about the probe image");
  }
  return "sharp metadata and ffprobe agree on 64x48";
}

async function thumbnailExtraction(dir: string): Promise<string> {
  const video = join(dir, "clip.mp4");
  await run(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=10:duration=1", "-pix_fmt", "yuv420p", video],
    { timeout: STEP_TIMEOUT_MS },
  );
  const { stdout } = await run(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-ss", "0.5", "-i", video, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"],
    { encoding: "buffer", timeout: STEP_TIMEOUT_MS, maxBuffer: 5 * 1024 * 1024 },
  );
  const frame = join(dir, "frame.jpg");
  await writeFile(frame, stdout);
  const meta = await sharp(frame).metadata();
  if (meta.format !== "jpeg" || meta.width !== 160) throw new Error("extracted frame is not the expected JPEG");
  return "ffmpeg extracted a 160x90 JPEG frame";
}

const dir = await mkdtemp(join(tmpdir(), "narriflow-native-smoke-"));
let failed = false;
try {
  const steps: Array<[string, () => Promise<string>]> = [
    ["font-metadata", fontMetadata],
    ["passcode-hashing", passcodeHashing],
    ["visual-probe", () => visualProbe(dir)],
    ["thumbnail-extraction", () => thumbnailExtraction(dir)],
  ];
  for (const [name, work] of steps) {
    try {
      const detail = await bounded(name, work);
      console.warn(JSON.stringify({ level: "info", message: "native_smoke_step", step: name, ok: true, detail }));
    } catch (error) {
      failed = true;
      console.warn(
        JSON.stringify({
          level: "error",
          message: "native_smoke_step",
          step: name,
          ok: false,
          error: error instanceof Error ? error.message : "failed",
        }),
      );
    }
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);

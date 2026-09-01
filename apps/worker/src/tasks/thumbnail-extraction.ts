import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  presignDownloadUrl,
  putFileFromPath,
} from "@narriflow/services";

const execFileAsync = promisify(execFile);

export class ThumbnailFrameOutputError extends Error {
  readonly code = "thumbnail_output_invalid";

  constructor() {
    super("The extracted thumbnail failed its media integrity check");
    this.name = "ThumbnailFrameOutputError";
  }
}

interface ThumbnailFrameDependencies {
  createTempDirectory(): Promise<string>;
  removeTempDirectory(path: string): Promise<void>;
  sourceUrl(key: string): Promise<string>;
  runFfmpeg(binary: string, args: string[]): Promise<void>;
  probe(path: string): Promise<{
    width: number;
    height: number;
    contentType: "image/jpeg";
  } | null>;
  fileSize(path: string): Promise<number>;
  fingerprint(path: string): Promise<string>;
  upload(input: { key: string; filePath: string; contentType: "image/jpeg" }): Promise<void>;
}

interface ThumbnailFrameRequest {
  jobId: string;
  sourceStorageKey: string;
  sourceTimeSec: number;
  destinationStorageKey: string;
}

async function sha256File(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function probeJpeg(path: string) {
  try {
    const { stdout } = await execFileAsync(
      process.env.FFPROBE_PATH?.trim() || "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=codec_name,width,height",
        "-of",
        "json",
        path,
      ],
      { timeout: 15_000, maxBuffer: 256 * 1024 },
    );
    const parsed = JSON.parse(stdout) as {
      streams?: Array<{ codec_name?: string; width?: number; height?: number }>;
    };
    const stream = parsed.streams?.[0];
    return stream?.codec_name === "mjpeg" &&
      typeof stream.width === "number" &&
      stream.width > 0 &&
      typeof stream.height === "number" &&
      stream.height > 0
      ? { width: stream.width, height: stream.height, contentType: "image/jpeg" as const }
      : null;
  } catch {
    return null;
  }
}

const productionDependencies: ThumbnailFrameDependencies = {
  createTempDirectory: () => mkdtemp(join(tmpdir(), "narriflow-thumbnail-")),
  removeTempDirectory: (path) => rm(path, { recursive: true, force: true }),
  sourceUrl: (key) => presignDownloadUrl({ key, expiresIn: 600 }),
  async runFfmpeg(binary, args) {
    await execFileAsync(binary, args, {
      timeout: 60_000,
      maxBuffer: 512 * 1024,
    });
  },
  probe: probeJpeg,
  async fileSize(path) {
    return (await stat(path)).size;
  },
  fingerprint: sha256File,
  async upload(input) {
    await putFileFromPath(input);
  },
};

export function createFfmpegThumbnailFrameProcessor(
  dependencies: ThumbnailFrameDependencies = productionDependencies,
) {
  return {
    async extract(input: ThumbnailFrameRequest) {
      const directory = await dependencies.createTempDirectory();
      const outputPath = join(directory, "frame.jpg");
      try {
        const sourceUrl = await dependencies.sourceUrl(input.sourceStorageKey);
        await dependencies.runFfmpeg(
          process.env.FFMPEG_PATH?.trim() || "ffmpeg",
          [
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-ss",
            input.sourceTimeSec.toFixed(3),
            "-i",
            sourceUrl,
            "-map",
            "0:v:0",
            "-frames:v",
            "1",
            "-an",
            "-sn",
            "-dn",
            "-q:v",
            "2",
            "-f",
            "image2",
            "-y",
            outputPath,
          ],
        );
        const [probe, sizeBytes, fingerprint] = await Promise.all([
          dependencies.probe(outputPath),
          dependencies.fileSize(outputPath),
          dependencies.fingerprint(outputPath),
        ]);
        if (
          !probe ||
          sizeBytes <= 0 ||
          !/^[a-f0-9]{64}$/.test(fingerprint)
        ) {
          throw new ThumbnailFrameOutputError();
        }
        await dependencies.upload({
          key: input.destinationStorageKey,
          filePath: outputPath,
          contentType: "image/jpeg",
        });
        return {
          storageKey: input.destinationStorageKey,
          contentType: "image/jpeg" as const,
          sizeBytes,
          width: probe.width,
          height: probe.height,
          fingerprint,
        };
      } finally {
        await dependencies.removeTempDirectory(directory).catch(() => undefined);
      }
    },
  };
}

export const ffmpegThumbnailFrameProcessor =
  createFfmpegThumbnailFrameProcessor();

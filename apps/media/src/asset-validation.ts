import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { constants, copyFile, lstat, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { z } from "zod";
import { nativeValidationEvidenceSchema, type NativeValidationEvidence } from "@narriflow/validators/native-validation";
import { parseBrandFont } from "./brand-font-parser";
import { createWorkerProcessModule } from "./worker-process";

const filePath = z.string().min(1).max(2048).refine(value => isAbsolute(value) && !value.includes("\0"));
export const assetValidationCommandSchema = z.strictObject({
  kind: z.enum(["font", "visual", "thumbnail"]), sourcePath: filePath, outputPath: filePath,
  expected: z.strictObject({ contentType: z.string().min(1).max(128), byteLength: z.number().int().positive().max(2 * 1024 ** 3), sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  sourceTimeMs: z.number().int().nonnegative().max(86_400_000).optional(),
}).refine(value => (value.kind === "thumbnail") === (value.sourceTimeMs !== undefined));

async function digest(path: string, signal: AbortSignal) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
  return hash.digest("hex");
}

async function inspectImage(path: string) {
  const { default: sharp } = await import("sharp");
  const image = sharp(path, { failOn: "warning", limitInputPixels: 40_000_000, sequentialRead: true });
  const metadata = await image.metadata();
  // metadata() alone can accept truncated pixel payloads. Decode every pixel
  // before admitting the original bytes, within the fixed image pixel ceiling.
  await image.stats();
  const contentType = metadata.format === "png" ? "image/png" : metadata.format === "jpeg" ? "image/jpeg" : metadata.format === "webp" ? "image/webp" : null;
  if (!contentType || !metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1) throw new Error("visual_asset_probe_failed");
  return { contentType, mediaKind: "image" as const, width: metadata.width, height: metadata.height, durationSec: null };
}

/** Local immutable inputs only. The wrapper owns transfer, execution authority,
 * process-start charging, container limits and the absolute process deadline. */
export async function validateNativeAsset(raw: unknown, signal: AbortSignal): Promise<NativeValidationEvidence> {
  const input = assetValidationCommandSchema.parse(raw);
  signal.throwIfAborted();
  const sourcePath = await realpath(input.sourcePath);
  const outputPath = `${await realpath(dirname(input.outputPath))}/${input.outputPath.split("/").at(-1)}`;
  if ((await lstat(input.sourcePath)).isSymbolicLink() || sourcePath === outputPath) throw new Error("asset_validation_path_invalid");
  const source = await stat(sourcePath);
  if (!source.isFile() || source.size !== input.expected.byteLength || (input.kind === "font" && source.size > 20 * 1024 ** 2)) throw new Error("asset_validation_size_mismatch");
  const sha256 = await digest(sourcePath, signal);
  if (sha256 !== input.expected.sha256) throw new Error("asset_validation_fingerprint_mismatch");
  let evidence: NativeValidationEvidence;
  if (input.kind === "font") {
    const parsed = parseBrandFont(new Uint8Array(await readFile(sourcePath)));
    const expectedFormat = input.expected.contentType === "font/woff2" ? "woff2" : input.expected.contentType === "font/otf" ? "otf" : ["font/ttf", "application/font-sfnt"].includes(input.expected.contentType) ? "ttf" : null;
    if (parsed.format !== expectedFormat) throw new Error("brand_font_format_mismatch");
    evidence = nativeValidationEvidenceSchema.parse({ kind: "font", sha256, byteLength: source.size, ...parsed });
  } else if (input.kind === "visual" && input.expected.contentType.startsWith("image/")) {
    const inspected = await inspectImage(sourcePath);
    if (inspected.contentType !== input.expected.contentType) throw new Error("visual_asset_mime_mismatch");
    evidence = nativeValidationEvidenceSchema.parse({ kind: "visual", sha256, byteLength: source.size, ...inspected });
  } else {
    const process = createWorkerProcessModule();
    if (input.kind === "thumbnail") {
      await process.execute({ command: "ffmpeg", signal, deadlineMs: 60_000, maxStdoutBytes: 1024,
        args: ["-hide_banner", "-loglevel", "error", "-nostdin", "-max_alloc", "268435456", "-protocol_whitelist", "file,pipe", "-ss", (input.sourceTimeMs! / 1000).toFixed(3), "-f", "mov", "-i", sourcePath, "-frames:v", "1", "-threads", "2", "-f", "image2", "-vcodec", "mjpeg", "-n", input.outputPath] });
      const inspected = await inspectImage(input.outputPath);
      const output = await stat(input.outputPath);
      evidence = nativeValidationEvidenceSchema.parse({ kind: "thumbnail", sha256: await digest(input.outputPath, signal), byteLength: output.size, ...inspected });
    } else {
      const output = await process.execute({ command: "ffprobe", signal, deadlineMs: 20_000, captureStdout: true, maxStdoutBytes: 64 * 1024,
        args: ["-v", "error", "-max_alloc", "268435456", "-protocol_whitelist", "file", "-probesize", "33554432", "-analyzeduration", "20000000", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height,duration:format=format_name,duration:format_tags=major_brand", "-of", "json", "-f", "mov", sourcePath] });
      const probed = JSON.parse(output.stdout.toString("utf8")) as { streams?: Array<{ width?: number; height?: number; duration?: string }>; format?: { format_name?: string; duration?: string; tags?: { major_brand?: string } } };
      const stream = probed.streams?.[0];
      const contentType = probed.format?.format_name?.split(",").some(value => value === "mov" || value === "mp4") ? probed.format.tags?.major_brand?.trim().toLowerCase() === "qt" ? "video/quicktime" : "video/mp4" : null;
      if (!contentType || contentType !== input.expected.contentType) throw new Error("visual_asset_mime_mismatch");
      evidence = nativeValidationEvidenceSchema.parse({ kind: "visual", sha256, byteLength: source.size, contentType, mediaKind: "video", width: stream?.width, height: stream?.height, durationSec: Number(stream?.duration ?? probed.format?.duration) });
    }
  }
  signal.throwIfAborted();
  if (input.kind !== "thumbnail") {
    await copyFile(sourcePath, input.outputPath, constants.COPYFILE_EXCL);
    if (await digest(input.outputPath, signal) !== sha256) throw new Error("asset_validation_fingerprint_mismatch");
  }
  return evidence;
}

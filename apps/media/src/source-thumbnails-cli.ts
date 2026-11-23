import { dirname, isAbsolute } from "node:path";
import { lstat } from "node:fs/promises";
import { z } from "zod";
import { generateSourceThumbnails } from "./source-thumbnails";

const path = z.string().min(1).max(4096).refine((value) => isAbsolute(value) && !value.includes("\0"));
const command = z.strictObject({ sourcePath: path, outputDirectory: path, durationSec: z.number().finite().positive().max(86_400) });
async function main() {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin) { size += chunk.length; if (size > 8192) throw new Error("source_thumbnail_invalid"); chunks.push(chunk); }
  const input = command.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  const source = await lstat(input.sourcePath);
  if (!source.isFile() || source.isSymbolicLink() || source.size <= 0 || source.size > 10 * 1024 ** 3 || dirname(input.sourcePath) !== input.outputDirectory) throw new Error("source_thumbnail_invalid");
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("media_execution_cancelled"));
  process.once("SIGTERM", cancel); process.once("SIGINT", cancel);
  try { process.stdout.write(`${JSON.stringify(await generateSourceThumbnails(input, controller.signal))}\n`); }
  finally { process.removeListener("SIGTERM", cancel); process.removeListener("SIGINT", cancel); }
}
if (import.meta.main) main().catch(() => {
  console.warn(JSON.stringify({ level: "warn", message: "source_thumbnail_unavailable" }));
  process.exitCode = 1;
});

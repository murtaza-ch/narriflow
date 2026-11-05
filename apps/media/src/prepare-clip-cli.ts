import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { clipPreparationInputSchema } from "@narriflow/validators/clip-preparation";
import { WorkflowFailure } from "@narriflow/services/workflow-attempt-contract";
import { prepareClip } from "./prepare-clip";
import { parseRenderConfig } from "./render-config";
import { productionWorkerProcessModule } from "./worker-process";

const invalid = (): never => { throw new Error("clip_preparation_command_invalid"); };
async function main() {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of process.stdin) { bytes += chunk.length; if (bytes > 65536) invalid(); chunks.push(chunk); }
  const command = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!command || typeof command !== "object" || Array.isArray(command) || Object.keys(command).sort().join(",") !== "inputPath,peaksArtifactId,previewArtifactId,sourcePath,work") invalid();
  for (const field of ["inputPath", "work"]) if (typeof command[field] !== "string" || command[field].length > 4096 || !isAbsolute(command[field])) invalid();
  for (const field of ["previewArtifactId", "peaksArtifactId"]) if (typeof command[field] !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(command[field])) invalid();
  if (typeof command.sourcePath !== "string" || command.sourcePath.length > 512) invalid();
  const url = new URL(command.sourcePath);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.hash || url.search || !/^\/[A-Za-z0-9_-]+\/[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(url.pathname)) invalid();
  const [work, path, inputStat] = await Promise.all([realpath(command.work), realpath(command.inputPath), lstat(command.inputPath)]);
  if (inputStat.isSymbolicLink() || !inputStat.isFile() || inputStat.size < 1 || inputStat.size > 16*1024**2 || dirname(path) !== work) invalid();
  const input = clipPreparationInputSchema.parse(JSON.parse(await readFile(path, "utf8")));
  const controller = new AbortController(), cancel = () => controller.abort(new Error("clip_preparation_cancelled"));
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  const timer = setTimeout(cancel, 45*60_000);
  try {
    const result = await prepareClip({ input, sourcePath: command.sourcePath, work, previewArtifactId: command.previewArtifactId,
      peaksArtifactId: command.peaksArtifactId, workerProcess: productionWorkerProcessModule, config: parseRenderConfig(process.env), signal: controller.signal });
    console.error(JSON.stringify({ level: "info", message: "clip_preparation_metrics", phaseMs: result.phaseMs }));
    process.stdout.write(JSON.stringify({ previewPath: result.previewPath, peaksPath: result.peaksPath, layoutPath: result.layoutPath })+"\n");
  } finally { clearTimeout(timer); process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
}
if (import.meta.main) main().catch((error: unknown) => {
  const code = error instanceof WorkflowFailure ? error.code : error instanceof Error && /^(?:source_identity_mismatch|clip_preparation_[a-z_]+)$/.test(error.message) ? error.message : "clip_preparation_failed";
  console.error(JSON.stringify({ level: "error", message: "clip_preparation_failed", errorCode: code,
    retryable: error instanceof WorkflowFailure ? error.disposition === "retryable" : code !== "source_identity_mismatch" && code !== "clip_preparation_command_invalid" }));
  process.exitCode = 1;
});

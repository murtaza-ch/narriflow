import { isAbsolute } from "node:path";
import { stat } from "node:fs/promises";
import { createWorkerProcessModule } from "./worker-process";
import { WorkflowFailure } from "@narriflow/services/workflow-attempt-contract";

export const NORMALIZED_PROBE_VERSION = "normalized-probe-v1";

/** Shared normalized probe used by both Python acquisition locations. Local files only. */
async function main() {
 const chunks: Buffer[] = [];
 let size = 0;
 for await (const chunk of process.stdin) {
  size += chunk.length;
  if (size > 4096) throw new Error("probe_command_invalid");
  chunks.push(chunk);
 }
 const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
 if (!input || typeof input !== "object" || Array.isArray(input) ||
     Object.keys(input).some((key) => key !== "sourcePath")) throw new Error("probe_command_invalid");
 const sourcePath = Reflect.get(input, "sourcePath");
 if (typeof sourcePath !== "string" || sourcePath.length > 2048 || sourcePath.includes("\0") || !isAbsolute(sourcePath)) {
  throw new Error("probe_command_invalid");
 }
 const source = await stat(sourcePath);
 if (!source.isFile() || source.size === 0 || source.size > 10 * 1024 ** 3) throw new Error("source_media_invalid");
 const controller = new AbortController();
 const cancel = () => controller.abort(new Error("media_execution_cancelled"));
 process.once("SIGTERM", cancel);
 process.once("SIGINT", cancel);
 try {
  const facts = await createWorkerProcessModule().inspectMedia({ sourcePath,localOnly:true, signal: controller.signal, deadlineMs: 30_000 });
  process.stdout.write(`${JSON.stringify({ ...facts, probeVersion: NORMALIZED_PROBE_VERSION })}\n`);
 } finally {
  process.removeListener("SIGTERM", cancel);
  process.removeListener("SIGINT", cancel);
 }
}

if (import.meta.main) {
 main().catch((error: unknown) => {
  const failure = error instanceof WorkflowFailure ? error : null;
  const code = failure?.code ?? "source_probe_failed";
  console.error(JSON.stringify({ level: "error", message: code, errorCode: code, retryable: failure?.disposition !== "permanent" }));
  process.exitCode = 1;
 });
}

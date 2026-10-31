import { createWorkerProcessModule } from "./worker-process";
import { prepareLanguageProbeFile, type LanguageProbeFileInput } from "./prepare-language-probe";

async function main() {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) { size += chunk.length; if (size > 65536) throw new Error(); chunks.push(chunk); }
  const input: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  const fields = ["sourceAudio", "source", "windows", "outputPath", "artifactId", "bindingHash"];
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== fields.length || Object.keys(input).some(key => !fields.includes(key))) throw new Error();
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("media_execution_cancelled"));
  process.once("SIGTERM", cancel); process.once("SIGINT", cancel);
  try {
    const result = await prepareLanguageProbeFile(input as LanguageProbeFileInput, { signal: controller.signal, workerProcess: createWorkerProcessModule() });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally { process.removeListener("SIGTERM", cancel); process.removeListener("SIGINT", cancel); }
}
if (import.meta.main) main().catch(() => { console.error(JSON.stringify({ level: "error", message: "language_probe_preparation_failed" })); process.exitCode = 1; });

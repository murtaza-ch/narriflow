import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { z } from "zod";
import { executeDubbing, type DubbingNativeOptions } from "./dubbing-native";
import { DUBBING_STAGE_OUTPUTS } from "@narriflow/services/dubbing-policy";

const path = z.string().min(1).max(4096).refine(value => isAbsolute(value) && !value.includes("\0"));
const invocation = z.strictObject({ inputPath: path, work: path, rpcUrl: z.string().max(512),
  sourceNames: z.array(z.enum(["base_video", "translation_result", "dub_audio", "dub_video"])).min(1).max(4),
  stages: z.array(z.enum(Object.keys(DUBBING_STAGE_OUTPUTS) as [keyof typeof DUBBING_STAGE_OUTPUTS, ...(keyof typeof DUBBING_STAGE_OUTPUTS)[]])).min(1).max(6) });
/** The optional transport is a trusted program seam for controlled HTTP gates. */
export async function runDubbingCli(providerRequest?: DubbingNativeOptions["providerRequest"]) {
  const chunks: Buffer[] = [];let size = 0;
  for await (const chunk of process.stdin) { size += chunk.length;if (size > 65536) throw Error("dubbing_command_invalid");chunks.push(chunk); }
  const command = invocation.parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))), url = new URL(command.rpcUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.hash || url.search || !/^\/[A-Za-z0-9_-]+$/.test(url.pathname)) throw Error("dubbing_command_invalid");
  const [work, inputPath, info] = await Promise.all([realpath(command.work), realpath(command.inputPath), lstat(command.inputPath)]);
  if (info.isSymbolicLink() || !info.isFile() || info.size < 1 || info.size > 16 * 1024 ** 2 || dirname(inputPath) !== work) throw Error("dubbing_command_invalid");
  const input = JSON.parse(await readFile(inputPath, "utf8")), controller = new AbortController(), cancel = () => controller.abort(Error("dubbing_cancelled"));
  process.once("SIGTERM", cancel);process.once("SIGINT", cancel);const timeout = setTimeout(cancel, 45 * 60_000);
  try {
    const result = await executeDubbing(input, { work, sourceNames: command.sourceNames, stages: command.stages, signal: controller.signal, apiKey: process.env.OPENAI_API_KEY, providerRequest,
      request: async value => {
        const response = await fetch(url, { method: "POST", redirect: "error", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value), signal: controller.signal });
        if (response.status !== 200 || !response.body) throw Error("dubbing_control_unavailable");
        const reader = response.body.getReader(), parts: Uint8Array[] = [];let size = 0;
        try { while (true) { const part = await reader.read();if (part.done) break;size += part.value.byteLength;if (size > 65536) throw Error("dubbing_control_unavailable");parts.push(part.value); } }
        finally { await reader.cancel().catch(() => {});reader.releaseLock(); }
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts)));
      } });
    process.stdout.write(JSON.stringify(result) + "\n");
  } finally { clearTimeout(timeout);process.removeListener("SIGTERM", cancel);process.removeListener("SIGINT", cancel); }
}
if (import.meta.main) runDubbingCli().catch(() => { console.error(JSON.stringify({ level: "error", message: "dubbing_failed", errorCode: "dubbing_process_failed" }));process.exitCode = 1; });

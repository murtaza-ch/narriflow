import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { renderGroup } from "./render-group";
import { parseRenderConfig } from "./render-config";
import { renderGroupDeadlineMs } from "./render-resource-budget";
import { renderExecutionInputSchema } from "@narriflow/validators/render-execution";

const invalid = (): never => { throw new Error("render_command_invalid"); };
function localUrl(value: unknown, directory = false) {
  if (typeof value !== "string" || value.length > 512) return invalid();
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.hash || url.search ||
    !(directory ? /^\/[A-Za-z0-9_-]+\/$/ : /^\/[A-Za-z0-9_-]+$/).test(url.pathname)) return invalid();
  return url;
}
async function main() {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of process.stdin) { bytes += chunk.length; if (bytes > 65536) invalid(); chunks.push(chunk); }
  const command = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!command || Object.keys(command).sort().join(",") !== "attemptToken,inputPath,renderIds,rpcUrl,sourceBaseUrl,work") invalid();
  for (const field of ["inputPath", "work"]) if (typeof command[field] !== "string" || !isAbsolute(command[field]) || command[field].length > 4096) invalid();
  if (typeof command.attemptToken !== "string" || !/^[0-9a-f-]{36}$/i.test(command.attemptToken) || !Array.isArray(command.renderIds) || command.renderIds.length > 4) invalid();
  const rpcUrl = localUrl(command.rpcUrl), sourceBaseUrl = localUrl(command.sourceBaseUrl, true);
  const [work, inputPath, info] = await Promise.all([realpath(command.work), realpath(command.inputPath), lstat(command.inputPath)]);
  if (info.isSymbolicLink() || !info.isFile() || info.size < 1 || info.size > 16 * 1024 ** 2 || dirname(inputPath) !== work) invalid();
  const input = renderExecutionInputSchema.parse(JSON.parse(await readFile(inputPath, "utf8")));
  const controller = new AbortController(), cancel = () => controller.abort(new Error("render_cancelled"));
  process.once("SIGTERM", cancel); process.once("SIGINT", cancel);
  const { document, sourceProbe } = input.preparation;
  const deadlineMs = renderGroupDeadlineMs({ editedDurationSec: document.clipEndSec - document.clipStartSec, sourceWidth: sourceProbe.video?.width ?? null,
    sourceHeight: sourceProbe.video?.height ?? null, hdr: false, variants: command.renderIds.length }, parseRenderConfig({}));
  const timer = setTimeout(() => {
    console.error(JSON.stringify({ level: "warn", message: "render_group_deadline_exceeded", deadlineMs }));
    cancel();
  }, deadlineMs);
  // Diagnostics stay off stdout and contain only the renderer's bounded facts.
  const originalLog = console.log;
  console.log = (...args) => console.error(...args);
  try {
    const outcome = await renderGroup({ input, work, signal: controller.signal, attemptToken: command.attemptToken,
      ports: { renderIds: command.renderIds, sourceUrl: name => new URL(name, sourceBaseUrl).href,
        request: async body => {
          const response = await fetch(rpcUrl, { method: "POST", redirect: "error", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
          if (response.status !== 200 || Number(response.headers.get("Content-Length")) > 65536) throw new Error("render_control_unavailable");
          const bytes = new Uint8Array(await response.arrayBuffer()); if (bytes.byteLength > 65536) invalid();
          return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        } } });
    process.stdout.write(JSON.stringify(outcome) + "\n");
  } finally { console.log = originalLog; clearTimeout(timer); process.removeListener("SIGTERM", cancel); process.removeListener("SIGINT", cancel); }
}
if (import.meta.main) main().catch((error: unknown) => {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[a-z][a-z0-9_]{0,99}$/.test(error.code) ? error.code : "render_group_failed";
  console.error(JSON.stringify({ level: "error", message: "render_group_failed", errorCode: code })); process.exitCode = 1;
});

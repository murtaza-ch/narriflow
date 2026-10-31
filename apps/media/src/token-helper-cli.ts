import { isAbsolute, join } from "node:path";
import { readFile, stat, writeFile } from "node:fs/promises";
import { startYoutubeTokenServer, YOUTUBE_TOKEN_SERVER_VERSION } from "./youtube-token-helper";

async function main() {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("source_token_helper_invalid");
    chunks.push(chunk);
  }
  const input: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  if (!input || typeof input !== "object" || Array.isArray(input) ||
    Object.keys(input).some(key => !["serverHome", "readyFile", "owner", "port", "proxy", "deadlineSeconds"].includes(key))) throw new Error("source_token_helper_invalid");
  const serverHome = Reflect.get(input, "serverHome"), readyFile = Reflect.get(input, "readyFile"), owner = Reflect.get(input, "owner");
  const port = Reflect.get(input, "port"), proxy = Reflect.get(input, "proxy"), deadlineSeconds = Reflect.get(input, "deadlineSeconds");
  if (typeof serverHome !== "string" || !isAbsolute(serverHome) || serverHome.length > 2048 ||
    typeof readyFile !== "string" || !isAbsolute(readyFile) || readyFile.length > 2048 ||
    typeof owner !== "string" || !/^[a-f0-9]{32}$/.test(owner) || !Number.isInteger(port) || port < 1 || port > 65535 ||
    typeof proxy !== "string" || proxy.length > 2048 || typeof deadlineSeconds !== "number" || !Number.isFinite(deadlineSeconds) ||
    deadlineSeconds <= 0 || deadlineSeconds > 2700) throw new Error("source_token_helper_invalid");
  const packagePath = join(serverHome, "package.json");
  if ((await stat(packagePath)).size > 65536 || JSON.parse(await readFile(packagePath, "utf8")).version !== YOUTUBE_TOKEN_SERVER_VERSION) throw new Error("source_token_helper_invalid");
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("media_execution_cancelled"));
  const deadline = setTimeout(cancel, deadlineSeconds * 1000);
  process.once("SIGTERM", cancel);
  process.once("SIGINT", cancel);
  try {
    const helper = await startYoutubeTokenServer(serverHome, controller.signal, undefined, { port, proxy });
    try {
      await writeFile(readyFile, JSON.stringify({ owner, version: YOUTUBE_TOKEN_SERVER_VERSION, url: `http://127.0.0.1:${port}` }), { flag: "wx", mode: 0o600 });
      await helper.exited;
      if (!controller.signal.aborted) throw new Error("source_token_helper_exited");
    } finally { helper.stop(); await helper.exited; }
  } finally {
    clearTimeout(deadline);
    process.removeListener("SIGTERM", cancel);
    process.removeListener("SIGINT", cancel);
  }
}

if (import.meta.main) main().catch(() => {
  console.error(JSON.stringify({ level: "error", message: "source_token_helper_failed" }));
  process.exitCode = 1;
});

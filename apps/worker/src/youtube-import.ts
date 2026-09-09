import { spawn, type ChildProcess } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export const YOUTUBE_TOKEN_SERVER_URL = "http://127.0.0.1:4416";
export const YOUTUBE_TOKEN_SERVER_VERSION = "2.0.0";

/** Both extraction and media transfer must use the same client configuration. */
export function ytdlpCommonArgs(provider: string): string[] {
  const args = ["--ignore-config", "--no-playlist"];
  if (provider === "youtube") {
    args.push(
      "--no-js-runtimes", "--js-runtimes", "deno",
      "--extractor-args", "youtube:player_client=mweb",
      "--extractor-args", `youtubepot-bgutilhttp:base_url=${YOUTUBE_TOKEN_SERVER_URL}`,
    );
  }
  return args;
}

/** Never borrow an unrelated server already occupying our private port. */
export async function startYoutubeTokenServer(
  serverHome: string,
  signal: AbortSignal,
): Promise<ChildProcess> {
  signal.throwIfAborted();
  const home = await realpath(serverHome);
  const modules = resolve(home, "node_modules");
  const child = spawn("deno", [
    "run", "--cached-only", "--frozen", "--allow-env", "--allow-net",
    `--allow-ffi=${modules}`, `--allow-read=${modules}`,
    resolve(home, "src/main.ts"), "--host", "127.0.0.1",
  ], {
    cwd: home,
    stdio: ["ignore", "pipe", "ignore"],
    // Third-party token generation does not need application credentials.
    env: {
      PATH: process.env.PATH,
      DENO_DIR: resolve(home, ".cache/deno"),
      DENO_NO_PROMPT: "1",
      DENO_NO_UPDATE_CHECK: "1",
    },
  });
  let failure: Error | undefined;
  let listening = false;
  let startupOutput = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    // Upstream prints generated tokens; never forward its stdout to app logs.
    if (!listening) {
      startupOutput = (startupOutput + chunk.toString()).slice(-2048);
      listening = startupOutput.includes("Started POT server");
    }
  });
  child.on("error", (error) => { failure = error; });
  const stop = () => {
    child.kill("SIGTERM");
    const forceKill = setTimeout(() => child.kill("SIGKILL"), 5_000);
    forceKill.unref();
    child.once("close", () => clearTimeout(forceKill));
  };
  signal.addEventListener("abort", stop, { once: true });
  child.once("exit", () => signal.removeEventListener("abort", stop));

  try {
    for (let attempt = 0; attempt < 60; attempt++) {
      signal.throwIfAborted();
      if (failure) throw failure;
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error("YouTube token server exited during startup");
      }
      try {
        if (!listening) {
          await sleep(250, undefined, { signal });
          continue;
        }
        const response = await fetch(`${YOUTUBE_TOKEN_SERVER_URL}/ping`, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(500)]),
        });
        const status = await response.json() as { version?: string };
        if (response.ok && status.version === YOUTUBE_TOKEN_SERVER_VERSION) {
          console.warn(JSON.stringify({ level: "info", message: "youtube_token_server_ready", version: status.version }));
          return child;
        }
      } catch {
        signal.throwIfAborted();
      }
      await sleep(250, undefined, { signal });
    }
    throw new Error("YouTube token server did not become ready within 45 seconds");
  } catch (error) {
    stop();
    throw error;
  }
}

import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { productionWorkerProcessModule, type WorkerPersistentProcess, type WorkerProcessModule } from "./worker-process";

export const YOUTUBE_TOKEN_SERVER_URL = "http://127.0.0.1:4416";
export const YOUTUBE_TOKEN_SERVER_VERSION = "2.0.0";

/** Never borrow an unrelated server already occupying our private port. */
export async function startYoutubeTokenServer(
  serverHome: string,
  signal: AbortSignal,
  workerProcess: WorkerProcessModule = productionWorkerProcessModule,
  options: { port?: number; proxy?: string } = {},
): Promise<WorkerPersistentProcess> {
  signal.throwIfAborted();
  const port = options.port ?? 4416;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("youtube_helper_configuration_invalid");
  const endpoint = `http://127.0.0.1:${port}`;
  const proxy = options.proxy ?? "";
  if (proxy) {
    try {
      const value = new URL(proxy);
      if (value.protocol !== "http:" || !value.hostname || value.pathname !== "/" || value.search || value.hash || /[\s\0]/.test(proxy)) throw new Error();
    } catch { throw new Error("youtube_proxy_invalid"); }
  }
  const home = await realpath(serverHome);
  const modules = resolve(home, "node_modules");
  let failure: Error | undefined;
  const child = await workerProcess.start?.({ command: "deno", args: [
    "run", "--cached-only", "--frozen", "--allow-env", "--allow-net",
    `--allow-ffi=${modules}`, `--allow-read=${modules},${resolve(home, "src")}`,
    // The provider image ships package.json and deno.lock but no deno.json;
    // Deno discovers both from cwd, exactly like the image's own entrypoint.
    fileURLToPath(new URL("./owned-helper.ts", import.meta.url)),
    resolve(home, "src/main.ts"), "--host", "127.0.0.1", "--port", String(port),
  ],
    cwd: home,
    // Third-party token generation does not need application credentials.
    env: {
      PATH: process.env.PATH,
      DENO_DIR: resolve(home, ".cache/deno"),
      DENO_NO_PROMPT: "1",
      DENO_NO_UPDATE_CHECK: "1",
      HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy,
      http_proxy: proxy, https_proxy: proxy, all_proxy: proxy,
      NO_PROXY: "127.0.0.1,localhost,::1", no_proxy: "127.0.0.1,localhost,::1",
    },
    signal,
    startupDeadlineMs: 45_000,
    startupReadyMarker: "Started POT server",
  });
  if (!child) throw new Error("Worker Process Module does not support persistent processes");
  void child.exited.then(({ exitCode, signalCode }) => {
    if (!signal.aborted && (exitCode !== 0 || signalCode !== null)) failure = new Error("YouTube token server exited");
  });
  const stop = () => child.stop();

  try {
    for (let attempt = 0; attempt < 60; attempt++) {
      signal.throwIfAborted();
      if (failure) throw failure;
      try {
        const response = await fetch(`${endpoint}/ping`, {
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
    await child.exited;
    throw error;
  }
}


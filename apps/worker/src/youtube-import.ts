import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  WorkerProcessFailure,
  type WorkerPersistentProcess,
} from "../../media/src/worker-process";

import { YOUTUBE_TOKEN_SERVER_URL } from "../../media/src/youtube-token-helper";
export { startYoutubeTokenServer, YOUTUBE_TOKEN_SERVER_URL, YOUTUBE_TOKEN_SERVER_VERSION } from "../../media/src/youtube-token-helper";

/** Operator configuration only. Never accept proxy credentials from import input. */
export function getYoutubeProxyUrl(value = process.env.YTDLP_PROXY_URL): string {
  const proxy = value?.trim() ?? "";
  if (!proxy) return "";
  try {
    const url = new URL(proxy);
    if (
      !["http:", "https:", "socks4:", "socks4a:", "socks5:", "socks5h:"].includes(url.protocol)
      || !url.hostname || (url.pathname !== "" && url.pathname !== "/")
      || url.search || url.hash || /\s/.test(proxy) || proxy.length > 2048
    ) throw new Error("invalid proxy");
    return proxy;
  } catch {
    // URL parsing errors can include credentials. Never forward them.
    throw new Error("YTDLP_PROXY_URL must be an HTTP, HTTPS or SOCKS proxy URL without a path, query or fragment");
  }
}

/** A `{session}` username placeholder gives each resolution a fresh exit IP. */
export function youtubeProxyRotates(proxyUrl = process.env.YTDLP_PROXY_URL): boolean {
  const proxy = getYoutubeProxyUrl(proxyUrl);
  return proxy !== "" && /%7Bsession%7D/i.test(new URL(proxy).username);
}

/** Both extraction and media transfer must use the same client configuration. */
export function ytdlpCommonArgs(provider: string, proxyUrl = process.env.YTDLP_PROXY_URL): string[] {
  const args = ["--ignore-config", "--no-playlist"];
  if (provider === "youtube") {
    let proxy = getYoutubeProxyUrl(proxyUrl);
    if (proxy) {
      const url = new URL(proxy);
      if (/%7Bsession%7D/i.test(url.username)) {
        // Called once per import; metadata, media and retries reuse these args.
        url.username = url.username.replace(/%7Bsession%7D/gi, randomUUID().replaceAll("-", ""));
        proxy = url.href;
      }
    }
    args.push(
      // Empty explicitly means direct; ignore machine-wide proxy environment.
      "--proxy", proxy,
      "--no-js-runtimes", "--js-runtimes", "deno",
      "--extractor-args", "youtube:player_client=mweb",
      "--extractor-args", `youtubepot-bgutilhttp:base_url=${YOUTUBE_TOKEN_SERVER_URL}`,
    );
  }
  return args;
}


type HelperFailure = Record<string, string | number | null>;
const TERMINAL_COLOR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** A loggable startup reason. Startup output precedes any generated token. */
function helperFailure(error: unknown): HelperFailure {
  const summary = (text: string) =>
    text.replace(TERMINAL_COLOR, "").split("\n").map((line) => line.trim())
      .filter(Boolean).slice(0, 3).join(" | ").slice(0, 400);
  if (error instanceof WorkerProcessFailure) {
    return { reason: error.code, exitCode: error.exitCode, detail: summary(error.diagnostic) };
  }
  return {
    reason: "youtube_helper_start_failed",
    detail: summary(error instanceof Error ? error.message : String(error)),
  };
}

/** Restore intake after a failed startup or helper exit without restarting other loops. */
export async function superviseYoutubeTokenServer(
  signal: AbortSignal,
  start: () => Promise<WorkerPersistentProcess>,
  setAvailable: (available: boolean) => void,
  retryMs = 5_000,
  maxRetryMs = 5 * 60_000,
): Promise<void> {
  let delayMs = retryMs;
  while (!signal.aborted) {
    let failure: HelperFailure;
    try {
      const server = await start();
      setAvailable(!signal.aborted);
      delayMs = retryMs;
      const { exitCode, signalCode } = await server.exited;
      failure = { reason: "youtube_helper_exited", exitCode, signalCode };
    } catch (error) {
      failure = helperFailure(error);
    } finally {
      setAvailable(false);
    }
    if (signal.aborted) return;
    console.warn(JSON.stringify({ level: "warn", message: "youtube_link_intake_unavailable", retryMs: delayMs, ...failure }));
    try { await sleep(delayMs, undefined, { signal }); }
    catch { return; }
    delayMs = Math.min(delayMs * 2, maxRetryMs);
  }
}

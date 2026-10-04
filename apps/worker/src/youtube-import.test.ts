import { expect, spyOn, test } from "bun:test";
import { WorkerProcessFailure, type WorkerPersistentProcessRequest } from "./worker-process";
import {
  getYoutubeProxyUrl,
  startYoutubeTokenServer,
  superviseYoutubeTokenServer,
  ytdlpCommonArgs,
} from "./youtube-import";

test("the token provider launch needs only files the provider image ships", async () => {
  let request: WorkerPersistentProcessRequest | undefined;
  await expect(startYoutubeTokenServer(process.cwd(), new AbortController().signal, {
    async start(input) { request = input; throw new Error("stop after capture"); },
  } as never)).rejects.toThrow("stop after capture");
  // The image copies package.json, deno.lock, node_modules and src, not deno.json.
  expect(request!.args.join(" ")).not.toContain("deno.json");
  expect(request!.args).not.toContainEqual(expect.stringMatching(/^--config/));
});

test("unavailable YouTube intake logs why and backs off until a start succeeds", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const controller = new AbortController();
  let starts = 0;
  try {
    await superviseYoutubeTokenServer(controller.signal, async () => {
      starts++;
      if (starts <= 2) {
        throw new WorkerProcessFailure("worker_process_startup_failed", "retryable", "exited",
          "\x1b[31merror\x1b[0m: Error reading config file\n\nCaused by:\n    No such file", 1);
      }
      if (starts === 3) return { exited: Promise.resolve({ exitCode: 0, signalCode: null }), stop() {} };
      controller.abort();
      throw new Error("shutdown");
    }, () => {}, 1, 2);
    const logs = warn.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(logs).toEqual([
      expect.objectContaining({ retryMs: 1, reason: "worker_process_startup_failed", exitCode: 1,
        detail: "error: Error reading config file | Caused by: | No such file" }),
      expect.objectContaining({ retryMs: 2, reason: "worker_process_startup_failed" }),
      expect.objectContaining({ retryMs: 1, reason: "youtube_helper_exited", exitCode: 0 }),
    ]);
  } finally {
    warn.mockRestore();
  }
});

test("YouTube intake recovers from startup failure and a later helper exit", async () => {
  const controller = new AbortController();
  const availability: boolean[] = [];
  let starts = 0;
  await superviseYoutubeTokenServer(controller.signal, async () => {
    starts++;
    if (starts === 1) throw new Error("port occupied");
    if (starts === 3) controller.abort();
    return { exited: Promise.resolve({ exitCode: 1, signalCode: null }), stop() {} };
  }, (available) => availability.push(available), 1);
  expect(starts).toBe(3);
  expect(availability).toEqual([false, true, false, false, false]);
});

test("shutdown cancels the helper restart delay", async () => {
  const controller = new AbortController();
  let starts = 0;
  const pending = superviseYoutubeTokenServer(controller.signal, async () => {
    starts++;
    throw new Error("unavailable");
  }, () => {}, 60_000);
  await Bun.sleep(10);
  controller.abort();
  await pending;
  expect(starts).toBe(1);
});

test("YouTube explicitly uses Deno, mweb and the private token provider", () => {
  const args = ytdlpCommonArgs("youtube");
  expect(args).toContain("--ignore-config");
  expect(args).toContain("--no-js-runtimes");
  expect(args[args.indexOf("--js-runtimes") + 1]).toBe("deno");
  expect(args).toContain("youtube:player_client=mweb");
  expect(args).toContain("youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416");
  expect(args).not.toContain("--no-warnings");
});

test("a YouTube import preserves one authenticated proxy for all shared arguments", () => {
  const proxy = "http://session-fixed:p%40ss@proxy.example:8080";
  const args = ytdlpCommonArgs("youtube", proxy);
  expect(args[args.indexOf("--proxy") + 1]).toBe(proxy);
  expect(ytdlpCommonArgs("vimeo", proxy)).not.toContain(proxy);
});

test("unconfigured YouTube imports explicitly use a direct connection", () => {
  const args = ytdlpCommonArgs("youtube", "");
  expect(args[args.indexOf("--proxy") + 1]).toBe("");
});

test("sticky proxy sessions are fresh per import and resolved before arguments are reused", () => {
  const proxy = "http://user-session-{session}-sessionduration-180:pass@proxy.example:7000";
  const first = ytdlpCommonArgs("youtube", proxy);
  const second = ytdlpCommonArgs("youtube", proxy);
  const resolved = first[first.indexOf("--proxy") + 1];
  expect(resolved).toMatch(/user-session-[a-f0-9]{32}-sessionduration-180/);
  expect(resolved).not.toBe(second[second.indexOf("--proxy") + 1]);
  expect(resolved).not.toContain("{session}");
  expect(getYoutubeProxyUrl(proxy)).toBe(proxy);
});

test.each(["http", "https", "socks4", "socks4a", "socks5", "socks5h"])("supports %s proxies", (scheme) => {
  const proxy = `${scheme}://user:password@proxy.example:8080`;
  expect(getYoutubeProxyUrl(proxy)).toBe(proxy);
});

test.each([
  "password-at-invalid-url", "file:///secret", "http://user:secret@proxy.example/path",
  "http://user:secret@proxy.example?token=secret", "http://user:secret@proxy.example#secret",
  "http://user:secret@proxy.example:99999", "http://user:secret\n@proxy.example",
])("rejects malformed proxy configuration without echoing credentials: %s", (proxy) => {
  let failure: unknown;
  try { getYoutubeProxyUrl(proxy); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain("YTDLP_PROXY_URL");
  expect((failure as Error).message).not.toContain("secret");
  expect((failure as Error).message).not.toContain(proxy);
});

test("other link providers do not receive YouTube-specific options", () => {
  expect(ytdlpCommonArgs("vimeo")).toEqual(["--ignore-config", "--no-playlist"]);
});

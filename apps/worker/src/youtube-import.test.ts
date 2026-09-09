import { expect, test } from "bun:test";
import { getYoutubeProxyUrl, ytdlpCommonArgs } from "./youtube-import";

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

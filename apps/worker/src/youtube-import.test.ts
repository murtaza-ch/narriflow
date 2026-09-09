import { expect, test } from "bun:test";
import { ytdlpCommonArgs } from "./youtube-import";

test("YouTube explicitly uses Deno, mweb and the private token provider", () => {
  const args = ytdlpCommonArgs("youtube");
  expect(args).toContain("--ignore-config");
  expect(args).toContain("--no-js-runtimes");
  expect(args[args.indexOf("--js-runtimes") + 1]).toBe("deno");
  expect(args).toContain("youtube:player_client=mweb");
  expect(args).toContain("youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416");
  expect(args).not.toContain("--no-warnings");
});

test("other link providers do not receive YouTube-specific options", () => {
  expect(ytdlpCommonArgs("vimeo")).toEqual(["--ignore-config", "--no-playlist"]);
});

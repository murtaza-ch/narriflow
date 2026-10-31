import { expect, test } from "bun:test";
import type { WorkerPersistentProcessRequest } from "./worker-process";
import { startYoutubeTokenServer } from "./youtube-token-helper";

test("the token provider launch needs only files the provider image ships", async () => {
  let request: WorkerPersistentProcessRequest | undefined;
  await expect(startYoutubeTokenServer(process.cwd(), new AbortController().signal, {
    async start(input) { request = input; throw new Error("stop after capture"); },
  } as never)).rejects.toThrow("stop after capture");
  expect(request!.args.join(" ")).not.toContain("deno.json");
  expect(request!.args).not.toContainEqual(expect.stringMatching(/^--config/));
});

test("owned helpers bind their own port and every upstream proxy environment to the same session", async () => {
  let request: WorkerPersistentProcessRequest | undefined;
  const proxy = "http://sticky-fixed:test-only@proxy.example:8080";
  await expect(startYoutubeTokenServer(process.cwd(), new AbortController().signal, {
    async start(input) { request = input; throw new Error("stop after capture"); },
  } as never, { port: 18416, proxy })).rejects.toThrow("stop after capture");
  expect(request!.args.slice(-4)).toEqual(["--host", "127.0.0.1", "--port", "18416"]);
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) expect(request!.env[key]).toBe(proxy);
  expect(request!.env.DATABASE_URL).toBeUndefined();
  expect(request!.env.EXECUTION_SIGNING_KEY).toBeUndefined();
  expect(request!.env.NO_PROXY).toBe("127.0.0.1,localhost,::1");
});

test.skipIf(!process.env.MEDIA_TEST_TOKEN_SERVER_HOME)("an occupied loopback port cannot be borrowed as the owned daemon", async () => {
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return Response.json({ version: "2.0.0" }); } });
  try {
    await expect(startYoutubeTokenServer(process.env.MEDIA_TEST_TOKEN_SERVER_HOME!, AbortSignal.timeout(5_000), undefined, { port: server.port! })).rejects.toBeInstanceOf(Error);
    expect(requests).toBe(0);
  } finally { await server.stop(true); }
});

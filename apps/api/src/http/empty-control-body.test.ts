import { expect, test } from "bun:test";
import { Hono } from "hono";
import {
  createExportsClient,
  exportCommands,
} from "../../../../packages/api-client/src/exports";
import { routeBodyLimit } from "../body-limits";
import type { ApiEnv } from "./env";
import { BODY_LIMIT_BYTES } from "./limits";
import { requireJsonContentType } from "./route";

function stream(chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function app() {
  const server = new Hono<ApiEnv>();
  server.use("*", routeBodyLimit(), requireJsonContentType());
  server.post("/api/projects/:id/clips/:clipId/exports/:exportId/retry", (c) =>
    c.json({ id: c.req.param("exportId"), bodyAbsent: c.req.raw.body === null }, 202),
  );
  server.post("/control", async (c) => c.json({ body: await c.req.text() }));
  return server;
}

for (const chunks of [[], [new Uint8Array(0), new Uint8Array(0)]]) {
  test(`empty streamed export retry reaches the bodyless route (${chunks.length} chunks)`, async () => {
    const server = app();
    const client = createExportsClient({
      baseUrl: "https://api.test",
      fetch: async (target, init = {}) => {
        expect(init.method).toBe("POST");
        expect(init.body == null).toBe(true);
        expect(new Headers(init.headers).has("Content-Type")).toBe(false);
        // Cloudflare exposes an empty network POST as a stream, unlike Bun's
        // in-process client request with no body.
        return server.fetch(new Request(String(target), { ...init, body: stream(chunks) }));
      },
    });
    expect(await exportCommands.retry(client, "project", "clip", "export")).toEqual({
      id: "export",
      bodyAbsent: true,
    });
  });
}

test("Content-Length zero cannot hide a nonempty body without a JSON media type", async () => {
  const response = await app().fetch(new Request("https://api.test/control", {
    method: "POST",
    headers: { "Content-Length": "0" },
    body: stream([new TextEncoder().encode("not JSON")]),
  }));
  expect(response.status).toBe(415);
  expect(await response.json()).toMatchObject({ error: "unsupported_media_type" });
});

test("a nonempty JSON body retains its exact bytes through the ingress chain", async () => {
  const raw = '{ "value" : "\\u0061", "number": 1 }\n';
  const bytes = new TextEncoder().encode(raw);
  const response = await app().fetch(new Request("https://api.test/control", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: stream([bytes.subarray(0, 8), new Uint8Array(0), bytes.subarray(8)]),
  }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ body: raw });
});

test("Content-Length zero cannot hide bytes above the control limit", async () => {
  const response = await app().fetch(new Request("https://api.test/control", {
    method: "POST",
    headers: { "Content-Length": "0", "Content-Type": "application/json" },
    body: stream([new Uint8Array(BODY_LIMIT_BYTES.control), new Uint8Array(1)]),
  }));
  expect(response.status).toBe(413);
  expect(await response.json()).toMatchObject({ error: "payload_too_large" });
});

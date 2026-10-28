import { expect, test } from "bun:test";
import { createRestClient } from "./index";

test("REST reads and commands use API-key transport and retain caller keys", async () => {
  const requests: Request[] = [];
  const credentials: Array<RequestCredentials | undefined> = [];
  const client = createRestClient({
    baseUrl: "https://api.example.com",
    apiKey: () => "nf_test_key",
    fetch: (async (input, init) => {
      credentials.push(init?.credentials);
      requests.push(new Request(input, init));
      return Response.json({});
    }) as typeof fetch,
  });
  await client.workspace.$get();
  await client.projects.$post({
    header: { "idempotency-key": "intent:1" },
    json: { url: "https://example.com/video.mp4" },
  });
  expect(requests.map((request) => request.url)).toEqual([
    "https://api.example.com/api/v1/workspace",
    "https://api.example.com/api/v1/projects",
  ]);
  for (const request of requests) {
    expect(request.headers.get("Authorization")).toBe("Bearer nf_test_key");
    expect(request.headers.has("X-Workspace-Id")).toBe(false);
  }
  expect(credentials).toEqual(["omit", "omit"]);
  expect(requests[1]!.headers.get("Idempotency-Key")).toBe("intent:1");
  expect(await requests[1]!.json()).toEqual({ url: "https://example.com/video.mp4" });
});

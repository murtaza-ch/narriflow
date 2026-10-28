import { describe, expect, test } from "bun:test";
import { createProjectsClient } from "./projects";

function recordingTransport() {
  const calls: Array<{ url: string; method: string }> = [];
  return {
    calls,
    transport: {
      baseUrl: "https://api.example.test",
      async fetch(input: string | URL, init?: RequestInit) {
        calls.push({ url: String(input), method: init?.method ?? "GET" });
        return Response.json({ ok: true });
      },
    },
  };
}

describe("domain RPC clients", () => {
  test("first-party routes are called under /api through the bound transport", async () => {
    const { calls, transport } = recordingTransport();
    const client = createProjectsClient(transport);
    await client.projects[":id"].$get({ param: { id: "p1" } });
    expect(calls).toEqual([{ url: "https://api.example.test/api/projects/p1", method: "GET" }]);
  });
});

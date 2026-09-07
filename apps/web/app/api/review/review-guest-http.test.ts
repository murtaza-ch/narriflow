import { describe, expect, test } from "bun:test";
import { GET, POST, PATCH, DELETE } from "./[token]/[[...review]]/route";

describe("guest review HTTP contract", () => {
  test("unknown paths return 404 before asking for a guest session", async () => {
    const response = await GET(new Request("http://localhost:3000/api/review/token/unknown"), {
      params: Promise.resolve({ token: "token", review: ["unknown"] }),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "review_route_not_found" });
  });
  test("mutations require the review page's origin", async () => {
    for (const handler of [POST, PATCH, DELETE]) {
      const response = await handler(new Request("http://localhost:3000/api/review/token/comments", {
        method: "POST", headers: { origin: "https://unrelated.example" }, body: "{}",
      }), { params: Promise.resolve({ token: "token", review: ["comments"] }) });
      expect(await response.json()).toMatchObject({ error: "review_origin_invalid" });
    }
  });

  test("known read routes require a signed guest session", async () => {
    const response = await GET(new Request("http://localhost:3000/api/review/token"), {
      params: Promise.resolve({ token: "token" }),
    });
    expect(await response.json()).toMatchObject({ error: "review_session_invalid" });
  });

  test("extra path segments cannot invoke a valid action", async () => {
    const response = await POST(new Request("http://localhost:3000/api/review/token/access/extra", {
      method: "POST", headers: { origin: "http://localhost:3000" }, body: "{}",
    }), { params: Promise.resolve({ token: "token", review: ["access", "extra"] }) });
    expect(response.status).toBe(404);
  });

  test("invalid JSON is rejected before guest authentication", async () => {
    const response = await POST(new Request("http://localhost:3000/api/review/token/access", {
      method: "POST", headers: { origin: "http://localhost:3000" }, body: "{bad json",
    }), { params: Promise.resolve({ token: "token", review: ["access"] }) });
    expect(await response.json()).toMatchObject({ error: "review_request_invalid" });
  });

  test("oversized streaming bodies are stopped as soon as the limit is crossed", async () => {
    let chunksRead = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksRead += 1;
        controller.enqueue(new Uint8Array(8192));
        if (chunksRead === 100) controller.close();
      },
      cancel() { cancelled = true; },
    });
    const response = await POST(new Request("http://localhost:3000/api/review/token/access", {
      method: "POST", headers: { origin: "http://localhost:3000" }, body: stream,
    }), { params: Promise.resolve({ token: "token", review: ["access"] }) });
    expect(await response.json()).toMatchObject({ error: "review_request_too_large" });
    expect(chunksRead).toBeLessThan(10);
    expect(cancelled).toBe(true);
  });
});

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { ApiEnv } from "./env";
import { apiRequestId, requestLogger } from "./logging";

describe("request logging", () => {
  test("logs the route pattern, never the URL, token or query", async () => {
    const lines: string[] = [];
    let tick = 100;
    const app = new Hono<ApiEnv>();
    app.use("*", apiRequestId());
    app.use("*", requestLogger({ write: (line) => lines.push(line), now: () => (tick += 5), skipRoutes: ["/api/health"] }));
    app.get("/api/review/:token/comments", (c) => c.json({}));
    app.get("/api/health", (c) => c.json({}));

    await app.request("/api/review/secret-signed-token/comments?code=oauth-code", {
      headers: { authorization: "Bearer eyJ.secret.jwt", "x-request-id": "req-1" },
    });
    await app.request("/api/health");

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] as string);
    expect(entry).toEqual({
      level: "info",
      message: "http_request",
      requestId: "req-1",
      method: "GET",
      route: "/api/review/:token/comments",
      status: 200,
      durationMs: 5,
    });
    expect(lines[0]).not.toContain("secret");
    expect(lines[0]).not.toContain("oauth-code");
  });
});

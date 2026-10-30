import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  apiSecurityHeaders,
  CORS_ALLOWED_HEADERS,
  CORS_EXPOSED_HEADERS,
  firstPartyCors,
} from "./cors";
import type { ApiEnv } from "./env";
import { apiErrorHandler } from "./errors";
import { apiRequestId } from "./logging";

const WEB = "https://narriflow-dev.vercel.app";

function app() {
  const instance = new Hono<ApiEnv>();
  instance.use("*", apiRequestId());
  instance.onError(apiErrorHandler);
  instance.use("*", apiSecurityHeaders({ production: true }));
  instance.use("/api/*", firstPartyCors({ allowedOrigins: [WEB, "http://localhost:3000"] }));
  instance.get("/api/data", (c) => c.json({ ok: true }));
  instance.get("/api/stream", (c) => {
    c.header("Cache-Control", "no-cache, no-transform");
    return c.text("data");
  });
  return instance;
}

describe("first-party CORS", () => {
  test("echoes an exact allowed origin, varies on Origin and never allows credentials", async () => {
    const response = await app().request("/api/data", { headers: { origin: WEB } });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(WEB);
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expect(response.headers.get("vary")).toContain("Origin");
    const exposed = response.headers.get("access-control-expose-headers") ?? "";
    for (const name of CORS_EXPOSED_HEADERS) expect(exposed).toContain(name);
  });

  test("answers a preflight with the exact methods and headers", async () => {
    const response = await app().request("/api/data", {
      method: "OPTIONS",
      headers: {
        origin: WEB,
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,x-workspace-id,idempotency-key",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toBe("GET,POST,PUT,PATCH,DELETE,OPTIONS");
    const allowed = response.headers.get("access-control-allow-headers") ?? "";
    for (const name of CORS_ALLOWED_HEADERS) expect(allowed.toLowerCase()).toContain(name.toLowerCase());
  });

  test.each([
    "https://evil.example",
    "https://narriflow-dev.vercel.app.evil.example",
    "https://preview-123.vercel.app",
    "http://narriflow-dev.vercel.app",
    "null",
  ])("refuses the disallowed origin %s instead of just omitting headers", async (origin) => {
    const response = await app().request("/api/data", { headers: { origin } });
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(await response.json()).toMatchObject({ error: "origin_not_allowed" });
  });

  test("refuses a disallowed preflight too", async () => {
    const response = await app().request("/api/data", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "GET" },
    });
    expect(response.status).toBe(403);
  });

  test("leaves server-to-server requests without an Origin alone", async () => {
    const response = await app().request("/api/data");
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("secure headers and caching", () => {
  test("defaults authenticated responses to private no-store with secure headers", async () => {
    const response = await app().request("/api/data");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("strict-transport-security")).toContain("max-age=");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  test("keeps a handler's own cache policy such as the SSE stream", async () => {
    const response = await app().request("/api/stream");
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
  });


});

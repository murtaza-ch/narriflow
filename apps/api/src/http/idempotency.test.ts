import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { ApiEnv } from "./env";
import { apiErrorHandler } from "./errors";
import {
  getIdempotencyKey,
  readCampaignRetryOf,
  reconcileIdempotencyKey,
  requireIdempotencyKey,
} from "./idempotency";
import { apiRequestId } from "./logging";

function app() {
  const instance = new Hono<ApiEnv>();
  instance.use("*", apiRequestId());
  instance.onError(apiErrorHandler);
  instance.post("/cmd", requireIdempotencyKey(), readCampaignRetryOf(), (c) =>
    c.json({ key: getIdempotencyKey(c), retryOf: c.get("campaignRetryOf") ?? null }),
  );
  return instance;
}

describe("idempotency helpers", () => {
  test("trims and exposes the key the browser minted for this intent", async () => {
    const response = await app().request("/cmd", {
      method: "POST",
      headers: { "Idempotency-Key": "  2f1c6b1e-6e2d-4a3f-8d6e-0c7d2c0f9a11  " },
    });
    expect(await response.json()).toEqual({ key: "2f1c6b1e-6e2d-4a3f-8d6e-0c7d2c0f9a11", retryOf: null });
  });

  test.each([undefined, "", "   ", "k".repeat(129)])("refuses the key %p", async (key) => {
    const response = await app().request("/cmd", {
      method: "POST",
      headers: key === undefined ? {} : { "Idempotency-Key": key },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "idempotency_key_required" });
  });

  test("accepts the 128 character upper bound", async () => {
    const response = await app().request("/cmd", {
      method: "POST",
      headers: { "Idempotency-Key": "k".repeat(128) },
    });
    expect(response.status).toBe(200);
  });

  test("validates the optional Campaign-Retry-Of identity", async () => {
    const good = await app().request("/cmd", {
      method: "POST",
      headers: { "Idempotency-Key": "a", "Campaign-Retry-Of": "2f1c6b1e-6e2d-4a3f-8d6e-0c7d2c0f9a11" },
    });
    expect((await good.json()).retryOf).toBe("2f1c6b1e-6e2d-4a3f-8d6e-0c7d2c0f9a11");
    const bad = await app().request("/cmd", {
      method: "POST",
      headers: { "Idempotency-Key": "a", "Campaign-Retry-Of": "not-a-uuid" },
    });
    expect(bad.status).toBe(400);
  });

  test("a header and an equivalent native body key must agree", () => {
    expect(reconcileIdempotencyKey("a", undefined)).toBe("a");
    expect(reconcileIdempotencyKey("a", "a")).toBe("a");
    expect(() => reconcileIdempotencyKey("a", "b")).toThrow(
      expect.objectContaining({ failure: expect.objectContaining({ code: "idempotency_key_mismatch" }) }),
    );
  });
});

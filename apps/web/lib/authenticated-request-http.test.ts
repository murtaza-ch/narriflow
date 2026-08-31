import { describe, expect, test } from "bun:test";
import {
  authenticatedRequestHttpFailure,
  normalizeAuthenticatedErrorResponse,
} from "./authenticated-request-http";

describe("authenticated request HTTP translation", () => {
  test("translates expected failures with request and retry metadata", () => {
    expect(
      authenticatedRequestHttpFailure({
        code: "rate_limited",
        category: "rate_limit",
        status: 429,
        message: "Wait before trying again.",
        requestId: "request-http-1",
        retryAfterSeconds: 7,
      }),
    ).toEqual({
      body: {
        error: "rate_limited",
        message: "Wait before trying again.",
        requestId: "request-http-1",
        retryAfterSeconds: 7,
      },
      status: 429,
      retryAfterSeconds: 7,
    });
  });

  test("allowlists 5xx bodies and hides every provider field", async () => {
    const issues = Array.from({ length: 12 }, (_, index) => ({
      path: ["field", index],
      code: "invalid_type",
    }));
    const response = await normalizeAuthenticatedErrorResponse(
      Response.json(
        {
          error: "provider_failed",
          message: "private provider body",
          issues,
          details: { providerToken: "secret" },
          stack: "private stack",
        },
        { status: 503 },
      ),
      "request-http-2",
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("x-request-id")).toBe("request-http-2");
    const body = await response.json();
    expect(body).toEqual({
      error: "internal_error",
      message: "Something went wrong. Try again or contact support.",
      requestId: "request-http-2",
    });
  });

  test("preserves marked safe domain failures at 5xx", async () => {
    const response = await normalizeAuthenticatedErrorResponse(
      Response.json(
        {
          error: "generated_media_not_configured",
          message: "Generated media is temporarily unavailable.",
          retryable: true,
        },
        {
          status: 503,
          headers: { "X-Narriflow-Error-Contract": "expected-v1" },
        },
      ),
      "request-http-domain-1",
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("x-narriflow-error-contract")).toBeNull();
    expect(await response.json()).toEqual({
      error: "generated_media_not_configured",
      message: "Generated media is temporarily unavailable.",
      retryable: true,
      requestId: "request-http-domain-1",
    });
  });

  test("does not change successful responses", async () => {
    const success = Response.json({ ok: true }, { status: 202 });
    expect(
      await normalizeAuthenticatedErrorResponse(success, "request-http-3"),
    ).toBe(success);
  });

  test("allowlists and bounds validation issue fields on 4xx responses", async () => {
    const response = await normalizeAuthenticatedErrorResponse(
      Response.json(
        {
          error: "invalid_input",
          issues: [
            {
              path: ["one", "two", "three", "four", "five", "six"],
              code: "x".repeat(100),
              message: "m".repeat(300),
              stack: "private",
            },
          ],
        },
        { status: 400 },
      ),
      "request-http-4",
    );
    const body = await response.json();
    expect(body.issues).toEqual([
      {
        path: ["one", "two", "three", "four", "five"],
        code: "x".repeat(80),
        message: "m".repeat(240),
      },
    ]);
  });
});

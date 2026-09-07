import { describe, expect, test } from "bun:test";
import { ExpectedDomainFailureError } from "@narriflow/services";
import { AuthenticatedRequestFailure } from "./authenticated-request-policy";
import {
  applyAuthenticatedErrorResponse,
  authenticatedRequestDomainFailure,
  authenticatedRequestHttpFailure,
  normalizeAuthenticatedErrorResponse,
} from "./authenticated-request-http";

describe("authenticated request HTTP translation", () => {
  test.each([
    ["invalid", "semantic_refusal", 400],
    ["unprocessable", "validation", 422],
    ["forbidden", "authorization", 403],
    ["payment_required", "payment_refusal", 402],
    ["missing", "missing", 404],
    ["conflict", "conflict", 409],
    ["rate_limited", "rate_limit", 429],
    ["unavailable", "unavailable", 503],
  ] as const)(
    "maps the %s domain failure kind through the authenticated request contract",
    (kind, category, status) => {
      const translated = authenticatedRequestDomainFailure(
        new ExpectedDomainFailureError({
          code: `example_${kind}`,
          kind,
          message: "Safe domain message.",
          details: { currentRevision: 4 },
          retryAfterSeconds: kind === "rate_limited" ? 3 : undefined,
        }),
      );

      expect(translated).toBeInstanceOf(AuthenticatedRequestFailure);
      expect(translated.failure).toEqual({
        code: `example_${kind}`,
        category,
        status,
        message: "Safe domain message.",
        details: { currentRevision: 4 },
        ...(kind === "rate_limited" ? { retryAfterSeconds: 3 } : {}),
      });
    },
  );

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

  test("does not change successful responses", async () => {
    const success = Response.json({ ok: true }, { status: 202 });
    expect(
      await normalizeAuthenticatedErrorResponse(success, "request-http-3"),
    ).toBe(success);
  });

  test("replaces the Hono response so literal route failures keep the request ID", async () => {
    const original = Response.json(
      {
        error: "invalid_transcript_export_format",
        message: "Invalid transcript export format",
      },
      { status: 400 },
    );
    const context = { res: original };

    const response = await applyAuthenticatedErrorResponse(
      context,
      "request-http-hono",
    );

    expect(context.res).not.toBe(response);
    expect(context.res).not.toBe(original);
    expect(await response.json()).toEqual({
      error: "invalid_transcript_export_format",
      message: "Invalid transcript export format",
      requestId: "request-http-hono",
    });
    expect(await context.res.json()).toEqual({
      error: "invalid_transcript_export_format",
      message: "Invalid transcript export format",
      requestId: "request-http-hono",
    });
  });

  test("normalizes non-JSON handler failures into the same allowlisted contract", async () => {
    const response = await normalizeAuthenticatedErrorResponse(
      new Response("private upstream failure", { status: 400 }),
      "request-http-non-json",
    );

    expect(await response.json()).toEqual({
      error: "request_failed",
      message: "The request could not be completed.",
      requestId: "request-http-non-json",
    });
  });

  test("sets Retry-After when a literal handler failure carries bounded retry guidance", async () => {
    const response = await normalizeAuthenticatedErrorResponse(
      Response.json(
        { error: "busy", message: "Try again soon", retryAfterSeconds: 2.1 },
        { status: 429 },
      ),
      "request-http-retry",
    );

    expect(response.headers.get("retry-after")).toBe("3");
    expect(await response.json()).toMatchObject({ retryAfterSeconds: 3 });
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

  test("serializes one allowlisted 4xx body shape", async () => {
    const response = await normalizeAuthenticatedErrorResponse(
      Response.json(
        {
          error: "editor_revision_conflict",
          message: "Refresh before saving again.",
          details: { currentRevision: 7 },
          currentRevision: 7,
          retryable: true,
          providerBody: "private",
        },
        { status: 409 },
      ),
      "request-http-5",
    );

    expect(await response.json()).toEqual({
      error: "editor_revision_conflict",
      message: "Refresh before saving again.",
      requestId: "request-http-5",
      details: { currentRevision: 7 },
    });
  });
});

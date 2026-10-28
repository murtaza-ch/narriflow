import { describe, expect, test } from "bun:test";
import { ExpectedDomainFailureError } from "@narriflow/services";
import { Hono } from "hono";
import { requestId } from "hono/request-id";
import type { ApiEnv } from "./env";
import {
  apiErrorHandler,
  apiNotFoundHandler,
  applyErrorResponse,
  errorEnvelope,
  errorEnvelopeMiddleware,
  normalizeErrorResponse,
  requestFailureFromDomain,
} from "./errors";
import { AuthenticatedRequestFailure } from "./request-policy";

describe("API error envelope", () => {
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
      const translated = requestFailureFromDomain(
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
      errorEnvelope({
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
    const response = await normalizeErrorResponse(
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
      await normalizeErrorResponse(success, "request-http-3"),
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

    const response = await applyErrorResponse(
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
    const response = await normalizeErrorResponse(
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
    const response = await normalizeErrorResponse(
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
    const response = await normalizeErrorResponse(
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
    const response = await normalizeErrorResponse(
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

function envelopeApp(register: (app: Hono<ApiEnv>) => void) {
  const app = new Hono<ApiEnv>();
  app.use("*", requestId({ headerName: "X-Request-ID" }) as never);
  app.use("*", errorEnvelopeMiddleware());
  app.onError(apiErrorHandler);
  app.notFound(apiNotFoundHandler);
  register(app);
  return app;
}

describe("API error handling", () => {
  test("answers unknown paths with a JSON 404 carrying the request ID", async () => {
    const response = await envelopeApp(() => {}).request("/api/nothing", {
      headers: { "X-Request-ID": "caller-supplied-1" },
    });
    expect(response.status).toBe(404);
    expect(response.headers.get("x-request-id")).toBe("caller-supplied-1");
    expect(await response.json()).toEqual({
      error: "not_found",
      message: "This resource was not found.",
      requestId: "caller-supplied-1",
    });
  });

  test("replaces an unsafe caller-supplied request ID", async () => {
    const response = await envelopeApp(() => {}).request("/missing", {
      headers: { "X-Request-ID": "bad id with spaces and \"quotes\"" },
    });
    const body = await response.json();
    expect(body.requestId).not.toContain(" ");
    expect(response.headers.get("x-request-id")).toBe(body.requestId);
  });

  test("normalizes malformed JSON, oversized bodies and unexpected exceptions", async () => {
    const { HTTPException } = await import("hono/http-exception");
    const app = envelopeApp((a) => {
      a.get("/malformed", () => {
        throw new HTTPException(400, { message: "Malformed JSON in request body" });
      });
      a.get("/large", () => {
        throw new HTTPException(413, { message: "Payload Too Large" });
      });
      a.get("/boom", () => {
        throw new Error("password=hunter2 postgres://user:pw@db");
      });
    });

    const malformed = await app.request("/malformed");
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: "invalid_json" });

    const large = await app.request("/large");
    expect(large.status).toBe(413);
    expect(await large.json()).toMatchObject({ error: "payload_too_large" });

    const boom = await app.request("/boom");
    expect(boom.status).toBe(500);
    const text = JSON.stringify(await boom.json());
    expect(text).toContain("internal_error");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("postgres");
  });

  test("keeps an expected 503 domain failure and its Retry-After instead of flattening it", async () => {
    const app = envelopeApp((a) => {
      a.get("/limited", () => {
        throw new ExpectedDomainFailureError({
          code: "mutations_unavailable",
          kind: "unavailable",
          message: "New mutations are paused.",
          retryAfterSeconds: 5,
        });
      });
    });
    const response = await app.request("/limited");
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(await response.json()).toMatchObject({
      error: "mutations_unavailable",
      retryAfterSeconds: 5,
    });
  });

  test("normalizes a literal handler failure through the envelope middleware", async () => {
    const app = envelopeApp((a) => {
      a.get("/literal", (c) =>
        c.json({ error: "literal_invalid", message: "Nope", secret: "x" }, 400),
      );
    });
    const response = await app.request("/literal");
    const body = await response.json();
    expect(body).toEqual({
      error: "literal_invalid",
      message: "Nope",
      requestId: response.headers.get("x-request-id"),
    });
  });
});

import { describe, expect, test } from "bun:test";
import {
  ApiError,
  apiErrorFromResponse,
  CLIENT_ERROR_CODES,
  describeApiFailure,
  fieldErrors,
  parseRetryAfter,
} from "./error";
import { errorResponse } from "./test-helpers";

describe("apiErrorFromResponse", () => {
  test("maps the envelope's error field to code and keeps safe facts", async () => {
    const error = await apiErrorFromResponse(
      errorResponse(409, "active_workspace_mismatch", {
        details: { projectWorkspaceId: "w1" },
        issues: [{ path: ["a", 0], code: "too_small", message: "Too short" }],
        retryAfterSeconds: 7,
      }),
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe("active_workspace_mismatch");
    expect(error.status).toBe(409);
    expect(error.requestId).toBe("req_1");
    expect(error.message).toBe("message for active_workspace_mismatch");
    expect(error.details).toEqual({ projectWorkspaceId: "w1" });
    expect(error.issues).toEqual([{ path: ["a", 0], code: "too_small", message: "Too short" }]);
    expect(error.retryAfterSeconds).toBe(7);
  });

  test("falls back to the Retry-After header and the X-Request-ID header", async () => {
    const response = new Response(JSON.stringify({ error: "rate_limited", message: "slow" }), {
      status: 429,
      headers: { "Retry-After": "12", "X-Request-ID": "req_hdr" },
    });
    const error = await apiErrorFromResponse(response);
    expect(error.retryAfterSeconds).toBe(12);
    expect(error.requestId).toBe("req_hdr");
  });

  test("a non-envelope body (proxy page, html) becomes unexpected_response without echoing it", async () => {
    const error = await apiErrorFromResponse(
      new Response("<html>Bad gateway secret-ish</html>", { status: 502 }),
    );
    expect(error.code).toBe(CLIENT_ERROR_CODES.unexpectedResponse);
    expect(error.status).toBe(502);
    expect(error.message).not.toContain("secret");
  });

  test("ignores malformed issues and non-object details", async () => {
    const error = await apiErrorFromResponse(
      errorResponse(400, "invalid_input", {
        issues: [{ nope: true }, "x", { path: ["f"], message: "Bad" }],
        details: "not-an-object",
      }),
    );
    expect(error.issues).toEqual([{ path: ["f"], code: "invalid", message: "Bad" }]);
    expect(error.details).toBeUndefined();
  });

  test("bounds issues to eight", async () => {
    const issues = Array.from({ length: 20 }, (_, i) => ({ path: [i], code: "x", message: `m${i}` }));
    const error = await apiErrorFromResponse(errorResponse(400, "invalid_input", { issues }));
    expect(error.issues).toHaveLength(8);
  });
});

describe("parseRetryAfter", () => {
  test("accepts seconds and HTTP dates, rejects junk and the past", () => {
    expect(parseRetryAfter("5")).toBe(5);
    expect(parseRetryAfter("0")).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:10 GMT", now)).toBe(10);
    expect(parseRetryAfter("Wed, 31 Dec 2025 23:59:00 GMT", now)).toBeUndefined();
    expect(parseRetryAfter("99999999", now)).toBe(86_400);
  });
});

describe("describeApiFailure", () => {
  const kind = (status: number, code: string) =>
    describeApiFailure(new ApiError({ code, message: "m", status })).kind;

  test("branches on codes first, then status", () => {
    expect(kind(401, "authentication_required")).toBe("authenticate");
    expect(kind(409, "workspace_selection_changed")).toBe("reselect_workspace");
    expect(kind(409, "active_workspace_mismatch")).toBe("workspace_mismatch");
    expect(kind(403, "workspace_restricted")).toBe("workspace_restricted");
    expect(kind(403, "capability_denied")).toBe("forbidden");
    expect(kind(404, "project_not_found")).toBe("missing");
    expect(kind(402, "plan_required")).toBe("upgrade");
    expect(kind(409, "revision_conflict")).toBe("conflict");
    expect(kind(429, "rate_limited")).toBe("rate_limited");
    expect(kind(503, "mutations_unavailable")).toBe("retry_later");
    expect(kind(422, "something")).toBe("validation");
    expect(kind(0, CLIENT_ERROR_CODES.network)).toBe("offline");
    expect(kind(0, CLIENT_ERROR_CODES.scopeChanged)).toBe("superseded");
    expect(kind(500, "internal_error")).toBe("failed");
  });

  test("wraps non-ApiError values instead of swallowing them", () => {
    const failure = describeApiFailure(new Error("boom"));
    expect(failure.kind).toBe("failed");
    expect(failure.error.message).toBe("boom");
  });

  test("surfaces retryAfterSeconds", () => {
    const failure = describeApiFailure(
      new ApiError({ code: "rate_limited", message: "m", status: 429, retryAfterSeconds: 9 }),
    );
    expect(failure.retryAfterSeconds).toBe(9);
  });
});

describe("fieldErrors", () => {
  test("first message per dotted path", () => {
    const error = new ApiError({
      code: "invalid_input",
      message: "m",
      status: 400,
      issues: [
        { path: ["a", "b"], code: "x", message: "first" },
        { path: ["a", "b"], code: "y", message: "second" },
        { path: [], code: "z", message: "form" },
      ],
    });
    expect(fieldErrors(error)).toEqual({ "a.b": "first", "": "form" });
    expect(fieldErrors(new Error("x"))).toEqual({});
  });
});

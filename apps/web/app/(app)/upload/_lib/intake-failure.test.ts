import { describe, expect, test } from "bun:test";
import { ApiError } from "@narriflow/api-client";
import { failureFromApiError, intakeFailureMessage } from "./intake-failure";

function failure(code: string, status: number, extra: Partial<ConstructorParameters<typeof ApiError>[0]> = {}) {
  return new ApiError({ code, message: `server says ${code}`, status, ...extra });
}

describe("intake failures", () => {
  test("carries the recovery facts the upgrade helpers read", () => {
    const error = failure("credits_exhausted", 402, {
      requestId: "req-1",
      details: { tier: "free", spentCredits: 90 },
      retryAfterSeconds: 3,
      issues: [{ path: ["a", 0], code: "invalid", message: "bad" }],
    });
    expect(failureFromApiError(error)).toEqual({
      error: "credits_exhausted",
      code: "credits_exhausted",
      message: "server says credits_exhausted",
      requestId: "req-1",
      details: { tier: "free", spentCredits: 90 },
      issues: [{ path: ["a", 0], code: "invalid", message: "bad" }],
      retryAfterSeconds: 3,
    });
  });

  test("a usage refusal keeps the server's exact credits or length text", () => {
    expect(intakeFailureMessage(failure("upload_too_long", 422), "x")).toBe("server says upload_too_long");
    expect(intakeFailureMessage(failure("workspace_processing_capacity_reached", 429), "x")).toBe(
      "server says workspace_processing_capacity_reached",
    );
  });

  test("other failures use the shared recovery wording, never raw server text", () => {
    expect(intakeFailureMessage(failure("authentication_required", 401), "x")).toContain("Sign in again");
    expect(intakeFailureMessage(failure("unheard_of", 500, { requestId: "req-9" }), "Could not start.")).toBe(
      "Could not start. Support reference: req-9.",
    );
  });

  test("a non-API error keeps its own message, else the fallback", () => {
    expect(intakeFailureMessage(new Error("boom"), "x")).toBe("boom");
    expect(intakeFailureMessage("nope", "fallback")).toBe("fallback");
  });
});

import { describe, expect, test } from "bun:test";
import { ReviewServiceError } from "@narriflow/services";
import {
  assertReviewSameOrigin,
  MAX_REVIEW_BODY_BYTES,
  readRateLimitedReviewAccessRequest,
  readReviewJsonBody,
  reviewPublicFailureStatus,
} from "./review-public-http";

describe("public review HTTP boundary", () => {
  test("accepts only an exact same-origin mutation", () => {
    expect(() =>
      assertReviewSameOrigin(
        new Request("https://review.example/api/review/token/comments", {
          headers: { origin: "https://review.example" },
        }),
      ),
    ).not.toThrow();
    for (const origin of [
      "https://attacker.example",
      "https://review.example.attacker.test",
      "null",
    ]) {
      expect(() =>
        assertReviewSameOrigin(
          new Request("https://review.example/api/review/token/comments", {
            headers: { origin },
          }),
        ),
      ).toThrow(ReviewServiceError);
    }
  });

  test("bounds and parses JSON before it reaches the review service", async () => {
    await expect(
      readReviewJsonBody(
        new Request("https://review.example/api/review/token/comments", {
          method: "POST",
          body: JSON.stringify({ body: "Clear note" }),
        }),
      ),
    ).resolves.toEqual({ body: "Clear note" });
    await expect(
      readReviewJsonBody(
        new Request("https://review.example/api/review/token/comments", {
          method: "POST",
          body: "x".repeat(MAX_REVIEW_BODY_BYTES + 1),
        }),
      ),
    ).rejects.toMatchObject({ code: "review_request_too_large" });
    await expect(
      readReviewJsonBody(
        new Request("https://review.example/api/review/token/comments", {
          method: "POST",
          body: "not-json",
        }),
      ),
    ).rejects.toMatchObject({ code: "review_request_invalid" });
  });

  test("admits the token-independent source before consuming an access body", async () => {
    const request = new Request(
      "https://review.example/api/review/random-token/access",
      {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.40, 10.0.0.2" },
        body: JSON.stringify({ identity: "Client" }),
      },
    );
    let admittedSource: string | null = null;

    await expect(
      readRateLimitedReviewAccessRequest(request, async (source) => {
        admittedSource = source;
        throw new ReviewServiceError(
          "review_access_rate_limited",
          "Too many review access attempts",
        );
      }),
    ).rejects.toMatchObject({ code: "review_access_rate_limited" });

    expect(admittedSource).toBe("203.0.113.40");
    expect(request.bodyUsed).toBe(false);
  });

  test("projects stable denial statuses without exposing service details", () => {
    expect(reviewPublicFailureStatus("review_media_not_found")).toBe(404);
    expect(reviewPublicFailureStatus("review_access_rate_limited")).toBe(429);
    expect(reviewPublicFailureStatus("review_round_closed")).toBe(409);
    expect(reviewPublicFailureStatus("review_download_forbidden")).toBe(403);
    expect(
      reviewPublicFailureStatus("review_access_temporarily_unavailable"),
    ).toBe(503);
    expect(reviewPublicFailureStatus("review_session_invalid")).toBe(400);
  });
});

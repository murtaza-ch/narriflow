import { ReviewServiceError } from "@narriflow/services";

export const MAX_REVIEW_BODY_BYTES = 32 * 1024;

export function assertReviewSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) {
    throw new ReviewServiceError(
      "review_origin_invalid",
      "Review request origin is invalid",
    );
  }
}

export async function readReviewJsonBody(request: Request) {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_REVIEW_BODY_BYTES) {
    throw new ReviewServiceError(
      "review_request_too_large",
      "Review request is too large",
    );
  }
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_REVIEW_BODY_BYTES) {
    throw new ReviewServiceError(
      "review_request_too_large",
      "Review request is too large",
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ReviewServiceError(
      "review_request_invalid",
      "Review request body is invalid",
    );
  }
}

export function reviewPublicFailureStatus(code: string) {
  if (code === "review_access_temporarily_unavailable") return 503;
  if (code.endsWith("not_found")) return 404;
  if (code.includes("rate_limited")) return 429;
  if (code.includes("closed")) return 409;
  if (code.includes("forbidden")) return 403;
  return 400;
}

import { z } from "zod";
import type { MiddlewareHandler } from "hono";
import type { ApiEnv } from "./env";
import { AuthenticatedRequestFailure } from "./request-policy";

export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";
export const CAMPAIGN_RETRY_HEADER = "Campaign-Retry-Of";

/** The existing internal bounds: one to 128 characters after trimming. */
export const idempotencyKeySchema = z.string().trim().min(1).max(128);

function keyRequired(): AuthenticatedRequestFailure {
  return new AuthenticatedRequestFailure({
    code: "idempotency_key_required",
    category: "validation",
    status: 400,
    message: "Send an Idempotency-Key header of 1 to 128 characters.",
  });
}

/**
 * Retryable creates and commands require the browser's per-intent key before
 * they can be accepted. Register after `admit(...)` and before the validator.
 */
export function requireIdempotencyKey(): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const parsed = idempotencyKeySchema.safeParse(
      c.req.header(IDEMPOTENCY_KEY_HEADER),
    );
    if (!parsed.success) throw keyRequired();
    c.set("idempotencyKey", parsed.data);
    await next();
  };
}

/** Optional explicit retry-of identity for campaign commands. */
export function readCampaignRetryOf(): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const header = c.req.header(CAMPAIGN_RETRY_HEADER);
    if (header !== undefined) {
      const parsed = z.string().trim().uuid().safeParse(header);
      if (!parsed.success) {
        throw new AuthenticatedRequestFailure({
          code: "invalid_input",
          category: "validation",
          status: 400,
          message: "Campaign-Retry-Of must be a command identifier.",
        });
      }
      c.set("campaignRetryOf", parsed.data);
    }
    await next();
  };
}

/** The validated header key. Throws when `requireIdempotencyKey` was not registered. */
export function getIdempotencyKey(c: {
  get(key: "idempotencyKey"): string | undefined;
}): string {
  const key = c.get("idempotencyKey");
  if (!key) throw new Error("requireIdempotencyKey did not run for this route");
  return key;
}

/**
 * A route that accepts both the header and an equivalent native body field
 * (Upload Session client key, commit token, checkout key) must see them agree;
 * it never silently prefers one.
 */
export function reconcileIdempotencyKey(
  headerKey: string,
  nativeKey: string | undefined,
): string {
  if (nativeKey !== undefined && nativeKey !== headerKey) {
    throw new AuthenticatedRequestFailure({
      code: "idempotency_key_mismatch",
      category: "validation",
      status: 400,
      message: "The Idempotency-Key header and the request body disagree.",
    });
  }
  return headerKey;
}

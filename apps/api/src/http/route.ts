import { zValidator } from "@hono/zod-validator";
import type { Context, MiddlewareHandler, ValidationTargets } from "hono";
import type { ZodIssue, ZodType } from "zod";
import type { ApiEnv } from "./env";
import { failureResponse, markEnvelope, requestIdOf } from "./errors";
import { boundedIssue } from "./request-policy";

export { getActor, getProject, getSignedInActor } from "./admission";

/**
 * The shared validator failure hook: every route reports invalid input as the
 * same 400 `invalid_input` envelope with bounded issues, so one schema defines
 * both the client's input type and the server's refusal.
 */
export function validationFailureHook(
  result: { success: boolean; error?: { issues: readonly ZodIssue[] } },
  context: Context,
): Response | undefined {
  if (result.success || !result.error) return undefined;
  const c = context as Context<ApiEnv>;
  return markEnvelope(
    c,
    failureResponse({
      code: "invalid_input",
      category: "validation",
      status: 400,
      message: "Check the highlighted fields and try again.",
      requestId: requestIdOf(c),
      issues: result.error.issues.slice(0, 8).map(boundedIssue),
    }),
  );
}

/**
 * Register after `admit(...)`: `.post(path, admit(d), validate("json", schema), handler)`.
 * Admission runs first, so unauthenticated or unauthorized callers never learn
 * what the input schema accepts.
 */
export function validate<
  Target extends keyof ValidationTargets,
  Schema extends ZodType,
>(target: Target, schema: Schema) {
  return zValidator(target, schema, validationFailureHook);
}

/**
 * Ingress guard for JSON route classes: a request that carries a body must
 * declare `application/json`, otherwise it is a 415 in the common envelope
 * rather than a silently empty object.
 */
export function requireJsonContentType(): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const method = c.req.method;
    // Bun hands handlers a null body for bodiless requests, chunked or not.
    const hasBody = c.req.raw.body !== null;
    if (
      hasBody &&
      (method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE") &&
      !/^application\/([a-z0-9.+-]+\+)?json\s*(;|$)/i.test(
        c.req.header("content-type") ?? "",
      )
    ) {
      return markEnvelope(
        c,
        failureResponse({
          code: "unsupported_media_type",
          category: "validation",
          status: 415,
          message: "Send the request body as application/json.",
          requestId: requestIdOf(c),
        }),
      );
    }
    await next();
  };
}

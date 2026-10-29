import type { clipExportService, reviewerOptOut, reviewsCommands, reviewService } from "@narriflow/services";
import { clipExportSnapshotSchema, resolvePricingTier, workspaceAllowsCapability } from "@narriflow/validators";
import {
  createReviewRoundSchema, internalReviewCommentSchema, inviteReviewersSchema, retryReviewNotificationSchema,
  reviewGuestAccessSchema, reviewCommentSchema, reviewCommentEditSchema, reviewDecisionSchema,
  reviewTokenParamsSchema, reviewCommentParamsSchema, reviewMediaParamsSchema, reviewOptOutSchema,
} from "@narriflow/validators/api/reviews";
import type { Context, MiddlewareHandler } from "hono";
import { bodyClass } from "../../body-limits";
import { createRouteApp, getActor, getRecordedRateLimit } from "../../http/admission";
import type { ApiEnv } from "../../http/env";
import { getIdempotencyKey, requireIdempotencyKey } from "../../http/idempotency";
import { enforceRecordedRateLimit, ipRateLimit } from "../../http/limits";
import type { RateLimitCheck } from "../../http/request-policy";
import { AuthenticatedRequestFailure } from "../../http/request-policy";
import { validate } from "../../http/route";
import { uuidParams } from "../platform/params";
import { reviewsAdmission as access } from "./admission";
import { guestCredential, guestRoom, guestSession, reviewOrigin } from "./guest";

export interface ReviewsRouteDeps {
  reviewService: typeof reviewService;
  commands: typeof reviewsCommands;
  optOut: typeof reviewerOptOut;
  sharedExport: typeof clipExportService.getShared;
  sessionSecret(): string;
  allowedOrigins: readonly string[];
  clientIp(c: Context<ApiEnv>): string;
  rateLimit(input: { key: string; limit: number; windowSeconds: number }): Promise<RateLimitCheck>;
}
function missing(code: string, message: string): never {
  throw new AuthenticatedRequestFailure({ code, message, category: "missing", status: 404 });
}
function scope(c: Context<ApiEnv>, projectId: string) {
  const actor = getActor(c);
  return { actorUserId: actor.actorUserId, workspaceId: actor.workspaceId, projectId, pricingTier: resolvePricingTier(actor.pricingTier) };
}
function mutation(c: Context<ApiEnv>) {
  return { clientIdempotencyKey: getIdempotencyKey(c), beforeAccept: async () => enforceRecordedRateLimit(getRecordedRateLimit(c)) };
}
function replay(c: Context<ApiEnv>, accepted: { replayed: boolean }) {
  if (accepted.replayed) c.header("Idempotent-Replayed", "true");
}
/** R2 grants carry their signing instant and lifetime; share refresh uses the earliest actual expiry. */
function storageGrantExpiry(url: string): number {
  const query = new URL(url).searchParams;
  const signedAt = query.get("X-Amz-Date")?.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z");
  const seconds = Number(query.get("X-Amz-Expires"));
  const expiry = Date.parse(signedAt ?? "") + seconds * 1000;
  if (!Number.isFinite(expiry) || !Number.isSafeInteger(seconds) || seconds <= 0) throw new Error("Storage grant expiry is unavailable");
  return expiry;
}
export function createReviewsRoutes(deps: ReviewsRouteDeps) {
  const service = deps.reviewService;
  const commands = deps.commands;
  const origin = reviewOrigin(deps.allowedOrigins);
  const guest = guestCredential(deps.sessionSecret, (session, secret) => service.authorizeSession(session, secret));
  const readLimit = (name: string, limit: number): MiddlewareHandler<ApiEnv> => async (c, next) => {
    const check = await deps.rateLimit({ key: `review-${name}:${deps.clientIp(c)}`, limit, windowSeconds: 60 });
    if (!check.allowed) throw new AuthenticatedRequestFailure({ code: "rate_limited", category: "rate_limit", status: 429, message: "Too many requests. Wait before trying again.", retryAfterSeconds: Math.max(1, Math.ceil(check.retryAfterSeconds ?? 60)) });
    await next();
  };
  // A full round has 100 items x 4 variants. Media allows six full-round
  // fetches per minute behind one NAT; downloads allow two, independently.
  const roomLimit = readLimit("room", 120);
  const mediaLimit = readLimit("media", 2400);
  const downloadLimit = readLimit("download", 800);
  const shareLimit = readLimit("share", 120);
  const optOutLimit = readLimit("opt-out", 60);
  const exchangeLimit = ipRateLimit({ prefix: "review-exchange", tier: "guestExchange", clientIp: deps.clientIp, rateLimit: deps.rateLimit });
  const exchange = async (c: Context<ApiEnv>, token: string, input: unknown) => {
    const sessionToken = await service.authenticate(token, input, deps.clientIp(c), deps.sessionSecret());
    // Expiry is the signed claim, not a second wall-clock estimate.
    const { verifyReviewSession } = await import("@narriflow/services");
    return { sessionToken, expiresAt: new Date(verifyReviewSession(sessionToken, deps.sessionSecret()).exp * 1000).toISOString() };
  };
  return createRouteApp(access)
    .post("/projects/:id/review-rounds", uuidParams("id"), requireIdempotencyKey(), validate("json", createReviewRoundSchema), async (c) => {
      const result = await commands.createRound(scope(c, c.req.valid("param").id), c.req.valid("json"), mutation(c)); replay(c, result); return c.json(result.value, 201);
    })
    .get("/projects/:id/review-rounds", uuidParams("id"), async (c) => {
      const actor = getActor(c); const manage = workspaceAllowsCapability({ role: actor.role, status: actor.status }, "review.manage");
      return c.json(await service.internalRoom(actor.workspaceId, c.req.valid("param").id, manage ? "manage" : "view"), 200);
    })
    .post("/projects/:id/review-rounds/:roundId/invite", uuidParams("id", "roundId"), requireIdempotencyKey(), validate("json", inviteReviewersSchema), async (c) => {
      const { id, roundId } = c.req.valid("param"); const result = await commands.invite(scope(c, id), roundId, c.req.valid("json"), mutation(c)); replay(c, result); return c.json(result.value, 200);
    })
    .post("/projects/:id/review-rounds/:roundId/comments", uuidParams("id", "roundId"), requireIdempotencyKey(), validate("json", internalReviewCommentSchema), async (c) => {
      const { id, roundId } = c.req.valid("param"); const result = await commands.comment(scope(c, id), roundId, c.req.valid("json"), mutation(c)); replay(c, result); return c.json(result.value, 201);
    })
    .post("/projects/:id/review-rounds/:roundId/comments/:commentId/resolve", uuidParams("id", "roundId", "commentId"), requireIdempotencyKey(), async (c) => {
      const { id, roundId, commentId } = c.req.valid("param"); const result = await commands.resolve(scope(c, id), roundId, commentId, true, mutation(c)); replay(c, result); return c.json(result.value, 200);
    })
    .post("/projects/:id/review-rounds/:roundId/comments/:commentId/reopen", uuidParams("id", "roundId", "commentId"), requireIdempotencyKey(), async (c) => {
      const { id, roundId, commentId } = c.req.valid("param"); const result = await commands.resolve(scope(c, id), roundId, commentId, false, mutation(c)); replay(c, result); return c.json(result.value, 200);
    })
    .post("/projects/:id/review-rounds/:roundId/notifications/retry", uuidParams("id", "roundId"), requireIdempotencyKey(), validate("json", retryReviewNotificationSchema), async (c) => {
      const { id, roundId } = c.req.valid("param"); const result = await commands.retry(scope(c, id), roundId, c.req.valid("json").ledgerId, mutation(c)); replay(c, result);
      if (!result.value.retrying) missing("review_notification_not_found", "Failed notification was not found"); return c.json(result.value, 200);
    })
    .post("/projects/:id/review-rounds/:roundId/revoke", uuidParams("id", "roundId"), requireIdempotencyKey(), async (c) => {
      const { id, roundId } = c.req.valid("param"); const result = await commands.revoke(scope(c, id), roundId, mutation(c)); replay(c, result); return c.json(result.value, 200);
    })
    // Literal opt-out routes must precede /review/:token.
    .get("/review/opt-out", bodyClass("guest"), origin, optOutLimit, validate("query", reviewOptOutSchema), async (c) => {
      const result = await deps.optOut.preview(c.req.valid("query").token); if (!result) missing("review_opt_out_invalid", "This opt-out link is invalid"); return c.json(result, 200);
    })
    .post("/review/opt-out", bodyClass("guest"), origin, exchangeLimit, validate("json", reviewOptOutSchema), async (c) => {
      const result = await deps.optOut.confirm(c.req.valid("json").token); if (!result) missing("review_opt_out_invalid", "This opt-out link is invalid"); return c.json(result, 200);
    })
    .get("/share/:token", origin, shareLimit, validate("param", reviewTokenParamsSchema), async (c) => {
      const exported = await deps.sharedExport(c.req.valid("param").token);
      const variants = exported?.variants.filter((v) => v.status === "completed" && v.hasAsset && v.downloadUrl) ?? [];
      if (!exported || !variants.length) missing("share_not_found", "Shared export was not found");
      // Match the page's existing export DTO, with safe, completed variants only.
      const urls = variants.flatMap((variant) => [variant.previewUrl, variant.downloadUrl]).filter((url): url is string => !!url);
      const expiresAt = new Date(Math.min(...urls.map(storageGrantExpiry)) - 30_000).toISOString();
      return c.json({ ...clipExportSnapshotSchema.parse({ ...exported, variants }), expiresAt }, 200);
    })
    .post("/review/:token", bodyClass("guest"), origin, exchangeLimit, validate("param", reviewTokenParamsSchema), validate("json", reviewGuestAccessSchema), async (c) => c.json(await exchange(c, c.req.valid("param").token, c.req.valid("json")), 200))
    .post("/review/:token/access", bodyClass("guest"), origin, exchangeLimit, validate("param", reviewTokenParamsSchema), validate("json", reviewGuestAccessSchema), async (c) => c.json(await exchange(c, c.req.valid("param").token, c.req.valid("json")), 200))
    .get("/review/:token", bodyClass("guest"), origin, guest, roomLimit, validate("param", reviewTokenParamsSchema), async (c) => c.json(guestRoom(await service.readRound(guestSession(c, deps.sessionSecret()), deps.sessionSecret())), 200))
    .post("/review/:token/comments", bodyClass("guest"), origin, guest, requireIdempotencyKey(), validate("param", reviewTokenParamsSchema), validate("json", reviewCommentSchema), async (c) => {
      const result = await service.addComment(guestSession(c, deps.sessionSecret()), deps.sessionSecret(), c.req.valid("json"), { clientIdempotencyKey: getIdempotencyKey(c) }); replay(c, result); return c.json(result.value, 201);
    })
    .post("/review/:token/decision", bodyClass("guest"), origin, guest, requireIdempotencyKey(), validate("param", reviewTokenParamsSchema), validate("json", reviewDecisionSchema), async (c) => {
      const result = await service.decide(guestSession(c, deps.sessionSecret()), deps.sessionSecret(), c.req.valid("json"), { clientIdempotencyKey: getIdempotencyKey(c) }); replay(c, result); return c.json(result.value, 201);
    })
    .patch("/review/:token/comments/:commentId", bodyClass("guest"), origin, guest, validate("param", reviewCommentParamsSchema), validate("json", reviewCommentEditSchema), async (c) => {
      const updated = await service.editComment(guestSession(c, deps.sessionSecret()), deps.sessionSecret(), c.req.valid("param").commentId, c.req.valid("json"));
      return c.json(updated, 200);
    })
    .delete("/review/:token/comments/:commentId", bodyClass("guest"), origin, guest, validate("param", reviewCommentParamsSchema), async (c) => c.json(await service.deleteComment(guestSession(c, deps.sessionSecret()), deps.sessionSecret(), c.req.valid("param").commentId), 200))
    .get("/review/:token/media/:itemId/:variantId", bodyClass("guest"), origin, guest, mediaLimit, validate("param", reviewMediaParamsSchema), async (c) => {
      const { itemId, variantId } = c.req.valid("param"); return c.json(await service.resolveMedia(guestSession(c, deps.sessionSecret()), deps.sessionSecret(), itemId, variantId, "playback"), 200);
    })
    .get("/review/:token/download/:itemId/:variantId", bodyClass("guest"), origin, guest, downloadLimit, validate("param", reviewMediaParamsSchema), async (c) => {
      const { itemId, variantId } = c.req.valid("param"); return c.json(await service.resolveMedia(guestSession(c, deps.sessionSecret()), deps.sessionSecret(), itemId, variantId, "download"), 200);
    });
}
export type ReviewsRoutes = ReturnType<typeof createReviewsRoutes>;

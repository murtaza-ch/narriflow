import { deriveReviewRoundStatus, hashReviewAccessToken, reviewGuestCanEditComment, ReviewServiceError, verifyReviewSession } from "@narriflow/services";
import type { MiddlewareHandler } from "hono";
import type { ApiEnv } from "../../http/env";
import type { ReviewsRouteDeps } from "./routes";

/** Server callers may omit Origin; browser origins must match the configured W allowlist. */
export function reviewOrigin(allowedOrigins: readonly string[]): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const origin = c.req.header("Origin");
    c.header("X-Robots-Tag", "noindex");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Cache-Control", "private, no-store");
    if (origin !== undefined && !allowedOrigins.includes(origin)) throw new ReviewServiceError("review_origin_invalid", "Review request origin is invalid");
    await next();
  };
}

/** Cookie path separation is replaced by a signed full token digest plus round binding. */
export function guestSession(c: { req: { header(name: string): string | undefined; param(name: string): string | undefined } }, secret: string): string {
  const match = /^Bearer ([^\s,]+)$/i.exec(c.req.header("Authorization") ?? "");
  if (!match) throw new ReviewServiceError("review_session_invalid", "Review session is missing or invalid");
  const session = match[1]!;
  const claims = verifyReviewSession(session, secret);
  if (claims.grant !== hashReviewAccessToken(c.req.param("token") ?? "")) throw new ReviewServiceError("review_session_invalid", "Review session does not belong to this review link");
  return session;
}

export function guestCredential(secret: () => string, authorize: (session: string, secret: string) => Promise<void>): MiddlewareHandler<ApiEnv> {
  return async (c, next) => { await authorize(guestSession(c, secret()), secret()); await next(); };
}

export function guestRoom({ round, claims }: Awaited<ReturnType<ReviewsRouteDeps["reviewService"]["readRound"]>>) {
  return { round: {
    id: round.id, title: round.title, message: round.message, projectTitle: round.project.title, agencyName: round.workspace.name,
    revision: round.revision, status: deriveReviewRoundStatus(round), allowDownloads: round.allowDownloads, approvalRequired: round.approvalRequired,
    items: round.items.map((item) => {
      const selected = new Set(Array.isArray(item.selectedVariantIds) ? item.selectedVariantIds.filter((v): v is string => typeof v === "string") : []);
      return { id: item.id, clipTitle: item.clip.title, position: item.position, required: item.required, currentDecision: item.currentDecision,
        export: { id: item.export.id, editorRevision: item.export.editorRevision,
          variants: item.export.variants.filter((v) => selected.has(v.id) && v.status === "completed").map((v) => ({ id: v.id, aspectRatio: v.aspectRatio, durationSec: v.durationSec, status: v.status })) } };
    }),
    comments: round.comments.map((comment) => ({ id: comment.id, itemId: comment.itemId, parentId: comment.parentId, authorKind: comment.authorKind, authorName: comment.authorName, body: comment.body,
      timestampSec: comment.timestampSec, resolvedAt: comment.resolvedAt?.toISOString() ?? null, editedAt: comment.editedAt?.toISOString() ?? null, createdAt: comment.createdAt.toISOString(), canEdit: reviewGuestCanEditComment(claims, comment) })),
    reviewer: claims.identity,
  } };
}

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  hashReviewAccessToken,
  deriveReviewRoundStatus,
  reviewService,
  ReviewServiceError,
  ProgramWriteDisabledError,
  hashReviewSessionGrant,
} from "@narriflow/services";
import {
  assertReviewSameOrigin,
  readReviewJsonBody,
  reviewPublicFailureStatus,
} from "./review-public-http";

function sessionSecret() {
  const secret = process.env.REVIEW_SESSION_SECRET?.trim();
  if (!secret || secret.length < 32) throw new Error("REVIEW_SESSION_SECRET must contain at least 32 characters");
  return secret;
}

function cookieName(token: string) {
  return `nf_review_${hashReviewAccessToken(token).slice(0, 12)}`;
}

function failure(error: unknown) {
  if (error instanceof ProgramWriteDisabledError) return NextResponse.json({ error: error.code, message: error.message }, { status: 503 });
  const code = error instanceof ReviewServiceError ? error.code : "review_request_failed";
  const status = reviewPublicFailureStatus(code);
  return NextResponse.json({ error: code, message: error instanceof ReviewServiceError ? error.message : "Review request failed" }, { status });
}

type Context = { params: Promise<{ token: string; review?: string[] }> };

export async function POST(request: Request, context: Context) {
  try {
    assertReviewSameOrigin(request);
    const { token, review = [] } = await context.params;
    const action = review[0] ?? "access";
    if (action === "access") {
      const session = await reviewService.authenticate(
        token,
        await readReviewJsonBody(request),
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown",
        sessionSecret(),
      );
      const response = NextResponse.json({ ok: true });
      response.cookies.set(cookieName(token), session, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        maxAge: 12 * 60 * 60,
        path: `/api/review/${encodeURIComponent(token)}`,
      });
      return response;
    }
    const session = (await cookies()).get(cookieName(token))?.value;
    if (!session) throw new ReviewServiceError("review_session_invalid", "Review session is missing");
    if (action === "comments") return NextResponse.json(await reviewService.addComment(session, sessionSecret(), await readReviewJsonBody(request)), { status: 201 });
    if (action === "decision") return NextResponse.json(await reviewService.decide(session, sessionSecret(), await readReviewJsonBody(request)), { status: 201 });
    throw new ReviewServiceError("review_route_not_found", "Review route was not found");
  } catch (error) {
    return failure(error);
  }
}

export async function GET(_request: Request, context: Context) {
  try {
    const { token, review = [] } = await context.params;
    const session = (await cookies()).get(cookieName(token))?.value;
    if (!session) throw new ReviewServiceError("review_session_invalid", "Review session is missing");
    if (review[0] === "media" && review[1] && review[2]) {
      const url = await reviewService.resolveMedia(session, sessionSecret(), review[1], review[2], "playback");
      return NextResponse.redirect(url, { status: 307 });
    }
    if (review[0] === "download" && review[1] && review[2]) {
      const url = await reviewService.resolveMedia(session, sessionSecret(), review[1], review[2], "download");
      return NextResponse.redirect(url, { status: 307 });
    }
    if (review.length === 0) {
      const { round, claims } = await reviewService.readRound(session, sessionSecret());
      const status = deriveReviewRoundStatus(round);
      const grantHash = hashReviewSessionGrant(claims.subject);
      const commentsWithReplies = new Set(
        round.comments
          .map((comment) => comment.parentId)
          .filter((value): value is string => value !== null),
      );
      const now = Date.now();
      const requiredItems = round.items.filter((item) => item.required);
      return NextResponse.json({
        round: {
          id: round.id,
          title: round.title,
          message: round.message,
          revision: round.revision,
          status,
          responsesOpen:
            round.status === "open" &&
            round.revokedAt === null &&
            (!round.expiresAt || round.expiresAt > new Date()) &&
            round.decision !== "approved",
          sentAt: round.sentAt,
          expiresAt: round.expiresAt,
          projectTitle: round.project.title,
          workspaceName: round.project.workspace.name,
          allowDownloads: round.allowDownloads,
          approvalRequired: round.approvalRequired,
          campaignDecision: round.decision,
          progress: {
            approved: requiredItems.filter(
              (item) => item.currentDecision === "approved",
            ).length,
            changesRequested: requiredItems.filter(
              (item) => item.currentDecision === "changes_requested",
            ).length,
            required: requiredItems.length,
          },
          items: round.items.map((item) => {
            const selected = new Set(Array.isArray(item.selectedVariantIds) ? item.selectedVariantIds.filter((value): value is string => typeof value === "string") : []);
            return {
              id: item.id,
              position: item.position,
              required: item.required,
              currentDecision: item.currentDecision,
              title: item.clip.title || `Clip ${item.clip.index + 1}`,
              export: {
                id: item.export.id,
                editorRevision: item.export.editorRevision,
                variants: item.export.variants.filter((variant) => selected.has(variant.id)),
              },
            };
          }),
          comments: round.comments.map((comment) => ({
            id: comment.id,
            itemId: comment.itemId,
            parentId: comment.parentId,
            authorName: comment.authorName,
            body: comment.body,
            timestampSec: comment.timestampSec,
            authorKind: comment.authorKind,
            resolvedAt: comment.resolvedAt,
            editedAt: comment.editedAt,
            createdAt: comment.createdAt,
            isOwn: comment.authorGrantHash === grantHash,
            canEdit:
              status === "open" &&
              comment.authorGrantHash === grantHash &&
              now - comment.createdAt.getTime() <= 15 * 60_000,
            canDelete:
              status === "open" &&
              comment.authorGrantHash === grantHash &&
              !commentsWithReplies.has(comment.id) &&
              now - comment.createdAt.getTime() <= 15 * 60_000,
          })),
          reviewer: claims.identity,
        },
      });
    }
    throw new ReviewServiceError("review_route_not_found", "Review route was not found");
  } catch (error) {
    return failure(error);
  }
}

export async function PATCH(request: Request, context: Context) {
  try {
    assertReviewSameOrigin(request);
    const { token, review = [] } = await context.params;
    if (review[0] !== "comments" || !review[1]) throw new ReviewServiceError("review_route_not_found", "Review route was not found");
    const session = (await cookies()).get(cookieName(token))?.value;
    if (!session) throw new ReviewServiceError("review_session_invalid", "Review session is missing");
    return NextResponse.json(await reviewService.editComment(session, sessionSecret(), review[1], await readReviewJsonBody(request)));
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE(request: Request, context: Context) {
  try {
    assertReviewSameOrigin(request);
    const { token, review = [] } = await context.params;
    if (review[0] !== "comments" || !review[1]) throw new ReviewServiceError("review_route_not_found", "Review route was not found");
    const session = (await cookies()).get(cookieName(token))?.value;
    if (!session) throw new ReviewServiceError("review_session_invalid", "Review session is missing");
    return NextResponse.json(await reviewService.deleteComment(session, sessionSecret(), review[1]));
  } catch (error) {
    return failure(error);
  }
}

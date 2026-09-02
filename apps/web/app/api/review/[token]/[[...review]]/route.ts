import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  hashReviewAccessToken,
  deriveReviewRoundStatus,
  reviewGuestCanEditComment,
  reviewService,
  ReviewServiceError,
  ProgramWriteDisabledError,
} from "@narriflow/services";

const MAX_BODY_BYTES = 32 * 1024;

function sessionSecret() {
  const secret = process.env.REVIEW_SESSION_SECRET?.trim();
  if (!secret || secret.length < 32) throw new Error("REVIEW_SESSION_SECRET must contain at least 32 characters");
  return secret;
}

function cookieName(token: string) {
  return `nf_review_${hashReviewAccessToken(token).slice(0, 12)}`;
}

function assertSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) {
    throw new ReviewServiceError("review_origin_invalid", "Review request origin is invalid");
  }
}

async function body(request: Request) {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) throw new ReviewServiceError("review_request_too_large", "Review request is too large");
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
    throw new ReviewServiceError("review_request_too_large", "Review request is too large");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ReviewServiceError("review_request_invalid", "Review request body is invalid");
  }
}

function failure(error: unknown) {
  if (error instanceof ProgramWriteDisabledError) return NextResponse.json({ error: error.code, message: error.message }, { status: 503 });
  const code = error instanceof ReviewServiceError ? error.code : "review_request_failed";
  const status = code.endsWith("not_found") ? 404 : code.includes("rate_limited") ? 429 : code.includes("closed") ? 409 : code.includes("forbidden") ? 403 : 400;
  return NextResponse.json({ error: code, message: error instanceof ReviewServiceError ? error.message : "Review request failed" }, { status });
}

type Context = { params: Promise<{ token: string; review?: string[] }> };

export async function POST(request: Request, context: Context) {
  try {
    assertSameOrigin(request);
    const { token, review = [] } = await context.params;
    const action = review[0] ?? "access";
    if (action === "access") {
      const session = await reviewService.authenticate(
        token,
        await body(request),
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
    if (action === "comments") return NextResponse.json(await reviewService.addComment(session, sessionSecret(), await body(request)), { status: 201 });
    if (action === "decision") return NextResponse.json(await reviewService.decide(session, sessionSecret(), await body(request)), { status: 201 });
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
      return NextResponse.json({
        round: {
          id: round.id,
          title: round.title,
          message: round.message,
          projectTitle: round.project.title,
          agencyName: round.workspace.name,
          revision: round.revision,
          status: deriveReviewRoundStatus(round),
          allowDownloads: round.allowDownloads,
          approvalRequired: round.approvalRequired,
          items: round.items.map((item) => {
            const selected = new Set(Array.isArray(item.selectedVariantIds) ? item.selectedVariantIds.filter((value): value is string => typeof value === "string") : []);
            return {
              id: item.id,
              clipTitle: item.clip.title,
              position: item.position,
              required: item.required,
              currentDecision: item.currentDecision,
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
            authorKind: comment.authorKind,
            authorName: comment.authorName,
            body: comment.body,
            timestampSec: comment.timestampSec,
            resolvedAt: comment.resolvedAt,
            editedAt: comment.editedAt,
            createdAt: comment.createdAt,
            canEdit: reviewGuestCanEditComment(claims, comment),
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
    assertSameOrigin(request);
    const { token, review = [] } = await context.params;
    if (review[0] !== "comments" || !review[1]) throw new ReviewServiceError("review_route_not_found", "Review route was not found");
    const session = (await cookies()).get(cookieName(token))?.value;
    if (!session) throw new ReviewServiceError("review_session_invalid", "Review session is missing");
    return NextResponse.json(await reviewService.editComment(session, sessionSecret(), review[1], await body(request)));
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE(request: Request, context: Context) {
  try {
    assertSameOrigin(request);
    const { token, review = [] } = await context.params;
    if (review[0] !== "comments" || !review[1]) throw new ReviewServiceError("review_route_not_found", "Review route was not found");
    const session = (await cookies()).get(cookieName(token))?.value;
    if (!session) throw new ReviewServiceError("review_session_invalid", "Review session is missing");
    return NextResponse.json(await reviewService.deleteComment(session, sessionSecret(), review[1]));
  } catch (error) {
    return failure(error);
  }
}

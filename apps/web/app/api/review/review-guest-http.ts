import { NextRequest, NextResponse } from "next/server";
import {
  hashReviewAccessToken,
  deriveReviewRoundStatus,
  reviewGuestCanEditComment,
  reviewService,
  type ExpectedDomainFailureKind,
  ReviewServiceError,
} from "@narriflow/services";

// Independent of Clerk browser sessions. Every route uses a signed guest cookie;
// access exchanges the review token and guest credentials for that cookie.
export const guestReviewRoutes = [
  { method: "POST", path: "", session: false },
  { method: "POST", path: "access", session: false },
  { method: "GET", path: "", session: true },
  { method: "POST", path: "comments", session: true },
  { method: "POST", path: "decision", session: true },
  { method: "PATCH", path: "comments/:commentId", session: true },
  { method: "DELETE", path: "comments/:commentId", session: true },
  { method: "GET", path: "media/:itemId/:variantId", session: true },
  { method: "GET", path: "download/:itemId/:variantId", session: true },
] as const;

function assertGuestRoute(method: string, segments: string[]) {
  const matches = guestReviewRoutes.some((route) => {
    const parts = route.path ? route.path.split("/") : [];
    return route.method === method && parts.length === segments.length &&
      parts.every((part, index) => part.startsWith(":") ? Boolean(segments[index]) : part === segments[index]);
  });
  if (!matches) throw new ReviewServiceError("review_route_not_found", "Review route was not found");
}

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
  const reader = request.body?.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  if (reader) {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_BODY_BYTES) {
          await reader.cancel().catch(() => {});
          throw new ReviewServiceError("review_request_too_large", "Review request is too large");
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      reader.releaseLock();
    }
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ReviewServiceError("review_request_invalid", "Review request body is invalid");
  }
}

const failureStatus = {
  invalid: 400, unprocessable: 422, forbidden: 403, payment_required: 402,
  missing: 404, conflict: 409, rate_limited: 429, unavailable: 503,
} satisfies Record<ExpectedDomainFailureKind, number>;

function failure(error: unknown) {
  const code = error instanceof ReviewServiceError ? error.code : "review_request_failed";
  const status = error instanceof ReviewServiceError ? failureStatus[error.kind] : 500;
  if (!(error instanceof ReviewServiceError)) {
    console.warn(JSON.stringify({ level: "error", message: "review_request_failed" }));
  }
  return NextResponse.json({ error: code, message: error instanceof ReviewServiceError ? error.message : "Review request failed" }, { status });
}

type Context = { params: Promise<{ token: string; review?: string[] }> };

export async function POST(request: Request, context: Context) {
  try {
    assertSameOrigin(request);
    const { token, review = [] } = await context.params;
    assertGuestRoute("POST", review);
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
    const session = new NextRequest(request).cookies.get(cookieName(token))?.value;
    if (!session) throw new ReviewServiceError("review_session_invalid", "Review session is missing");
    if (action === "comments") return NextResponse.json(await reviewService.addComment(session, sessionSecret(), await body(request)), { status: 201 });
    if (action === "decision") return NextResponse.json(await reviewService.decide(session, sessionSecret(), await body(request)), { status: 201 });
    throw new ReviewServiceError("review_route_not_found", "Review route was not found");
  } catch (error) {
    return failure(error);
  }
}

export async function GET(request: Request, context: Context) {
  try {
    const { token, review = [] } = await context.params;
    assertGuestRoute("GET", review);
    const session = new NextRequest(request).cookies.get(cookieName(token))?.value;
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
    assertGuestRoute("PATCH", review);
    if (review[0] !== "comments" || !review[1]) throw new ReviewServiceError("review_route_not_found", "Review route was not found");
    const session = new NextRequest(request).cookies.get(cookieName(token))?.value;
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
    assertGuestRoute("DELETE", review);
    if (review[0] !== "comments" || !review[1]) throw new ReviewServiceError("review_route_not_found", "Review route was not found");
    const session = new NextRequest(request).cookies.get(cookieName(token))?.value;
    if (!session) throw new ReviewServiceError("review_session_invalid", "Review session is missing");
    return NextResponse.json(await reviewService.deleteComment(session, sessionSecret(), review[1]));
  } catch (error) {
    return failure(error);
  }
}

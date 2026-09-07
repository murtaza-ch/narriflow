import { type NextRequest, NextResponse } from "next/server";
import { resolvePostAuthRedirect } from "@/lib/post-auth-redirect";

export function GET(request: NextRequest) {
  const target = resolvePostAuthRedirect(
    request.nextUrl.searchParams.get("redirect_url"),
    request.nextUrl.origin,
    process.env.CLERK_OAUTH_ISSUER,
    process.env.CLERK_OAUTH_CONSENT_ORIGIN,
  );
  return NextResponse.redirect(target);
}

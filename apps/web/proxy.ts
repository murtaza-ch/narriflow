import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { type NextFetchEvent, type NextRequest, NextResponse } from "next/server";
import { authContinuationHref, authEntryHref, isAuthMode } from "./lib/auth-entry";

const isProtectedRoute = createRouteMatcher([
  "/home(.*)",
  "/projects(.*)",
  "/exports(.*)",
  "/calendar(.*)",
  "/performance(.*)",
  "/autopilot(.*)",
  "/brand-kit(.*)",
  "/workspaces(.*)",
  "/settings(.*)",
  "/upload(.*)",
  "/recipes(.*)",
  "/search(.*)",
  "/integrations(.*)",
  "/help(.*)",
  "/whats-new(.*)",
  "/auth/continue",
]);

export const clerkProxy = clerkMiddleware(async (auth, req) => {
  // UI-only page protection: unsigned navigations go to the sign-in modal.
  // The API on its own origin admits every data request with a session Bearer
  // token, so nothing here decides access to data.
  const { userId } = await auth();

  if (isProtectedRoute(req)) {
    const destination = req.nextUrl.pathname === "/auth/continue"
      ? req.nextUrl.searchParams.get("redirect_url") ?? "/home"
      : req.url;
    await auth.protect({ unauthenticatedUrl: new URL(authEntryHref("sign-in", destination), req.url).href });
  }

  if (req.nextUrl.pathname === "/" && isAuthMode(req.nextUrl.searchParams.get("auth")) && userId) {
    return NextResponse.redirect(new URL(authContinuationHref(req.nextUrl.searchParams.get("redirect_url")), req.url));
  }

  return NextResponse.next();
});

/** Rewrites forward request headers, and Clerk's session cookie must not reach PostHog. */
export default function proxy(req: NextRequest, event: NextFetchEvent) {
  if (!req.nextUrl.pathname.startsWith("/ingest/")) return clerkProxy(req, event);
  const headers = new Headers(req.headers);
  headers.delete("cookie");
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: [
    "/ingest/:path*",
    "/((?!_next|ingest/|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
  ],
};

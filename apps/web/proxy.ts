import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { authContinuationHref, authEntryHref, isAuthMode } from "./lib/auth-entry";

const isProtectedRoute = createRouteMatcher([
  "/home(.*)",
  "/projects(.*)",
  "/exports(.*)",
  "/calendar(.*)",
  "/autopilot(.*)",
  "/brand-kit(.*)",
  "/workspaces(.*)",
  "/settings(.*)",
  "/upload(.*)",
  "/auth/continue",
  "/api/projects(.*)",
  "/api/upload-sessions(.*)",
  "/api/ingest(.*)",
  "/api/stream(.*)",
  "/api/workspace(.*)",
  "/api/billing(.*)",
  "/api/autopilot(.*)",
  "/api/social(.*)",
  "/api/brand-templates(.*)",
  "/api/audio-assets(.*)",
  "/api/brand-profiles(.*)",
  "/api/brand-fonts(.*)",
  "/api/visual-assets(.*)",
  "/api/generated-media(.*)",
]);

const isPublicInfrastructureRoute = createRouteMatcher([
  "/api/health",
  "/mcp(.*)",
  "/.well-known/oauth-protected-resource(.*)",
  "/.well-known/oauth-authorization-server(.*)",
]);

export default clerkMiddleware(async (auth, req) => {
  // MCP verifies its own OAuth/API-key bearer token. Its discovery documents
  // and the health check are public infrastructure endpoints, so none should
  // wait on or depend on Clerk's browser-session middleware.
  if (isPublicInfrastructureRoute(req)) return NextResponse.next();

  const { userId } = await auth();

  if (isProtectedRoute(req)) {
    if (req.nextUrl.pathname.startsWith("/api/")) {
      // Clerk's page detection can classify API fetches as page requests in
      // Next's server context. Keep the API response independent of that heuristic.
      if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      await auth.protect();
    } else {
      const destination = req.nextUrl.pathname === "/auth/continue"
        ? req.nextUrl.searchParams.get("redirect_url") ?? "/home"
        : req.url;
      await auth.protect({ unauthenticatedUrl: new URL(authEntryHref("sign-in", destination), req.url).href });
    }
  }

  if (req.nextUrl.pathname === "/" && isAuthMode(req.nextUrl.searchParams.get("auth")) && userId) {
    return NextResponse.redirect(new URL(authContinuationHref(req.nextUrl.searchParams.get("redirect_url")), req.url));
  }

  return NextResponse.next();
});

export const config = {
  matcher: [
    "/((?!_next|mcp(?:/|$)|\\.well-known/oauth-(?:protected-resource|authorization-server)(?:/|$)|api/health(?:/|$)|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
  ],
};

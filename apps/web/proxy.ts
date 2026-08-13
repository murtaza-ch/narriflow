import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

const isProtectedRoute = createRouteMatcher([
  "/dashboard(.*)",
  "/home(.*)",
  "/projects(.*)",
  "/exports(.*)",
  "/calendar(.*)",
  "/autopilot(.*)",
  "/brand-kit(.*)",
  "/workspaces(.*)",
  "/settings(.*)",
  "/upload(.*)",
  "/onboarding(.*)",
  "/api/projects(.*)",
  "/api/uploads(.*)",
  "/api/ingest(.*)",
  "/api/stream(.*)",
  "/api/workspace(.*)",
  "/api/billing(.*)",
  "/api/autopilot(.*)",
  "/api/social(.*)",
  "/api/brand-templates(.*)",
  "/api/audio-assets(.*)",
]);

const isAuthRoute = createRouteMatcher(["/sign-in(.*)", "/sign-up(.*)", "/forgot-password(.*)"]);
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
    await auth.protect();
  }

  if (isAuthRoute(req) && userId) {
    const redirectUrl = req.nextUrl.searchParams.get("redirect_url");
    if (redirectUrl) {
      const continueUrl = new URL("/auth/continue", req.url);
      continueUrl.searchParams.set("redirect_url", redirectUrl);
      return NextResponse.redirect(continueUrl);
    }
    return NextResponse.redirect(new URL("/onboarding", req.url));
  }

  return NextResponse.next();
});

export const config = {
  matcher: [
    "/((?!_next|mcp(?:/|$)|\\.well-known/oauth-(?:protected-resource|authorization-server)(?:/|$)|api/health(?:/|$)|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
  ],
};

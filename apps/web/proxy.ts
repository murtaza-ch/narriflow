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

export default clerkMiddleware(async (auth, req) => {
  const { userId } = await auth();

  if (isProtectedRoute(req)) {
    await auth.protect();
  }

  if (isAuthRoute(req) && userId) {
    return NextResponse.redirect(new URL("/onboarding", req.url));
  }

  return NextResponse.next();
});

export const config = {
  matcher: ["/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)", "/(api|trpc)(.*)"],
};

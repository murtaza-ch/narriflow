import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { admitSignedInPage } from "@/lib/authenticated-request-page";
import { resolvePostAuthRedirect } from "@/lib/post-auth-redirect";
import { ClerkOAuthContinuation } from "./clerk-oauth-continuation";

export default async function AuthenticationContinuationPage({ searchParams }: {
  searchParams: Promise<{ redirect_url?: string | string[] }>;
}) {
  const params = await searchParams;
  const destination = typeof params.redirect_url === "string" ? params.redirect_url : null;
  // Identity admission synchronizes Clerk and provisions the personal workspace.
  // An unrelated active workspace's billing state must not block this step.
  await admitSignedInPage(destination ?? "/home");
  const requestHeaders = await headers();
  const host = requestHeaders.get("host");
  const protocol = requestHeaders.get("x-forwarded-proto") === "https" ? "https" : "http";
  const origin = host ? `${protocol}://${host}` : process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const target = resolvePostAuthRedirect(destination, origin, process.env.CLERK_OAUTH_ISSUER, process.env.CLERK_OAUTH_CONSENT_ORIGIN);
  if (target.origin !== new URL(origin).origin) return <ClerkOAuthContinuation href={target.href} />;
  redirect(target.href);
}

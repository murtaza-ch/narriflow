import { AuthContinuation } from "./clerk-oauth-continuation";

// Data-free: provisioning is the identity bootstrap the client runs next, and
// the destination is validated only once its API-supplied Clerk configuration is known.
export default async function AuthenticationContinuationPage({ searchParams }: {
  searchParams: Promise<{ redirect_url?: string | string[] }>;
}) {
  const params = await searchParams;
  const destination = typeof params.redirect_url === "string" ? params.redirect_url : null;
  return <AuthContinuation destination={destination} />;
}

export function resolvePostAuthRedirect(
  redirectUrl: string | null,
  appOrigin: string,
  clerkOAuthIssuer: string | undefined,
  clerkOAuthConsentOrigin?: string,
) {
  const fallback = new URL("/onboarding", appOrigin);
  if (!redirectUrl) return fallback;

  try {
    const target = new URL(redirectUrl, appOrigin);
    if (target.origin === new URL(appOrigin).origin) return target;

    if (!clerkOAuthIssuer) return fallback;
    const issuer = new URL(clerkOAuthIssuer);
    if (
      target.origin === issuer.origin
      && target.pathname === "/oauth/authorize-with-immediate-redirect"
    ) {
      return target;
    }

    const derivedDevelopmentConsentOrigin = issuer.hostname.endsWith(".clerk.accounts.dev")
      ? `${issuer.protocol}//${issuer.hostname.replace(".clerk.accounts.dev", ".accounts.dev")}`
      : undefined;
    const consentOrigin = clerkOAuthConsentOrigin ?? derivedDevelopmentConsentOrigin;
    if (
      consentOrigin
      && target.origin === new URL(consentOrigin).origin
      && target.pathname === "/oauth-consent"
    ) {
      return target;
    }
  } catch {
    return fallback;
  }

  return fallback;
}

export function resolvePostAuthRedirect(
  redirectUrl: string | null,
  appOrigin: string,
  clerkOAuthIssuer: string | undefined,
  clerkOAuthConsentOrigin?: string,
) {
  const fallback = new URL("/home", appOrigin);
  if (!redirectUrl) return fallback;

  try {
    const target = new URL(redirectUrl, appOrigin);
    if (target.username || target.password) return fallback;
    if (target.origin === new URL(appOrigin).origin) {
      const path = decodeURIComponent(target.pathname).replace(/\/+$/, "") || "/";
      if (
        (path === "/" && target.searchParams.has("auth")) ||
        /^\/(?:auth|sso-callback|sign-in|sign-up|forgot-password|onboarding)(?:\/|$)/.test(path)
      ) return fallback;
      return target;
    }

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

export type AuthContinuationTarget =
  /** A page of this app: `pathname + search + hash`. */
  | { kind: "app"; path: string }
  /** An approved Clerk authorization or consent page, reached through Clerk's SDK hand-off. */
  | { kind: "clerk"; href: string };

/**
 * Where `/auth/continue` goes once the identity bootstrap has provisioned the
 * person. `config` is the API's validated Clerk configuration, never anything
 * the request supplied; `webOrigin` is this app's own origin.
 */
export function resolveAuthContinuation(
  destination: string | null,
  webOrigin: string,
  config: { issuerUrl: string | null; consentOrigin: string | null },
): AuthContinuationTarget {
  const target = resolvePostAuthRedirect(
    destination,
    webOrigin,
    config.issuerUrl ?? undefined,
    config.consentOrigin ?? undefined,
  );
  if (target.origin !== new URL(webOrigin).origin) return { kind: "clerk", href: target.href };
  return { kind: "app", path: `${target.pathname}${target.search}${target.hash}` };
}

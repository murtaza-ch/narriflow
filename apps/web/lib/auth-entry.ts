export const AUTH_MODES = ["sign-in", "sign-up", "forgot-password", "continue"] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

export function isAuthMode(value: string | null): value is AuthMode {
  return AUTH_MODES.some((mode) => mode === value);
}

export function authEntryHref(mode: AuthMode, destination?: string | null) {
  const params = new URLSearchParams({ auth: mode });
  if (destination) params.set("redirect_url", destination);
  return `/?${params}`;
}

export function authContinuationHref(destination?: string | null) {
  const params = new URLSearchParams();
  if (destination) params.set("redirect_url", destination);
  return `/auth/continue${params.size ? `?${params}` : ""}`;
}

export function oauthCallbackHref(destination?: string | null) {
  const params = new URLSearchParams();
  if (destination) params.set("redirect_url", destination);
  return `/sso-callback${params.size ? `?${params}` : ""}`;
}

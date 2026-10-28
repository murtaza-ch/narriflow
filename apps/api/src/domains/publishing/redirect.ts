const SAFE_REDIRECT_ORIGIN = "https://redirect.narriflow.invalid";
const DEFAULT_SOCIAL_REDIRECT = "/settings/social-accounts";
const ENCODED_UNSAFE_DELIMITERS =
  /%(?:0[0-9a-f]|1[0-9a-f]|2f|5c|7f|8[0-9a-f]|9[0-9a-f])/i;

function hasControlCharacters(value: string) {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
}

/** Returns the only supported canonical OAuth return path, or a safe default. */
export function safeSocialRedirectPath(value: string | null | undefined): string {
  if (
    !value ||
    value !== value.trim() ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    hasControlCharacters(value) ||
    ENCODED_UNSAFE_DELIMITERS.test(value)
  ) {
    return DEFAULT_SOCIAL_REDIRECT;
  }

  let parsed: URL;
  try {
    parsed = new URL(value, SAFE_REDIRECT_ORIGIN);
  } catch {
    return DEFAULT_SOCIAL_REDIRECT;
  }

  if (parsed.origin !== SAFE_REDIRECT_ORIGIN || parsed.pathname !== DEFAULT_SOCIAL_REDIRECT) {
    return DEFAULT_SOCIAL_REDIRECT;
  }

  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

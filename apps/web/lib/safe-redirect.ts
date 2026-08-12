const SAFE_REDIRECT_ORIGIN = "https://redirect.narriflow.invalid";
const DEFAULT_SOCIAL_REDIRECT = "/settings/social-accounts";
const ENCODED_UNSAFE_DELIMITERS =
  /%(?:0[0-9a-f]|1[0-9a-f]|2f|5c|7f|8[0-9a-f]|9[0-9a-f])/i;

export type AppOriginConfigurationErrorReason =
  | "configured_origin_invalid"
  | "configured_origin_missing"
  | "local_fallback_invalid";

export class AppOriginConfigurationError extends Error {
  constructor(public readonly reason: AppOriginConfigurationErrorReason) {
    super("OAuth app origin is not safely configured");
    this.name = "AppOriginConfigurationError";
  }
}

interface ResolveCanonicalAppOriginOptions {
  configuredOrigin?: string | null;
  environment?: string;
  requestUrl: string;
}

function hasControlCharacters(value: string) {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
}

function parseHttpUrl(value: string) {
  if (
    !value ||
    value.includes("\\") ||
    hasControlCharacters(value)
  ) {
    return null;
  }

  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password ||
      !parsed.hostname
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname: string) {
  const normalized = hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "")
    .toLowerCase();
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "::1"
  ) {
    return true;
  }

  const octets = normalized.split(".").map((part) => Number(part));
  return (
    octets.length === 4 &&
    octets[0] === 127 &&
    octets.every(
      (octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255,
    )
  );
}

/** Resolves the canonical OAuth origin without trusting production Host data. */
export function resolveCanonicalAppOrigin({
  configuredOrigin,
  environment,
  requestUrl,
}: ResolveCanonicalAppOriginOptions) {
  const rawConfigured = configuredOrigin ?? "";
  if (rawConfigured) {
    const configured = rawConfigured.trim();
    const parsed = parseHttpUrl(configured);
    if (
      !configured ||
      hasControlCharacters(rawConfigured) ||
      !parsed ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      throw new AppOriginConfigurationError("configured_origin_invalid");
    }
    return parsed.origin;
  }

  if (environment !== "development") {
    throw new AppOriginConfigurationError("configured_origin_missing");
  }

  const localRequest = parseHttpUrl(requestUrl);
  if (!localRequest || !isLoopbackHostname(localRequest.hostname)) {
    throw new AppOriginConfigurationError("local_fallback_invalid");
  }
  return localRequest.origin;
}

/** Returns the only supported canonical OAuth return path or a safe default. */
export function safeSocialRedirectPath(value: string | null | undefined) {
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

  if (
    parsed.origin !== SAFE_REDIRECT_ORIGIN ||
    parsed.pathname !== DEFAULT_SOCIAL_REDIRECT
  ) {
    return DEFAULT_SOCIAL_REDIRECT;
  }

  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

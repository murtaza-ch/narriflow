const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function sextet(char: string): number {
  if (char === "-" || char === "+") return 62;
  if (char === "_" || char === "/") return 63;
  return ALPHABET.indexOf(char);
}

/**
 * Base64url (or base64) to text, decoded as UTF-8. Hand-written so it runs the
 * same in browsers, Workers and React Native: no `Buffer`, and no reliance on
 * `atob` or `TextDecoder`. Null on anything malformed.
 */
function decodeBase64Url(input: string): string | null {
  // Unpadded or correctly padded only; any other "=" fails as a foreign character below.
  const text = input.replace(/={1,2}$/, "");
  if (text.length % 4 === 1) return null;
  try {
    let value = 0;
    let bits = 0;
    let escaped = "";
    for (const char of text) {
      const digit = sextet(char);
      if (digit < 0) return null;
      value = ((value << 6) | digit) & 0xffffff;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        escaped += `%${((value >> bits) & 0xff).toString(16).padStart(2, "0")}`;
      }
    }
    return decodeURIComponent(escaped);
  } catch {
    // Not UTF-8, or too long for the engine to hold: unreadable either way.
    return null;
  }
}

/**
 * The claims of a session token (a JWT), read WITHOUT verifying it: only for
 * client-side decisions that refuse or expire, never to grant anything. The API
 * verifies every token. Null when the token is not a readable JWT.
 */
export function sessionTokenClaims(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  const json = decodeBase64Url(parts[1]);
  if (json === null) return null;
  try {
    const claims: unknown = JSON.parse(json);
    return claims !== null && typeof claims === "object" && !Array.isArray(claims)
      ? (claims as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The identity a session token was issued for (`sub`, Clerk's user id), or null when unreadable. */
export function sessionTokenSubject(token: string): string | null {
  const subject = sessionTokenClaims(token)?.sub;
  return typeof subject === "string" && subject.length > 0 ? subject : null;
}

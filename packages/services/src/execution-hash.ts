/** Lowercase hex SHA-256 of a string (UTF-8) or of bytes, via Web Crypto so it runs in Workers. */
export async function sha256Hex(input: string | BufferSource): Promise<string> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Postgres UUID columns reject anything else, so a malformed id can never name a row. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/** The credential of exactly one `Authorization: Bearer <token>` value; null for anything else, including merged values. */
export function bearerCredential(header: string | null | undefined): string | null {
  return /^Bearer ([^\s,]+)$/i.exec(header ?? "")?.[1] ?? null;
}

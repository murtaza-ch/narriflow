/**
 * Exact browser/server origins. Entries are full origins (`https://host[:port]`)
 * with no path, query, credentials or wildcard, so CORS, JWT authorized parties
 * and canonical URL construction can never widen by accident.
 */
export function parseOrigin(value: string): string | null {
  if (value.includes("*")) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return url.origin === value ? value : null;
}

/** Parses a comma-separated origin list, naming the setting on failure but never echoing values. */
export function parseOriginList(
  value: string | undefined,
  settingName: string,
): string[] {
  const origins: string[] = [];
  for (const entry of (value ?? "").split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const origin = parseOrigin(trimmed);
    if (!origin) {
      throw new Error(
        `${settingName} entries must be full origins without a path or wildcard`,
      );
    }
    if (!origins.includes(origin)) origins.push(origin);
  }
  return origins;
}

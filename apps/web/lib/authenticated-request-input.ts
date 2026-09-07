export function parseAuthenticatedJsonBody(
  rawBody: string,
  optional: boolean,
): unknown {
  if (rawBody.trim().length === 0) return optional ? {} : null;
  try {
    return JSON.parse(rawBody);
  } catch {
    return null;
  }
}

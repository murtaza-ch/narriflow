import { userErrorMessage } from "@narriflow/validators";

function readPayloadString(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Resolves action feedback without allowing provider details to override the
 * bounded product copy for a known error code.
 */
export function clipActionErrorCopy(
  payload: unknown,
  fallback: string,
): string {
  return (
    userErrorMessage(readPayloadString(payload, "error")) ??
    readPayloadString(payload, "message") ??
    fallback
  );
}

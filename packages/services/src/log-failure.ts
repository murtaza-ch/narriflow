const MAX_MESSAGE = 300;
const MAX_FRAMES = 5;
const MAX_CAUSES = 3;

export interface FailureRecord {
  name: string;
  code?: string | number;
  message?: string;
  stack?: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Longest text any replace below sees. Several rules scan to the end of a long
 * run for every start position, so an unbounded error body would stall a log line. */
const MAX_SCAN = 2_000;

/** Error text can carry URLs with tokens, emails, bearer values and key-shaped strings. Keep the shape, drop the secret. */
export function redactFailureText(text: string): string {
  return text
    .slice(0, MAX_SCAN)
    .replace(/:\/\/[^\s/@]+@/g, "://[redacted]@")
    // Credential schemes first, so the key rule below never leaves the credential behind "Authorization:".
    .replace(/\b(Bearer|Basic)\s+[^\s"'`,;]+/gi, "$1 [redacted]")
    .replace(/(pass(?:word)?|pwd|secret|token|api[_-]?key|key|auth(?:orization)?)("?\s*[=:]\s*"?)(?!(?:Bearer|Basic)\b)[^\s,;&"'`]+/gi, "$1$2[redacted]")
    .replace(/(https?:\/\/[^\s?#"'`)]+)[?#][^\s"'`)]*/gi, "$1?[redacted]")
    .replace(/[^\s@"'`<>(),;]+@[^\s@"'`<>(),;]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, (run) => (UUID.test(run) ? run : "[redacted]"))
    .slice(0, MAX_MESSAGE);
}

function frames(stack: unknown): string[] | undefined {
  if (typeof stack !== "string") return undefined;
  const lines = stack.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("at "));
  // A multi-line message can put its own text on a line that starts with "at ".
  return lines.length ? lines.slice(0, MAX_FRAMES).map((line) => redactFailureText(line).slice(0, 200)) : undefined;
}

function record(value: unknown, withStack: boolean): FailureRecord {
  if (!value || typeof value !== "object") return { name: typeof value };
  const error = value as { name?: unknown; code?: unknown; message?: unknown; stack?: unknown };
  const stack = withStack ? frames(error.stack) : undefined;
  return {
    name: typeof error.name === "string" ? error.name.slice(0, 80) : "object",
    ...(typeof error.code === "string" || typeof error.code === "number" ? { code: typeof error.code === "string" ? error.code.slice(0, 80) : error.code } : {}),
    ...(typeof error.message === "string" && error.message ? { message: redactFailureText(error.message) } : {}),
    ...(stack ? { stack } : {}),
  };
}

/** The failure, its cause chain, and the top stack frames. Safe to log; never for client responses. */
export function describeFailure(cause: unknown): FailureRecord & { causes?: FailureRecord[] } {
  const head = record(cause, true);
  const causes: FailureRecord[] = [];
  let next = cause && typeof cause === "object" ? (cause as { cause?: unknown }).cause : undefined;
  while (next !== undefined && next !== null && causes.length < MAX_CAUSES) {
    causes.push(record(next, false));
    next = typeof next === "object" ? (next as { cause?: unknown }).cause : undefined;
  }
  return causes.length ? { ...head, causes } : head;
}

/**
 * One structured error line for an unexpected failure: name, code, bounded
 * redacted message, top frames and cause chain. Callers keep their client
 * response generic; `context` is theirs to keep free of secrets.
 */
export function logFailure(message: string, cause: unknown, context: Record<string, unknown> = {}): void {
  const error = describeFailure(cause);
  console.warn(JSON.stringify({ level: "error", message, ...context, error }));
  try { reporter?.(message, error, context); } catch { /* Reporting must never break the caller. */ }
}

export type FailureReporter = (message: string, failure: ReturnType<typeof describeFailure>, context: Record<string, unknown>) => void;
let reporter: FailureReporter | undefined;
/** The runtime chooses where failures go. This module stays free of vendors. */
export function installFailureReporter(next: FailureReporter | undefined) { reporter = next; }

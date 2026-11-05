import type { FailureRecord, FailureReporter } from "@narriflow/services/log-failure";

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 10;
/** A context is free-form, so only these reach a third party. */
const SHARED_CONTEXT = ["requestId", "method", "route", "kind", "subjectKind"];

export interface FailureClient {
  captureExceptionImmediate(error: unknown, distinctId?: string, properties?: Record<string, unknown>): Promise<void>;
  shutdown(): Promise<void> | void;
}
export interface FailureReporterDependencies {
  settings(): { token?: string; deployment?: string } | null;
  createClient(token: string): FailureClient;
  waitUntil(work: Promise<unknown>): void;
  now?(): number;
}

/** Rebuilt from the constant label and redacted frames. Redaction catches secret-shaped
 * text, not a project title inside a database error, so the error's own message stays
 * in the Worker log. The event's requestId finds that line. */
function safeError(label: string, failure: FailureRecord) {
  const error = new Error(label);
  error.name = failure.name;
  error.stack = [`${failure.name}: ${label}`, ...(failure.stack ?? [])].join("\n");
  return error;
}

/** Function names survive a deploy; bundle line numbers do not. */
function throwSite(failure: FailureRecord) {
  return failure.stack?.map(frame => /^at (?:async )?(?:new )?([^\s(]+) \(/.exec(frame)?.[1]).find(Boolean);
}

export function createFailureReporter(dependencies: FailureReporterDependencies): FailureReporter {
  const now = dependencies.now ?? Date.now;
  const windows = new Map<string, { startedAt: number; count: number }>();
  return (message, failure, context) => {
    const settings = dependencies.settings();
    if (!settings?.token) return;
    const fingerprint = [message, failure.name, failure.code, context.route ?? context.kind, throwSite(failure)].filter(value => value !== undefined).join(":");
    const window = windows.get(fingerprint);
    if (window && now() - window.startedAt < WINDOW_MS) {
      if (++window.count > MAX_PER_WINDOW) return;
    } else windows.set(fingerprint, { startedAt: now(), count: 1 });
    const client = dependencies.createClient(settings.token);
    const shared = Object.fromEntries(SHARED_CONTEXT.filter(key => context[key] !== undefined).map(key => [key, context[key]]));
    dependencies.waitUntil(client.captureExceptionImmediate(safeError(message, failure), crypto.randomUUID(),
      { ...shared, failure: message, code: failure.code, deployment: settings.deployment, $exception_fingerprint: fingerprint, $process_person_profile: false })
      .then(() => client.shutdown()).catch(() => undefined));
  };
}

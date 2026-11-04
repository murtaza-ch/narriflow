import { readBoundedBody } from "@narriflow/services/bounded-body";

/** Browsers cannot retry a rejected report usefully, and a reporter must never be an error surface. */
export const CSP_REPORT_MAX_BYTES = 64 * 1024;
const MAX_REPORTS_PER_BODY = 10;
const KEYWORD = /^[a-z][a-z-]{0,29}$/;

export interface CspReportDependencies {
  /** Per-address budget; `false` drops the report. A failure of the limiter also drops it. */
  allow(): Promise<boolean>;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
} as const;

/** Answers the Reporting API's cross-origin preflight; the report itself carries no credentials. */
export function cspReportPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function urlOf(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/** Host of a blocked URL, or the CSP keyword (`inline`, `eval`, `data`, ...). Nothing else leaves this function. */
function blockedHost(value: string | undefined): string {
  const url = urlOf(value);
  if (url?.host) return url.host.slice(0, 120);
  if (url) return url.protocol.replace(":", "").slice(0, 30) || "unknown";
  return value && KEYWORD.test(value) ? value : "unknown";
}

function documentPath(value: string | undefined): string {
  const url = urlOf(value);
  return url ? url.pathname.slice(0, 200) : "unknown";
}

function directive(value: string | undefined): string {
  return value && KEYWORD.test(value.split(/\s/)[0] ?? "") ? (value.split(/\s/)[0] as string) : "unknown";
}

/** Normalizes both wire formats to the three logged fields. */
function violations(contentType: string, payload: unknown) {
  const out: { blockedHost: string; directive: string; documentPath: string }[] = [];
  if (contentType === "application/csp-report") {
    const report = (payload as { "csp-report"?: Record<string, unknown> } | null)?.["csp-report"];
    if (report && typeof report === "object") {
      out.push({
        blockedHost: blockedHost(text(report["blocked-uri"])),
        directive: directive(text(report["effective-directive"]) ?? text(report["violated-directive"])),
        documentPath: documentPath(text(report["document-uri"])),
      });
    }
  } else if (Array.isArray(payload)) {
    for (const entry of payload.slice(0, MAX_REPORTS_PER_BODY)) {
      const item = entry as { type?: unknown; body?: Record<string, unknown> } | null;
      if (item?.type !== "csp-violation" || !item.body || typeof item.body !== "object") continue;
      out.push({
        blockedHost: blockedHost(text(item.body.blockedURL)),
        directive: directive(text(item.body.effectiveDirective)),
        documentPath: documentPath(text(item.body.documentURL)),
      });
    }
  }
  return out;
}

/**
 * Browser CSP violation reports. Always 204. Only the blocked host, the
 * directive and the document path are logged: no query string, no full URL, no
 * body is kept, and nothing is written to a database.
 */
export async function handleCspReport(request: Request, deps: CspReportDependencies): Promise<Response> {
  const done = () => new Response(null, { status: 204, headers: CORS });
  try {
    const contentType = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    if (contentType !== "application/csp-report" && contentType !== "application/reports+json") return done();
    if (Number(request.headers.get("content-length")) > CSP_REPORT_MAX_BYTES) return done();
    if (!(await deps.allow())) return done();
    const body = await readBoundedBody(request.body, CSP_REPORT_MAX_BYTES);
    if (body.kind === "too_large") return done();
    for (const violation of violations(contentType, JSON.parse(new TextDecoder().decode(body.bytes)))) {
      console.warn(JSON.stringify({ level: "warn", message: "csp_violation_reported", ...violation }));
    }
  } catch {
    // Malformed or unreadable reports are dropped; the reporter gets the same answer.
  }
  return done();
}

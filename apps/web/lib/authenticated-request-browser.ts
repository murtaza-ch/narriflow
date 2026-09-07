export interface BrowserRequestFailure {
  ok?: false;
  error?: string;
  code?: string;
  message?: string;
  requestId?: string;
  issues?: Array<{
    path?: Array<string | number>;
    code?: string;
    message?: string;
  }>;
  details?: Record<string, unknown>;
  retryAfterSeconds?: number;
}

export function isAuthenticatedActionFailure(
  value: unknown,
): value is BrowserRequestFailure & {
  ok: false;
  error: string;
  code: string;
  requestId: string;
} {
  if (!value || typeof value !== "object") return false;
  const candidate = value as {
    ok?: unknown;
    error?: unknown;
    code?: unknown;
    requestId?: unknown;
  };
  return (
    candidate.ok === false &&
    typeof candidate.error === "string" &&
    typeof candidate.code === "string" &&
    candidate.error === candidate.code &&
    typeof candidate.requestId === "string" &&
    candidate.requestId.length > 0 &&
    candidate.requestId.length <= 128
  );
}

export function authenticatedActionResultMessage(
  value: unknown,
  fallback: string,
): string {
  if (isAuthenticatedActionFailure(value)) {
    return authenticatedRequestFailureMessage(
      value,
      typeof window === "undefined" ? "/home" : window.location.pathname,
      fallback,
    );
  }
  if (value && typeof value === "object") {
    if ("message" in value && typeof value.message === "string") {
      return value.message;
    }
    if ("error" in value && typeof value.error === "string") {
      return value.error;
    }
  }
  return fallback;
}

export type BrowserRequestRecovery =
  | { kind: "sign_in"; preserveInput: true; returnDestination: string }
  | {
      kind: "switch_workspace";
      preserveInput: true;
      workspaceId: string;
      workspaceName: string;
    }
  | { kind: "billing"; preserveInput: true; message: string }
  | { kind: "contact_owner"; preserveInput: true; message: string }
  | { kind: "missing"; preserveInput: false }
  | {
      kind: "correct_input";
      preserveInput: true;
      focusPath: Array<string | number> | null;
    }
  | { kind: "refresh"; preserveInput: true; message: string }
  | { kind: "wait"; preserveInput: true; retryAfterSeconds: number }
  | { kind: "upgrade"; preserveInput: true; message: string }
  | { kind: "retry"; preserveInput: true; message: string }
  | { kind: "support"; preserveInput: true; requestId: string | null };

function safeReturnDestination(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//")) return "/home";
  try {
    const parsed = new URL(value, "https://narriflow.local");
    return parsed.origin === "https://narriflow.local"
      ? `${parsed.pathname}${parsed.search}${parsed.hash}`
      : "/home";
  } catch {
    return "/home";
  }
}

export function classifyAuthenticatedRequestFailure(
  failure: BrowserRequestFailure,
  currentDestination: string,
): BrowserRequestRecovery {
  const code = failure.error ?? "internal_error";
  if (code === "authentication_required") {
    return {
      kind: "sign_in",
      preserveInput: true,
      returnDestination: safeReturnDestination(currentDestination),
    };
  }
  if (code === "active_workspace_mismatch") {
    return {
      kind: "switch_workspace",
      preserveInput: true,
      workspaceId: String(failure.details?.workspaceId ?? ""),
      workspaceName: String(failure.details?.workspaceName ?? "Workspace"),
    };
  }
  if (code === "workspace_restricted") {
    return failure.details?.ownerCanResolve === true
      ? { kind: "billing", preserveInput: true, message: failure.message ?? "" }
      : {
          kind: "contact_owner",
          preserveInput: true,
          message: failure.message ?? "",
        };
  }
  if (code === "project_not_found" || code.endsWith("_not_found")) {
    return { kind: "missing", preserveInput: false };
  }
  if (code === "invalid_input") {
    return {
      kind: "correct_input",
      preserveInput: true,
      focusPath: failure.issues?.[0]?.path ?? null,
    };
  }
  if (code.includes("conflict") || code.includes("revision")) {
    return {
      kind: "refresh",
      preserveInput: true,
      message: failure.message ?? "Refresh before trying again.",
    };
  }
  if (code === "rate_limited") {
    return {
      kind: "wait",
      preserveInput: true,
      retryAfterSeconds: Math.max(1, Math.ceil(failure.retryAfterSeconds ?? 1)),
    };
  }
  if (
    code === "remote_fetch_timeout" ||
    code === "rss_download_failed" ||
    code === "remote_fetch_failed"
  ) {
    return {
      kind: "retry",
      preserveInput: true,
      message: failure.message ?? "The remote service did not respond. Try again.",
    };
  }
  if (
    code.includes("quota") ||
    code.includes("plan") ||
    code.includes("payment")
  ) {
    return {
      kind: "upgrade",
      preserveInput: true,
      message: failure.message ?? "Review plan usage before trying again.",
    };
  }
  if (code.includes("unavailable") || code.includes("temporary")) {
    return {
      kind: "retry",
      preserveInput: true,
      message: failure.message ?? "Try again when the service is available.",
    };
  }
  return {
    kind: "support",
    preserveInput: true,
    requestId: failure.requestId ?? null,
  };
}

export function authenticatedRequestFailureMessage(
  failure: BrowserRequestFailure,
  currentDestination: string,
  fallback: string,
): string {
  const recovery = classifyAuthenticatedRequestFailure(
    failure,
    currentDestination,
  );
  switch (recovery.kind) {
    case "sign_in":
      return "Your session ended. Sign in again to continue without losing your work.";
    case "switch_workspace":
      return `Switch to ${recovery.workspaceName} before trying again.`;
    case "billing":
    case "contact_owner":
    case "refresh":
    case "upgrade":
    case "retry":
      return recovery.message || fallback;
    case "missing":
      return "This item is no longer available. Return to the collection to continue.";
    case "correct_input":
      return failure.message || "Check the highlighted fields and try again.";
    case "wait":
      return `Wait ${recovery.retryAfterSeconds} seconds before trying again.`;
    case "support":
      return recovery.requestId
        ? `${fallback} Support reference: ${recovery.requestId}.`
        : fallback;
  }
}

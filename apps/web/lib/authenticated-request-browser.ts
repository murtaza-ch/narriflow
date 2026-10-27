import {
  PLAN_CATALOG,
  PRICING_TIER_ORDER,
  lowestTier,
  planFeatureSchema,
  planUpgradeHighlight,
  pricingTierSchema,
  type PlanCountLimit,
  type PricingTier,
} from "@narriflow/validators";
import type { UpgradePrompt } from "@/app/(app)/_components/upgrade";

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
  | {
      kind: "wait";
      preserveInput: true;
      retryAfterSeconds: number;
      /** The server's own waiting instruction, when it sent a safe one. */
      message?: string;
    }
  | {
      kind: "upgrade";
      preserveInput: true;
      message: string;
      /** Null when no higher plan lifts this refusal. */
      prompt: UpgradePrompt | null;
    }
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

const UPGRADE_FAILURE_CODES: ReadonlySet<string> = new Set([
  "plan_feature_required",
  "plan_limit_reached",
  "credits_exhausted",
  "upload_too_long",
]);

const COUNT_LIMITS: readonly PlanCountLimit[] = [
  "brandProfiles",
  "brandTemplates",
  "socialDestinations",
  "autopilotRules",
];

function failureDetails(failure: BrowserRequestFailure) {
  const details = failure.details;
  return details && typeof details === "object" && !Array.isArray(details)
    ? details
    : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function tierOf(value: unknown): PricingTier | null {
  const parsed = pricingTierSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** A tier can only be offered when it sits above the one that was refused. */
function purchasableAbove(
  current: PricingTier,
  candidate: PricingTier | null,
): candidate is PricingTier {
  return (
    candidate !== null &&
    candidate !== "free" &&
    PRICING_TIER_ORDER.indexOf(candidate) > PRICING_TIER_ORDER.indexOf(current)
  );
}

function sourceLengthLabel(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  return minutes % 60 === 0
    ? `${minutes / 60} hour${minutes === 60 ? "" : "s"}`
    : `${minutes} minutes`;
}

/**
 * The cheapest plan above `currentTier` that admits a source of `seconds` and
 * has room for its credits after `credits.spentCredits` (settled plus reserved
 * this month), as an upgrade prompt; null when no plan does both.
 */
export function uploadLengthUpgradePrompt(
  currentTier: PricingTier,
  seconds: number,
  credits: { spentCredits: number; requestedCredits: number },
): UpgradePrompt | null {
  const needed = credits.spentCredits + credits.requestedCredits;
  const tier = lowestTier(
    (plan) => plan.limits.maxSourceSeconds >= seconds && plan.limits.monthlyCredits >= needed,
  );
  if (!purchasableAbove(currentTier, tier)) return null;
  return {
    tier,
    headline: `Upgrade to ${PLAN_CATALOG[tier].name} for longer videos`,
    highlight: `Videos up to ${sourceLengthLabel(PLAN_CATALOG[tier].limits.maxSourceSeconds)}`,
  };
}

/**
 * The cheapest plan above `currentTier` whose monthly allowance covers the
 * credits already spent (settled plus reserved, which may exceed the current
 * limit after a downgrade) plus `requestedCredits`; null when none does.
 */
export function creditsUpgradePrompt(
  currentTier: PricingTier,
  spentCredits: number,
  requestedCredits: number,
): UpgradePrompt | null {
  const needed = spentCredits + requestedCredits;
  const tier = lowestTier((plan) => plan.limits.monthlyCredits >= needed);
  if (!purchasableAbove(currentTier, tier)) return null;
  return {
    tier,
    headline: `Upgrade to ${PLAN_CATALOG[tier].name} for more credits`,
    highlight: `${PLAN_CATALOG[tier].limits.monthlyCredits.toLocaleString("en-US")} credits a month`,
  };
}

/**
 * The upgrade dialog's prompt for a refused request, or null when no plan
 * fixes it (capacity, billing repair, a top-tier ceiling, malformed details).
 * Callers open it explicitly; nothing is retried.
 */
export function upgradePromptFromFailure(
  failure: BrowserRequestFailure,
): UpgradePrompt | null {
  const code = failure.error ?? failure.code;
  const details = failureDetails(failure);
  if (!code || !details) return null;

  if (code === "plan_feature_required" || code === "plan_limit_reached") {
    const current = tierOf(details.currentTier);
    const required = tierOf(details.requiredTier);
    if (!current || !purchasableAbove(current, required)) return null;
    const plan = PLAN_CATALOG[required];
    const feature = planFeatureSchema.safeParse(details.feature);
    if (feature.success) {
      return {
        tier: required,
        headline:
          typeof failure.message === "string" && failure.message
            ? failure.message
            : `Upgrade to ${plan.name}`,
        highlight: planUpgradeHighlight(required, feature.data),
      };
    }
    const limit = details.limit;
    const headline = `Upgrade to ${plan.name} to raise this limit`;
    if (COUNT_LIMITS.some((candidate) => candidate === limit)) {
      return {
        tier: required,
        headline,
        highlight: planUpgradeHighlight(required, limit as PlanCountLimit),
      };
    }
    if (limit === "generatedImages") {
      const { count: images, period } = plan.limits.generatedImages;
      return {
        tier: required,
        headline,
        highlight: `${images} AI images ${period === "month" ? "a month" : "to try"}`,
      };
    }
    if (limit === "dubs") {
      return {
        tier: required,
        headline,
        highlight: `${plan.limits.dubs.perMonth} dubs a month`,
      };
    }
    return null;
  }

  if (code === "credits_exhausted") {
    const current = tierOf(details.tier);
    const spent = count(details.spentCredits);
    if (!current || spent === null) return null;
    const requested = details.requestedCredits;
    if (requested !== null && count(requested) === null) return null;
    return creditsUpgradePrompt(
      current,
      spent,
      requested === null ? 1 : Math.max(1, count(requested) ?? 1),
    );
  }

  if (code === "upload_too_long") {
    const current = tierOf(details.tier);
    const seconds = count(details.seconds);
    const spentCredits = count(details.spentCredits);
    const requestedCredits = count(details.requestedCredits);
    // Without usage facts we can't promise a plan admits the import.
    if (!current || seconds === null || seconds <= 0 || spentCredits === null || requestedCredits === null) return null;
    return uploadLengthUpgradePrompt(current, seconds, { spentCredits, requestedCredits });
  }

  return null;
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
  if (code === "workspace_processing_capacity_reached") {
    // Capacity frees when a running video finishes; no purchase, no auto-retry.
    return {
      kind: "wait",
      preserveInput: true,
      retryAfterSeconds: Math.max(1, Math.ceil(failure.retryAfterSeconds ?? 60)),
      ...(failure.message ? { message: failure.message } : {}),
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
  if (UPGRADE_FAILURE_CODES.has(code)) {
    return {
      kind: "upgrade",
      preserveInput: true,
      message: failure.message ?? "Review plan usage before trying again.",
      prompt: upgradePromptFromFailure(failure),
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
      return recovery.message ?? `Wait ${recovery.retryAfterSeconds} seconds before trying again.`;
    case "support":
      return recovery.requestId
        ? `${fallback} Support reference: ${recovery.requestId}.`
        : fallback;
  }
}

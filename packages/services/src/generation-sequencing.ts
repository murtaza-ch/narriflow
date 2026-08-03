import {
  MONTHLY_PROCESSING_MINUTE_LIMITS,
  type PricingTier,
} from "@narriflow/validators";

/**
 * Link-first generation sequencing (docs/plans/link-to-clips-uiux.md, Phase 0).
 *
 * THE ORDERING INVARIANT:
 *   Finalize commits the ContentPack BEFORE reading ingestStatus.
 *   The ingest worker commits ingestStatus = ready BEFORE reading the pack.
 *
 * With both sides committing their own write before reading the other's, at
 * least one of the two transition paths always observes both facts and
 * attempts the run-claim. The claim itself is made idempotent by a
 * deterministic key + the WorkflowRun (projectId, idempotencyKey) unique —
 * the loser of a concurrent claim recovers the winner's run instead of
 * throwing.
 */

/** Deterministic idempotency key for the automatic post-setup run claim. */
export function autoTriggerIdempotencyKey(
  projectId: string,
  contentPackId: string,
): string {
  return `auto:${projectId}:${contentPackId}`;
}

export interface ActionablePackCandidate {
  id: string;
  draft: boolean;
  createdAt: Date;
}

/**
 * Pick the pack a run-claim may act on: the latest pack overall, and STOP if
 * that row is a draft. Never filter drafts out first — that would silently
 * select an older committed pack and start a run with stale settings.
 */
export function selectActionablePack<T extends ActionablePackCandidate>(
  packs: readonly T[],
): T | null {
  if (packs.length === 0) return null;
  const latest = [...packs].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  )[0]!;
  return latest.draft ? null : latest;
}

/**
 * Prisma unique-constraint violation (P2002). The loser of a concurrent
 * run-claim must treat this as "the winner exists" — fetch and return it —
 * never as a failure.
 */
export function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

/**
 * Derived (never persisted) processing-panel state for a project whose
 * automatic run claim was blocked by quota mid-flight: ingest finished, a
 * committed pack exists, no run was created, and the user is at/over their
 * monthly limit. Self-clears on upgrade, month rollover, or a successful
 * re-claim — there is no sticky flag to reset.
 */
export function isQuotaBlockedMidFlight(input: {
  ingestReady: boolean;
  hasCommittedPack: boolean;
  hasAnyRun: boolean;
  tier: PricingTier;
  usedMinutes: number;
}): boolean {
  if (!input.ingestReady || !input.hasCommittedPack || input.hasAnyRun) {
    return false;
  }
  // Strictly greater-than: mirrors the authoritative post-ingest gate in
  // assertProjectGenerationAllowed, so this derived banner can never claim
  // "limit reached" for a project the gate would actually allow.
  return input.usedMinutes > MONTHLY_PROCESSING_MINUTE_LIMITS[input.tier];
}

export type FinalizeSetupResult = {
  started: boolean;
  ingestStatus: string;
  workflowRunId?: string;
};

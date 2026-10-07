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
 * Processing-panel state for a Project whose speech-to-text admission was
 * refused by Processing Usage: the typed refusal persisted on the Project is
 * the only input, so web, MCP, and REST render the same recovery copy.
 */
export function isQuotaBlockedMidFlight(input: {
  ingestErrorCode: string | null | undefined;
}): boolean {
  return (
    input.ingestErrorCode === "processing_quota_exhausted" ||
    input.ingestErrorCode === "upload_too_long"
  );
}

export type FinalizeSetupResult = {
  started: boolean;
  ingestStatus: string;
  workflowRunId?: string;
};

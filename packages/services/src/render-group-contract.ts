import type {
  ClipRenderFailureDisposition,
  RenderGroupExecutionResult,
  RenderGroupStatus,
  RenderGroupVariantResult,
} from "@prisma/client";

// Pure contracts for the service protocol and worker adapter. No DB ownership
// decision may use a process clock; callers supply time read inside their txn.
export const RENDER_GROUP_MAX_ATTEMPTS = 3;
export const RENDER_GROUP_RETRY_BASE_MS = 30_000;

export interface RenderGroupRef {
  readonly workflowRunId: string;
  readonly workSetGeneration: string;
  readonly groupId: string;
}

/** A new token on every claim. Coordinator attempt identity is deliberately absent. */
export interface RenderGroupAttemptRef extends RenderGroupRef {
  readonly token: string;
  readonly owner: string;
}

export interface ClaimedRenderGroupAttempt extends RenderGroupAttemptRef {
  readonly projectId: string;
  readonly clipId: string;
  readonly exportIdentity: string;
  readonly chargedAttemptCount: number;
  readonly leaseExpiresAt: Date;
  readonly memberIds: readonly string[];
}

export interface StartRenderGroupExecution extends RenderGroupAttemptRef {
  readonly sourceFingerprint: string;
  readonly analysisFingerprint: string | null;
  readonly toolchainFingerprint: string;
}

export interface ReleaseRenderGroupExecution extends RenderGroupAttemptRef {
  readonly reason: "pre_start_rejection" | "shutdown";
}

export interface RenderGroupConfiguration {
  readonly clipId: string;
  readonly exportId: string | null;
  readonly editorRevision: number;
  readonly resolution: string;
  readonly watermark: boolean;
}

/** Aspects share one group; different exports/configurations never collide. */
export function renderGroupExportIdentity(config: RenderGroupConfiguration): string {
  return JSON.stringify([
    config.exportId === null ? "automatic" : "export",
    config.exportId,
    config.editorRevision,
    config.resolution,
    config.watermark,
  ]);
}

export interface RenderGroupMemberOutcome {
  readonly clipRenderId: string;
  readonly status: "pending" | "rendering" | "completed" | "failed" | "superseded";
  readonly failureDisposition: ClipRenderFailureDisposition | null;
}

/** Durable per-token/per-variant ledger input, never a second render manifest. */
export interface RecordRenderGroupVariantOutcome extends RenderGroupAttemptRef {
  readonly clipRenderId: string;
  readonly result: RenderGroupVariantResult;
  readonly errorCode: string | null;
}

export interface RenderGroupExecutionCharge {
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly charged: boolean;
}

export interface RenderGroupChargeTransition {
  readonly charged: boolean;
  readonly delta: -1 | 0 | 1;
  readonly chargedAttemptCount: number;
}

/** Applied with the ledger write under the group lock, once per token.
 * Claim/pre-start failure costs zero; a durable start costs one. Expiry keeps
 * that charge. Graceful shutdown refunds even a started execution. */
export function renderGroupChargeTransition(
  count: number,
  execution: RenderGroupExecutionCharge,
  action: "start" | "release" | "expire",
): RenderGroupChargeTransition {
  assertAttemptCount(count);
  if (execution.charged && (execution.startedAt === null || count === 0)) {
    throw new Error("Invalid render group execution charge");
  }
  if (execution.finishedAt !== null) {
    return { charged: execution.charged, delta: 0, chargedAttemptCount: count };
  }
  const charged = action === "start" ? true : action === "release" ? false : execution.charged;
  const delta = (Number(charged) - Number(execution.charged)) as -1 | 0 | 1;
  const chargedAttemptCount = count + delta;
  assertAttemptCount(chargedAttemptCount);
  return { charged, delta, chargedAttemptCount };
}

export interface RenderGroupCounts {
  readonly requested: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly superseded: number;
}

export interface RenderGroupSettlement extends RenderGroupCounts {
  readonly status: Exclude<RenderGroupStatus, "running">;
  readonly retryVariantIds: readonly string[];
  readonly nextAttemptAt: Date | null;
}

/** Count is AFTER durable start/release accounting. The caller commits this
 * decision, member mutations, export aggregates and ledger result together.
 * Infrastructure failures must first classify affected unsettled members. */
export function deriveRenderGroupSettlement(input: {
  members: readonly RenderGroupMemberOutcome[];
  chargedAttemptCount: number;
  databaseNow: Date;
  releaseNotBefore?: Date;
}): RenderGroupSettlement {
  assertAttemptCount(input.chargedAttemptCount);
  if (input.members.length === 0) throw new Error("Empty render group");
  const seen = new Set<string>();
  for (const member of input.members) {
    if (seen.has(member.clipRenderId)) throw new Error("Duplicate render group member");
    seen.add(member.clipRenderId);
  }
  const succeeded = input.members.filter((m) => m.status === "completed").length;
  const superseded = input.members.filter((m) => m.status === "superseded").length;
  const retryable = input.members.filter((m) => m.status === "pending" || m.status === "rendering" ||
    (m.status === "failed" && m.failureDisposition === "retryable"));
  const failed = input.members.length - succeeded - superseded - retryable.length;
  if (retryable.length > 0 && input.chargedAttemptCount < RENDER_GROUP_MAX_ATTEMPTS) {
    const delay = input.chargedAttemptCount === 0 ? 0 :
      RENDER_GROUP_RETRY_BASE_MS * 2 ** (input.chargedAttemptCount - 1);
    return {
      status: "queued", requested: input.members.length, succeeded, failed, superseded,
      retryVariantIds: retryable.map((m) => m.clipRenderId),
      nextAttemptAt: new Date(Math.max(input.databaseNow.getTime() + delay,
        input.releaseNotBefore?.getTime() ?? 0)),
    };
  }
  const settledFailed = failed + retryable.length;
  return {
    status: superseded === input.members.length ? "superseded" : terminalStatus(succeeded, settledFailed),
    requested: input.members.length, succeeded, failed: settledFailed, superseded,
    retryVariantIds: [], nextAttemptAt: null,
  };
}

export interface RenderGroupParentSnapshot {
  readonly workflowRunId: string;
  readonly stage: string;
  readonly status: string;
  readonly workSetGeneration: string | null;
}

export interface RenderGroupOwnershipSnapshot extends RenderGroupRef {
  readonly status: RenderGroupStatus;
  readonly attemptToken: string | null;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: Date | null;
}

/** Predicate for protocol tests, not a substitute for SQL row locks. Group
 * writes lock parent, group and affected members in that order and repeat this
 * check with DB time. A coordinator lease/attempt is never a child fence. */
export function renderGroupOwnsMember(input: {
  attempt: RenderGroupAttemptRef;
  parent: RenderGroupParentSnapshot;
  group: RenderGroupOwnershipSnapshot;
  clipRenderId: string;
  member: RenderGroupRef & { readonly clipRenderId: string; readonly invalidatedAt: Date | null };
  databaseNow: Date;
}): boolean {
  const { attempt, parent, group, member, databaseNow } = input;
  return parent.stage === "clip_rendering" &&
    (parent.status === "queued" || parent.status === "running") &&
    parent.workflowRunId === attempt.workflowRunId &&
    parent.workSetGeneration === attempt.workSetGeneration &&
    group.workflowRunId === attempt.workflowRunId &&
    group.workSetGeneration === attempt.workSetGeneration &&
    group.groupId === attempt.groupId && group.status === "running" &&
    group.attemptToken === attempt.token && group.leaseOwner === attempt.owner &&
    group.leaseExpiresAt !== null && group.leaseExpiresAt.getTime() > databaseNow.getTime() &&
    member.workflowRunId === attempt.workflowRunId &&
    member.workSetGeneration === attempt.workSetGeneration &&
    member.groupId === attempt.groupId && member.clipRenderId === input.clipRenderId &&
    member.invalidatedAt === null;
}

export interface SettlingRenderGroup extends RenderGroupCounts {
  readonly status: RenderGroupStatus;
  readonly leaseExpiresAt: Date | null;
  readonly nextAttemptAt: Date | null;
}

export type RenderParentSettlement =
  | { readonly eligible: false; readonly reason: "not_frozen" | "membership_incomplete" | "live_lease" | "retry_scheduled" | "unsettled_groups" }
  | ({ readonly eligible: true; readonly status: "completed" | "partial" | "failed";
      readonly notify: boolean } & RenderGroupCounts);

export function deriveRenderParentSettlement(input: {
  frozen: boolean;
  requestedCount: number;
  groups: readonly SettlingRenderGroup[];
  databaseNow: Date;
}): RenderParentSettlement {
  if (!input.frozen) return { eligible: false, reason: "not_frozen" };
  const counts = input.groups.reduce<RenderGroupCounts>((sum, g) => ({
    requested: sum.requested + g.requested, succeeded: sum.succeeded + g.succeeded,
    failed: sum.failed + g.failed, superseded: sum.superseded + g.superseded,
  }), { requested: 0, succeeded: 0, failed: 0, superseded: 0 });
  if (counts.requested !== input.requestedCount || input.groups.some((g) =>
    [g.requested, g.succeeded, g.failed, g.superseded].some((n) => !Number.isInteger(n) || n < 0))) {
    return { eligible: false, reason: "membership_incomplete" };
  }
  if (input.groups.some((g) => g.leaseExpiresAt !== null &&
    g.leaseExpiresAt.getTime() > input.databaseNow.getTime())) return { eligible: false, reason: "live_lease" };
  if (input.groups.some((g) => g.nextAttemptAt !== null)) return { eligible: false, reason: "retry_scheduled" };
  if (input.groups.some((g) => g.status === "running" || g.status === "queued")) {
    return { eligible: false, reason: "unsettled_groups" };
  }
  if (input.groups.some((g) => g.requested !== g.succeeded + g.failed + g.superseded ||
    g.status !== (g.superseded === g.requested ? "superseded" : terminalStatus(g.succeeded, g.failed)))) {
    return { eligible: false, reason: "membership_incomplete" };
  }
  return { eligible: true, status: terminalStatus(counts.succeeded, counts.failed),
    notify: counts.succeeded + counts.failed > 0, ...counts };
}

export interface FinishRenderGroupExecution extends RenderGroupAttemptRef {
  readonly result: RenderGroupExecutionResult;
  readonly errorCode: string | null;
  readonly failureDisposition: ClipRenderFailureDisposition | null;
}

function terminalStatus(succeeded: number, failed: number): "completed" | "partial" | "failed" {
  return failed === 0 ? "completed" : succeeded > 0 ? "partial" : "failed";
}

function assertAttemptCount(count: number): void {
  if (!Number.isInteger(count) || count < 0 || count > RENDER_GROUP_MAX_ATTEMPTS) {
    throw new Error("Invalid render group charged attempt count");
  }
}

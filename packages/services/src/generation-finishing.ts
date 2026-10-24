import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  clipExportDurationSec,
  finishingPicksSchema,
  finishingReasonMessage,
  finishingSettingsSchema,
  freezeFinishingSettings,
  frozenFinishingSettingsSchema,
  type ClipAspectRatio,
  type ClipRenderResolution,
  type FinishingPick,
  type FinishingRanking,
  type FinishingReason,
  type FinishingSettings,
  type FinishingState,
  type FrozenFinishingSettings,
  type SocialPlatform,
} from "@narriflow/validators";
import { ExpectedDomainFailureError, type ExpectedDomainFailureCatalog } from "./expected-domain-failure";
import { deriveGenerationStatus, encodeOperationId, readGenerationLineage, type OperationState } from "./operation-status";
import { hasFeature } from "./plan-features";
import { rankClips, readAppliedGuidance } from "./performance-guidance";
import { accessibleProjectWhere } from "./project-access";
import { uuidV5 } from "./uuid-v5";
import { flushWorkspaceEvents, queueWorkspaceEvent } from "./workspace-event";

/** Finishing: after a generation completes, export its best clips and write
 * assisted copy as the person who asked, then leave the Project ready to
 * review. See `GenerationFinishing` in the schema for the row's life.
 *
 * Two kinds of function live here. The transaction helpers (`freeze…`,
 * `transition…`) are called inside other lifecycles' transactions and only
 * touch this table, so they add no lock the Workflow Run lifecycle doesn't
 * already order. The runner claims `due` rows and does the work outside any
 * long transaction. */

type Tx = Prisma.TransactionClient;

const finishingFailureCatalog = {
  finishing_origin_invalid: "invalid",
} as const satisfies ExpectedDomainFailureCatalog<string>;

export class GenerationFinishingError extends ExpectedDomainFailureError<keyof typeof finishingFailureCatalog> {
  constructor(code: keyof typeof finishingFailureCatalog, message: string) {
    super({ code, kind: finishingFailureCatalog[code], message });
    this.name = "GenerationFinishingError";
  }
}

/** A Date as the UTC `timestamp` the table stores, whatever the session zone. */
const utc = (date: Date) => Prisma.sql`(${date.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;

/** Namespace of the idempotency keys derived from a finishing row. */
const FINISHING_KEY_NAMESPACE = "3f6c1a52-8d47-5b9e-a0c3-7e2d94b6f118";
/** An export is for one clip revision, so the revision is part of its key: a
 * clip edited mid-run gets a new key, never a replay of the old revision. */
export const finishingExportKey = (finishingId: string, clipId: string, revision: number) => uuidV5(FINISHING_KEY_NAMESPACE, `export:${finishingId}:${clipId}:${revision}`);
/** A copy generation that failed stays failed under its key, so each retry
 * after a transient failure counts up and gets a fresh one. */
export const finishingCopyKey = (finishingId: string, clipId: string, attempt: number) => uuidV5(FINISHING_KEY_NAMESPACE, `copy:${finishingId}:${clipId}:${attempt}`);
/** One proposal per picked clip and queue account, so a re-claim finds the one it made. */
export const finishingQueueKey = (finishingId: string, clipId: string, accountId: string) => uuidV5(FINISHING_KEY_NAMESPACE, `queue:${finishingId}:${clipId}:${accountId}`);

export const FINISHING_LEASE_MS = 5 * 60 * 1000;
/** Exports that haven't finished this long after finishing became due count as failed. */
export const FINISHING_MAX_WAIT_MS = 6 * 60 * 60 * 1000;
export const FINISHING_MAX_ATTEMPTS = 5;
/** How often a clip edited mid-run is exported again at its new revision. */
const MAX_REVISION_RETRIES = 3;

// --- Transaction helpers --------------------------------------------------

/** Two frozen settings ask for the same finishing when only the order of their
 * formats or platforms differs. */
export function sameFinishingSettings(a: FrozenFinishingSettings, b: FrozenFinishingSettings): boolean {
  const sorted = (values: readonly string[]) => [...values].sort().join(",");
  return a.topClips === b.topClips && a.minScore === b.minScore && a.resolution === b.resolution && a.delivery === b.delivery
    && sorted(a.aspectRatios) === sorted(b.aspectRatios) && sorted(a.copyPlatforms) === sorted(b.copyPlatforms)
    && sorted(a.queueAccountIds) === sorted(b.queueAccountIds);
}

/** Freezes the requested settings for one generation, in the transaction that
 * admits it. The origin run, which must be a generation's speech-to-text run,
 * keys the row, so retries and replays find it. The first freeze wins: `matches`
 * says whether an existing row asks for the same finishing, and `ended` whether
 * it already ran. */
export async function freezeGenerationFinishing(tx: Tx, input: {
  workspaceId: string;
  projectId: string;
  originRunId: string;
  actorUserId: string | null;
  settings: FinishingSettings;
  /** The Autopilot rule whose import asked for this finishing, from its Content Pack. Only the
   * import sets it; Standing Grants cover finishing by it and by nothing else. */
  autopilotRuleId?: string | null;
  /** The generation's own default, used when the settings name no format. */
  defaultAspectRatio: ClipAspectRatio;
}): Promise<{ created: boolean; matches: boolean; ended: boolean }> {
  const origin = await tx.workflowRun.findUnique({ where: { id: input.originRunId }, select: { stage: true, projectId: true } });
  // Only a speech-to-text run is a generation's origin; any other run never transitions.
  if (!origin || origin.stage !== "stt" || origin.projectId !== input.projectId) {
    throw new GenerationFinishingError("finishing_origin_invalid", "Finishing belongs to a generation's speech-to-text run.");
  }
  const settings = freezeFinishingSettings(input.settings, input.defaultAspectRatio);
  const created = await tx.generationFinishing.createMany({
    data: [{
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      originRunId: input.originRunId,
      actorUserId: input.actorUserId,
      settings: settings as Prisma.InputJsonValue,
      autopilotRuleId: input.autopilotRuleId ?? null,
    }],
    skipDuplicates: true,
  });
  if (created.count === 1) return { created: true, matches: true, ended: false };
  const existing = await tx.generationFinishing.findUniqueOrThrow({ where: { originRunId: input.originRunId }, select: { settings: true, state: true } });
  return {
    created: false,
    matches: sameFinishingSettings(frozenFinishingSettingsSchema.parse(existing.settings), settings),
    ended: ["ready", "partial", "skipped"].includes(existing.state),
  };
}

type FinishedGenerationState = Exclude<OperationState, "working">;

/** The transition beside the generation's `operation.finished`: a completed or
 * partial generation makes finishing due; a failed or cancelled one skips it.
 * A plain update of this table's own row (never the Workspace counter), with
 * the skip's event queued for the transaction's flush. */
export async function transitionGenerationFinishing(tx: Tx, originRunId: string, state: FinishedGenerationState, now = new Date()): Promise<void> {
  const row = await tx.generationFinishing.findUnique({ where: { originRunId }, select: { id: true, workspaceId: true, projectId: true, state: true } });
  if (!row || row.state !== "waiting") return;
  if (state === "completed" || state === "partial") {
    await tx.generationFinishing.updateMany({ where: { id: row.id, state: "waiting" }, data: { state: "due", dueAt: now } });
    return;
  }
  const reason: FinishingReason = state === "cancelled" ? "generation_cancelled" : "generation_failed";
  const skipped = await tx.generationFinishing.updateMany({ where: { id: row.id, state: "waiting" }, data: { state: "skipped", reason, finishedAt: now } });
  if (skipped.count === 1) queueFinishingFinished(tx, { ...row, originRunId, state: "skipped", reason, exportIds: [] });
}

/** For a freeze on a generation that may already be finished: apply the
 * transition now, since its settlement will not run again. Only queues events;
 * the caller flushes them as its last act. */
export async function queueSettledGenerationFinishing(tx: Tx, projectId: string, originRunId: string): Promise<void> {
  const lineage = await readGenerationLineage(tx, projectId, originRunId);
  if (!lineage) return;
  const { state } = deriveGenerationStatus(lineage);
  if (state === "working") return;
  await transitionGenerationFinishing(tx, originRunId, state);
}

/** `queueSettledGenerationFinishing`, flushed at once. */
export async function settleFinishedGenerationFinishing(tx: Tx, projectId: string, originRunId: string): Promise<void> {
  await queueSettledGenerationFinishing(tx, projectId, originRunId);
  await flushWorkspaceEvents(tx);
}

function queueFinishingFinished(tx: Tx, input: { id: string; workspaceId: string; projectId: string; originRunId: string; state: "ready" | "partial" | "skipped"; reason: string | null; exportIds: string[] }) {
  queueWorkspaceEvent(tx, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    type: "finishing.finished",
    subject: { projectId: input.projectId, operation: { kind: "generation", id: encodeOperationId({ kind: "generation", id: input.originRunId }) }, state: input.state, reason: input.reason, exportIds: input.exportIds },
    dedupeKey: `finishing.finished:${input.id}`,
  });
}

// --- The runner -------------------------------------------------------------

interface ClaimedRow {
  id: string;
  workspaceId: string;
  projectId: string;
  originRunId: string;
  actorUserId: string | null;
  settings: unknown;
  picks: unknown;
  attempts: number;
  dueAt: Date | null;
  claimToken: string;
}

export interface GenerationFinishingDependencies {
  prisma: PrismaClient;
  now?: () => Date;
  /** Throws when the person has lost access; returns the Workspace's plan. */
  requireActor(userId: string, workspaceId: string): Promise<{ pricingTier: string }>;
  /** Whether the person can manage publishing now. Settings are saved by one
   * member and run as another (a shared Recipe), so proposing posts to a
   * queue is checked again when it runs. */
  canManagePublishing(userId: string, workspaceId: string): Promise<boolean>;
  /** Creates (or finds) the Clip Export for one clip revision. Called with a
   * key derived from the finishing row, clip and revision, so repeats return
   * one export. `reused` says an earlier export of this revision and these
   * formats answered, whatever its state. */
  createExport(
    scope: { actorUserId: string; workspaceId: string },
    projectId: string,
    clipId: string,
    input: { expectedRevision: number; aspectRatios: ClipAspectRatio[]; resolution: ClipRenderResolution },
    idempotencyKey: string,
  ): Promise<{ export: { id: string; status: string }; reused: boolean }>;
  /** Requeues the failed formats of an export, as the Exports page does. */
  retryExport(scope: { actorUserId: string; workspaceId: string }, projectId: string, clipId: string, exportId: string): Promise<unknown>;
  /** Writes assisted copy for one clip on every platform, under the given key. */
  writeCopy(input: { actorUserId: string; workspaceId: string; projectId: string; clipId: string; platforms: SocialPlatform[]; idempotencyKey: string }): Promise<{ id: string }>;
  /** The Workspace's active accounts among those a queue-delivery setting names. */
  queueAccounts(workspaceId: string, accountIds: string[]): Promise<Array<{ id: string; platform: SocialPlatform }>>;
  /** Proposes one picked clip to one account's Publishing Queue, using the
   * platform's variant of the pick's copy. The key is derived from the finishing
   * row, so a repeat returns the proposal made before. */
  propose(input: { actorUserId: string; workspaceId: string; clipId: string; exportId: string; socialAccountId: string; copyGenerationId: string; idempotencyKey: string }): Promise<{ proposal: { proposalId: string } }>;
  /** Accepts a just-proposed post under the publish Standing Grant that covers its
   * rule and account, if there is one. Returns `accepted`, or why the post stays a
   * proposal (`no_grant` when nothing covers it). A refusal is an outcome, not an error. */
  acceptUnderGrant(input: { finishingId: string; workspaceId: string; projectId: string; proposalId: string }): Promise<string>;
  /** Sends the finished exports as a Review Round under the review-send Standing
   * Grant that covers the Project's rule. At most one round per finishing row; a
   * repeat finds it. A refusal says why, and the row ends with that reason. */
  sendReviewRound(input: { finishingId: string; workspaceId: string; projectId: string; exportIds: string[] }): Promise<{ sent: true } | { sent: false; reason: FinishingReason }>;
  /** The "clips ready to review" notification to the acting user, through the
   * existing path. `sourceId` is the finishing row's id. Best effort. */
  notify(input: { projectId: string; sourceId: string; clipCount: number }): Promise<void>;
}

class ClaimLost extends Error {
  constructor() {
    super("Finishing claim was lost");
    this.name = "FinishingClaimLost";
  }
}

const EXPORT_TERMINAL = ["ready", "partial_ready", "failed"];
const EXPORT_USABLE = ["ready", "partial_ready"];
/** An export that failed or lost a format can be requeued instead of reported. */
const EXPORT_RETRYABLE = ["failed", "partial_ready"];

/** A copy failure worth another attempt: the provider or store was unavailable,
 * or an earlier attempt never settled. Anything else stays final for its key. */
function transientCopyFailure(error: unknown) {
  if (!(error instanceof ExpectedDomainFailureError)) return true;
  return error.kind === "unavailable" || error.kind === "rate_limited" || error.code === "assisted_copy_generation_in_progress";
}

function log(message: string, context: Record<string, unknown>) {
  console.warn(JSON.stringify({ level: "info", message, ...context }));
}

export function createGenerationFinishing(deps: GenerationFinishingDependencies) {
  const { prisma } = deps;
  const now = () => deps.now?.() ?? new Date();

  /** Rows parked while their exports render wake here, in one statement, once
   * every export is terminal or the wait ran out. A poll costs no claim, so
   * waiting rows never use up a batch that new work could use. */
  async function wakeExporting(): Promise<void> {
    const at = now();
    await prisma.$executeRaw`
      UPDATE "GenerationFinishing" AS f SET "state" = 'due', "updatedAt" = ${utc(at)}
      WHERE f."state" = 'exporting'
        AND (f."dueAt" <= ${utc(new Date(at.getTime() - FINISHING_MAX_WAIT_MS))}
          OR NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(f."picks") AS pick
            JOIN "ClipExport" AS e ON e."id" = (pick->>'exportId')::uuid
            WHERE e."status" NOT IN ('ready', 'partial_ready', 'failed')))
    `;
  }

  /** Claims the next due row, or one whose lease ran out. Reclaiming a lapsed
   * lease counts as an attempt, so a row that keeps killing its worker ends. */
  async function claimNext(): Promise<ClaimedRow | null> {
    const at = now();
    const [row] = await prisma.$queryRaw<ClaimedRow[]>`
      UPDATE "GenerationFinishing" SET "state" = 'running', "claimToken" = ${randomUUID()}::uuid,
        "attempts" = CASE WHEN "state" = 'running' THEN "attempts" + 1 ELSE "attempts" END,
        "leaseExpiresAt" = ${utc(new Date(at.getTime() + FINISHING_LEASE_MS))}, "updatedAt" = ${utc(at)}
      WHERE "id" = (
        SELECT "id" FROM "GenerationFinishing"
        WHERE ("state" = 'due' AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= ${utc(at)}))
           OR ("state" = 'running' AND "leaseExpiresAt" <= ${utc(at)})
        ORDER BY COALESCE("nextAttemptAt", "dueAt"), "id" FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING "id", "workspaceId", "projectId", "originRunId", "actorUserId", "settings", "picks", "attempts", "dueAt", "claimToken"
    `;
    return row ?? null;
  }

  /** Writes only while this claim still owns the row. */
  async function save(row: ClaimedRow, data: Prisma.GenerationFinishingUncheckedUpdateManyInput) {
    const written = await prisma.generationFinishing.updateMany({ where: { id: row.id, state: "running", claimToken: row.claimToken }, data });
    if (written.count !== 1) throw new ClaimLost();
  }
  const savePicks = (row: ClaimedRow, picks: FinishingPick[]) => save(row, { picks: picks as Prisma.InputJsonValue });
  const renew = (row: ClaimedRow) => save(row, { leaseExpiresAt: new Date(now().getTime() + FINISHING_LEASE_MS) });

  async function exportStatuses(picks: FinishingPick[]) {
    const ids = picks.flatMap((pick) => (pick.exportId ? [pick.exportId] : []));
    const rows = ids.length ? await prisma.clipExport.findMany({ where: { id: { in: ids } }, select: { id: true, status: true } }) : [];
    return new Map(rows.map((entry) => [entry.id, entry.status as string]));
  }

  /** Ends the row and writes its one `finishing.finished` event in the same
   * transaction. The event names the exports that are usable now. */
  async function finish(row: ClaimedRow, outcome: { state: "ready" | "partial" | "skipped"; reason: FinishingReason | null; picks: FinishingPick[] }) {
    const statuses = await exportStatuses(outcome.picks);
    const exportIds = outcome.picks.flatMap((pick) => (pick.exportId && !pick.exportError && EXPORT_USABLE.includes(statuses.get(pick.exportId) ?? "failed") ? [pick.exportId] : []));
    await prisma.$transaction(async (tx) => {
      const ended = await tx.generationFinishing.updateMany({
        where: { id: row.id, state: "running", claimToken: row.claimToken },
        data: { state: outcome.state, reason: outcome.reason, picks: outcome.picks as Prisma.InputJsonValue, finishedAt: now(), claimToken: null, leaseExpiresAt: null, nextAttemptAt: null },
      });
      if (ended.count !== 1) throw new ClaimLost();
      queueFinishingFinished(tx, { ...row, state: outcome.state, reason: outcome.reason, exportIds });
      // The Workspace counter is the last lock this transaction takes.
      await flushWorkspaceEvents(tx);
    });
    log("generation_finishing_finished", { finishingId: row.id, projectId: row.projectId, state: outcome.state, reason: outcome.reason });
  }

  /** Why the person this runs for can no longer have it run, if so. */
  async function refusal(row: ClaimedRow): Promise<FinishingReason | null> {
    if (!row.actorUserId) return "actor_unavailable";
    let tier: string;
    try {
      tier = (await deps.requireActor(row.actorUserId, row.workspaceId)).pricingTier;
    } catch (error) {
      if (error instanceof ExpectedDomainFailureError) return "actor_unavailable";
      throw error;
    }
    // A downgrade since the settings were saved ends here; imports are unaffected.
    return hasFeature(tier, "campaign.operations") ? null : "plan_required";
  }

  /** The generation's clips at or above the minimum score, best first. When
   * the Workspace has Performance Guidance in force, "best" is the score times
   * a bounded factor from its audience data, and each pick keeps the factor it
   * was ranked with. The minimum is always checked against the plain score,
   * and a clip never overtakes one more than 15 points of score above it. */
  async function choose(row: ClaimedRow, settings: FrozenFinishingSettings): Promise<FinishingPick[]> {
    const lineage = await readGenerationLineage(prisma, row.projectId, row.originRunId);
    if (!lineage?.clipIds?.length) return [];
    const clips = await prisma.clip.findMany({
      where: { id: { in: lineage.clipIds }, projectId: row.projectId, viralityScore: { gte: settings.minScore } },
      select: { id: true, editorRevision: true, index: true, viralityScore: true, category: true, startSec: true, endSec: true, deletedRanges: true, sceneBlocks: true },
    });
    const applied = await readAppliedGuidance(prisma, row.workspaceId);
    // The length a clip's export will have, the measure its clip facts record.
    return rankClips(clips.map((clip) => ({ ...clip, durationSec: clipExportDurationSec(clip) })), applied)
      .slice(0, settings.topClips)
      .map(({ clip, ranking }) => ({ clipId: clip.id, editorRevision: clip.editorRevision, ...(ranking ? { ranking } : {}) }));
  }

  /** Exports one pick at its clip's revision. A clip edited since it was
   * picked is exported again at the revision it has now, under a key for that
   * revision. An export of this revision that already failed is requeued
   * through the Exports page's own retry rather than reported failed. */
  async function exportPick(row: ClaimedRow, scope: { actorUserId: string; workspaceId: string }, settings: FrozenFinishingSettings, pick: FinishingPick, picks: FinishingPick[]) {
    for (let revisions = 0; revisions <= MAX_REVISION_RETRIES; revisions += 1) {
      try {
        const created = await deps.createExport(scope, row.projectId, pick.clipId,
          { expectedRevision: pick.editorRevision, aspectRatios: settings.aspectRatios, resolution: settings.resolution },
          finishingExportKey(row.id, pick.clipId, pick.editorRevision));
        if (created.reused && EXPORT_RETRYABLE.includes(created.export.status)) {
          try {
            await deps.retryExport(scope, row.projectId, pick.clipId, created.export.id);
          } catch (error) {
            if (!(error instanceof ExpectedDomainFailureError)) throw error;
          }
        }
        pick.exportId = created.export.id;
        return;
      } catch (error) {
        if (!(error instanceof ExpectedDomainFailureError)) throw error;
        if (error.code === "editor_revision_conflict") {
          const current = await prisma.clip.findUnique({ where: { id: pick.clipId }, select: { editorRevision: true } });
          if (current && current.editorRevision !== pick.editorRevision) {
            pick.editorRevision = current.editorRevision;
            await savePicks(row, picks);
            continue;
          }
        }
        pick.exportError = error.code;
        return;
      }
    }
    pick.exportError = "editor_revision_conflict";
  }

  async function run(row: ClaimedRow): Promise<void> {
    const settings = frozenFinishingSettingsSchema.parse(row.settings);
    if (row.attempts >= FINISHING_MAX_ATTEMPTS) return endFailed(row);
    let picks = row.picks == null ? null : finishingPicksSchema.parse(row.picks);

    // Before anything is picked, a person or plan that no longer qualifies
    // skips the row. Once exports exist, finishing keeps them: it ends
    // partial with that reason, and never throws them away.
    const refused = await refusal(row);
    if (refused) {
      const kept = picks ?? [];
      return finish(row, { state: kept.some((pick) => pick.exportId) ? "partial" : "skipped", reason: refused, picks: kept });
    }
    const actor = { actorUserId: row.actorUserId!, workspaceId: row.workspaceId };

    // Choose once. The picks stay with the row, so a re-claim resumes them.
    if (!picks) {
      picks = await choose(row, settings);
      await savePicks(row, picks);
    }
    if (picks.length === 0) return finish(row, { state: "skipped", reason: "no_clips", picks });

    // Exports. The derived key makes a repeat return the export it made before.
    for (const pick of picks) {
      if (pick.exportId || pick.exportError) continue;
      await renew(row);
      await exportPick(row, actor, settings, pick, picks);
      await savePicks(row, picks);
    }

    // Park the row while the renders run. It wakes without a claim.
    const statuses = await exportStatuses(picks);
    const unfinished = picks.filter((pick) => pick.exportId && !EXPORT_TERMINAL.includes(statuses.get(pick.exportId) ?? "failed"));
    if (unfinished.length > 0) {
      if (now().getTime() - (row.dueAt ?? now()).getTime() < FINISHING_MAX_WAIT_MS) {
        return save(row, { state: "exporting", nextAttemptAt: null, claimToken: null, leaseExpiresAt: null });
      }
      for (const pick of unfinished) pick.exportError = "export_timeout";
      await savePicks(row, picks);
    }
    const usable = (pick: FinishingPick) => Boolean(pick.exportId && EXPORT_USABLE.includes(statuses.get(pick.exportId) ?? "failed") && !pick.exportError);

    // Queue delivery proposes to accounts that must still be active now, and
    // each needs its platform's copy, so those platforms are written too.
    const proposes = settings.delivery === "propose_to_queue";
    const mayPropose = !proposes || await deps.canManagePublishing(actor.actorUserId, row.workspaceId);
    const queue = proposes && mayPropose
      ? await resolveQueue(row.workspaceId, settings.queueAccountIds)
      : null;
    const copyPlatforms = [...new Set([...settings.copyPlatforms, ...(queue?.accounts.map((account) => account.platform) ?? [])])];

    // Copy, per picked clip across every chosen platform. A transient failure
    // counts the pick's attempt up (a fresh key next time) and releases the row
    // to back off; any other failure is final for the clip and ends it partial.
    if (copyPlatforms.length > 0) {
      for (const pick of picks) {
        if (!usable(pick) || pick.copyGenerationId || pick.copyError) continue;
        await renew(row);
        try {
          const copy = await deps.writeCopy({ ...actor, projectId: row.projectId, clipId: pick.clipId, platforms: copyPlatforms,
            idempotencyKey: finishingCopyKey(row.id, pick.clipId, pick.copyAttempt ?? 0) });
          pick.copyGenerationId = copy.id;
        } catch (error) {
          if (transientCopyFailure(error)) {
            pick.copyAttempt = (pick.copyAttempt ?? 0) + 1;
            await savePicks(row, picks);
            throw error;
          }
          pick.copyError = error instanceof ExpectedDomainFailureError ? error.code : "copy_failed";
        }
        await savePicks(row, picks);
      }
    }

    // Queue: after copy is ready, propose each picked clip to each account, in
    // account order. A proposal the queue refuses is final for that clip and
    // account and doesn't stop the other accounts; anything unexpected releases
    // the row, and the derived keys make the retry repeat nothing.
    if (queue) {
      for (const pick of picks) {
        if (!usable(pick) || !pick.copyGenerationId) continue;
        pick.queue ??= {};
        const results = pick.queue;
        for (const account of queue.accounts) {
          if (results[account.id]) continue;
          await renew(row);
          try {
            const { proposal } = await deps.propose({ ...actor, clipId: pick.clipId, exportId: pick.exportId!, socialAccountId: account.id, copyGenerationId: pick.copyGenerationId,
              idempotencyKey: finishingQueueKey(row.id, pick.clipId, account.id) });
            // A grant that covers this rule and account takes the proposal into its slot; otherwise it waits for a person.
            const granted = await deps.acceptUnderGrant({ finishingId: row.id, workspaceId: row.workspaceId, projectId: row.projectId, proposalId: proposal.proposalId });
            if (granted !== "no_grant") {
              pick.grant = { ...pick.grant, [account.id]: granted };
              if (granted !== "accepted") log("generation_finishing_grant_refused", { finishingId: row.id, projectId: row.projectId, socialAccountId: account.id, outcome: granted });
            }
            results[account.id] = "proposed";
          } catch (error) {
            if (!(error instanceof ExpectedDomainFailureError)) throw error;
            results[account.id] = error.code;
          }
          await savePicks(row, picks);
        }
      }
    }

    const exportCount = picks.filter(usable).length;
    const exportsReady = picks.every((pick) => usable(pick) && statuses.get(pick.exportId!) === "ready");
    const copyWritten = copyPlatforms.length === 0 || picks.every((pick) => pick.copyGenerationId);
    const queued = !queue || (queue.missing === 0 && picks.every((pick) => queue.accounts.every((account) => pick.queue?.[account.id] === "proposed")));
    const complete = exportsReady && copyWritten && queued && mayPropose;
    // A finished generation is sent for review under the rule's grant. The round is keyed by this
    // row, so a re-claim finds it; a refusal leaves the clips for a person and says why.
    let reviewReason: FinishingReason | null = null;
    if (complete && settings.delivery === "send_review_round") {
      const sent = await deps.sendReviewRound({ finishingId: row.id, workspaceId: row.workspaceId, projectId: row.projectId, exportIds: picks.filter(usable).map((pick) => pick.exportId!) });
      if (!sent.sent) reviewReason = sent.reason;
    }
    const reason: FinishingReason | null = complete ? reviewReason
      : !exportsReady ? "exports_failed"
        : !copyWritten ? "copy_failed"
          : !mayPropose ? "actor_lacks_publishing"
            : queue && queue.missing > 0 ? "queue_account_unavailable" : "queue_failed";
    // The ledger keys the notification by the row, so a repeat sends nothing.
    if (exportCount > 0) await deps.notify({ projectId: row.projectId, sourceId: row.id, clipCount: exportCount }).catch((error) => {
      log("generation_finishing_notification_failed", { finishingId: row.id, error: error instanceof Error ? error.message : String(error) });
    });
    await finish(row, { state: complete && !reviewReason ? "ready" : "partial", reason, picks });
  }

  /** The queue accounts still active in the Workspace, and how many named ones are not. */
  async function resolveQueue(workspaceId: string, accountIds: string[]) {
    const accounts = await deps.queueAccounts(workspaceId, accountIds);
    return { accounts, missing: new Set(accountIds).size - accounts.length };
  }

  /** An unexpected failure releases the row to try again, until the budget runs out. */
  async function fail(row: ClaimedRow, error: unknown) {
    const attempts = row.attempts + 1;
    log("generation_finishing_attempt_failed", { finishingId: row.id, projectId: row.projectId, attempts, error: error instanceof Error ? error.message : String(error) });
    if (attempts < FINISHING_MAX_ATTEMPTS) {
      await save(row, { state: "due", attempts, nextAttemptAt: new Date(now().getTime() + Math.min(2 ** attempts * 30_000, 15 * 60_000)), claimToken: null, leaseExpiresAt: null });
      return;
    }
    await endFailed(row);
  }

  /** Out of attempts: report what exists. Exports already made stay linked,
   * so read the picks this claim saved, not the ones it started with. */
  async function endFailed(row: ClaimedRow) {
    const current = await prisma.generationFinishing.findUnique({ where: { id: row.id }, select: { picks: true } });
    const picks = finishingPicksSchema.catch([]).parse(current?.picks ?? row.picks);
    await finish(row, { state: picks.some((pick) => pick.exportId) ? "partial" : "skipped", reason: "finishing_failed", picks });
  }

  return {
    /** Wakes rows whose exports finished, then claims and runs due rows, up to
     * `limit`. Returns how many it ran. */
    async processDue(limit = 3): Promise<number> {
      await wakeExporting();
      let handled = 0;
      while (handled < limit) {
        const row = await claimNext();
        if (!row) break;
        handled += 1;
        try {
          await run(row);
        } catch (error) {
          if (error instanceof ClaimLost) continue;
          try { await fail(row, error); } catch (inner) { if (!(inner instanceof ClaimLost)) throw inner; }
        }
      }
      return handled;
    },
  };
}

// --- Reading ------------------------------------------------------------------

export interface ProjectFinishingView {
  id: string;
  state: FinishingState;
  reason: string | null;
  message: string | null;
  /** The clips finishing chose, with the export each one produced and, when
   * it ranked with the Workspace's audience data, the factor it used. */
  clips: Array<{ clipId: string; title: string; exportId: string | null; exportStatus: string | null; copyWritten: boolean; ranking: FinishingRanking | null }>;
  /** Finishing ranked these clips with the Workspace's audience data. */
  rankedWithAudienceData: boolean;
}

/** The newest finishing on a Project, for the Project page. */
export async function readProjectFinishing(db: Pick<PrismaClient, "generationFinishing" | "clip" | "clipExport">, scope: { workspaceId: string; projectId: string }): Promise<ProjectFinishingView | null> {
  const row = await db.generationFinishing.findFirst({ where: { projectId: scope.projectId, workspaceId: scope.workspaceId, project: { ...accessibleProjectWhere() } }, orderBy: { createdAt: "desc" } });
  if (!row) return null;
  const picks = finishingPicksSchema.catch([]).parse(row.picks);
  const [clips, exports] = await Promise.all([
    picks.length ? db.clip.findMany({ where: { id: { in: picks.map((pick) => pick.clipId) } }, select: { id: true, title: true, hookText: true } }) : [],
    picks.some((pick) => pick.exportId) ? db.clipExport.findMany({ where: { id: { in: picks.flatMap((pick) => (pick.exportId ? [pick.exportId] : [])) } }, select: { id: true, status: true } }) : [],
  ]);
  const clipOf = new Map(clips.map((clip) => [clip.id, clip.title?.trim() || clip.hookText]));
  const statusOf = new Map(exports.map((entry) => [entry.id, entry.status as string]));
  return {
    id: row.id,
    state: row.state as FinishingState,
    reason: row.reason,
    message: finishingReasonMessage(row.reason),
    clips: picks.map((pick) => ({ clipId: pick.clipId, title: clipOf.get(pick.clipId) ?? "Clip", exportId: pick.exportId ?? null,
      exportStatus: pick.exportId ? (statusOf.get(pick.exportId) ?? null) : null, copyWritten: Boolean(pick.copyGenerationId), ranking: pick.ranking ?? null })),
    rankedWithAudienceData: picks.some((pick) => pick.ranking),
  };
}

/** The Content Pack column that carries requested finishing from acceptance
 * to the generation that freezes it. */
export function finishingColumn(context?: { finishing?: FinishingSettings | null } | null) {
  return context?.finishing ? { finishing: finishingSettingsSchema.parse(context.finishing) as Prisma.InputJsonValue } : {};
}

import type {
  Prisma,
  PrismaClient,
  ProcessingIntakeKind,
  ProcessingUsageReservation,
  ProcessingUsageState,
} from "@prisma/client";
import {
  creditDebitSeconds,
  creditsForSourceSeconds,
  lowestTier,
  planDefinition,
  planLimits,
  processingPeriodEnd,
  processingPeriodStart,
  resolvePricingTier,
  type PricingTier,
} from "@narriflow/validators";
import {
  ExpectedDomainFailureError,
  type ExpectedDomainFailureCatalog,
} from "./expected-domain-failure";

type Tx = Prisma.TransactionClient;

/** Interactive-transaction bounds for any transaction that admits, settles,
 * or resizes usage. Admissions can queue on the Workspace lock under bursts,
 * so Prisma's 2 s wait and 5 s lifetime defaults are too short. */
export const PROCESSING_USAGE_TRANSACTION = {
  maxWait: 10_000,
  timeout: 20_000,
} as const;
type Db = Tx | PrismaClient;

export const processingUsageFailureCatalog = {
  credits_exhausted: "payment_required",
  upload_too_long: "unprocessable",
  workspace_processing_capacity_reached: "rate_limited",
  /** The intake's reservation was released (for example by the stranded
   * sweep) before settlement; a manual retry re-admits it. */
  credits_reservation_released: "conflict",
} as const satisfies ExpectedDomainFailureCatalog<string>;

export type ProcessingUsageFailureCode =
  keyof typeof processingUsageFailureCatalog;

/** Retry guidance for a capacity refusal; capacity frees as soon as one
 * in-flight video reaches a terminal state. */
const CAPACITY_RETRY_AFTER_SECONDS = 60;
const MAX_REASON_LENGTH = 120;

export type ProcessingUsageFailureDetails =
  | {
      tier: PricingTier;
      limitCredits: number;
      remainingCredits: number;
      /** Settled plus reserved credits this period. Unlike `limit - remaining`,
       * it survives a downgrade that leaves spending above the limit. */
      spentCredits: number;
      requestedCredits: number | null;
      renewsAt: string;
    }
  | {
      tier: PricingTier;
      maxSeconds: number;
      seconds: number;
      /** Settled plus reserved credits this period, so an upgrade offer can
       * require room for this video's credits as well as its length. */
      spentCredits: number;
      requestedCredits: number;
    }
  | { tier: PricingTier; inFlight: number; inFlightLimit: number }
  | { tier: PricingTier };

export class ProcessingUsageError extends ExpectedDomainFailureError<
  ProcessingUsageFailureCode,
  ProcessingUsageFailureDetails
> {
  constructor(input: {
    code: ProcessingUsageFailureCode;
    message: string;
    details: ProcessingUsageFailureDetails;
    retryAfterSeconds?: number;
  }) {
    super({ ...input, kind: processingUsageFailureCatalog[input.code] });
    this.name = "ProcessingUsageError";
  }
}

export function isProcessingUsageFailureCode(
  code: string | null | undefined,
): code is ProcessingUsageFailureCode {
  return Boolean(code && Object.hasOwn(processingUsageFailureCatalog, code));
}

function creditsExhausted(input: {
  tier: PricingTier;
  periodStart: Date;
  remainingSeconds: number;
  requestedSeconds: number | null;
}) {
  const plan = planDefinition(input.tier);
  const limitCredits = plan.limits.monthlyCredits;
  // Ledger debits are whole credits, so remaining seconds are a multiple of 60.
  const remainingCredits = Math.max(0, Math.floor(input.remainingSeconds / 60));
  // `remainingSeconds` is unclamped, so a downgrade below current spending still reports the real total.
  const spentCredits = Math.max(0, limitCredits - Math.floor(input.remainingSeconds / 60));
  const requestedCredits =
    input.requestedSeconds === null
      ? null
      : creditsForSourceSeconds(input.requestedSeconds);
  const renewsAt = processingPeriodEnd(input.periodStart);
  const renewal = renewsAt.toISOString().slice(0, 10);
  // Only promise more credits when a bigger monthly allowance would cover this video.
  const needed = spentCredits + (requestedCredits ?? 1);
  const biggerPlan = lowestTier((candidate) => candidate.limits.monthlyCredits >= needed && candidate.limits.monthlyCredits > limitCredits);
  const upgradeNote = biggerPlan ? ", or upgrade for more" : "";
  return new ProcessingUsageError({
    code: "credits_exhausted",
    message:
      requestedCredits === null || remainingCredits <= 0
        ? `This workspace has used its ${limitCredits} ${plan.name} credits for this month. Credits renew on ${renewal} (UTC)${upgradeNote}.`
        : `This video needs ${requestedCredits} credits, but the workspace has ${remainingCredits} of ${limitCredits} ${plan.name} credits left this month. Credits renew on ${renewal} (UTC)${upgradeNote}.`,
    details: {
      tier: input.tier,
      limitCredits,
      remainingCredits,
      spentCredits,
      requestedCredits,
      renewsAt: renewsAt.toISOString(),
    },
  });
}

function tooLong(tier: PricingTier, seconds: number, remainingSeconds: number) {
  const plan = planDefinition(tier);
  const maxSeconds = plan.limits.maxSourceSeconds;
  const spentCredits = Math.max(0, plan.limits.monthlyCredits - Math.floor(remainingSeconds / 60));
  const requestedCredits = creditsForSourceSeconds(seconds);
  // Only promise longer videos when a plan admits both this length and its credits
  // (Pro and Business share a three-hour ceiling).
  const longerPlan = lowestTier(
    (candidate) =>
      candidate.limits.maxSourceSeconds >= seconds &&
      candidate.limits.maxSourceSeconds > maxSeconds &&
      candidate.limits.monthlyCredits >= spentCredits + requestedCredits,
  );
  return new ProcessingUsageError({
    code: "upload_too_long",
    message: `This video is ${Math.ceil(seconds / 60)} min, over the ${Math.round(
      maxSeconds / 60,
    )}-min per-video limit on the ${plan.name} plan. ${longerPlan ? "Upgrade for longer videos." : "Choose a shorter video."}`,
    details: { tier, maxSeconds, seconds, spentCredits, requestedCredits },
  });
}

function reservationReleased(tier: PricingTier) {
  return new ProcessingUsageError({
    code: "credits_reservation_released",
    message: "This video's credit reservation was released before processing started. Retry the import to reserve credits again.",
    details: { tier },
  });
}

function capacityReached(tier: PricingTier, inFlight: number, limit: number) {
  return new ProcessingUsageError({
    code: "workspace_processing_capacity_reached",
    message: `This workspace already has ${inFlight} of ${limit} videos processing on the ${planDefinition(tier).name} plan. Try again when one finishes.`,
    details: { tier, inFlight, inFlightLimit: limit },
    retryAfterSeconds: CAPACITY_RETRY_AFTER_SECONDS,
  });
}

function inactiveWorkspace() {
  return new ExpectedDomainFailureError({
    code: "project_access_denied",
    kind: "forbidden",
    message: "This workspace can't start new processing.",
  });
}

function knownSeconds(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.ceil(value)
    : null;
}

function boundedReason(reason: string) {
  return reason.trim().slice(0, MAX_REASON_LENGTH) || "unspecified";
}

export interface ProcessingUsageReservationView {
  projectId: string;
  workspaceId: string;
  intakeKind: ProcessingIntakeKind;
  state: ProcessingUsageState;
  periodStart: Date;
  reservedSeconds: number;
  settledSeconds: number | null;
}

function view(row: ProcessingUsageReservation): ProcessingUsageReservationView {
  return {
    projectId: row.projectId,
    workspaceId: row.workspaceId,
    intakeKind: row.intakeKind,
    state: row.state,
    periodStart: row.periodStart,
    reservedSeconds: row.reservedSeconds,
    settledSeconds: row.settledSeconds,
  };
}

export type ProcessingUsageSettlement =
  /** The Project's credits are settled. `charged` is false when an earlier
   * speech-to-text admission already settled them. */
  | { outcome: "settled"; charged: boolean; settledSeconds: number }
  /** The reservation was released inside the caller's transaction. The caller
   * records the intake failure in the same transaction and commits. */
  | { outcome: "refused"; failure: ExpectedDomainFailureError }
  /** Ingest has not produced a measured source yet. Nothing changed. */
  | { outcome: "not_ready" };

export interface ProcessingUsageSummary {
  tier: PricingTier;
  usedCredits: number;
  reservedCredits: number;
  limitCredits: number;
  remainingCredits: number;
  /** Start of the UTC month these credits belong to. */
  periodStart: Date;
  /** When the next month's credits become available (UTC). */
  renewsAt: Date;
  inFlight: number;
  inFlightLimit: number;
  maxUploadSeconds: number;
}

export interface ProcessingUsageLogRecord {
  level: "info" | "warn";
  message: string;
  intent:
    | "reserve"
    | "resize"
    | "settle"
    | "release"
    | "refund"
    | "reconcile";
  disposition: string;
  workspaceId: string;
  projectId: string;
  intakeKind?: ProcessingIntakeKind;
  previousState?: ProcessingUsageState | null;
  nextState?: ProcessingUsageState;
  reservedSeconds?: number;
  settledSeconds?: number | null;
  remainingSeconds?: number;
  inFlight?: number;
  reason?: string;
  failureCode?: string;
}

export interface ProcessingUsageDependencies {
  prisma: PrismaClient;
  capacityLimits: Readonly<Record<PricingTier, number>>;
  now?: () => Date;
  log?: (record: ProcessingUsageLogRecord) => void;
}

/**
 * Processing Usage owns credit admission, reservation sizing, settlement from
 * the probed duration, release, operator refunds, the usage read model, and
 * Processing Capacity. Every mutation that can change another admission's
 * answer serializes on one transaction-scoped Workspace lock. Lock order is
 * fixed: this Workspace lock first, then any Project generation lock, then
 * row locks. Release only frees credits, so it is a lock-free compare-and-set.
 *
 * One credit is one started minute of source media. The ledger stores every
 * debit as whole credits in seconds (multiples of 60); per-video duration caps
 * compare the source's real seconds before rounding.
 */
/**
 * Takes the transaction-scoped Workspace usage lock. Every ledger mutation
 * takes it first, and Workspace Billing takes it before committing an access
 * projection change, so an admission cannot interleave with a restriction.
 * Lock order: this lock, then any Project generation lock, then row locks.
 */
export async function lockWorkspaceUsage(tx: Tx, workspaceId: string) {
  // A distinct key namespace from the Project generation lock, which hashes
  // the bare Project ID.
  const key = `processing_usage:${workspaceId}`;
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0)) IS NULL AS "locked"`;
}

export class ProcessingUsage {
  private readonly now: () => Date;
  private readonly log: (record: ProcessingUsageLogRecord) => void;

  constructor(private readonly deps: ProcessingUsageDependencies) {
    this.now = deps.now ?? (() => new Date());
    this.log =
      deps.log ??
      ((record) => console.warn(JSON.stringify(record)));
  }

  private lockWorkspace(tx: Tx, workspaceId: string) {
    return lockWorkspaceUsage(tx, workspaceId);
  }

  private async workspaceTier(db: Db, workspaceId: string) {
    const workspace = await db.workspace.findUnique({
      where: { id: workspaceId },
      select: { pricingTier: true, status: true },
    });
    if (!workspace) throw new Error("processing_usage_workspace_missing");
    return {
      tier: resolvePricingTier(workspace.pricingTier),
      status: workspace.status,
    };
  }

  private async periodUsage(db: Db, workspaceId: string, periodStart: Date) {
    const rows = await db.$queryRaw<
      Array<{ settled: number; reserved: number }>
    >`
      SELECT
        COALESCE(SUM("settledSeconds") FILTER (WHERE "state" = 'settled'), 0)::int AS "settled",
        COALESCE(SUM("reservedSeconds") FILTER (WHERE "state" = 'reserved'), 0)::int AS "reserved"
      FROM "ProcessingUsageReservation"
      WHERE "workspaceId" = ${workspaceId}::uuid AND "periodStart" = ${periodStart}
    `;
    return { settled: rows[0]?.settled ?? 0, reserved: rows[0]?.reserved ?? 0 };
  }

  private async remainingSeconds(
    db: Db,
    workspaceId: string,
    tier: PricingTier,
    periodStart: Date,
  ) {
    const usage = await this.periodUsage(db, workspaceId, periodStart);
    return planLimits(tier).monthlyCredits * 60 - usage.settled - usage.reserved;
  }

  /** Videos in flight: unsettled intakes still importing plus Projects with
   * an active Workflow Run or accepted export renders that have no run yet.
   * An ingested intake waiting for its owner to commit setup keeps its
   * credits reserved but no longer occupies capacity; it isn't processing. */
  private async inFlight(db: Db, workspaceId: string) {
    const rows = await db.$queryRaw<Array<{ inFlight: number }>>`
      SELECT (
        (SELECT COUNT(*) FROM "ProcessingUsageReservation" usage
          LEFT JOIN "Project" intake ON intake."id" = usage."projectId"
          WHERE usage."workspaceId" = ${workspaceId}::uuid AND usage."state" = 'reserved'
            AND (intake."id" IS NULL OR intake."ingestStatus" <> 'ready'))
        +
        (SELECT COUNT(*) FROM "Project" project
          WHERE project."workspaceId" = ${workspaceId}::uuid AND (
            EXISTS (SELECT 1 FROM "WorkflowRun" run
              WHERE run."projectId" = project."id" AND run."status" IN ('queued', 'running', 'waiting'))
            OR EXISTS (SELECT 1 FROM "ClipRender" render
              JOIN "Clip" clip ON clip."id" = render."clipId"
              WHERE clip."projectId" = project."id" AND render."status" = 'pending'
                AND render."workflowRunId" IS NULL)
          ))
      )::int AS "inFlight"
    `;
    return rows[0]?.inFlight ?? 0;
  }

  /**
   * Admits one intake in the caller's acceptance transaction. A repeated
   * admission for the same Project returns the original reservation. A
   * released reservation (manual retry) is re-admitted into the current
   * period with fresh allowance, per-video, and capacity checks.
   */
  async reserve(
    tx: Tx,
    input: {
      workspaceId: string;
      projectId: string;
      actorUserId: string | null;
      intakeKind: ProcessingIntakeKind;
      declaredSeconds?: number | null;
    },
  ): Promise<ProcessingUsageReservationView & { replayed: boolean }> {
    await this.lockWorkspace(tx, input.workspaceId);
    const existing = await tx.processingUsageReservation.findUnique({
      where: { projectId: input.projectId },
    });
    if (existing && existing.workspaceId !== input.workspaceId)
      throw new Error("processing_usage_workspace_mismatch");
    if (existing && existing.state !== "released")
      return { ...view(existing), replayed: true };

    const { tier, status } = await this.workspaceTier(tx, input.workspaceId);
    // Billing restrictions commit under this same lock, so an admission
    // authorized before a concurrent restriction cannot slip through.
    if (status !== "active") throw inactiveWorkspace();
    const periodStart = processingPeriodStart(this.now());
    const declared = knownSeconds(input.declaredSeconds);
    const maxSeconds = planLimits(tier).maxSourceSeconds;
    const refuse = (failure: ProcessingUsageError, context: { remainingSeconds?: number; inFlight?: number }) => {
      this.log({
        level: "warn",
        message: "processing_usage_reserve_refused",
        intent: "reserve",
        disposition: "refused",
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        intakeKind: input.intakeKind,
        previousState: existing?.state ?? null,
        failureCode: failure.code,
        ...context,
      });
      return failure;
    };
    const remainingSeconds = await this.remainingSeconds(
      tx,
      input.workspaceId,
      tier,
      periodStart,
    );
    if (declared !== null && declared > maxSeconds)
      throw refuse(tooLong(tier, declared, remainingSeconds), {});
    if (
      remainingSeconds <= 0 ||
      (declared !== null && creditDebitSeconds(declared) > remainingSeconds)
    )
      throw refuse(
        creditsExhausted({ tier, periodStart, remainingSeconds, requestedSeconds: declared }),
        { remainingSeconds },
      );
    const inFlight = await this.inFlight(tx, input.workspaceId);
    const inFlightLimit = this.deps.capacityLimits[tier];
    if (inFlight >= inFlightLimit)
      throw refuse(capacityReached(tier, inFlight, inFlightLimit), {
        remainingSeconds,
        inFlight,
      });

    // An unknown duration holds the most this video could cost.
    const reservedSeconds =
      declared === null
        ? Math.min(remainingSeconds, creditDebitSeconds(maxSeconds))
        : creditDebitSeconds(declared);
    const data = {
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      intakeKind: input.intakeKind,
      periodStart,
      reservedSeconds,
      settledSeconds: null,
      state: "reserved" as const,
      reason: null,
      releasedAt: null,
    };
    const row = existing
      ? await tx.processingUsageReservation.update({
          where: { projectId: input.projectId },
          data,
        })
      : await tx.processingUsageReservation.create({
          data: { ...data, projectId: input.projectId },
        });
    this.log({
      level: "info",
      message: "processing_usage_reserved",
      intent: "reserve",
      disposition: existing ? "readmitted" : "reserved",
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      intakeKind: input.intakeKind,
      previousState: existing?.state ?? null,
      nextState: "reserved",
      reservedSeconds,
      remainingSeconds: remainingSeconds - reservedSeconds,
      inFlight: inFlight + 1,
    });
    return { ...view(row), replayed: false };
  }

  /**
   * Resizes an unsettled reservation from a better duration fact. A smaller
   * fact releases the difference; a larger one takes it from the remaining
   * allowance or throws a typed refusal. Facts never settle.
   */
  async resize(input: {
    projectId: string;
    seconds: number;
  }): Promise<ProcessingUsageReservationView> {
    const sourceSeconds = knownSeconds(input.seconds);
    if (sourceSeconds === null) throw new Error("processing_usage_resize_invalid");
    const next = creditDebitSeconds(sourceSeconds);
    return this.deps.prisma.$transaction(async (tx) => {
      const head = await tx.processingUsageReservation.findUnique({
        where: { projectId: input.projectId },
        select: { workspaceId: true },
      });
      if (!head) throw new Error("processing_usage_not_reserved");
      await this.lockWorkspace(tx, head.workspaceId);
      const row = await tx.processingUsageReservation.findUniqueOrThrow({
        where: { projectId: input.projectId },
      });
      if (row.state !== "reserved" || row.reservedSeconds === next)
        return view(row);
      const { tier } = await this.workspaceTier(tx, row.workspaceId);
      const remainingSeconds = await this.remainingSeconds(
        tx,
        row.workspaceId,
        tier,
        row.periodStart,
      );
      const failure =
        sourceSeconds > planLimits(tier).maxSourceSeconds
          ? tooLong(tier, sourceSeconds, remainingSeconds + row.reservedSeconds)
          : next - row.reservedSeconds > remainingSeconds
            ? creditsExhausted({
                tier,
                periodStart: row.periodStart,
                remainingSeconds: remainingSeconds + row.reservedSeconds,
                requestedSeconds: sourceSeconds,
              })
            : null;
      if (failure) {
        this.log({
          level: "warn",
          message: "processing_usage_resize_refused",
          intent: "resize",
          disposition: "refused",
          workspaceId: row.workspaceId,
          projectId: row.projectId,
          intakeKind: row.intakeKind,
          previousState: row.state,
          reservedSeconds: row.reservedSeconds,
          remainingSeconds,
          failureCode: failure.code,
        });
        throw failure;
      }
      const changed = await tx.processingUsageReservation.updateMany({
        where: { projectId: row.projectId, state: "reserved" },
        data: { reservedSeconds: next },
      });
      const resized = await tx.processingUsageReservation.findUniqueOrThrow({
        where: { projectId: row.projectId },
      });
      if (!changed.count) return view(resized);
      this.log({
        level: "info",
        message: "processing_usage_resized",
        intent: "resize",
        disposition: next < row.reservedSeconds ? "shrunk" : "grown",
        workspaceId: row.workspaceId,
        projectId: row.projectId,
        intakeKind: row.intakeKind,
        previousState: row.state,
        nextState: resized.state,
        reservedSeconds: next,
        remainingSeconds: remainingSeconds + row.reservedSeconds - next,
      });
      return view(resized);
    }, PROCESSING_USAGE_TRANSACTION);
  }

  /**
   * Settles a Project's minutes from its probed source duration inside the
   * transaction that admits its speech-to-text Workflow Run. Call it before
   * taking the Project generation lock. Settlement is final for its period.
   */
  async settle(tx: Tx, projectId: string): Promise<ProcessingUsageSettlement> {
    const head = await tx.project.findUnique({
      where: { id: projectId },
      select: { workspaceId: true },
    });
    if (!head) throw new Error("processing_usage_project_missing");
    await this.lockWorkspace(tx, head.workspaceId);
    const [row, project, workspace] = await Promise.all([
      tx.processingUsageReservation.findUnique({ where: { projectId } }),
      tx.project.findUniqueOrThrow({
        where: { id: projectId },
        select: { ingestStatus: true, sourceDurationSeconds: true },
      }),
      this.workspaceTier(tx, head.workspaceId),
    ]);
    if (row?.state === "settled" || row?.state === "refunded")
      return {
        outcome: "settled",
        charged: false,
        settledSeconds: row.settledSeconds ?? 0,
      };
    const seconds = knownSeconds(project.sourceDurationSeconds);
    if (project.ingestStatus !== "ready" || seconds === null)
      return { outcome: "not_ready" };

    const { tier } = workspace;
    // Every intake reserves at acceptance. A missing row is a defect; a
    // released one was swept before settlement and needs an explicit retry.
    if (!row) throw new Error("processing_usage_not_reserved");
    if (row.state !== "reserved") {
      const failure = reservationReleased(tier);
      this.log({
        level: "warn",
        message: "processing_usage_settle_refused",
        intent: "settle",
        disposition: "refused",
        workspaceId: row.workspaceId,
        projectId,
        intakeKind: row.intakeKind,
        previousState: row.state,
        failureCode: failure.code,
      });
      return { outcome: "refused", failure };
    }

    const remainingSeconds = await this.remainingSeconds(
      tx,
      row.workspaceId,
      tier,
      row.periodStart,
    );
    const debitSeconds = creditDebitSeconds(seconds);
    const failure =
      workspace.status !== "active"
        ? inactiveWorkspace()
        : seconds > planLimits(tier).maxSourceSeconds
          ? tooLong(tier, seconds, row.reservedSeconds + remainingSeconds)
          : debitSeconds > row.reservedSeconds + remainingSeconds
            ? creditsExhausted({
                tier,
                periodStart: row.periodStart,
                remainingSeconds: row.reservedSeconds + remainingSeconds,
                requestedSeconds: seconds,
              })
            : null;
    if (failure) {
      this.log({
        level: "warn",
        message: "processing_usage_settle_refused",
        intent: "settle",
        disposition: "refused",
        workspaceId: row.workspaceId,
        projectId,
        intakeKind: row.intakeKind,
        previousState: row.state,
        reservedSeconds: row.reservedSeconds,
        settledSeconds: debitSeconds,
        remainingSeconds,
        failureCode: failure.code,
      });
      await this.release(tx, { projectId, reason: failure.code });
      return { outcome: "refused", failure };
    }
    const settled = await tx.processingUsageReservation.updateMany({
      where: { projectId, state: "reserved" },
      data: { state: "settled", settledSeconds: debitSeconds, settledAt: this.now() },
    });
    if (settled.count !== 1) throw new Error("processing_usage_settlement_lost");
    this.log({
      level: "info",
      message: "processing_usage_settled",
      intent: "settle",
      disposition: "settled",
      workspaceId: row.workspaceId,
      projectId,
      intakeKind: row.intakeKind,
      previousState: row.state,
      nextState: "settled",
      reservedSeconds: row.reservedSeconds,
      settledSeconds: debitSeconds,
      remainingSeconds: remainingSeconds + row.reservedSeconds - debitSeconds,
    });
    return { outcome: "settled", charged: true, settledSeconds: debitSeconds };
  }

  /** Releases an unsettled reservation in the transaction that settles the
   * intake's terminal outcome. Idempotent; settled usage is never touched. */
  async release(
    tx: Tx,
    input: { projectId: string; reason: string; expectedUpdatedAt?: Date },
  ): Promise<boolean> {
    const row = await tx.processingUsageReservation.findUnique({
      where: { projectId: input.projectId },
    });
    if (!row || row.state !== "reserved") return false;
    const reason = boundedReason(input.reason);
    const released = await tx.processingUsageReservation.updateMany({
      where: {
        projectId: input.projectId,
        state: "reserved",
        ...(input.expectedUpdatedAt ? { updatedAt: input.expectedUpdatedAt } : {}),
      },
      data: { state: "released", reason, releasedAt: this.now() },
    });
    if (released.count !== 1) return false;
    this.log({
      level: "info",
      message: "processing_usage_released",
      intent: "release",
      disposition: "released",
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      intakeKind: row.intakeKind,
      previousState: row.state,
      nextState: "released",
      reservedSeconds: row.reservedSeconds,
      reason,
    });
    return true;
  }

  /** Operator-only correction of settled usage. Records the actor and reason. */
  async refund(input: {
    projectId: string;
    actorUserId: string;
    reason: string;
  }): Promise<ProcessingUsageReservationView> {
    const reason = input.reason.trim().slice(0, MAX_REASON_LENGTH);
    if (!reason) throw new Error("processing_usage_refund_reason_required");
    return this.deps.prisma.$transaction(async (tx) => {
      const head = await tx.processingUsageReservation.findUnique({
        where: { projectId: input.projectId },
        select: { workspaceId: true },
      });
      if (!head)
        throw new ExpectedDomainFailureError({
          code: "processing_usage_not_found",
          kind: "missing",
          message: "No processing usage exists for this Project.",
        });
      await this.lockWorkspace(tx, head.workspaceId);
      const row = await tx.processingUsageReservation.findUniqueOrThrow({
        where: { projectId: input.projectId },
      });
      if (row.state !== "settled")
        throw new ExpectedDomainFailureError({
          code: "processing_usage_not_refundable",
          kind: "conflict",
          message: "Only settled processing usage can be refunded.",
        });
      const refunded = await tx.processingUsageReservation.update({
        where: { projectId: input.projectId },
        data: {
          state: "refunded",
          reason,
          refundedByUserId: input.actorUserId,
          refundedAt: this.now(),
        },
      });
      this.log({
        level: "warn",
        message: "processing_usage_refunded",
        intent: "refund",
        disposition: "refunded",
        workspaceId: row.workspaceId,
        projectId: row.projectId,
        intakeKind: row.intakeKind,
        previousState: row.state,
        nextState: "refunded",
        settledSeconds: row.settledSeconds,
        reason,
      });
      return view(refunded);
    }, PROCESSING_USAGE_TRANSACTION);
  }

  /**
   * Spending the next attempt checks, excluding this Project's own hold.
   * Settlement keeps a live reservation in its admission period. A released
   * reservation is re-admitted in the current period by an explicit retry.
   */
  async projectCreditUsage(projectId: string): Promise<{ periodStart: Date; spentCredits: number } | null> {
    const row = await this.deps.prisma.processingUsageReservation.findUnique({
      where: { projectId },
      select: { workspaceId: true, state: true, periodStart: true, reservedSeconds: true },
    });
    if (!row) return null;
    const periodStart = row.state === "reserved" ? row.periodStart : processingPeriodStart(this.now());
    const usage = await this.periodUsage(this.deps.prisma, row.workspaceId, periodStart);
    const ownReservation = row.state === "reserved" ? row.reservedSeconds : 0;
    return {
      periodStart,
      spentCredits: Math.max(0, Math.floor((usage.settled + usage.reserved - ownReservation) / 60)),
    };
  }

  /** The one usage projection web, MCP, and REST render. */
  async summarize(workspaceId: string): Promise<ProcessingUsageSummary> {
    const db = this.deps.prisma;
    const { tier } = await this.workspaceTier(db, workspaceId);
    const periodStart = processingPeriodStart(this.now());
    const [usage, inFlight] = await Promise.all([
      this.periodUsage(db, workspaceId, periodStart),
      this.inFlight(db, workspaceId),
    ]);
    const limits = planLimits(tier);
    // Debits are whole credits, so these divisions are exact and the parts sum.
    const usedCredits = Math.floor(usage.settled / 60);
    const reservedCredits = Math.floor(usage.reserved / 60);
    return {
      tier,
      usedCredits,
      reservedCredits,
      limitCredits: limits.monthlyCredits,
      remainingCredits: Math.max(0, limits.monthlyCredits - usedCredits - reservedCredits),
      periodStart,
      renewsAt: processingPeriodEnd(periodStart),
      inFlight,
      inFlightLimit: this.deps.capacityLimits[tier],
      maxUploadSeconds: limits.maxSourceSeconds,
    };
  }

  /**
   * Releases reservations stranded by crashes or missed terminal paths: a
   * terminal Upload Session that never handed off, an Ingest Job that failed
   * or was cancelled, or an intake whose Project no longer exists. Completed
   * Ingest Jobs waiting for or deferring their generation handoff, including
   * browser setup awaiting commitment, are never released.
   */
  async reconcileStranded(
    options: { limit?: number; graceMs?: number } = {},
  ): Promise<number> {
    const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
    const cutoff = new Date(
      this.now().getTime() - Math.max(0, options.graceMs ?? 10 * 60_000),
    );
    const candidates = await this.deps.prisma.$queryRaw<
      Array<{ projectId: string; updatedAt: Date; reason: string }>
    >`
      SELECT usage."projectId", usage."updatedAt",
        CASE
          WHEN session."status" IN ('aborted', 'expired', 'failed') THEN 'upload_session_terminal'
          WHEN project."id" IS NULL THEN 'intake_missing'
          ELSE 'ingest_terminal'
        END AS "reason"
      FROM "ProcessingUsageReservation" usage
      LEFT JOIN "Project" project ON project."id" = usage."projectId"
      LEFT JOIN "UploadSession" session ON session."preallocatedProjectId" = usage."projectId"
      LEFT JOIN LATERAL (
        SELECT job."status" FROM "IngestJob" job
        WHERE job."projectId" = usage."projectId"
        ORDER BY job."createdAt" DESC, job."id" DESC
        LIMIT 1
      ) latest ON TRUE
      WHERE usage."state" = 'reserved' AND usage."updatedAt" < ${cutoff}
        AND (
          session."status" IN ('aborted', 'expired', 'failed')
          OR (project."id" IS NULL AND (session."id" IS NULL OR session."status" = 'queued_for_ingest'))
          OR (project."id" IS NOT NULL AND latest."status" IN ('failed', 'cancelled'))
        )
      ORDER BY usage."updatedAt" ASC, usage."id" ASC
      LIMIT ${limit}
    `;
    let released = 0;
    for (const candidate of candidates) {
      // The updatedAt fence skips rows a manual retry re-admitted meanwhile.
      const won = await this.deps.prisma.$transaction((tx) =>
        this.release(tx, {
          projectId: candidate.projectId,
          reason: `reconciled_${candidate.reason}`,
          expectedUpdatedAt: candidate.updatedAt,
        }),
      );
      if (won) released += 1;
    }
    return released;
  }
}

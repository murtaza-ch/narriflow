import { executionDispatchReferenceSchema, type ExecutionDispatchReference } from "@narriflow/validators/execution";
import { executeExecutionPage } from "./execution-page-receipt";
import { readExecutionAdmission } from "./execution-admission";
import type { Prisma, PrismaClient } from "@prisma/client";
import { appendExecutionDispatch, executionDispatchIdentity, readExecutionDispatch } from "./execution-dispatch";

export class ExecutionRestoreError extends Error {
  constructor(readonly code: "restore_epoch_changed" | "restore_reference_invalid" | "restore_phase_unavailable" | "restore_page_invalid") { super(code); }
}
export const EXECUTION_RESTORE_PHASES = ["attempts", "ingest", "workflows", "render_groups", "selection", "preparation", "native_validation", "thumbnail", "generated_media", "outbound", "publication", "uploads", "billing", "devices", "redispatch"] as const;

export type ExecutionRestorePhase = typeof EXECUTION_RESTORE_PHASES[number];
export interface ExecutionRestorePosition { at: Date; id: string }
export interface ExecutionRestorePage { snapshotEpoch: number; fenceAboveEpoch: number; deploymentEpoch: number; cutoff: Date; after: ExecutionRestorePosition | null; limit: number }
export interface ExecutionRestorePageResult { processed: number; next: ExecutionRestorePosition | null; dispatchIds?: readonly string[] }
export type ExecutionRestorePhaseHandler = (tx: Prisma.TransactionClient, page: ExecutionRestorePage) => Promise<ExecutionRestorePageResult>;
export interface ExecutionRestoreResult { kind: "complete" | "continue" | "superseded"; processed: number; dispatchIds: string[] }
type Facts = Omit<ExecutionRestorePage, "limit" | "after">;
const invalid = () => new ExecutionRestoreError("restore_reference_invalid");
function point(value: ExecutionRestorePosition) {
  if (!Number.isSafeInteger(value.at.getTime()) || value.at.getTime() < 0 || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.id)) throw new ExecutionRestoreError("restore_page_invalid");
  return `${value.at.getTime()}.${value.id.replaceAll("-", "")}`;
}
function identity(facts: Facts, phase: ExecutionRestorePhase, after: ExecutionRestorePosition | null) {
  if (!EXECUTION_RESTORE_PHASES.includes(phase) || facts.deploymentEpoch !== Math.max(facts.snapshotEpoch, facts.fenceAboveEpoch) + 1 ||
    ![facts.snapshotEpoch, facts.fenceAboveEpoch, facts.deploymentEpoch].every(value => Number.isSafeInteger(value) && value >= 1 && value <= 2_147_483_647) || !Number.isSafeInteger(facts.cutoff.getTime()) || facts.cutoff.getTime() < 0) throw invalid();
  return `rs1.${facts.snapshotEpoch}.${facts.fenceAboveEpoch}.${facts.deploymentEpoch}.${facts.cutoff.getTime()}.${phase}${after ? `.${point(after)}` : ""}`;
}
function parse(id: string) {
  const match = /^rs1\.([1-9][0-9]{0,9})\.([1-9][0-9]{0,9})\.([1-9][0-9]{0,9})\.(0|[1-9][0-9]{0,12})\.([a-z_]+)(?:\.(0|[1-9][0-9]{0,12})\.([a-f0-9]{32}))?$/.exec(id);
  if (!match) throw invalid();
  const facts = { snapshotEpoch: Number(match[1]), fenceAboveEpoch: Number(match[2]), deploymentEpoch: Number(match[3]), cutoff: new Date(Number(match[4])) };
  const phase = match[5] as ExecutionRestorePhase, compact = match[7];
  const after = compact ? { at: new Date(Number(match[6])), id: `${compact.slice(0,8)}-${compact.slice(8,12)}-${compact.slice(12,16)}-${compact.slice(16,20)}-${compact.slice(20)}` } : null;
  if (identity(facts, phase, after) !== id) throw invalid();
  return { facts, phase, after };
}
async function hash(epoch: number, subjectId: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["restore-page-v1", epoch, subjectId])))), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Operator authority only. The fence commits in its own transaction before
 * any domain reset or redispatch. Recovery never reopens admission. */
export class ExecutionRestoreService {
  private readonly limit: number;
  constructor(private readonly options: { database: PrismaClient; register(ids: readonly string[]): Promise<void>; phases?: Partial<Record<ExecutionRestorePhase, ExecutionRestorePhaseHandler>>; limit?: number }) {
    this.limit = options.limit ?? 100;
    if (!Number.isSafeInteger(this.limit) || this.limit < 1 || this.limit > 100) throw new ExecutionRestoreError("restore_page_invalid");
  }
  private async append(tx: Prisma.TransactionClient, facts: Facts, phase: ExecutionRestorePhase, after: ExecutionRestorePosition | null) {
    const subjectId = identity(facts, phase, after);
    return (await appendExecutionDispatch(tx, { deploymentEpoch: facts.deploymentEpoch, generation: 1, kind: "maintenance", subject: { kind: "maintenance", id: subjectId }, inputHash: await hash(facts.deploymentEpoch, subjectId), dueAt: facts.cutoff })).reference;
  }
  async begin(input: { expectedEpoch: number; fenceAboveEpoch: number }) {
    if (![input.expectedEpoch, input.fenceAboveEpoch].every(value => Number.isSafeInteger(value) && value >= 1 && value < 2_147_483_647)) throw new ExecutionRestoreError("restore_epoch_changed");
    const deploymentEpoch = Math.max(input.expectedEpoch, input.fenceAboveEpoch) + 1;
    const reference = await this.options.database.$transaction(async tx => {
      const [changed] = await tx.$queryRaw<Array<{ epoch: number; changedAt: Date }>>`UPDATE "ExecutionEpoch"
        SET epoch = ${deploymentEpoch}, "admissionOpen" = false, "changedAt" = clock_timestamp() AT TIME ZONE 'UTC'
        WHERE id = 1 AND epoch = ${input.expectedEpoch} RETURNING epoch, "changedAt"`;
      const current = changed ?? await tx.executionEpoch.findUnique({ where: { id: 1 } });
      if (!current || current.epoch !== deploymentEpoch || ("admissionOpen" in current && current.admissionOpen)) throw new ExecutionRestoreError("restore_epoch_changed");
      const facts = { snapshotEpoch: input.expectedEpoch, fenceAboveEpoch: input.fenceAboveEpoch, deploymentEpoch, cutoff: current.changedAt };
      const subjectId = identity(facts, EXECUTION_RESTORE_PHASES[0], null);
      const dispatchIdentity = { deploymentEpoch, generation: 1, kind: "maintenance" as const, subject: { kind: "maintenance" as const, id: subjectId } };
      const inputHash = await hash(deploymentEpoch, subjectId);
      if (!changed) {
        // The persisted begin obligation is the source-pair receipt. A
        // different pair yielding the same max epoch cannot resume it.
        const existing = await tx.executionDispatch.findUnique({ where: { deliveryKey: (await executionDispatchIdentity(dispatchIdentity)).deliveryKey } });
        const recorded = existing ? await readExecutionDispatch(tx, existing.id) : null;
        if (!recorded || recorded.reference.inputHash !== inputHash) throw new ExecutionRestoreError("restore_epoch_changed");
        return recorded.reference;
      }
      // The fence and its initial obligation commit atomically, with no
      // domain-row reset locks and no SQL transaction spanning HTTP.
      return (await appendExecutionDispatch(tx, { ...dispatchIdentity, inputHash, dueAt: current.changedAt })).reference;
    });
    await this.options.register([reference.dispatchId]);
    return { previousEpoch: input.expectedEpoch, deploymentEpoch, reference };
  }
  async run(value: ExecutionDispatchReference): Promise<ExecutionRestoreResult> {
    const validation = executionDispatchReferenceSchema.safeParse(value);
    if (!validation.success) throw invalid();
    const reference = validation.data;
    const result = await this.options.database.$transaction(async tx => {
      const state = await readExecutionAdmission(tx), record = await readExecutionDispatch(tx, reference.dispatchId);
      if (!record || JSON.stringify(record.reference) !== JSON.stringify(reference) || reference.kind !== "maintenance" || reference.subject.kind !== "maintenance" || reference.generation !== 1) throw invalid();
      if (state.epoch !== reference.deploymentEpoch) return { kind: "superseded" as const, processed: 0, dispatchIds: [] };
      const { facts, phase, after } = parse(reference.subject.id);
      if (facts.deploymentEpoch !== state.epoch || record.dueAt.getTime() !== facts.cutoff.getTime() || reference.inputHash !== await hash(state.epoch, reference.subject.id)) throw invalid();
      const begin = { deploymentEpoch: state.epoch, generation: 1, kind: "maintenance" as const, subject: { kind: "maintenance" as const, id: identity(facts, EXECUTION_RESTORE_PHASES[0], null) } };
      const first = await tx.executionDispatch.findUnique({ where: { deliveryKey: (await executionDispatchIdentity(begin)).deliveryKey }, select: { inputHash: true } });
      if (!first || first.inputHash !== await hash(state.epoch, begin.subject.id)) throw invalid();
      return executeExecutionPage(tx, reference, "restore-page", async () => {
        if (state.admissionOpen) throw new ExecutionRestoreError("restore_epoch_changed");
        for (let index = EXECUTION_RESTORE_PHASES.indexOf(phase); index < EXECUTION_RESTORE_PHASES.length; index++) {
          const current = EXECUTION_RESTORE_PHASES[index]!, handler = this.options.phases?.[current];
          if (!handler) throw new ExecutionRestoreError("restore_phase_unavailable");
          const cursor = current === phase ? after : null;
          const outcome = await handler(tx, { ...facts, after: cursor, limit: this.limit });
          const ids = [...new Set(outcome.dispatchIds ?? [])];
          if (!Number.isSafeInteger(outcome.processed) || outcome.processed < 0 || outcome.processed > this.limit || ids.length > 127 || (outcome.processed === 0 && (outcome.next || ids.length))) throw new ExecutionRestoreError("restore_page_invalid");
          if (outcome.next) {
            point(outcome.next);
            if (outcome.next.at > facts.cutoff || (cursor && (outcome.next.at < cursor.at || (outcome.next.at.getTime() === cursor.at.getTime() && outcome.next.id <= cursor.id)))) throw new ExecutionRestoreError("restore_page_invalid");
          }
          if (outcome.processed > 0) {
            const nextPhase = outcome.next ? current : EXECUTION_RESTORE_PHASES[index + 1];
            if (nextPhase) ids.push((await this.append(tx, facts, nextPhase, outcome.next)).dispatchId);
            return { kind: nextPhase ? "continue" as const : "complete" as const, processed: outcome.processed, dispatchIds: ids };
          }
        }
        return { kind: "complete" as const, processed: 0, dispatchIds: [] };
      });
    });
    if (result.dispatchIds.length) await this.options.register(result.dispatchIds);
    return result;
  }

}

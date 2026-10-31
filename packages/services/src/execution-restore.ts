import { lockRestoreMetadataPlans,readRestoreMetadataBarrier } from "./execution-restore-pages";
import { assertExecutionSnapshotDatabase, validateExecutionSnapshotEvidence, ExecutionSnapshotError, type ExecutionSnapshotEvidence } from "./execution-snapshot";
import { executionDispatchReferenceSchema, type ExecutionDispatchReference } from "@narriflow/validators/execution";
import { executeExecutionPage, readExecutionPageReceipt } from "./execution-page-receipt";
import { readExecutionAdmission } from "./execution-admission";
import type { Prisma, PrismaClient } from "@prisma/client";
import { appendExecutionDispatch, executionDispatchIdentity, readExecutionDispatch } from "./execution-dispatch";

export class ExecutionRestoreError extends Error {
  constructor(readonly code: "restore_epoch_changed" | "restore_reference_invalid" | "restore_phase_unavailable" | "restore_page_invalid") { super(code); }
}
export const EXECUTION_RESTORE_PHASES = ["attempts", "ingest", "workflows", "render_groups", "selection", "preparation", "preparation_links", "native_validation", "thumbnail", "generated_media", "outbound_probes", "outbound_deliveries", "callbacks", "subscriptions", "publication", "bundle", "dubbing", "uploads", "billing", "library", "finishing", "autopilot", "zoom_notifications", "notifications", "review_notifications", "grant_notifications", "devices", "redispatch", "redispatch_ingest", "redispatch_workflows", "redispatch_groups", "redispatch_selection", "redispatch_preparation", "redispatch_validation", "redispatch_thumbnail", "redispatch_generated", "redispatch_probes", "redispatch_delivery", "redispatch_callbacks", "redispatch_subscriptions", "redispatch_uploads", "redispatch_billing", "redispatch_library", "redispatch_finishing", "redispatch_publication", "redispatch_pub_receipts", "redispatch_pub_captures", "redispatch_grants", "redispatch_guidance", "redispatch_bundle", "redispatch_dubbing", "redispatch_autopilot", "redispatch_zoom", "redispatch_notifications", "redispatch_review_mail", "redispatch_grant_mail", "redispatch_retention", "redispatch_cleanup", "redispatch_restore_cleanup"] as const;

export type ExecutionRestorePhase = typeof EXECUTION_RESTORE_PHASES[number];
export interface ExecutionRestorePosition { at: Date; id: string }
export interface ExecutionRestorePage { snapshotEpoch: number; fenceAboveEpoch: number; deploymentEpoch: number; cutoff: Date; after: ExecutionRestorePosition | null; limit: number }
export interface ExecutionRestorePageResult { processed: number; next: ExecutionRestorePosition | null; dispatchIds?: readonly string[] }
export type ExecutionRestorePhaseHandler = (tx: Prisma.TransactionClient, page: ExecutionRestorePage) => Promise<ExecutionRestorePageResult>;
/** Server-owned preparation returns a typed transition closure. Bytes never
 * enter Workflow state and storage I/O never runs while the apply Tx is held. */
export type ExecutionRestorePreparedPhase = (reference: ExecutionDispatchReference, page: ExecutionRestorePage) => Promise<{
  apply(tx: Prisma.TransactionClient, page: ExecutionRestorePage): Promise<ExecutionRestorePageResult>;
}>;

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
  return `rs2.${facts.snapshotEpoch}.${facts.fenceAboveEpoch}.${facts.deploymentEpoch}.${facts.cutoff.getTime()}.${phase}${after ? `.${point(after)}` : ""}`;
}
function parse(id: string) {
  const match = /^rs2\.([1-9][0-9]{0,9})\.([1-9][0-9]{0,9})\.([1-9][0-9]{0,9})\.(0|[1-9][0-9]{0,12})\.([a-z_]+)(?:\.(0|[1-9][0-9]{0,12})\.([a-f0-9]{32}))?$/.exec(id);
  if (!match) throw invalid();
  const facts = { snapshotEpoch: Number(match[1]), fenceAboveEpoch: Number(match[2]), deploymentEpoch: Number(match[3]), cutoff: new Date(Number(match[4])) };
  const phase = match[5] as ExecutionRestorePhase, compact = match[7];
  const after = compact ? { at: new Date(Number(match[6])), id: `${compact.slice(0,8)}-${compact.slice(8,12)}-${compact.slice(12,16)}-${compact.slice(16,20)}-${compact.slice(20)}` } : null;
  if (identity(facts, phase, after) !== id) throw invalid();
  return { facts, phase, after };
}
async function hash(epoch: number, subjectId: string, attestation: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["restore-page-v2", epoch, subjectId, attestation])))), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Operator authority only. The fence commits in its own transaction before
 * any domain reset or redispatch. Recovery never reopens admission. */
export class ExecutionRestoreService {
  private readonly limit: number;
  constructor(private readonly options: { database: PrismaClient; register(ids: readonly string[]): Promise<void>; phases?: Partial<Record<ExecutionRestorePhase, ExecutionRestorePhaseHandler>>; prepare?: Partial<Record<"selection" | "preparation", ExecutionRestorePreparedPhase>>; limit?: number }) {
    this.limit = options.limit ?? 100;
    if (!Number.isSafeInteger(this.limit) || this.limit < 1 || this.limit > 100) throw new ExecutionRestoreError("restore_page_invalid");
  }
  private async append(tx: Prisma.TransactionClient, facts: Facts, phase: ExecutionRestorePhase, after: ExecutionRestorePosition | null, attestation: string) {
    const subjectId = identity(facts, phase, after);
    return (await appendExecutionDispatch(tx, { deploymentEpoch: facts.deploymentEpoch, generation: 1, kind: "maintenance", subject: { kind: "maintenance", id: subjectId }, inputHash: await hash(facts.deploymentEpoch, subjectId, attestation), dueAt: facts.cutoff })).reference;
  }
  async begin(input: { expectedEpoch: number; fenceAboveEpoch: number; evidence: ExecutionSnapshotEvidence }) {
    if (!input.evidence?.proof || !input.evidence.proofHash) throw new ExecutionSnapshotError("restore_snapshot_proof_required");
    if (![input.expectedEpoch, input.fenceAboveEpoch].every(value => Number.isSafeInteger(value) && value >= 1 && value < 2_147_483_647)) throw new ExecutionRestoreError("restore_epoch_changed");
    const evidence = await validateExecutionSnapshotEvidence({ proof: input.evidence.proof, snapshotSha256: input.evidence.proof.snapshotSha256,
      localMigrationSha256: input.evidence.localMigrationSha256, worker: input.evidence.worker });
    if (evidence.proofHash !== input.evidence.proofHash) throw new ExecutionSnapshotError("restore_snapshot_proof_invalid");
    if (input.fenceAboveEpoch > evidence.proof.sourceEpoch) throw new ExecutionSnapshotError("restore_snapshot_history_unknown");
    if (input.expectedEpoch !== evidence.proof.sourceEpoch || input.fenceAboveEpoch !== evidence.proof.sourceEpoch) throw new ExecutionSnapshotError("restore_snapshot_proof_invalid");
    const deploymentEpoch = evidence.proof.sourceEpoch + 1;
    const reference = await this.options.database.$transaction(async tx => {
      // Control-plane lock only, before any domain lock. Validation and the
      // epoch bump cannot race a source-epoch permission transaction.
      const [source] = await tx.$queryRaw<Array<{ epoch: number; admissionOpen: boolean; changedAt: Date }>>`SELECT epoch, "admissionOpen", "changedAt" FROM "ExecutionEpoch" WHERE id = 1 FOR UPDATE`;
      if (!source) throw new ExecutionRestoreError("restore_epoch_changed");
      let current = source;
      const replay = current.epoch === deploymentEpoch;
      if (!replay) {
        await assertExecutionSnapshotDatabase(tx, evidence, { ...source, expectedEpoch: input.expectedEpoch, fenceAboveEpoch: input.fenceAboveEpoch });
        current = await tx.executionEpoch.update({ where: { id: 1 }, data: { epoch: deploymentEpoch, admissionOpen: false,
          changedAt: (await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`)[0]!.now } });
      }
      if (current.epoch !== deploymentEpoch || current.admissionOpen) throw new ExecutionRestoreError("restore_epoch_changed");
      const facts = { snapshotEpoch: input.expectedEpoch, fenceAboveEpoch: input.fenceAboveEpoch, deploymentEpoch, cutoff: current.changedAt };
      const subjectId = identity(facts, EXECUTION_RESTORE_PHASES[0], null);
      const dispatchIdentity = { deploymentEpoch, generation: 1, kind: "maintenance" as const, subject: { kind: "maintenance" as const, id: subjectId } };
      const inputHash = await hash(deploymentEpoch, subjectId, evidence.proofHash);
      if (replay) {
        const existing = await tx.executionDispatch.findUnique({ where: { deliveryKey: (await executionDispatchIdentity(dispatchIdentity)).deliveryKey } });
        const recorded = existing ? await readExecutionDispatch(tx, existing.id) : null;
        if (!recorded || recorded.reference.inputHash !== inputHash) throw new ExecutionRestoreError("restore_epoch_changed");
        return recorded.reference;
      }
      return (await appendExecutionDispatch(tx, { ...dispatchIdentity, inputHash, dueAt: current.changedAt })).reference;
    });
    await this.options.register([reference.dispatchId]);
    return { previousEpoch: input.expectedEpoch, deploymentEpoch, reference };
  }
  private async currentPage(tx: Prisma.TransactionClient, reference: ExecutionDispatchReference) {
      const state = await readExecutionAdmission(tx), record = await readExecutionDispatch(tx, reference.dispatchId);
      if (!record || JSON.stringify(record.reference) !== JSON.stringify(reference) || reference.kind !== "maintenance" || reference.subject.kind !== "maintenance" || reference.generation !== 1) throw invalid();
      if (state.epoch !== reference.deploymentEpoch) return null;
      const { facts, phase, after } = parse(reference.subject.id);
      if (facts.deploymentEpoch !== state.epoch || record.dueAt.getTime() !== facts.cutoff.getTime()) throw invalid();
      const begin = { deploymentEpoch: state.epoch, generation: 1, kind: "maintenance" as const, subject: { kind: "maintenance" as const, id: identity(facts, EXECUTION_RESTORE_PHASES[0], null) } };
      const first = await tx.executionDispatch.findUnique({ where: { deliveryKey: (await executionDispatchIdentity(begin)).deliveryKey }, select: { id: true, inputHash: true } });
      if (!first || (reference.dispatchId !== first.id && reference.inputHash !== await hash(state.epoch, reference.subject.id, first.inputHash))) throw invalid();
      return { state, facts, phase, after, attestation: first.inputHash };
  }
  private async inspectPage(tx: Prisma.TransactionClient, dispatchId: string) {
    const record = await readExecutionDispatch(tx, dispatchId);
    if (!record) throw invalid();
    const page = await this.currentPage(tx, record.reference);
    if (!page) throw new ExecutionRestoreError("restore_epoch_changed");
    return { ...page.facts, reference: record.reference, phase: page.phase, after: page.after, admissionOpen: page.state.admissionOpen,
      metadataReady: page.phase.startsWith("redispatch"), receipt: await readExecutionPageReceipt(tx, record.reference, "restore-page") };
  }
  async inspect(dispatchId: string) {
    return this.options.database.$transaction(tx => this.inspectPage(tx, dispatchId));
  }
  /** Exact unique-key lookup recovers an uncertain begin's dispatch ID. It
   * neither infers a new source pair nor creates a replacement obligation. */
  async inspectCurrent() {
    return this.options.database.$transaction(async tx => {
      const state = await readExecutionAdmission(tx);
      const row = await tx.executionEpoch.findUniqueOrThrow({ where: { id: 1 } });
      if (state.epoch < 2 || state.admissionOpen) return { state: row, restore: null };
      const facts = { snapshotEpoch: state.epoch - 1, fenceAboveEpoch: state.epoch - 1, deploymentEpoch: state.epoch, cutoff: row.changedAt };
      const subject = { kind: "maintenance" as const, id: identity(facts, EXECUTION_RESTORE_PHASES[0], null) };
      const key = await executionDispatchIdentity({ deploymentEpoch: state.epoch, generation: 1, kind: "maintenance", subject });
      const record = await tx.executionDispatch.findUnique({ where: { deliveryKey: key.deliveryKey }, select: { id: true } });
      return { state: row, restore: record ? await this.inspectPage(tx, record.id) : null };
    });
  }
  async run(value: ExecutionDispatchReference): Promise<ExecutionRestoreResult> {
    const validation = executionDispatchReferenceSchema.safeParse(value);
    if (!validation.success) throw invalid();
    const reference = validation.data;
    const preparation = await this.options.database.$transaction(async tx => {
      const page = await this.currentPage(tx, reference);
      if (!page || await readExecutionPageReceipt(tx, reference, "restore-page")) return null;
      if (page.phase !== "selection" && page.phase !== "preparation") return null;
      const prepare = this.options.prepare?.[page.phase];
      return prepare ? { prepare, page: { ...page.facts, after: page.after, limit: this.limit } } : null;
    });
    const prepared = preparation ? await preparation.prepare(reference, preparation.page) : null;
    const result = await this.options.database.$transaction(async tx => {
      const page = await this.currentPage(tx, reference);
      if (!page) return { kind: "superseded" as const, processed: 0, dispatchIds: [] };
      const { state, facts, phase, after, attestation } = page;
      return executeExecutionPage(tx, reference, "restore-page", async () => {
        if (state.admissionOpen) throw new ExecutionRestoreError("restore_epoch_changed");
        for (let index = EXECUTION_RESTORE_PHASES.indexOf(phase); index < EXECUTION_RESTORE_PHASES.length; index++) {
          const current = EXECUTION_RESTORE_PHASES[index]!, handler = this.options.phases?.[current];
          if(current==="redispatch" && !phase.startsWith("redispatch")){
            await lockRestoreMetadataPlans(tx,facts.deploymentEpoch);
            const continuation=await this.append(tx,facts,current,null,attestation);
            return {kind:"continue" as const,processed:0,dispatchIds:[continuation.dispatchId]};
          }
          const needsPreparation = (current === "selection" || current === "preparation") && this.options.prepare?.[current];
          if (needsPreparation && current !== phase) {
            const continuation = await this.append(tx, facts, current, null, attestation);
            return { kind: "continue" as const, processed: 0, dispatchIds: [continuation.dispatchId] };
          }
          if (!handler && !needsPreparation) throw new ExecutionRestoreError("restore_phase_unavailable");
          const cursor = current === phase ? after : null, page = { ...facts, after: cursor, limit: this.limit };
          if (needsPreparation && !prepared) throw new ExecutionRestoreError("restore_page_invalid");
          const outcome = needsPreparation ? await prepared!.apply(tx,page) : await handler!(tx,page);
          const ids = [...new Set(outcome.dispatchIds ?? [])];
          if (!Number.isSafeInteger(outcome.processed) || outcome.processed < 0 || outcome.processed > this.limit || ids.length > 127 || (outcome.processed === 0 && (outcome.next || ids.length))) throw new ExecutionRestoreError("restore_page_invalid");
          if (outcome.next) {
            point(outcome.next);
            if (outcome.next.at > (current==="redispatch_restore_cleanup" ? (await readRestoreMetadataBarrier(tx,facts.deploymentEpoch,facts.cutoff))?.createdAt ?? facts.cutoff : facts.cutoff) || (cursor && (outcome.next.at < cursor.at || (outcome.next.at.getTime() === cursor.at.getTime() && outcome.next.id <= cursor.id)))) throw new ExecutionRestoreError("restore_page_invalid");
          }
          if (outcome.processed > 0) {
            const nextPhase = outcome.next ? current : EXECUTION_RESTORE_PHASES[index + 1];
            if (nextPhase) ids.push((await this.append(tx, facts, nextPhase, outcome.next, attestation)).dispatchId);
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

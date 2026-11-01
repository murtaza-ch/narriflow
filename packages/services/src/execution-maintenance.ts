import { executeExecutionPage } from "./execution-page-receipt";
import type { Prisma, PrismaClient } from "@prisma/client";
import { executionDispatchReferenceSchema, type ExecutionDispatchReference } from "@narriflow/validators/execution";
import { appendExecutionDispatch, readExecutionDispatch } from "./execution-dispatch";
import { readExecutionAdmission } from "./execution-admission";

export const HOURLY_MAINTENANCE_PHASES = ["dispatches", "deadlines", "provider_waits", "domain_wakes", "workflow_wakes", "render_wakes", "selection_wakes", "preparation_wakes", "native_validation_wakes", "thumbnail_wakes", "generated_media_wakes", "outbound_probe_wakes", "outbound_delivery_wakes", "cleanup_wakes", "callback_wakes", "subscription_wakes", "upload_wakes", "billing_wakes", "library_wakes", "finishing_wakes", "publication_wakes", "publication_receipts", "publication_captures", "bundle_wakes", "dubbing_wakes", "autopilot_wakes", "zoom_notification_wakes", "notification_wakes", "review_notification_wakes", "grant_notification_wakes", "webhook_notification_wakes"] as const;
export const DAILY_MAINTENANCE_PHASES = ["tasks", "receipts", "events", "workspace_events", "webhook_logs", "generated_prompts", "validation_rows", "probe_rows", "grant_notification_rows", "webhook_notification_rows", "deletion_receipts", "grants", "grant_authority", "bundle_expiry", "project_warnings", "retention", "sources", "pending_workspaces", "cleanup"] as const;
export type MaintenancePhase = typeof HOURLY_MAINTENANCE_PHASES[number] | typeof DAILY_MAINTENANCE_PHASES[number];
export type MaintenanceCadence = "hourly" | "daily";
export const MAINTENANCE_RECEIPT_AUDIENCES = ["modal-bridge", "executor-control", "dev-device", "watchdog", "maintenance-page", "restore-page"] as const;
export interface MaintenancePosition { at: Date; id: string; tie?: typeof MAINTENANCE_RECEIPT_AUDIENCES[number] }
export interface MaintenancePage { deploymentEpoch: number; cutoff: Date; after: MaintenancePosition | null; limit: number }
export interface MaintenancePageResult { processed: number; next: MaintenancePosition | null; dispatchIds?: readonly string[] }
export type MaintenancePhaseHandler = (tx: Prisma.TransactionClient, page: MaintenancePage) => Promise<MaintenancePageResult>;
export interface MaintenanceResult { kind: "complete" | "continue" | "superseded"; processed: number; dispatchIds: string[] }
export class ExecutionMaintenanceError extends Error {
  constructor(readonly code: "maintenance_reference_invalid" | "maintenance_phase_unavailable" | "maintenance_page_invalid") { super(code); }
}
const invalid = () => new ExecutionMaintenanceError("maintenance_reference_invalid");
const phases = (cadence: MaintenanceCadence): readonly MaintenancePhase[] => cadence === "hourly" ? HOURLY_MAINTENANCE_PHASES : DAILY_MAINTENANCE_PHASES;
function validDate(value: Date) { return value instanceof Date && Number.isSafeInteger(value.getTime()) && value.getTime() >= 0; }
function position(value: MaintenancePosition) {
  if (!validDate(value.at) || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.id) || (value.tie !== undefined && !MAINTENANCE_RECEIPT_AUDIENCES.includes(value.tie))) throw new ExecutionMaintenanceError("maintenance_page_invalid");
}
function identity(cadence: MaintenanceCadence, cutoff: Date, phase: MaintenancePhase, after: MaintenancePosition | null) {
  if (!validDate(cutoff) || !phases(cadence).includes(phase)) throw invalid();
  if (after) {
    position(after);
    if ((phase === "receipts") !== (after.tie !== undefined)) throw invalid();
  }
  return `mt1.${cadence === "hourly" ? "h" : "d"}.${cutoff.getTime()}.${phase}${after ? `.${after.at.getTime()}.${after.id.replaceAll("-", "")}${after.tie ? `.${after.tie}` : ""}` : ""}`;
}
function parse(id: string) {
  const match = /^mt1\.([hd])\.(0|[1-9][0-9]{0,12})\.([a-z_]+)(?:\.(0|[1-9][0-9]{0,12})\.([a-f0-9]{32})(?:\.([a-z-]+))?)?$/.exec(id);
  if (!match) throw invalid();
  const cadence: MaintenanceCadence = match[1] === "h" ? "hourly" : "daily";
  const cutoff = new Date(Number(match[2])), phase = match[3] as MaintenancePhase;
  const compact = match[5];
  const after: MaintenancePosition | null = compact ? { at: new Date(Number(match[4])), id: `${compact.slice(0,8)}-${compact.slice(8,12)}-${compact.slice(12,16)}-${compact.slice(16,20)}-${compact.slice(20)}`,
    ...(match[6] ? { tie: match[6] as MaintenancePosition["tie"] } : {}) } : null;
  if (identity(cadence, cutoff, phase, after) !== id) throw invalid();
  return { cadence, cutoff, phase, after };
}
async function hash(epoch: number, id: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["maintenance-page-v1", epoch, id])))), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** A bounded page commits its cursor and domain obligations together. Ports
 * only plan database work; storage/provider HTTP happens in targeted handlers. */
export class ExecutionMaintenanceService {
  private readonly limit: number;
  constructor(private readonly options: { database: PrismaClient; register(ids: readonly string[]): Promise<void>;
    phases: Partial<Record<MaintenancePhase, MaintenancePhaseHandler>>; limit?: number }) {
    this.limit = options.limit ?? 100;
    if (!Number.isSafeInteger(this.limit) || this.limit < 1 || this.limit > 100) throw new ExecutionMaintenanceError("maintenance_page_invalid");
  }
  private async append(tx: Prisma.TransactionClient, epoch: number, cadence: MaintenanceCadence, cutoff: Date, phase: MaintenancePhase, after: MaintenancePosition | null) {
    const id = identity(cadence, cutoff, phase, after);
    return (await appendExecutionDispatch(tx, { deploymentEpoch: epoch, generation: 1, kind: "maintenance", subject: { kind: "maintenance", id }, inputHash: await hash(epoch, id), dueAt: cutoff })).reference;
  }
  async start(input: { cadence: MaintenanceCadence; scheduledAt: Date }): Promise<ExecutionDispatchReference> {
    if (!["hourly", "daily"].includes(input.cadence) || !validDate(input.scheduledAt)) throw invalid();
    const interval = input.cadence === "hourly" ? 3_600_000 : 86_400_000;
    const cutoff = new Date(Math.floor(input.scheduledAt.getTime() / interval) * interval);
    const reference = await this.options.database.$transaction(async tx => {
      const { epoch } = await readExecutionAdmission(tx);
      return this.append(tx, epoch, input.cadence, cutoff, phases(input.cadence)[0]!, null);
    });
    await this.options.register([reference.dispatchId]);
    return reference;
  }
  async run(value: ExecutionDispatchReference): Promise<MaintenanceResult> {
    const reference = executionDispatchReferenceSchema.parse(value);
    const result = await this.options.database.$transaction(async tx => {
      const { epoch } = await readExecutionAdmission(tx);
      const record = await readExecutionDispatch(tx, reference.dispatchId);
      if (!record || JSON.stringify(record.reference) !== JSON.stringify(reference) || reference.kind !== "maintenance" || reference.subject.kind !== "maintenance" || reference.generation !== 1) throw invalid();
      if (epoch !== reference.deploymentEpoch) return { kind: "superseded" as const, processed: 0, dispatchIds: [] };
      const page = parse(reference.subject.id);
      if (reference.inputHash !== await hash(epoch, reference.subject.id)) throw invalid();
      return executeExecutionPage(tx, reference, "maintenance-page", async () => {
      const sequence = phases(page.cadence);
      for (let index = sequence.indexOf(page.phase); index < sequence.length; index++) {
        const phase = sequence[index]!, handler = this.options.phases[phase];
        if (!handler) throw new ExecutionMaintenanceError("maintenance_phase_unavailable");
        const after = phase === page.phase ? page.after : null;
        const outcome = await handler(tx, { deploymentEpoch: epoch, cutoff: page.cutoff, after, limit: this.limit });
        if (!Number.isSafeInteger(outcome.processed) || outcome.processed < 0 || outcome.processed > this.limit || (outcome.processed === 0 && (outcome.next || outcome.dispatchIds?.length))) throw new ExecutionMaintenanceError("maintenance_page_invalid");
        const ids = [...new Set(outcome.dispatchIds ?? [])];
        if (ids.length > 127) throw new ExecutionMaintenanceError("maintenance_page_invalid");
        if (outcome.next) {
          position(outcome.next);
          if (outcome.next.at > page.cutoff || (after && (outcome.next.at < after.at || (outcome.next.at.getTime() === after.at.getTime() && (outcome.next.id < after.id || (outcome.next.id === after.id && (outcome.next.tie ?? "") <= (after.tie ?? ""))))))) throw new ExecutionMaintenanceError("maintenance_page_invalid");
        }
        const nextPhase = outcome.next ? phase : sequence[index + 1];
        if (outcome.processed > 0) {
          if (nextPhase) ids.push((await this.append(tx, epoch, page.cadence, page.cutoff, nextPhase, outcome.next)).dispatchId);
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

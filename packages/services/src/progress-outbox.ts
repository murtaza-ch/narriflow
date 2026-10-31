import type { Prisma, PrismaClient } from "@prisma/client";
import type { ExecutionDispatchReference } from "@narriflow/validators/execution";
import { appendExecutionDispatch, createExecutionDispatch, type ExecutionDispatchConfirmation, type ExecutionDispatchRecord } from "./execution-dispatch";
import { progressDeliveryPort } from "./progress-delivery";
import { progressEvent, type ProgressRevocation } from "./progress-feed";

type Tx = Prisma.TransactionClient;
type Revocation = Omit<ProgressRevocation, "projectId" | "authorizedBefore"> & { projectId?: string; authorizedBefore: number; afterProjectId?: string };
const reasons = { workspace_membership_required: "m", workspace_restricted: "w", project_inaccessible: "p" } as const;
const pendingEventRanges = new WeakMap<Tx, Set<string>>();
function compact(id: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) throw new Error("Invalid progress revocation identity");
  return btoa(String.fromCharCode(...id.replaceAll("-", "").match(/../g)!.map((value) => Number.parseInt(value, 16)))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
function expanded(id: string): string {
  if (!/^[A-Za-z0-9_-]{22}$/.test(id)) throw new Error("Invalid progress revocation identity");
  const hex = Array.from(atob(id.replaceAll("-", "+").replaceAll("_", "/")), (value) => value.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  if (compact(uuid) !== id) throw new Error("Noncanonical progress revocation identity");
  return uuid;
}
function encode(input: Revocation): string {
  return ["pr1", compact(input.workspaceId), input.actorUserId ? compact(input.actorUserId) : "all", input.projectId ? compact(input.projectId) : "all", input.authorizedBefore, reasons[input.error], input.afterProjectId ? compact(input.afterProjectId) : "start"].join(".");
}
function decode(id: string): Revocation {
  const [version, workspace, actor, project, cutoff, reason, after, extra] = id.split(".");
  const error = (Object.entries(reasons) as Array<[ProgressRevocation["error"], string]>).find(([, value]) => value === reason)?.[0];
  const authorizedBefore = Number(cutoff);
  if (version !== "pr1" || !workspace || !actor || !project || !after || extra !== undefined || !error || !Number.isSafeInteger(authorizedBefore) || authorizedBefore < 0) throw new Error("Invalid progress revocation reference");
  const value: Revocation = { workspaceId: expanded(workspace), ...(actor === "all" ? {} : { actorUserId: expanded(actor) }), ...(project === "all" ? {} : { projectId: expanded(project) }), authorizedBefore, error, ...(after === "start" ? {} : { afterProjectId: expanded(after) }) };
  if (encode(value) !== id) throw new Error("Noncanonical progress revocation reference");
  return value;
}
async function hash(kind: string, id: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["project_progress", kind, id])))), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function append(tx: Tx, subject: ExecutionDispatchReference["subject"], dueAt: Date, deploymentEpoch?: number): Promise<ExecutionDispatchRecord> {
  const epoch = deploymentEpoch ?? (await tx.executionEpoch.findUniqueOrThrow({ where: { id: 1 } })).epoch;
  return appendExecutionDispatch(tx, { deploymentEpoch: epoch, kind: "project_progress", subject, wakeKind: subject.kind === "workflow_event" ? "progress.event" : "progress.revoke", generation: 1, inputHash: await hash(subject.kind, subject.id), dueAt });
}

/** Called in the same transaction as the event. No delivery can precede commit. */
export async function appendProgressEventDispatch(tx: Tx, event: { id: string; projectId: string; seq: number; emittedAt: Date }): Promise<ExecutionDispatchRecord> {
  const record = await append(tx, { kind: "workflow_event", id: event.id }, event.emittedAt);
  queueProjectProgressCatchup(tx, event.projectId);
  return record;
}

/** A replay must recover committed, unconfirmed event obligations even when it
 * changes no domain row. This queues identities only until all locks are held. */
export function queueProjectProgressCatchup(tx: Tx, projectId: string): void {
  compact(projectId);
  let projects = pendingEventRanges.get(tx);
  if (!projects) { projects = new Set(); pendingEventRanges.set(tx, projects); }
  projects.add(projectId);
}

function eventRangeId(projectId: string, after: number, through: number) { return `pe1.${compact(projectId)}.${after}.${through}`; }
function eventRange(id: string) {
  const [version, project, lower, upper, extra] = id.split(".");
  const after = Number(lower), through = Number(upper);
  if (version !== "pe1" || !project || extra !== undefined || !Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(through) || through <= after || through > 2147483647) throw new Error("Invalid progress event range");
  const projectId = expanded(project);
  if (eventRangeId(projectId, after, through) !== id) throw new Error("Noncanonical progress event range");
  return { projectId, after, through };
}

/** One receipt identifier per Project and transaction, even for cancellation
 * pages that emit more than a hundred events. Rollback discards both ledgers. */
export async function flushProjectProgressDrains(tx: Tx): Promise<string[]> {
  const ranges = pendingEventRanges.get(tx);
  pendingEventRanges.delete(tx);
  if (!ranges) return [];
  if (ranges.size > 128) throw new Error("Progress transaction exceeds its Project limit");
  const ids: string[] = [];
  for (const projectId of ranges) {
    const [first] = await tx.$queryRaw<Array<{ seq: number }>>`SELECT event.seq FROM "WorkflowEvent" event WHERE event."projectId" = ${projectId}::uuid
      AND event."progressRequired" = true AND event."progressPublishedAt" IS NULL AND EXISTS (
        SELECT 1 FROM "ExecutionDispatch" dispatch JOIN "ExecutionEpoch" epoch ON epoch.id = 1 AND epoch.epoch = dispatch."deploymentEpoch"
        WHERE dispatch.kind = 'project_progress' AND dispatch."subjectKind" = 'workflow_event' AND dispatch."subjectId" = event.id::text)
      ORDER BY event.seq ASC LIMIT 1`;
    if (!first) continue;
    const [last] = await tx.$queryRaw<Array<{ seq: number }>>`SELECT event.seq FROM "WorkflowEvent" event WHERE event."projectId" = ${projectId}::uuid
      AND event."progressRequired" = true AND event."progressPublishedAt" IS NULL AND EXISTS (
        SELECT 1 FROM "ExecutionDispatch" dispatch JOIN "ExecutionEpoch" epoch ON epoch.id = 1 AND epoch.epoch = dispatch."deploymentEpoch"
        WHERE dispatch.kind = 'project_progress' AND dispatch."subjectKind" = 'workflow_event' AND dispatch."subjectId" = event.id::text)
      ORDER BY event.seq DESC LIMIT 1`;
    if (last) ids.push((await append(tx, { kind: "maintenance", id: eventRangeId(projectId, first.seq - 1, last.seq) }, new Date(0))).reference.dispatchId);
  }
  return ids;
}

/** Cutoff is read from PostgreSQL after the owning mutation/lock, never from a
 * caller's clock. Reference contains identities and a cutoff, without content. */
export async function appendProgressRevocation(tx: Tx, scope: Omit<Revocation, "authorizedBefore" | "afterProjectId">): Promise<ExecutionDispatchRecord> {
  const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"`;
  if (!clock) throw new Error("Progress revocation clock unavailable");
  return append(tx, { kind: "maintenance", id: encode({ ...scope, authorizedBefore: clock.now.getTime() }) }, clock.now);
}

export interface ProgressDispatchConfirmation extends ExecutionDispatchConfirmation { continuationDispatchIds: string[] }
/** Invoked by the Worker dispatch scheduler. One delivery is one bounded page. */
export async function deliverProgressDispatch(database: PrismaClient, reference: ExecutionDispatchReference): Promise<ProgressDispatchConfirmation> {
  if (reference.kind !== "project_progress" || reference.generation !== 1 || reference.inputHash !== await hash(reference.subject.kind, reference.subject.id)) throw new Error("Invalid progress dispatch");
  const port = progressDeliveryPort();
  if (!port) throw new Error("Progress destination unavailable");
  const continuationDispatchIds: string[] = [];
  if (reference.subject.kind === "workflow_event") {
    const event = await database.workflowEvent.findUnique({ where: { id: reference.subject.id }, include: { project: { select: { workspaceId: true } } } });
    if (event && !event.progressPublishedAt) {
      await port.publish({ projectId: event.projectId, workspaceId: event.project.workspaceId }, progressEvent(event));
      await database.workflowEvent.updateMany({ where: { id: event.id, progressPublishedAt: null }, data: { progressPublishedAt: new Date() } });
    }
  } else if (reference.subject.kind === "maintenance" && reference.subject.id.startsWith("pe1.")) {
    const range = eventRange(reference.subject.id);
    const events = await database.workflowEvent.findMany({ where: { projectId: range.projectId, seq: { gt: range.after, lte: range.through }, progressPublishedAt: null }, orderBy: { seq: "asc" }, take: 101, select: { id: true, seq: true, emittedAt: true } });
    const page = events.slice(0, 100);
    const obligations = await database.executionDispatch.findMany({ where: { deploymentEpoch: reference.deploymentEpoch, kind: "project_progress", subjectKind: "workflow_event", subjectId: { in: page.map(event => event.id) } }, select: { id: true, subjectId: true } });
    const byEvent = new Map(obligations.map(row => [row.subjectId, row.id]));
    const dispatch = createExecutionDispatch({ database, scheduler: { deliver: delivery => deliverProgressDispatch(database, delivery.reference) } });
    for (let offset = 0; offset < page.length; offset += 4) {
      const outcomes = await Promise.all(page.slice(offset, offset + 4).map(async event => {
        const id = byEvent.get(event.id);
        if (!id) throw new Error("Progress event obligation unavailable");
        return dispatch.deliver(id);
      }));
      if (outcomes.some(outcome => outcome.status !== "acknowledged" && outcome.status !== "superseded")) throw new Error("Progress event page unconfirmed");
    }
    if (events.length > 100) {
      const next = await database.$transaction(tx => append(tx, { kind: "maintenance", id: eventRangeId(range.projectId, page.at(-1)!.seq, range.through) }, new Date(0), reference.deploymentEpoch));
      continuationDispatchIds.push(next.reference.dispatchId);
    }
  } else if (reference.subject.kind === "maintenance") {
    const scope = decode(reference.subject.id);
    const projects = scope.projectId ? [{ id: scope.projectId }] : await database.project.findMany({ where: { workspaceId: scope.workspaceId, ...(scope.afterProjectId ? { id: { gt: scope.afterProjectId } } : {}) }, orderBy: { id: "asc" }, take: 100, select: { id: true } });
    if (!scope.projectId && projects.length === 100) {
      const next = await database.$transaction((tx) => append(tx, { kind: "maintenance", id: encode({ ...scope, afterProjectId: projects.at(-1)!.id }) }, new Date(scope.authorizedBefore), reference.deploymentEpoch));
      continuationDispatchIds.push(next.reference.dispatchId);
    }
    // Bound simultaneous DO calls as well as the SQL page.
    for (let offset = 0; offset < projects.length; offset += 10) {
      await Promise.all(projects.slice(offset, offset + 10).map((project) => port.revoke({ projectId: project.id, workspaceId: scope.workspaceId, ...(scope.actorUserId ? { actorUserId: scope.actorUserId } : {}), authorizedBefore: scope.authorizedBefore, error: scope.error })));
    }
  } else throw new Error("Unsupported progress dispatch subject");
  if (continuationDispatchIds.length) await port.registerContinuations(continuationDispatchIds);
  return { status: "confirmed_notified", destinationId: `project-progress:${reference.subject.id}`, continuationDispatchIds };
}

/** Fast post-commit delivery uses the same durable claim and checkpoint. A
 * failed push remains due in ExecutionDispatch for its normal retry owner. */
export async function deliverProgressAfterCommit(database: PrismaClient, records: readonly (ExecutionDispatchRecord | undefined)[]): Promise<void> {
  if (!progressDeliveryPort()) return;
  const dispatch = createExecutionDispatch({ database, scheduler: { deliver: (delivery) => deliverProgressDispatch(database, delivery.reference) } });
  for (const record of records) if (record) {
    try {
      const result = await dispatch.deliver(record.reference.dispatchId);
      if (result.status === "pending" || result.status === "unavailable") {
        await progressDeliveryPort()!.registerContinuations([record.reference.dispatchId]);
      }
      if (result.status !== "acknowledged") console.warn(JSON.stringify({ level: "warn", message: "progress_revocation_delivery_pending", dispatchId: record.reference.dispatchId, outcome: result.status }));
    }
    catch { console.warn(JSON.stringify({ level: "warn", message: "progress_revocation_delivery_pending", dispatchId: record.reference.dispatchId })); }
  }
}

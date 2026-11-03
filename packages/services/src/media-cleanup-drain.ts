import { executeExecutionPage } from "./execution-page-receipt";
import { Prisma, type PrismaClient } from "@prisma/client";
import { executionDispatchReferenceSchema, type ExecutionDispatchReference } from "@narriflow/validators/execution";
import { appendExecutionDispatch, readExecutionDispatch } from "./execution-dispatch";
import { collectExecutionDispatch } from "./execution-dispatch-runtime";
import { readExecutionAdmission } from "./execution-admission";
import { queueMediaCleanupBatchWithinTransaction, MediaCleanupControlError } from "./media-cleanup-control";

type Position = { id: string; at: Date };
const invalid = () => new MediaCleanupControlError("cleanup_reference_invalid");
function point(value: Position) { return `${value.at.getTime()}.${value.id.replaceAll("-", "")}`; }
function identity(first: Position, through: Position, after: Position | null) { return `mc1.${point(first)}.${point(through)}${after ? `.${point(after)}` : ""}`; }
function parse(id: string) {
  const match = /^mc1\.(0|[1-9][0-9]{0,12})\.([a-f0-9]{32})\.(0|[1-9][0-9]{0,12})\.([a-f0-9]{32})(?:\.(0|[1-9][0-9]{0,12})\.([a-f0-9]{32}))?$/.exec(id);
  if (!match) throw invalid();
  const value = (at: string, id: string): Position => ({ at: new Date(Number(at)), id: `${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}` });
  const first = value(match[1]!, match[2]!), through = value(match[3]!, match[4]!), after = match[5] ? value(match[5], match[6]!) : null;
  const compare = (a: Position, b: Position) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id);
  if (compare(first, through) > 0 || (after && (compare(after, first) < 0 || compare(after, through) > 0)) || identity(first, through, after) !== id) throw invalid();
  return { first, through, after };
}
async function hash(epoch: number, id: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["media-cleanup-drain-v1", epoch, id])))), byte => byte.toString(16).padStart(2, "0")).join("");
}
async function append(tx: Prisma.TransactionClient, epoch: number, first: Position, through: Position, after: Position | null) {
  const id = identity(first, through, after);
  const record = await appendExecutionDispatch(tx, { deploymentEpoch: epoch, generation: 1, kind: "maintenance", subject: { kind: "maintenance", id }, inputHash: await hash(epoch, id), dueAt: new Date(0) });
  collectExecutionDispatch(tx, record.reference.dispatchId);
  return record.reference;
}
/** A producer freezes a known-row range, never a bucket inventory. Other
 * admitted intents in the same range may safely share this bounded drain. */
export async function queueMediaCleanupRangeWithinTransaction(tx: Prisma.TransactionClient, ids: readonly string[]) {
  if (!ids.length) return null;
  const rows = await tx.mediaCleanupObligation.findMany({ where: { id: { in: [...ids] }, completedAt: null }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, createdAt: true } });
  if (!rows.length) return null;
  const epoch = await tx.executionEpoch.findUniqueOrThrow({ where: { id: 1 } });
  const first = rows[0]!, through = rows.at(-1)!;
  return append(tx, epoch.epoch, { id: first.id, at: first.createdAt }, { id: through.id, at: through.createdAt }, null);
}
export function createMediaCleanupDrain(options: { database: PrismaClient; register(ids: readonly string[]): Promise<void>; limit?: number }) {
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw invalid();
  return { async run(value: ExecutionDispatchReference) {
    const reference = executionDispatchReferenceSchema.parse(value);
    const result = await options.database.$transaction(async tx => {
      const { epoch } = await readExecutionAdmission(tx), record = await readExecutionDispatch(tx, reference.dispatchId);
      if (!record || JSON.stringify(record.reference) !== JSON.stringify(reference) || reference.kind !== "maintenance" || reference.subject.kind !== "maintenance" || reference.generation !== 1) throw invalid();
      if (epoch !== reference.deploymentEpoch) return { kind: "superseded" as const, processed: 0, dispatchIds: [] };
      const { first, through, after } = parse(reference.subject.id);
      if (reference.inputHash !== await hash(epoch, reference.subject.id)) throw invalid();
      return executeExecutionPage(tx, reference, "maintenance-page", async () => {
      const start = after ? Prisma.sql`("createdAt", id) > ((${after.at}::timestamp), ${after.id}::uuid)` : Prisma.sql`("createdAt", id) >= ((${first.at}::timestamp), ${first.id}::uuid)`;
      const rows = await tx.$queryRaw<Array<{ id: string; at: Date }>>`SELECT id, "createdAt" AS at FROM "MediaCleanupObligation" WHERE ${start}
        AND ("createdAt", id) <= ((${through.at}::timestamp), ${through.id}::uuid) ORDER BY "createdAt", id LIMIT ${limit + 1}`;
      const selected = rows.slice(0, limit);
      const dispatchIds = (await queueMediaCleanupBatchWithinTransaction(tx, selected.map(row => row.id))).map(reference => reference.dispatchId);
      if (rows.length > limit) dispatchIds.push((await append(tx, epoch, first, through, selected.at(-1)!)).dispatchId);
      return { kind: rows.length > limit ? "continue" as const : "complete" as const, processed: selected.length, dispatchIds };
      });
    });
    if (result.dispatchIds.length) await options.register(result.dispatchIds);
    return result;
  } };
}

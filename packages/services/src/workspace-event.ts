import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  WORKSPACE_EVENT_DEFAULT_LIMIT,
  WORKSPACE_EVENT_MAX_LIMIT,
  WORKSPACE_EVENT_RETENTION_DAYS,
  type WorkspaceEventOrder,
  type WorkspaceEventSubjects,
  type WorkspaceEventType,
  type WorkspaceEventView,
} from "@narriflow/validators";

type Tx = Prisma.TransactionClient;

/** Every type is at version 1. A breaking change to a subject adds a version. */
const EVENT_VERSION = 1;

export interface WorkspaceEventInput<T extends WorkspaceEventType = WorkspaceEventType> {
  workspaceId: string;
  /** The Project the transition belongs to, whose deletion also deletes the
   * event's key. Null when it ended before any Project existed. */
  projectId: string | null;
  type: T;
  subject: WorkspaceEventSubjects[T];
  /** Names the transition. Choose it so a retry or replay of the same
   * transition repeats it, and a later transition of the same thing does not. */
  dedupeKey: string;
  occurredAt?: Date;
}

const queued = new WeakMap<object, WorkspaceEventInput[]>();

/** Remembers an event for the end of the transaction. Nothing is written, so
 * the caller may queue from anywhere inside it without taking a lock. The
 * transaction must end with `flushWorkspaceEvents`; an event queued by an
 * attempt that rolls back or retries is dropped with that attempt's `tx`. */
export function queueWorkspaceEvent<T extends WorkspaceEventType>(tx: Tx, input: WorkspaceEventInput<T>): void {
  const pending = queued.get(tx) ?? [];
  pending.push({ ...input, occurredAt: input.occurredAt ?? new Date() } as WorkspaceEventInput);
  queued.set(tx, pending);
}

/** Writes the queued events in one batch, as the transaction's last act.
 *
 * Each dedupe key is claimed first in `WorkspaceEventKey`, which the retention
 * purge never touches, so a replay or a later settlement of the same lineage
 * writes nothing even after the event itself expired. Only a batch with at
 * least one new key takes the Workspace counter, once per Workspace, bumping it
 * by the batch size. That row lock holds until commit, so a second writer takes
 * the next `seq` only after this batch is visible: commit order is `seq` order,
 * and a reader never sees a gap fill in behind its cursor. Taking the counter
 * last, after every other lock the transaction needs, is what keeps it out of
 * lock-order cycles with the Project, export and run rows. */
export async function flushWorkspaceEvents(tx: Tx): Promise<void> {
  const pending = queued.get(tx);
  queued.delete(tx);
  if (!pending?.length) return;
  const unique = [...new Map(pending.map((event) => [event.dedupeKey, event])).values()];
  const keyRows = [...unique].sort((a, b) => (a.dedupeKey < b.dedupeKey ? -1 : 1))
    .map((event) => Prisma.sql`(${event.dedupeKey}, ${event.workspaceId}::uuid, ${event.projectId}::uuid)`);
  const claimed = new Set((await tx.$queryRaw<Array<{ dedupeKey: string }>>(Prisma.sql`
    INSERT INTO "WorkspaceEventKey" ("dedupeKey", "workspaceId", "projectId") VALUES ${Prisma.join(keyRows)}
    ON CONFLICT ("dedupeKey") DO NOTHING RETURNING "dedupeKey"
  `)).map((row) => row.dedupeKey));
  const fresh = unique.filter((event) => claimed.has(event.dedupeKey));
  if (fresh.length === 0) return;

  const byWorkspace = new Map<string, WorkspaceEventInput[]>();
  for (const event of fresh) byWorkspace.set(event.workspaceId, [...(byWorkspace.get(event.workspaceId) ?? []), event]);
  const rows: Prisma.Sql[] = [];
  for (const workspaceId of [...byWorkspace.keys()].sort()) {
    const batch = byWorkspace.get(workspaceId)!;
    const [counter] = await tx.$queryRaw<Array<{ lastSeq: bigint }>>`
      INSERT INTO "WorkspaceEventCounter" ("workspaceId", "lastSeq") VALUES (${workspaceId}::uuid, ${batch.length}::bigint)
      ON CONFLICT ("workspaceId") DO UPDATE SET "lastSeq" = "WorkspaceEventCounter"."lastSeq" + ${batch.length}::bigint
      RETURNING "lastSeq"
    `;
    const first = counter!.lastSeq - BigInt(batch.length) + 1n;
    for (const [index, event] of batch.entries()) {
      rows.push(Prisma.sql`(${randomUUID()}::uuid, ${workspaceId}::uuid, ${first + BigInt(index)}::bigint, ${event.type},
        ${EVENT_VERSION}, ${JSON.stringify(event.subject)}::jsonb, (${event.occurredAt!.toISOString()}::timestamptz AT TIME ZONE 'UTC'), ${event.dedupeKey})`);
    }
  }
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "WorkspaceEvent" ("id", "workspaceId", "seq", "type", "version", "subject", "occurredAt", "dedupeKey")
    VALUES ${Prisma.join(rows)} ON CONFLICT ("dedupeKey") DO NOTHING
  `);
}

/** Appends one Workspace Event as the last act of the transaction that made the
 * transition it reports. Use `queueWorkspaceEvent` when other work, or other
 * events, may still follow in the same transaction. */
export async function appendWorkspaceEvent<T extends WorkspaceEventType>(tx: Tx, input: WorkspaceEventInput<T>): Promise<void> {
  queueWorkspaceEvent(tx, input);
  await flushWorkspaceEvents(tx);
}

export interface WorkspaceEventQuery {
  /** The last `seq` the reader processed. Omitted means from the oldest retained event. */
  after?: string | null;
  limit?: number;
  /** Omitted or empty means every type. */
  types?: readonly WorkspaceEventType[];
  /** `asc` (the default) reads forward from `after`. `desc` reads the newest
   * `limit` matching events, newest first, and has no `after`. */
  order?: WorkspaceEventOrder;
}

/** One page of a Workspace's events. Ascending, `nextCursor` is the last
 * returned `seq`, or the input cursor when nothing is newer. Descending, the
 * page is the newest matching events, newest first, and `nextCursor` is the
 * highest `seq` on it (the first row): a forward cursor, so it never points
 * backwards. An empty descending page's cursor is the Workspace's head as it
 * was before the read, so nothing committed after it is skipped. */
export async function listWorkspaceEvents(
  db: Pick<PrismaClient, "workspaceEvent" | "workspaceEventCounter">,
  scope: { workspaceId: string },
  query: WorkspaceEventQuery = {},
): Promise<{ data: WorkspaceEventView[]; nextCursor: string }> {
  const limit = Math.min(Math.max(query.limit ?? WORKSPACE_EVENT_DEFAULT_LIMIT, 1), WORKSPACE_EVENT_MAX_LIMIT);
  const types = query.types?.length ? { type: { in: [...query.types] } } : {};
  const view = (rows: Awaited<ReturnType<typeof db.workspaceEvent.findMany>>) => rows.map((row) => ({ id: row.id, seq: Number(row.seq), type: row.type, version: row.version,
    occurredAt: row.occurredAt.toISOString(), subject: row.subject }) as WorkspaceEventView);
  if (query.order === "desc") {
    if (query.after) throw new Error("A descending read has no cursor to continue from");
    // Read before the page: an event that commits in between has a higher seq than this head.
    const head = (await db.workspaceEventCounter.findUnique({ where: { workspaceId: scope.workspaceId }, select: { lastSeq: true } }))?.lastSeq ?? 0n;
    // The (workspaceId, seq) unique index, read backwards.
    const rows = await db.workspaceEvent.findMany({ where: { workspaceId: scope.workspaceId, ...types }, orderBy: { seq: "desc" }, take: limit });
    return { data: view(rows), nextCursor: rows.length > 0 ? String(rows[0]!.seq) : String(head) };
  }
  const after = query.after ?? "0";
  const rows = await db.workspaceEvent.findMany({
    where: { workspaceId: scope.workspaceId, seq: { gt: BigInt(after) }, ...types },
    orderBy: { seq: "asc" },
    take: limit,
  });
  return { data: view(rows), nextCursor: rows.length > 0 ? String(rows[rows.length - 1]!.seq) : after };
}

/** Deletes events past the retention window, oldest first, in bounded batches.
 * The counter row and the dedupe keys stay, so `seq` keeps rising and an
 * expired event is never written again. */
export async function deleteExpiredWorkspaceEvents(
  db: Pick<PrismaClient, "workspaceEvent">,
  now = new Date(),
  batchSize = 1_000,
): Promise<number> {
  const cutoff = new Date(now.getTime() - WORKSPACE_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const expired = await db.workspaceEvent.findMany({ where: { createdAt: { lt: cutoff } }, orderBy: { createdAt: "asc" }, take: batchSize, select: { id: true } });
  if (expired.length === 0) return 0;
  return (await db.workspaceEvent.deleteMany({ where: { id: { in: expired.map((row) => row.id) } } })).count;
}

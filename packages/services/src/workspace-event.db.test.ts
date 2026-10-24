import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { appendWorkspaceEvent, deleteExpiredWorkspaceEvents, flushWorkspaceEvents, listWorkspaceEvents, queueWorkspaceEvent } from "./workspace-event";
import { listEvents } from "./integration-commands";

const url = process.env.INTEGRATION_TEST_DATABASE_URL;
const schema = process.env.INTEGRATION_TEST_DATABASE_SCHEMA;
const enabled = process.env.ALLOW_INTEGRATION_DB_TESTS === "1" && Boolean(url);
const db = enabled ? describe : describe.skip;
setDefaultTimeout(180_000);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

db("Workspace Event feed", () => {
  let prisma: PrismaClient;
  let pool: Pool;
  let userId: string;
  const projectId = randomUUID();
  const globals = globalThis as unknown as { narriflowPrismaClient?: PrismaClient };
  let previousGlobalPrisma: PrismaClient | undefined;

  beforeAll(async () => {
    if (!url || !schema || !/^integration_test_[a-z0-9_]+$/.test(schema)) throw new Error("Workspace Event tests require a disposable schema");
    pool = new Pool({ connectionString: url, max: 40 });
    if ((await pool.query("SELECT current_schema() AS schema")).rows[0]?.schema !== schema) throw new Error("Wrong disposable schema");
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }), transactionOptions: { maxWait: 60_000, timeout: 60_000 } });
    // listEvents reads through the shared client.
    previousGlobalPrisma = globals.narriflowPrismaClient;
    globals.narriflowPrismaClient = prisma;
    userId = (await prisma.user.create({ data: { clerkId: `workspace-event:${randomUUID()}` } })).id;
  });
  afterAll(async () => {
    globals.narriflowPrismaClient = previousGlobalPrisma;
    await prisma?.$disconnect();
    await pool?.end();
  });

  async function workspace() {
    return (await prisma.workspace.create({ data: { name: "Events", ownerUserId: userId, pricingTier: "business", members: { create: { userId, role: "owner" } } } })).id;
  }
  /** An operation.finished event named by `tag`, so tests can tell rows apart. */
  const finished = (workspaceId: string, tag: string, key = `test:${workspaceId}:${tag}`) => ({
    workspaceId, projectId: null, type: "operation.finished" as const, dedupeKey: key,
    subject: { operation: { kind: "export" as const, id: tag }, projectId, state: "completed" as const },
  });
  const tags = (page: Awaited<ReturnType<typeof listWorkspaceEvents>>) =>
    page.data.map((event) => (event.subject as { operation: { id: string } }).operation.id);

  test("two interleaved transactions commit in seq order, and a blocked writer waits for the first to commit", async () => {
    const workspaceId = await workspace();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let firstAppended = false;
    let secondAppended = false;
    const first = prisma.$transaction(async (tx) => {
      await appendWorkspaceEvent(tx, finished(workspaceId, "first"));
      firstAppended = true;
      await gate;
    });
    while (!firstAppended) await sleep(5);
    const second = prisma.$transaction(async (tx) => {
      await appendWorkspaceEvent(tx, finished(workspaceId, "second"));
      secondAppended = true;
    });
    await sleep(300);
    // The first transaction's counter lock holds until it commits.
    expect(secondAppended).toBe(false);
    expect(await listWorkspaceEvents(prisma, { workspaceId })).toEqual({ data: [], nextCursor: "0" });
    release();
    await Promise.all([first, second]);
    const page = await listWorkspaceEvents(prisma, { workspaceId });
    expect(tags(page)).toEqual(["first", "second"]);
    expect(page.data.map((event) => event.seq)).toEqual([1, 2]);
  });

  test("a reader polling during 24 racing writers only ever sees a gapless prefix", async () => {
    const workspaceId = await workspace();
    const snapshots: number[][] = [];
    let writing = true;
    const reader = (async () => {
      while (writing) {
        const rows = await prisma.workspaceEvent.findMany({ where: { workspaceId }, orderBy: { seq: "asc" }, select: { seq: true } });
        snapshots.push(rows.map((row) => Number(row.seq)));
        await sleep(2);
      }
    })();
    await Promise.all(Array.from({ length: 24 }, (_, index) => prisma.$transaction(async (tx) => {
      await sleep(Math.random() * 30);
      await appendWorkspaceEvent(tx, finished(workspaceId, `racer-${index}`));
      await sleep(Math.random() * 30);
    })));
    writing = false;
    await reader;
    expect(snapshots.length).toBeGreaterThan(3);
    for (const seqs of snapshots) expect(seqs).toEqual(seqs.map((_, index) => index + 1));
    const final = await listWorkspaceEvents(prisma, { workspaceId }, { limit: 200 });
    expect(final.data.map((event) => event.seq)).toEqual(Array.from({ length: 24 }, (_, index) => index + 1));
  });

  test("a rolled-back transaction consumes no seq", async () => {
    const workspaceId = await workspace();
    await expect(prisma.$transaction(async (tx) => {
      await appendWorkspaceEvent(tx, finished(workspaceId, "lost"));
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    await prisma.$transaction((tx) => appendWorkspaceEvent(tx, finished(workspaceId, "kept")));
    const page = await listWorkspaceEvents(prisma, { workspaceId });
    expect(tags(page)).toEqual(["kept"]);
    expect(page.data[0]?.seq).toBe(1);
  });

  test("one dedupe key writes once and advances the counter once, including racing writers", async () => {
    const workspaceId = await workspace();
    await Promise.all(Array.from({ length: 6 }, () => prisma.$transaction((tx) => appendWorkspaceEvent(tx, finished(workspaceId, "same", `test:${workspaceId}:same`)))));
    expect(await prisma.workspaceEvent.count({ where: { workspaceId } })).toBe(1);
    expect((await prisma.workspaceEventCounter.findUniqueOrThrow({ where: { workspaceId } })).lastSeq).toBe(1n);
    // A sequential retry is a no-op, and the next event is seq 2: no gap.
    await prisma.$transaction((tx) => appendWorkspaceEvent(tx, finished(workspaceId, "same", `test:${workspaceId}:same`)));
    await prisma.$transaction((tx) => appendWorkspaceEvent(tx, finished(workspaceId, "next")));
    expect((await listWorkspaceEvents(prisma, { workspaceId })).data.map((event) => event.seq)).toEqual([1, 2]);
  });

  test("each Workspace counts its own seq", async () => {
    const [one, two] = [await workspace(), await workspace()];
    await prisma.$transaction(async (tx) => {
      await appendWorkspaceEvent(tx, finished(one, "a"));
      await appendWorkspaceEvent(tx, finished(two, "b"));
      await appendWorkspaceEvent(tx, finished(one, "c"));
    });
    expect((await listWorkspaceEvents(prisma, { workspaceId: one })).data.map((event) => event.seq)).toEqual([1, 2]);
    expect((await listWorkspaceEvents(prisma, { workspaceId: two })).data.map((event) => event.seq)).toEqual([1]);
  });

  test("reads page by seq, filter by type, and echo the cursor when nothing is newer", async () => {
    const workspaceId = await workspace();
    await prisma.$transaction(async (tx) => {
      for (const tag of ["a", "b", "c"]) await appendWorkspaceEvent(tx, finished(workspaceId, tag));
      await appendWorkspaceEvent(tx, { workspaceId, projectId: null, type: "autopilot.episode_imported", dedupeKey: `test:${workspaceId}:episode`,
        subject: { ruleId: randomUUID(), projectId, episodeId: "guid-1" } });
    });
    const first = await listWorkspaceEvents(prisma, { workspaceId }, { limit: 2 });
    expect(tags(first)).toEqual(["a", "b"]);
    expect(first.nextCursor).toBe("2");
    const second = await listWorkspaceEvents(prisma, { workspaceId }, { after: first.nextCursor, limit: 2 });
    expect(second.data.map((event) => event.type)).toEqual(["operation.finished", "autopilot.episode_imported"]);
    expect(second.nextCursor).toBe("4");
    expect(await listWorkspaceEvents(prisma, { workspaceId }, { after: "4" })).toEqual({ data: [], nextCursor: "4" });
    const imported = await listWorkspaceEvents(prisma, { workspaceId }, { types: ["autopilot.episode_imported"] });
    expect(imported.data).toHaveLength(1);
    expect(imported.data[0]).toMatchObject({ seq: 4, version: 1, subject: { episodeId: "guid-1" } });
    // An empty list is every type, as it is for the REST query and the MCP tool.
    expect((await listWorkspaceEvents(prisma, { workspaceId }, { types: [] })).data).toHaveLength(4);
    expect(Number.isNaN(Date.parse(first.data[0]!.occurredAt))).toBe(false);
  });

  test("posting outcomes are filtered without publishing:read, and the cursor still advances past visible rows only", async () => {
    const workspaceId = await workspace();
    await prisma.$transaction(async (tx) => {
      await appendWorkspaceEvent(tx, finished(workspaceId, "visible-1"));
      await appendWorkspaceEvent(tx, { workspaceId, projectId: null, type: "social_post.finished", dedupeKey: `test:${workspaceId}:post`,
        subject: { socialPostId: randomUUID(), projectId, clipId: null, platform: "youtube_shorts", state: "posted" } });
      await appendWorkspaceEvent(tx, finished(workspaceId, "visible-2"));
    });
    const actor = { actorUserId: userId, workspaceId };
    const without = await listEvents(actor, { scopes: ["projects:read"] }, {});
    expect(without.data.map((event) => event.type)).toEqual(["operation.finished", "operation.finished"]);
    expect(without.nextCursor).toBe("3");
    const withScope = await listEvents(actor, { scopes: ["projects:read", "publishing:read"] }, {});
    expect(withScope.data.map((event) => event.type)).toEqual(["operation.finished", "social_post.finished", "operation.finished"]);
    // Asking for only hidden types is refused with the scope it lacks, not answered with an empty page...
    await expect(listEvents(actor, { scopes: ["projects:read"] }, { types: ["social_post.finished"] })).rejects.toMatchObject({ code: "scope_required", details: { scope: "publishing:read" } });
    // ...while hidden types among visible ones are filtered out silently.
    expect((await listEvents(actor, { scopes: ["projects:read"] }, { types: ["social_post.finished", "operation.finished"] })).data.map((event) => event.seq)).toEqual([1, 3]);
    expect((await listEvents(actor, { scopes: ["projects:read", "publishing:read"] }, { types: ["social_post.finished"] })).data).toHaveLength(1);
  });

  test("a descending read is the newest matching events, newest first, with a forward cursor", async () => {
    const workspaceId = await workspace();
    expect(await listWorkspaceEvents(prisma, { workspaceId }, { order: "desc" })).toEqual({ data: [], nextCursor: "0" });
    await prisma.$transaction(async (tx) => {
      for (const tag of ["a", "b", "c"]) await appendWorkspaceEvent(tx, finished(workspaceId, tag));
      await appendWorkspaceEvent(tx, { workspaceId, projectId: null, type: "autopilot.episode_imported", dedupeKey: `test:${workspaceId}:episode`,
        subject: { ruleId: randomUUID(), projectId, episodeId: "guid-1" } });
    });
    const newest = await listWorkspaceEvents(prisma, { workspaceId }, { order: "desc", limit: 2 });
    expect(newest.data.map((event) => event.seq)).toEqual([4, 3]);
    expect(newest.nextCursor).toBe("4");
    // The default stays ascending.
    expect((await listWorkspaceEvents(prisma, { workspaceId }, { limit: 2 })).data.map((event) => event.seq)).toEqual([1, 2]);
    const operations = await listWorkspaceEvents(prisma, { workspaceId }, { order: "desc", types: ["operation.finished"], limit: 2 });
    expect(operations.data.map((event) => event.seq)).toEqual([3, 2]);
    expect(operations.nextCursor).toBe("3");
    // Nothing matches: the cursor is the head, so ascending polling from it misses nothing.
    expect(await listWorkspaceEvents(prisma, { workspaceId }, { order: "desc", types: ["social_post.proposed"] })).toEqual({ data: [], nextCursor: "4" });
    // A cursor to continue from makes no sense for the newest page.
    await expect(listWorkspaceEvents(prisma, { workspaceId }, { order: "desc", after: "2" })).rejects.toThrow();
    await expect(listEvents({ actorUserId: userId, workspaceId }, { scopes: ["projects:read"] }, { order: "desc", after: "2" })).rejects.toMatchObject({ code: "invalid_request", kind: "invalid" });
  });

  test("a descending read uses the (workspaceId, seq) index backwards, not a sort", async () => {
    const workspaceId = await workspace();
    await prisma.$transaction(async (tx) => {
      for (let index = 0; index < 5; index += 1) await appendWorkspaceEvent(tx, finished(workspaceId, `plan-${index}`));
    });
    // Planner choices vary on tiny tables, so rule out the sequential scan to see which index and direction the read is shaped for.
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
      await tx.$executeRawUnsafe("SET LOCAL enable_bitmapscan = off");
      return tx.$queryRawUnsafe<Array<Record<string, string>>>(`EXPLAIN SELECT * FROM "WorkspaceEvent" WHERE "workspaceId" = '${workspaceId}'::uuid ORDER BY "seq" DESC LIMIT 2`);
    });
    const text = plan.map((row) => Object.values(row)[0]).join("\n");
    expect(text).toContain("Index Scan Backward");
    expect(text).toContain("WorkspaceEvent_workspaceId_seq_key");
    expect(text).not.toContain("Sort");
  });

  test("events outlive their Project, and retention deletes only rows older than 30 days", async () => {
    const workspaceId = await workspace();
    const project = await prisma.project.create({ data: { workspaceId, createdByUserId: userId, title: "Doomed", sourceMediaUrl: "r2://source.mp4" } });
    await prisma.$transaction(async (tx) => {
      await appendWorkspaceEvent(tx, { ...finished(workspaceId, "old"), projectId: project.id, subject: { operation: { kind: "export", id: "old" }, projectId: project.id, state: "completed" } });
      await appendWorkspaceEvent(tx, finished(workspaceId, "recent"));
    });
    await prisma.project.delete({ where: { id: project.id } });
    expect(await prisma.workspaceEvent.count({ where: { workspaceId } })).toBe(2);

    const now = new Date();
    const day = 24 * 60 * 60 * 1000;
    await prisma.workspaceEvent.updateMany({ where: { workspaceId, dedupeKey: `test:${workspaceId}:old` }, data: { createdAt: new Date(now.getTime() - 31 * day) } });
    await prisma.workspaceEvent.updateMany({ where: { workspaceId, dedupeKey: `test:${workspaceId}:recent` }, data: { createdAt: new Date(now.getTime() - 29 * day) } });
    expect(await deleteExpiredWorkspaceEvents(prisma, now)).toBe(1);
    expect(tags(await listWorkspaceEvents(prisma, { workspaceId }))).toEqual(["recent"]);
    expect(await deleteExpiredWorkspaceEvents(prisma, now)).toBe(0);

    // The counter outlives its events, so seq never repeats.
    await prisma.$transaction((tx) => appendWorkspaceEvent(tx, finished(workspaceId, "after")));
    expect((await listWorkspaceEvents(prisma, { workspaceId })).data.map((event) => event.seq)).toEqual([2, 3]);
    // Without a cursor the feed starts at the oldest retained row.
    expect(tags(await listWorkspaceEvents(prisma, { workspaceId }))[0]).toBe("recent");
  });

  test("an expired event is never written again, because its key outlives it", async () => {
    const workspaceId = await workspace();
    await prisma.$transaction((tx) => appendWorkspaceEvent(tx, finished(workspaceId, "once")));
    const day = 24 * 60 * 60 * 1000;
    await prisma.workspaceEvent.updateMany({ where: { workspaceId }, data: { createdAt: new Date(Date.now() - 31 * day) } });
    expect(await deleteExpiredWorkspaceEvents(prisma)).toBeGreaterThanOrEqual(1);
    expect(await prisma.workspaceEvent.count({ where: { workspaceId } })).toBe(0);
    // The same transition settling again after the purge adds nothing and spends no seq.
    await prisma.$transaction((tx) => appendWorkspaceEvent(tx, finished(workspaceId, "once")));
    expect(await prisma.workspaceEvent.count({ where: { workspaceId } })).toBe(0);
    expect((await prisma.workspaceEventCounter.findUniqueOrThrow({ where: { workspaceId } })).lastSeq).toBe(1n);
  });

  test("one transaction's events take one counter bump, in queue order, and drop duplicate keys", async () => {
    const workspaceId = await workspace();
    await prisma.$transaction(async (tx) => {
      for (const tag of ["a", "b", "a", "c"]) queueWorkspaceEvent(tx, finished(workspaceId, tag));
      await flushWorkspaceEvents(tx);
    });
    const page = await listWorkspaceEvents(prisma, { workspaceId });
    expect(tags(page)).toEqual(["a", "b", "c"]);
    expect(page.data.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect((await prisma.workspaceEventCounter.findUniqueOrThrow({ where: { workspaceId } })).lastSeq).toBe(3n);
  });

  test("a queued event is dropped with a transaction that rolls back, and never written without a flush", async () => {
    const workspaceId = await workspace();
    await expect(prisma.$transaction(async (tx) => {
      queueWorkspaceEvent(tx, finished(workspaceId, "rolled-back"));
      await flushWorkspaceEvents(tx);
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    await prisma.$transaction(async (tx) => { queueWorkspaceEvent(tx, finished(workspaceId, "never-flushed")); });
    expect(await prisma.workspaceEvent.count({ where: { workspaceId } })).toBe(0);
    expect(await prisma.workspaceEventKey.count({ where: { workspaceId } })).toBe(0);
  });

  test("a replay takes no counter lock, so it never waits behind another writer", async () => {
    const workspaceId = await workspace();
    await prisma.$transaction((tx) => appendWorkspaceEvent(tx, finished(workspaceId, "known")));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let holding = false;
    const holder = prisma.$transaction(async (tx) => {
      await appendWorkspaceEvent(tx, finished(workspaceId, "holder"));
      holding = true;
      await gate;
    });
    while (!holding) await sleep(5);
    // The holder owns the counter lock until it commits.
    await Promise.race([
      prisma.$transaction((tx) => appendWorkspaceEvent(tx, finished(workspaceId, "known"))),
      sleep(5_000).then(() => { throw new Error("replay waited on the counter lock"); }),
    ]);
    release();
    await holder;
    expect(tags(await listWorkspaceEvents(prisma, { workspaceId }))).toEqual(["known", "holder"]);
  });
});

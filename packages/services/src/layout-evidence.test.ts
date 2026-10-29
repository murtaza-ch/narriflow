import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describe, expect, test } from "bun:test";
import { Prisma, PrismaClient } from "@prisma/client";
import { LayoutEvidenceClaimLost, LayoutEvidenceLifecycle, type ClipPendingAutoLayoutAnalysis } from "./layout-evidence";

function executionFixture() {
  let clock = 0;
  let expiresAt = 60_000;
  let token: string | null = "owned";
  let status = "processing";
  let tick: (() => void) | undefined;
  let cancelled = false;
  const claim: ClipPendingAutoLayoutAnalysis = {
    id: "clip", projectId: "project", startSec: 10, endSec: 30,
    transcriptSlice: [], deletedRanges: [], editorRevision: 7,
    previewStorageKey: "preview", previewStartSec: 6, previewDurationSec: 28,
    autoLayoutClaimToken: "owned", sourceStorageKey: "source", leaseMs: 60_000,
  };
  const prisma = { clip: { updateMany: async ({ where, data }: {
    where: { autoLayoutClaimToken: string; autoLayoutLeaseExpiresAt: { gt: Date } };
    data: { autoLayoutStatus?: string; autoLayoutClaimToken?: null; autoLayoutLeaseExpiresAt: Date | null };
  }) => {
    if (status !== "processing" || token !== where.autoLayoutClaimToken || expiresAt <= where.autoLayoutLeaseExpiresAt.gt.getTime()) return { count: 0 };
    expiresAt = data.autoLayoutLeaseExpiresAt?.getTime() ?? 0;
    if (data.autoLayoutStatus) status = data.autoLayoutStatus;
    if (data.autoLayoutClaimToken === null) token = null;
    return { count: 1 };
  } } } as unknown as PrismaClient;
  const lifecycle = new LayoutEvidenceLifecycle({
    prisma, now: () => new Date(clock),
    scheduler: {
      schedule(callback, intervalMs) { expect(intervalMs).toBe(20_000); tick = callback; return callback; },
      cancel() { cancelled = true; },
    },
  });
  return {
    lifecycle, claim,
    advance(ms: number) { clock += ms; },
    async heartbeat() { tick?.(); await new Promise((resolve) => setTimeout(resolve, 0)); },
    replaceOwner() { token = "replacement"; },
    canPublish() { return status === "processing" && token === "owned" && expiresAt > clock; },
    status: () => status,
    cancelled: () => cancelled,
  };
}

describe("Layout Evidence background execution", () => {
  test("renews throughout work longer than the original lease", async () => {
    const f = executionFixture();
    let finish!: () => void;
    const work = f.lifecycle.runAutomaticClaim(f.claim, async ({ signal }) => {
      await new Promise<void>((resolve) => { finish = resolve; });
      signal.throwIfAborted();
      return f.canPublish();
    });
    for (let step = 0; step < 5; step++) {
      f.advance(20_000);
      await f.heartbeat();
    }
    finish();
    expect(await work).toBe(true);
    expect(f.cancelled()).toBe(true);
  });

  test("renewal loss cancels active IO and cannot release a replacement owner", async () => {
    const f = executionFixture();
    let observed: AbortSignal | undefined;
    const work = f.lifecycle.runAutomaticClaim(f.claim, async ({ signal }) => {
      observed = signal;
      await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    // Attach rejection handling before the fake scheduler can deliver it.
    const rejection = work.catch((error: unknown) => error);
    f.replaceOwner();
    await f.heartbeat();
    expect(await rejection).toBeInstanceOf(LayoutEvidenceClaimLost);
    expect(observed?.aborted).toBe(true);
    expect(f.status()).toBe("processing");
    expect(f.cancelled()).toBe(true);
  });

  test("shutdown releases immediately when a handler ignores cancellation", async () => {
    const f = executionFixture();
    const shutdown = new AbortController();
    let finish!: () => void;
    const work = f.lifecycle.runAutomaticClaim(f.claim, async () => {
      await new Promise<void>((resolve) => { finish = resolve; });
    }, { signal: shutdown.signal });
    shutdown.abort(new Error("worker shutdown"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.status()).toBe("pending");
    expect(f.canPublish()).toBe(false);
    expect(f.cancelled()).toBe(true);
    finish();
    await work;
  });
});

test("targeted transient evidence reset is bounded and touches only failed infrastructure envelopes", async () => {
  const updates: unknown[] = [];
  const prisma = {
    clip: { updateMany: async (query: unknown) => { updates.push(query); return { count: 2 }; } },
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(prisma),
  } as unknown as PrismaClient;
  const lifecycle = new LayoutEvidenceLifecycle({ prisma });
  await expect(lifecycle.resetTransientFailures([])).rejects.toThrow();
  await expect(lifecycle.resetTransientFailures(Array.from({ length: 1001 }, (_, i) => `clip-${i}`))).rejects.toThrow();
  expect(updates).toEqual([]);
  expect(await lifecycle.resetTransientFailures(["clip-1", "clip-2"])).toEqual({ screen: 2, split: 2 });
  expect(updates).toEqual([
    { where: { id: { in: ["clip-1", "clip-2"] }, AND: [
      { layoutAnalysis: { path: ["state"], equals: "failed" } },
      { OR: ["analysis_unavailable", "detection_unavailable"].map((reason) => ({ layoutAnalysis: { path: ["reason"], equals: reason } })) },
    ] }, data: { layoutAnalysis: Prisma.DbNull } },
    { where: { id: { in: ["clip-1", "clip-2"] }, AND: [
      { splitLayoutAnalysis: { path: ["state"], equals: "failed" } },
      { OR: ["analysis_unavailable", "detection_unavailable"].map((reason) => ({ splitLayoutAnalysis: { path: ["reason"], equals: reason } })) },
    ] }, data: { splitLayoutAnalysis: Prisma.DbNull } },
  ]);
});


test.skipIf(process.env.ALLOW_LAYOUT_EVIDENCE_RESET_DB_TESTS !== "1")("resets old transient envelopes on disposable local Postgres and preserves valid content", async () => {
  const url = process.env.WORKFLOW_TEST_DATABASE_URL;
  if (!url || new URL(url).hostname !== "localhost" || new URL(url).port !== "55432") throw new Error("Use db-gate.sh for the local reset gate");
  const schema = `layout_reset_test_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: url, max: 2 });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool as unknown as ConstructorParameters<typeof PrismaPg>[0], { schema }) });
  const ids = Array.from({ length: 4 }, () => randomUUID());
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    await pool.query(`CREATE TABLE "${schema}"."Clip" (id uuid PRIMARY KEY, "layoutAnalysis" jsonb, "splitLayoutAnalysis" jsonb, "updatedAt" timestamp DEFAULT now())`);
    const envelopes = [
      { state: "failed", reason: "analysis_unavailable" },
      { state: "failed", reason: "detection_unavailable" },
      { state: "failed", reason: "no_trustworthy_faces" },
      { state: "available", reason: "analysis_unavailable", segments: [] },
    ];
    for (let i = 0; i < ids.length; i++) await pool.query(`INSERT INTO "${schema}"."Clip" (id, "layoutAnalysis", "splitLayoutAnalysis") VALUES ($1, $2::jsonb, $2::jsonb)`, [ids[i], JSON.stringify(envelopes[i])]);
    const lifecycle = new LayoutEvidenceLifecycle({ prisma });
    expect(await lifecycle.resetTransientFailures([ids[0]!])).toEqual({ screen: 1, split: 1 });
    expect(await lifecycle.resetTransientFailures(ids)).toEqual({ screen: 1, split: 1 });
    expect(await lifecycle.resetTransientFailures(ids)).toEqual({ screen: 0, split: 0 });
    const rows = await pool.query(`SELECT "layoutAnalysis", "splitLayoutAnalysis" FROM "${schema}"."Clip" ORDER BY array_position($1::uuid[], id)`, [ids]);
    expect(rows.rows.map((row) => row.layoutAnalysis)).toEqual([null, null, envelopes[2], envelopes[3]]);
    expect(rows.rows.map((row) => row.splitLayoutAnalysis)).toEqual([null, null, envelopes[2], envelopes[3]]);
  } finally {
    await prisma.$disconnect();
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
});

test("a late evidence read is bound to the frozen editor revision and preview and returns stored evidence verbatim", async () => {
  const queries: Array<{ where: Record<string, unknown>; select: Record<string, unknown> }> = [];
  const row = { autoLayoutAnalysis: { engine: "shot-layout-v1" }, layoutAnalysis: null, splitLayoutAnalysis: { engine: "explicit-split-v1" } };
  let stored: typeof row | null = row;
  const prisma = { clip: { findFirst: async (query: { where: Record<string, unknown>; select: Record<string, unknown> }) => { queries.push(query); return stored; } } } as unknown as PrismaClient;
  const lifecycle = new LayoutEvidenceLifecycle({ prisma, now: () => new Date(1_000) });

  expect(await lifecycle.readCompatibleDurable("clip-1", { editorRevision: 7, previewStorageKey: "preview-a" })).toEqual({
    automatic: row.autoLayoutAnalysis, screen: null, split: row.splitLayoutAnalysis,
  });
  expect(queries[0]!.where).toMatchObject({ id: "clip-1", editorRevision: 7, previewStorageKey: "preview-a", project: expect.anything() });
  // Evidence only; never the editor document or entitlements.
  expect(Object.keys(queries[0]!.select).sort()).toEqual(["autoLayoutAnalysis", "layoutAnalysis", "splitLayoutAnalysis"]);

  stored = null;
  expect(await lifecycle.readCompatibleDurable("clip-1", { editorRevision: 8, previewStorageKey: "preview-a" })).toBeNull();
});

test("background completion keeps the provenance that tells a render whose crops these are", async () => {
  const writes: Array<{ data: { autoLayoutAnalysis: { analysisPath?: string } } }> = [];
  const prisma = { clip: { updateMany: async (query: { data: { autoLayoutAnalysis: { analysisPath?: string } } }) => { writes.push(query); return { count: 1 }; } } } as unknown as PrismaClient;
  const lifecycle = new LayoutEvidenceLifecycle({ prisma, now: () => new Date(1_000) });
  const analysis = {
    version: 1, engine: "shot-layout-v1", sourceIdentity: "source", analysisPath: "proxy", analyzedAtISO: "2026-10-29T00:00:00.000Z",
    clipStartSec: 0, clipEndSec: 10, deletedRanges: [], editedDurationSec: 10, sourceWidth: 1920, sourceHeight: 1080,
    segments: [], noSplitSegments: [], shotCount: 0, soloShotCount: 0, multiShotCount: 0, twoUpSegmentCount: 0, speakerCount: 0, mappedSpeakerCount: 0,
  } as const;
  expect(await lifecycle.completeAutomatic("clip-1", analysis, { editorRevision: 1, previewStorageKey: "preview", claimToken: "owned" })).toBe(true);
  expect(writes[0]!.data.autoLayoutAnalysis.analysisPath).toBe("proxy");
});

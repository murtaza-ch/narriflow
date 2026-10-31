import { createDatabaseScope, getPrismaClient, withDatabaseScope } from "@narriflow/db/client";

function sqlState(error: unknown, depth = 0): string | null {
  if (!error || typeof error !== "object" || depth > 6) return null;
  const value = error as Record<string, unknown>;
  for (const key of ["cause", "meta", "driverAdapterError"]) { const code = sqlState(value[key], depth + 1); if (code) return code; }
  for (const key of ["code", "originalCode", "sqlState"]) if (typeof value[key] === "string" && /^[0-9A-Z]{5}$/.test(value[key])) return value[key] as string;
  return null;
}

/** Fixed SQL against the isolated platform branch. This is never mounted in
 * the application and accepts no SQL, table names or connection URLs over HTTP. */
export async function runHyperdriveTransactionGate(connectionString: string) {
  return withDatabaseScope(createDatabaseScope({ connectionString, pool: { max: 1 } }), async () => {
    const first = getPrismaClient()!;
    return withDatabaseScope(createDatabaseScope({ connectionString, pool: { max: 1 } }), async () => {
      const second = getPrismaClient()!;
      const id = crypto.randomUUID(), key = `narriflow-platform-lock:${id}`;
      const checks: string[] = [];
      await first.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS "_narriflow_platform_lock_gate" (id UUID PRIMARY KEY, value INTEGER NOT NULL)');
      await first.$executeRaw`INSERT INTO "_narriflow_platform_lock_gate" (id,value) VALUES (${id}::uuid,0)`;
      let release!: () => void, markHeld!: () => void;
      const released = new Promise<void>(resolve => { release = resolve; });
      const held = new Promise<void>(resolve => { markHeld = resolve; });
      const holder = first.$transaction(async tx => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key},0)) IS NULL AS locked`;
        await tx.$queryRaw`SELECT id FROM "_narriflow_platform_lock_gate" WHERE id=${id}::uuid FOR UPDATE`;
        markHeld();
        await released;
        await tx.$executeRaw`UPDATE "_narriflow_platform_lock_gate" SET value=1 WHERE id=${id}::uuid`;
      }, { timeout: 15_000, maxWait: 10_000 });
      try {
        await Promise.race([held, holder.then(() => { throw new Error("platform_holder_ended_before_lock"); })]);
        try {
          await second.$transaction(async tx => {
            const [lock] = await tx.$queryRaw<Array<{ acquired: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtextextended(${key},0)) AS acquired`;
            if (lock?.acquired !== false) throw new Error("platform_advisory_lock_not_exclusive");
            const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "_narriflow_platform_lock_gate" WHERE id=${id}::uuid FOR UPDATE SKIP LOCKED`;
            if (rows.length !== 0) throw new Error("platform_row_lock_not_exclusive");
          }, { timeout: 10_000, maxWait: 10_000 });
          checks.push("interactive_transactions", "advisory_transaction_lock_exclusion", "row_lock_skip_locked_exclusion");
        } finally { release(); await holder; }
        await second.$transaction(async tx => {
          const [lock] = await tx.$queryRaw<Array<{ acquired: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtextextended(${key},0)) AS acquired`;
          const rows = await tx.$queryRaw<Array<{ value: number }>>`SELECT value FROM "_narriflow_platform_lock_gate" WHERE id=${id}::uuid FOR UPDATE SKIP LOCKED`;
          if (lock?.acquired !== true || rows.length !== 1 || rows[0]?.value !== 1) throw new Error("platform_commit_or_lock_release_failed");
          await tx.$executeRaw`UPDATE "_narriflow_platform_lock_gate" SET value=2 WHERE id=${id}::uuid`;
        }, { timeout: 10_000, maxWait: 10_000 });
        checks.push("commit_visibility_and_lock_release");
        try {
          await first.$transaction(async tx => { await tx.$executeRaw`UPDATE "_narriflow_platform_lock_gate" SET value=99 WHERE id=${id}::uuid`; throw new Error("platform_expected_rollback"); });
        } catch (error) { if (!(error instanceof Error) || error.message !== "platform_expected_rollback") throw error; }
        const [row] = await second.$queryRaw<Array<{ value: number }>>`SELECT value FROM "_narriflow_platform_lock_gate" WHERE id=${id}::uuid`;
        if (row?.value !== 2) throw new Error("platform_rollback_failed");
        checks.push("transaction_rollback");
        let cancelled = false;
        try {
          await first.$transaction(async tx => { await tx.$executeRawUnsafe("SET LOCAL statement_timeout='100ms'"); await tx.$queryRaw`SELECT pg_sleep(2)::text`; });
        } catch (error) { cancelled = sqlState(error) === "57014"; }
        if (!cancelled) throw new Error("platform_statement_cancellation_unconfirmed");
        const [healthy] = await first.$queryRaw<Array<{ answer: number }>>`SELECT 42::integer AS answer`;
        if (healthy?.answer !== 42) throw new Error("platform_pool_unhealthy_after_cancellation");
        checks.push("server_statement_timeout_sqlstate_57014", "fresh_query_after_cancelled_transaction");
        return { checks, passed: checks.length, database: "isolated-platform-gates", completedAt: new Date().toISOString() };
      } finally {
        release();
        await holder.catch(() => {});
        await first.$executeRaw`DELETE FROM "_narriflow_platform_lock_gate" WHERE id=${id}::uuid`;
      }
    });
  });
}

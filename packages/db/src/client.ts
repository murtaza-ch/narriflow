import { PrismaNeon } from "@prisma/adapter-neon";
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  narriflowAdapter?: PrismaNeon;
  narriflowPrismaClient?: PrismaClient;
};

/**
 * Driver defaults for a process with no pool settings in its environment.
 * `@neondatabase/serverless` ships with no connection timeout and no query
 * timeout, so a websocket that dies without a clean close (Neon dropping a
 * pooled connection, a NAT idling it out) leaves every pending
 * `pool.connect()` or query awaiting forever — and with it every worker poll
 * loop that is waiting on one. Bounding both makes a dead connection reject,
 * so the caller's normal failure path runs.
 *
 * `query_timeout` is a client-side read timeout on a single statement; it is
 * deliberately not Prisma's interactive-transaction timeout (see
 * `transactionOptions` below), and it is not a server `statement_timeout`,
 * which the Neon pooler does not accept as a startup parameter.
 */
export const DATABASE_POOL_DEFAULTS = {
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  query_timeout: 60_000,
} as const;

export interface DatabasePoolOptions {
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  query_timeout?: number;
}

/**
 * Optional pool settings from the environment. Only settings that are present
 * (and positive integers) are returned; `databasePoolConfig` layers them over
 * `DATABASE_POOL_DEFAULTS`.
 */
export function databasePoolOptions(
  env: Record<string, string | undefined> = process.env,
): DatabasePoolOptions {
  const read = (name: string) => {
    const value = Number(env[name]);
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  };
  const max = read("DATABASE_POOL_MAX");
  const idleTimeoutMillis = read("DATABASE_POOL_IDLE_TIMEOUT_MS");
  const connectionTimeoutMillis = read("DATABASE_POOL_CONNECTION_TIMEOUT_MS");
  const queryTimeout = read("DATABASE_POOL_QUERY_TIMEOUT_MS");
  return {
    ...(max ? { max } : {}),
    ...(idleTimeoutMillis ? { idleTimeoutMillis } : {}),
    ...(connectionTimeoutMillis ? { connectionTimeoutMillis } : {}),
    ...(queryTimeout ? { query_timeout: queryTimeout } : {}),
  };
}

/** Defaults plus environment overrides: the pool config every process uses. */
export function databasePoolConfig(
  env: Record<string, string | undefined> = process.env,
): DatabasePoolOptions {
  return { ...DATABASE_POOL_DEFAULTS, ...databasePoolOptions(env) };
}

export function getPrismaClient() {
  if (!process.env.DATABASE_URL) {
    return null;
  }

  if (!globalForPrisma.narriflowAdapter) {
    globalForPrisma.narriflowAdapter = new PrismaNeon({
      connectionString: process.env.DATABASE_URL,
      ...databasePoolConfig(),
    });
  }

  if (!globalForPrisma.narriflowPrismaClient) {
    globalForPrisma.narriflowPrismaClient = new PrismaClient({
      adapter: globalForPrisma.narriflowAdapter,
      log: ["error"],
      // Prisma's default interactive-transaction timeout is 5s of wall
      // clock, which is statement time — not held-lock time — and our
      // transactions ship large JSON columns (transcriptSlice/studioEdits)
      // across whatever latency separates the process from Neon. Two live
      // incidents on 2026-08-06 from a high-RTT connection: the editor
      // autosave PUT expired at 10.3s, and the worker's post-render
      // completion bookkeeping expired at 7.5s (which cascaded into a
      // requeued run that then failed permanently on no_renderable_clips).
      // Every mutating transaction in this codebase is either
      // revision-guarded or a conditional update, so a longer window can
      // only fail cleanly — never produce a torn write.
      transactionOptions: {
        timeout: 30_000,
        maxWait: 10_000,
      },
    });
  }

  return globalForPrisma.narriflowPrismaClient;
}

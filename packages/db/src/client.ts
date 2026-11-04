import { AsyncLocalStorage } from "node:async_hooks";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

/** Hyperdrive owns the origin pool. This pool belongs to just one invocation. */
export const DATABASE_POOL_DEFAULTS = {
  max: 2,
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

/** CLI callers may pass their environment explicitly. Workers pass bindings. */
export function databasePoolOptions(env: Record<string, string | undefined>): DatabasePoolOptions {
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

export function databasePoolConfig(env: Record<string, string | undefined> = {}): DatabasePoolOptions {
  return { ...DATABASE_POOL_DEFAULTS, ...databasePoolOptions(env) };
}

export interface DatabaseClientResource {
  readonly client: PrismaClient;
  dispose(): Promise<void>;
}

export type DatabaseScopeOptions =
  | { connectionString: string; pool?: DatabasePoolOptions }
  | { createClient(): DatabaseClientResource };

const currentDatabaseScope = new AsyncLocalStorage<DatabaseScope>();

function createClientResource(options: DatabaseScopeOptions): DatabaseClientResource {
  if ("createClient" in options) return options.createClient();
  const adapter = new PrismaPg({
    connectionString: options.connectionString,
    ...DATABASE_POOL_DEFAULTS,
    ...options.pool,
  });
  const client = new PrismaClient({
    adapter,
    log: ["error"],
    transactionOptions: { timeout: 30_000, maxWait: 10_000 },
  });
  return { client, dispose: () => client.$disconnect() };
}

/** One request, Workflow step or CLI command. A scope cannot be reopened. */
export class DatabaseScope {
  private resource: DatabaseClientResource | undefined;
  private started = false;
  private closed = false;

  constructor(private readonly options: DatabaseScopeOptions) {}

  client(): PrismaClient {
    if (this.closed) throw new Error("Database scope is closed");
    this.resource ??= createClientResource(this.options);
    return this.resource.client;
  }

  async run<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.started) throw new Error("Database scope can only run once");
    this.started = true;
    return currentDatabaseScope.run(this, async () => {
      try {
        return await operation();
      } finally {
        this.closed = true;
        const resource = this.resource;
        this.resource = undefined;
        // Cleanup must not replace the operation's result or its original error.
        try {
          await resource?.dispose();
        } catch (error) {
          console.warn(JSON.stringify({ level: "warn", message: "database_scope_dispose_failed", errorName: error instanceof Error ? error.name : typeof error }));
        }
      }
    });
  }
}

/** Construction is lazy, so liveness and DO-only requests never create a pool. */
export function createDatabaseScope(options: DatabaseScopeOptions): DatabaseScope {
  if ("connectionString" in options && !options.connectionString.trim()) {
    throw new Error("A database connection string is required");
  }
  return new DatabaseScope(options);
}

export function withDatabaseScope<T>(scope: DatabaseScope, operation: () => T | Promise<T>): Promise<T> {
  return scope.run(operation);
}

/** Reads only the injected invocation scope. There is no process-env fallback. */
export function getPrismaClient(): PrismaClient | null {
  return currentDatabaseScope.getStore()?.client() ?? null;
}

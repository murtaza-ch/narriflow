import { createRouteApp } from "../../http/admission";
import { platformAdmission } from "./admission";

export interface HealthDependencies {
  /** Short revision label; never a secret. */
  version: string;
  /** Resolves when the database answers and all image migrations are applied. Rejection or timeout is "not ready". */
  checkDatabase(): Promise<void>;
  isDraining(): boolean;
  /** Upper bound for the database probe. */
  databaseTimeoutMs?: number;
  cacheMs?: number;
  now?: () => number;
}

const DEFAULT_DATABASE_TIMEOUT_MS = 2_000;

async function databaseReady(dependencies: HealthDependencies): Promise<boolean> {
  const timeout = dependencies.databaseTimeoutMs ?? DEFAULT_DATABASE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      dependencies.checkDatabase(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("database_timeout")), timeout);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Liveness and readiness, mounted at `/api`. Neither needs credentials, Clerk,
 * Redis or an AI/provider key: readiness is the migrated database plus the validated
 * startup configuration, and it fails while the process drains.
 */
export function createHealthRoutes(dependencies: HealthDependencies) {
  const now = dependencies.now ?? (() => performance.now());
  let cached: { ready: boolean; expiresAt: number } | undefined;
  let inFlight: Promise<boolean> | undefined;
  const probe = () => {
    if (cached && now() < cached.expiresAt) return Promise.resolve(cached.ready);
    inFlight ??= databaseReady(dependencies).then((ready) => {
      cached = { ready, expiresAt: now() + (dependencies.cacheMs ?? 5_000) };
      inFlight = undefined;
      return ready;
    });
    return inFlight;
  };
  return createRouteApp(platformAdmission)
    .get("/health", (c) =>
      c.json({ ok: true, service: "narriflow-api", version: dependencies.version }),
    )
    .get("/ready", async (c) => {
      if (dependencies.isDraining()) {
        return c.json({ ok: false, status: "draining" as const }, 503);
      }
      const database = await probe();
      return c.json(
        {
          ok: database,
          status: database ? ("ready" as const) : ("unavailable" as const),
          checks: { configuration: "ok" as const, database: database ? ("ok" as const) : ("failed" as const) },
        },
        database ? 200 : 503,
      );
    });
}

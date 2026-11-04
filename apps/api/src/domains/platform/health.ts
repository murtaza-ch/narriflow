import { createRouteApp } from "../../http/admission";
import { platformAdmission } from "./admission";

export interface HealthDependencies {
  /** Short revision label; never a secret. */
  version: string;
  /** Resolves when the database answers and all image migrations are applied. Rejection or timeout is "not ready". */
  checkDatabase(): Promise<void>;
  isDraining(): boolean;
  admissionState?(): "open" | "closed" | "fenced";
  /** Upper bound for the database probe. */
  databaseTimeoutMs?: number;
  cacheMs?: number;
  /** Where the last answer lives. The Worker rebuilds the app per request, so production passes one per isolate. */
  readiness?: ReadinessCache;
  now?: () => number;
}

export function healthResponse(version: string, requestId: string = crypto.randomUUID(), admissionState: "open" | "closed" | "fenced" = "open"): Response {
  return Response.json({ ok: true, service: "narriflow-api", version, admissionState }, { headers: { "X-Request-ID": requestId, "Cache-Control": "no-store" } });
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
 * Liveness and readiness, mounted at `/api`. Neither needs credentials, Clerk
 * or an AI/provider key: readiness is the migrated database plus the validated
 * startup configuration, and it fails while the process drains.
 */
/** The last readiness answer: plain data, so it can outlive the request that measured it. */
export interface ReadinessCache {
  value?: { ready: boolean; expiresAt: number };
}

export function createHealthRoutes(dependencies: HealthDependencies) {
  const cache = dependencies.readiness ?? {};
  const now = dependencies.now ?? (() => performance.now());
  // A probe promise belongs to the request that started it, so only the answer is shared.
  let inFlight: Promise<boolean> | undefined;
  const probe = () => {
    if (cache.value && now() < cache.value.expiresAt) return Promise.resolve(cache.value.ready);
    inFlight ??= databaseReady(dependencies).then((ready) => {
      cache.value = { ready, expiresAt: now() + (dependencies.cacheMs ?? 5_000) };
      inFlight = undefined;
      return ready;
    });
    return inFlight;
  };
  return createRouteApp(platformAdmission)
    .get("/health", (c) => healthResponse(dependencies.version, c.get("requestId"), dependencies.admissionState?.()))
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

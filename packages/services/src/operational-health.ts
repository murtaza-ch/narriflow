import { Prisma, type PrismaClient } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import { logFailure } from "./log-failure";
import { accessibleProjectSql } from "./project-access";
import { readServiceEnvironment } from "./runtime-environment";

/** Longer than the hourly cron, because that cron's reconcile is what redelivers a failed dispatch. */
const STUCK_DISPATCH_SECONDS = 75 * 60;
/** The fair queue lets lower tiers wait on a busy day, and the deadline starts at admission. */
const STUCK_RENDER_SECONDS = 60 * 60;
const MIN_RENDER_FAILURES = 3;
const RENDER_FAILURE_RATE = 0.2;
const MIN_EXPIRED_ATTEMPTS = 3;
const HEARTBEAT_TIMEOUT_MS = 10_000;

export interface OperationalSnapshot {
  deadLettered: number;
  oldestUndeliveredSeconds: number;
  oldestRenderWaitSeconds: number;
  expiredAttempts: number;
  failedRenders: number;
  finishedRenders: number;
}
export interface OperationalAlert { key: string; severity: "critical" | "warning"; summary: string; }

/** Thresholds live here so the runbook has one list to quote. */
export function evaluateOperationalHealth(snapshot: OperationalSnapshot): OperationalAlert[] {
  const alerts: OperationalAlert[] = [];
  if (snapshot.deadLettered > 0) alerts.push({ key: "dispatch_dead_lettered", severity: "critical", summary: `${snapshot.deadLettered} dispatches dead-lettered in the last 2 hours` });
  if (snapshot.oldestUndeliveredSeconds > STUCK_DISPATCH_SECONDS) alerts.push({ key: "dispatch_undelivered", severity: "critical", summary: `A dispatch has waited ${Math.round(snapshot.oldestUndeliveredSeconds / 60)} minutes for delivery` });
  if (snapshot.oldestRenderWaitSeconds > STUCK_RENDER_SECONDS) alerts.push({ key: "render_queue_stuck", severity: "critical", summary: `A render has waited ${Math.round(snapshot.oldestRenderWaitSeconds / 60)} minutes for a slot` });
  if (snapshot.failedRenders >= MIN_RENDER_FAILURES && snapshot.failedRenders / Math.max(1, snapshot.finishedRenders) >= RENDER_FAILURE_RATE) {
    alerts.push({ key: "render_failures", severity: "warning", summary: `${snapshot.failedRenders} of ${snapshot.finishedRenders} renders failed in the last hour` });
  }
  if (snapshot.expiredAttempts >= MIN_EXPIRED_ATTEMPTS) alerts.push({ key: "attempts_expired", severity: "warning", summary: `${snapshot.expiredAttempts} execution attempts expired in the last hour` });
  return alerts;
}

/** Runs inside the hourly cron, so it never wakes a suspended database by itself.
 * Work from a superseded epoch never leaves these tables as acknowledged, so both
 * stuck-work reads stay on the current epoch or one cutover would alarm forever. */
export async function readOperationalSnapshot(database: Pick<PrismaClient, "$queryRaw">): Promise<OperationalSnapshot> {
  const [row] = await database.$queryRaw<OperationalSnapshot[]>`
    WITH clock AS (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now)
    SELECT
      (SELECT COUNT(*)::int FROM "ExecutionDispatch", clock WHERE "deadLetteredAt" > clock.now - interval '2 hours') AS "deadLettered",
      COALESCE((SELECT EXTRACT(EPOCH FROM clock.now - MIN("nextDeliveryAt"))::int FROM "ExecutionDispatch", clock
        WHERE "deploymentEpoch" = (SELECT epoch FROM "ExecutionEpoch" WHERE id = 1)
          AND "acknowledgedAt" IS NULL AND "deadLetteredAt" IS NULL AND "nextDeliveryAt" < clock.now GROUP BY clock.now), 0) AS "oldestUndeliveredSeconds",
      COALESCE((SELECT EXTRACT(EPOCH FROM clock.now - MIN(render_group."capacityWaitSince"))::int
        FROM "RenderGroup" render_group
        JOIN "WorkflowRun" run ON run.id = render_group."workflowRunId"
        JOIN "Project" project ON project.id = run."projectId"
        JOIN "Workspace" workspace ON workspace.id = project."workspaceId"
        CROSS JOIN clock
        WHERE render_group."deploymentEpoch" = (SELECT epoch FROM "ExecutionEpoch" WHERE id = 1) AND render_group.status = 'queued'
          AND render_group."capacityWaitSince" IS NOT NULL AND workspace.status = 'active'
          AND ${accessibleProjectSql("project", Prisma.sql`clock.now`)} GROUP BY clock.now), 0) AS "oldestRenderWaitSeconds",
      (SELECT COUNT(*)::int FROM "ExecutionAttempt", clock WHERE status = 'expired' AND "finishedAt" > clock.now - interval '1 hour') AS "expiredAttempts",
      (SELECT COUNT(*)::int FROM "ClipRender", clock WHERE status = 'failed' AND "completedAt" > clock.now - interval '1 hour') AS "failedRenders",
      (SELECT COUNT(*)::int FROM "ClipRender", clock WHERE status IN ('completed', 'failed') AND "completedAt" > clock.now - interval '1 hour') AS "finishedRenders"`;
  if (!row) throw new Error("Operational snapshot unavailable");
  return row;
}

/** A healthy ping proves the Worker, its cron and the database all ran. A failure
 * ping opens an incident now; no ping at all opens one when the grace period ends. */
export async function pingHeartbeat(url: string | undefined, failure: string | null, request: typeof fetch = fetch): Promise<void> {
  if (!url) return;
  try {
    await request(failure === null ? url : `${url}/fail`, { method: failure === null ? "GET" : "POST", body: failure ?? undefined, signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS) });
  } catch (error) { logFailure("heartbeat_ping_failed", error); }
}

export async function runOperationalHealthCheck(dependencies: { database?: Pick<PrismaClient, "$queryRaw">; request?: typeof fetch } = {}): Promise<void> {
  const url = readServiceEnvironment().HEARTBEAT_URL;
  try {
    const database = dependencies.database ?? getPrismaClient();
    if (!database) throw new Error("Health check requires a database scope");
    const alerts = evaluateOperationalHealth(await readOperationalSnapshot(database));
    for (const alert of alerts) logFailure(`operational_${alert.severity}`, Object.assign(new Error(alert.summary), { code: alert.key }));
    const critical = alerts.filter(alert => alert.severity === "critical").map(alert => alert.summary);
    await pingHeartbeat(url, critical.length ? critical.join("\n") : null, dependencies.request);
  } catch (error) {
    logFailure("operational_health_check_failed", error);
    await pingHeartbeat(url, "The operational health check could not run", dependencies.request);
  }
}

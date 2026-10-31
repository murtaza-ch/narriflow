import type { PrismaClient } from "@prisma/client";
import type { LocalFetchDeviceClaims } from "@narriflow/validators/api/local-fetch";
import type { ExecutionDispatchReference } from "@narriflow/validators/execution";
import type { ActorScope } from "./actor-scope";
import { ExecutorControlError } from "./executor-control";

type DeviceExecutionDatabase = Pick<PrismaClient, "ingestJob" | "$queryRaw">;
export interface LocalFetchDeviceExecutionPorts {
  /** Resolve inside the verified command; constructing the service opens no SQL. */
  database(): DeviceExecutionDatabase;
  requireActor(scope: ActorScope): Promise<unknown>;
  delivery: {
    read(id: string): Promise<{ reference: ExecutionDispatchReference; acknowledgedAt: Date | null } | null>;
    replay(reference: ExecutionDispatchReference): Promise<unknown>;
    deliver(id: string): Promise<unknown>;
  };
}

/** The device's credential is only one Workspace's delivery authority. Generic
 * Executor Control still owns current epoch, owner, token and lease fencing. */
export function createLocalFetchDeviceExecution(ports: LocalFetchDeviceExecutionPorts) {
  async function authorizeReference(claims: LocalFetchDeviceClaims, reference: ExecutionDispatchReference): Promise<void> {
    if (reference.kind !== "local_fetch" || reference.subject.kind !== "ingest_job" || reference.deploymentEpoch !== claims.deploymentEpoch) throw new ExecutorControlError("invalid_reference");
    const job = await ports.database().ingestJob.findUnique({ where: { id: reference.subject.id }, include: { project: { select: { workspaceId: true } } } });
    if (!job || job.project.workspaceId !== claims.workspaceId || job.generation !== reference.generation || job.jobType !== "link_import" ||
      !job.payload || Array.isArray(job.payload) || typeof job.payload !== "object" || job.payload.provider !== "youtube") throw new ExecutorControlError("invalid_reference");
    await ports.requireActor({ actorUserId: claims.actorUserId, workspaceId: claims.workspaceId });
  }

  /** One explicit reconnect page, never a timer or background queue scan.
   * Finish selection before remote delivery; no transaction spans mailbox IO. */
  async function reconcile(claims: LocalFetchDeviceClaims, after?: string): Promise<{ nextCursor: string | null }> {
    await ports.requireActor({ actorUserId: claims.actorUserId, workspaceId: claims.workspaceId });
    const rows = await ports.database().$queryRaw<Array<{ id: string }>>`SELECT dispatch.id FROM "ExecutionDispatch" dispatch
      JOIN "IngestJob" job ON dispatch."subjectId"=job.id::text AND dispatch.generation=job.generation
      JOIN "Project" project ON project.id=job."projectId"
      WHERE dispatch.kind='local_fetch' AND dispatch."subjectKind"='ingest_job' AND project."workspaceId"=${claims.workspaceId}::uuid
      AND job.status IN ('queued','running') AND dispatch."deploymentEpoch"=${claims.deploymentEpoch} AND job."deploymentEpoch"=dispatch."deploymentEpoch"
      AND (${after ?? null}::uuid IS NULL OR dispatch.id>${after ?? null}::uuid) ORDER BY dispatch.id LIMIT 25`;
    for (const row of rows) {
      const record = await ports.delivery.read(row.id);
      if (!record) continue;
      if (record.acknowledgedAt) await ports.delivery.replay(record.reference);
      else await ports.delivery.deliver(row.id);
    }
    return { nextCursor: rows.length === 25 ? rows.at(-1)!.id : null };
  }
  return { authorizeReference, reconcile };
}

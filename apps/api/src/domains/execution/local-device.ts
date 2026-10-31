import { getPrismaClient } from "@narriflow/db/client";
import type { ActorScope } from "@narriflow/services/actor-scope";
import { createLocalFetchDeviceCodec, LocalFetchDeviceError, requireLocalFetchDevelopment, type LocalFetchDeviceClaims } from "@narriflow/services/local-fetch-device";
import { readServiceEnvironment } from "@narriflow/services/runtime-environment";
import { workspaceService } from "@narriflow/services/workspace.service";
import { ExecutorControlError } from "@narriflow/services/executor-control";
import { ExecutionSignatureError, verifyExecutionRequest } from "@narriflow/services/execution-signature";
import { getExecutionDispatch } from "@narriflow/services/execution-dispatch-runtime";
import { createRouteApp } from "../../http/admission";
import { jsonError, requestIdOf } from "../../http/errors";
import { executionKeyRing } from "../../execution-keys";
import type { ApiWorkerBindings } from "../../worker-bindings";
import type { ExecutionDispatchReference } from "@narriflow/validators/execution";
import type { AdmissionTable } from "../platform/admission-table";
import { CommandTooLarge, readCommandBody, executionCommandHandler, type ExecutionRouteDependencies } from "./routes";
import { createWorkerExecutor } from "./runtime";
import { readExecutionDispatch } from "@narriflow/services/execution-dispatch";
import { deliverLocalFetchReference } from "../../workflows/scheduler";
import { localDeviceMailbox } from "../../resource-ports";

export const localDeviceAdmission = {
  "POST /dev-device/connect-ticket": { trust: "dev_device_signature" },
  "POST /dev-device/reconcile": { trust: "dev_device_signature" },
  "POST /dev-device/execution/command": { trust: "dev_device_signature" },
  "POST /dev-device/execution/transfer": { trust: "dev_device_signature" },
  "GET /dev-device/:workspaceId/socket": { trust: "dev_device_signature" },
} as const satisfies AdmissionTable;

function codec() { return createLocalFetchDeviceCodec(executionKeyRing(readServiceEnvironment().DEV_DEVICE_KEYS_JSON)); }
/** First-party authenticated issuance. The returned key is scoped to this
 * development Workspace, actor, epoch and two-hour session. */
export async function issueLocalFetchDevice(actor: ActorScope, bindings: ApiWorkerBindings) {
  const environment = readServiceEnvironment();
  requireLocalFetchDevelopment(environment, actor.workspaceId);
  await workspaceService.requireActor(actor.actorUserId, actor.workspaceId, "processing.consume");
  const database = getPrismaClient();
  if (!database || !environment.DEV_DEVICE_KEY_ID || !environment.API_ORIGIN || !(bindings.LOCAL_FETCH_MAILBOX || bindings.DEV_CLOUD) || !/^[a-f0-9]{64}$/.test(environment.MEDIA_LOCAL_FETCH_TOOLCHAIN_FINGERPRINT ?? "")) throw new LocalFetchDeviceError("local_fetch_unavailable");
  const epoch = await database.executionEpoch.findUniqueOrThrow({ where: { id: 1 } });
  const issued = await codec().issue({ ...actor, deploymentEpoch: epoch.epoch, apiOrigin: environment.API_ORIGIN }, environment.DEV_DEVICE_KEY_ID);
  await localDeviceMailbox(bindings, actor.workspaceId).register(issued.claims);
  return { version: 1 as const, apiOrigin: environment.API_ORIGIN, sessionToken: issued.token, keyId: issued.claims.sessionId,
    key: Buffer.from(issued.key).toString("base64url"), workspaceId: actor.workspaceId, expiresAt: issued.claims.expiresAt, toolchainFingerprint: environment.MEDIA_LOCAL_FETCH_TOOLCHAIN_FINGERPRINT! };
}

async function authenticate(request: Request | undefined, bindings: ApiWorkerBindings | undefined) {
  try {
    if (!request || !(bindings?.LOCAL_FETCH_MAILBOX || bindings?.DEV_CLOUD)) throw new Error();
    const token = request.headers.get("X-Local-Fetch-Session") ?? "";
    const verified = await codec().verify(token);
    requireLocalFetchDevelopment(readServiceEnvironment(), verified.claims.workspaceId);
    if (verified.claims.apiOrigin !== readServiceEnvironment().API_ORIGIN) throw new Error();
    const current = await localDeviceMailbox(bindings, verified.claims.workspaceId).authorize(verified.claims.sessionId);
    if (JSON.stringify(current) !== JSON.stringify(verified.claims)) throw new Error();
    return verified;
  } catch { throw new ExecutionSignatureError("invalid_metadata"); }
}

async function authorizeReference(claims: LocalFetchDeviceClaims, reference: ExecutionDispatchReference) {
  if (reference.kind !== "local_fetch" || reference.subject.kind !== "ingest_job" || reference.deploymentEpoch !== claims.deploymentEpoch) throw new ExecutorControlError("invalid_reference");
  const database = getPrismaClient();
  if (!database) throw new ExecutorControlError("epoch_unavailable");
  const job = await database.ingestJob.findUnique({ where: { id: reference.subject.id }, include: { project: { select: { workspaceId: true } } } });
  if (!job || job.project.workspaceId !== claims.workspaceId || job.generation !== reference.generation || job.jobType !== "link_import" ||
    !job.payload || Array.isArray(job.payload) || typeof job.payload !== "object" || job.payload.provider !== "youtube") throw new ExecutorControlError("invalid_reference");
  await workspaceService.requireActor(claims.actorUserId, claims.workspaceId, "processing.consume");
}

export function createLocalDeviceExecutionDependencies(): ExecutionRouteDependencies {
  const authenticated = new WeakMap<Request, LocalFetchDeviceClaims>();
  async function reference(request: Request | undefined, value: ExecutionDispatchReference) {
    const claims = request && authenticated.get(request);
    if (!claims) throw new ExecutorControlError("invalid_reference");
    await authorizeReference(claims, value);
  }
  return {
    audience: "dev-device", nowSeconds: () => Math.floor(Date.now() / 1000),
    async keyRing(request, bindings) {
      const verified = await authenticate(request, bindings);
      authenticated.set(request!, verified.claims);
      return new Map([[verified.claims.sessionId, verified.key]]);
    },
    async execute(command, verified, bindings, request) {
      const value = command.action === "acquire" ? command.reference : command.fence.reference;
      await reference(request, value);
      return createWorkerExecutor(value, bindings).control.execute({ command, verifiedRequest: verified });
    },
    async transfer(command, verified, bindings, request) {
      await reference(request, command.fence.reference);
      return createWorkerExecutor(command.fence.reference, bindings).transfer.execute({ command, verifiedRequest: verified });
    },
  };
}

/** No PostgreSQL work is reachable before the scoped device signature passes. */
export function createLocalDeviceRoutes() {
  const execution = createLocalDeviceExecutionDependencies();
  const signed = (action: "connect-ticket" | "reconcile") => async (c: import("hono").Context) => {
    try {
      const auth = await authenticate(c.req.raw, c.env as ApiWorkerBindings);
      // Device requests here contain only an optional UUID cursor, never media.
      const body = await readCommandBody(c.req.raw, 256);
      const signature = JSON.parse(c.req.header("X-Execution-Signature") ?? "null");
      await verifyExecutionRequest({ signature, keyRing: new Map([[auth.claims.sessionId, auth.key]]), audience: "dev-device", method: "POST",
        target: new URL(c.req.url).pathname + new URL(c.req.url).search, body, nowSeconds: Math.floor(Date.now() / 1000) });
      c.header("Cache-Control", "no-store");
      if (action === "connect-ticket") return c.json(await localDeviceMailbox(c.env as ApiWorkerBindings, auth.claims.workspaceId).connectTicket(auth.claims.sessionId));
      const input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as { after?: unknown };
      if (!input || typeof input !== "object" || Object.keys(input).some(key => key !== "after") || input.after !== undefined && (typeof input.after !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input.after))) return c.body(null, 400);
      await workspaceService.requireActor(auth.claims.actorUserId, auth.claims.workspaceId, "processing.consume");
      const database = getPrismaClient();
      if (!database) throw new ExecutorControlError("epoch_unavailable");
      const after = input.after as string | undefined;
      const rows = await database.$queryRaw<Array<{ id: string }>>`SELECT dispatch.id FROM "ExecutionDispatch" dispatch
        JOIN "IngestJob" job ON dispatch."subjectId"=job.id::text AND dispatch.generation=job.generation
        JOIN "Project" project ON project.id=job."projectId"
        WHERE dispatch.kind='local_fetch' AND dispatch."subjectKind"='ingest_job' AND project."workspaceId"=${auth.claims.workspaceId}::uuid
        AND job.status IN ('queued','running') AND dispatch."deploymentEpoch"=${auth.claims.deploymentEpoch} AND job."deploymentEpoch"=dispatch."deploymentEpoch"
        AND (${after ?? null}::uuid IS NULL OR dispatch.id>${after ?? null}::uuid) ORDER BY dispatch.id LIMIT 25`;
      for (const row of rows) {
        const record = await readExecutionDispatch(database, row.id);
        if (!record) continue;
        if (record.acknowledgedAt) await deliverLocalFetchReference(record.reference, c.env as ApiWorkerBindings);
        else await getExecutionDispatch().deliver(row.id);
      }
      return c.json({ nextCursor: rows.length === 25 ? rows.at(-1)!.id : null });
    } catch (error) {
      if (error instanceof ExecutionSignatureError) return jsonError(401, "local_fetch_session_invalid", "Device authentication failed", requestIdOf(c));
      if (error instanceof CommandTooLarge) return c.body(null, 413);
      if (error instanceof SyntaxError) return c.body(null, 400);
      throw error;
    }
  };
  return createRouteApp(localDeviceAdmission)
    .post("/dev-device/connect-ticket", signed("connect-ticket"))
    .post("/dev-device/reconcile", signed("reconcile"))
    .post("/dev-device/execution/command", executionCommandHandler(execution, "command"))
    .post("/dev-device/execution/transfer", executionCommandHandler(execution, "transfer"))
    .get("/dev-device/:workspaceId/socket", c => {
      try { requireLocalFetchDevelopment(readServiceEnvironment(), c.req.param("workspaceId")); }
      catch { return c.body(null, 403); }
      const remote = (c.env as ApiWorkerBindings).DEV_CLOUD;
      if (remote) return remote.fetch(c.req.raw);
      return (c.env as ApiWorkerBindings).LOCAL_FETCH_MAILBOX.getByName(c.req.param("workspaceId")).fetch(c.req.raw);
    });
}

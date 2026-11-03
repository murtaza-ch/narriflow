import { WorkerEntrypoint } from "cloudflare:workers";
import { createDatabaseScope, getPrismaClient, withDatabaseScope } from "@narriflow/db/client";
import { ExecutionDispatchError, readExecutionDispatch } from "@narriflow/services/execution-dispatch";
import { withExecutionDispatches } from "@narriflow/services/execution-dispatch-runtime";
import type { LocalFetchDeviceClaims } from "@narriflow/services/local-fetch-device";
import type { ProgressRevocation } from "@narriflow/services/progress-feed";
import { executionDispatchReferenceSchema, type ExecutionDispatchReference } from "@narriflow/validators/execution";
import type { WorkflowStageUpdatedEvent } from "@narriflow/validators/api/progress";
import type { DevelopmentCloudPort, DevelopmentProgressTicketScope } from "./development-cloud-port";
import { createProgressTicketCodec, loadProgressTicketKeys } from "@narriflow/services/progress-ticket";
import { PROGRESS_CONNECT_TICKET_MS } from "@narriflow/validators/api/progress";
import type { ApiWorkerBindings } from "./worker-bindings";
import { withWorkerServices, workerServiceEnvironment } from "./worker-services";
import { createWorkerExecutionScheduler, registerProgressContinuations } from "./workflows/scheduler";
import { createApiWorker } from "./worker";
import { loadApiConfig, loadCorsAllowedOrigins } from "./config";
import { createProductionApp } from "./runtime";

/** Accessed through a Cloudflare Service binding, never an HTTP RPC endpoint.
 * The deployed development Worker owns every durable cloud resource. */
export class DevelopmentBindings extends WorkerEntrypoint<ApiWorkerBindings> implements DevelopmentCloudPort {
  #bindings() {
    if (this.env.ADMISSION_STATE === "fenced") throw new Error("execution_fenced");
    if (this.env.APP_ENV !== "development" || this.env.DEV_CLOUD) throw new Error("development_binding_unavailable");
    return this.env;
  }
  #database<T>(operation: () => Promise<T>) {
    const bindings = this.#bindings();
    return withWorkerServices(bindings, workerServiceEnvironment(bindings), () => withDatabaseScope(
      createDatabaseScope({ connectionString: bindings.HYPERDRIVE.connectionString }), () => withExecutionDispatches(operation)));
  }
  async dispatch(value: ExecutionDispatchReference) {
    const reference = executionDispatchReferenceSchema.parse(value);
    return this.#database(async () => {
      const database = getPrismaClient()!;
      const record = await readExecutionDispatch(database, reference.dispatchId);
      const epoch = await database.executionEpoch.findUnique({ where: { id: 1 } });
      if (!record || JSON.stringify(record.reference) !== JSON.stringify(reference) || epoch?.epoch !== reference.deploymentEpoch) throw new ExecutionDispatchError("epoch_superseded");
      return createWorkerExecutionScheduler(this.#bindings()).deliver({ reference: record.reference, deliveryKey: record.deliveryKey, instanceId: record.instanceId,
        dueAt: record.dueAt, mode: record.wakeKind !== null || record.deadlineKind !== null ? "wake" : "registration",
        wakeKind: record.wakeKind, deadlineKind: record.deadlineKind, observedDeadlineAt: record.observedDeadlineAt });
    });
  }
  async progressContinuations(ids: readonly string[]) {
    if (ids.length > 100) throw new Error("progress_continuation_limit");
    return this.#database(() => registerProgressContinuations(this.#bindings(), ids));
  }
  async issueProgressTicket(scope: DevelopmentProgressTicketScope, authorizedAt: number) {
    const environment = workerServiceEnvironment(this.#bindings());
    if (!loadCorsAllowedOrigins(environment).includes(scope.origin)) throw new Error("progress_origin_not_allowed");
    const now = Date.now();
    if (!Number.isSafeInteger(authorizedAt) || now < authorizedAt - 5_000 || now >= authorizedAt + PROGRESS_CONNECT_TICKET_MS) throw new Error("progress_authorization_expired");
    // The shared cloud socket owns its audience, even for localhost callers.
    return createProgressTicketCodec(loadProgressTicketKeys(environment)).issue({ ...scope, audience: new URL("/api/progress", environment.API_ORIGIN).href }, authorizedAt);
  }
  async publishProgress(scope: { projectId: string; workspaceId: string }, event: WorkflowStageUpdatedEvent) {
    return this.#bindings().PROJECT_PROGRESS.getByName(scope.projectId).publish(scope, event);
  }
  async revokeProgress(input: ProgressRevocation) { return this.#bindings().PROJECT_PROGRESS.getByName(input.projectId).revoke(input); }
  async checkRate(name: string, command: { limit: number; windowSeconds: number; consume: boolean }) {
    if (!/^[a-f0-9]{64}$/.test(name)) throw new Error("rate_key_invalid");
    return this.#bindings().RATE_LIMITER.getByName(name).check(command);
  }
  async registerDevice(claims: LocalFetchDeviceClaims) { return this.#bindings().LOCAL_FETCH_MAILBOX.getByName(claims.workspaceId).register(claims); }
  async authorizeDevice(workspaceId: string, sessionId: string) { return this.#bindings().LOCAL_FETCH_MAILBOX.getByName(workspaceId).authorize(sessionId); }
  async connectDeviceTicket(workspaceId: string, sessionId: string) { return this.#bindings().LOCAL_FETCH_MAILBOX.getByName(workspaceId).connectTicket(sessionId); }
  async devicePresence(workspaceId: string) { return this.#bindings().LOCAL_FETCH_MAILBOX.getByName(workspaceId).presence(); }
  async revokeDevice(input: { workspaceId: string; actorUserId?: string; authorizedBefore: number }) { return this.#bindings().LOCAL_FETCH_MAILBOX.getByName(input.workspaceId).revoke(input); }
  override async fetch(request: Request): Promise<Response> {
    const bindings = this.#bindings(), path = new URL(request.url).pathname;
    if (!/^\/api\/(?:progress\/[a-f0-9-]{36}|dev-device\/[a-f0-9-]{36}\/socket)$/.test(path) || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response(null, { status: 404 });
    return createApiWorker({ createApp: (environment, run) => createProductionApp(loadApiConfig(environment), environment, run) }).fetch(request, bindings, this.ctx);
  }
}

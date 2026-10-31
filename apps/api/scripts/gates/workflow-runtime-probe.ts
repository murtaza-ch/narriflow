import { withProgressDelivery, progressDeliveryPort } from "@narriflow/services/progress-delivery";
import { getExecutionDispatch } from "@narriflow/services/execution-dispatch-runtime";
import { Hono } from "hono";
import { createApiWorker } from "../../src/worker";
import { createProgressSocketRoutes } from "../../src/domains/progress/socket";
import { createProgressTicketCodec, loadProgressTicketKeys } from "@narriflow/services/progress-ticket";
import { appendProgressRevocation, deliverProgressAfterCommit } from "@narriflow/services/progress-outbox";
import { readProgressReplay } from "@narriflow/services/progress-feed";
import type { ApiEnv } from "../../src/http/env";
export { Maintenance } from "../../src/workflows/maintenance";
export { ProjectProgress } from "../../src/durable-objects/project-progress";
import { DurableObject } from "cloudflare:workers";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { createDatabaseScope, getPrismaClient } from "@narriflow/db/client";
import { executionDispatchIdentity } from "@narriflow/services/execution-dispatch";
import { executionDispatchReferenceSchema, type ExecutionDispatchReference } from "@narriflow/validators/execution";
import { ScopedDomainWorkflow } from "../../src/workflows/scoped-workflow";
import { createWorkerExecutionScheduler } from "../../src/workflows/scheduler";
import { dispatchContinuationInstanceId, workflowDispatchEventSchema, type WorkflowCommandHandler, type WorkflowHandlerRegistry, type WorkflowKind } from "../../src/workflows/protocol";
import type { ApiWorkerBindings } from "../../src/worker-bindings";

export class GateState extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) { super(ctx, env); ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, scope TEXT NOT NULL, detail TEXT NOT NULL)"); }
  async record(kind: string, scope: string, detail: string) { this.ctx.storage.sql.exec("INSERT INTO log(kind, scope, detail) VALUES (?, ?, ?)", kind, scope, detail); }
  async read() { return this.ctx.storage.sql.exec<{ kind: string; scope: string; detail: string }>("SELECT kind, scope, detail FROM log ORDER BY id").toArray(); }
}
interface Bindings extends ApiWorkerBindings { GATE_WORKFLOW: Workflow<ExecutionDispatchReference>; GATE_CONTINUATION: Workflow<ExecutionDispatchReference>; GATE_STATE: DurableObjectNamespace<GateState> }
export class GateWorkflow extends ScopedDomainWorkflow {
  protected readonly workflowKind: WorkflowKind = "import_pipeline";
  private scopeId = "";
  private subject = "";
  protected override scope() {
    const id = crypto.randomUUID(); this.scopeId = id;
    return createDatabaseScope({ createClient: () => {
      const state = (this.env as Bindings).GATE_STATE.getByName(this.subject);
      const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: this.env.HYPERDRIVE.connectionString, max: 1, connectionTimeoutMillis: 10_000, query_timeout: 10_000 }) });
      return { client, dispose: async () => { await client.$disconnect(); await state.record("close", id, "disposed"); } };
    } });
  }
  protected override registry(): WorkflowHandlerRegistry {
    const handler: WorkflowCommandHandler = async ({ reference, wake }) => {
      this.subject = reference.subject.id;
      const state = (this.env as Bindings).GATE_STATE.getByName(this.subject);
      const scopeId = this.scopeId;
      const client = getPrismaClient()!;
      await state.record("open", scopeId, wake.type);
      const [row] = await client.$queryRaw<Array<{ answer: number }>>`SELECT 42::integer AS answer`;
      if (row?.answer !== 42) throw new Error("SQL result mismatch");
      await state.record("query", scopeId, wake.type);
      if (reference.subject.id.startsWith("continuation")) return { type: "complete", disposition: "terminal" };
      if (reference.subject.id.startsWith("early") && wake.type === "start") return { type: "sleep", until: new Date(Date.now() + 1_000).toISOString() };
      if (wake.type === "start" || wake.type === "timer") return { type: "wait", until: new Date(Date.now() + (reference.subject.id.startsWith("timeout") ? 1_100 : 20_000)).toISOString(), deliveryId: crypto.randomUUID() };
      return { type: "complete", disposition: "terminal" };
    };
    return { import_pipeline: { ingest_job: handler } };
  }
}
export class GateContinuation extends GateWorkflow { protected override readonly workflowKind: WorkflowKind = "maintenance"; }

const api = createApiWorker({ createApp(environment) {
  return { async fetch(request, resourceBindings, context) {
    const bindings = resourceBindings as Bindings;
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/progress/")) {
      const codec = createProgressTicketCodec(loadProgressTicketKeys(environment));
      return new Hono<ApiEnv>().route("/api", createProgressSocketRoutes({ allowedOrigins: ["https://web.narriflow.test"], audience: "https://api.narriflow.test/api/progress", verify: codec.verify,
        replay: (scope, cursor) => readProgressReplay(getPrismaClient()!, scope, cursor),
      })).fetch(request, bindings, context);
    }
    if (url.pathname === "/progress-revoke" && request.method === "POST") {
      const input = await request.json() as { workspaceId?: unknown };
      if (typeof input.workspaceId !== "string" || !/^[a-f0-9-]{36}$/.test(input.workspaceId)) return new Response(null, { status: 400 });
      const database = getPrismaClient()!;
      const fixture = await database.workspace.findFirst({ where: { id: input.workspaceId, owner: { clerkId: { startsWith: "workflow-progress-gate:" } } }, select: { id: true } });
      if (!fixture) return new Response(null, { status: 403 });
      const record = await database.$transaction((tx) => appendProgressRevocation(tx, { workspaceId: fixture.id, error: "workspace_restricted" }));
      const continuationIds: string[] = [];
      const port = progressDeliveryPort()!;
      let lostAcknowledgement = false;
      await withProgressDelivery({ ...port, revoke: async (input) => { await port.revoke(input); if (url.searchParams.get("loseAck") === "1" && !lostAcknowledgement) { lostAcknowledgement = true; throw new Error("Injected lost DO acknowledgement"); } }, registerContinuations: async (ids) => { await port.registerContinuations(ids); continuationIds.push(...ids); } }, () => deliverProgressAfterCommit(database, [record]));
      const dispatch = getExecutionDispatch(createWorkerExecutionScheduler(bindings));
      const continuationInstances: string[] = [];
      for (const id of continuationIds) continuationInstances.push((await dispatch.read(id))!.instanceId);
      return Response.json({ dispatchId: record.reference.dispatchId, continuationInstances });
    }
    if (url.pathname === "/maintenance-status") {
      const id = url.searchParams.get("instanceId") ?? "";
      if (!/^nf_[a-f0-9]{64}$/.test(id)) return new Response(null, { status: 400 });
      return Response.json(await (await bindings.MAINTENANCE.get(id)).status());
    }
    const reference = executionDispatchReferenceSchema.parse(JSON.parse(url.searchParams.get("reference") ?? "null"));
    const identity = await executionDispatchIdentity(reference);
    if (url.pathname === "/stats") return Response.json(await bindings.GATE_STATE.getByName(reference.subject.id).read());
    const actual = { ...bindings, IMPORT_PIPELINE: bindings.GATE_WORKFLOW, MAINTENANCE: bindings.GATE_CONTINUATION };
    const scheduler = createWorkerExecutionScheduler(actual);
    if (url.pathname === "/continuation-status") return Response.json(await (await bindings.GATE_CONTINUATION.get(dispatchContinuationInstanceId(reference))).status());
    if (url.pathname === "/deadline") return Response.json(await scheduler.deliver({ reference, ...identity, dueAt: new Date(), mode: "registration", wakeKind: null, deadlineKind: "operation", observedDeadlineAt: new Date() }));
    if (url.pathname === "/create") return Response.json(await scheduler.deliver({ reference, ...identity, dueAt: new Date(), mode: "registration", wakeKind: null, deadlineKind: null, observedDeadlineAt: null }));
    const instance = await bindings.GATE_WORKFLOW.get(identity.instanceId);
    if (url.pathname === "/late-wake") return Response.json(await scheduler.deliver({ reference, ...identity, dueAt: new Date(), mode: "wake", wakeKind: "audio.ready", deadlineKind: null, observedDeadlineAt: null }));
    if (url.pathname === "/wake") {
      await instance.sendEvent({ type: "dispatch", payload: workflowDispatchEventSchema.parse({ reference, wakeKind: "audio.ready", deadlineKind: null, observedDeadlineAt: null }) });
      return Response.json({ status: "confirmed_notified" });
    }
    if (url.pathname === "/status") return Response.json(await instance.status());
    if (url.pathname === "/scope-mismatch") {
      await instance.sendEvent({ type: "dispatch", payload: workflowDispatchEventSchema.parse({ reference: { ...reference, subject: { ...reference.subject, id: "different-subject" } }, wakeKind: "audio.ready", deadlineKind: null, observedDeadlineAt: null }) });
      return Response.json({ notified: true });
    }
    return new Response(null, { status: 404 });
  } };
} });
export default { fetch(request: Request, bindings: Bindings, context: ExecutionContext) {
  if (typeof bindings.GATE_KEY === "string" && request.headers.get("X-Gate-Key") !== bindings.GATE_KEY) return new Response(null, { status: 401 });
  return api.fetch(request, bindings, context);
} };

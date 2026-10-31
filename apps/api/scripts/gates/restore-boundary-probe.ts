import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { createDatabaseScope, getPrismaClient } from "@narriflow/db/client";
import { deliverExecutionDispatches } from "@narriflow/services/execution-dispatch-runtime";
import { ExecutionRestoreService, EXECUTION_RESTORE_PHASES } from "@narriflow/services/execution-restore";
import { ScopedDomainWorkflow } from "../../src/workflows/scoped-workflow";
import { createWorkerExecutionScheduler } from "../../src/workflows/scheduler";
import type { WorkflowHandlerRegistry, WorkflowKind } from "../../src/workflows/protocol";
import type { ApiWorkerBindings } from "../../src/worker-bindings";

interface Bindings extends ApiWorkerBindings { GATE_DATABASE_URL: string; GATE_DATABASE_SCHEMA: string }
export class RestoreBoundaryGate extends ScopedDomainWorkflow {
  protected readonly workflowKind: WorkflowKind = "maintenance";
  protected override scope() {
    const bindings = this.env as Bindings, url = new URL(bindings.GATE_DATABASE_URL);
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.port !== "55432" || !url.pathname.startsWith("/narriflow_serverless_gates_") ||
      !/^serverless_execution_test_[a-z0-9_]+$/.test(bindings.GATE_DATABASE_SCHEMA)) throw Error("local_restore_probe_target_invalid");
    return createDatabaseScope({ createClient: () => {
      const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: bindings.GATE_DATABASE_URL, max: 1 }, { schema: bindings.GATE_DATABASE_SCHEMA }) });
      return { client, dispose: () => client.$disconnect() };
    } });
  }
  protected override registry(): WorkflowHandlerRegistry {
    return { maintenance: { maintenance: async ({ reference }) => {
      const database = getPrismaClient()!;
      const restore = new ExecutionRestoreService({ database,
        phases: Object.fromEntries(EXECUTION_RESTORE_PHASES.map(phase => [phase, async () => ({ processed: 0, next: null })])),
        register: deliverExecutionDispatches,
      });
      await restore.run(reference); return { type: "complete", disposition: "terminal" };
    } } };
  }
}
export default { async fetch(request: Request, bindings: Bindings) {
  const url = new URL(request.url);
  if (url.pathname === "/register" && request.method === "POST") return Response.json(await createWorkerExecutionScheduler(bindings).deliver(await request.json()));
  const id = url.searchParams.get("id") ?? "";
  if (url.pathname === "/status" && /^nf_[a-f0-9]{64}$/.test(id)) return Response.json(await (await bindings.MAINTENANCE.get(id)).status());
  return new Response(null, { status: 404 });
} };

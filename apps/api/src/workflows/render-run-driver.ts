import type { RenderRunPreparation, RenderRunSettlement } from "@narriflow/services/workflow-run-lifecycle";
import type { ExecutorExpiryResult } from "@narriflow/services/executor-domain-control";
import type { ExecutionDispatchReference } from "@narriflow/validators/execution";
import type { WorkflowCommandHandler, WorkflowDirective } from "./protocol";

interface Ports {
  now(): number;
  prepare(reference: ExecutionDispatchReference): Promise<RenderRunPreparation>;
  settle(reference: ExecutionDispatchReference): Promise<RenderRunSettlement>;
  deliver(ids: readonly string[]): Promise<void>;
  expire(deadline: { reference: ExecutionDispatchReference; observedDeadlineAt: Date }): Promise<ExecutorExpiryResult>;
}

/** The parent freezes and settles metadata. It never acquires an executor owner. */
export function createRenderRunDriver(ports: Ports): WorkflowCommandHandler {
  const deliver = async (ids: readonly string[]) => {
    for (let offset = 0; offset < ids.length; offset += 128) await ports.deliver(ids.slice(offset, offset + 128));
  };
  return async ({ reference }) => {
    const prepared = await ports.prepare(reference);
    await deliver(prepared.dispatchIds);
    if (prepared.kind === "superseded") return { type: "complete", disposition: "superseded" };
    if (prepared.kind === "waiting_for_video") return { type: "wait", until: prepared.dueAt.toISOString(), deliveryId: prepared.deadlineDispatchId };
    let settled = await ports.settle(reference);
    await deliver(settled.dispatchIds);
    const observations: Date[] = [];
    if (settled.kind === "settled" && settled.outcome.status === "pending" && settled.wait) {
      const overdue = settled.wait.deadlines.filter(deadline => deadline.observedDeadlineAt.getTime() <= ports.now());
      for (const deadline of overdue) {
        const expired = await ports.expire(deadline);
        await deliver("dispatchIds" in expired ? expired.dispatchIds ?? [] : []);
        if (expired.kind === "sleep") observations.push(expired.dueAt);
      }
      if (overdue.length) { settled = await ports.settle(reference); await deliver(settled.dispatchIds); }
    }
    const result = directive(settled);
    if (result.type === "wait") {
      const fresh = [new Date(result.until), ...observations].filter(dueAt => dueAt.getTime() > ports.now());
      if (!fresh.length) throw new Error("render_deadline_unsettled");
      return { ...result, until: new Date(Math.min(...fresh.map(date => date.getTime()))).toISOString() };
    }
    return result;
  };
}

function directive(result: RenderRunSettlement): WorkflowDirective {
  if (result.kind !== "settled") return { type: "complete", disposition: result.kind === "superseded" ? "superseded" : "terminal" };
  if (result.outcome.status !== "pending") return { type: "complete", disposition: "terminal" };
  if (!result.wait) throw new Error("render_parent_obligation_missing");
  return { type: "wait", until: result.wait.dueAt.toISOString(), deliveryId: result.wait.deliveryId };
}

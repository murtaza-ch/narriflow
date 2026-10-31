import { expect, test } from "bun:test";
import type { ExecutionDispatchReference } from "@narriflow/validators/execution";
import { createRenderRunDriver } from "./render-run-driver";

const now = Date.parse("2026-10-31T00:00:00Z");
const reference: ExecutionDispatchReference = { dispatchId: crypto.randomUUID(), deploymentEpoch: 1, generation: 1, inputHash: "a".repeat(64), kind: "render_run", subject: { kind: "workflow_run", id: crypto.randomUUID() } };
const outcome = { status: "completed" as const, requested: 1, succeeded: 1, failed: 0, superseded: 0, followUpWorkflowRunId: null };
const prepared = { kind: "prepared" as const, groups: [], dispatchIds: [crypto.randomUUID()], workSet: { workflowRunId: reference.subject.id, frozenAt: new Date(now), variantIds: [] } };

test("a child outcome committed before the parent wait settles immediately and repairs its wakes", async () => {
  const deliveries: string[][] = [];
  const followUp = crypto.randomUUID();
  const run = createRenderRunDriver({ now: () => now, prepare: async () => prepared,
    settle: async () => ({ kind: "settled", outcome, dispatchIds: [followUp] }),
    deliver: async ids => { deliveries.push([...ids]); }, expire: async () => { throw new Error("No expiry for a completed batch"); } });
  expect(await run({ reference, wake: { type: "start" } })).toEqual({ type: "complete", disposition: "terminal" });
  expect(deliveries).toEqual([prepared.dispatchIds, [followUp]]);
});

test("an elapsed group deadline executes its exact expiry before settling instead of returning a past-due wait", async () => {
  const child = { reference: { ...reference, kind: "operation_driver" as const, dispatchId: crypto.randomUUID(), subject: { kind: "render_group" as const, id: crypto.randomUUID() } }, observedDeadlineAt: new Date(now - 1) };
  const expired: string[] = []; let reads = 0;
  const run = createRenderRunDriver({ now: () => now, prepare: async () => prepared, deliver: async () => {},
    settle: async () => ++reads === 1 ? { kind: "settled", outcome: { ...outcome, status: "pending", succeeded: 0 }, dispatchIds: [],
      wait: { dueAt: child.observedDeadlineAt, deliveryId: child.reference.dispatchId, deadlines: [child] } }
      : { kind: "settled", outcome: { ...outcome, status: "failed", succeeded: 0, failed: 1 }, dispatchIds: [] },
    expire: async deadline => { expired.push(deadline.reference.dispatchId); return { kind: "expired" }; } });
  expect(await run({ reference, wake: { type: "deadline", until: child.observedDeadlineAt.toISOString(), deliveryId: child.reference.dispatchId } })).toEqual({ type: "complete", disposition: "terminal" });
  expect(expired).toEqual([child.reference.dispatchId]); expect(reads).toBe(2);
});

test("one old timer with divergent renewed deadlines waits for the nearest fresh observation", async () => {
  const children = [50_000,10_000].map((delay,index) => ({ delay, reference: { ...reference, kind: "operation_driver" as const, dispatchId: crypto.randomUUID(), subject: { kind: "render_group" as const, id: crypto.randomUUID() } }, observedDeadlineAt: new Date(now - index - 1) }));
  const run = createRenderRunDriver({ now: () => now, prepare: async () => prepared, deliver: async () => {},
    settle: async () => ({ kind: "settled", outcome: { ...outcome, requested: 2, status: "pending", succeeded: 0 }, dispatchIds: [],
      wait: { dueAt: children[0]!.observedDeadlineAt, deliveryId: children[0]!.reference.dispatchId, deadlines: children } }),
    expire: async deadline => ({ kind: "sleep", dueAt: new Date(now + children.find(child => child.reference.dispatchId === deadline.reference.dispatchId)!.delay) }) });
  expect(await run({ reference, wake: { type: "timer", until: new Date(now - 1).toISOString() } })).toEqual({ type: "wait", until: new Date(now + 10_000).toISOString(), deliveryId: children[0]!.reference.dispatchId });
});

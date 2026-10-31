import { z } from "zod";
import { executionDeadlineSchema, executionDispatchReferenceSchema, type ExecutionDispatchKind, type ExecutionDispatchReference, type ExecutionSubjectKind } from "@narriflow/validators/execution";

export const WORKFLOW_METADATA_MAX_BYTES = 64 * 1024;
export const WORKFLOW_DISPATCH_EVENT = "dispatch";
export type WorkflowKind = "import_pipeline" | "render_run" | "operation_driver" | "maintenance";
export const workflowDispatchEventSchema = z.strictObject({
  reference: executionDispatchReferenceSchema,
  wakeKind: z.string().regex(/^[a-z][a-z0-9_.-]{0,39}$/),
  deadlineKind: z.enum(["lease", "operation", "provider_submission", "provider_result", "retry"]).nullable(),
  observedDeadlineAt: z.string().datetime().nullable(),
});
export type WorkflowDispatchEvent = z.infer<typeof workflowDispatchEventSchema>;
export const workflowDirectiveSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("complete"), disposition: z.enum(["terminal", "superseded"]) }),
  z.strictObject({ type: z.literal("wait"), until: z.string().datetime(), deliveryId: z.string().uuid(), deadline: executionDeadlineSchema.optional() }),
  z.strictObject({ type: z.literal("sleep"), until: z.string().datetime() }),
]);
export type WorkflowDirective = z.infer<typeof workflowDirectiveSchema>;
export type WorkflowWake = { type: "start" } | { type: "dispatch"; delivery: WorkflowDispatchEvent } | { type: "deadline"; until: string; deliveryId: string; deadline?: z.infer<typeof executionDeadlineSchema> } | { type: "timer"; until: string };
export interface WorkflowCommand { reference: ExecutionDispatchReference; wake: WorkflowWake }
/** A command re-reads the ledger and releases all coordinator claims before
 * returning wait metadata. A replayed directive grants no mutation authority. */
export type WorkflowCommandHandler = (command: WorkflowCommand) => Promise<WorkflowDirective>;
export type WorkflowHandlerRegistry = Partial<Record<ExecutionDispatchKind, Partial<Record<ExecutionSubjectKind, WorkflowCommandHandler>>>>;
export function assertMetadataBound(input: unknown): void {
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > WORKFLOW_METADATA_MAX_BYTES) throw new Error("workflow_metadata_limit");
}

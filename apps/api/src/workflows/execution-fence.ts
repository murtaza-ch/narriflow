import type { ExecutionDispatchReference } from "@narriflow/validators/execution";

/** Restore pages can transform authority while every product consumer stays
 * stopped. Provider-capable TS drivers are consumers too. */
export function canRunWhileFenced(reference: ExecutionDispatchReference): boolean {
  return reference.kind === "maintenance" && reference.subject.kind === "maintenance" && reference.subject.id.startsWith("rs2.");
}

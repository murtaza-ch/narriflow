import { AsyncLocalStorage } from "node:async_hooks";
import type { WorkflowStageUpdatedEvent } from "@narriflow/validators/api/progress";
import type { ProgressRevocation } from "./progress-feed";

export interface ProgressDeliveryPort {
  publish(scope: { projectId: string; workspaceId: string }, event: WorkflowStageUpdatedEvent): Promise<void>;
  revoke(input: ProgressRevocation): Promise<void>;
}
const delivery = new AsyncLocalStorage<ProgressDeliveryPort>();
export function withProgressDelivery<T>(port: ProgressDeliveryPort, operation: () => T): T { return delivery.run(port, operation); }
export function progressDeliveryPort(): ProgressDeliveryPort | null { return delivery.getStore() ?? null; }

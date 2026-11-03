import type { ExecutionDispatchConfirmation } from "@narriflow/services/execution-dispatch";
import type { ProgressConnection, ProgressRevocation } from "@narriflow/services/progress-feed";
import type { LocalFetchDeviceClaims } from "@narriflow/services/local-fetch-device";
import type { RateLimitResult } from "@narriflow/services/rate-limit";
import type { ExecutionDispatchReference } from "@narriflow/validators/execution";
import type { ProgressTicketPayload, WorkflowStageUpdatedEvent } from "@narriflow/validators/api/progress";

export type DevelopmentProgressTicketScope = Pick<ProgressTicketPayload, "actorUserId" | "workspaceId" | "projectId" | "origin">;

/** Finite transport capabilities for the shared development resources. No SQL,
 * provider call or arbitrary service method can be supplied by a caller. */
export interface DevelopmentCloudPort {
  fetch(request: Request): Promise<Response>;
  dispatch(reference: ExecutionDispatchReference): Promise<ExecutionDispatchConfirmation>;
  progressContinuations(ids: readonly string[]): Promise<void>;
  issueProgressTicket(scope: DevelopmentProgressTicketScope, authorizedAt: number): Promise<string>;
  publishProgress(scope: { projectId: string; workspaceId: string }, event: WorkflowStageUpdatedEvent): Promise<void>;
  revokeProgress(input: ProgressRevocation): Promise<void>;
  checkRate(name: string, command: { limit: number; windowSeconds: number; consume: boolean }): Promise<RateLimitResult>;
  registerDevice(claims: LocalFetchDeviceClaims): Promise<void>;
  authorizeDevice(workspaceId: string, sessionId: string): Promise<LocalFetchDeviceClaims>;
  connectDeviceTicket(workspaceId: string, sessionId: string): Promise<{ ticket: string; expiresAt: number }>;
  devicePresence(workspaceId: string): Promise<{ available: boolean }>;
  revokeDevice(input: { workspaceId: string; actorUserId?: string; authorizedBefore: number }): Promise<void>;
}

export type DevelopmentProgressPort = Pick<ProgressConnection, "publish" | "revoke">;

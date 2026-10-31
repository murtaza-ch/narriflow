import type { ApiWorkerBindings } from "./worker-bindings";
import type { LocalFetchDeviceClaims } from "@narriflow/services/local-fetch-device";
import type { DevelopmentProgressPort } from "./development-cloud-port";

export function localDeviceMailbox(bindings: ApiWorkerBindings, workspaceId: string) {
  const remote = bindings.DEV_CLOUD;
  if (!remote) return bindings.LOCAL_FETCH_MAILBOX.getByName(workspaceId);
  return {
    register: (claims: LocalFetchDeviceClaims) => remote.registerDevice(claims),
    authorize: (sessionId: string) => remote.authorizeDevice(workspaceId, sessionId),
    connectTicket: (sessionId: string) => remote.connectDeviceTicket(workspaceId, sessionId),
    presence: () => remote.devicePresence(workspaceId),
    revoke: (input: { workspaceId: string; actorUserId?: string; authorizedBefore: number }) => remote.revokeDevice(input),
  };
}
export function projectProgressPort(bindings: ApiWorkerBindings, projectId: string): DevelopmentProgressPort {
  const remote = bindings.DEV_CLOUD;
  return remote ? { publish: (scope, event) => remote.publishProgress(scope, event), revoke: input => remote.revokeProgress(input) }
    : bindings.PROJECT_PROGRESS.getByName(projectId);
}
export function rateLimiterNamespace(bindings: ApiWorkerBindings) {
  const remote = bindings.DEV_CLOUD;
  return remote ? { getByName: (name: string) => ({ check: (command: { limit: number; windowSeconds: number; consume: boolean }) => remote.checkRate(name, command) }) }
    : bindings.RATE_LIMITER;
}

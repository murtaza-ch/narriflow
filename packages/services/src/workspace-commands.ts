import { WORKSPACE_RECEIPT_COMMANDS } from "./workspace-receipt-commands";

/** Dependencies of the workspace receipt-backed commands. The owning ticket adds what its commands need. */
export type WorkspaceCommandDependencies = Record<string, never>;

/**
 * Receipt-backed retryable commands of the workspace domain. Only names registered
 * in `WORKSPACE_RECEIPT_COMMANDS` may be recorded.
 */
export function createWorkspaceCommands(_dependencies: WorkspaceCommandDependencies) {
  return { receiptCommands: WORKSPACE_RECEIPT_COMMANDS };
}

export type WorkspaceCommands = ReturnType<typeof createWorkspaceCommands>;

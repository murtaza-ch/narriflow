import { getOperationReceiptExecutor } from "./operation-receipt-runtime";
import { createWorkspaceCommands } from "./workspace-commands";
import { workspaceService } from "./workspace.service";

/** Production wiring of the workspace commands. */
export const workspaceCommands = createWorkspaceCommands({
  receipts: getOperationReceiptExecutor,
  workspaces: workspaceService,
});

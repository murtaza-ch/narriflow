import { createProjectsCommands } from "./projects-commands";
import { getOperationReceiptExecutor } from "./operation-receipt-runtime";
import { workspaceService } from "./workspace.service";

/** Production wiring of the projects commands. */
export const projectsCommands = createProjectsCommands({
	receipts: getOperationReceiptExecutor,
	requireActor: (scope, capability) =>
		workspaceService.requireActor(scope.actorUserId, scope.workspaceId, capability),
});

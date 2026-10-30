import type { Prisma } from "@prisma/client";
import type { WorkspaceCapability } from "@narriflow/validators";
import type { ActorScope } from "./actor-scope";
import type {
	createOperationReceiptExecutor,
	IntegrationMutation,
} from "./operation-receipt";
import { PROJECTS_RECEIPT_COMMANDS } from "./projects-receipt-commands";
import {
	folderCreateData,
	folderCreateSelect,
	folderNameTakenFromDatabase,
	validFolderName,
} from "./workspace-library.service";

type ReceiptExecutor = ReturnType<
	typeof createOperationReceiptExecutor<Prisma.TransactionClient>
>;

/** Dependencies of the projects receipt-backed commands. */
export interface ProjectsCommandDependencies {
	/** Resolved per command, because the executor needs the database client. */
	receipts(): Pick<ReceiptExecutor, "execute">;
	requireActor(scope: ActorScope, capability: WorkspaceCapability): Promise<unknown>;
}

/** A created folder as it is stored in the receipt and returned on replay. */
export interface CreatedFolder {
	id: string;
	name: string;
	/** ISO 8601. */
	createdAt: string;
}

/**
 * Receipt-backed retryable commands of the projects domain. Only names registered
 * in `PROJECTS_RECEIPT_COMMANDS` may be recorded.
 */
export function createProjectsCommands(dependencies: ProjectsCommandDependencies) {
	return {
		receiptCommands: PROJECTS_RECEIPT_COMMANDS,

		/**
		 * Creates a folder once per caller key. The receipt fingerprints the
		 * validated name, so a replay with another name conflicts instead of
		 * creating a second folder, and the folder and receipt commit together.
		 */
		async createFolder(
			scope: ActorScope,
			name: string,
			mutation: IntegrationMutation,
		): Promise<{ folder: CreatedFolder; replayed: boolean }> {
			const safeName = validFolderName(name);
			const accepted = await dependencies.receipts().execute<CreatedFolder>({
				identity: {
					workspaceId: scope.workspaceId,
					actorUserId: scope.actorUserId,
					command: "create_folder",
					clientIdempotencyKey: mutation.clientIdempotencyKey,
				},
				input: { name: safeName },
				authorize: async () => {
					await dependencies.requireActor(scope, "content.edit");
				},
				beforeAccept: mutation.beforeAccept,
				mutate: async (tx) => {
					const folder = await tx.workspaceFolder
						.create({
							data: folderCreateData(scope, safeName),
							select: folderCreateSelect,
						})
						.catch(folderNameTakenFromDatabase);
					return {
						resourceType: "workspace_folder",
						resourceId: folder.id,
						value: {
							id: folder.id,
							name: folder.name,
							createdAt: folder.createdAt.toISOString(),
						},
					};
				},
			});
			return { folder: accepted.value, replayed: accepted.replayed };
		},
	};
}

export type ProjectsCommands = ReturnType<typeof createProjectsCommands>;

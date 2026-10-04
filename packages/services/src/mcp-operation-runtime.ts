import { Prisma, type PrismaClient } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
	createMcpOperationExecutor,
	type McpOperationIdentity,
	type McpOperationPersistence,
} from "./mcp-operation";

function unique(identity: McpOperationIdentity) {
	return { workspaceId_callerId_toolName_clientIdempotencyKey: identity };
}

export function prismaMcpOperationPersistence(
	prisma: PrismaClient,
): McpOperationPersistence<Prisma.TransactionClient> {
	return {
		read: (identity) =>
			prisma.mcpOperation.findUnique({ where: unique(identity) }),
		transaction: (run) => prisma.$transaction(run),
		async lock(tx, identity) {
			// PostgreSQL releases the transaction lock on commit or rollback. Hash
			// collisions merely serialize unrelated requests; they cannot replay them.
			const name = JSON.stringify([
				identity.workspaceId,
				identity.callerId,
				identity.toolName,
				identity.clientIdempotencyKey,
			]);
			await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${name}, 0))::text`;
		},
		readInTransaction: (tx, identity) =>
			tx.mcpOperation.findUnique({ where: unique(identity) }),
		async create(tx, receipt) {
			await tx.mcpOperation.create({
				data: {
					...receipt,
					result:
						receipt.result === null
							? Prisma.JsonNull
							: (receipt.result as Prisma.InputJsonValue),
				},
			});
		},
	};
}

export function getMcpOperationExecutor() {
	const prisma = getPrismaClient();
	if (!prisma) throw new Error("Database client unavailable");
	return createMcpOperationExecutor(prismaMcpOperationPersistence(prisma));
}

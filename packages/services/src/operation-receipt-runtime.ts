import { Prisma, type PrismaClient } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
	createOperationReceiptExecutor,
	type OperationReceiptIdentity,
	type OperationReceiptPersistence,
} from "./operation-receipt";
import { recoverReceiptNotificationDispatches } from "./notification-dispatch";

function unique(identity: OperationReceiptIdentity) {
	return { workspaceId_actorUserId_command_clientIdempotencyKey: identity };
}

export function prismaOperationReceiptPersistence(
	prisma: PrismaClient,
): OperationReceiptPersistence<Prisma.TransactionClient> {
	return {
		recover: (receipt, tx) => tx ? recoverReceiptNotificationDispatches(tx, receipt) : prisma.$transaction(tx => recoverReceiptNotificationDispatches(tx, receipt)),
		read: (identity) =>
			prisma.operationReceipt.findUnique({ where: unique(identity) }),
		transaction: (run) => prisma.$transaction(run),
		async lock(tx, identity) {
			// PostgreSQL releases the transaction lock on commit or rollback. Hash
			// collisions merely serialize unrelated requests; they cannot replay them.
			const name = JSON.stringify([
				identity.workspaceId,
				identity.actorUserId,
				identity.command,
				identity.clientIdempotencyKey,
			]);
			await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${name}, 0))::text`;
		},
		readInTransaction: (tx, identity) =>
			tx.operationReceipt.findUnique({ where: unique(identity) }),
		async create(tx, receipt) {
			await tx.operationReceipt.create({
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

export function getOperationReceiptExecutor() {
	const prisma = getPrismaClient();
	if (!prisma) throw new Error("Database client unavailable");
	return createOperationReceiptExecutor(prismaOperationReceiptPersistence(prisma));
}

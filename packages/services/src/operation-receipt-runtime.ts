import { WorkflowRunLifecycle } from "./workflow-run-lifecycle";
import {recoverNotificationDispatchIds} from "./notification-execution";
import {recoverPublicationDispatches} from "./publication-dispatch";
import { Prisma, type PrismaClient } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
	createOperationReceiptExecutor,
	type OperationReceiptIdentity,
	type OperationReceiptPersistence,
} from "./operation-receipt";
import { recoverReceiptNotificationDispatches } from "./notification-dispatch";
import { readExecutionAdmission } from "./execution-admission";
import { getIngestJobLifecycle } from "./ingest-job-lifecycle-runtime";

function unique(identity: OperationReceiptIdentity) {
	return { workspaceId_actorUserId_command_clientIdempotencyKey: identity };
}

export function prismaOperationReceiptPersistence(
	prisma: PrismaClient,
): OperationReceiptPersistence<Prisma.TransactionClient> {
 const recover:NonNullable<OperationReceiptPersistence<Prisma.TransactionClient>["recover"]>=async(receipt,tx)=>{
  if(!tx)return prisma.$transaction(tx=>recover(receipt,tx));
  await readExecutionAdmission(tx);
  if(receipt.resourceType==="ingest_job"&&["submit_video","create_captioned_video"].includes(receipt.command)){
   const job=await tx.ingestJob.findFirst({where:{id:receipt.resourceId,project:{workspaceId:receipt.workspaceId}}});
   if(!job)throw Error("ingest_receipt_job_missing");
   await getIngestJobLifecycle().queueExecutionWithinTransaction(tx,job.id);
  }
  if(receipt.resourceType==="clip_export"&&receipt.command==="create_clip_export")await new WorkflowRunLifecycle({prisma}).handoffClipExportWithinTransaction(tx,receipt.resourceId,receipt.workspaceId,{id:receipt.id,actorUserId:receipt.actorUserId});
  if(receipt.resourceType==="workflow_run"&&receipt.command==="render_clips")await new WorkflowRunLifecycle({prisma}).recoverClipRenderRunWithinTransaction(tx,receipt.resourceId,receipt.workspaceId,{result:receipt.result});
  await recoverReceiptNotificationDispatches(tx,receipt);
  if(receipt.resourceType==="review"&&receipt.result&&typeof receipt.result==="object"&&!Array.isArray(receipt.result))await recoverNotificationDispatchIds(tx,(receipt.result as Record<string,unknown>).notificationDispatchIds);
  if(receipt.resourceType==="social_post"&&["recheck_social_publication","publish_social_publication_again"].includes(receipt.command))await recoverPublicationDispatches(tx,receipt.resourceId,receipt.workspaceId);
 };
	return {
  recover,
		read: (identity) =>
			prisma.operationReceipt.findUnique({ where: unique(identity) }),
		transaction: (run) => prisma.$transaction(run),
		async lock(tx, identity) {
			// Domain admission checks run after this receipt lock. Take the epoch
			// first without refusing completion or exact replay while closed.
			await readExecutionAdmission(tx);
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

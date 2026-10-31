import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { ExecutionDispatchReference } from "@narriflow/validators/execution";
import {
	appendExecutionDispatch,
	readExecutionDispatch,
} from "./execution-dispatch";
import {collectExecutionDispatch} from "./execution-dispatch-runtime";

const scheduleInclude = {
	frozenState: true,
} satisfies Prisma.SocialPostInclude;
export type PublicationSchedule = Prisma.SocialPostGetPayload<{
	include: typeof scheduleInclude;
}>;
type Tx = Prisma.TransactionClient;

/** Schedule intent and physical-cycle identity are distinct. Provider checkpoints
 * and mutable statuses never alter the frozen input of an already admitted cycle. */
function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	return `{${Object.keys(value)
		.sort()
		.map(
			(key) =>
				`${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
		)
		.join(",")}}`;
}
export function publicationExecutionInputHash(post: PublicationSchedule) {
	const frozen = post.frozenState;
	return createHash("sha256")
		.update(
			JSON.stringify([
				"publication-execution-v1",
				post.id,
				post.workspaceId,
				post.projectId,
				post.createdByUserId,
				post.deploymentEpoch,
				post.generation,
				post.scheduleRevision,
				post.immutableRequestHash,
				post.scheduledFor?.toISOString() ?? null,
				post.standingGrantId,
				post.standingGrantRevision,
				frozen
					? [
							frozen.id,
							frozen.clipExportId,
							frozen.clipExportVariantId,
							frozen.editorRevision,
							frozen.exportFingerprint,
							frozen.platform,
							frozen.socialAccountId,
							frozen.capabilityVersion,
							createHash("sha256")
								.update(canonical(frozen.providerSettings))
								.digest("hex"),
							createHash("sha256").update(frozen.caption).digest("hex"),
						]
					: null,
			]),
		)
		.digest("hex");
}

export async function appendPublicationDispatch(
	tx: Tx,
	postId: string,
	options: {
		dueAt?: Date;
		wakeKind?: string;
	} = {},
) {
	const post = await tx.socialPost.findUniqueOrThrow({
		where: { id: postId },
		include: scheduleInclude,
	});
	const epoch = await tx.executionEpoch.findUniqueOrThrow({ where: { id: 1 } });
	if (post.deploymentEpoch !== epoch.epoch)
		throw new Error("publication_epoch_superseded");
	const result = await appendExecutionDispatch(tx, {
		deploymentEpoch: post.deploymentEpoch,
		generation: post.generation,
		kind: "operation_driver",
		subject: { kind: "social_publication", id: post.id },
		inputHash: publicationExecutionInputHash(post),
		dueAt:
			options.dueAt ??
			post.nextAttemptAt ??
			post.scheduledFor ??
			post.createdAt,
		...(options.wakeKind ? { wakeKind: options.wakeKind } : {}),
	});
	return result.reference.dispatchId;
}

/** Repair an accepted identity only. Never creates a new admission or invents
 * a next wake from a stale request, even if the producer committed a newer cycle. */
export async function recoverPublicationDispatches(tx:Tx,postId:string,workspaceId?:string){
 const epoch=await tx.executionEpoch.findUniqueOrThrow({where:{id:1}});
 const post=await tx.socialPost.findFirst({where:{id:postId,...(workspaceId?{workspaceId}:{}),deploymentEpoch:epoch.epoch},include:scheduleInclude});
 if(!post)return [];
 const rows=await tx.executionDispatch.findMany({where:{deploymentEpoch:epoch.epoch,subjectKind:"social_publication",subjectId:post.id,generation:post.generation,inputHash:publicationExecutionInputHash(post),kind:{in:["operation_driver","modal_execution"]},acknowledgedAt:null,deadLetteredAt:null},orderBy:{id:"asc"},take:129,select:{id:true}});
 if(rows.length>128)throw Error("publication_dispatch_repair_bound");
 for(const row of rows)collectExecutionDispatch(tx,row.id);
 return rows.map(row=>row.id);
}
export function samePublicationDispatch(a:ExecutionDispatchReference,b:ExecutionDispatchReference){
 return a.dispatchId===b.dispatchId&&a.kind===b.kind&&a.subject.kind===b.subject.kind&&a.subject.id===b.subject.id&&a.deploymentEpoch===b.deploymentEpoch&&a.generation===b.generation&&a.inputHash===b.inputHash;
}

export type PublicationScheduleObservation =
	| { kind: "superseded" }
	| { kind: "terminal" }
	| { kind: "sleep"; dueAt: Date }
	| { kind: "waiting_export"; clipExportVariantId: string }
	| { kind: "ready"; post: PublicationSchedule };

/** The Workflow rereads this snapshot after every sleep. A stale wake cannot
 * claim a newer revision, even if its old due time has already arrived. */
export async function observePublicationSchedule(
	database: Pick<PrismaClient, "$transaction">,
	reference: ExecutionDispatchReference,
): Promise<PublicationScheduleObservation> {
	return database.$transaction(async (tx) => {
		const epoch = await tx.executionEpoch.findUniqueOrThrow({
			where: { id: 1 },
		});
		const ledger = (await readExecutionDispatch(tx, reference.dispatchId))
			?.reference;
		if (
			reference.kind !== "operation_driver" ||
			reference.subject.kind !== "social_publication" ||
			reference.deploymentEpoch !== epoch.epoch ||
			!ledger ||
			ledger.dispatchId !== reference.dispatchId ||
			ledger.kind !== reference.kind ||
			ledger.subject.kind !== reference.subject.kind ||
			ledger.subject.id !== reference.subject.id ||
			ledger.deploymentEpoch !== reference.deploymentEpoch ||
			ledger.generation !== reference.generation ||
			ledger.inputHash !== reference.inputHash
		)
			return { kind: "superseded" };
		await tx.$queryRaw`SELECT "id" FROM "SocialPost" WHERE "id"=${reference.subject.id}::uuid FOR UPDATE`;
		const post = await tx.socialPost.findUnique({
			where: { id: reference.subject.id },
			include: scheduleInclude,
		});
		if (
			!post ||
			post.deploymentEpoch !== epoch.epoch ||
			post.generation !== reference.generation ||
			publicationExecutionInputHash(post) !== reference.inputHash
		)
			return { kind: "superseded" };
		if (
			[
				"draft",
				"cancelled",
				"posted",
				"inbox_delivered",
				"failed",
				"needs_attention",
			].includes(post.status)
		)
			return { kind: "terminal" };
		const [clock] = await tx.$queryRaw<
			Array<{ now: Date }>
		>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"`;
		const dueAt = post.nextAttemptAt ?? post.scheduledFor ?? post.createdAt;
		if (dueAt > clock!.now) return { kind: "sleep", dueAt };
		if (!post.frozenState) return { kind: "terminal" };
		if (
			!post.frozenState.storageKey ||
			post.frozenState.sizeBytes === null ||
			post.frozenState.durationSec === null
		)
			return {
				kind: "waiting_export",
				clipExportVariantId: post.frozenState.clipExportVariantId,
			};
		return { kind: "ready", post };
	});
}

import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { ExecutionDispatchReference } from "@narriflow/validators/execution";
import {
	appendExecutionDispatch,
	readExecutionDispatch,
} from "./execution-dispatch";
import {collectExecutionDispatch} from "./execution-dispatch-runtime";
import { canonicalJson } from "./canonical-json";

const scheduleInclude = {
	frozenState: true,
} satisfies Prisma.SocialPostInclude;
const SCHEDULE_SPREAD_MS = 120_000;
/** Planned posts land on whole minutes, and many on the hour. A stable per-post
 * offset stops them all reaching the containers and provider APIs in one second. */
export function spreadScheduledPublish(postId: string, scheduledFor: Date): Date {
	const offset = createHash("sha256").update(postId).digest().readUInt32BE(0) % SCHEDULE_SPREAD_MS;
	return new Date(scheduledFor.getTime() + offset);
}
/** When the driver may start a post. The registration keeps the exact schedule
 * in its identity and sleeps here, so the offset never changes a dispatch row. */
export function publicationReleaseAt(post: { id: string; nextAttemptAt: Date | null; scheduledFor: Date | null; createdAt: Date }): Date {
	if (post.nextAttemptAt) return post.nextAttemptAt;
	if (!post.scheduledFor) return post.createdAt;
	// "Post now" is stamped with the current instant, so it keeps its exact time.
	return post.scheduledFor.getTime() % 60_000 === 0 ? spreadScheduledPublish(post.id, post.scheduledFor) : post.scheduledFor;
}
export type PublicationSchedule = Prisma.SocialPostGetPayload<{
	include: typeof scheduleInclude;
}>;
type Tx = Prisma.TransactionClient;

/** Schedule intent and physical-cycle identity are distinct. Provider checkpoints
 * and mutable statuses never alter the frozen input of an already admitted cycle. */
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
								.update(canonicalJson(frozen.providerSettings))
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
	collectExecutionDispatch(tx,result.reference.dispatchId);
	return result.reference.dispatchId;
}

/** How many waiting posts a released slot wakes, and how many it looks through. */
const ACCOUNT_WAKE_COUNT = 2;
const ACCOUNT_WAKE_SCAN = 16;

/** One claim holds an account's slot, and a post that finds it taken waits on the
 * holder's lease or deadline. Wake the oldest posts able to run as the slot frees,
 * so a queue moves as fast as its work rather than its timers. Two, not all of
 * them: one wins the slot, and the other keeps the queue moving if the first
 * cannot claim. A lost wake only falls back to those timers, so this never has to
 * take a peer's lock. Call before the release clears `accountSlotKey`. */
export async function wakeNextAccountPosts(tx:Tx,claimId:string,now:Date,append:typeof appendPublicationDispatch=appendPublicationDispatch){
 const claim=await tx.publicationClaim.findUnique({where:{id:claimId},select:{accountSlotKey:true,attempt:{select:{socialPostId:true}}}});
 if(!claim?.accountSlotKey)return [];
 const epoch=await tx.executionEpoch.findUniqueOrThrow({where:{id:1}});
 const candidates=await tx.socialPost.findMany({
  where:{socialAccountId:claim.accountSlotKey,id:{not:claim.attempt.socialPostId},status:"scheduled",deploymentEpoch:epoch.epoch,
   // A paused grant stays scheduled and past due, and would hold the head of the queue forever.
   AND:[{OR:[{nextAttemptAt:{lte:now}},{nextAttemptAt:null,scheduledFor:{lte:now}}]},{OR:[{standingGrantId:null},{standingGrant:{status:{not:"paused"}}}]}]},
  orderBy:[{scheduledFor:"asc"},{createdAt:"asc"},{id:"asc"}],take:ACCOUNT_WAKE_SCAN,select:{id:true,nextAttemptAt:true,scheduledFor:true,createdAt:true}});
 const wakeKind=`pub_${createHash("sha256").update(claimId).digest("hex").slice(0,32)}`;
 const runnable=candidates.filter(post=>publicationReleaseAt(post)<=now).slice(0,ACCOUNT_WAKE_COUNT);
 return Promise.all(runnable.map(post=>append(tx,post.id,{dueAt:now,wakeKind})));
}

/** Repair an accepted identity only. Never creates a new admission or invents
 * a next wake from a stale request, even if the producer committed a newer cycle. */
export async function recoverPublicationDispatches(tx:Tx,postId:string,workspaceId?:string){
 const epoch=await tx.executionEpoch.findUniqueOrThrow({where:{id:1}});
 const post=await tx.socialPost.findFirst({where:{id:postId,...(workspaceId?{workspaceId}:{}),deploymentEpoch:epoch.epoch},include:scheduleInclude});
 if(!post)return [];
 const rows=await tx.executionDispatch.findMany({where:{deploymentEpoch:epoch.epoch,subjectKind:"social_publication",subjectId:post.id,generation:post.generation,inputHash:publicationExecutionInputHash(post),kind:{in:["operation_driver","modal_execution"]},acknowledgedAt:null,deadLetteredAt:null},orderBy:{id:"asc"},take:129,select:{id:true}});
 if(rows.length>128)throw Error("publication_dispatch_repair_bound");
 const prior=await tx.publicationClaim.findFirst({where:{deploymentEpoch:epoch.epoch,attempt:{socialPostId:post.id}},orderBy:{createdAt:"desc"},select:{workState:true}});
 const saved=(prior?.workState as {transitionDispatchIds?:unknown}|null)?.transitionDispatchIds;
 const ids=rows.map(row=>row.id);
 if(saved!==undefined){if(!Array.isArray(saved)||saved.length>128||saved.some(id=>typeof id!=="string"||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)))throw Error("publication_dispatch_repair_bound");ids.push(...saved);}
 const unique=[...new Set(ids)];if(unique.length>128)throw Error("publication_dispatch_repair_bound");
 for(const id of unique)collectExecutionDispatch(tx,id);
 return unique;
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
		const dueAt = publicationReleaseAt(post);
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

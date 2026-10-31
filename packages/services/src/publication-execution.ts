import {refreshPublicationExport,returnPublicationGrantPost} from "./publication-producers";
import { admitMediaCleanupObligations } from "./media-cleanup-admission";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	Prisma,
	type PrismaClient,
	type PublicationClaim,
	type SocialPublicationAttempt,
} from "@prisma/client";
import type {
	ExecutionDeadline,
	ExecutionDispatchReference,
} from "@narriflow/validators/execution";
import {
	linkedInInstructionBlobSchema,
	type LinkedInInstructionBlob,
	publicationNativeCommandSchema,
	type PublicationNativeCommand,
	type PublicationNativeReply,
} from "@narriflow/validators/publication-execution";
import { roleHasWorkspaceCapability } from "@narriflow/validators";
import type {
	ExecutorDomainControl,
	ExecutorDomainLock,
	ExecutorMutationContext,
	ExecutorMutationResult,
	ExecutorArtifactCommit,
	ExecutorExpiryObservation,
	ExecutorExpiryResult,
} from "./executor-domain-control";
import {
	appendExecutionDispatch,
	readExecutionDispatch,
} from "./execution-dispatch";
import {
	appendPublicationDispatch,
 recoverPublicationDispatches,
 samePublicationDispatch,
	publicationExecutionInputHash,
	type PublicationSchedule,
} from "./publication-dispatch";
import {
	lockPublicationPost,
	lockPublicationAttempt,
} from "./publication-locks";
import {
	createPrismaSocialPublicationAttemptStore,
	type LoadedPublicationAttempt,
	type OwnedPublicationAttempt,
	type PublicationAttemptExecutionResult,
	type PublicationRetryPolicy,
} from "./social-publication-attempt";
import { takeExecutionDispatchIds } from "./execution-dispatch-runtime";
import { emitSocialPostFinished } from "./social-post-finished";
import type { PublicationProviderOperation } from "./social-publication-platform";

type Tx = Prisma.TransactionClient;
const ended = ["succeeded", "failed", "needs_attention"];
const submitted = (row: SocialPublicationAttempt) =>
	["submission_started", "processing", "reconciling"].includes(row.phase);
const budgetDeadline = (row: SocialPublicationAttempt) =>
	row.phase === "reconciling"
		? row.reconciliationDeadline
		: row.processingDeadline;
const json = (value: unknown) => value as Prisma.InputJsonValue;
export interface PublicationSource {
	name: string;
	storageKey: string;
	etag: string;
	byteLength: number;
	sha256: string;
}
export interface PublicationInputPlan {
	storageKey: string;
	sha256: string;
	byteLength: number;
}
interface ClaimState {
	nonce: string;
	inputPlan?: PublicationInputPlan;
	sources?: PublicationSource[];
	providerGrant?: { operation: string; purpose: string };
	irreversibleGrants?: string[];
	instructionArtifactId?: string;
 transitionDispatchIds?:string[];
}
const state = (claim: PublicationClaim) =>
	claim.workState as unknown as ClaimState;
export interface PublicationInstructionArtifact extends ExecutorArtifactCommit {
	instructions: LinkedInInstructionBlob;
}
export interface PublicationExecutionRef {
	postId: string;
	attemptId: string;
	claimId: string;
}
export interface PublicationInputSnapshot {
	post: PublicationSchedule;
	attempt: SocialPublicationAttempt;
	claim: PublicationClaim;
	loaded: LoadedPublicationAttempt;
}
export interface PublicationExecutionDependencies {
	config: {
		operationDeadlineMs: number;
		providerCallBudget: number;
		processingDeadlineMs: number;
		reconciliationDeadlineMs: number;
		retry: PublicationRetryPolicy;
	};
	checkpointCipher: {
		seal(value: Prisma.JsonObject): string;
		open(value: string): Prisma.JsonObject;
	};
	planRefusal(tx: Tx, post: PublicationSchedule): Promise<string | null>;
	buildInput(
		snapshot: PublicationInputSnapshot,
	): Promise<{ bytes: Uint8Array; sources: PublicationSource[] }>;
	inputStorage: {
		put(plan: PublicationInputPlan, bytes: Uint8Array): Promise<void>;
		head(
			plan: PublicationInputPlan,
		): Promise<{ etag: string; sha256: string; byteLength: number } | null>;
	};
	register(ids: readonly string[]): Promise<void>;
}
export type PublicationPreparation =
	| { kind: "terminal" | "superseded" | "waiting_export" | "waiting_grant" }
 | {kind:"dependency_wait";dueAt:Date;deadlineDispatchId:string;dispatchIds:string[]}
	| { kind: "sleep"; dueAt: Date }
	| {
			kind: "waiting";
			deadline: ExecutionDeadline;
			deliveryId: string;
			dispatchIds: string[];
	  };
export class PublicationExecutionError extends Error {
	constructor(readonly code: string) {
		super(code);
		this.name = "PublicationExecutionError";
	}
}
const clock = async (tx: Tx) =>
	(
		await tx.$queryRaw<
			Array<{ now: Date }>
		>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"`
	)[0]!.now;

/** One existing Social Publication Attempt retains provider identity across
 * physical cycles. Each claim has fresh generic ownership and a fixed deadline. */
export class PublicationExecution
	implements
		ExecutorDomainControl<
			PublicationExecutionRef,
			PublicationInstructionArtifact
		>
{
	constructor(
		private readonly database: PrismaClient,
		private readonly ports: PublicationExecutionDependencies,
	) {}
	private async epoch(tx: Tx) {
		const [row] = await tx.$queryRaw<
			Array<{ epoch: number }>
		>`SELECT "epoch" FROM "ExecutionEpoch" WHERE "id"=1 FOR SHARE`;
		if (!row)
			throw new PublicationExecutionError("publication_epoch_unavailable");
		return row.epoch;
	}
	private async post(tx: Pick<Tx, "socialPost">, id: string) {
		return tx.socialPost.findUnique({
			where: { id },
			include: { frozenState: true },
		});
	}
	private async actor(
		tx: Tx,
		post: PublicationSchedule,
		alreadySubmitted: boolean,
		actorUserId: string | null,
	) {
		if (!post.workspaceId || !actorUserId)
			throw new PublicationExecutionError("publication_actor_unavailable");
		const member = await tx.workspaceMember.findUnique({
			where: {
				workspaceId_userId: {
					workspaceId: post.workspaceId,
					userId: actorUserId,
				},
			},
			include: {
				user: { select: { deletedAt: true } },
				workspace: { select: { status: true } },
			},
		});
		if (
			!member ||
			member.user.deletedAt ||
			!roleHasWorkspaceCapability(member.role, "publishing.manage")
		)
			throw new PublicationExecutionError("publication_actor_revoked");
		if (!alreadySubmitted && member.workspace.status !== "active")
			throw new PublicationExecutionError("publication_workspace_restricted");
		const project = await tx.project.findUnique({
				where: { id: post.projectId },
				select: { purgeStartedAt: true, expiresAt: true },
			}),
			now = await clock(tx);
		if (
			!project ||
			project.purgeStartedAt !== null ||
			(project.expiresAt && project.expiresAt <= now)
		)
			throw new PublicationExecutionError("publication_project_unavailable");
		if (post.socialAccountId) {
			const account = await tx.socialAccount.findUnique({
				where: { id: post.socialAccountId },
				select: { workspaceId: true, status: true, platform: true },
			});
			if (
				!account ||
				account.workspaceId !== post.workspaceId ||
				account.status !== "active" ||
				account.platform !== post.platform
			)
				throw new PublicationExecutionError(
					"social_account_reconnect_required",
				);
		}
		if (!alreadySubmitted) {
			const refusal = await this.ports.planRefusal(tx, post);
			if (refusal) throw new PublicationExecutionError(refusal);
		}
	}
	private async grant(tx: Tx, post: PublicationSchedule) {
		if (!post.standingGrantId) return "allowed" as const;
		await tx.$queryRaw`SELECT "id" FROM "StandingGrant" WHERE "id"=${post.standingGrantId}::uuid FOR SHARE`;
		const row = await tx.standingGrant.findUnique({
				where: { id: post.standingGrantId },
			}),
			now = await clock(tx);
		if (
			!row ||
			row.revision !== post.standingGrantRevision ||
			row.status === "revoked" ||
			row.expiresAt <= now
		)
			throw new PublicationExecutionError("publication_grant_changed");
		return row.status === "paused"
			? ("waiting" as const)
			: ("allowed" as const);
	}
	private async wake(tx: Tx, postId: string, dueAt: Date, wakeKind?: string) {
		return [
			await appendPublicationDispatch(tx, postId, {
				dueAt,
				...(wakeKind ? { wakeKind } : {}),
			}),
		];
	}
	private async advance(tx: Tx, postId: string, dueAt: Date) {
		await tx.socialPost.update({
			where: { id: postId },
			data: { generation: { increment: 1 } },
		});
		return this.wake(tx, postId, dueAt);
	}
	private async release(tx: Tx, ref: PublicationExecutionRef, now: Date) {
		await tx.publicationClaim.update({
			where: { id: ref.claimId },
			data: { releasedAt: now, accountSlotKey: null },
		});
		await tx.socialPublicationAttempt.updateMany({
			where: { id: ref.attemptId, currentClaimId: ref.claimId },
			data: { currentClaimId: null },
		});
	}
 private async rememberTransition(tx:Tx,ref:PublicationExecutionRef,result:{dispatchIds:string[]}){
  if(result.dispatchIds.length>128)throw new PublicationExecutionError("publication_dispatch_repair_bound");
  const claim=await tx.publicationClaim.findUniqueOrThrow({where:{id:ref.claimId}});
  await tx.publicationClaim.update({where:{id:claim.id},data:{workState:json({...state(claim),transitionDispatchIds:[...new Set(result.dispatchIds)]})}});
  return result;
 }
	private async stop(
		tx: Tx,
		ref: PublicationExecutionRef,
		code: string,
		uncertain: boolean,
	) {
		const now = await clock(tx);
		await tx.socialPublicationAttempt.update({
			where: { id: ref.attemptId },
			data: {
				phase: uncertain ? "needs_attention" : "failed",
				outcome: uncertain ? "unknown" : "failed",
				failureCode: code,
				failureDisposition: uncertain ? "attention" : "permanent",
				terminalAt: now,
			},
		});
		await tx.socialPost.update({
			where: { id: ref.postId },
			data: {
				status: uncertain ? "needs_attention" : "failed",
				errorCode: code,
				errorDisposition: uncertain ? "attention" : "permanent",
				nextAttemptAt: null,
			},
		});
		await this.release(tx, ref, now);
		await emitSocialPostFinished(tx, {
			socialPostId: ref.postId,
			attemptId: ref.attemptId,
		});
		return this.rememberTransition(tx,ref,{
			dispatchIds: [
				...(await this.wake(tx, ref.postId, now, "publication_terminal")),
				...takeExecutionDispatchIds(tx),
			],
		});
	}
 private async uncertain(tx:Tx,ref:PublicationExecutionRef,code:string){
  return this.rememberTransition(tx,ref,await this.uncertainResult(tx,ref,code));
 }
 private async uncertainResult(tx: Tx, ref: PublicationExecutionRef, code: string) {
		const attempt = await tx.socialPublicationAttempt.findUniqueOrThrow({
				where: { id: ref.attemptId },
			}),
			claim = await tx.publicationClaim.findUniqueOrThrow({
				where: { id: ref.claimId },
			}),
			now = await clock(tx);
		if (
			attempt.nativeStartCount >= attempt.nativeStartCeiling ||
			budgetDeadline(attempt) <= now
		)
			return this.stop(
				tx,
				ref,
				code,
				submitted(attempt) || Boolean(state(claim).providerGrant),
			);
		if (!attempt.operationKind || !attempt.checkpointEncrypted) {
			if (state(claim).providerGrant) return this.stop(tx, ref, code, true);
			await this.release(tx, ref, now);
			const due = new Date(now.getTime() + 5000);
			await tx.socialPost.update({
				where: { id: ref.postId },
				data: { nextAttemptAt: due },
			});
			await tx.socialPublicationAttempt.update({
				where: { id: ref.attemptId },
				data: { nextActionAt: due },
			});
			return { dispatchIds: await this.advance(tx, ref.postId, due) };
		}
		// Retain the original provider operation. Upload preparation resumes the
		// same resource; possible public acceptance uses reconciliation only.
		await tx.socialPublicationAttempt.update({
			where: { id: ref.attemptId },
			data: {
				phase: submitted(attempt) ? "reconciling" : "uploading",
				outcome: "unknown",
				failureCode: code,
				nextActionAt: new Date(now.getTime() + 30000),
			},
		});
		await tx.socialPost.update({
			where: { id: ref.postId },
			data: {
				status: submitted(attempt) ? "reconciling" : "processing",
				nextAttemptAt: new Date(now.getTime() + 30000),
			},
		});
		await this.release(tx, ref, now);
		return {
			dispatchIds: await this.advance(
				tx,
				ref.postId,
				new Date(now.getTime() + 30000),
			),
		};
	}
	private async expireAccountSlot(reference: ExecutionDispatchReference) {
		const ledger = (
			await readExecutionDispatch(this.database, reference.dispatchId)
		)?.reference;
		if (
			!ledger ||
			!samePublicationDispatch(ledger,reference) ||
   ledger.subject.kind!=="social_publication"
		)
			return;
		const post = await this.post(this.database, reference.subject.id);
		if (
			!post?.socialAccountId ||
			publicationExecutionInputHash(post) !== reference.inputHash
		)
			return;
		const other = await this.database.publicationClaim.findUnique({
			where: { accountSlotKey: post.socialAccountId },
		});
		if (!other) return;
		const dispatchIds = await this.database.$transaction(async (tx) => {
			const epoch = await this.epoch(tx);
			if (epoch !== reference.deploymentEpoch) return [];
			const otherPostId = await lockPublicationAttempt(tx, other.attemptId);
			if (!otherPostId) return [];
			await tx.$queryRaw`SELECT "id" FROM "PublicationClaim" WHERE "id"=${other.id}::uuid FOR UPDATE`;
			const row = await tx.publicationClaim.findUniqueOrThrow({
					where: { id: other.id },
				}),
				now = await clock(tx);
			if (
				row.releasedAt ||
				row.leaseExpiresAt > now ||
				row.accountSlotKey !== post.socialAccountId
			)
				return [];
			const result = await this.uncertain(
				tx,
				{ postId: otherPostId, attemptId: row.attemptId, claimId: row.id },
				"publication_native_expired",
			);
			await tx.executionAttempt.updateMany({
				where: {
					attemptToken: row.id,
					status: { in: ["queued", "owned", "running"] },
				},
				data: { status: "expired", finishedAt: now },
			});
			return result.dispatchIds;
		});
		await this.ports.register(dispatchIds);
	}
	async prepareExecution(
		reference: ExecutionDispatchReference,
	): Promise<PublicationPreparation> {
  // Registration is outside SQL. An exact old delivery can repair the already
  // committed next cycle before its ordinary stale-generation return.
  const repaired=await this.database.$transaction(async tx=>{
   if(reference.kind!=="operation_driver"||reference.subject.kind!=="social_publication"||(await this.epoch(tx))!==reference.deploymentEpoch)return [];
   const ledger=(await readExecutionDispatch(tx,reference.dispatchId))?.reference;
   if(!ledger||!samePublicationDispatch(ledger,reference))return [];
   await lockPublicationPost(tx,reference.subject.id);
   const ids=await recoverPublicationDispatches(tx,reference.subject.id);
   const claim=await tx.publicationClaim.findFirst({where:{deploymentEpoch:reference.deploymentEpoch,generation:reference.generation,attempt:{socialPostId:reference.subject.id}},orderBy:{createdAt:"desc"}});
   const transitions=claim?state(claim)?.transitionDispatchIds:undefined;
   if(transitions){
    if(!Array.isArray(transitions)||transitions.length>128||transitions.some(id=>typeof id!=="string"||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)))throw new PublicationExecutionError("publication_dispatch_repair_bound");
    ids.push(...transitions);
   }
   return [...new Set(ids)];
  });
  if(repaired.length)await this.ports.register(repaired);
		await this.expireAccountSlot(reference);
		const snapshot = await this.database.$transaction(async (tx) => {
			const epoch = await this.epoch(tx),
				ledger = (await readExecutionDispatch(tx, reference.dispatchId))
					?.reference;
			if (
				reference.subject.kind !== "social_publication" ||
				reference.kind !== "operation_driver" ||
				epoch !== reference.deploymentEpoch ||
				!ledger ||
				!samePublicationDispatch(ledger,reference)
			)
				return { kind: "superseded" as const };
			await lockPublicationPost(tx, reference.subject.id);
   let post=await this.post(tx,reference.subject.id);const now=await clock(tx);
			if (
				!post ||
				post.generation !== reference.generation ||
				post.deploymentEpoch !== epoch ||
				publicationExecutionInputHash(post) !== reference.inputHash
			)
				return { kind: "superseded" as const };
			if (
				[
					"draft",
					"cancelled",
					"failed",
					"needs_attention",
					"posted",
					"inbox_delivered",
				].includes(post.status)
			)
				return { kind: "terminal" as const };
			const due = post.nextAttemptAt ?? post.scheduledFor ?? post.createdAt;
			if (due > now) return { kind: "sleep" as const, dueAt: due };
   const exportState=await refreshPublicationExport(tx,post);
   if(exportState==="waiting")return {kind:"waiting_export" as const};
   if(exportState==="terminal")return {kind:"terminal" as const,dispatchIds:takeExecutionDispatchIds(tx)};
   post=(await this.post(tx,post.id))!;
   if(!post.frozenState)throw new PublicationExecutionError("publication_frozen_media_unsealed");
			let attempt = await tx.socialPublicationAttempt.findFirst({
				where: { socialPostId: post.id },
				orderBy: { attemptNumber: "desc" },
			});
			const sent = attempt ? submitted(attempt) : false;
			const settings = post.frozenState
				.providerSettings as Prisma.JsonObject | null;
			const actorUserId = attempt
				? attempt.executionActorUserId
				: typeof settings?.confirmedBy === "string"
					? settings.confirmedBy
					: null;
			try {
    await this.actor(tx,post,sent,actorUserId);
    if(!sent&&(await this.grant(tx,post))==="waiting")return {kind:"waiting_grant" as const};
   } catch(error){
				const code =
					error instanceof PublicationExecutionError
						? error.code
						: "publication_authority_revoked";
    if(code==="publication_grant_changed"&&!attempt&&post.standingGrantId){
     const grant=await tx.standingGrant.findUnique({where:{id:post.standingGrantId}});
     if(grant&&await returnPublicationGrantPost(tx,post,grant))return {kind:"terminal" as const,dispatchIds:await this.wake(tx,post.id,new Date(0),"publication_grant_returned")};
    }
				if (attempt?.currentClaimId) {
					const result = await this.stop(
						tx,
						{
							postId: post.id,
							attemptId: attempt.id,
							claimId: attempt.currentClaimId,
						},
						code,
						sent,
					);
					return { kind: "terminal" as const, dispatchIds: result.dispatchIds };
				}
				if (attempt)
					await tx.socialPublicationAttempt.update({
						where: { id: attempt.id },
						data: {
							phase: sent ? "needs_attention" : "failed",
							outcome: sent ? "unknown" : "failed",
							failureCode: code,
							failureDisposition: sent ? "attention" : "permanent",
							terminalAt: now,
						},
					});
				await tx.socialPost.update({
					where: { id: post.id },
					data: {
						status: sent ? "needs_attention" : "failed",
						errorCode: code,
						nextAttemptAt: null,
					},
				});
				await emitSocialPostFinished(tx, {
					socialPostId: post.id,
					attemptId: attempt?.id,
				});
				return {
					kind: "terminal" as const,
					dispatchIds: [
						...(await this.wake(tx, post.id, now, "publication_terminal")),
						...takeExecutionDispatchIds(tx),
					],
				};
			}
			if (!attempt)
				attempt = await tx.socialPublicationAttempt.create({
					data: {
						socialPostId: post.id,
						frozenStateId: post.frozenState.id,
						attemptNumber: 1,
						executionActorUserId: actorUserId,
						idempotencyKey: `publication:${post.id}:1`,
						phase: "retry_scheduled",
						nextActionAt: now,
						processingDeadline: new Date(
							now.getTime() + this.ports.config.processingDeadlineMs,
						),
						reconciliationDeadline: new Date(
							now.getTime() + this.ports.config.reconciliationDeadlineMs,
						),
						providerCallCeiling: this.ports.config.providerCallBudget,
						nativeStartCeiling:
							this.ports.config.providerCallBudget +
							this.ports.config.retry.maxAttempts,
					},
				});
			if (ended.includes(attempt.phase)) return { kind: "terminal" as const };
			await lockPublicationAttempt(tx, attempt.id);
			if (attempt.nextActionAt > now)
				return { kind: "sleep" as const, dueAt: attempt.nextActionAt };
			if (attempt.currentClaimId) {
				const claim = await tx.publicationClaim.findUniqueOrThrow({
					where: { id: attempt.currentClaimId },
				});
				if (
					claim.deploymentEpoch !== epoch ||
					claim.generation !== post.generation
				)
					return { kind: "superseded" as const };
				const ref = {
					postId: post.id,
					attemptId: attempt.id,
					claimId: claim.id,
				};
				if (claim.releasedAt || claim.leaseExpiresAt <= now) {
					const result = await this.uncertain(
						tx,
						ref,
						"publication_execution_expired",
					);
					return { kind: "terminal" as const, dispatchIds: result.dispatchIds };
				}
				const existing = await tx.executionAttempt.findUnique({
					where: { attemptToken: claim.id },
				});
				if (existing?.inputEtag)
					return { kind: "existing" as const, post, attempt, claim, existing };
				return {
					kind: "stage" as const,
					post,
					attempt,
					claim,
					loaded: await createPrismaSocialPublicationAttemptStore(
						() => tx,
					).loadOwned({ attemptId: attempt.id, claimId: claim.id }, now),
				};
			}
			if (
				attempt.nativeStartCount >= attempt.nativeStartCeiling ||
				attempt.providerCallCount >= attempt.providerCallCeiling ||
				budgetDeadline(attempt) <= now
			) {
				await tx.socialPublicationAttempt.update({
					where: { id: attempt.id },
					data: {
						phase: sent ? "needs_attention" : "failed",
						outcome: sent ? "unknown" : "failed",
						failureCode: "publication_execution_budget_exhausted",
						failureDisposition: sent ? "attention" : "permanent",
						terminalAt: now,
					},
				});
				await tx.socialPost.update({
					where: { id: post.id },
					data: {
						status: sent ? "needs_attention" : "failed",
						errorCode: "publication_execution_budget_exhausted",
						nextAttemptAt: null,
					},
				});
				await emitSocialPostFinished(tx, {
					socialPostId: post.id,
					attemptId: attempt.id,
				});
				return {
					kind: "terminal" as const,
					dispatchIds: [
						...(await this.wake(tx, post.id, now, "publication_terminal")),
						...takeExecutionDispatchIds(tx),
					],
				};
			}
			const accountSlotKey = sent ? null : post.socialAccountId;
			if (accountSlotKey) {
				const other = await tx.publicationClaim.findUnique({
					where: { accountSlotKey },
				});
    if(other){
     // Never take another Post lock while this Post is locked. Its independent
     // deadline continuation owns expiry, and this Post has its own fixed wake.
     const execution=await tx.executionAttempt.findUnique({where:{attemptToken:other.id}});
     let watch:Awaited<ReturnType<typeof readExecutionDispatch>>;
     if(execution){
      const modal=await readExecutionDispatch(tx,execution.dispatchId);
      if(!modal||modal.reference.subject.kind!=="social_publication"||modal.reference.deploymentEpoch!==epoch)throw new PublicationExecutionError("publication_account_slot_invalid");
      const until=other.executorOwner?other.leaseExpiresAt:other.operationDeadlineAt!;
      watch=await appendExecutionDispatch(tx,{...modal.reference,subject:modal.reference.subject,kind:"operation_driver",dueAt:until,deadlineKind:other.executorOwner?"lease":"operation",observedDeadlineAt:until});
     }else{
      const peer=await tx.socialPublicationAttempt.findUniqueOrThrow({where:{id:other.attemptId},select:{socialPostId:true}});
      const timer=await tx.executionDispatch.findFirst({where:{subjectKind:"social_publication",subjectId:peer.socialPostId,generation:other.generation,deploymentEpoch:epoch,wakeKind:"publication_preparation_deadline"},select:{id:true}});
      watch=timer?await readExecutionDispatch(tx,timer.id):null;
     }
     if(!watch)throw new PublicationExecutionError("publication_account_slot_invalid");
     const wakeKind=`pub_${createHash("sha256").update(JSON.stringify([other.id,watch.dueAt.toISOString()])).digest("hex").slice(0,32)}`;
     const resume=await appendPublicationDispatch(tx,post.id,{dueAt:watch.dueAt,wakeKind});
     return {kind:"dependency_wait" as const,dueAt:watch.dueAt,deadlineDispatchId:watch.reference.dispatchId,dispatchIds:[watch.reference.dispatchId,resume]};
    }
			}
			const until = new Date(
				Math.min(
					now.getTime() + this.ports.config.operationDeadlineMs,
					budgetDeadline(attempt).getTime(),
				),
			);
			const claim = await tx.publicationClaim.create({
				data: {
					id: randomUUID(),
					attemptId: attempt.id,
					claimantId: "native:publication",
					accountSlotKey,
					leaseExpiresAt: until,
					heartbeatAt: now,
					operationDeadlineAt: until,
					deploymentEpoch: epoch,
					generation: post.generation,
					executionMode: sent
						? "reconcile"
						: attempt.operationKind
							? "resume"
							: "publish",
					workState: json({ nonce: randomBytes(12).toString("base64url") }),
				},
			});
			attempt = await tx.socialPublicationAttempt.update({
				where: { id: attempt.id },
				data: {
					currentClaimId: claim.id,
					phase:
						attempt.phase === "retry_scheduled" ? "claimed" : attempt.phase,
				},
			});
			await tx.socialPost.update({
				where: { id: post.id },
				data: {
					status:
						attempt.phase === "reconciling"
							? "reconciling"
							: attempt.phase === "processing" || attempt.phase === "uploading"
								? "processing"
								: "publishing",
				},
			});
			const loaded = await createPrismaSocialPublicationAttemptStore(
				() => tx,
			).loadOwned({ attemptId: attempt.id, claimId: claim.id }, now);
			const preparationWake = await appendPublicationDispatch(tx, post.id, {
				dueAt: until,
				wakeKind: "publication_preparation_deadline",
			});
			return {
				kind: "stage" as const,
				post,
				attempt,
				claim,
				loaded,
				dispatchIds: [preparationWake],
			};
		});
		if (snapshot.kind !== "stage" && snapshot.kind !== "existing") {
			if ("dispatchIds" in snapshot)
				await this.ports.register(snapshot.dispatchIds ?? []);
			return snapshot;
		}
		if (snapshot.kind === "existing")
			return this.waiting(
				snapshot.post,
				snapshot.claim,
				snapshot.existing.dispatchId,
			);
		if ("dispatchIds" in snapshot)
			await this.ports.register(snapshot.dispatchIds ?? []);
		let built: Awaited<
			ReturnType<PublicationExecutionDependencies["buildInput"]>
		>;
		try {
			built = await this.ports.buildInput(snapshot);
		} catch (error) {
			if (
				!(error instanceof PublicationExecutionError) ||
				![
					"publication_frozen_media_unsealed",
					"publication_thumbnail_unsealed",
					"publication_checkpoint_invalid",
					"publication_input_invalid",
				].includes(error.code)
			)
				throw error;
			const failed = await this.database.$transaction(async (tx) => {
				if ((await this.epoch(tx)) !== snapshot.post.deploymentEpoch)
					throw new PublicationExecutionError("publication_epoch_superseded");
				await lockPublicationAttempt(tx, snapshot.attempt.id);
				const attempt = await tx.socialPublicationAttempt.findUniqueOrThrow({
					where: { id: snapshot.attempt.id },
				});
				if (attempt.currentClaimId !== snapshot.claim.id)
					return { dispatchIds: [] };
				return this.stop(
					tx,
					{
						postId: snapshot.post.id,
						attemptId: attempt.id,
						claimId: snapshot.claim.id,
					},
					error.code,
					submitted(attempt) || Boolean(state(snapshot.claim).providerGrant),
				);
			});
			await this.ports.register(failed.dispatchIds);
			return { kind: "terminal" };
		}
		const plan: PublicationInputPlan = {
			storageKey: `execution-inputs/${snapshot.post.deploymentEpoch}/publication/${snapshot.post.id}/${snapshot.post.generation}/${snapshot.claim.id}.json`,
			sha256: createHash("sha256").update(built.bytes).digest("hex"),
			byteLength: built.bytes.byteLength,
		};
		if (
			!plan.byteLength ||
			plan.byteLength > 16 * 1024 * 1024 ||
			built.sources.length > 3 ||
			built.sources.some(
				(source) =>
					!source.name ||
					!/^[-a-z0-9_]{1,64}$/.test(source.name) ||
					!/^execution\/[A-Za-z0-9/_.-]{1,1000}$/.test(source.storageKey) ||
					!Number.isSafeInteger(source.byteLength) ||
					source.byteLength < 1 ||
					source.byteLength > 10 * 1024 ** 3 ||
					!/^"[\x21\x23-\x7e]{1,158}"$/.test(source.etag) ||
					!/^[a-f0-9]{64}$/.test(source.sha256),
			)
		)
			throw new PublicationExecutionError("publication_input_invalid");
		await this.database.$transaction(async (tx) => {
			if ((await this.epoch(tx)) !== snapshot.post.deploymentEpoch)
				throw new PublicationExecutionError("publication_epoch_superseded");
			await lockPublicationAttempt(tx, snapshot.attempt.id);
			const claim = await tx.publicationClaim.findUniqueOrThrow({
					where: { id: snapshot.claim.id },
				}),
				post = await this.post(tx, snapshot.post.id);
			if (
				!post ||
				post.generation !== snapshot.post.generation ||
				claim.releasedAt ||
				claim.executorOwner
			)
				throw new PublicationExecutionError("publication_claim_lost");
			const prior = state(claim).inputPlan;
			if (
				prior &&
				(prior.sha256 !== plan.sha256 ||
					prior.byteLength !== plan.byteLength ||
					prior.storageKey !== plan.storageKey)
			)
				throw new PublicationExecutionError("publication_input_changed");
			await tx.publicationClaim.update({
				where: { id: claim.id },
				data: {
					workState: json({
						...state(claim),
						inputPlan: plan,
						sources: built.sources,
					}),
				},
			});
      await admitMediaCleanupObligations(tx, [{ origin: "publication_execution", cleanupClass: "publication_private", projectId: post.projectId,
        clipId: post.clipId, objectKey: plan.storageKey, notBefore: claim.operationDeadlineAt! }]);
		});
		let head = await this.ports.inputStorage.head(plan);
		if (!head) {
			try {
				await this.ports.inputStorage.put(plan, built.bytes);
			} catch {
				/* Exact HEAD reconciles only this planned immutable key. */
			}
			head = await this.ports.inputStorage.head(plan);
		}
		if (
			!head ||
			head.byteLength !== plan.byteLength ||
			head.sha256 !== plan.sha256 ||
			!/^[\x21-\x7e]{1,160}$/.test(head.etag)
		)
			throw new PublicationExecutionError("publication_input_unavailable");
		const sealed = head;
		const dispatchId = await this.database.$transaction(async (tx) => {
			if ((await this.epoch(tx)) !== snapshot.post.deploymentEpoch)
				throw new PublicationExecutionError("publication_epoch_superseded");
			await lockPublicationAttempt(tx, snapshot.attempt.id);
			const post = await this.post(tx, snapshot.post.id),
				claim = await tx.publicationClaim.findUniqueOrThrow({
					where: { id: snapshot.claim.id },
				}),
				now = await clock(tx);
			if (
				!post ||
				post.generation !== reference.generation ||
				post.deploymentEpoch !== reference.deploymentEpoch ||
				claim.releasedAt ||
				claim.leaseExpiresAt <= now
			)
				throw new PublicationExecutionError("publication_claim_lost");
			const freshAttempt = await tx.socialPublicationAttempt.findUniqueOrThrow({
				where: { id: snapshot.attempt.id },
			});
			try {
				await this.actor(
					tx,
					post,
					submitted(freshAttempt),
					freshAttempt.executionActorUserId,
				);
				if (
					!submitted(freshAttempt) &&
					(await this.grant(tx, post)) === "waiting"
				) {
					await this.release(
						tx,
						{ postId: post.id, attemptId: freshAttempt.id, claimId: claim.id },
						now,
					);
					await tx.socialPost.update({
						where: { id: post.id },
						data: {
							status: "scheduled",
							generation: { increment: 1 },
							nextAttemptAt: null,
						},
					});
					return { kind: "waiting_grant" as const, dispatchIds: [] };
				}
			} catch (error) {
				return {
					kind: "terminal" as const,
					...(await this.stop(
						tx,
						{ postId: post.id, attemptId: freshAttempt.id, claimId: claim.id },
						error instanceof PublicationExecutionError
							? error.code
							: "publication_authority_revoked",
						submitted(freshAttempt),
					)),
				};
			}
			const d = await appendExecutionDispatch(tx, {
				deploymentEpoch: post.deploymentEpoch,
				generation: post.generation,
				kind: "modal_execution",
				subject: { kind: "social_publication", id: post.id },
				inputHash: reference.inputHash,
				dueAt: snapshot.claim.createdAt,
			});
			const created = await tx.executionAttempt.upsert({
				where: { attemptToken: claim.id },
				create: {
					attemptToken: claim.id,
					dispatchId: d.reference.dispatchId,
					deploymentEpoch: post.deploymentEpoch,
					generation: post.generation,
					inputHash: reference.inputHash,
					functionName: "publication",
					operationDeadlineAt: claim.operationDeadlineAt!,
					inputStorageKey: plan.storageKey,
					inputEtag: sealed.etag,
					inputByteLength: BigInt(plan.byteLength),
					inputChecksumSha256: plan.sha256,
				},
				update: {},
			});
			if (
				created.dispatchId !== d.reference.dispatchId ||
				created.inputStorageKey !== plan.storageKey ||
				created.inputEtag !== sealed.etag ||
				created.inputByteLength !== BigInt(plan.byteLength) ||
				created.inputChecksumSha256 !== plan.sha256 ||
				created.operationDeadlineAt.getTime() !==
					claim.operationDeadlineAt!.getTime()
			)
				throw new PublicationExecutionError("publication_input_changed");
			return d.reference.dispatchId;
		});
		if (typeof dispatchId !== "string") {
			await this.ports.register(dispatchId.dispatchIds);
			return { kind: dispatchId.kind };
		}
		return this.waiting(snapshot.post, snapshot.claim, dispatchId);
	}
	/** Frozen primitive snapshot only; called after generic authorization and
	 * checked again by transfer before any fresh grant leaves the Worker. */
	async workSnapshot(
		reference: ExecutionDispatchReference,
		attemptToken: string,
	) {
		return this.database.$transaction(async (tx) => {
			const epoch = await this.epoch(tx);
			await lockPublicationPost(tx, reference.subject.id);
			const post = await this.post(tx, reference.subject.id),
				claim = await tx.publicationClaim.findUnique({
					where: { id: attemptToken },
					include: { attempt: true },
				}),
				now = await clock(tx);
			if (
				!post ||
				!claim ||
				reference.subject.kind !== "social_publication" ||
				reference.kind !== "modal_execution" ||
				epoch !== reference.deploymentEpoch ||
				post.deploymentEpoch !== epoch ||
				post.generation !== reference.generation ||
				claim.generation !== post.generation ||
				claim.deploymentEpoch !== epoch ||
				claim.attempt.socialPostId !== post.id ||
				claim.attempt.currentClaimId !== claim.id ||
				claim.releasedAt ||
				claim.leaseExpiresAt <= now ||
				!claim.operationDeadlineAt ||
				claim.operationDeadlineAt <= now ||
				publicationExecutionInputHash(post) !== reference.inputHash
			)
				throw new PublicationExecutionError("publication_claim_lost");
			await lockPublicationAttempt(tx, claim.attemptId);
			const plan = state(claim);
			if (!plan.inputPlan || !plan.sources)
				throw new PublicationExecutionError("publication_input_unavailable");
			const execution = await tx.executionAttempt.findUniqueOrThrow({
				where: { attemptToken: claim.id },
			});
			if (
				execution.inputStorageKey !== plan.inputPlan.storageKey ||
				execution.inputByteLength !== BigInt(plan.inputPlan.byteLength) ||
				execution.inputChecksumSha256 !== plan.inputPlan.sha256 ||
				!execution.inputEtag
			)
				throw new PublicationExecutionError("publication_input_changed");
			const loaded = await createPrismaSocialPublicationAttemptStore(
				() => tx,
			).loadOwned({ attemptId: claim.attemptId, claimId: claim.id }, now);
			return {
				post,
				attempt: claim.attempt,
				claim,
				loaded,
				sources: plan.sources,
				inputPlan: plan.inputPlan,
			};
		});
	}

	private async waiting(
		post: PublicationSchedule,
		claim: PublicationClaim,
		dispatchId: string,
	): Promise<PublicationPreparation> {
		const modal = (await readExecutionDispatch(this.database, dispatchId))!
				.reference,
			until = claim.executorOwner
				? claim.leaseExpiresAt
				: claim.operationDeadlineAt!,
			kind = claim.executorOwner ? ("lease" as const) : ("operation" as const);
		const watch = await this.database.$transaction((tx) =>
			appendExecutionDispatch(tx, {
				deploymentEpoch: post.deploymentEpoch,
				generation: post.generation,
				kind: "operation_driver",
				subject: { kind: "social_publication", id: post.id },
				inputHash: modal.inputHash,
				dueAt: until,
				deadlineKind: kind,
				observedDeadlineAt: until,
			}),
		);
		const dispatchIds = [dispatchId, watch.reference.dispatchId];
		await this.ports.register(dispatchIds);
		return {
			kind: "waiting",
			deadline: {
				reference: modal,
				attemptToken: claim.id,
				kind,
				observedDeadlineAt: until.toISOString(),
			},
			deliveryId: watch.reference.dispatchId,
			dispatchIds,
		};
	}
	async lockExecution(
		tx: Tx,
		reference: ExecutionDispatchReference,
		token: string,
	): Promise<ExecutorDomainLock<PublicationExecutionRef>> {
		await lockPublicationPost(tx, reference.subject.id);
		const post = await this.post(tx, reference.subject.id),
			claim = await tx.publicationClaim.findUnique({
				where: { id: token },
				include: { attempt: true },
			});
		if (
			!post ||
			!claim ||
			reference.kind !== "modal_execution" ||
			reference.subject.kind !== "social_publication" ||
			post.generation !== reference.generation ||
			post.deploymentEpoch !== reference.deploymentEpoch ||
			claim.generation !== post.generation ||
			claim.deploymentEpoch !== post.deploymentEpoch ||
			claim.attempt.socialPostId !== post.id ||
			publicationExecutionInputHash(post) !== reference.inputHash
		)
			return { kind: "terminal", disposition: { disposition: "superseded" } };
		await lockPublicationAttempt(tx, claim.attemptId);
		await tx.$queryRaw`SELECT "id" FROM "PublicationClaim" WHERE "id"=${token}::uuid FOR UPDATE`;
		if (post.status === "posted" || post.status === "inbox_delivered")
			return { kind: "terminal", disposition: { disposition: "completed" } };
		if (post.status === "cancelled")
			return { kind: "terminal", disposition: { disposition: "cancelled" } };
		if (
			ended.includes(claim.attempt.phase) ||
			claim.releasedAt ||
			claim.attempt.currentClaimId !== token
		)
			return {
				kind: "terminal",
				disposition: {
					disposition: "failed",
					failureCode: claim.attempt.failureCode ?? "publication_claim_lost",
				},
			};
		const ref = {
			postId: post.id,
			attemptId: claim.attemptId,
			claimId: claim.id,
		};
		try {
			await this.actor(
				tx,
				post,
				submitted(claim.attempt),
				claim.attempt.executionActorUserId,
			);
			if (
				!submitted(claim.attempt) &&
				(await this.grant(tx, post)) === "waiting"
			)
				throw new PublicationExecutionError("publication_grant_paused");
		} catch (error) {
			const result = await this.stop(
				tx,
				ref,
				error instanceof PublicationExecutionError
					? error.code
					: "publication_authority_revoked",
				submitted(claim.attempt) || Boolean(state(claim).providerGrant),
			);
			return {
				kind: "terminal",
				disposition: {
					disposition: "failed",
					failureCode: "publication_authority_revoked",
				},
				dispatchIds: result.dispatchIds,
			};
		}
		return { kind: "current", ref };
	}
	private async owned(
		tx: Tx,
		ref: PublicationExecutionRef,
		c: ExecutorMutationContext,
	) {
		const claim = await tx.publicationClaim.findUniqueOrThrow({
			where: { id: ref.claimId },
		});
		if (
			claim.executorOwner !== c.owner ||
			claim.releasedAt ||
			claim.leaseExpiresAt <= c.now ||
			!claim.operationDeadlineAt ||
			claim.operationDeadlineAt <= c.now ||
			claim.operationDeadlineAt.getTime() !== c.operationDeadlineAt.getTime()
		)
			throw new PublicationExecutionError("publication_claim_lost");
		return claim;
	}
	async acquireExecution(
		tx: Tx,
		ref: PublicationExecutionRef,
		c: ExecutorMutationContext,
	): Promise<ExecutorMutationResult> {
		const claim = await tx.publicationClaim.findUniqueOrThrow({
			where: { id: ref.claimId },
		});
		if (
			claim.executorOwner ||
			claim.releasedAt ||
			!claim.operationDeadlineAt ||
			claim.operationDeadlineAt <= c.now ||
			claim.operationDeadlineAt.getTime() !== c.operationDeadlineAt.getTime()
		)
			throw new PublicationExecutionError("publication_claim_lost");
		await tx.publicationClaim.update({
			where: { id: claim.id },
			data: {
				executorOwner: c.owner,
				leaseExpiresAt: c.leaseExpiresAt,
				heartbeatAt: c.now,
			},
		});
		return undefined;
	}
	async renewExecution(
		tx: Tx,
		ref: PublicationExecutionRef,
		c: ExecutorMutationContext,
	): Promise<ExecutorMutationResult> {
		await this.owned(tx, ref, c);
		await tx.publicationClaim.update({
			where: { id: ref.claimId },
			data: { leaseExpiresAt: c.leaseExpiresAt, heartbeatAt: c.now },
		});
		return undefined;
	}
	async startExecution(
		tx: Tx,
		ref: PublicationExecutionRef,
		c: ExecutorMutationContext,
	): Promise<ExecutorMutationResult> {
		await this.owned(tx, ref, c);
		const updated = await tx.socialPublicationAttempt.updateMany({
			where: {
				id: ref.attemptId,
				nativeStartCount: {
					lt: (
						await tx.socialPublicationAttempt.findUniqueOrThrow({
							where: { id: ref.attemptId },
						})
					).nativeStartCeiling,
				},
			},
			data: { nativeStartCount: { increment: 1 } },
		});
		if (updated.count !== 1)
			throw new PublicationExecutionError(
				"publication_native_budget_exhausted",
			);
		return undefined;
	}
	async progressExecution(
		tx: Tx,
		ref: PublicationExecutionRef,
		c: ExecutorMutationContext,
	): Promise<ExecutorMutationResult> {
		await this.owned(tx, ref, c);
		return undefined;
	}
	async failExecution(
		tx: Tx,
		ref: PublicationExecutionRef,
		c: ExecutorMutationContext,
	): Promise<ExecutorMutationResult> {
		await this.owned(tx, ref, c);
		return this.uncertain(tx, ref, "publication_native_outcome_unconfirmed");
	}
	async releaseExecution(
		tx: Tx,
		ref: PublicationExecutionRef,
		c: ExecutorMutationContext,
	): Promise<ExecutorMutationResult> {
		await this.owned(tx, ref, c);
		return this.uncertain(tx, ref, "publication_native_interrupted");
	}
	async expireExecution(
		tx: Tx,
		reference: ExecutionDispatchReference,
		token: string,
		observation: ExecutorExpiryObservation,
	): Promise<ExecutorExpiryResult> {
		const locked = await this.lockExecution(tx, reference, token);
		if (locked.kind === "terminal")
			return { kind: "terminal", dispatchIds: locked.dispatchIds };
		const claim = await tx.publicationClaim.findUniqueOrThrow({
				where: { id: token },
			}),
			due =
				observation.kind === "lease"
					? claim.leaseExpiresAt
					: claim.operationDeadlineAt;
		if (!due || due.getTime() !== observation.observedDeadlineAt.getTime())
			return { kind: "superseded" };
		if (due > (await clock(tx))) return { kind: "sleep", dueAt: due };
		return {
			kind: "expired",
			...(await this.uncertain(tx, locked.ref, "publication_native_expired")),
		};
	}
	async commitArtifactExecution(
		tx: Tx,
		ref: PublicationExecutionRef,
		c: ExecutorMutationContext,
		artifact: PublicationInstructionArtifact,
	): Promise<ExecutorMutationResult> {
		const claim = await this.owned(tx, ref, c),
			post = await this.post(tx, ref.postId),
			instructions = linkedInInstructionBlobSchema.parse(artifact.instructions);
		if (
			!post?.frozenState ||
			post.platform !== "linkedin" ||
			artifact.role !== "publication_checkpoint" ||
			artifact.contentType !== "application/octet-stream" ||
			artifact.byteLength > 16n * 1024n * 1024n ||
			BigInt(instructions.totalBytes) !== post.frozenState.sizeBytes
		)
			throw new PublicationExecutionError("publication_checkpoint_invalid");
		const account = post.socialAccountId
			? await tx.socialAccount.findUnique({
					where: { id: post.socialAccountId },
					select: { providerAccountId: true, metadata: true },
				})
			: null;
		const metadata = account?.metadata as Prisma.JsonObject | null,
			owner =
				typeof metadata?.ownerUrn === "string"
					? metadata.ownerUrn
					: `urn:li:person:${account?.providerAccountId}`;
		if (
			!account ||
			instructions.owner !== owner ||
			(state(claim).instructionArtifactId &&
				state(claim).instructionArtifactId !== artifact.artifactId)
		)
			throw new PublicationExecutionError("publication_checkpoint_invalid");
		const operation = {
			kind: "linkedin_video_upload",
			state: {
				owner: instructions.owner,
				videoUrn: instructions.videoUrn,
				uploadToken: instructions.uploadToken,
				uploadInstructionsRef: { artifactId: artifact.artifactId },
				uploadedPartIds: [],
			},
		};
		await createPrismaSocialPublicationAttemptStore(() => tx).checkpoint({
			owned: { attemptId: ref.attemptId, claimId: ref.claimId },
			operationKind: operation.kind,
			sealedState: this.ports.checkpointCipher.seal(operation.state),
			now: c.now,
		});
		await tx.publicationClaim.update({
			where: { id: claim.id },
			data: {
				workState: json({
					...state(claim),
					instructionArtifactId: artifact.artifactId,
				}),
			},
		});
		return undefined;
	}
	private operation(
		attempt: SocialPublicationAttempt,
		claim: PublicationClaim,
		incoming: PublicationProviderOperation,
	): PublicationProviderOperation {
		if (incoming.kind !== "linkedin_video_upload") return incoming;
		const previous = attempt.checkpointEncrypted
			? this.ports.checkpointCipher.open(attempt.checkpointEncrypted)
			: null;
		const value = incoming.state,
			reference = value.uploadInstructionsRef as Prisma.JsonObject | undefined;
		const priorReference = previous?.uploadInstructionsRef as
			| Prisma.JsonObject
			| undefined;
		if (
			!previous ||
			!reference ||
			reference.artifactId !== priorReference?.artifactId ||
			typeof reference.artifactId !== "string" ||
			"uploadInstructions" in value ||
			"uploadedPartIds" in value
		)
			throw new PublicationExecutionError("publication_checkpoint_invalid");
		if (
			state(claim).instructionArtifactId &&
			reference.artifactId !== state(claim).instructionArtifactId
		)
			throw new PublicationExecutionError("publication_checkpoint_invalid");
		if (
			value.owner !== previous.owner ||
			value.videoUrn !== previous.videoUrn ||
			value.uploadToken !== previous.uploadToken
		)
			throw new PublicationExecutionError("publication_checkpoint_invalid");
		const prior = Array.isArray(previous.uploadedPartIds)
				? previous.uploadedPartIds
				: [],
			append = value.uploadedPartIdsAppend;
		if (
			!Array.isArray(append) ||
			append.length > 2 ||
			append.some(
				(item) =>
					typeof item !== "string" || !item.length || item.length > 8192,
			) ||
			value.uploadedPartCount !== prior.length + append.length
		)
			throw new PublicationExecutionError("publication_checkpoint_invalid");
		return {
			...incoming,
			state: { ...previous, uploadedPartIds: [...prior, ...append] },
		};
	}
	async publicationCommandExecution(
		tx: Tx,
		ref: PublicationExecutionRef,
		c: ExecutorMutationContext,
		raw: PublicationNativeCommand,
	) {
		const command = publicationNativeCommandSchema.parse(raw),
			claim = await this.owned(tx, ref, c),
			attempt = await tx.socialPublicationAttempt.findUniqueOrThrow({
				where: { id: ref.attemptId },
			}),
			store = createPrismaSocialPublicationAttemptStore(() => tx),
			owned: OwnedPublicationAttempt = {
				attemptId: attempt.id,
				claimId: claim.id,
			};
		if (command.kind === "preflight")
			return { reply: { kind: "recorded" } as PublicationNativeReply };
		if (command.kind === "provider_call") {
			if (!["read", "cleanup"].includes(command.operation)) {
				const currentPost = await this.post(tx, ref.postId);
				if (!currentPost)
					throw new PublicationExecutionError("publication_claim_lost");
				try {
					await this.actor(
						tx,
						currentPost,
						false,
						attempt.executionActorUserId,
					);
					if ((await this.grant(tx, currentPost)) === "waiting")
						throw new PublicationExecutionError("publication_grant_paused");
				} catch (error) {
					const code =
							error instanceof PublicationExecutionError
								? error.code
								: "publication_authority_revoked",
						mutation = await this.stop(
							tx,
							ref,
							code,
							submitted(attempt) || Boolean(state(claim).providerGrant),
						);
					return {
						reply: {
							kind: "settled",
							outcome:
								submitted(attempt) || state(claim).providerGrant
									? "needs_attention"
									: "failed",
							attemptId: attempt.id,
							socialPostId: ref.postId,
							code,
						} as PublicationNativeReply,
						complete: true,
						dispatchIds: mutation.dispatchIds,
					};
				}
			}
			if (
				command.operation !== "read" &&
				(await tx.publicationManualDecision.findFirst({
					where: { attemptId: attempt.id, kind: "recheck_requested" },
					select: { id: true },
				}))
			)
				throw new PublicationExecutionError("publication_new_create_forbidden");
			const post = await this.post(tx, ref.postId);
			const idempotentWebhookReplay =
				!post?.socialAccountId &&
				attempt.operationKind === "submission_started" &&
				command.operation === "submit";
			if (
				(claim.executionMode === "reconcile" &&
					!idempotentWebhookReplay &&
					["initialize", "submit"].includes(command.operation)) ||
				(claim.executionMode === "resume" &&
					command.operation === "initialize" &&
					command.purpose !== "thumbnail")
			)
				throw new PublicationExecutionError("publication_new_create_forbidden");
			const irreversible = ["initialize", "submit"].includes(command.operation),
				marker = `${command.operation}:${command.purpose ?? "primary_media"}`;
			if (irreversible && state(claim).irreversibleGrants?.includes(marker))
				throw new PublicationExecutionError(
					"publication_duplicate_create_forbidden",
				);
			await store.recordProviderCall({
				owned,
				maximum: attempt.providerCallCeiling,
				now: c.now,
			});
			await tx.publicationClaim.update({
				where: { id: claim.id },
				data: {
					workState: json({
						...state(claim),
						providerGrant: {
							operation: command.operation,
							purpose: command.purpose ?? "primary_media",
						},
						irreversibleGrants: irreversible
							? [...(state(claim).irreversibleGrants ?? []), marker]
							: (state(claim).irreversibleGrants ?? []),
					}),
				},
			});
			return { reply: { kind: "recorded" } as PublicationNativeReply };
		}
		const parsedOperation =
			"operation" in command &&
			typeof command.operation === "object" &&
			command.operation
				? this.operation(attempt, claim, command.operation)
				: null;
		const seal = (operation: PublicationProviderOperation) =>
			this.ports.checkpointCipher.seal(operation.state);
		if (command.kind === "checkpoint") {
			const operation = parsedOperation!;
			await store.checkpoint({
				owned,
				operationKind: operation.kind,
				sealedState: seal(operation),
				operationLookupHash:
					command.operationLookupHash ??
					(operation.lookupKey
						? createHash("sha256").update(operation.lookupKey).digest("hex")
						: null),
				now: c.now,
			});
			return { reply: { kind: "recorded" } as PublicationNativeReply };
		}
		let result: PublicationAttemptExecutionResult;
		if (command.kind === "accepted")
			result = await store.settleAccepted({
				owned,
				result: { kind: "accepted", receipt: command.receipt },
				now: c.now,
			});
		else if (command.kind === "pending")
			result = await store.settlePending({
				owned,
				result: {
					...command,
					kind: "pending",
					operation: parsedOperation!,
					submissionStarted: submitted(attempt)
						? true
						: command.submissionStarted,
					nextCheckAt: new Date(command.nextCheckAt),
				},
				sealedState: seal(parsedOperation!),
				operationLookupHash: command.operation.lookupKey
					? createHash("sha256")
							.update(command.operation.lookupKey)
							.digest("hex")
					: null,
				now: c.now,
			});
		else if (command.kind === "unknown")
			result = await store.settleUnknown({
				owned,
				code: command.code,
				operation: parsedOperation,
				sealedState: parsedOperation ? seal(parsedOperation) : null,
				canReconcile:
					parsedOperation !== null && attempt.reconciliationDeadline > c.now,
				nextActionAt: command.operation
					? new Date(
							c.now.getTime() + Math.max(1000, command.retryAfterMs ?? 30000),
						)
					: null,
				now: c.now,
			});
		else if (
			command.kind === "failed" &&
			["initialize", "submit"].includes(
				state(claim).providerGrant?.operation ?? "",
			) &&
			command.failure.safeToRepublishAfterSubmission !== true
		) {
			const mutation = await this.uncertain(tx, ref, command.failure.code);
			const current = await tx.socialPublicationAttempt.findUniqueOrThrow({
				where: { id: attempt.id },
			});
			return {
				reply: {
					kind: "settled",
					outcome:
						current.phase === "needs_attention"
							? "needs_attention"
							: current.phase === "failed"
								? "failed"
								: current.phase === "reconciling"
									? "reconciling"
									: "processing",
					attemptId: attempt.id,
					socialPostId: ref.postId,
					code: command.failure.code,
					...(["processing", "reconciling"].includes(current.phase)
						? { nextActionAt: current.nextActionAt.toISOString() }
						: {}),
				} as PublicationNativeReply,
				complete: true,
				dispatchIds: mutation.dispatchIds,
			};
		} else if (command.kind === "failed")
			result = await store.settleFailed({
				owned,
				code: command.failure.code,
				phase: command.failure.phase,
				disposition: command.failure.disposition,
				retryAfterMs: command.failure.retryAfterMs,
				failureEvidence: command.failure.evidence,
				submissionMayHaveStarted:
					submitted(attempt) && !command.failure.safeToRepublishAfterSubmission,
				now: c.now,
				retry: this.ports.config.retry,
				processingDeadlineMs: this.ports.config.processingDeadlineMs,
				reconciliationDeadlineMs: this.ports.config.reconciliationDeadlineMs,
			});
		else {
			const mutation = await this.uncertain(
				tx,
				ref,
				"publication_native_interrupted",
			);
			return {
				reply: {
					kind: "settled",
					outcome: "interrupted",
					attemptId: attempt.id,
					socialPostId: ref.postId,
				} as PublicationNativeReply,
				complete: true,
				dispatchIds: mutation.dispatchIds,
			};
		}
		const next = "nextActionAt" in result ? result.nextActionAt : c.now;
		const dispatchIds =
			"nextActionAt" in result
				? await this.advance(tx, ref.postId, next)
				: await this.wake(tx, ref.postId, next, "publication_terminal");
		return {
			reply: {
				kind: "settled",
				outcome: result.kind,
				attemptId: result.attemptId,
				socialPostId: result.socialPostId,
				...("nextActionAt" in result
					? { nextActionAt: result.nextActionAt.toISOString() }
					: {}),
				...("nextAttemptId" in result
					? { nextAttemptId: result.nextAttemptId }
					: {}),
				...("code" in result ? { code: result.code } : {}),
			} as PublicationNativeReply,
			complete: true,
			dispatchIds,
		};
	}
}

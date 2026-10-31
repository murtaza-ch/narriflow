import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { socialProviderAcceptsMedia } from "@narriflow/validators";
import type { PublishSocialAccount } from "./social-oauth.service";
import type { PublicationFailureDisposition, PublicationPlatform, PublicationPlatformResult, PublicationProviderOperation, PublicationOperationPhase } from "./social-publication-platform";
import { PublicationPlatformExecutionError } from "./social-publication-platform";
import { hasCustomThumbnail } from "./social-account-eligibility";
import type { FrozenPublicationState } from "./social-publication-scheduling";
import type { SocialPublicationMetrics } from "./social-publication-observability";

export type PublicationAttemptPhase =
	| "claimed"
	| "preparing"
	| "uploading"
	| "submission_started"
	| "processing"
	| "reconciling"
	| "retry_scheduled"
	| "succeeded"
	| "failed"
	| "needs_attention";

export type PublicationAttemptOutcome =
	| "accepted"
	| "pending"
	| "failed"
	| "unknown";

/** Plan refusals the worker records on a post it did not submit. */
export type PublicationPlanRefusal = "publication_plan_required" | "publication_account_beyond_plan" | "publication_thumbnail_plan_required";

export type OwnedPublicationAttempt = {
	attemptId: string;
	claimId: string;
};

export type PublicationAttemptSeed = {
	socialPost: {
		id: string;
		workspaceId: string;
		projectId: string;
		status:
			| "scheduled"
			| "publishing"
			| "processing"
			| "reconciling"
			| "inbox_delivered"
			| "posted"
			| "failed"
			| "needs_attention"
			| "cancelled";
		scheduledFor: Date;
		nextAttemptAt?: Date | null;
		externalUrl?: string | null;
		errorCode?: string | null;
	};
	frozen: FrozenPublicationState;
	attempt: {
		id: string;
		attemptNumber: number;
		priorAttemptId: string | null;
		idempotencyKey: string;
		phase: PublicationAttemptPhase;
		outcome: PublicationAttemptOutcome | null;
		nextActionAt: Date;
		providerCallCount: number;
		startedAt: Date;
		phaseStartedAt?: Date;
		processingDeadline: Date;
		reconciliationDeadline: Date;
		/** An accepted manual Recheck permits provider reads for this attempt only. */
		reconciliationOnly?: boolean;
		failureCode?: string | null;
		failureEvidence?: Prisma.InputJsonValue | null;
		failureDisposition?: PublicationFailureDisposition | null;
	};
	claim: {
		id: string;
		claimantId: string;
		leaseExpiresAt: Date;
		heartbeatAt: Date;
	} | null;
	checkpointKind?: string | null;
	sealedCheckpoint?: string | null;
};

export type PublicationAttemptExecutionResult =
	| {
			kind: "posted" | "inbox_delivered";
			attemptId: string;
			socialPostId: string;
			externalUrl: string | null;
	  }
	| {
			kind: "failed" | "needs_attention";
			attemptId: string;
			socialPostId: string;
			code: string;
	  }
	| {
			kind: "processing" | "reconciling";
			attemptId: string;
			socialPostId: string;
			nextActionAt: Date;
	  }
	| {
			kind: "retry_scheduled";
			attemptId: string;
			socialPostId: string;
			nextAttemptId: string;
			nextActionAt: Date;
	  }
	| {
			kind: "interrupted";
			attemptId: string;
			socialPostId: string;
	  };

export type LoadedPublicationAttempt = PublicationAttemptSeed & {
	sealedCheckpoint: string | null;
	checkpointKind: string | null;
	terminalResult: PublicationAttemptExecutionResult | null;
};

export interface SocialPublicationAttemptStore {
	loadOwned(
		input: OwnedPublicationAttempt,
		now: Date,
	): Promise<LoadedPublicationAttempt>;
	checkpoint(input: {
		owned: OwnedPublicationAttempt;
		operationKind: string;
		sealedState: string;
		operationLookupHash?: string | null;
		now: Date;
	}): Promise<void>;
	recordProviderCall(input: {
		owned: OwnedPublicationAttempt;
		maximum: number;
		now: Date;
	}): Promise<void>;
	settleAccepted(input: {
		owned: OwnedPublicationAttempt;
		result: Extract<PublicationPlatformResult, { kind: "accepted" }>;
		now: Date;
	}): Promise<PublicationAttemptExecutionResult>;
	settlePending(input: {
		owned: OwnedPublicationAttempt;
		result: Extract<PublicationPlatformResult, { kind: "pending" }>;
		sealedState: string;
		operationLookupHash?: string | null;
		now: Date;
	}): Promise<PublicationAttemptExecutionResult>;
	settleUnknown(input: {
		owned: OwnedPublicationAttempt;
		code: string;
		operation: PublicationProviderOperation | null;
		sealedState: string | null;
		canReconcile: boolean;
		nextActionAt: Date | null;
		now: Date;
	}): Promise<PublicationAttemptExecutionResult>;
	settleFailed(input: {
		owned: OwnedPublicationAttempt;
		code: string;
		phase: PublicationOperationPhase;
		disposition: PublicationFailureDisposition;
		retryAfterMs: number | null;
		failureEvidence?: Prisma.InputJsonValue;
		submissionMayHaveStarted: boolean;
  definitiveNonPublication?:boolean;
		now: Date;
		retry: PublicationRetryPolicy;
		processingDeadlineMs: number;
		reconciliationDeadlineMs: number;
	}): Promise<PublicationAttemptExecutionResult>;
	releaseInterrupted(input: {
		owned: OwnedPublicationAttempt;
		now: Date;
	}): Promise<PublicationAttemptExecutionResult>;
}

export class PublicationClaimLostError extends Error {
	readonly code = "publication_claim_lost";

	constructor() {
		super("The Social Publication Attempt claim is no longer owned");
		this.name = "PublicationClaimLostError";
	}
}

export class PublicationProviderCallBudgetError extends Error {
	readonly code = "publication_provider_call_budget_exhausted";

	constructor() {
		super("The Social Publication Attempt provider-call budget is exhausted");
		this.name = "PublicationProviderCallBudgetError";
	}
}

export function publicationOperationLookupHash(lookupKey: string) {
	return createHash("sha256").update(lookupKey).digest("hex");
}

export type PublicationRetryPolicy = {
	maxAttempts: number;
	maxElapsedMs: number;
	baseDelayMs: number;
	maxDelayMs: number;
	jitterRatio: number;
	random(): number;
};

export function retryActionAt(input: {
	now: Date;
	attemptNumber: number;
	retryAfterMs: number | null;
	retry: PublicationRetryPolicy;
}) {
	const rawDelay = Math.min(
		input.retry.maxDelayMs,
		input.retry.baseDelayMs * 2 ** Math.max(0, input.attemptNumber - 1),
	);
	const jitter = 1 + (input.retry.random() * 2 - 1) * input.retry.jitterRatio;
	const delayMs = Math.max(
		input.retryAfterMs ?? 0,
		Math.round(rawDelay * jitter),
	);
	return new Date(input.now.getTime() + delayMs);
}

export type SocialPublicationDiagnostic = {
	level: "info" | "warn" | "error";
	message: string;
	attemptId: string;
	claimId: string;
	socialPostId?: string;
	workspaceId?: string;
	platform?: string;
	accountIdHash?: string;
	phase?: string;
	operation?: string;
	outcome?: string;
	disposition?: string;
	errorCode?: string;
	retryAt?: string;
	elapsedMs?: number;
	cleanupOutcome?: string;
};

function isAbort(error: unknown, signal: AbortSignal): boolean {
	return (
		signal.aborted || (error instanceof Error && error.name === "AbortError")
	);
}

export function createSocialPublicationAttempt(dependencies: {
	store: SocialPublicationAttemptStore;
	platforms: {
		get(
			platform: FrozenPublicationState["platform"],
			channel?: "native" | "webhook",
		): PublicationPlatform;
	};
	credentials: {
		load(accountId: string): Promise<PublishSocialAccount | null>;
	};
	/** Why the Workspace's current plan does not let this post go out, if so. Read
	 * before the first provider submission only; submitted work always reconciles. */
	planEligibility: {
		refusal(input: { workspaceId: string; socialAccountId: string | null; customThumbnail: boolean }): Promise<PublicationPlanRefusal | null>;
	};
	checkpointCodec: {
		encode(value: Prisma.JsonObject): string;
		decode(value: string): Prisma.JsonObject;
	};
	clock: { now(): Date };
	diagnostics: { record(event: SocialPublicationDiagnostic): void };
	metrics?: SocialPublicationMetrics;
	retry: PublicationRetryPolicy;
	providerCallBudget: number;
	processingDeadlineMs: number;
	reconciliationDeadlineMs: number;
}) {
	return {
		async execute(input: {
			attempt: OwnedPublicationAttempt;
			signal: AbortSignal;
		}): Promise<PublicationAttemptExecutionResult> {
			const startedAtMs = dependencies.clock.now().getTime();
			const loaded = await dependencies.store.loadOwned(
				input.attempt,
				dependencies.clock.now(),
			);
			if (loaded.terminalResult) {
				dependencies.metrics?.observe(
					"social_publication_settlement_replays_total",
					1,
					{ platform: loaded.frozen.platform, phase: loaded.attempt.phase },
				);
				return loaded.terminalResult;
			}
			dependencies.metrics?.observe(
				"social_publication_queue_age_ms",
				Math.max(0, startedAtMs - loaded.attempt.nextActionAt.getTime()),
				{ platform: loaded.frozen.platform, phase: loaded.attempt.phase },
			);
			const recordDiagnostic = (
				event: Omit<
					SocialPublicationDiagnostic,
					| "attemptId"
					| "claimId"
					| "socialPostId"
					| "workspaceId"
					| "platform"
					| "accountIdHash"
					| "elapsedMs"
				>,
			) => {
				const recorded = {
					...event,
					attemptId: input.attempt.attemptId,
					claimId: input.attempt.claimId,
					socialPostId: loaded.socialPost.id,
					workspaceId: loaded.socialPost.workspaceId,
					platform: loaded.frozen.platform,
					accountIdHash: loaded.frozen.socialAccountId
						? createHash("sha256")
								.update(loaded.frozen.socialAccountId)
								.digest("hex")
								.slice(0, 16)
						: undefined,
					elapsedMs: dependencies.clock.now().getTime() - startedAtMs,
				};
				dependencies.diagnostics.record(recorded);
				const attributes = {
					platform: recorded.platform,
					phase: recorded.phase,
					outcome: recorded.outcome,
					disposition: recorded.disposition,
				};
				if (recorded.phase === "processing") {
					dependencies.metrics?.observe(
						"social_publication_pending_age_ms",
						Math.max(
							0,
							dependencies.clock.now().getTime() -
								(
									loaded.attempt.phaseStartedAt ?? loaded.attempt.startedAt
								).getTime(),
						),
						attributes,
					);
				}
				if (recorded.phase === "reconciling") {
					dependencies.metrics?.observe(
						"social_publication_reconciliation_age_ms",
						Math.max(
							0,
							dependencies.clock.now().getTime() -
								(
									loaded.attempt.phaseStartedAt ?? loaded.attempt.startedAt
								).getTime(),
						),
						attributes,
					);
				}
				if (recorded.phase === "retry_scheduled") {
					dependencies.metrics?.observe(
						"social_publication_retries_total",
						1,
						attributes,
					);
				}
				if (recorded.phase === "needs_attention") {
					dependencies.metrics?.observe(
						"social_publication_attention_total",
						1,
						attributes,
					);
				}
				if (recorded.outcome === "accepted") {
					dependencies.metrics?.observe(
						"social_publication_receipts_total",
						1,
						attributes,
					);
				}
				if (
					recorded.errorCode?.includes("rate_limit") ||
					recorded.errorCode?.includes("429")
				) {
					dependencies.metrics?.observe(
						"social_publication_rate_limits_total",
						1,
						attributes,
					);
				}
				if (
					recorded.phase === "posted" ||
					recorded.phase === "failed" ||
					recorded.phase === "needs_attention"
				) {
					dependencies.metrics?.observe(
						"social_publication_terminal_outcomes_total",
						1,
						attributes,
					);
				}
			};
			const notYetSubmitted =
				loaded.attempt.phase !== "submission_started" &&
				loaded.attempt.phase !== "processing" &&
				loaded.attempt.phase !== "reconciling";
			if (notYetSubmitted) {
				// A downgrade since scheduling ends the post here, as an outcome the
				// person can act on, before anything reaches the provider.
				const refusal = await dependencies.planEligibility.refusal({
					workspaceId: loaded.socialPost.workspaceId,
					socialAccountId: loaded.frozen.socialAccountId,
					customThumbnail: hasCustomThumbnail(loaded.frozen.providerSettings),
				});
				if (refusal) {
					const settled = await dependencies.store.settleFailed({
						owned: input.attempt,
						code: refusal,
						phase: "preparation",
						disposition: "permanent",
						retryAfterMs: null,
						submissionMayHaveStarted: false,
						now: dependencies.clock.now(),
						retry: dependencies.retry,
						processingDeadlineMs: dependencies.processingDeadlineMs,
						reconciliationDeadlineMs: dependencies.reconciliationDeadlineMs,
					});
					recordDiagnostic({
						level: "warn",
						message: "social_publication_plan_ineligible",
						phase: settled.kind,
						operation: "plan_eligibility",
						outcome: settled.kind,
						disposition: "permanent",
						errorCode: refusal,
					});
					return settled;
				}
			}
			let platform: PublicationPlatform;
			let account: PublishSocialAccount | null;
			try {
				platform = dependencies.platforms.get(
					loaded.frozen.platform,
					loaded.frozen.socialAccountId ? "native" : "webhook",
				);
				account = loaded.frozen.socialAccountId
					? await dependencies.credentials.load(loaded.frozen.socialAccountId)
					: null;
			} catch (error) {
				const now = dependencies.clock.now();
				const credentialCode =
					error &&
					typeof error === "object" &&
					"code" in error &&
					(error.code === "social_account_expired" ||
						error.code === "social_account_missing")
						? "social_account_reconnect_required"
						: null;
				const failureCode =
					credentialCode ?? "publication_execution_dependency_unavailable";
				const submissionMayHaveStarted =
					loaded.attempt.phase === "submission_started" ||
					loaded.attempt.phase === "processing" ||
					loaded.attempt.phase === "reconciling";
				if (submissionMayHaveStarted) {
					let operation: PublicationProviderOperation | null = null;
					if (loaded.sealedCheckpoint && loaded.checkpointKind) {
						try {
							operation = {
								kind: loaded.checkpointKind,
								state: dependencies.checkpointCodec.decode(
									loaded.sealedCheckpoint,
								),
							};
						} catch {
							operation = null;
						}
					}
					const canReconcile = credentialCode === null && operation !== null;
					const settled = await dependencies.store.settleUnknown({
						owned: input.attempt,
						code: failureCode,
						operation,
						sealedState: loaded.sealedCheckpoint,
						canReconcile,
						nextActionAt: canReconcile ? new Date(now.getTime() + 30_000) : null,
						now,
					});
					recordDiagnostic({
						level: "error",
						message: "social_publication_attempt_failed",
						phase: settled.kind,
						operation: operation?.kind ?? "platform_resolution",
						outcome: settled.kind,
						disposition: canReconcile ? "reconcile" : "attention",
						errorCode: failureCode,
					});
					return settled;
				}
				const settled = await dependencies.store.settleFailed({
					owned: input.attempt,
					code: failureCode,
					phase: "preparation",
					disposition: credentialCode ? "permanent" : "safe_retry",
					retryAfterMs: null,
					submissionMayHaveStarted: false,
					now,
					retry: dependencies.retry,
					processingDeadlineMs: dependencies.processingDeadlineMs,
					reconciliationDeadlineMs: dependencies.reconciliationDeadlineMs,
				});
				recordDiagnostic({
					level: "error",
					message: "social_publication_attempt_failed",
					phase: settled.kind,
					operation: "platform_resolution",
					outcome: settled.kind,
					disposition: credentialCode ? "permanent" : "safe_retry",
					errorCode: failureCode,
					retryAt:
						settled.kind === "retry_scheduled"
							? settled.nextActionAt.toISOString()
							: undefined,
				});
				return settled;
			}
			if (
				platform.capabilities.capabilityVersion !==
				loaded.frozen.capabilityVersion
			) {
				const now = dependencies.clock.now();
				const submitted =
					loaded.attempt.phase === "submission_started" ||
					loaded.attempt.phase === "processing" ||
					loaded.attempt.phase === "reconciling";
				const settled = await (submitted
					? dependencies.store.settleUnknown({
							owned: input.attempt,
							code: "publication_capability_version_mismatch",
							operation: null,
							sealedState: loaded.sealedCheckpoint,
							canReconcile: false,
							nextActionAt: null,
							now,
						})
					: dependencies.store.settleFailed({
							owned: input.attempt,
							code: "publication_capability_version_mismatch",
							phase: "preparation",
							disposition: "permanent",
							retryAfterMs: null,
							submissionMayHaveStarted: false,
							now,
							retry: dependencies.retry,
							processingDeadlineMs: dependencies.processingDeadlineMs,
							reconciliationDeadlineMs: dependencies.reconciliationDeadlineMs,
						}));
				recordDiagnostic({
					level: "error",
					message: "social_publication_attempt_failed",
					phase: settled.kind,
					operation: loaded.checkpointKind ?? "capability_validation",
					outcome: settled.kind,
					disposition: submitted ? "attention" : "permanent",
					errorCode: "publication_capability_version_mismatch",
				});
				return settled;
			}
			const platformInput = {
				attemptId: loaded.attempt.id,
				idempotencyKey: loaded.attempt.idempotencyKey,
				socialPostId: loaded.socialPost.id,
				projectId: loaded.socialPost.projectId,
				platform: loaded.frozen.platform,
				caption: loaded.frozen.caption,
				scheduledFor: loaded.socialPost.scheduledFor,
				providerSettings: loaded.frozen.providerSettings,
				account,
				media: {
					storageKey: loaded.frozen.storageKey!,
					fileName: `social-${loaded.frozen.clipExportVariantId}.mp4`,
					contentType: "video/mp4" as const,
					sizeBytes: loaded.frozen.sizeBytes!,
					durationSec: loaded.frozen.durationSec!,
					aspectRatio: loaded.frozen.aspectRatio,
				},
			};
			let submissionCheckpointed =
				loaded.attempt.phase === "submission_started" ||
				loaded.attempt.phase === "processing" ||
				loaded.attempt.phase === "reconciling";
			let lastCheckpointOperation: PublicationProviderOperation | null =
				loaded.sealedCheckpoint && loaded.checkpointKind
					? {
							kind: loaded.checkpointKind,
							state: dependencies.checkpointCodec.decode(
								loaded.sealedCheckpoint,
							),
						}
					: null;

			try {
				if (input.signal.aborted)
					throw new DOMException("Aborted", "AbortError");
				if (
					!socialProviderAcceptsMedia({
						platform: platformInput.platform,
						aspectRatio: platformInput.media.aspectRatio,
						durationSec: platformInput.media.durationSec,
					})
				) {
					throw new PublicationPlatformExecutionError(
						"publication_media_capability_mismatch",
						"preparation",
						"Frozen media does not satisfy the provider capability contract",
					);
				}
				const context = {
					signal: input.signal,
					reconciliationOnly: loaded.attempt.reconciliationOnly === true,
					providerCall: async () => {
						await dependencies.store.recordProviderCall({
							owned: input.attempt,
							maximum: Math.min(
								dependencies.providerCallBudget,
								platform.capabilities.maxProviderCalls,
							),
							now: dependencies.clock.now(),
						});
						dependencies.metrics?.observe(
							"social_publication_provider_operations_total",
							1,
							{
								platform: loaded.frozen.platform,
								operation:
									lastCheckpointOperation?.kind ?? loaded.attempt.phase,
							},
						);
					},
					checkpoint: async (operation: PublicationProviderOperation) => {
						lastCheckpointOperation = operation;
						const sealedState = dependencies.checkpointCodec.encode(
							operation.state,
						);
						await dependencies.store.checkpoint({
							owned: input.attempt,
							operationKind: operation.kind,
							sealedState,
							operationLookupHash: operation.lookupKey
								? publicationOperationLookupHash(operation.lookupKey)
								: null,
							now: dependencies.clock.now(),
						});
						submissionCheckpointed ||= operation.kind === "submission_started";
					},
				};
				let result: PublicationPlatformResult;
				const resumedAfterSubmission =
					loaded.attempt.phase === "submission_started" ||
					loaded.attempt.phase === "processing" ||
					loaded.attempt.phase === "reconciling";
				if (resumedAfterSubmission) {
					if (lastCheckpointOperation && platform.reconcile) {
						result = await platform.reconcile(
							platformInput,
							lastCheckpointOperation,
							context,
						);
					} else {
						const now = dependencies.clock.now();
						const settled = await dependencies.store.settleUnknown({
							owned: input.attempt,
							code: "publication_recovery_unavailable_after_submission",
							operation: lastCheckpointOperation,
							sealedState: loaded.sealedCheckpoint,
							canReconcile: false,
							nextActionAt: null,
							now,
						});
						recordDiagnostic({
							level: "warn",
							message: "social_publication_attempt_needs_attention",
							phase: settled.kind,
							operation: lastCheckpointOperation?.kind ?? "recovery",
							outcome: settled.kind,
							disposition: "attention",
							errorCode: "publication_recovery_unavailable_after_submission",
						});
						return settled;
					}
				} else if (lastCheckpointOperation && platform.resume) {
					result = await platform.resume(
						platformInput,
						lastCheckpointOperation,
						context,
					);
				} else {
					result = await platform.publish(platformInput, context);
				}
				const now = dependencies.clock.now();
				let settled: PublicationAttemptExecutionResult;
				switch (result.kind) {
					case "accepted":
						settled = await dependencies.store.settleAccepted({
							owned: input.attempt,
							result,
							now,
						});
						break;
					case "pending":
						settled = await dependencies.store.settlePending({
							owned: input.attempt,
							result,
							sealedState: dependencies.checkpointCodec.encode(
								result.operation.state,
							),
							operationLookupHash: result.operation.lookupKey
								? publicationOperationLookupHash(result.operation.lookupKey)
								: null,
							now,
						});
						break;
					case "failed":
						settled = await dependencies.store.settleFailed({
							owned: input.attempt,
							code: result.failure.code,
							definitiveNonPublication:result.failure.safeToRepublishAfterSubmission===true,
							phase: result.failure.phase,
							disposition: result.failure.disposition,
							retryAfterMs: result.failure.retryAfterMs,
							failureEvidence: result.failure.evidence,
							submissionMayHaveStarted:
								loaded.attempt.reconciliationOnly === true ||
								(submissionCheckpointed && !result.failure.safeToRepublishAfterSubmission),
							now,
							retry: dependencies.retry,
							processingDeadlineMs: dependencies.processingDeadlineMs,
							reconciliationDeadlineMs: dependencies.reconciliationDeadlineMs,
						});
						break;
					case "unknown": {
						const operation = result.operation ?? lastCheckpointOperation;
						const canReconcile =
							operation !== null &&
							platform.capabilities.recovery !== "none" &&
							platform.reconcile !== undefined;
						settled = await dependencies.store.settleUnknown({
							owned: input.attempt,
							code: result.code,
							operation,
							sealedState: operation
								? dependencies.checkpointCodec.encode(operation.state)
								: null,
							canReconcile,
							nextActionAt: canReconcile
								? new Date(
										now.getTime() + Math.max(30_000, result.retryAfterMs ?? 0),
									)
								: null,
							now,
						});
						break;
					}
				}
				recordDiagnostic({
					level: "info",
					message: "social_publication_attempt_settled",
					phase: settled.kind,
					outcome: result.kind,
					errorCode:
						result.kind === "failed"
							? result.failure.code
							: result.kind === "unknown"
								? result.code
								: undefined,
					disposition:
						settled.kind === "needs_attention"
							? "attention"
							: result.kind === "failed"
								? result.failure.disposition
								: result.kind === "unknown"
									? "attention"
									: undefined,
					operation:
						result.kind === "pending"
							? result.operation.kind
							: (lastCheckpointOperation?.kind ?? "publish"),
					retryAt:
						settled.kind === "retry_scheduled"
							? settled.nextActionAt.toISOString()
							: settled.kind === "processing" || settled.kind === "reconciling"
								? settled.nextActionAt.toISOString()
								: undefined,
				});
				return settled;
			} catch (error) {
				if (error instanceof PublicationClaimLostError) {
					dependencies.metrics?.observe(
						"social_publication_stale_settlements_total",
						1,
						{ platform: loaded.frozen.platform },
					);
					throw error;
				}
				if (isAbort(error, input.signal)) {
					const now = dependencies.clock.now();
					if (submissionCheckpointed) {
						const canReconcile =
							platform.capabilities.recovery !== "none" &&
							lastCheckpointOperation !== null;
						const settled = await dependencies.store.settleUnknown({
							owned: input.attempt,
							code: "publication_interrupted_after_submission",
							operation: lastCheckpointOperation,
							sealedState: lastCheckpointOperation
								? dependencies.checkpointCodec.encode(
										lastCheckpointOperation.state,
									)
								: null,
							canReconcile,
							nextActionAt: canReconcile
								? new Date(now.getTime() + 30_000)
								: null,
							now,
						});
						recordDiagnostic({
							level: "warn",
							message: "social_publication_attempt_interrupted",
							phase: settled.kind,
							operation: lastCheckpointOperation?.kind ?? "submission",
							outcome: settled.kind,
							disposition: "attention",
							errorCode: "publication_interrupted_after_submission",
							retryAt:
								settled.kind === "reconciling"
									? settled.nextActionAt.toISOString()
									: undefined,
						});
						return settled;
					}
					const settled = await dependencies.store.releaseInterrupted({
						owned: input.attempt,
						now,
					});
					recordDiagnostic({
						level: "info",
						message: "social_publication_attempt_interrupted",
						phase: "interrupted",
						operation: lastCheckpointOperation?.kind ?? "preparation",
						outcome: settled.kind,
					});
					return settled;
				}
				const code =
					error instanceof PublicationProviderCallBudgetError
						? error.code
						: error instanceof PublicationPlatformExecutionError
							? error.code
							: "social_publish_failed";
				const phase =
					error instanceof PublicationPlatformExecutionError
						? error.phase
						: submissionCheckpointed
							? "submission"
							: "preparation";
				const now = dependencies.clock.now();
				const canReconcile =
					submissionCheckpointed &&
					platform.capabilities.recovery !== "none" &&
					lastCheckpointOperation !== null &&
					platform.reconcile !== undefined;
				const settled = submissionCheckpointed
					? await dependencies.store.settleUnknown({
							owned: input.attempt,
							code,
							operation: lastCheckpointOperation,
							sealedState: lastCheckpointOperation
								? dependencies.checkpointCodec.encode(
										lastCheckpointOperation.state,
									)
								: null,
							canReconcile,
							nextActionAt: canReconcile
								? new Date(now.getTime() + 30_000)
								: null,
							now,
						})
					: await dependencies.store.settleFailed({
							owned: input.attempt,
							code,
							phase,
							disposition:
								error instanceof PublicationProviderCallBudgetError ||
								(error instanceof PublicationPlatformExecutionError &&
									error.code === "publication_frozen_media_missing")
									? "permanent"
									: "safe_retry",
							retryAfterMs: null,
							submissionMayHaveStarted: false,
							now,
							retry: dependencies.retry,
							processingDeadlineMs: dependencies.processingDeadlineMs,
							reconciliationDeadlineMs: dependencies.reconciliationDeadlineMs,
						});
				recordDiagnostic({
					level: "error",
					message: "social_publication_attempt_failed",
					phase: settled.kind,
					outcome: settled.kind,
					disposition: submissionCheckpointed
						? "attention"
						: error instanceof PublicationProviderCallBudgetError ||
								(error instanceof PublicationPlatformExecutionError &&
									error.code === "publication_frozen_media_missing")
							? "permanent"
							: "safe_retry",
					errorCode: code,
					operation: lastCheckpointOperation?.kind ?? "publish",
					retryAt:
						settled.kind === "retry_scheduled"
							? settled.nextActionAt.toISOString()
							: settled.kind === "reconciling"
								? settled.nextActionAt.toISOString()
								: undefined,
				});
				return settled;
			}
		},
	};
}


import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import type { PublishSocialAccount } from "./social-oauth.service";
import type {
	PublicationFailureDisposition,
	PublicationPlatform,
	PublicationPlatformResult,
	PublicationProviderOperation,
	PublicationOperationPhase,
} from "./social-publication-platform";
import { PublicationPlatformExecutionError } from "./social-publication-platform";
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
			kind: "posted";
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

type LoadedPublicationAttempt = PublicationAttemptSeed & {
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

function retryActionAt(input: {
	now: Date;
	attemptNumber: number;
	retryAfterMs: number | null;
	retry: PublicationRetryPolicy;
}) {
	const rawDelay = Math.min(
		input.retry.maxDelayMs,
		input.retry.baseDelayMs * 2 ** Math.max(0, input.attemptNumber - 1),
	);
	const jitter =
		1 + (input.retry.random() * 2 - 1) * input.retry.jitterRatio;
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
	checkpointCipher: {
		seal(value: Prisma.JsonObject): string;
		open(value: string): Prisma.JsonObject;
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
								(loaded.attempt.phaseStartedAt ?? loaded.attempt.startedAt).getTime(),
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
								(loaded.attempt.phaseStartedAt ?? loaded.attempt.startedAt).getTime(),
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
								state: dependencies.checkpointCipher.open(
									loaded.sealedCheckpoint,
								),
							};
						} catch {
							operation = null;
						}
					}
					const settled = await dependencies.store.settleUnknown({
						owned: input.attempt,
						code: failureCode,
						operation,
						sealedState: loaded.sealedCheckpoint,
						canReconcile: false,
						nextActionAt: null,
						now,
							});
					recordDiagnostic({
						level: "error",
						message: "social_publication_attempt_failed",
						phase: settled.kind,
						operation: operation?.kind ?? "platform_resolution",
						outcome: settled.kind,
						disposition: "attention",
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
					reconciliationDeadlineMs:
						dependencies.reconciliationDeadlineMs,
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
				platform.capabilities.apiVersion !== loaded.frozen.capabilityVersion
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
							reconciliationDeadlineMs:
								dependencies.reconciliationDeadlineMs,
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
				scheduledFor: loaded.frozen.scheduledFor,
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
							state: dependencies.checkpointCipher.open(
								loaded.sealedCheckpoint,
							),
						}
					: null;

			try {
				if (input.signal.aborted)
					throw new DOMException("Aborted", "AbortError");
				const context = {
					signal: input.signal,
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
						const sealedState = dependencies.checkpointCipher.seal(
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
							sealedState: dependencies.checkpointCipher.seal(
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
							phase: result.failure.phase,
							disposition: result.failure.disposition,
							retryAfterMs: result.failure.retryAfterMs,
							failureEvidence: result.failure.evidence,
							submissionMayHaveStarted:
								submissionCheckpointed &&
								!result.failure.safeToRepublishAfterSubmission,
							now,
							retry: dependencies.retry,
							processingDeadlineMs: dependencies.processingDeadlineMs,
							reconciliationDeadlineMs:
								dependencies.reconciliationDeadlineMs,
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
								? dependencies.checkpointCipher.seal(operation.state)
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
								? dependencies.checkpointCipher.seal(
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
								? dependencies.checkpointCipher.seal(
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
							reconciliationDeadlineMs:
								dependencies.reconciliationDeadlineMs,
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

type InMemoryRecord = LoadedPublicationAttempt & {
	receipt: {
		receiptId: string;
		platformPostId: string | null;
		externalUrl: string | null;
	} | null;
	analyticsIntent: { kind: "social_posted"; attemptId: string } | null;
};

function cloneRecord(record: InMemoryRecord): InMemoryRecord {
	return structuredClone(record);
}

function requireOwned(
	records: Map<string, InMemoryRecord>,
	owned: OwnedPublicationAttempt,
): InMemoryRecord {
	const record = records.get(owned.attemptId);
	if (!record) throw new PublicationClaimLostError();
	if (record.terminalResult) return record;
	if (!record.claim || record.claim.id !== owned.claimId) {
		throw new PublicationClaimLostError();
	}
	return record;
}

export function createInMemorySocialPublicationAttemptStore(
	seeds: readonly PublicationAttemptSeed[],
): SocialPublicationAttemptStore & {
	inspect(attemptId: string): Promise<{
		socialPost: InMemoryRecord["socialPost"];
		attempt: InMemoryRecord["attempt"];
		claim: InMemoryRecord["claim"] | null;
		receipt: InMemoryRecord["receipt"];
		analyticsIntent: InMemoryRecord["analyticsIntent"];
	} | null>;
	takeOver(
		attemptId: string,
		claim: PublicationAttemptSeed["claim"],
	): Promise<void>;
} {
	const records = new Map<string, InMemoryRecord>();
	for (const seed of seeds) {
		records.set(seed.attempt.id, {
			...cloneRecord({
				...seed,
				sealedCheckpoint: seed.sealedCheckpoint ?? null,
				checkpointKind: seed.checkpointKind ?? null,
				terminalResult: null,
				receipt: null,
				analyticsIntent: null,
			}),
		});
	}

	return {
		async loadOwned(owned) {
			return cloneRecord(requireOwned(records, owned));
		},

		async checkpoint(input) {
			const record = requireOwned(records, input.owned);
			record.attempt.phase =
				input.operationKind === "submission_started"
					? "submission_started"
					: record.attempt.phase;
			if (input.operationKind === "submission_started") {
				record.attempt.phaseStartedAt = input.now;
			}
			record.checkpointKind = input.operationKind;
			record.sealedCheckpoint = input.sealedState;
		},

		async recordProviderCall(input) {
			const record = requireOwned(records, input.owned);
			if (record.attempt.providerCallCount >= input.maximum) {
				throw new PublicationProviderCallBudgetError();
			}
			record.attempt.providerCallCount += 1;
		},

		async settleAccepted(input) {
			const record = requireOwned(records, input.owned);
			if (record.terminalResult) return record.terminalResult;
			record.attempt.phase = "succeeded";
			record.attempt.outcome = "accepted";
			record.socialPost.status = "posted";
			record.socialPost.externalUrl = input.result.receipt.externalUrl;
			record.receipt = {
				receiptId: input.result.receipt.receiptId,
				platformPostId: input.result.receipt.platformPostId,
				externalUrl: input.result.receipt.externalUrl,
			};
			record.analyticsIntent = {
				kind: "social_posted",
				attemptId: record.attempt.id,
			};
			record.claim = null;
			record.terminalResult = {
				kind: "posted",
				attemptId: record.attempt.id,
				socialPostId: record.socialPost.id,
				externalUrl: input.result.receipt.externalUrl,
			};
			return structuredClone(record.terminalResult);
		},

		async settlePending(input) {
			const record = requireOwned(records, input.owned);
			const nextActionAt = new Date(
				Math.min(
					input.result.nextCheckAt.getTime(),
					record.attempt.processingDeadline.getTime(),
				),
			);
			const nextPhase =
				input.result.submissionStarted === false ? "uploading" : "processing";
			if (record.attempt.phase !== nextPhase) {
				record.attempt.phaseStartedAt = input.now;
			}
			record.attempt.phase = nextPhase;
			record.attempt.outcome = "pending";
			record.attempt.nextActionAt = nextActionAt;
			record.socialPost.status = "processing";
			record.checkpointKind = input.result.operation.kind;
			record.sealedCheckpoint = input.sealedState;
			record.claim = null;
			return {
				kind: "processing",
				attemptId: record.attempt.id,
				socialPostId: record.socialPost.id,
				nextActionAt,
			};
		},

		async settleUnknown(input) {
			const record = requireOwned(records, input.owned);
			record.attempt.outcome = "unknown";
			record.attempt.failureCode = input.code;
			record.checkpointKind = input.operation?.kind ?? record.checkpointKind;
			record.sealedCheckpoint = input.sealedState;
			record.claim = null;
			if (input.canReconcile && input.nextActionAt) {
				if (record.attempt.phase !== "reconciling") {
					record.attempt.phaseStartedAt = input.now;
				}
				record.attempt.phase = "reconciling";
				record.attempt.nextActionAt = input.nextActionAt;
				record.socialPost.status = "reconciling";
				return {
					kind: "reconciling",
					attemptId: record.attempt.id,
					socialPostId: record.socialPost.id,
					nextActionAt: input.nextActionAt,
				};
			}
			record.attempt.phase = "needs_attention";
			record.socialPost.status = "needs_attention";
			record.socialPost.errorCode = input.code;
			record.terminalResult = {
				kind: "needs_attention",
				attemptId: record.attempt.id,
				socialPostId: record.socialPost.id,
				code: input.code,
			};
			return structuredClone(record.terminalResult);
		},

		async settleFailed(input) {
			const record = requireOwned(records, input.owned);
			const needsAttention =
				input.disposition === "attention" ||
				(input.disposition === "safe_retry" && input.submissionMayHaveStarted);
			if (needsAttention) {
				record.attempt.phase = "needs_attention";
				record.attempt.outcome = input.submissionMayHaveStarted
					? "unknown"
					: "failed";
				record.attempt.failureCode = input.code;
				record.attempt.failureEvidence = input.failureEvidence ?? null;
				record.attempt.failureDisposition = "attention";
				record.socialPost.status = "needs_attention";
				record.socialPost.errorCode = input.code;
				record.claim = null;
				record.terminalResult = {
					kind: "needs_attention",
					attemptId: record.attempt.id,
					socialPostId: record.socialPost.id,
					code: input.code,
				};
				return structuredClone(record.terminalResult);
			}
			record.attempt.phase = "failed";
			record.attempt.outcome = "failed";
			record.attempt.failureCode = input.code;
			record.attempt.failureEvidence = input.failureEvidence ?? null;
			record.attempt.failureDisposition = input.disposition;
			record.socialPost.status = "failed";
			record.socialPost.errorCode = input.code;
			record.claim = null;
			const retryCandidate =
				input.disposition === "safe_retry" &&
				!input.submissionMayHaveStarted &&
				record.attempt.attemptNumber < input.retry.maxAttempts;
			const nextActionAt = retryCandidate
				? retryActionAt({
						now: input.now,
						attemptNumber: record.attempt.attemptNumber,
						retryAfterMs: input.retryAfterMs,
						retry: input.retry,
					})
				: null;
			let lineageRecord = record;
			while (lineageRecord.attempt.priorAttemptId) {
				const prior = records.get(lineageRecord.attempt.priorAttemptId);
				if (!prior) break;
				lineageRecord = prior;
			}
			const lineageDeadline =
				lineageRecord.attempt.startedAt.getTime() + input.retry.maxElapsedMs;
			if (nextActionAt && nextActionAt.getTime() <= lineageDeadline) {
				record.socialPost.status = "scheduled";
				record.socialPost.errorCode = input.code;
				record.socialPost.nextAttemptAt = nextActionAt;
				const nextAttemptId = `attempt-${record.attempt.attemptNumber + 1}`;
				const nextRecord: InMemoryRecord = cloneRecord({
					socialPost: record.socialPost,
					frozen: record.frozen,
					attempt: {
						id: nextAttemptId,
						attemptNumber: record.attempt.attemptNumber + 1,
						priorAttemptId: record.attempt.id,
						idempotencyKey: `${record.attempt.idempotencyKey}:retry:${record.attempt.attemptNumber + 1}`,
						phase: "retry_scheduled",
						outcome: null,
						nextActionAt,
						providerCallCount: 0,
						startedAt: input.now,
						processingDeadline: new Date(
							nextActionAt.getTime() + input.processingDeadlineMs,
						),
						reconciliationDeadline: new Date(
							nextActionAt.getTime() + input.reconciliationDeadlineMs,
						),
					},
					claim: null,
					checkpointKind: null,
					sealedCheckpoint: null,
					terminalResult: null,
					receipt: null,
					analyticsIntent: null,
				});
				records.set(nextAttemptId, nextRecord);
				record.terminalResult = {
					kind: "retry_scheduled",
					attemptId: record.attempt.id,
					socialPostId: record.socialPost.id,
					nextAttemptId,
					nextActionAt,
				};
				return structuredClone(record.terminalResult);
			}
			record.terminalResult = {
				kind: "failed",
				attemptId: record.attempt.id,
				socialPostId: record.socialPost.id,
				code: input.code,
			};
			return structuredClone(record.terminalResult);
		},

		async releaseInterrupted(input) {
			const record = requireOwned(records, input.owned);
			record.claim = null;
			record.attempt.nextActionAt = input.now;
			return {
				kind: "interrupted",
				attemptId: record.attempt.id,
				socialPostId: record.socialPost.id,
			};
		},

		async inspect(attemptId) {
			const record = records.get(attemptId);
			if (!record) return null;
			return structuredClone({
				socialPost: record.socialPost,
				attempt: record.attempt,
				claim: record.claim,
				receipt: record.receipt,
				analyticsIntent: record.analyticsIntent,
			});
		},

		async takeOver(attemptId, claim) {
			const record = records.get(attemptId);
			if (!record) throw new Error("attempt not found");
			record.claim = structuredClone(claim);
		},
	};
}

const publicationAttemptInclude = {
	socialPost: true,
	frozenState: true,
	claims: { orderBy: { createdAt: "desc" as const } },
	receipt: true,
	analyticsIntent: true,
};

type PublicationAttemptRow = Prisma.SocialPublicationAttemptGetPayload<{
	include: typeof publicationAttemptInclude;
}>;

function requirePrisma() {
	const prisma = getPrismaClient();
	if (!prisma) throw new Error("Database client unavailable");
	return prisma;
}

function rowExecutionResult(
	row: PublicationAttemptRow,
): PublicationAttemptExecutionResult | null {
	if (row.phase === "succeeded" && row.receipt) {
		return {
			kind: "posted",
			attemptId: row.id,
			socialPostId: row.socialPostId,
			externalUrl: row.receipt.externalUrl,
		};
	}
	if (row.phase === "failed") {
		return {
			kind: "failed",
			attemptId: row.id,
			socialPostId: row.socialPostId,
			code: row.failureCode ?? "social_publish_failed",
		};
	}
	if (row.phase === "needs_attention") {
		return {
			kind: "needs_attention",
			attemptId: row.id,
			socialPostId: row.socialPostId,
			code: row.failureCode ?? "publication_outcome_unknown",
		};
	}
	return null;
}

function rowToLoadedAttempt(
	row: PublicationAttemptRow,
): LoadedPublicationAttempt {
	const claim = row.currentClaimId
		? (row.claims.find((candidate) => candidate.id === row.currentClaimId) ??
			null)
		: null;
	return {
		socialPost: {
			id: row.socialPost.id,
			workspaceId: row.socialPost.workspaceId!,
			projectId: row.socialPost.projectId,
			status: row.socialPost
				.status as LoadedPublicationAttempt["socialPost"]["status"],
			scheduledFor: row.socialPost.scheduledFor!,
			nextAttemptAt: row.socialPost.nextAttemptAt,
			externalUrl: row.socialPost.externalUrl,
			errorCode: row.socialPost.errorCode,
		},
		frozen: {
			clipExportId: row.frozenState.clipExportId,
			clipExportVariantId: row.frozenState.clipExportVariantId,
			editorRevision: row.frozenState.editorRevision,
			exportFingerprint: row.frozenState.exportFingerprint,
			storageKey: row.frozenState.storageKey,
			sizeBytes:
				row.frozenState.sizeBytes === null
					? null
					: Number(row.frozenState.sizeBytes),
			durationSec: row.frozenState.durationSec,
			aspectRatio:
				row.frozenState.aspectRatio === "ratio_9_16"
					? "9:16"
					: row.frozenState.aspectRatio === "ratio_1_1"
						? "1:1"
						: row.frozenState.aspectRatio === "ratio_16_9"
							? "16:9"
							: "4:5",
			caption: row.frozenState.caption,
			providerSettings:
				row.frozenState.providerSettings &&
				typeof row.frozenState.providerSettings === "object" &&
				!Array.isArray(row.frozenState.providerSettings)
					? (row.frozenState.providerSettings as Prisma.JsonObject)
					: {},
			socialAccountId: row.frozenState.socialAccountId,
			platform: row.frozenState.platform,
			capabilityVersion: row.frozenState.capabilityVersion,
			scheduledFor: row.frozenState.scheduledFor,
		},
		attempt: {
			id: row.id,
			attemptNumber: row.attemptNumber,
			priorAttemptId: row.priorAttemptId,
			idempotencyKey: row.idempotencyKey,
			phase: row.phase,
			outcome: row.outcome,
			nextActionAt: row.nextActionAt,
			providerCallCount: row.providerCallCount,
			startedAt: row.startedAt,
			phaseStartedAt: row.phaseStartedAt,
			processingDeadline: row.processingDeadline,
			reconciliationDeadline: row.reconciliationDeadline,
			failureCode: row.failureCode,
			failureDisposition: row.failureDisposition,
		},
		claim: claim
			? {
					id: claim.id,
					claimantId: claim.claimantId,
					leaseExpiresAt: claim.leaseExpiresAt,
					heartbeatAt: claim.heartbeatAt,
				}
			: null,
		sealedCheckpoint: row.checkpointEncrypted,
		checkpointKind: row.operationKind,
		terminalResult: rowExecutionResult(row),
	};
}

async function requireCurrentClaim(
	tx: Prisma.TransactionClient,
	owned: OwnedPublicationAttempt,
	now: Date,
) {
	const attempt = await tx.socialPublicationAttempt.findFirst({
		where: { id: owned.attemptId, currentClaimId: owned.claimId },
		select: { id: true },
	});
	const claim = attempt
		? await tx.publicationClaim.findFirst({
				where: {
					id: owned.claimId,
					attemptId: owned.attemptId,
					releasedAt: null,
					leaseExpiresAt: { gt: now },
				},
				select: { id: true },
			})
		: null;
	if (!attempt || !claim) throw new PublicationClaimLostError();
}

async function releaseCurrentClaim(
	tx: Prisma.TransactionClient,
	owned: OwnedPublicationAttempt,
	now: Date,
) {
	await tx.publicationClaim.updateMany({
		where: {
			id: owned.claimId,
			attemptId: owned.attemptId,
			releasedAt: null,
		},
		data: { releasedAt: now, accountSlotKey: null },
	});
	await tx.socialPublicationAttempt.updateMany({
		where: { id: owned.attemptId, currentClaimId: owned.claimId },
		data: { currentClaimId: null },
	});
}

export class ProviderReceiptConflictError extends Error {
	readonly code = "provider_receipt_conflict";

	constructor() {
		super(
			"Provider evidence conflicts with the receipt already stored for this attempt",
		);
		this.name = "ProviderReceiptConflictError";
	}
}

export const prismaSocialPublicationAttemptStore: SocialPublicationAttemptStore =
	{
		async loadOwned(owned, now) {
			const row = await requirePrisma().socialPublicationAttempt.findUnique({
				where: { id: owned.attemptId },
				include: publicationAttemptInclude,
			});
			if (!row) throw new PublicationClaimLostError();
			const terminal = rowExecutionResult(row);
			if (!terminal) {
				const claim = row.claims.find(
					(candidate) => candidate.id === owned.claimId,
				);
				if (
					row.currentClaimId !== owned.claimId ||
					!claim ||
					claim.releasedAt ||
					claim.leaseExpiresAt <= now
				) {
					throw new PublicationClaimLostError();
				}
			}
			return rowToLoadedAttempt(row);
		},

		async checkpoint(input) {
			await requirePrisma().$transaction(async (tx) => {
				await requireCurrentClaim(tx, input.owned, input.now);
				const updated = await tx.socialPublicationAttempt.updateMany({
					where: {
						id: input.owned.attemptId,
						currentClaimId: input.owned.claimId,
					},
					data: {
						phase:
							input.operationKind === "submission_started"
								? "submission_started"
								: undefined,
						phaseStartedAt:
							input.operationKind === "submission_started"
								? input.now
								: undefined,
						operationKind: input.operationKind,
						checkpointEncrypted: input.sealedState,
						operationLookupHash: input.operationLookupHash,
					},
				});
				if (updated.count !== 1) throw new PublicationClaimLostError();
			});
		},

		async recordProviderCall(input) {
			await requirePrisma().$transaction(async (tx) => {
				await requireCurrentClaim(tx, input.owned, input.now);
				const updated = await tx.socialPublicationAttempt.updateMany({
					where: {
						id: input.owned.attemptId,
						currentClaimId: input.owned.claimId,
						providerCallCount: { lt: input.maximum },
					},
					data: { providerCallCount: { increment: 1 } },
				});
				if (updated.count !== 1) {
					throw new PublicationProviderCallBudgetError();
				}
			});
		},

		async settleAccepted(input) {
			try {
				return await requirePrisma().$transaction(async (tx) => {
					const row = await tx.socialPublicationAttempt.findUnique({
						where: { id: input.owned.attemptId },
						include: publicationAttemptInclude,
					});
					if (!row) throw new PublicationClaimLostError();
					if (row.phase === "succeeded" && row.receipt) {
						if (
							row.receipt.receiptId !== input.result.receipt.receiptId ||
							(row.receipt.platformPostId &&
								input.result.receipt.platformPostId &&
								row.receipt.platformPostId !==
									input.result.receipt.platformPostId)
						) {
							throw new ProviderReceiptConflictError();
						}
						return rowExecutionResult(row)!;
					}
					await requireCurrentClaim(tx, input.owned, input.now);
					await tx.providerReceipt.create({
						data: {
							attemptId: row.id,
							platform: row.frozenState.platform,
							receiptId: input.result.receipt.receiptId,
							platformPostId: input.result.receipt.platformPostId,
							externalUrl: input.result.receipt.externalUrl,
							metrics: input.result.receipt.metrics
								? (input.result.receipt.metrics as Prisma.InputJsonValue)
								: Prisma.JsonNull,
							providerProcessingStatus:
								input.result.receipt.providerProcessingStatus ?? null,
							providerProcessingFailureCode:
								input.result.receipt.providerProcessingFailureCode ?? null,
							providerVisibility:
								input.result.receipt.providerVisibility ?? null,
							enrichmentNextCheckAt:
								input.result.receipt.providerProcessingStatus === "processing"
									? new Date(input.now.getTime() + 30_000)
									: null,
							enrichedAt:
								input.result.receipt.providerProcessingStatus &&
								input.result.receipt.providerProcessingStatus !== "processing"
									? input.now
									: null,
						},
					});
					await tx.publicationAnalyticsIntent.create({
						data: {
							attemptId: row.id,
							socialPostId: row.socialPostId,
							projectId: row.socialPost.projectId,
							kind: "social_posted",
							payload: {
								platform: row.frozenState.platform,
								receiptId: input.result.receipt.receiptId,
							},
							deliveredAt: input.now,
						},
					});
					await tx.projectAnalyticsEvent.create({
						data: {
							projectId: row.socialPost.projectId,
							clipId: row.socialPost.clipId,
							type: "social_posted",
							platform: row.frozenState.platform,
							metadata: {
								socialPostId: row.socialPostId,
								attemptId: row.id,
								receiptId: input.result.receipt.receiptId,
							},
						},
					});
					if (input.result.receipt.metrics) {
						const metrics = input.result.receipt.metrics;
						await tx.socialPostMetric.create({
							data: {
								projectId: row.socialPost.projectId,
								postId: row.socialPostId,
								platform: row.frozenState.platform,
								views: metrics.views,
								likes: metrics.likes,
								comments: metrics.comments,
								shares: metrics.shares,
								saves: metrics.saves,
								watchTimeSeconds: metrics.watchTimeSeconds ?? null,
								capturedAt: metrics.capturedAt
									? new Date(metrics.capturedAt)
									: input.now,
								metadata: metrics.metadata
									? (metrics.metadata as Prisma.InputJsonValue)
									: Prisma.JsonNull,
							},
						});
					}
					await tx.socialPublicationAttempt.update({
						where: { id: row.id },
						data: {
							phase: "succeeded",
							outcome: "accepted",
							failureCode: null,
							failureDisposition: null,
							terminalAt: input.now,
						},
					});
					await tx.socialPost.update({
						where: { id: row.socialPostId },
						data: {
							status: "posted",
							postedAt: input.now,
							externalUrl: input.result.receipt.externalUrl,
							errorCode:
								input.result.receipt.providerProcessingFailureCode ?? null,
							errorDisposition: input.result.receipt.providerProcessingFailureCode
								? "permanent"
								: null,
							nextAttemptAt: null,
						},
					});
					await releaseCurrentClaim(tx, input.owned, input.now);
					return {
						kind: "posted",
						attemptId: row.id,
						socialPostId: row.socialPostId,
						externalUrl: input.result.receipt.externalUrl,
					};
				});
			} catch (error) {
				if (
					error instanceof Prisma.PrismaClientKnownRequestError &&
					error.code === "P2002"
				) {
					throw new ProviderReceiptConflictError();
				}
				throw error;
			}
		},

		async settlePending(input) {
			return requirePrisma().$transaction(async (tx) => {
				await requireCurrentClaim(tx, input.owned, input.now);
				const current = await tx.socialPublicationAttempt.findUniqueOrThrow({
					where: { id: input.owned.attemptId },
					select: { processingDeadline: true, phase: true },
				});
				const nextActionAt = new Date(
					Math.min(
						input.result.nextCheckAt.getTime(),
						current.processingDeadline.getTime(),
					),
				);
				const nextPhase =
					input.result.submissionStarted === false ? "uploading" : "processing";
				const row = await tx.socialPublicationAttempt.update({
					where: { id: input.owned.attemptId },
					data: {
						phase: nextPhase,
						outcome: "pending",
						phaseStartedAt:
							current.phase === nextPhase ? undefined : input.now,
						nextActionAt,
						operationKind: input.result.operation.kind,
						checkpointEncrypted: input.sealedState,
						operationLookupHash: input.operationLookupHash,
					},
					select: { id: true, socialPostId: true },
				});
				await tx.socialPost.update({
					where: { id: row.socialPostId },
					data: {
						status: "processing",
						nextAttemptAt: nextActionAt,
					},
				});
				await releaseCurrentClaim(tx, input.owned, input.now);
				return {
					kind: "processing",
					attemptId: row.id,
					socialPostId: row.socialPostId,
					nextActionAt,
				};
			});
		},

		async settleUnknown(input) {
			return requirePrisma().$transaction(async (tx) => {
				await requireCurrentClaim(tx, input.owned, input.now);
				const current = await tx.socialPublicationAttempt.findUniqueOrThrow({
					where: { id: input.owned.attemptId },
					select: { phase: true },
				});
				const phase = input.canReconcile ? "reconciling" : "needs_attention";
				const row = await tx.socialPublicationAttempt.update({
					where: { id: input.owned.attemptId },
					data: {
						phase,
						outcome: "unknown",
						phaseStartedAt: current.phase === phase ? undefined : input.now,
						failureCode: input.code,
						failureDisposition: "attention",
						operationKind: input.operation?.kind,
						checkpointEncrypted: input.sealedState,
						nextActionAt: input.nextActionAt ?? input.now,
						terminalAt: input.canReconcile ? null : input.now,
					},
					select: { id: true, socialPostId: true },
				});
				await tx.socialPost.update({
					where: { id: row.socialPostId },
					data: {
						status: input.canReconcile ? "reconciling" : "needs_attention",
						errorCode: input.code,
						errorDisposition: "attention",
						nextAttemptAt: input.nextActionAt,
					},
				});
				await releaseCurrentClaim(tx, input.owned, input.now);
				return input.canReconcile && input.nextActionAt
					? {
							kind: "reconciling",
							attemptId: row.id,
							socialPostId: row.socialPostId,
							nextActionAt: input.nextActionAt,
						}
					: {
							kind: "needs_attention",
							attemptId: row.id,
							socialPostId: row.socialPostId,
							code: input.code,
						};
			});
		},

		async settleFailed(input) {
			return requirePrisma().$transaction(async (tx) => {
				await requireCurrentClaim(tx, input.owned, input.now);
				const row = await tx.socialPublicationAttempt.findUniqueOrThrow({
					where: { id: input.owned.attemptId },
					include: { socialPost: true, frozenState: true },
				});
				const needsAttention =
					input.disposition === "attention" ||
					(input.disposition === "safe_retry" &&
						input.submissionMayHaveStarted);
				if (needsAttention) {
					await tx.socialPublicationAttempt.update({
						where: { id: row.id },
						data: {
							phase: "needs_attention",
							outcome: input.submissionMayHaveStarted ? "unknown" : "failed",
							failureCode: input.code,
							failureEvidence: input.failureEvidence,
							failureDisposition: "attention",
							terminalAt: input.now,
						},
					});
					await tx.socialPost.update({
						where: { id: row.socialPostId },
						data: {
							status: "needs_attention",
							errorCode: input.code,
							errorDisposition: "attention",
							nextAttemptAt: null,
						},
					});
					await releaseCurrentClaim(tx, input.owned, input.now);
					return {
						kind: "needs_attention",
						attemptId: row.id,
						socialPostId: row.socialPostId,
						code: input.code,
					};
				}
				const lineageStart = await tx.socialPublicationAttempt.findFirstOrThrow(
					{
						where: { socialPostId: row.socialPostId },
						orderBy: [{ attemptNumber: "asc" }, { startedAt: "asc" }],
						select: { startedAt: true },
					},
				);
				const retryCandidate =
					input.disposition === "safe_retry" &&
					!input.submissionMayHaveStarted &&
					row.attemptNumber < input.retry.maxAttempts;
				const nextActionAt = retryCandidate
					? retryActionAt({
							now: input.now,
							attemptNumber: row.attemptNumber,
							retryAfterMs: input.retryAfterMs,
							retry: input.retry,
						})
					: null;
				const lineageDeadline =
					lineageStart.startedAt.getTime() + input.retry.maxElapsedMs;
				await tx.socialPublicationAttempt.update({
					where: { id: row.id },
					data: {
						phase: "failed",
						outcome: "failed",
						failureCode: input.code,
						failureEvidence: input.failureEvidence,
						failureDisposition: input.disposition,
						terminalAt: input.now,
					},
				});
				if (nextActionAt && nextActionAt.getTime() <= lineageDeadline) {
					const nextAttemptId = randomUUID();
					await tx.socialPublicationAttempt.create({
						data: {
							id: nextAttemptId,
							socialPostId: row.socialPostId,
							frozenStateId: row.frozenStateId,
							attemptNumber: row.attemptNumber + 1,
							priorAttemptId: row.id,
							idempotencyKey: `${row.idempotencyKey}:retry:${row.attemptNumber + 1}`,
							phase: "retry_scheduled",
							nextActionAt,
							processingDeadline: new Date(
								nextActionAt.getTime() + input.processingDeadlineMs,
							),
							reconciliationDeadline: new Date(
								nextActionAt.getTime() + input.reconciliationDeadlineMs,
							),
						},
					});
					await tx.socialPost.update({
						where: { id: row.socialPostId },
						data: {
							status: "scheduled",
							errorCode: input.code,
							errorDisposition: input.disposition,
							nextAttemptAt: nextActionAt,
						},
					});
					await releaseCurrentClaim(tx, input.owned, input.now);
					return {
						kind: "retry_scheduled",
						attemptId: row.id,
						socialPostId: row.socialPostId,
						nextAttemptId,
						nextActionAt,
					};
				}
				await tx.socialPost.update({
					where: { id: row.socialPostId },
					data: {
						status: "failed",
						errorCode: input.code,
						errorDisposition: input.disposition,
						nextAttemptAt: null,
					},
				});
				await tx.publicationAnalyticsIntent.upsert({
					where: { attemptId: row.id },
					create: {
						attemptId: row.id,
						socialPostId: row.socialPostId,
						projectId: row.socialPost.projectId,
						kind: "social_failed",
						payload: { code: input.code, disposition: input.disposition },
					},
					update: {},
				});
				await releaseCurrentClaim(tx, input.owned, input.now);
				return {
					kind: "failed",
					attemptId: row.id,
					socialPostId: row.socialPostId,
					code: input.code,
				};
			});
		},

		async releaseInterrupted(input) {
			return requirePrisma().$transaction(async (tx) => {
				await requireCurrentClaim(tx, input.owned, input.now);
				const row = await tx.socialPublicationAttempt.findUniqueOrThrow({
					where: { id: input.owned.attemptId },
					select: { id: true, socialPostId: true, phase: true },
				});
				await tx.socialPublicationAttempt.update({
					where: { id: row.id },
					data: { nextActionAt: input.now },
				});
				if (row.phase === "claimed") {
					await tx.socialPost.update({
						where: { id: row.socialPostId },
						data: { status: "scheduled", nextAttemptAt: input.now },
					});
				}
				await releaseCurrentClaim(tx, input.owned, input.now);
				return {
					kind: "interrupted",
					attemptId: row.id,
					socialPostId: row.socialPostId,
				};
			});
		},
	};

export type PublicationClaimConfig = {
	batchSize: number;
	leaseMs: number;
	processingDeadlineMs: number;
	reconciliationDeadlineMs: number;
	providerCallBudget: number;
};

const publicationClaimCandidateInclude = {
	socialPost: { include: { workspace: true } },
	frozenState: { include: { socialAccount: true } },
	claims: { orderBy: { createdAt: "desc" as const }, take: 1 },
};

type PublicationClaimCandidate = Prisma.SocialPublicationAttemptGetPayload<{
	include: typeof publicationClaimCandidateInclude;
}>;

class PublicationClaimAdmissionRaceError extends Error {}

export async function synchronizePreparedSocialPosts(now = new Date()) {
	const prisma = requirePrisma();
	const states = await prisma.frozenPublicationState.findMany({
		where: {
			socialPost: { status: "preparing_video" },
			OR: [
				{
					clipExportVariant: { status: "completed", storageKey: { not: null } },
				},
				{ clipExportVariant: { status: "failed" } },
			],
		},
		include: { clipExportVariant: true },
	});
	for (const state of states) {
		if (
			state.clipExportVariant.status === "completed" &&
			state.clipExportVariant.storageKey &&
			state.clipExportVariant.sizeBytes !== null &&
			state.clipExportVariant.durationSec !== null
		) {
			await prisma.$transaction(async (tx) => {
				await tx.frozenPublicationState.updateMany({
					where: { id: state.id, storageKey: null },
					data: {
						storageKey: state.clipExportVariant.storageKey,
						sizeBytes: state.clipExportVariant.sizeBytes,
						durationSec: state.clipExportVariant.durationSec,
						mediaReadyAt: now,
					},
				});
				await tx.socialPost.updateMany({
					where: { id: state.socialPostId, status: "preparing_video" },
					data: { status: "scheduled" },
				});
			});
		} else if (
			state.clipExportVariant.status === "failed" ||
			state.clipExportVariant.status === "completed"
		) {
			await prisma.socialPost.updateMany({
				where: { id: state.socialPostId, status: "preparing_video" },
				data: {
					status: "failed",
					errorCode:
						state.clipExportVariant.errorCode ??
						(state.clipExportVariant.status === "completed"
							? "publication_media_duration_missing"
							: "publication_media_preparation_failed"),
					errorDisposition: "permanent",
				},
			});
		}
	}
	return states.length;
}

export async function claimDueSocialPublicationAttempts(input: {
	claimantId: string;
	now: Date;
	config: PublicationClaimConfig;
	createId?: () => string;
	metrics?: SocialPublicationMetrics;
}): Promise<OwnedPublicationAttempt[]> {
	const prisma = requirePrisma();
	const createId = input.createId ?? randomUUID;
	await synchronizePreparedSocialPosts(input.now);

	const duePosts = await prisma.socialPost.findMany({
		where: {
			status: "scheduled",
			scheduledFor: { lte: input.now },
			OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: input.now } }],
			workspace: { status: "active" },
			frozenState: {
				is: {
					storageKey: { not: null },
					sizeBytes: { not: null },
					durationSec: { not: null },
				},
			},
			publicationAttempts: { none: {} },
		},
		include: { frozenState: true },
		orderBy: [{ scheduledFor: "asc" }, { id: "asc" }],
		take: input.config.batchSize * 3,
	});
	for (const post of duePosts) {
		if (!post.frozenState) continue;
		await prisma
			.$transaction(async (tx) => {
				const [locked] = await tx.$queryRaw<Array<{ status: string }>>`
          SELECT "status"::text AS "status"
          FROM "SocialPost"
          WHERE "id" = ${post.id}::uuid
          FOR UPDATE
        `;
				if (locked?.status !== "scheduled") return;
				await tx.socialPublicationAttempt.create({
					data: {
						id: createId(),
						socialPostId: post.id,
						frozenStateId: post.frozenState!.id,
						attemptNumber: 1,
						idempotencyKey: `publication:${post.id}:1`,
						phase: "retry_scheduled",
						nextActionAt: input.now,
						processingDeadline: new Date(
							input.now.getTime() + input.config.processingDeadlineMs,
						),
						reconciliationDeadline: new Date(
							input.now.getTime() + input.config.reconciliationDeadlineMs,
						),
					},
				});
			})
			.catch((error) => {
				if (
					!(
						error instanceof Prisma.PrismaClientKnownRequestError &&
						error.code === "P2002"
					)
				) {
					throw error;
				}
			});
	}

	const owned: OwnedPublicationAttempt[] = [];
	const pageSize = Math.max(20, input.config.batchSize * 4);
	const maximumScan = 5_000;
	let scanned = 0;
	let cursor: { nextActionAt: Date; id: string } | null = null;
	while (owned.length < input.config.batchSize && scanned < maximumScan) {
		const candidates: PublicationClaimCandidate[] =
			await prisma.socialPublicationAttempt.findMany({
				where: {
					phase: {
						in: [
							"claimed",
							"preparing",
							"uploading",
							"submission_started",
							"processing",
							"reconciling",
							"retry_scheduled",
						],
					},
					nextActionAt: { lte: input.now },
					...(cursor
						? {
								OR: [
									{ nextActionAt: { gt: cursor.nextActionAt } },
									{
										nextActionAt: cursor.nextActionAt,
										id: { gt: cursor.id },
									},
								],
							}
						: {}),
				},
				include: publicationClaimCandidateInclude,
				orderBy: [{ nextActionAt: "asc" }, { id: "asc" }],
				take: Math.min(pageSize, maximumScan - scanned),
			});
		if (candidates.length === 0) break;
		const lastCandidate = candidates.at(-1)!;
		cursor = {
			nextActionAt: lastCandidate.nextActionAt,
			id: lastCandidate.id,
		};
		scanned += candidates.length;
		for (const candidate of candidates) {
			if (owned.length >= input.config.batchSize) break;
			const submitted =
				candidate.phase === "submission_started" ||
				candidate.phase === "processing" ||
				candidate.phase === "reconciling";
			if (!submitted && candidate.socialPost.workspace?.status !== "active")
				continue;
			const claimId = createId();
			let leaseTakenOver = false;
			try {
				const claimed = await prisma.$transaction(async (tx) => {
					const current = await tx.socialPublicationAttempt.findUnique({
						where: { id: candidate.id },
						include: {
							socialPost: { select: { status: true } },
							frozenState: {
								select: { socialAccount: { select: { status: true } } },
							},
							claims: { orderBy: { createdAt: "desc" }, take: 1 },
						},
					});
					if (!current) return false;
					const currentSubmitted =
						current.phase === "submission_started" ||
						current.phase === "processing" ||
						current.phase === "reconciling";
					const expectedPreSubmissionStatus =
						current.phase === "retry_scheduled"
							? "scheduled"
							: current.phase === "uploading"
								? "processing"
								: "publishing";
					if (
						!currentSubmitted &&
						current.socialPost.status !== expectedPreSubmissionStatus
					) {
						return false;
					}
					if (current.currentClaimId) {
						const active = current.claims.find(
							(claim) => claim.id === current.currentClaimId,
						);
						if (
							active &&
							!active.releasedAt &&
							active.leaseExpiresAt > input.now
						) {
							return false;
						}
						leaseTakenOver = true;
						await tx.publicationClaim.updateMany({
							where: { id: current.currentClaimId, releasedAt: null },
							data: { releasedAt: input.now, accountSlotKey: null },
						});
						await tx.socialPublicationAttempt.updateMany({
							where: { id: current.id, currentClaimId: current.currentClaimId },
							data: { currentClaimId: null },
						});
					}
					const providerBudgetExhausted =
						current.providerCallCount >= input.config.providerCallBudget;
					const phaseDeadlineExceeded =
						current.phase === "processing" || current.phase === "uploading"
							? current.processingDeadline <= input.now
							: currentSubmitted
								? current.reconciliationDeadline <= input.now
								: false;
					const accountUnavailable =
						!currentSubmitted &&
						current.frozenState.socialAccount !== null &&
						current.frozenState.socialAccount.status !== "active";
					if (
						providerBudgetExhausted ||
						phaseDeadlineExceeded ||
						accountUnavailable
					) {
						const code = accountUnavailable
							? "social_account_reconnect_required"
							: providerBudgetExhausted
								? "publication_provider_call_budget_exhausted"
								: current.phase === "processing" || current.phase === "uploading"
									? "publication_processing_deadline_exceeded"
									: "publication_reconciliation_deadline_exceeded";
						const terminalAttempt =
							await tx.socialPublicationAttempt.updateMany({
								where: {
									id: current.id,
									currentClaimId: null,
									phase: current.phase,
								},
								data: {
									phase: currentSubmitted ? "needs_attention" : "failed",
									outcome: currentSubmitted ? "unknown" : "failed",
									failureCode: code,
									failureDisposition: currentSubmitted
										? "attention"
										: "permanent",
									terminalAt: input.now,
								},
							});
						if (terminalAttempt.count !== 1) return false;
						const terminalPost = await tx.socialPost.updateMany({
							where: {
								id: current.socialPostId,
								status: current.socialPost.status,
							},
							data: {
								status: currentSubmitted ? "needs_attention" : "failed",
								errorCode: code,
								errorDisposition: currentSubmitted ? "attention" : "permanent",
								nextAttemptAt: null,
							},
						});
						if (terminalPost.count !== 1) {
							throw new PublicationClaimAdmissionRaceError();
						}
						return false;
					}
					await tx.publicationClaim.create({
						data: {
							id: claimId,
							attemptId: current.id,
							claimantId: input.claimantId,
							accountSlotKey: currentSubmitted
								? null
								: candidate.frozenState.socialAccountId,
							heartbeatAt: input.now,
							leaseExpiresAt: new Date(
								input.now.getTime() + input.config.leaseMs,
							),
						},
					});
					const updated = await tx.socialPublicationAttempt.updateMany({
						where: { id: current.id, currentClaimId: null },
						data: {
							currentClaimId: claimId,
							phase:
								current.phase === "retry_scheduled" ? "claimed" : undefined,
						},
					});
					if (updated.count !== 1) {
						await tx.publicationClaim.delete({ where: { id: claimId } });
						return false;
					}
					const projected = await tx.socialPost.updateMany({
						where: {
							id: current.socialPostId,
							status: current.socialPost.status,
						},
						data: {
							status:
								current.phase === "processing" || current.phase === "uploading"
									? "processing"
									: current.phase === "reconciling"
										? "reconciling"
										: "publishing",
						},
					});
					if (projected.count !== 1) {
						await tx.publicationClaim.delete({ where: { id: claimId } });
						if (current.phase === "retry_scheduled") {
							await tx.socialPublicationAttempt.delete({
								where: { id: current.id },
							});
						} else {
							await tx.socialPublicationAttempt.updateMany({
								where: { id: current.id, currentClaimId: claimId },
								data: { currentClaimId: null },
							});
						}
						return false;
					}
					return true;
				});
				if (claimed) {
					owned.push({ attemptId: candidate.id, claimId });
					input.metrics?.observe("social_publication_claims_total", 1, {
						phase: candidate.phase,
					});
					if (leaseTakenOver) {
						input.metrics?.observe(
							"social_publication_lease_takeovers_total",
							1,
							{ phase: candidate.phase },
						);
					}
				}
			} catch (error) {
				if (error instanceof PublicationClaimAdmissionRaceError) continue;
				if (
					error instanceof Prisma.PrismaClientKnownRequestError &&
					error.code === "P2002"
				) {
					continue;
				}
				throw error;
			}
		}
		if (candidates.length < pageSize) break;
	}
	return owned;
}

export async function heartbeatSocialPublicationClaim(input: {
	owned: OwnedPublicationAttempt;
	now: Date;
	leaseMs: number;
	metrics?: SocialPublicationMetrics;
}) {
	const updated = await requirePrisma().$transaction(async (tx) => {
		await requireCurrentClaim(tx, input.owned, input.now);
		return tx.publicationClaim.updateMany({
			where: {
				id: input.owned.claimId,
				attemptId: input.owned.attemptId,
				releasedAt: null,
			},
			data: {
				heartbeatAt: input.now,
				leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs),
			},
		});
	});
	if (updated.count !== 1) throw new PublicationClaimLostError();
	input.metrics?.observe("social_publication_heartbeats_total", 1);
}

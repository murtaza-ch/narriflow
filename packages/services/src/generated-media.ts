import {
	createCipheriv,
	createDecipheriv,
	createHash,
	createHmac,
	randomBytes,
	randomUUID,
	timingSafeEqual,
} from "node:crypto";

import {
	generatedMediaSubmitSchema,
	resolvePricingTier,
	workspaceAllowsCapability,
	type GeneratedMediaAspectRatio,
	type GeneratedMediaKind,
	type GeneratedMediaPromptOrigin,
	type GeneratedMediaStyle,
	type GeneratedMediaSubmit,
	type GeneratedMediaSubmitInput,
} from "@narriflow/validators";

import { resolveBrandOwner, type BrandActorScope } from "./brand-ownership";
import {
	generationAccessForTier,
	generationUsageAvailability,
	generationUsageWindow,
	type GenerationUsageSummary,
	type GenerationUsageWindow,
} from "./generation-usage";

export type GeneratedMediaJobStatus =
	| "queued"
	| "running"
	| "waiting"
	| "reconciliation_required"
	| "completed"
	| "failed"
	| "rejected"
	| "cancelled";

export type GeneratedMediaModeration = {
	outcome: "pending" | "passed" | "rejected";
	stage?: "input" | "output" | "unknown";
	categories?: readonly string[];
};

export type GeneratedMediaProviderSource =
	| { kind: "inline"; contentType: string; bytes: Uint8Array }
	| { kind: "url"; url: string; headers?: Readonly<Record<string, string>> };

export type GeneratedMediaProviderOutcome =
	| {
			state: "completed";
			providerReference: string | null;
			resultReference: string;
			moderation: GeneratedMediaModeration;
			usage: { units: number };
	  }
	| {
			state: "waiting";
			providerReference: string;
			nextPollAt: Date;
			moderation: GeneratedMediaModeration;
	  }
	| {
			state: "rejected";
			providerReference: string | null;
			moderation: GeneratedMediaModeration;
			errorCode: "generated_media_rejected";
	  }
	| {
			state: "failed";
			providerReference: string | null;
			resultReference?: string;
			moderation?: GeneratedMediaModeration;
			usage?: { units: number };
			errorCode: string;
			retry: "safe" | "terminal" | "unknown";
	  };

export interface GeneratedMediaProvider {
	readonly alias: string;
	submit(input: {
		requestId: string;
		model: string;
		kind: GeneratedMediaKind;
		prompt: string;
		aspectRatio: GeneratedMediaAspectRatio;
		style: GeneratedMediaStyle;
		durationSec: number | null;
		seed: number | null;
		signal?: AbortSignal;
	}): Promise<GeneratedMediaProviderOutcome>;
	poll(input: {
		providerReference: string;
		model: string;
		kind: GeneratedMediaKind;
		signal?: AbortSignal;
	}): Promise<GeneratedMediaProviderOutcome>;
	cancel(input: {
		providerReference: string;
		model: string;
		kind: GeneratedMediaKind;
		signal?: AbortSignal;
	}): Promise<{ state: "cancelled" | "unsupported" | "unknown" }>;
	retrieve(input: {
		resultReference: string;
		model: string;
		kind: GeneratedMediaKind;
		signal?: AbortSignal;
	}): Promise<GeneratedMediaProviderSource>;
}

export interface GeneratedMediaEventSink {
	recordCompleted(input: {
		jobId: string;
		workspaceId: string;
		projectId: string;
		clipId: string | null;
		kind: GeneratedMediaKind;
		providerAlias: string;
		modelAlias: string;
		status: "completed";
		latencyMs: number;
		retryCount: number;
		moderationOutcome: GeneratedMediaModeration["outcome"];
		usageUnits: number;
	}): Promise<void>;
	recordInserted(input: {
		jobId: string;
		workspaceId: string;
		projectId: string;
		clipId: string | null;
		insertionAction: "broll" | "scene_block";
		planTier: "free" | "creator" | "pro" | "business";
		outcome: "succeeded";
	}): Promise<void>;
}

export type EnabledGeneratedMediaKindConfig = {
	enabled: true;
	provider: string;
	model: string;
	maxConcurrency: number;
	usageUnits: number;
	dailyUsageLimit?: number;
	dailyAbuseLimit?: number;
	maxOutputBytes: number;
	maxDurationSec?: number;
	supportedAspectRatios?: readonly GeneratedMediaAspectRatio[];
};

export type DisabledGeneratedMediaKindConfig = {
	enabled: false;
	reason: string;
};

export interface GeneratedMediaConfig {
	image: EnabledGeneratedMediaKindConfig | DisabledGeneratedMediaKindConfig;
	video: EnabledGeneratedMediaKindConfig | DisabledGeneratedMediaKindConfig;
	terminalPromptRetentionMs?: number;
}

export type GeneratedMediaPromptBinding = {
	workspaceId: string;
	projectId: string;
	clipId: string | null;
	kind: GeneratedMediaKind;
	idempotencyKey: string;
	requestFingerprint: string;
	promptFingerprint: string;
};

export type GeneratedMediaProtectedPrompt = {
	ciphertext: string;
	keyVersion: string;
};

export interface GeneratedMediaPromptProtection {
	seal(
		value: { prompt: string; derivedContext: string | null },
		binding: GeneratedMediaPromptBinding,
	): GeneratedMediaProtectedPrompt;
	open(
		value: GeneratedMediaProtectedPrompt,
		binding: GeneratedMediaPromptBinding,
	): { prompt: string; derivedContext: string | null };
	fingerprint(value: string): string;
}

function cryptoKey(value: string | Uint8Array, label: string) {
	const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
	if (bytes.byteLength < 32) {
		throw new Error(`${label} must contain at least 32 bytes of key material`);
	}
	return bytes.byteLength === 32 ? bytes : createHash("sha256").update(bytes).digest();
}

export function createGeneratedMediaPromptProtection(input: {
	activeKeyVersion: string;
	encryptionKeys: Readonly<Record<string, string | Uint8Array>>;
	fingerprintKey: string | Uint8Array;
}): GeneratedMediaPromptProtection {
	if (!/^[A-Za-z0-9._-]{1,64}$/.test(input.activeKeyVersion)) {
		throw new Error("Generated media prompt key version is invalid");
	}
	const encryptionKeys = new Map(
		Object.entries(input.encryptionKeys).map(([version, key]) => {
			if (!/^[A-Za-z0-9._-]{1,64}$/.test(version)) {
				throw new Error("Generated media prompt key version is invalid");
			}
			return [version, cryptoKey(key, `Generated media prompt key ${version}`)] as const;
		}),
	);
	const activeEncryptionKey = encryptionKeys.get(input.activeKeyVersion);
	if (!activeEncryptionKey) {
		throw new Error("Generated media active prompt key is missing");
	}
	const fingerprintKey = cryptoKey(
		input.fingerprintKey,
		"Generated media prompt fingerprint key",
	);
	if (
		[...encryptionKeys.values()].some((key) => timingSafeEqual(key, fingerprintKey))
	) {
		throw new Error("Generated media prompt protection keys must be independent");
	}
	const aad = (binding: GeneratedMediaPromptBinding) =>
		Buffer.from(
			JSON.stringify({
				workspaceId: binding.workspaceId,
				projectId: binding.projectId,
				clipId: binding.clipId,
				kind: binding.kind,
				idempotencyKey: binding.idempotencyKey,
				requestFingerprint: binding.requestFingerprint,
				promptFingerprint: binding.promptFingerprint,
			}),
			"utf8",
		);
	return {
		seal(value, binding) {
			const iv = randomBytes(12);
			const cipher = createCipheriv("aes-256-gcm", activeEncryptionKey, iv);
			cipher.setAAD(aad(binding));
			const ciphertext = Buffer.concat([
				cipher.update(JSON.stringify(value), "utf8"),
				cipher.final(),
			]);
			return {
				keyVersion: input.activeKeyVersion,
				ciphertext: [
					"v2",
					Buffer.from(input.activeKeyVersion, "utf8").toString("base64url"),
					iv.toString("base64url"),
					cipher.getAuthTag().toString("base64url"),
					ciphertext.toString("base64url"),
				].join(":"),
			};
		},
		open(value, binding) {
			try {
				const [format, encodedKeyVersion, iv, tag, ciphertext] =
					value.ciphertext.split(":");
				const encodedVersion = encodedKeyVersion
					? Buffer.from(encodedKeyVersion, "base64url").toString("utf8")
					: "";
				const encryptionKey = encryptionKeys.get(value.keyVersion);
				if (
					format !== "v2" ||
					encodedVersion !== value.keyVersion ||
					!encryptionKey ||
					!iv ||
					!tag ||
					!ciphertext
				) {
					throw new Error("invalid protected prompt envelope");
				}
				const decipher = createDecipheriv(
					"aes-256-gcm",
					encryptionKey,
					Buffer.from(iv, "base64url"),
				);
				decipher.setAAD(aad(binding));
				decipher.setAuthTag(Buffer.from(tag, "base64url"));
				const parsed = JSON.parse(
					Buffer.concat([
						decipher.update(Buffer.from(ciphertext, "base64url")),
						decipher.final(),
					]).toString("utf8"),
				) as unknown;
				if (
					!parsed ||
					typeof parsed !== "object" ||
					!("prompt" in parsed) ||
					typeof parsed.prompt !== "string" ||
					!("derivedContext" in parsed) ||
					(parsed.derivedContext !== null &&
						typeof parsed.derivedContext !== "string")
				) {
					throw new Error("invalid protected prompt payload");
				}
				return {
					prompt: parsed.prompt,
					derivedContext: parsed.derivedContext,
				};
			} catch {
				throw new GeneratedMediaError("generated_media_prompt_unreadable");
			}
		},
		fingerprint(value) {
			return createHmac("sha256", fingerprintKey).update(value).digest("hex");
		},
	};
}

export class GeneratedMediaError extends Error {
	constructor(
		readonly code:
			| "generated_media_forbidden"
			| "generated_media_not_entitled"
			| "generated_media_not_configured"
			| "generated_media_idempotency_conflict"
			| "generated_media_prompt_unreadable"
			| "generated_media_usage_exhausted"
			| "generated_media_not_found",
	) {
		super(code);
		this.name = "GeneratedMediaError";
	}
}

export interface GeneratedMediaJobView {
	id: string;
	workspaceId: string;
	projectId: string;
	clipId: string | null;
	kind: GeneratedMediaKind;
	status: GeneratedMediaJobStatus;
	provider: string;
	model: string;
	promptOrigin: GeneratedMediaPromptOrigin;
	aspectRatio: GeneratedMediaAspectRatio;
	style: GeneratedMediaStyle;
	durationSec: number | null;
	resultAssetId: string | null;
	insertionCount: number;
	lastInsertionKind: "broll" | "scene_block" | null;
	lastInsertedAt: string | null;
	errorCode: string | null;
	moderation: GeneratedMediaModeration;
	createdAt: string;
	updatedAt: string;
	replayed: boolean;
}

type StoredGeneratedMediaJob = Omit<
	GeneratedMediaJobView,
	"createdAt" | "updatedAt" | "replayed" | "lastInsertedAt"
> & {
	actorUserId: string;
	ownerUserId: string | null;
	ownerWorkspaceId: string | null;
	idempotencyKey: string;
	requestFingerprint: string;
	promptCiphertext: string | null;
	promptFingerprint: string;
	promptKeyVersion: string;
	seed: number | null;
	title: string | null;
	usageUnits: number;
	usageStatus: "reserved" | "finalized" | "released";
	finalizedUsageUnits: number;
	providerReference: string | null;
	resultReference: string | null;
	providerUsageUnits: number | null;
	attemptCount: number;
	claimId: string | null;
	claimExpiresAt: Date | null;
	submissionStartedAt: Date | null;
	nextAttemptAt: Date | null;
	nextPollAt: Date | null;
	cancelRequestedAt: Date | null;
	promptDeleteAfter: Date | null;
	stagedAsset: GeneratedMediaAssetDraft | null;
	lastInsertedAtDate: Date | null;
	createdAt: Date;
	updatedAt: Date;
};

export interface GeneratedMediaAssetDraft {
	storageKey: string;
	contentType:
		| "image/png"
		| "image/jpeg"
		| "image/webp"
		| "video/mp4"
		| "video/quicktime";
	sizeBytes: number;
	width: number;
	height: number;
	durationSec: number | null;
	hasAudio: boolean | null;
	videoCodec: string | null;
	audioCodec: string | null;
	fingerprint: string;
}

export interface GeneratedMediaAssetIngestor {
	ingest(input: {
		jobId: string;
		attemptId: string;
		projectId: string;
		clipId: string | null;
		storageKey: string;
		kind: GeneratedMediaKind;
		aspectRatio: GeneratedMediaAspectRatio;
		requestedDurationSec: number | null;
		source: GeneratedMediaProviderSource;
		maxOutputBytes: number;
		signal?: AbortSignal;
	}): Promise<GeneratedMediaAssetDraft>;
}

export interface GeneratedMediaClaim {
	jobId: string;
	claimId: string;
	workspaceId: string;
	projectId: string;
	clipId: string | null;
	actorUserId: string;
	ownerUserId: string | null;
	ownerWorkspaceId: string | null;
	kind: GeneratedMediaKind;
	provider: string;
	model: string;
	promptCiphertext: string;
	promptKeyVersion: string;
	idempotencyKey: string;
	requestFingerprint: string;
	promptFingerprint: string;
	promptOrigin: GeneratedMediaPromptOrigin;
	aspectRatio: GeneratedMediaAspectRatio;
	style: GeneratedMediaStyle;
	durationSec: number | null;
	seed: number | null;
	title: string | null;
	usageUnits: number;
	providerReference: string | null;
	resultReference: string | null;
	providerUsageUnits: number | null;
	moderation: GeneratedMediaModeration;
	attemptCount: number;
	priorStatus: GeneratedMediaJobStatus;
	submissionStartedAt: Date | null;
	cancelRequested: boolean;
	stagedAsset: GeneratedMediaAssetDraft | null;
	createdAt: Date;
}

export class GeneratedMediaClaimLost extends Error {
	constructor() {
		super("Generated media claim is no longer owned by this worker");
		this.name = "GeneratedMediaClaimLost";
	}
}

function toView(job: StoredGeneratedMediaJob, replayed = false): GeneratedMediaJobView {
	return {
		id: job.id,
		workspaceId: job.workspaceId,
		projectId: job.projectId,
		clipId: job.clipId,
		kind: job.kind,
		status: job.status,
		provider: job.provider,
		model: job.model,
		promptOrigin: job.promptOrigin,
		aspectRatio: job.aspectRatio,
		style: job.style,
		durationSec: job.durationSec,
		resultAssetId: job.resultAssetId,
		insertionCount: job.insertionCount,
		lastInsertionKind: job.lastInsertionKind,
		lastInsertedAt: job.lastInsertedAtDate?.toISOString() ?? null,
		errorCode: job.errorCode,
		moderation: job.moderation,
		createdAt: job.createdAt.toISOString(),
		updatedAt: job.updatedAt.toISOString(),
		replayed,
	};
}

export interface GeneratedMediaStore {
	readonly terminalAnalyticsDelivery?: "transactional";
	reserve(input: {
		scope: BrandActorScope;
		request: GeneratedMediaSubmit;
		provider: string;
		model: string;
		usageUnits: number;
		requestFingerprint: string;
		promptCiphertext: string;
		promptFingerprint: string;
		promptKeyVersion: string;
		usageWindow: GenerationUsageWindow;
		now: Date;
	}): Promise<{ job: GeneratedMediaJobView; replayed: boolean }>;
	usageSummary(
		scope: BrandActorScope,
		windows: Readonly<Record<GeneratedMediaKind, GenerationUsageWindow>>,
	): Promise<GenerationUsageSummary>;
	get(scope: BrandActorScope, jobId: string): Promise<GeneratedMediaJobView | null>;
	list(scope: BrandActorScope, projectId: string): Promise<GeneratedMediaJobView[]>;
	requestCancellation(input: {
		scope: BrandActorScope;
		jobId: string;
		now: Date;
		promptRetentionMs: number;
	}): Promise<GeneratedMediaJobView | null>;
	claimNext(input: {
		workerId: string;
		now: Date;
		leaseMs: number;
		enabledKinds: readonly GeneratedMediaKind[];
		maxConcurrency: Readonly<Partial<Record<GeneratedMediaKind, number>>>;
	}): Promise<GeneratedMediaClaim | null>;
	beginSubmission(input: {
		claim: GeneratedMediaClaim;
		now: Date;
		promptRetentionMs: number;
	}): Promise<"started" | "cancelled">;
	recordProviderResult(input: {
		claim: GeneratedMediaClaim;
		providerReference: string | null;
		resultReference: string;
		moderation: GeneratedMediaModeration;
		usageUnits: number;
		now: Date;
	}): Promise<void>;
	markWaiting(input: {
		claim: GeneratedMediaClaim;
		providerReference: string | null;
		nextPollAt: Date | null;
		moderation?: GeneratedMediaModeration;
		errorCode?: string | null;
		now: Date;
	}): Promise<void>;
	markReconciliationRequired(input: {
		claim: GeneratedMediaClaim;
		providerReference: string | null;
		resultReference: string | null;
		usageUnits: number | null;
		moderation: GeneratedMediaModeration | null;
		errorCode: string;
		now: Date;
		promptRetentionMs: number;
	}): Promise<void>;
	markRetry(input: {
		claim: GeneratedMediaClaim;
		nextAttemptAt: Date;
		errorCode: string;
		now: Date;
	}): Promise<void>;
	markTerminal(input: {
		claim: GeneratedMediaClaim;
		status: "failed" | "rejected" | "cancelled";
		errorCode: string | null;
		moderation?: GeneratedMediaModeration;
		now: Date;
		promptRetentionMs: number;
	}): Promise<void>;
	stageAsset(input: {
		claim: GeneratedMediaClaim;
		asset: GeneratedMediaAssetDraft;
		now: Date;
	}): Promise<void>;
	publishAsset(input: {
		claim: GeneratedMediaClaim;
		now: Date;
		promptRetentionMs: number;
	}): Promise<{ assetId: string; replayed: boolean }>;
	recordInsertion(input: {
		scope: BrandActorScope;
		jobId: string;
		kind: "broll" | "scene_block";
		now: Date;
	}): Promise<GeneratedMediaJobView | null>;
	purgeExpiredPrompts(now: Date, limit: number): Promise<number>;
}

export function createInMemoryGeneratedMediaStore(): GeneratedMediaStore {
	const jobs = new Map<string, StoredGeneratedMediaJob>();
	const assetIdsByOwnerFingerprint = new Map<string, string>();
	const terminalStatuses = new Set<GeneratedMediaJobStatus>([
		"completed",
		"failed",
		"rejected",
		"cancelled",
	]);
	const assertClaim = (claim: GeneratedMediaClaim) => {
		const job = jobs.get(claim.jobId);
		if (!job || job.claimId !== claim.claimId || job.status !== "running") {
			throw new GeneratedMediaClaimLost();
		}
		return job;
	};
	const release = (job: StoredGeneratedMediaJob) => {
		if (job.usageStatus === "reserved") job.usageStatus = "released";
	};
	const clearClaim = (job: StoredGeneratedMediaJob) => {
		job.claimId = null;
		job.claimExpiresAt = null;
	};
	return {
		async reserve(input) {
			const replay = [...jobs.values()].find(
				(job) =>
					job.workspaceId === input.scope.workspaceId &&
					job.idempotencyKey === input.request.idempotencyKey,
			);
			if (replay) {
				if (replay.requestFingerprint !== input.requestFingerprint) {
					throw new GeneratedMediaError("generated_media_idempotency_conflict");
				}
				return { job: toView(replay, true), replayed: true };
			}
			const allowanceJobs = [...jobs.values()]
				.filter(
					(job) =>
						job.workspaceId === input.scope.workspaceId &&
						job.kind === input.request.kind &&
						(input.usageWindow.allowance.startsAt === null ||
							job.createdAt >= input.usageWindow.allowance.startsAt) &&
						(input.usageWindow.allowance.endsAt === null ||
							job.createdAt < input.usageWindow.allowance.endsAt),
				);
			const committedUnits = allowanceJobs.reduce(
				(sum, job) =>
					sum +
					(job.usageStatus === "reserved"
						? job.usageUnits
						: job.usageStatus === "finalized"
							? job.finalizedUsageUnits
							: 0),
				0,
			);
			const dailyAdmittedUnits = [...jobs.values()]
				.filter(
					(job) =>
						job.workspaceId === input.scope.workspaceId &&
						job.kind === input.request.kind &&
						job.createdAt >= input.usageWindow.dailyAbuse.startsAt! &&
						job.createdAt < input.usageWindow.dailyAbuse.endsAt!,
				)
				.reduce((sum, job) => sum + job.usageUnits, 0);
			if (
				committedUnits + input.usageUnits >
					input.usageWindow.allowance.limitUnits ||
				dailyAdmittedUnits + input.usageUnits >
					input.usageWindow.dailyAbuse.limitUnits
			) {
				throw new GeneratedMediaError("generated_media_usage_exhausted");
			}
			const owner = resolveBrandOwner(input.scope);
			const stored: StoredGeneratedMediaJob = {
				id: randomUUID(),
				workspaceId: input.scope.workspaceId,
				projectId: input.request.projectId,
				clipId: input.request.clipId,
				actorUserId: input.scope.actorUserId,
				ownerUserId: owner.userId,
				ownerWorkspaceId: owner.workspaceId,
				kind: input.request.kind,
				status: "queued",
				provider: input.provider,
				model: input.model,
				promptOrigin: input.request.promptOrigin,
				aspectRatio: input.request.aspectRatio,
				style: input.request.style,
				durationSec: input.request.durationSec,
				resultAssetId: null,
				insertionCount: 0,
				lastInsertionKind: null,
				errorCode: null,
				moderation: { outcome: "pending" },
				idempotencyKey: input.request.idempotencyKey,
				requestFingerprint: input.requestFingerprint,
				promptCiphertext: input.promptCiphertext,
				promptFingerprint: input.promptFingerprint,
				promptKeyVersion: input.promptKeyVersion,
				seed: input.request.seed,
				title: input.request.title,
				usageUnits: input.usageUnits,
				usageStatus: "reserved",
				finalizedUsageUnits: 0,
				providerReference: null,
				resultReference: null,
				providerUsageUnits: null,
				attemptCount: 0,
				claimId: null,
				claimExpiresAt: null,
				submissionStartedAt: null,
				nextAttemptAt: input.now,
				nextPollAt: null,
				cancelRequestedAt: null,
				promptDeleteAfter: null,
				stagedAsset: null,
				lastInsertedAtDate: null,
				createdAt: input.now,
				updatedAt: input.now,
			};
			jobs.set(stored.id, stored);
			return { job: toView(stored), replayed: false };
		},
		async usageSummary(requestScope, windows) {
			const summarize = (kind: GeneratedMediaKind) => {
				const window = windows[kind];
				const allowanceJobs = [...jobs.values()].filter(
					(job) =>
						job.workspaceId === requestScope.workspaceId &&
						job.kind === kind &&
						(window.allowance.startsAt === null ||
							job.createdAt >= window.allowance.startsAt) &&
						(window.allowance.endsAt === null ||
							job.createdAt < window.allowance.endsAt),
				);
				const dailyJobs = [...jobs.values()].filter(
					(job) =>
						job.workspaceId === requestScope.workspaceId &&
						job.kind === kind &&
						job.createdAt >= window.dailyAbuse.startsAt! &&
						job.createdAt < window.dailyAbuse.endsAt!,
				);
				return generationUsageAvailability(window, {
					admittedUnits: dailyJobs.reduce((sum, job) => sum + job.usageUnits, 0),
					committedUnits: allowanceJobs.reduce(
						(sum, job) =>
							sum +
							(job.usageStatus === "reserved"
								? job.usageUnits
								: job.usageStatus === "finalized"
									? job.finalizedUsageUnits
									: 0),
						0,
					),
					reservedUnits: allowanceJobs
						.filter((job) => job.usageStatus === "reserved")
						.reduce((sum, job) => sum + job.usageUnits, 0),
					finalizedUnits: allowanceJobs
						.filter((job) => job.usageStatus === "finalized")
						.reduce((sum, job) => sum + job.finalizedUsageUnits, 0),
					releasedUnits: allowanceJobs
						.filter((job) => job.usageStatus === "released")
						.reduce((sum, job) => sum + job.usageUnits, 0),
				});
			};
			return { image: summarize("image"), video: summarize("video") };
		},
		async get(requestScope, jobId) {
			const job = jobs.get(jobId);
			return job?.workspaceId === requestScope.workspaceId ? toView(job) : null;
		},
		async list(requestScope, projectId) {
			return [...jobs.values()]
				.filter(
					(job) =>
						job.workspaceId === requestScope.workspaceId &&
						job.projectId === projectId,
				)
				.sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
				.map((job) => toView(job));
		},
		async requestCancellation(input) {
			const job = jobs.get(input.jobId);
			if (!job || job.workspaceId !== input.scope.workspaceId) return null;
			if (terminalStatuses.has(job.status)) return toView(job);
			job.cancelRequestedAt = input.now;
			if (job.status === "queued" && job.submissionStartedAt === null) {
				job.status = "cancelled";
				job.errorCode = "generated_media_cancelled";
				job.promptDeleteAfter = new Date(
					input.now.getTime() + input.promptRetentionMs,
				);
				release(job);
				clearClaim(job);
			} else if (job.status === "waiting" && job.providerReference) {
				job.nextPollAt = input.now;
			}
			job.updatedAt = input.now;
			return toView(job);
		},
		async claimNext(input) {
			const enabledKinds = new Set(input.enabledKinds);
			const job = [...jobs.values()]
				.filter((candidate) => {
					if (!enabledKinds.has(candidate.kind)) return false;
					if (candidate.status === "queued") {
						const active = [...jobs.values()].filter(
							(other) =>
								other.workspaceId === candidate.workspaceId &&
								other.kind === candidate.kind &&
								(other.status === "waiting" ||
									(other.status === "running" &&
										other.claimExpiresAt !== null &&
										other.claimExpiresAt > input.now)),
						).length;
						return (
							active < (input.maxConcurrency[candidate.kind] ?? 0) &&
							(!candidate.nextAttemptAt || candidate.nextAttemptAt <= input.now)
						);
					}
					if (candidate.status === "waiting") {
						return Boolean(
							candidate.providerReference &&
							candidate.nextPollAt &&
							candidate.nextPollAt <= input.now,
						);
					}
					return (
						candidate.status === "running" &&
						candidate.claimExpiresAt !== null &&
						candidate.claimExpiresAt <= input.now
					);
				})
				.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())[0];
			if (!job || !job.promptCiphertext) return null;
			const priorStatus = job.status;
			job.status = "running";
			job.claimId = randomUUID();
			job.claimExpiresAt = new Date(input.now.getTime() + input.leaseMs);
			job.attemptCount += 1;
			job.updatedAt = input.now;
			return {
				jobId: job.id,
				claimId: job.claimId,
				workspaceId: job.workspaceId,
				projectId: job.projectId,
				clipId: job.clipId,
				actorUserId: job.actorUserId,
				ownerUserId: job.ownerUserId,
				ownerWorkspaceId: job.ownerWorkspaceId,
				kind: job.kind,
				provider: job.provider,
				model: job.model,
				promptCiphertext: job.promptCiphertext,
				promptKeyVersion: job.promptKeyVersion,
				idempotencyKey: job.idempotencyKey,
				requestFingerprint: job.requestFingerprint,
				promptFingerprint: job.promptFingerprint,
				promptOrigin: job.promptOrigin,
				aspectRatio: job.aspectRatio,
				style: job.style,
				durationSec: job.durationSec,
				seed: job.seed,
				title: job.title,
				usageUnits: job.usageUnits,
				providerReference: job.providerReference,
				resultReference: job.resultReference,
				providerUsageUnits: job.providerUsageUnits,
				moderation: job.moderation,
				attemptCount: job.attemptCount,
				priorStatus,
				submissionStartedAt: job.submissionStartedAt,
				cancelRequested: job.cancelRequestedAt !== null,
				stagedAsset: job.stagedAsset,
				createdAt: job.createdAt,
			};
		},
		async beginSubmission(input) {
			const job = assertClaim(input.claim);
			if (job.cancelRequestedAt) {
				job.status = "cancelled";
				job.errorCode = "generated_media_cancelled";
				job.promptDeleteAfter = new Date(
					input.now.getTime() + input.promptRetentionMs,
				);
				release(job);
				clearClaim(job);
				job.updatedAt = input.now;
				return "cancelled";
			}
			job.submissionStartedAt ??= input.now;
			job.updatedAt = input.now;
			return "started";
		},
		async recordProviderResult(input) {
			const job = assertClaim(input.claim);
			job.providerReference = input.providerReference;
			job.resultReference = input.resultReference;
			job.providerUsageUnits = input.usageUnits;
			job.moderation = input.moderation;
			job.errorCode = null;
			job.updatedAt = input.now;
		},
		async markWaiting(input) {
			const job = assertClaim(input.claim);
			job.status = "waiting";
			job.providerReference = input.providerReference ?? job.providerReference;
			job.nextPollAt = input.nextPollAt;
			job.errorCode = input.errorCode ?? null;
			if (input.moderation) job.moderation = input.moderation;
			clearClaim(job);
			job.updatedAt = input.now;
		},
		async markReconciliationRequired(input) {
			const job = assertClaim(input.claim);
			job.status = "reconciliation_required";
			job.providerReference = input.providerReference;
			job.resultReference = input.resultReference;
			job.providerUsageUnits = input.usageUnits;
			if (input.moderation) job.moderation = input.moderation;
			job.nextPollAt = null;
			job.errorCode = input.errorCode;
			job.promptDeleteAfter = new Date(
				input.now.getTime() + input.promptRetentionMs,
			);
			clearClaim(job);
			job.updatedAt = input.now;
		},
		async markRetry(input) {
			const job = assertClaim(input.claim);
			job.status = "queued";
			job.nextAttemptAt = input.nextAttemptAt;
			job.errorCode = input.errorCode;
			if (!job.providerReference && !job.resultReference) {
				job.submissionStartedAt = null;
			}
			clearClaim(job);
			job.updatedAt = input.now;
		},
		async markTerminal(input) {
			const job = assertClaim(input.claim);
			job.status = input.status;
			job.errorCode = input.errorCode;
			if (input.moderation) job.moderation = input.moderation;
			job.promptDeleteAfter = new Date(
				input.now.getTime() + input.promptRetentionMs,
			);
			release(job);
			clearClaim(job);
			job.updatedAt = input.now;
		},
		async stageAsset(input) {
			const job = assertClaim(input.claim);
			job.stagedAsset = input.asset;
			job.updatedAt = input.now;
		},
		async publishAsset(input) {
			const job = assertClaim(input.claim);
			if (!job.stagedAsset || job.providerUsageUnits === null) {
				throw new Error("Generated media asset is not ready to publish");
			}
			if (job.providerUsageUnits < 0 || job.providerUsageUnits > job.usageUnits) {
				throw new Error("Generated media usage exceeds its reservation");
			}
			const owner = job.ownerWorkspaceId
				? `workspace:${job.ownerWorkspaceId}`
				: `user:${job.ownerUserId}`;
			const fingerprintKey = `${owner}:${job.stagedAsset.fingerprint}`;
			const existingAssetId = assetIdsByOwnerFingerprint.get(fingerprintKey);
			const replayed = job.resultAssetId !== null || existingAssetId !== undefined;
			job.resultAssetId ??= existingAssetId ?? randomUUID();
			assetIdsByOwnerFingerprint.set(fingerprintKey, job.resultAssetId);
			job.status = "completed";
			job.errorCode = null;
			job.resultReference = null;
			job.usageStatus = "finalized";
			job.finalizedUsageUnits = job.providerUsageUnits;
			job.promptDeleteAfter = new Date(
				input.now.getTime() + input.promptRetentionMs,
			);
			clearClaim(job);
			job.updatedAt = input.now;
			return { assetId: job.resultAssetId, replayed };
		},
		async recordInsertion(input) {
			const job = jobs.get(input.jobId);
			if (
				!job ||
				job.workspaceId !== input.scope.workspaceId ||
				job.status !== "completed" ||
				!job.resultAssetId
			) {
				return null;
			}
			job.insertionCount += 1;
			job.lastInsertionKind = input.kind;
			job.lastInsertedAtDate = input.now;
			job.updatedAt = input.now;
			return toView(job);
		},
		async purgeExpiredPrompts(now, limit) {
			let purged = 0;
			for (const job of jobs.values()) {
				if (
					purged >= limit ||
					!job.promptCiphertext ||
					!job.promptDeleteAfter ||
					job.promptDeleteAfter > now
				) {
					continue;
				}
				job.promptCiphertext = null;
				purged += 1;
			}
			return purged;
		},
	};
}

function requestFingerprintPayload(request: GeneratedMediaSubmit, promptFingerprint: string) {
	return JSON.stringify({
		projectId: request.projectId,
		clipId: request.clipId,
		kind: request.kind,
		promptFingerprint,
		promptOrigin: request.promptOrigin,
		aspectRatio: request.aspectRatio,
		style: request.style,
		durationSec: request.durationSec,
		seed: request.seed,
		title: request.title,
	});
}

function protectedPromptPayload(input: {
	prompt: string;
	derivedContext: string | null;
}) {
	return JSON.stringify({
		prompt: input.prompt,
		derivedContext: input.derivedContext,
	});
}

function promptBinding(input: {
	workspaceId: string;
	request: GeneratedMediaSubmit;
	requestFingerprint: string;
	promptFingerprint: string;
}): GeneratedMediaPromptBinding {
	return {
		workspaceId: input.workspaceId,
		projectId: input.request.projectId,
		clipId: input.request.clipId,
		kind: input.request.kind,
		idempotencyKey: input.request.idempotencyKey,
		requestFingerprint: input.requestFingerprint,
		promptFingerprint: input.promptFingerprint,
	};
}

function promptFingerprintMatches(expected: string, actual: string) {
	if (!/^[a-f0-9]{64}$/.test(expected) || !/^[a-f0-9]{64}$/.test(actual)) {
		return false;
	}
	return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
}

export class GeneratedMediaService {
	private readonly now: () => Date;
	private readonly promptProtection: GeneratedMediaPromptProtection;

	constructor(
		private readonly dependencies: {
			store: GeneratedMediaStore;
			providers: ReadonlyMap<string, GeneratedMediaProvider>;
			config: GeneratedMediaConfig;
			promptProtection?: GeneratedMediaPromptProtection;
			events?: GeneratedMediaEventSink;
			now?: () => Date;
		},
	) {
		this.now = dependencies.now ?? (() => new Date());
		if (!dependencies.promptProtection) {
			throw new Error("Generated media prompt protection is not configured");
		}
		this.promptProtection = dependencies.promptProtection;
	}

	private usageWindow(
		scope: BrandActorScope,
		kind: GeneratedMediaKind,
		now: Date,
	) {
		const kindConfig = this.dependencies.config[kind];
		return generationUsageWindow({
			tier: scope.pricingTier,
			kind,
			usageUnits: kindConfig.enabled ? kindConfig.usageUnits : 1,
			dailyLimitUnits: kindConfig.enabled
				? kindConfig.dailyUsageLimit
				: undefined,
			dailyAbuseLimitUnits: kindConfig.enabled
				? kindConfig.dailyAbuseLimit
				: undefined,
			now,
		});
	}

	async submit(scope: BrandActorScope, input: GeneratedMediaSubmitInput) {
		if (
			!workspaceAllowsCapability(
				{ role: scope.role, status: scope.status },
				"processing.consume",
			)
		) {
			throw new GeneratedMediaError("generated_media_forbidden");
		}
		const request = generatedMediaSubmitSchema.parse(input);
		if (!generationAccessForTier(scope.pricingTier, request.kind).entitled) {
			throw new GeneratedMediaError("generated_media_not_entitled");
		}
		const kindConfig = this.dependencies.config[request.kind];
		if (!kindConfig.enabled || !this.dependencies.providers.has(kindConfig.provider)) {
			throw new GeneratedMediaError("generated_media_not_configured");
		}
		if (
			request.kind === "video" &&
			(kindConfig.maxDurationSec === undefined ||
				request.durationSec === null ||
				request.durationSec > kindConfig.maxDurationSec)
		) {
			throw new GeneratedMediaError("generated_media_not_configured");
		}
		if (
			kindConfig.supportedAspectRatios &&
			!kindConfig.supportedAspectRatios.includes(request.aspectRatio)
		) {
			throw new GeneratedMediaError("generated_media_not_configured");
		}
		const now = this.now();
		const protectedPrompt = {
			prompt: request.prompt,
			derivedContext: request.derivedContext,
		};
		const promptFingerprint = this.promptProtection.fingerprint(
			protectedPromptPayload(protectedPrompt),
		);
		const requestFingerprint = this.promptProtection.fingerprint(
			requestFingerprintPayload(request, promptFingerprint),
		);
		const sealedPrompt = this.promptProtection.seal(
			protectedPrompt,
			promptBinding({
				workspaceId: scope.workspaceId,
				request,
				requestFingerprint,
				promptFingerprint,
			}),
		);
		const reserved = await this.dependencies.store.reserve({
			scope,
			request,
			provider: kindConfig.provider,
			model: kindConfig.model,
			usageUnits: kindConfig.usageUnits,
			requestFingerprint,
			promptCiphertext: sealedPrompt.ciphertext,
			promptFingerprint,
			promptKeyVersion: sealedPrompt.keyVersion,
			usageWindow: this.usageWindow(scope, request.kind, now),
			now,
		});
		return { ...reserved.job, replayed: reserved.replayed };
	}

	usageSummary(scope: BrandActorScope) {
		const now = this.now();
		return this.dependencies.store.usageSummary(scope, {
			image: this.usageWindow(scope, "image", now),
			video: this.usageWindow(scope, "video", now),
		});
	}

	async get(scope: BrandActorScope, jobId: string) {
		const job = await this.dependencies.store.get(scope, jobId);
		if (!job) throw new GeneratedMediaError("generated_media_not_found");
		return job;
	}

	list(scope: BrandActorScope, projectId: string) {
		return this.dependencies.store.list(scope, projectId);
	}

	async cancel(scope: BrandActorScope, jobId: string) {
		if (
			!workspaceAllowsCapability(
				{ role: scope.role, status: scope.status },
				"content.edit",
			)
		) {
			throw new GeneratedMediaError("generated_media_forbidden");
		}
		const job = await this.dependencies.store.requestCancellation({
			scope,
			jobId,
			now: this.now(),
			promptRetentionMs:
				this.dependencies.config.terminalPromptRetentionMs ??
				30 * 24 * 60 * 60 * 1000,
		});
		if (!job) throw new GeneratedMediaError("generated_media_not_found");
		return job;
	}

	async recordInsertion(
		scope: BrandActorScope,
		input: { jobId: string; kind: "broll" | "scene_block" },
	) {
		if (
			!workspaceAllowsCapability(
				{ role: scope.role, status: scope.status },
				"content.edit",
			)
		) {
			throw new GeneratedMediaError("generated_media_forbidden");
		}
		const job = await this.dependencies.store.recordInsertion({
			scope,
			...input,
			now: this.now(),
		});
		if (!job) throw new GeneratedMediaError("generated_media_not_found");
		await this.dependencies.events
			?.recordInserted({
				jobId: job.id,
				workspaceId: job.workspaceId,
				projectId: job.projectId,
				clipId: job.clipId,
				insertionAction: input.kind,
				planTier: resolvePricingTier(scope.pricingTier),
				outcome: "succeeded",
			});
		return job;
	}
}

function extensionForGeneratedMedia(contentType: string) {
	return (
		{
			"image/png": "png",
			"image/jpeg": "jpg",
			"image/webp": "webp",
			"video/mp4": "mp4",
			"video/quicktime": "mov",
		} as Readonly<Record<string, string>>
	)[contentType] ?? "bin";
}

function storageKeyForGeneratedMedia(
	claim: GeneratedMediaClaim,
	contentType: string,
) {
	const owner = claim.ownerWorkspaceId
		? `workspace/${claim.ownerWorkspaceId}`
		: `user/${claim.ownerUserId}`;
	return `generated-media/assets/${owner}/${claim.jobId}/${claim.claimId}.${extensionForGeneratedMedia(contentType)}`;
}

export class GeneratedMediaWorker {
	private readonly now: () => Date;
	private readonly leaseMs: number;
	private readonly retryDelayMs: (attemptCount: number) => number;
	private readonly promptRetentionMs: number;

	constructor(
		private readonly dependencies: {
			store: GeneratedMediaStore;
			providers: ReadonlyMap<string, GeneratedMediaProvider>;
			config: GeneratedMediaConfig;
			promptProtection: GeneratedMediaPromptProtection;
			ingestor: GeneratedMediaAssetIngestor;
			workerId: string;
			events?: GeneratedMediaEventSink;
			now?: () => Date;
			leaseMs?: number;
			retryDelayMs?: (attemptCount: number) => number;
		},
	) {
		this.now = dependencies.now ?? (() => new Date());
		this.leaseMs = dependencies.leaseMs ?? 15 * 60 * 1000;
		this.retryDelayMs =
			dependencies.retryDelayMs ??
			((attemptCount) => Math.min(60_000, 1_000 * 2 ** Math.min(attemptCount, 6)));
		this.promptRetentionMs =
			dependencies.config.terminalPromptRetentionMs ?? 30 * 24 * 60 * 60 * 1000;
	}

	async processNext(signal?: AbortSignal): Promise<0 | 1> {
		const enabledKinds = (["image", "video"] as const).filter((kind) => {
			const kindConfig = this.dependencies.config[kind];
			return (
				kindConfig.enabled &&
				this.dependencies.providers.has(kindConfig.provider)
			);
		});
		const maxConcurrency = Object.fromEntries(
			enabledKinds.map((kind) => {
				const kindConfig = this.dependencies.config[kind];
				return [kind, kindConfig.enabled ? kindConfig.maxConcurrency : 0];
			}),
		) as Partial<Record<GeneratedMediaKind, number>>;
		const claim = await this.dependencies.store.claimNext({
			workerId: this.dependencies.workerId,
			now: this.now(),
			leaseMs: this.leaseMs,
			enabledKinds,
			maxConcurrency,
		});
		if (!claim) return 0;

		const provider = this.dependencies.providers.get(claim.provider);
		const kindConfig = this.dependencies.config[claim.kind];
		if (!provider || !kindConfig.enabled) {
			await this.failTerminal(
				claim,
				"generated_media_provider_unavailable",
			);
			return 1;
		}

		if (claim.cancelRequested) {
			const handled = await this.handleCancellation(claim, provider, signal);
			if (handled) return 1;
		}

		if (claim.stagedAsset) {
			await this.publishAndRecord(claim);
			return 1;
		}

		if (claim.resultReference) {
			await this.ingestResult(claim, provider, kindConfig, signal);
			return 1;
		}

		if (claim.priorStatus === "waiting" && claim.providerReference) {
			let outcome: GeneratedMediaProviderOutcome;
			try {
				outcome = await provider.poll({
					providerReference: claim.providerReference,
					model: claim.model,
					kind: claim.kind,
					signal,
				});
			} catch {
				await this.waitUnknown(claim, claim.providerReference);
				return 1;
			}
			await this.applyProviderOutcome(claim, provider, kindConfig, outcome, signal);
			return 1;
		}

		if (claim.submissionStartedAt) {
			await this.waitUnknown(claim, claim.providerReference);
			return 1;
		}

		let protectedPrompt: ReturnType<GeneratedMediaPromptProtection["open"]>;
		try {
			protectedPrompt = this.dependencies.promptProtection.open(
				{
					ciphertext: claim.promptCiphertext,
					keyVersion: claim.promptKeyVersion,
				},
				promptBinding({
					workspaceId: claim.workspaceId,
					request: {
						idempotencyKey: claim.idempotencyKey,
						projectId: claim.projectId,
						clipId: claim.clipId,
						kind: claim.kind,
						prompt: "",
						derivedContext: null,
						promptOrigin: claim.promptOrigin,
						aspectRatio: claim.aspectRatio,
						style: claim.style,
						durationSec: claim.durationSec,
						seed: claim.seed,
						title: claim.title,
					},
					requestFingerprint: claim.requestFingerprint,
					promptFingerprint: claim.promptFingerprint,
				}),
			);
			const actualFingerprint = this.dependencies.promptProtection.fingerprint(
				protectedPromptPayload(protectedPrompt),
			);
			if (!promptFingerprintMatches(claim.promptFingerprint, actualFingerprint)) {
				throw new GeneratedMediaError("generated_media_prompt_unreadable");
			}
		} catch {
			await this.failTerminal(claim, "generated_media_prompt_unreadable");
			return 1;
		}
		const submission = await this.dependencies.store.beginSubmission({
			claim,
			now: this.now(),
			promptRetentionMs: this.promptRetentionMs,
		});
		if (submission === "cancelled") return 1;
		let outcome: GeneratedMediaProviderOutcome;
		try {
			outcome = await provider.submit({
				requestId: claim.jobId,
				model: claim.model,
				kind: claim.kind,
				prompt: protectedPrompt.derivedContext
					? `${protectedPrompt.prompt}\n\nContext:\n${protectedPrompt.derivedContext}`
					: protectedPrompt.prompt,
				aspectRatio: claim.aspectRatio,
				style: claim.style,
				durationSec: claim.durationSec,
				seed: claim.seed,
				signal,
			});
		} catch {
			await this.waitUnknown(claim, null);
			return 1;
		}
		await this.applyProviderOutcome(claim, provider, kindConfig, outcome, signal);
		return 1;
	}

	private async handleCancellation(
		claim: GeneratedMediaClaim,
		provider: GeneratedMediaProvider,
		signal?: AbortSignal,
	) {
		if (!claim.providerReference) {
			if (claim.submissionStartedAt) {
				await this.waitUnknown(claim, null);
				return true;
			}
			await this.dependencies.store.markTerminal({
				claim,
				status: "cancelled",
				errorCode: "generated_media_cancelled",
				now: this.now(),
				promptRetentionMs: this.promptRetentionMs,
			});
			return true;
		}
		let outcome: Awaited<ReturnType<GeneratedMediaProvider["cancel"]>>;
		try {
			outcome = await provider.cancel({
				providerReference: claim.providerReference,
				model: claim.model,
				kind: claim.kind,
				signal,
			});
		} catch {
			outcome = { state: "unknown" };
		}
		if (outcome.state === "cancelled") {
			await this.dependencies.store.markTerminal({
				claim,
				status: "cancelled",
				errorCode: "generated_media_cancelled",
				now: this.now(),
				promptRetentionMs: this.promptRetentionMs,
			});
			return true;
		}
		// Unsupported or indeterminate cancellation does not refund. Polling the
		// original provider reference is the only safe reconciliation path.
		return false;
	}

	private async applyProviderOutcome(
		claim: GeneratedMediaClaim,
		provider: GeneratedMediaProvider,
		kindConfig: EnabledGeneratedMediaKindConfig,
		outcome: GeneratedMediaProviderOutcome,
		signal?: AbortSignal,
	) {
		switch (outcome.state) {
			case "completed":
				if (
					!Number.isSafeInteger(outcome.usage.units) ||
					outcome.usage.units < 0 ||
					outcome.usage.units > kindConfig.usageUnits
				) {
					await this.waitUnknown(claim, outcome.providerReference, {
						resultReference: outcome.resultReference,
						usageUnits: outcome.usage.units,
						moderation: outcome.moderation,
						errorCode: "generated_media_usage_invalid",
					});
					return;
				}
				await this.dependencies.store.recordProviderResult({
					claim,
					providerReference: outcome.providerReference,
					resultReference: outcome.resultReference,
					moderation: outcome.moderation,
					usageUnits: outcome.usage.units,
					now: this.now(),
				});
				await this.ingestResult(
					{
						...claim,
						resultReference: outcome.resultReference,
						providerUsageUnits: outcome.usage.units,
						moderation: outcome.moderation,
					},
					provider,
					kindConfig,
					signal,
				);
				return;
			case "waiting":
				await this.dependencies.store.markWaiting({
					claim,
					providerReference: outcome.providerReference,
					nextPollAt: outcome.nextPollAt,
					moderation: outcome.moderation,
					now: this.now(),
				});
				return;
			case "rejected":
				await this.dependencies.store.markTerminal({
					claim,
					status: "rejected",
					errorCode: outcome.errorCode,
					moderation: outcome.moderation,
					now: this.now(),
					promptRetentionMs: this.promptRetentionMs,
				});
				return;
			case "failed":
				if (outcome.retry === "safe") {
					const retryAt = new Date(
						this.now().getTime() + this.retryDelayMs(claim.attemptCount),
					);
					if (claim.priorStatus === "waiting" && claim.providerReference) {
						await this.dependencies.store.markWaiting({
							claim,
							providerReference: claim.providerReference,
							nextPollAt: retryAt,
							errorCode: outcome.errorCode,
							now: this.now(),
						});
					} else {
						await this.dependencies.store.markRetry({
							claim,
							nextAttemptAt: retryAt,
							errorCode: outcome.errorCode,
							now: this.now(),
						});
					}
					return;
				}
				if (outcome.retry === "unknown") {
					await this.waitUnknown(claim, outcome.providerReference, {
						resultReference: outcome.resultReference ?? null,
						usageUnits: outcome.usage?.units ?? null,
						moderation: outcome.moderation ?? null,
						errorCode: outcome.errorCode,
					});
					return;
				}
				await this.failTerminal(claim, outcome.errorCode);
		}
	}

	private async ingestResult(
		claim: GeneratedMediaClaim,
		provider: GeneratedMediaProvider,
		kindConfig: EnabledGeneratedMediaKindConfig,
		signal?: AbortSignal,
	) {
		if (!claim.resultReference) throw new Error("Provider result is missing");
		let source: GeneratedMediaProviderSource;
		try {
			source = await provider.retrieve({
				resultReference: claim.resultReference,
				model: claim.model,
				kind: claim.kind,
				signal,
			});
		} catch {
			await this.dependencies.store.markRetry({
				claim,
				nextAttemptAt: new Date(
					this.now().getTime() + this.retryDelayMs(claim.attemptCount),
				),
				errorCode: "generated_media_result_unavailable",
				now: this.now(),
			});
			return;
		}
		let asset: GeneratedMediaAssetDraft;
		try {
			asset = await this.dependencies.ingestor.ingest({
				jobId: claim.jobId,
				attemptId: claim.claimId,
				projectId: claim.projectId,
				clipId: claim.clipId,
				storageKey: storageKeyForGeneratedMedia(
					claim,
					source.kind === "inline"
						? source.contentType
						: "application/octet-stream",
				),
				kind: claim.kind,
				aspectRatio: claim.aspectRatio,
				requestedDurationSec: claim.durationSec,
				source,
				maxOutputBytes: kindConfig.maxOutputBytes,
				signal,
			});
		} catch (error) {
			const code =
				error &&
				typeof error === "object" &&
				"code" in error &&
				typeof error.code === "string"
					? error.code
					: "generated_media_ingestion_failed";
			if (
				code === "generated_media_upload_failed" ||
				code === "generated_media_cleanup_admission_failed" ||
				code === "generated_media_result_download_failed" ||
				code === "generated_media_storage_unavailable"
			) {
				await this.dependencies.store.markRetry({
					claim,
					nextAttemptAt: new Date(
						this.now().getTime() + this.retryDelayMs(claim.attemptCount),
					),
					errorCode: code,
					now: this.now(),
				});
			} else {
				await this.failTerminal(claim, code);
			}
			return;
		}
		await this.dependencies.store.stageAsset({ claim, asset, now: this.now() });
		await this.publishAndRecord({ ...claim, stagedAsset: asset });
	}

	private async publishAndRecord(claim: GeneratedMediaClaim) {
		await this.dependencies.store.publishAsset({
			claim,
			now: this.now(),
			promptRetentionMs: this.promptRetentionMs,
		});
		if (
			claim.providerUsageUnits === null ||
			this.dependencies.store.terminalAnalyticsDelivery === "transactional"
		) {
			return;
		}
		await this.dependencies.events
			?.recordCompleted({
				jobId: claim.jobId,
				workspaceId: claim.workspaceId,
				projectId: claim.projectId,
				clipId: claim.clipId,
				kind: claim.kind,
				providerAlias: claim.provider,
				modelAlias: claim.model,
				status: "completed",
				latencyMs: Math.max(0, this.now().getTime() - claim.createdAt.getTime()),
				retryCount: Math.max(0, claim.attemptCount - 1),
				moderationOutcome: claim.moderation.outcome,
				usageUnits: claim.providerUsageUnits,
			});
	}

	private waitUnknown(
		claim: GeneratedMediaClaim,
		providerReference: string | null,
		evidence: {
			resultReference: string | null;
			usageUnits: number | null;
			moderation: GeneratedMediaModeration | null;
			errorCode: string;
		} = {
			resultReference: null,
			usageUnits: null,
			moderation: null,
			errorCode: "generated_media_outcome_unknown",
		},
	) {
		if (!providerReference || evidence.resultReference) {
			return this.dependencies.store.markReconciliationRequired({
				claim,
				providerReference,
				resultReference: evidence.resultReference,
				usageUnits: evidence.usageUnits,
				moderation: evidence.moderation,
				errorCode: evidence.errorCode,
				now: this.now(),
				promptRetentionMs: this.promptRetentionMs,
			});
		}
		return this.dependencies.store.markWaiting({
			claim,
			providerReference,
			nextPollAt: new Date(
				this.now().getTime() + this.retryDelayMs(claim.attemptCount),
			),
			errorCode: "generated_media_outcome_unknown",
			now: this.now(),
		});
	}

	private failTerminal(claim: GeneratedMediaClaim, errorCode: string) {
		return this.dependencies.store.markTerminal({
			claim,
			status: "failed",
			errorCode,
			now: this.now(),
			promptRetentionMs: this.promptRetentionMs,
		});
	}
}

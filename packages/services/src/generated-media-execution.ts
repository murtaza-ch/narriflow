import { createHash, randomUUID } from "node:crypto";
import {
	Prisma,
	type ExecutionArtifact,
	type GeneratedMediaJob,
	type PrismaClient,
	type VisualAsset,
} from "@prisma/client";
import {
	workspaceAllowsCapability,
	createGeneratedImageSchema,
	brandProgramAnalyticsEventSchema,
	resolvePricingTier,
	type WorkspaceCapability,
} from "@narriflow/validators";
import {
	generatedImageCommandSchema,
	generatedImageEvidenceSchema,
	type GeneratedImageCommand,
	type GeneratedImageEvidence,
} from "@narriflow/validators/generated-image-execution";
import type {
	ExecutionDeadline,
	ExecutionDispatchReference,
} from "@narriflow/validators/execution";
import type { BrandActorScope } from "./brand-ownership";
import {
	GeneratedMediaJobError,
	generatedMediaPublicJob,
	type CreateGeneratedMediaInput,
	type GeneratedMediaJobRecord,
	type GeneratedMediaPromptProtection,
	type GeneratedMediaReconciliation,
} from "./generated-media";
import {
	reserveGenerationUsage,
	finalizeGenerationUsage,
	releaseGenerationUsage,
} from "./generated-media-usage-ledger";
import {
	appendExecutionDispatch,
	readExecutionDispatch,
} from "./execution-dispatch";
import type {
	ExecutorArtifactCommit,
	ExecutorDomainControl,
	ExecutorDomainLock,
	ExecutorMutationContext,
	ExecutorMutationResult,
	ExecutorExpiryObservation,
	ExecutorExpiryResult,
} from "./executor-domain-control";
import type { ExecutorArtifactHead } from "./executor-control";
import { requirePlanFeature } from "./plan-features";
import { accessibleProjectWhere } from "./project-access";

type Tx = Prisma.TransactionClient;
const terminal = ["completed", "failed", "rejected", "cancelled"];
const deadlineMs = 10 * 60_000;
const digest = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
interface Source {
	storageKey: string;
	etag: string;
	sha256: string;
	byteLength: number;
	artifactId: string;
}
interface State {
	inputPlan?: { storageKey: string; sha256: string; byteLength: number };
	binary?: Source;
	evidence?: GeneratedImageEvidence;
	probeArtifactId?: string;
	recovery?: Source;
}
const state = (row: GeneratedMediaJob): State =>
	row.resultState &&
	typeof row.resultState === "object" &&
	!Array.isArray(row.resultState)
		? (row.resultState as unknown as State)
		: {};
export function generatedMediaExecutionInputHash(row: GeneratedMediaJob) {
	return digest([
		"generated-image-v1",
		row.id,
		row.workspaceId,
		row.projectId,
		row.clipId,
		row.createdByUserId,
		row.promptFingerprint,
		row.promptOrigin,
		row.sourceStartSec,
		row.sourceEndSec,
		row.sourceCueAtSec,
		row.aspectRatio,
		row.style,
		row.provider,
		row.providerModel,
		row.providerQuality,
		row.outputByteLimit,
		row.generation,
		row.deploymentEpoch,
		row.executionMode,
		row.executionMode === "recover"
			? [
					row.providerRef,
					row.providerUsageImages,
					...(() => {
						const source = state(row).recovery;
						return source
							? [
									source.storageKey,
									source.etag,
									source.sha256,
									source.byteLength,
									source.artifactId,
								]
							: [];
					})(),
				]
			: null,
	]);
}
export interface GeneratedMediaInputPlan {
	storageKey: string;
	sha256: string;
	byteLength: number;
}
export interface GeneratedMediaExecutionDependencies {
	model: string;
	quality: "low" | "medium" | "high";
	maxOutputBytes: number;
	maxAttempts: number;
	maxPromptCharacters: number;
	promptProtection: GeneratedMediaPromptProtection;
	inputStorage: {
		put(plan: GeneratedMediaInputPlan, bytes: Uint8Array): Promise<void>;
		head(
			plan: GeneratedMediaInputPlan,
		): Promise<{ etag: string; sha256: string; byteLength: number } | null>;
	};
	headArtifact(
		row: Readonly<ExecutionArtifact>,
	): Promise<ExecutorArtifactHead | null>;
	register(ids: readonly string[]): Promise<void>;
	assetUrl(key: string): Promise<string | null>;
}
export interface GeneratedMediaExecutionReference {
	id: string;
	attemptToken: string;
	generation: number;
	deploymentEpoch: number;
}
export interface GeneratedMediaArtifact extends ExecutorArtifactCommit {
	evidence?: GeneratedImageEvidence;
}
export type GeneratedMediaPreparation =
	| { kind: "terminal" | "superseded" }
	| { kind: "sleep"; dueAt: Date }
	| {
			kind: "waiting";
			deadline: ExecutionDeadline;
			deliveryId: string;
			dispatchIds: readonly string[];
	  };
async function now(tx: Tx) {
	const [row] = await tx.$queryRaw<
		Array<{ now: Date }>
	>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"`;
	if (!row) throw new GeneratedMediaJobError("generated_media_claim_lost");
	return row.now;
}

/** SQL owns admission, usage and every transition. Native owns only one fixed
 * provider call (or exact-source recovery), decoding and assigned image work. */
export class GeneratedMediaExecution
	implements
		ExecutorDomainControl<
			GeneratedMediaExecutionReference,
			GeneratedMediaArtifact
		>
{
	constructor(
		private readonly database: PrismaClient,
		private readonly dependencies: GeneratedMediaExecutionDependencies,
	) {
		if (
			!dependencies.model.trim() ||
			dependencies.model.length > 160 ||
			!Number.isSafeInteger(dependencies.maxOutputBytes) ||
			dependencies.maxOutputBytes < 1000000 ||
			dependencies.maxOutputBytes > 100000000 ||
			!Number.isSafeInteger(dependencies.maxAttempts) ||
			dependencies.maxAttempts < 1 ||
			dependencies.maxAttempts > 10
		)
			throw new GeneratedMediaJobError(
				"generated_media_provider_result_unavailable",
			);
	}
	private async epoch(tx: Tx) {
		const [row] = await tx.$queryRaw<
			Array<{ epoch: number }>
		>`SELECT "epoch" FROM "ExecutionEpoch" WHERE "id"=1 FOR SHARE`;
		if (!row) throw new GeneratedMediaJobError("generated_media_claim_lost");
		return row.epoch;
	}
	private async ownerLocks(
		tx: Tx,
		row: Pick<GeneratedMediaJob, "workspaceId" | "projectId" | "id">,
	) {
		await tx.$queryRaw`SELECT "id" FROM "Workspace" WHERE "id"=${row.workspaceId}::uuid FOR SHARE`;
		const workspace = await tx.workspace.findUnique({
			where: { id: row.workspaceId },
			select: { personalOwnerUserId: true },
		});
		await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`native-validation-owner:${workspace?.personalOwnerUserId ?? row.workspaceId}`},0)) IS NULL AS "locked"`;
		await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id"=${row.projectId}::uuid FOR UPDATE`;
		await tx.$queryRaw`SELECT "id" FROM "GeneratedMediaJob" WHERE "id"=${row.id}::uuid FOR UPDATE`;
	}
	private async actor(
		tx: Tx,
		workspaceId: string,
		userId: string,
		capability: WorkspaceCapability = "content.edit",
	): Promise<BrandActorScope> {
		const workspace = await tx.workspace.findUnique({
				where: { id: workspaceId },
			}),
			user = await tx.user.findUnique({
				where: { id: userId },
				select: { deletedAt: true },
			}),
			member = await tx.workspaceMember.findUnique({
				where: { workspaceId_userId: { workspaceId, userId } },
			});
		const role = workspace?.ownerUserId === userId ? "owner" : member?.role;
		if (
			!workspace ||
			!user ||
			user.deletedAt ||
			!role ||
			!workspaceAllowsCapability({ role, status: workspace.status }, capability)
		)
			throw new GeneratedMediaJobError("generated_media_forbidden");
		if (capability !== "content.view")
			requirePlanFeature(workspace.pricingTier, "generated.images");
		return {
			actorUserId: userId,
			workspaceId,
			workspaceOwnerUserId: workspace.ownerUserId,
			isPersonalWorkspace: workspace.personalOwnerUserId !== null,
			role,
			status: workspace.status,
			pricingTier: workspace.pricingTier,
		};
	}
	private async current(tx: Tx, row: GeneratedMediaJob) {
		const scope = await this.actor(tx, row.workspaceId, row.createdByUserId);
		if (
			scope.isPersonalWorkspace !== row.isPersonalWorkspace ||
			(scope.isPersonalWorkspace &&
				scope.workspaceOwnerUserId !== row.workspaceOwnerUserId) ||
			!(await tx.project.findFirst({
				where: {
					id: row.projectId,
					workspaceId: row.workspaceId,
					...accessibleProjectWhere(await now(tx)),
				},
				select: { id: true },
			}))
		)
			throw new GeneratedMediaJobError("generated_media_origin_not_found");
		if (
			row.clipId &&
			!(await tx.clip.findFirst({
				where: { id: row.clipId, projectId: row.projectId },
				select: { id: true },
			}))
		)
			throw new GeneratedMediaJobError("generated_media_origin_not_found");
		return scope;
	}
	private async view(row: GeneratedMediaJob, replayed = false) {
		const asset = row.resultAssetId
			? await this.database.visualAsset.findUnique({
					where: { id: row.resultAssetId },
				})
			: null;
		const resultAsset =
			asset && !asset.deletedAt ? await this.asset(asset) : null;
		return generatedMediaPublicJob(
			{
				...row,
				scope: {
					actorUserId: row.createdByUserId,
					workspaceId: row.workspaceId,
					workspaceOwnerUserId: row.workspaceOwnerUserId,
					role: row.actorRole as BrandActorScope["role"],
					status: row.actorStatus as BrandActorScope["status"],
					pricingTier: row.pricingTier,
					isPersonalWorkspace: row.isPersonalWorkspace,
				},
				resultAsset,
			} as unknown as GeneratedMediaJobRecord,
			replayed,
		);
	}
	private async asset(row: VisualAsset) {
		return {
			id: row.id,
			title: row.title,
			kind: "image" as const,
			contentType: row.contentType as "image/png",
			sizeBytes: Number(row.sizeBytes),
			width: row.width,
			height: row.height,
			durationSec: null,
			fingerprint: row.fingerprint,
			provenance: "generated" as const,
			accessUrl: await this.dependencies.assetUrl(row.storageKey),
			replayed: false,
			createdAt: row.createdAt.toISOString(),
		};
	}
	private async register(tx: Tx, row: GeneratedMediaJob) {
		if (terminal.includes(row.status) || row.outcomeUnknown) return [];
		const d = await appendExecutionDispatch(tx, {
			deploymentEpoch: row.deploymentEpoch,
			generation: row.generation,
			kind: "operation_driver",
			subject: { kind: "generated_media", id: row.id },
			inputHash: generatedMediaExecutionInputHash(row),
			dueAt: row.retryAt ?? row.createdAt,
		});
		return [d.reference.dispatchId];
	}
	private async wake(
		tx: Tx,
		row: GeneratedMediaJob,
		at: Date,
		wakeKind: string,
		lease?: Date,
	) {
		const d = await appendExecutionDispatch(tx, {
			deploymentEpoch: row.deploymentEpoch,
			generation: row.generation,
			kind: "operation_driver",
			subject: { kind: "generated_media", id: row.id },
			inputHash: generatedMediaExecutionInputHash(row),
			dueAt: at,
			wakeKind,
			...(lease
				? { deadlineKind: "lease" as const, observedDeadlineAt: lease }
				: {}),
		});
		return { dispatchIds: [d.reference.dispatchId] };
	}
	private async confirm(ids: readonly string[]) {
		if (ids.length)
			try {
				await this.dependencies.register(ids);
			} catch {
				throw new GeneratedMediaJobError(
					"generated_media_provider_result_unavailable",
				);
			}
	}
	async create(scope: BrandActorScope, input: CreateGeneratedMediaInput) {
		if (
			input.idempotencyKey.trim().length < 8 ||
			input.idempotencyKey.length > 160
		)
			throw new GeneratedMediaJobError("generated_media_idempotency_invalid");
		if (
			input.prompt.trim().length < 3 ||
			input.prompt.length > this.dependencies.maxPromptCharacters
		)
			throw new GeneratedMediaJobError("generated_media_prompt_invalid");
		if (
			input.promptOrigin === "transcript_selection" &&
			!(
				input.sourceStartSec != null &&
				input.sourceEndSec != null &&
				input.sourceEndSec > input.sourceStartSec
			)
		)
			throw new GeneratedMediaJobError("generated_media_source_range_invalid");
		if (input.promptOrigin === "broll_cue" && input.sourceCueAtSec == null)
			throw new GeneratedMediaJobError("generated_media_source_cue_invalid");
		const parsed = createGeneratedImageSchema.safeParse(input);
		if (!parsed.success)
			throw new GeneratedMediaJobError("generated_media_prompt_invalid");
		input = parsed.data;
		const fingerprint = this.dependencies.promptProtection.fingerprint(
			JSON.stringify({
				projectId: input.projectId,
				clipId: input.clipId ?? null,
				prompt: input.prompt,
				promptOrigin: input.promptOrigin,
				aspectRatio: input.aspectRatio,
				style: input.style,
				sourceStartSec: input.sourceStartSec ?? null,
				sourceEndSec: input.sourceEndSec ?? null,
				sourceCueAtSec: input.sourceCueAtSec ?? null,
			}),
		);
		const admitted = await this.database.$transaction(async (tx) => {
			const epoch = await this.epoch(tx);
			await tx.$queryRaw`SELECT "id" FROM "Workspace" WHERE "id"=${scope.workspaceId}::uuid FOR SHARE`;
			const current = await this.actor(
				tx,
				scope.workspaceId,
				scope.actorUserId,
			);
			await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id"=${input.projectId}::uuid FOR SHARE`;
			if (
				!(await tx.project.findFirst({
					where: {
						id: input.projectId,
						workspaceId: scope.workspaceId,
						...accessibleProjectWhere(await now(tx)),
					},
					select: { id: true },
				}))
			)
				throw new GeneratedMediaJobError("generated_media_origin_not_found");
			if (input.clipId) {
				const clip = await tx.clip.findFirst({
					where: { id: input.clipId, projectId: input.projectId },
					select: { startSec: true, endSec: true },
				});
				if (!clip)
					throw new GeneratedMediaJobError("generated_media_origin_not_found");
				if (
					input.promptOrigin === "transcript_selection" &&
					(input.sourceStartSec! < clip.startSec ||
						input.sourceEndSec! > clip.endSec)
				)
					throw new GeneratedMediaJobError(
						"generated_media_source_range_invalid",
					);
				if (
					input.promptOrigin === "broll_cue" &&
					input.sourceCueAtSec! > clip.endSec - clip.startSec
				)
					throw new GeneratedMediaJobError(
						"generated_media_source_cue_invalid",
					);
			}
			await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`generated-media:${scope.workspaceId}:${input.idempotencyKey}`},0)) IS NULL AS "locked"`;
			const known = await tx.generatedMediaJob.findUnique({
				where: {
					workspaceId_idempotencyKey: {
						workspaceId: scope.workspaceId,
						idempotencyKey: input.idempotencyKey,
					},
				},
			});
			if (known) {
				if (known.requestFingerprint !== fingerprint)
					throw new GeneratedMediaJobError(
						"generated_media_idempotency_conflict",
					);
				return {
					row: known,
					replayed: true,
					ids: await this.register(tx, known),
				};
			}
			const id = randomUUID(),
				clock = await now(tx);
			const reservation = await reserveGenerationUsage(tx, {
				kind: "image",
				jobId: id,
				workspaceId: scope.workspaceId,
				actorUserId: scope.actorUserId,
				pricingTier: current.pricingTier,
				now: clock,
				attached: true,
			});
			const row = await tx.generatedMediaJob.create({
				data: {
					id,
					workspaceId: scope.workspaceId,
					projectId: input.projectId,
					clipId: input.clipId ?? null,
					createdByUserId: scope.actorUserId,
					workspaceOwnerUserId: current.workspaceOwnerUserId,
					actorRole: current.role,
					actorStatus: current.status,
					pricingTier: current.pricingTier,
					isPersonalWorkspace: current.isPersonalWorkspace,
					idempotencyKey: input.idempotencyKey,
					requestFingerprint: fingerprint,
					protectedPrompt: this.dependencies.promptProtection.protect(
						input.prompt.trim(),
					),
					promptFingerprint: this.dependencies.promptProtection.fingerprint(
						input.prompt.trim(),
					),
					promptOrigin: input.promptOrigin,
					sourceStartSec: input.sourceStartSec ?? null,
					sourceEndSec: input.sourceEndSec ?? null,
					sourceCueAtSec: input.sourceCueAtSec ?? null,
					aspectRatio: input.aspectRatio,
					style: input.style,
					title: `Generated ${input.style} frame`,
					usageReservationId: reservation.reservationId,
					provider: "openai",
					providerModel: this.dependencies.model,
					providerQuality: this.dependencies.quality,
					outputByteLimit: this.dependencies.maxOutputBytes,
					maxAttempts: this.dependencies.maxAttempts,
					deploymentEpoch: epoch,
					promptExpiresAt: new Date(clock.getTime() + 30 * 86400000),
					createdAt: clock,
					updatedAt: clock,
				},
			});
			return { row, replayed: false, ids: await this.register(tx, row) };
		});
		await this.confirm(admitted.ids);
		return this.view(admitted.row, admitted.replayed);
	}
	async get(scope: BrandActorScope, id: string, projectId?: string) {
		await this.database.$transaction((tx) =>
			this.actor(tx, scope.workspaceId, scope.actorUserId, "content.view"),
		);
		const row = await this.database.generatedMediaJob.findFirst({
			where: {
				id,
				workspaceId: scope.workspaceId,
				...(projectId ? { projectId } : {}),
			},
		});
		if (!row) throw new GeneratedMediaJobError("generated_media_job_not_found");
		return this.view(row);
	}
	async inspect(workspaceId: string, id: string) {
		const row = await this.database.generatedMediaJob.findFirst({
			where: { id, workspaceId },
		});
		if (!row) throw new GeneratedMediaJobError("generated_media_job_not_found");
		return this.view(row);
	}
	async list(scope: BrandActorScope, projectId: string, clipId?: string) {
		await this.database.$transaction((tx) =>
			this.actor(tx, scope.workspaceId, scope.actorUserId, "content.view"),
		);
		return Promise.all(
			(
				await this.database.generatedMediaJob.findMany({
					where: {
						workspaceId: scope.workspaceId,
						projectId,
						...(clipId ? { clipId } : {}),
					},
					orderBy: { createdAt: "desc" },
				})
			).map((row) => this.view(row)),
		);
	}
	private command(
		row: GeneratedMediaJob,
		token: string,
	): GeneratedImageCommand {
		const common = {
			kind: "generated_image",
			jobId: row.id,
			requestId: token,
			inputHash: generatedMediaExecutionInputHash(row),
			maxOutputBytes: row.outputByteLimit,
		};
		return generatedImageCommandSchema.parse(
			row.executionMode === "recover"
				? {
						...common,
						mode: "recover",
						providerRef: row.providerRef,
						expected: {
							contentType: "image/png",
							byteLength: state(row).recovery?.byteLength,
							sha256: state(row).recovery?.sha256,
						},
					}
				: {
						...common,
						mode: "generate",
						prompt: this.dependencies.promptProtection.reveal(
							row.protectedPrompt,
						),
						aspectRatio: row.aspectRatio,
						style: row.style,
						model: row.providerModel,
						quality: row.providerQuality,
					},
		);
	}
	async prepareExecution(
		reference: ExecutionDispatchReference,
	): Promise<GeneratedMediaPreparation> {
		const staged = await this.database.$transaction(async (tx) => {
			const epoch = await this.epoch(tx);
			const ledger = (await readExecutionDispatch(tx, reference.dispatchId))
				?.reference;
			if (
				epoch !== reference.deploymentEpoch ||
				reference.kind !== "operation_driver" ||
				reference.subject.kind !== "generated_media" ||
				!ledger ||
				ledger.dispatchId !== reference.dispatchId ||
				ledger.kind !== reference.kind ||
				ledger.subject.kind !== reference.subject.kind ||
				ledger.subject.id !== reference.subject.id ||
				ledger.generation !== reference.generation ||
				ledger.deploymentEpoch !== reference.deploymentEpoch ||
				ledger.inputHash !== reference.inputHash
			)
				return { kind: "superseded" as const };
			const initial = await tx.generatedMediaJob.findUnique({
				where: { id: reference.subject.id },
			});
			if (!initial) return { kind: "superseded" as const };
			await this.ownerLocks(tx, initial);
			let row = await tx.generatedMediaJob.findUniqueOrThrow({
				where: { id: initial.id },
			});
			const clock = await now(tx);
			if (
				row.generation !== reference.generation ||
				row.deploymentEpoch !== epoch ||
				generatedMediaExecutionInputHash(row) !== reference.inputHash
			)
				return { kind: "superseded" as const };
			if (terminal.includes(row.status) || row.outcomeUnknown)
				return { kind: "terminal" as const };
			try {
				await this.current(tx, row);
			} catch {
				const result = await this.withdraw(tx, row, clock);
				return { kind: "terminal" as const, ids: result.dispatchIds };
			}
			if (row.retryAt && row.retryAt > clock)
				return { kind: "sleep" as const, dueAt: row.retryAt };
			if (row.chargedAttempts >= row.maxAttempts) {
				const result = await this.finish(
					tx,
					row,
					clock,
					"failed",
					"generated_media_provider_validation",
				);
				return { kind: "terminal" as const, ids: result.dispatchIds };
			}
			const token = row.claimId ?? randomUUID(),
				until =
					row.operationDeadlineAt ?? new Date(clock.getTime() + deadlineMs),
				command = this.command(row, token),
				bytes = new TextEncoder().encode(JSON.stringify(command));
			if (bytes.byteLength > 16 * 1024 * 1024)
				throw new GeneratedMediaJobError("generated_media_prompt_invalid");
			const plan = {
				storageKey: `execution-inputs/${epoch}/generated/${row.id}/${row.generation}/${token}.json`,
				sha256: createHash("sha256").update(bytes).digest("hex"),
				byteLength: bytes.byteLength,
			};
			const pending = state(row);
			if (
				pending.inputPlan &&
				(pending.inputPlan.storageKey !== plan.storageKey ||
					pending.inputPlan.byteLength !== plan.byteLength ||
					pending.inputPlan.sha256 !== plan.sha256)
			)
				throw new GeneratedMediaJobError("generated_media_claim_lost");
			pending.inputPlan = plan;
			if (!row.claimId) {
				row = await tx.generatedMediaJob.update({
					where: { id: row.id },
					data: {
						claimId: token,
						operationDeadlineAt: until,
						resultState: pending as unknown as Prisma.InputJsonValue,
					},
				});
				await tx.mediaCleanupObligation.upsert({
					where: {
						origin_cleanupClass_objectKey: {
							origin: "generated_media_publication",
							cleanupClass: "generated_asset",
							objectKey: plan.storageKey,
						},
					},
					create: {
						origin: "generated_media_publication",
						cleanupClass: "generated_asset",
						objectKey: plan.storageKey,
						nextAttemptAt: new Date(row.promptExpiresAt.getTime() + 86400000),
					},
					update: {},
				});
			}
			return {
				kind: "stage" as const,
				row,
				token,
				bytes,
				plan,
			};
		});
		if (staged.kind !== "stage") {
			if ("ids" in staged) await this.confirm(staged.ids ?? []);
			return staged;
		}
		const existing = await this.database.executionAttempt.findUnique({
			where: { attemptToken: staged.token },
		});
		let etag = existing?.inputEtag;
		if (!etag) {
			let head = await this.dependencies.inputStorage.head(staged.plan);
			if (!head) {
				try {
					await this.dependencies.inputStorage.put(staged.plan, staged.bytes);
				} catch {
					/* Reconcile a lost PUT acknowledgment from the exact planned key. */
				}
				head = await this.dependencies.inputStorage.head(staged.plan);
			}
			if (
				!head ||
				head.sha256 !== staged.plan.sha256 ||
				head.byteLength !== staged.plan.byteLength ||
				!/^[\x21-\x7e]{1,160}$/.test(head.etag)
			)
				throw new GeneratedMediaJobError(
					"generated_media_provider_result_unavailable",
				);
			etag = head.etag;
		}
		const frozenEtag = etag;
		const prepared = await this.database.$transaction(
			async (tx): Promise<GeneratedMediaPreparation> => {
				const epoch = await this.epoch(tx);
				await this.ownerLocks(tx, staged.row);
				const row = await tx.generatedMediaJob.findUniqueOrThrow({
					where: { id: staged.row.id },
				});
				if (
					epoch !== row.deploymentEpoch ||
					row.generation !== reference.generation ||
					row.claimId !== staged.token ||
					row.outcomeUnknown ||
					terminal.includes(row.status)
				)
					return { kind: "superseded" };
				await this.current(tx, row);
				const modal = await appendExecutionDispatch(tx, {
					deploymentEpoch: epoch,
					generation: row.generation,
					kind: "modal_execution",
					subject: { kind: "generated_media", id: row.id },
					inputHash: reference.inputHash,
					dueAt: row.retryAt ?? row.createdAt,
				});
				const attempt = await tx.executionAttempt.upsert({
					where: { attemptToken: staged.token },
					create: {
						attemptToken: staged.token,
						dispatchId: modal.reference.dispatchId,
						deploymentEpoch: epoch,
						generation: row.generation,
						inputHash: reference.inputHash,
						functionName: "generated_image",
						operationDeadlineAt: row.operationDeadlineAt!,
						inputStorageKey: staged.plan.storageKey,
						inputEtag: frozenEtag,
						inputByteLength: BigInt(staged.plan.byteLength),
						inputChecksumSha256: staged.plan.sha256,
					},
					update: {},
				});
				if (
					attempt.dispatchId !== modal.reference.dispatchId ||
					attempt.inputStorageKey !== staged.plan.storageKey ||
					attempt.inputEtag !== frozenEtag ||
					attempt.inputChecksumSha256 !== staged.plan.sha256 ||
					attempt.inputByteLength !== BigInt(staged.plan.byteLength)
				)
					throw new GeneratedMediaJobError("generated_media_claim_lost");
				const until = row.claimExpiresAt ?? row.operationDeadlineAt!,
					kind = row.claimExpiresAt
						? ("lease" as const)
						: ("operation" as const);
				const deadline = {
					reference: modal.reference,
					attemptToken: staged.token,
					kind,
					observedDeadlineAt: until.toISOString(),
				};
				const watch = await appendExecutionDispatch(tx, {
					deploymentEpoch: row.deploymentEpoch,
					generation: row.generation,
					kind: "operation_driver",
					subject: { kind: "generated_media", id: row.id },
					inputHash: reference.inputHash,
					dueAt: until,
					deadlineKind: kind,
					observedDeadlineAt: until,
				});
				return {
					kind: "waiting",
					deadline,
					deliveryId: watch.reference.dispatchId,
					dispatchIds: [watch.reference.dispatchId, modal.reference.dispatchId],
				};
			},
		);
		if (prepared.kind === "waiting") await this.confirm(prepared.dispatchIds);
		return prepared;
	}
	async workInput(id: string) {
		const row = await this.database.generatedMediaJob.findUnique({
			where: { id },
		});
		if (!row || !row.claimId || row.status !== "running" || row.outcomeUnknown)
			throw new GeneratedMediaJobError("generated_media_claim_lost");
		return {
			inputHash: generatedMediaExecutionInputHash(row),
			input: { kind: "object" as const },
			sources:
				row.executionMode === "recover"
					? (() => {
							const source = state(row).recovery!;
							return [{ name: "generated_result", storageKey: source.storageKey, etag: source.etag, sha256: source.sha256, byteLength: source.byteLength }];
						})()
					: [],
			outputs: [
				{
					role: "validated_asset" as const,
					contentType: "image/png",
					maxBytes: row.outputByteLimit,
					bindingHash: generatedMediaExecutionInputHash(row),
				},
				{
					role: "probe" as const,
					contentType: "application/json",
					maxBytes: 65536,
					bindingHash: generatedMediaExecutionInputHash(row),
				},
			],
		};
	}
	async lockExecution(
		tx: Tx,
		reference: ExecutionDispatchReference,
		attemptToken: string,
	): Promise<ExecutorDomainLock<GeneratedMediaExecutionReference>> {
		const initial = await tx.generatedMediaJob.findUnique({
			where: { id: reference.subject.id },
		});
		if (
			!initial ||
			reference.kind !== "modal_execution" ||
			reference.subject.kind !== "generated_media"
		)
			return { kind: "terminal", disposition: { disposition: "superseded" } };
		await this.ownerLocks(tx, initial);
		const row = await tx.generatedMediaJob.findUniqueOrThrow({
			where: { id: initial.id },
		});
		if (
			row.generation !== reference.generation ||
			row.deploymentEpoch !== reference.deploymentEpoch ||
			row.claimId !== attemptToken ||
			generatedMediaExecutionInputHash(row) !== reference.inputHash
		)
			return { kind: "terminal", disposition: { disposition: "superseded" } };
		if (row.status === "completed")
			return { kind: "terminal", disposition: { disposition: "completed" } };
		if (row.status === "cancelled")
			return { kind: "terminal", disposition: { disposition: "cancelled" } };
		if (terminal.includes(row.status) || row.outcomeUnknown)
			return {
				kind: "terminal",
				disposition: {
					disposition: "failed",
					failureCode:
						row.errorCode ?? "generated_media_reconciliation_required",
				},
			};
		try {
			await this.current(tx, row);
		} catch {
			const result = await this.withdraw(tx, row, await now(tx));
			return {
				kind: "terminal",
				disposition: {
					disposition: result.unknown ? "failed" : "cancelled",
					...(result.unknown
						? { failureCode: "generated_media_reconciliation_required" }
						: {}),
				} as
					| { disposition: "failed"; failureCode: string }
					| { disposition: "cancelled" },
				dispatchIds: result.dispatchIds,
			};
		}
		return {
			kind: "current",
			ref: {
				id: row.id,
				attemptToken,
				generation: row.generation,
				deploymentEpoch: row.deploymentEpoch,
			},
		};
	}
	private async owned(
		tx: Tx,
		ref: GeneratedMediaExecutionReference,
		c: ExecutorMutationContext,
	) {
		const clock = await now(tx);
		const row = await tx.generatedMediaJob.findFirst({
			where: {
				id: ref.id,
				status: "running",
				claimId: c.attemptToken,
				executorOwner: c.owner,
				generation: c.reference.generation,
				deploymentEpoch: c.reference.deploymentEpoch,
				claimExpiresAt: { gt: clock },
				operationDeadlineAt: { gt: clock },
				outcomeUnknown: false,
			},
		});
		if (!row || ref.attemptToken !== c.attemptToken)
			throw new GeneratedMediaJobError("generated_media_claim_lost");
		return { row, clock };
	}
	async acquireExecution(
		tx: Tx,
		ref: GeneratedMediaExecutionReference,
		c: ExecutorMutationContext,
	): Promise<ExecutorMutationResult> {
		const row = await tx.generatedMediaJob.findUniqueOrThrow({
				where: { id: ref.id },
			}),
			clock = await now(tx),
			attempt = await tx.executionAttempt.findUniqueOrThrow({
				where: { attemptToken: c.attemptToken },
			});
		if (
			row.status !== "queued" ||
			row.executorOwner ||
			row.claimId !== c.attemptToken ||
			row.chargedAttempts >= row.maxAttempts ||
			!row.operationDeadlineAt ||
			row.operationDeadlineAt <= clock ||
			row.operationDeadlineAt.getTime() !== c.operationDeadlineAt.getTime() ||
			!attempt.inputEtag
		)
			throw new GeneratedMediaJobError("generated_media_claim_lost");
		await tx.generatedMediaJob.update({
			where: { id: row.id },
			data: {
				status: "running",
				executorOwner: c.owner,
				claimExpiresAt: c.leaseExpiresAt,
			},
		});
		return this.wake(tx, row, clock, "generated_acquired", c.leaseExpiresAt);
	}
	async renewExecution(
		tx: Tx,
		ref: GeneratedMediaExecutionReference,
		c: ExecutorMutationContext,
	): Promise<ExecutorMutationResult> {
		await this.owned(tx, ref, c);
		await tx.generatedMediaJob.update({
			where: { id: ref.id },
			data: { claimExpiresAt: c.leaseExpiresAt },
		});
		return undefined;
	}
	async startExecution(
		tx: Tx,
		ref: GeneratedMediaExecutionReference,
		c: ExecutorMutationContext,
	): Promise<ExecutorMutationResult> {
		const { row } = await this.owned(tx, ref, c);
		if (row.chargedAttempts >= row.maxAttempts)
			throw new GeneratedMediaJobError("generated_media_claim_lost");
		await tx.generatedMediaJob.update({
			where: { id: row.id },
			data: {
				chargedAttempts: { increment: 1 },
				...(row.executionMode === "generate"
					? { attempt: { increment: 1 } }
					: {}),
			},
		});
		return undefined;
	}
	async progressExecution(
		tx: Tx,
		ref: GeneratedMediaExecutionReference,
		c: ExecutorMutationContext,
	): Promise<ExecutorMutationResult> {
		await this.owned(tx, ref, c);
		return undefined;
	}
	async commitArtifactExecution(
		tx: Tx,
		ref: GeneratedMediaExecutionReference,
		c: ExecutorMutationContext,
		artifact: GeneratedMediaArtifact,
	): Promise<ExecutorMutationResult> {
		const { row, clock } = await this.owned(tx, ref, c),
			pending = state(row);
		if (artifact.bindingHash !== c.reference.inputHash)
			throw new GeneratedMediaJobError("generated_media_claim_lost");
		if (artifact.role === "probe") {
			const evidence = generatedImageEvidenceSchema.parse(artifact.evidence);
			if (
				artifact.contentType !== "application/json" ||
				artifact.byteLength > 65536n ||
				evidence.jobId !== row.id ||
				evidence.requestId !== c.attemptToken ||
				evidence.inputHash !== c.reference.inputHash
			)
				throw new GeneratedMediaJobError("generated_media_claim_lost");
			if (evidence.outcome !== "completed") {
				pending.evidence = evidence;
				pending.probeArtifactId = artifact.artifactId;
				await tx.generatedMediaJob.update({
					where: { id: row.id },
					data: {
						resultState: pending as unknown as Prisma.InputJsonValue,
						...(evidence.providerRef
							? { providerRef: evidence.providerRef }
							: {}),
					},
				});
				const current = await tx.generatedMediaJob.findUniqueOrThrow({
					where: { id: row.id },
				});
				if (evidence.outcome === "unknown")
					return this.unknown(tx, current, clock, evidence.code);
				if (evidence.retryable && row.chargedAttempts < row.maxAttempts)
					return this.retry(
						tx,
						current,
						clock,
						evidence.code,
						evidence.retryAfterMs ?? 5000,
					);
				return this.finish(
					tx,
					current,
					clock,
					evidence.outcome === "rejected" ? "rejected" : "failed",
					evidence.code,
				);
			}
			if (
				evidence.image.kind !== "visual" ||
				evidence.image.mediaKind !== "image" ||
				evidence.image.contentType !== "image/png" ||
				evidence.image.byteLength > row.outputByteLimit
			)
				throw new GeneratedMediaJobError("generated_media_claim_lost");
			const binary = await tx.executionArtifact.findFirst({
				where: {
					id: evidence.binaryArtifactId,
					attemptToken: c.attemptToken,
					owner: c.owner,
					role: "validated_asset",
					bindingHash: c.reference.inputHash,
				},
			});
			if (!binary || BigInt(evidence.image.byteLength) > binary.maxBytes)
				throw new GeneratedMediaJobError("generated_media_claim_lost");
			if (
				row.executionMode === "recover" &&
				evidence.providerRef !== row.providerRef
			)
				throw new GeneratedMediaJobError("generated_media_claim_lost");
			pending.evidence = evidence;
			pending.probeArtifactId = artifact.artifactId;
			await tx.generatedMediaJob.update({
				where: { id: row.id },
				data: {
					providerRef: evidence.providerRef,
					providerUsageImages:
						row.executionMode === "recover"
							? (row.providerUsageImages ?? 1)
							: 1,
					providerResultContentType: "image/png",
				},
			});
		} else if (artifact.role === "validated_asset") {
			if (
				artifact.contentType !== "image/png" ||
				artifact.byteLength < 1n ||
				artifact.byteLength > BigInt(row.outputByteLimit)
			)
				throw new GeneratedMediaJobError("generated_media_claim_lost");
			pending.binary = {
				artifactId: artifact.artifactId,
				storageKey: artifact.storageKey,
				etag: artifact.etag,
				sha256: artifact.sha256,
				byteLength: Number(artifact.byteLength),
			};
		} else throw new GeneratedMediaJobError("generated_media_claim_lost");
		if (
			!pending.binary ||
			pending.evidence?.outcome !== "completed" ||
			!pending.probeArtifactId
		) {
			await tx.generatedMediaJob.update({
				where: { id: row.id },
				data: { resultState: pending as unknown as Prisma.InputJsonValue },
			});
			return undefined;
		}
		const evidence = pending.evidence,
			image = evidence.image;
		if (
			image.kind !== "visual" ||
			image.mediaKind !== "image" ||
			pending.binary.artifactId !== evidence.binaryArtifactId ||
			pending.binary.sha256 !== image.sha256 ||
			pending.binary.byteLength !== image.byteLength
		)
			throw new GeneratedMediaJobError("generated_media_claim_lost");
		const other = await tx.executionArtifact.findFirst({
			where: {
				id:
					artifact.role === "probe"
						? pending.binary.artifactId
						: pending.probeArtifactId,
				attemptToken: c.attemptToken,
				owner: c.owner,
				committedAt: { not: null },
			},
		});
		if (!other) throw new GeneratedMediaJobError("generated_media_claim_lost");
		const scope = await this.current(tx, row),
			owner = scope.isPersonalWorkspace
				? { userId: scope.workspaceOwnerUserId, workspaceId: null }
				: { userId: null, workspaceId: scope.workspaceId };
		const existing = await tx.visualAsset.findFirst({
				where: { ...owner, fingerprint: image.sha256 },
			}),
			data = {
				...owner,
				createdByUserId: row.createdByUserId,
				title: row.title,
				kind: "image" as const,
				storageKey: pending.binary.storageKey,
				contentType: "image/png",
				sizeBytes: BigInt(image.byteLength),
				width: image.width,
				height: image.height,
				durationSec: null,
				fingerprint: image.sha256,
				provenance: "generated" as const,
				deletedAt: null,
			};
		const asset = existing
			? await tx.visualAsset.update({
					where: { id: existing.id },
					data: existing.deletedAt ? data : {},
				})
			: await tx.visualAsset.create({ data });
		const current = await tx.generatedMediaJob.findUniqueOrThrow({
			where: { id: row.id },
		});
		await finalizeGenerationUsage(tx, {
			kind: "image",
			jobId: row.id,
			reservationId: row.usageReservationId,
			units: current.providerUsageImages ?? 1,
		});
		const completed = await tx.generatedMediaJob.update({
			where: { id: row.id },
			data: {
				resultAssetId: asset.id,
				status: "completed",
				moderationStatus: "approved",
				usageStatus: "finalized",
				outcomeUnknown: false,
				executorOwner: null,
				claimExpiresAt: null,
				retryAt: null,
				errorCode: null,
				resultState: pending as unknown as Prisma.InputJsonValue,
				promptExpiresAt: new Date(clock.getTime() + 30 * 86400000),
			},
		});
		await this.analytics(tx, completed, clock, asset.id);
		return this.wake(tx, completed, clock, "generated_ready");
	}
	private async analytics(
		tx: Tx,
		row: GeneratedMediaJob,
		clock: Date,
		assetId?: string,
	) {
		const elapsed = Math.max(0, clock.getTime() - row.createdAt.getTime()),
			latencyBucket =
				elapsed < 10000
					? "under_10s"
					: elapsed < 30000
						? "10_to_30s"
						: elapsed < 90000
							? "30_to_90s"
							: "over_90s";
		const common = {
			workspaceId: row.workspaceId,
			actorUserId: row.createdByUserId,
		};
		const events: unknown[] = [
			{
				...common,
				projectId: row.projectId,
				type: "generated_asset_settled",
				metadata: {
					generatedMediaJobId: row.id,
					assetKind: "image",
					aspectRatio: row.aspectRatio,
					planTier: resolvePricingTier(row.pricingTier),
					outcome:
						row.status === "completed"
							? "succeeded"
							: row.status === "cancelled"
								? "blocked"
								: "failed",
					providerAlias: row.provider,
					modelAlias: row.providerModel,
					lifecycleStatus: row.status,
					latencyBucket,
					retryCount: Math.max(0, row.attempt - 1),
					moderationOutcome: row.moderationStatus,
					usageUnits: row.providerUsageImages ?? 0,
				},
			},
		];
		if (assetId)
			events.push({
				...common,
				projectId: undefined,
				type: "generated_asset_completed",
				metadata: {
					generatedMediaJobId: row.id,
					assetId,
					assetKind: "image",
					aspectRatio: row.aspectRatio,
					planTier: resolvePricingTier(row.pricingTier),
					outcome: "succeeded",
				},
			});
		for (const event of events) {
			const parsed = brandProgramAnalyticsEventSchema.safeParse(event);
			if (!parsed.success) continue;
			await tx.programAnalyticsEvent.create({
				data: {
					...common,
					projectId: parsed.data.projectId ?? null,
					type: parsed.data.type,
					metadata: parsed.data.metadata as Prisma.InputJsonValue,
				},
			});
		}
	}
	private async started(tx: Tx, row: GeneratedMediaJob) {
		return row.claimId
			? Boolean(
					(
						await tx.executionAttempt.findUnique({
							where: { attemptToken: row.claimId },
							select: { processStartedAt: true },
						})
					)?.processStartedAt,
				)
			: false;
	}
	private async unknown(
		tx: Tx,
		row: GeneratedMediaJob,
		clock: Date,
		code: string,
	) {
		const updated = await tx.generatedMediaJob.update({
			where: { id: row.id },
			data: {
				status: "waiting",
				outcomeUnknown: true,
				errorCode: code,
				executorOwner: null,
				claimExpiresAt: null,
				retryAt: null,
			},
		});
		return this.wake(tx, updated, clock, "generated_unknown");
	}
	private async finish(
		tx: Tx,
		row: GeneratedMediaJob,
		clock: Date,
		status: "failed" | "rejected" | "cancelled",
		code: string,
	) {
		if (row.usageStatus === "reserved")
			await releaseGenerationUsage(tx, {
				kind: "image",
				jobIds: [row.id],
				reason: code,
			});
		const updated = await tx.generatedMediaJob.update({
			where: { id: row.id },
			data: {
				status,
				moderationStatus:
					status === "rejected" ? "rejected" : row.moderationStatus,
				usageStatus:
					row.usageStatus === "reserved" ? "released" : row.usageStatus,
				errorCode: code,
				outcomeUnknown: false,
				executorOwner: null,
				claimExpiresAt: null,
				retryAt: null,
			},
		});
		await this.analytics(tx, updated, clock);
		return this.wake(tx, updated, clock, `generated_${status}`);
	}
	private async retry(
		tx: Tx,
		row: GeneratedMediaJob,
		clock: Date,
		code: string,
		delay: number,
	) {
		const updated = await tx.generatedMediaJob.update({
			where: { id: row.id },
			data: {
				status: "queued",
				generation: { increment: 1 },
				claimId: null,
				executorOwner: null,
				claimExpiresAt: null,
				operationDeadlineAt: null,
				outcomeUnknown: false,
				errorCode: code,
				retryAt: new Date(
					clock.getTime() + Math.max(1000, Math.min(86400000, delay)),
				),
				resultState:
					row.executionMode === "recover"
						? ({
								recovery: state(row).recovery!,
							} as unknown as Prisma.InputJsonValue)
						: Prisma.DbNull,
			},
		});
		return { dispatchIds: await this.register(tx, updated) };
	}
	private async withdraw(tx: Tx, row: GeneratedMediaJob, clock: Date) {
		const unknown =
			(await this.started(tx, row)) && row.providerUsageImages === null;
		const result = unknown
			? await this.unknown(
					tx,
					row,
					clock,
					"generated_media_reconciliation_required",
				)
			: await this.finish(
					tx,
					row,
					clock,
					"cancelled",
					"generated_media_forbidden",
				);
		return { ...result, unknown };
	}
	async failExecution(
		tx: Tx,
		ref: GeneratedMediaExecutionReference,
		c: ExecutorMutationContext,
		failure: { failureCode: string; retryable: boolean },
	): Promise<ExecutorMutationResult> {
		const { row, clock } = await this.owned(tx, ref, c);
		if (await this.started(tx, row))
			return this.unknown(
				tx,
				row,
				clock,
				row.executionMode === "recover"
					? "generated_media_publication_reconciliation_required"
					: "generated_media_provider_outcome_unknown",
			);
		if (failure.retryable)
			return this.retry(tx, row, clock, failure.failureCode, 5000);
		return this.finish(tx, row, clock, "failed", failure.failureCode);
	}
	async releaseExecution(
		tx: Tx,
		ref: GeneratedMediaExecutionReference,
		c: ExecutorMutationContext,
		release: { reason: string },
	): Promise<ExecutorMutationResult> {
		const { row, clock } = await this.owned(tx, ref, c);
		return (await this.started(tx, row))
			? this.unknown(
					tx,
					row,
					clock,
					row.executionMode === "recover"
						? "generated_media_publication_reconciliation_required"
						: "generated_media_provider_outcome_unknown",
				)
			: this.retry(tx, row, clock, `generated_media_${release.reason}`, 5000);
	}
	async expireExecution(
		tx: Tx,
		reference: ExecutionDispatchReference,
		token: string,
		observation: ExecutorExpiryObservation,
	): Promise<ExecutorExpiryResult> {
		const locked = await this.lockExecution(tx, reference, token);
		if (locked.kind === "terminal")
			return {
				kind:
					locked.disposition.disposition === "superseded"
						? "superseded"
						: "terminal",
				dispatchIds: locked.dispatchIds,
			};
		const row = await tx.generatedMediaJob.findUniqueOrThrow({
				where: { id: locked.ref.id },
			}),
			clock = await now(tx),
			due =
				observation.kind === "lease"
					? row.claimExpiresAt
					: row.operationDeadlineAt;
		if (!due || due.getTime() !== observation.observedDeadlineAt.getTime())
			return { kind: "superseded" };
		if (due > clock) return { kind: "sleep", dueAt: due };
		const result = (await this.started(tx, row))
			? await this.unknown(
					tx,
					row,
					clock,
					row.executionMode === "recover"
						? "generated_media_publication_reconciliation_required"
						: "generated_media_provider_outcome_unknown",
				)
			: await this.retry(
					tx,
					row,
					clock,
					"generated_media_start_unconfirmed",
					5000,
				);
		return { kind: "expired", dispatchIds: result.dispatchIds };
	}
	async cancel(scope: BrandActorScope, id: string) {
		const ids = await this.database.$transaction(async (tx) => {
			await this.epoch(tx);
			const initial = await tx.generatedMediaJob.findFirst({
				where: { id, workspaceId: scope.workspaceId },
			});
			if (!initial)
				throw new GeneratedMediaJobError("generated_media_job_not_found");
			await this.ownerLocks(tx, initial);
			await this.actor(tx, scope.workspaceId, scope.actorUserId);
			const row = await tx.generatedMediaJob.findUniqueOrThrow({
				where: { id },
			});
			if (terminal.includes(row.status)) return [];
			if (row.outcomeUnknown)
				throw new GeneratedMediaJobError(
					"generated_media_reconciliation_required",
				);
			if ((await this.started(tx, row)) && row.providerUsageImages === null)
				throw new GeneratedMediaJobError(
					"generated_media_cancellation_pending",
				);
			return (
				await this.finish(tx, row, await now(tx), "cancelled", "user_cancelled")
			).dispatchIds;
		});
		await this.confirm(ids);
		return this.get(scope, id);
	}
	async reconcile(
		workspaceId: string,
		id: string,
		decision: GeneratedMediaReconciliation,
	) {
		const snapshot = await this.database.generatedMediaJob.findFirst({
			where: { id, workspaceId },
		});
		if (!snapshot)
			throw new GeneratedMediaJobError("generated_media_job_not_found");
		if (!snapshot.outcomeUnknown)
			throw new GeneratedMediaJobError(
				"generated_media_reconciliation_not_required",
			);
		let source: Source | undefined;
		if (decision.kind === "completed") {
			const attempt = snapshot.claimId ? await this.database.executionAttempt.findUnique({where:{attemptToken:snapshot.claimId}}) : null;
			if (!attempt?.owner) throw new GeneratedMediaJobError("generated_media_provider_result_unavailable");
			const evidence = state(snapshot).evidence;
			const prior = await this.database.executionArtifact.findFirst({
				where: {
					attemptToken: snapshot.claimId!,
					owner: attempt.owner,
					bindingHash: attempt.inputHash,
					...(evidence?.outcome === "completed" ? {id:evidence.binaryArtifactId} : {}),
					role: "validated_asset",
					checksumSha256: { not: null },
					OR: [
						{ committedAt: { not: null } },
						{ multipartCompleteIntentAt: { not: null } },
					],
				},
			});
			const length = prior?.byteLength ?? prior?.uploadByteLength;
			if (
				!prior ||
				!length ||
				!prior.checksumSha256 ||
				length > BigInt(snapshot.outputByteLimit)
			)
				throw new GeneratedMediaJobError(
					"generated_media_provider_result_unavailable",
				);
			const found = await this.dependencies.headArtifact(prior);
			if (
				!found ||
				found.contentType !== "image/png" ||
				found.byteLength !== length ||
				(prior.etag && found.etag !== prior.etag) ||
				(found.sha256 && found.sha256 !== prior.checksumSha256)
			)
				throw new GeneratedMediaJobError(
					"generated_media_provider_result_unavailable",
				);
			if (snapshot.providerRef && snapshot.providerRef !== decision.providerRef)
				throw new GeneratedMediaJobError(
					"generated_media_provider_result_unavailable",
				);
			source = {
				artifactId: prior.id,
				storageKey: prior.storageKey,
				etag: found.etag,
				byteLength: Number(length),
				sha256: prior.checksumSha256,
			};
		}
		const ids = await this.database.$transaction(async (tx) => {
			await this.epoch(tx);
			await this.ownerLocks(tx, snapshot);
			const row = await tx.generatedMediaJob.findUniqueOrThrow({
				where: { id },
			});
			if (
				!row.outcomeUnknown ||
				row.generation !== snapshot.generation ||
				row.claimId !== snapshot.claimId
			)
				throw new GeneratedMediaJobError(
					"generated_media_reconciliation_not_required",
				);
			const clock = await now(tx);
			if (decision.kind === "retry" || decision.kind === "completed") {
				await this.current(tx, row);
				if (row.chargedAttempts + this.dependencies.maxAttempts > 1000000)
					throw new GeneratedMediaJobError("generated_media_claim_lost");
				if (source) {
					const frozen = await tx.executionArtifact.findUniqueOrThrow({
						where: { id: source.artifactId },
					});
					if (
						frozen.attemptToken !== row.claimId ||
						frozen.checksumSha256 !== source.sha256 ||
						(frozen.byteLength ?? frozen.uploadByteLength) !==
							BigInt(source.byteLength)
					)
						throw new GeneratedMediaJobError("generated_media_claim_lost");
				}
				const next = await tx.generatedMediaJob.update({
					where: { id },
					data: {
						status: "queued",
						generation: { increment: 1 },
						claimId: null,
						executorOwner: null,
						claimExpiresAt: null,
						operationDeadlineAt: null,
						outcomeUnknown: false,
						errorCode: null,
						retryAt: clock,
						maxAttempts: row.chargedAttempts + this.dependencies.maxAttempts,
						executionMode:
							decision.kind === "completed" ? "recover" : "generate",
						providerRef:
							decision.kind === "completed" ? decision.providerRef : null,
						providerUsageImages:
							decision.kind === "completed"
								? (decision.usageImages ?? 1)
								: null,
						providerResultContentType:
							decision.kind === "completed" ? "image/png" : null,
						resultState: source
							? ({ recovery: source } as unknown as Prisma.InputJsonValue)
							: Prisma.DbNull,
					},
				});
				return this.register(tx, next);
			}
			return (await this.finish(tx, row, clock, decision.kind, decision.code))
				.dispatchIds;
		});
		await this.confirm(ids);
		return this.inspect(workspaceId, id);
	}
}

/** Cleanup must retain exact private input/output keys while reserved or
 * awaiting explicit outcome reconciliation. Published asset references have
 * their separate reusable-asset hold. */
export async function generatedMediaObjectIsHeld(
	database: PrismaClient,
	key: string,
) {
	const planned =
		/^execution-inputs\/\d+\/generated\/([a-f0-9-]{36})\/\d+\/[a-f0-9-]{36}\.json$/.exec(
			key,
		);
	if (planned) {
		const row = await database.generatedMediaJob.findUnique({
			where: { id: planned[1] },
		});
		if (
			row &&
			state(row).inputPlan?.storageKey === key &&
			(row.usageStatus === "reserved" || row.outcomeUnknown)
		)
			return true;
	}
	const input = await database.executionAttempt.findFirst({
		where: {
			inputStorageKey: key,
			dispatch: { subjectKind: "generated_media" },
		},
		select: { dispatch: { select: { subjectId: true } } },
	});
	const artifact = input
		? null
		: await database.executionArtifact.findUnique({
				where: { storageKey: key },
				select: {
					attempt: {
						select: {
							dispatch: { select: { subjectKind: true, subjectId: true } },
						},
					},
				},
			});
	const subject =
		input?.dispatch.subjectId ??
		(artifact?.attempt.dispatch.subjectKind === "generated_media"
			? artifact.attempt.dispatch.subjectId
			: null);
	if (!subject) return false;
	const row = await database.generatedMediaJob.findUnique({
		where: { id: subject },
		select: { usageStatus: true, outcomeUnknown: true, status: true },
	});
	return Boolean(
		row &&
			(row.usageStatus === "reserved" ||
				row.outcomeUnknown ||
				["queued", "running", "waiting"].includes(row.status)),
	);
}

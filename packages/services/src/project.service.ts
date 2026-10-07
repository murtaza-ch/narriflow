import type { ActorScope } from "./actor-scope";
import { getMcpOperationExecutor } from "./mcp-operation-runtime";
import { mcpOperationFingerprint, type McpMutationOptions } from "./mcp-operation";
import { getIngestJobLifecycle } from "./ingest-job-lifecycle-runtime";
import { getProcessingUsage } from "./processing-usage-runtime";
import {
	isProcessingUsageFailureCode,
	PROCESSING_USAGE_TRANSACTION,
	ProcessingUsageError,
	processingUsageFailureCatalog,
	type ProcessingUsageSummary,
} from "./processing-usage";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type {
	IngestStatus as PrismaIngestStatus,
	Project,
	Transcript as PrismaTranscript,
	WorkflowRun as PrismaWorkflowRun,
} from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
	ASSEMBLYAI_SPEECH_MODEL_CHAIN,
	detectLinkProvider,
	generateProjectRequestSchema,
	linkIngestSchema,
	resolvePricingTier,
	rssImportSchema,
	rssPreviewSchema,
	sourceLanguageCodeSchema,
	workflowStageUpdatedEventSchema,
	type WorkflowStageUpdatedEvent,
	contentPackSchema,
	parseStoredContentPack,
	deriveProjectListProgress,
	PLATFORM_PLAYBOOK_VERSION,
	type ContentPack,
	type GenerateProjectInput,
	type LinkIngestInput,
	type RssImportInput,
	userErrorMessage,
	type TranscriptExportFormat,
	type TranscriptSnapshot,
} from "@narriflow/validators";
import { deleteObject } from "./r2-storage";
import { brandTemplateService } from "./brand-template.service";
import { brandProfileService } from "./brand-profile.service";
import type { BrandActorScope } from "./brand-ownership";
import {
	autoTriggerIdempotencyKey,
	isUniqueConstraintError,
	type FinalizeSetupResult,
} from "./generation-sequencing";
import { fetchRssFeed, redactUrlForDisplay } from "./rss";
import {
	buildTranscriptSnapshot,
	exportTranscript,
} from "./transcript.service";
import { getLastWorkflowSeq, getWorkflowEventsSince } from "./workflow.service";
import { toProjectSnapshot, type ProjectSnapshot } from "./project-snapshot";
import { projectRetentionService } from "./project-retention.service";
import { accessibleProjectWhere } from "./project-access";
import {
	ExpectedDomainFailureError,
	type ExpectedDomainFailureCatalog,
} from "./expected-domain-failure";
import {
	workspaceService,
	type WorkspaceCapability,
} from "./workspace.service";
import { getWorkflowRunLifecycle } from "./workflow-run-lifecycle";

type ProjectAccessResult = "owned" | "forbidden" | "missing";

const STT_PROVIDER = "assemblyai";
const STT_PROVIDER_MODEL = ASSEMBLYAI_SPEECH_MODEL_CHAIN.join(",");
// Defensive upper bound on how many persisted WorkflowEvent rows a single
// project page fetch will ever pull for the Activity tab; the client applies
// its own tighter display cap (PROJECT_EVENT_ROW_LIMIT) on top of this.
const WORKFLOW_HISTORY_FETCH_LIMIT = 200;

function isMissingObjectError(error: unknown) {
	if (typeof error !== "object" || error === null) return false;
	const candidate = error as {
		name?: unknown;
		code?: unknown;
		Code?: unknown;
	};
	const codes = [candidate.code, candidate.Code].filter(
		(value): value is string => typeof value === "string",
	);
	if (codes.length > 0) {
		return codes.every((code) => ["NoSuchKey", "NotFound"].includes(code));
	}
	return ["NoSuchKey", "NotFound"].includes(String(candidate.name ?? ""));
}

function toWorkflowRunSnapshot(row: PrismaWorkflowRun) {
	return {
		workflowRunId: row.id,
		projectId: row.projectId,
		stage: row.stage,
		status: row.status,
		progress: row.progress,
		errorCode: row.errorCode,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
		lastSeq: 0,
	};
}

function toTranscriptSnapshot(row: PrismaTranscript): TranscriptSnapshot {
	return buildTranscriptSnapshot({
		projectId: row.projectId,
		status: row.status,
		provider: row.provider,
		providerModel: row.providerModel,
		providerJobId: row.providerJobId,
		languageCode: row.languageCode,
		languageConfidence: row.languageConfidence,
		text: row.text,
		utterancesJson: row.utterancesJson,
		speakerCount: row.speakerCount,
		durationSeconds: row.durationSeconds,
		errorCode: row.errorCode,
		completedAt: row.completedAt ? row.completedAt.toISOString() : null,
		updatedAt: row.updatedAt.toISOString(),
	});
}

export const projectFailureCatalog = {
	idempotency_key_required: "invalid",
	generation_settings_conflict: "conflict",
	link_unsupported_source: "unprocessable",
	project_access_denied: "forbidden",
	project_deletion_incomplete: "unavailable",
	project_has_active_publication: "conflict",
	project_has_active_workflow: "conflict",
	project_ingest_not_ready: "conflict",
	project_not_found: "missing",
	project_processing_not_settled: "conflict",
	rss_commit_token_requires_single_episode: "invalid",
	rss_episode_count_invalid: "invalid",
	rss_episode_not_found: "missing",
	rss_ingest_job_missing: "unavailable",
	transcript_not_found: "missing",
	transcript_not_ready: "conflict",
} as const satisfies ExpectedDomainFailureCatalog<string>;

export type ProjectFailureCode = keyof typeof projectFailureCatalog;

export class ProjectServiceError extends ExpectedDomainFailureError<ProjectFailureCode> {
	constructor(code: ProjectFailureCode, message: string) {
		super({ code, kind: projectFailureCatalog[code], message });
		this.name = "ProjectServiceError";
	}
}

// ---------------------------------------------------------------------------
// Self-serve project deletion. Errors mirror the getProjectAccess three-way
// discriminator ("missing" -> 404, "forbidden" -> 403) plus two deletion-
// specific refusals. The orchestration itself (runProjectDeletion below) is a
// pure, dependency-injected function — same shape as resolveExistingUploadResume
// above — so its guarantees (ownership, the active-run guard, the "storage
// deletes before the DB row" ordering, and idempotent re-delete) have direct
// unit coverage without touching a real database or R2 bucket.
// ---------------------------------------------------------------------------

export class ProjectNotFoundError extends ExpectedDomainFailureError<"project_not_found"> {
	constructor() {
		super({
			code: "project_not_found",
			kind: projectFailureCatalog.project_not_found,
			message: "Project not found.",
		});
		this.name = "ProjectNotFoundError";
	}
}

export class LinkUnsupportedSourceError extends ExpectedDomainFailureError<"link_unsupported_source"> {
	constructor() {
		super({
			code: "link_unsupported_source",
			kind: projectFailureCatalog.link_unsupported_source,
			message: "This link source is not supported.",
		});
		this.name = "LinkUnsupportedSourceError";
	}
}

export class ProjectAccessDeniedError extends ExpectedDomainFailureError<"project_access_denied"> {
	constructor() {
		super({
			code: "project_access_denied",
			kind: projectFailureCatalog.project_access_denied,
			message: "You don't have access to this project.",
		});
		this.name = "ProjectAccessDeniedError";
	}
}

export class ProjectHasActiveWorkflowError extends ExpectedDomainFailureError<"project_has_active_workflow"> {
	constructor() {
		super({
			code: "project_has_active_workflow",
			kind: projectFailureCatalog.project_has_active_workflow,
			message:
				"This project has a run in progress. Wait for it to finish, then try deleting again.",
		});
		this.name = "ProjectHasActiveWorkflowError";
	}
}

export class ProjectHasActivePublicationError extends ExpectedDomainFailureError<"project_has_active_publication"> {
	constructor() {
		super({
			code: "project_has_active_publication",
			kind: projectFailureCatalog.project_has_active_publication,
			message:
				"This project has a live or uncertain social publication. Resolve it before deleting the project.",
		});
		this.name = "ProjectHasActivePublicationError";
	}
}

export class ProjectDeletionIncompleteError extends ExpectedDomainFailureError<
	"project_deletion_incomplete",
	{ failedKeyCount: number }
> {
	constructor(failedKeyCount: number) {
		super({
			code: "project_deletion_incomplete",
			kind: projectFailureCatalog.project_deletion_incomplete,
			message:
				"Some of this project's files couldn't be removed from storage. Please try deleting again.",
			details: { failedKeyCount },
		});
		this.name = "ProjectDeletionIncompleteError";
	}
}

/**
 * Every storage-key-bearing row a project may own, already fetched — kept
 * separate from the Prisma query shape so the planning logic below has no
 * dependency on a live database.
 *
 * Deliberately excludes: `Clip.brollUrl` and `studioEdits.music.url` (these
 * are user-supplied public HTTP URLs validated by assertPublicHttpUrl
 * elsewhere, never R2 objects this project owns) and `BrandTemplate.
 * logoStorageKey` / anything inside `Project.brandSnapshot` (owned by the
 * user's brand template, which other projects may still reference — deleting
 * one project must never delete a shared template's logo).
 */
export interface ProjectStorageSnapshot {
	sourceStorageKey: string | null;
	transcriptRawStorageKey: string | null;
	clipPreviewStorageKeys: ReadonlyArray<string | null>;
	clipRenderStorageKeys: ReadonlyArray<string | null>;
	clipDubStorageKeys: ReadonlyArray<string | null>;
}

export interface ProjectDeletionPlan {
	/** Deduped R2 object keys to DeleteObject. */
	objectKeysToDelete: string[];
}

/**
 * Pure enumeration of everything a project deletion must touch in R2. Exported
 * and tested directly so "which tables get swept" has coverage independent of
 * the Prisma query that feeds it in ProjectService.deleteProject below.
 */
export function planProjectStorageDeletion(
	snapshot: ProjectStorageSnapshot,
): ProjectDeletionPlan {
	const keys = new Set<string>();
	const addKey = (key: string | null | undefined) => {
		if (key) keys.add(key);
	};

	addKey(snapshot.sourceStorageKey);
	addKey(snapshot.transcriptRawStorageKey);
	snapshot.clipPreviewStorageKeys.forEach(addKey);
	snapshot.clipRenderStorageKeys.forEach(addKey);
	snapshot.clipDubStorageKeys.forEach(addKey);

	return { objectKeysToDelete: Array.from(keys) };
}

export interface ProjectDeletionIo {
	deleteObject: (key: string) => Promise<unknown>;
	isMissingObjectError: (error: unknown) => boolean;
}

export interface ProjectDeletionIoResult {
	/** Keys that failed for a reason OTHER than "already missing" — these
	 *  block the DB row from being deleted so the objects stay reachable and
	 *  retryable rather than orphaned forever. */
	failedKeys: string[];
}

/**
 * Executes a storage deletion plan resiliently: every key is attempted via
 * Promise.allSettled (one bad key can't stop the rest), and "already gone"
 * is treated as success exactly like purgeExpiredProjectSources does. Only
 * genuine failures are returned, since those are what must keep the DB row
 * alive for a retry.
 */
export async function deleteProjectStorageObjects(
	plan: ProjectDeletionPlan,
	io: ProjectDeletionIo,
): Promise<ProjectDeletionIoResult> {
	const results = await Promise.allSettled(
		plan.objectKeysToDelete.map((key) => io.deleteObject(key)),
	);

	const failedKeys: string[] = [];
	results.forEach((result, index) => {
		if (
			result.status === "rejected" &&
			!io.isMissingObjectError(result.reason)
		) {
			failedKeys.push(plan.objectKeysToDelete[index]!);
		}
	});

	return { failedKeys };
}

export type ProjectDeletionOutcome =
	| { kind: "not_found" }
	| { kind: "forbidden" }
	| { kind: "active_workflow" }
	| { kind: "active_publication" }
	| { kind: "storage_incomplete"; failedKeys: string[] }
	| { kind: "deleted" }
	| { kind: "already_deleted" };

export interface ProjectDeletionRow {
	/** Whether any WorkflowRun for this project is still queued/running —
	 *  same guard purgeExpiredProjectSources uses before touching a source. */
	hasActiveWorkflowRun: boolean;
	hasActivePublication: boolean;
	storage: ProjectStorageSnapshot;
}

export interface ProjectDeletionAccessResult {
	access: "missing" | "forbidden" | "owned";
	row: ProjectDeletionRow | null;
}

export interface ProjectDeletionDeps {
	getAccessAndRow: () => Promise<ProjectDeletionAccessResult>;
	deleteObject: (key: string) => Promise<unknown>;
	isMissingObjectError: (error: unknown) => boolean;
	/** Conditioned delete (e.g. `deleteMany({ where: { id, workspaceId } })`) so a
	 *  row a concurrent call already removed resolves to count 0 instead of
	 *  throwing — this is what makes repeated/racing calls safe. */
	deleteProjectRow: () => Promise<{ count: number }>;
}

/**
 * Pure orchestration for project deletion, fully dependency-injected so
 * every guarantee below has direct
 * test coverage without a live database or R2 bucket:
 *
 *  - ownership: "missing"/"forbidden" access short-circuits before any I/O.
 *  - the active-run guard: a queued/running WorkflowRun blocks deletion.
 *  - storage-first ordering: the DB row is only deleted once every storage
 *    key either deleted cleanly or was already gone; any other failure
 *    leaves the row intact so the objects stay reachable and retryable.
 *  - idempotent re-delete: deleteProjectRow resolving to count 0 (the row
 *    was already gone) is a success-shaped no-op, not a thrown error.
 */
export async function runProjectDeletion(
	deps: ProjectDeletionDeps,
): Promise<ProjectDeletionOutcome> {
	const { access, row } = await deps.getAccessAndRow();

	// Check the discriminator itself first: "forbidden" also carries a null
	// row (there's nothing to hand back for someone else's project), so a
	// combined "missing or no row" check here would misclassify it as
	// not_found instead of forbidden.
	if (access === "missing") {
		return { kind: "not_found" };
	}
	if (access === "forbidden") {
		return { kind: "forbidden" };
	}
	if (!row) {
		return { kind: "not_found" };
	}
	if (row.hasActiveWorkflowRun) {
		return { kind: "active_workflow" };
	}
	if (row.hasActivePublication) {
		return { kind: "active_publication" };
	}

	const plan = planProjectStorageDeletion(row.storage);
	const { failedKeys } = await deleteProjectStorageObjects(plan, {
		deleteObject: deps.deleteObject,
		isMissingObjectError: deps.isMissingObjectError,
	});

	if (failedKeys.length > 0) {
		return { kind: "storage_incomplete", failedKeys };
	}

	const deleteResult = await deps.deleteProjectRow();
	return deleteResult.count > 0
		? { kind: "deleted" }
		: { kind: "already_deleted" };
}

export class ProjectService {
	private requirePrisma() {
		const prisma = getPrismaClient();

		if (!prisma) {
			throw new Error("Database client unavailable");
		}

		return prisma;
	}

	private requireActor(
		scope: ActorScope,
		capability: WorkspaceCapability = "content.edit",
	) {
		return workspaceService.requireActor(
			scope.actorUserId,
			scope.workspaceId,
			capability,
		);
	}

	private async resolveProjectScope(
		scope: ActorScope,
		capability: WorkspaceCapability = "content.view",
	): Promise<Prisma.ProjectWhereInput> {
		const actor = await this.requireActor(scope, capability);
		return { workspaceId: actor.workspaceId };
	}

	async getProjectAccess(
		scope: ActorScope,
		projectId: string,
	): Promise<ProjectAccessResult> {
		const prisma = this.requirePrisma();

		const projectWhere = await this.resolveProjectScope(scope);
		const project = await prisma.project.findUnique({
			where: { id: projectId },
			select: {
				workspaceId: true,
				expiresAt: true,
				purgeStartedAt: true,
			},
		});

		if (!project) {
			return "missing";
		}

		if (
			project.purgeStartedAt ||
			(project.expiresAt && project.expiresAt.getTime() <= Date.now())
		) {
			return "missing";
		}
		const scopeMatch = await prisma.project.count({
			where: { id: projectId, AND: [projectWhere] },
		});
		return scopeMatch > 0 ? "owned" : "forbidden";
	}

	/**
	 * Self-serve, user-initiated project deletion — distinct from
	 * purgeExpiredProjectSources's time-based retention sweep (that only ever
	 * reclaims the source object once it has aged out; this deletes the whole
	 * project and everything it owns, right now, on the user's request).
	 *
	 * Storage is deleted before the DB row, and the row is only removed once
	 * every key deleted cleanly or was already gone — a partial storage
	 * failure leaves the project row intact so a retry can find the same
	 * (still-referenced) keys again rather than orphaning them. See
	 * runProjectDeletion above for the guarantees this wires together.
	 *
	 * Storage-key-bearing tables covered: Project.sourceStorageKey,
	 * Transcript.rawStorageKey, Clip.previewStorageKey, ClipRender.storageKey,
	 * and ClipDub.audioStorageKey/renderStorageKey.
	 * Deliberately NOT touched: BrandTemplate.logoStorageKey and any logo key
	 * embedded in Project.brandSnapshot (owned by the user's brand template,
	 * which other projects may still reference) and Clip.brollUrl /
	 * studioEdits.music.url (external HTTP URLs, not objects this project
	 * owns in R2).
	 */
	async deleteProject(scope: ActorScope, projectId: string): Promise<void> {
		await this.requireActor(scope, "content.edit");
		const prisma = this.requirePrisma();

		const outcome = await runProjectDeletion({
			getAccessAndRow: async () => {
				const project = await prisma.project.findUnique({
					where: { id: projectId },
					select: {
						workspaceId: true,
						expiresAt: true,
						purgeStartedAt: true,
						sourceStorageKey: true,
						transcript: { select: { rawStorageKey: true } },
						clips: {
							select: {
								previewStorageKey: true,
								renders: { select: { storageKey: true } },
								dubs: {
									select: { audioStorageKey: true, renderStorageKey: true },
								},
							},
						},
						workflowRuns: {
							where: { status: { in: ["queued", "running", "waiting"] } },
							select: { id: true },
							take: 1,
						},
						socialPosts: {
							where: {
								status: {
									in: [
										"publishing",
										"processing",
										"reconciling",
										"needs_attention",
									],
								},
							},
							select: { id: true },
							take: 1,
						},
					},
				});

				if (!project) {
					return { access: "missing", row: null };
				}
				if (project.workspaceId !== scope.workspaceId) {
					return { access: "forbidden", row: null };
				}

				if (
					project.purgeStartedAt ||
					(project.expiresAt && project.expiresAt <= new Date())
				)
					return { access: "missing", row: null };

				return {
					access: "owned",
					row: {
						hasActiveWorkflowRun: project.workflowRuns.length > 0,
						hasActivePublication: project.socialPosts.length > 0,
						storage: {
							sourceStorageKey: project.sourceStorageKey,
							transcriptRawStorageKey:
								project.transcript?.rawStorageKey ?? null,
							clipPreviewStorageKeys: project.clips.map(
								(clip) => clip.previewStorageKey,
							),
							clipRenderStorageKeys: project.clips.flatMap((clip) =>
								clip.renders.map((render) => render.storageKey),
							),
							clipDubStorageKeys: project.clips.flatMap((clip) =>
								clip.dubs.flatMap((dub) => [
									dub.audioStorageKey,
									dub.renderStorageKey,
								]),
							),
						},
					},
				};
			},
			deleteObject,
			isMissingObjectError,
			deleteProjectRow: async () => {
				const notDeleted = new Error("project_not_deleted");
				try {
					return await prisma.$transaction(async (tx) => {
						// Deleting an intake before settlement returns its reservation.
						// Settled usage has no Project foreign key and is unchanged.
						// Release precedes the Project row lock, as settlement orders them.
						await getProcessingUsage().release(tx, {
							projectId,
							reason: "project_deleted",
						});
						const result = await tx.project.deleteMany({
							where: {
								id: projectId,
								workspaceId: scope.workspaceId,
								...accessibleProjectWhere(),
							},
						});
						if (result.count === 0) throw notDeleted;
						return { count: result.count };
					});
				} catch (error) {
					if (error === notDeleted) return { count: 0 };
					throw error;
				}
			},
		});

		switch (outcome.kind) {
			case "not_found":
				throw new ProjectNotFoundError();
			case "forbidden":
				throw new ProjectAccessDeniedError();
			case "active_workflow":
				throw new ProjectHasActiveWorkflowError();
			case "active_publication":
				throw new ProjectHasActivePublicationError();
			case "storage_incomplete":
				console.warn(
					JSON.stringify({
						level: "warn",
						message: "project_delete_storage_incomplete",
						projectId,
						failedKeyCount: outcome.failedKeys.length,
					}),
				);
				throw new ProjectDeletionIncompleteError(outcome.failedKeys.length);
			case "deleted":
			case "already_deleted":
				return;
		}
	}

	async getProjectSnapshot(scope: ActorScope, projectId: string) {
		const prisma = this.requirePrisma();

		const projectWhere = await this.resolveProjectScope(scope);
		const row = await prisma.project.findFirst({
			where: { id: projectId, AND: [projectWhere, accessibleProjectWhere()] },
		});
		if (!row)
			return {
				project: null,
				progress: null,
				activeRun: null,
				lastSeq: 0,
				ingestAttemptCount: 0,
			};
		const [activeWorkflowRun, latestRun, lastSeq, ingestAttemptCount] =
			await Promise.all([
				prisma.workflowRun.findFirst({
					where: {
						projectId,
						status: { in: ["queued", "running", "waiting"] },
					},
					orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
				}),
				prisma.workflowRun.findFirst({
					where: { projectId },
					orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
				}),
				getLastWorkflowSeq(projectId),
				// Total ingest attempts so far (original + retries) — lets the project
				// page decide whether "Retry ingest" is still allowed.
				prisma.ingestJob.count({ where: { projectId } }),
			]);
		const project = toProjectSnapshot(row);
		const relevantRun = activeWorkflowRun ?? latestRun;

		return {
			project,
			progress: deriveProjectListProgress({
				ingestStatus: row.ingestStatus,
				workflowRuns: relevantRun ? [relevantRun] : [],
			}),
			activeRun: relevantRun ? toWorkflowRunSnapshot(relevantRun) : null,
			lastSeq,
			ingestAttemptCount,
		};
	}

	/**
	 * Persisted WorkflowEvent history for the Activity tab's initial paint —
	 * reuses getWorkflowEventsSince (the same durable-catch-up source the SSE
	 * route already replays from) instead of a second query path, and bounds
	 * the payload defensively; the client applies its own tighter display cap.
	 */
	async getWorkflowHistory(
		scope: ActorScope,
		projectId: string,
	): Promise<WorkflowStageUpdatedEvent[]> {
		const access = await this.getProjectAccess(scope, projectId);
		if (access !== "owned") {
			return [];
		}

		const events = await getWorkflowEventsSince(projectId, 0);
		const recent = events.slice(-WORKFLOW_HISTORY_FETCH_LIMIT);

		const validated: WorkflowStageUpdatedEvent[] = [];
		for (const event of recent) {
			const parsed = workflowStageUpdatedEventSchema.safeParse(event);
			if (parsed.success) {
				validated.push(parsed.data);
			}
		}
		return validated;
	}

	async getIngestSnapshot(scope: ActorScope, projectId: string) {
		await this.requireActor(scope, "content.view");
		const prisma = this.requirePrisma();
		const [row, activeWorkflowRun, latestRun, lastSeq] = await Promise.all([
			prisma.project.findFirst({
				where: {
					id: projectId,
					workspaceId: scope.workspaceId,
					...accessibleProjectWhere(),
				},
			}),
			prisma.workflowRun.findFirst({
				where: { projectId, status: { in: ["queued", "running", "waiting"] } },
				orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
			}),
			prisma.workflowRun.findFirst({
				where: { projectId },
				orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
			}),
			getLastWorkflowSeq(projectId),
		]);

		if (!row) {
			return null;
		}

		const relevantRun = activeWorkflowRun ?? latestRun;
		return {
			project: toProjectSnapshot(row),
			progress: deriveProjectListProgress({
				ingestStatus: row.ingestStatus,
				workflowRuns: relevantRun ? [relevantRun] : [],
			}),
			activeRun: relevantRun ? toWorkflowRunSnapshot(relevantRun) : null,
			lastSeq,
		};
	}

	async getWorkflowRun(
		scope: ActorScope,
		projectId: string,
		workflowRunId: string,
	) {
		const projectWhere = await this.resolveProjectScope(scope);
		const prisma = this.requirePrisma();
		const project = await prisma.project.findFirst({
			where: { id: projectId, AND: [projectWhere, accessibleProjectWhere()] },
			select: { id: true },
		});
		if (!project) return { run: null, lastSeq: 0 };
		const [dbRun, lastSeq] = await Promise.all([
			// Scope by projectId so a run from another tenant's project can't be read
			// by passing a foreign workflowRunId to an owned project's route.
			prisma.workflowRun.findFirst({
				where: { id: workflowRunId, projectId },
			}),
			getLastWorkflowSeq(projectId),
		]);

		return {
			run: dbRun ? toWorkflowRunSnapshot(dbRun) : null,
			lastSeq,
		};
	}

	async getTranscriptSnapshot(scope: ActorScope, projectId: string) {
		await this.requireActor(scope, "content.view");
		const prisma = this.requirePrisma();
		const row = await prisma.transcript.findFirst({
			where: {
				projectId,
				project: {
					workspaceId: scope.workspaceId,
					...accessibleProjectWhere(),
				},
			},
		});

		return row ? toTranscriptSnapshot(row) : null;
	}

	/** Status-only project-page read. Keeps the multi-thousand-word utterance
	 * payload off routes whose selected tab does not render the transcript. */
	async getTranscriptStatusSnapshot(scope: ActorScope, projectId: string) {
		await this.requireActor(scope, "content.view");
		const prisma = this.requirePrisma();
		return prisma.transcript.findFirst({
			where: {
				projectId,
				project: {
					workspaceId: scope.workspaceId,
					...accessibleProjectWhere(),
				},
			},
			select: { status: true, errorCode: true },
		});
	}

	/**
	 * Raw utterances for timeline/trim UIs. Deliberately skips the snapshot
	 * zod-parse: utterances were schema-validated when persisted, and
	 * re-validating ~8k word objects on every request added seconds of
	 * latency to an endpoint whose consumer re-normalizes anyway.
	 */
	async getTranscriptUtterancesRaw(scope: ActorScope, projectId: string) {
		await this.requireActor(scope, "content.view");
		const prisma = this.requirePrisma();
		const row = await prisma.transcript.findFirst({
			where: {
				projectId,
				project: {
					workspaceId: scope.workspaceId,
					...accessibleProjectWhere(),
				},
				status: "completed",
			},
			select: { utterancesJson: true },
		});

		return row ? (row.utterancesJson ?? []) : null;
	}

	async getTranscriptExport(
		scope: ActorScope,
		projectId: string,
		format: TranscriptExportFormat,
	) {
		const transcript = await this.getTranscriptSnapshot(scope, projectId);

		if (!transcript) {
			throw new ProjectServiceError(
				"transcript_not_found",
				"Transcript not found.",
			);
		}

		if (transcript.status !== "completed") {
			throw new ProjectServiceError(
				"transcript_not_ready",
				"The transcript is not ready.",
			);
		}

		const slug = (transcript.languageCode ?? "transcript").replace(
			/[^a-zA-Z0-9_-]/g,
			"-",
		);

		return {
			fileName: `${projectId}-${slug}.${format}`,
			body: exportTranscript(transcript, format),
			contentType:
				format === "txt"
					? "text/plain; charset=utf-8"
					: format === "srt"
						? "application/x-subrip; charset=utf-8"
						: "text/vtt; charset=utf-8",
		};
	}

	/**
	 * Regeneration consumes no further minutes, but it requires the Project's
	 * processing to have been settled by its first speech-to-text admission.
	 */
	async assertProjectProcessingSettled(
		scope: ActorScope,
		projectId: string,
	): Promise<void> {
		await this.requireActor(scope, "processing.consume");
		const usage = await this.requirePrisma().processingUsageReservation.findUnique(
			{ where: { projectId }, select: { workspaceId: true, state: true } },
		);
		if (usage?.workspaceId !== scope.workspaceId)
			throw new ProjectNotFoundError();
		if (usage.state !== "settled" && usage.state !== "refunded")
			throw new ProjectServiceError(
				"project_processing_not_settled",
				"This project has not been transcribed yet.",
			);
	}

	/**
	 * Settles the Project's processing minutes inside a speech-to-text admission
	 * transaction, before the Project generation lock. A refusal is recorded on
	 * the Ingest Job and Project in the same transaction and returned so the
	 * caller can commit it before reporting the typed failure.
	 */
	private async settleForGeneration(
		tx: Prisma.TransactionClient,
		workspaceId: string,
		projectId: string,
	): Promise<ExpectedDomainFailureError | null> {
		const project = await tx.project.findFirst({
			where: { id: projectId, workspaceId, ...accessibleProjectWhere() },
			select: { id: true },
		});
		if (!project) throw new ProjectNotFoundError();
		const settlement = await getProcessingUsage().settle(tx, projectId);
		if (settlement.outcome === "not_ready") {
			// A replay after a committed refusal reports the same typed failure.
			const failed = await tx.project.findUniqueOrThrow({
				where: { id: projectId },
				select: { ingestStatus: true, ingestErrorCode: true },
			});
			if (
				failed.ingestStatus === "failed" &&
				isProcessingUsageFailureCode(failed.ingestErrorCode)
			)
				throw new ExpectedDomainFailureError({
					code: failed.ingestErrorCode,
					kind: processingUsageFailureCatalog[failed.ingestErrorCode],
					message:
						userErrorMessage(failed.ingestErrorCode) ??
						"This project can't be processed on the current plan.",
				});
			throw new ProjectServiceError(
				"project_ingest_not_ready",
				"Project ingest is not ready.",
			);
		}
		if (settlement.outcome === "settled") return null;
		await getIngestJobLifecycle().refuseGeneration(
			tx,
			projectId,
			settlement.failure,
		);
		return settlement.failure;
	}

	async triggerGeneration(
		scope: ActorScope,
		projectId: string,
		input: GenerateProjectInput,
		idempotencyKey: string,
		options: {
			existingContentPackId?: string;
			mutation?: McpMutationOptions;
		} = {},
	) {
		const parsed = generateProjectRequestSchema.parse(input);
		await this.requireActor(scope, "processing.consume");
		if (options.mutation) {
			const mutation = options.mutation;
			const accepted = await getMcpOperationExecutor().execute<{
				workflowRunId: string;
				acceptedAt: string;
				initialSeq: number;
			}>({
				identity: {
					workspaceId: scope.workspaceId,
					callerId: mutation.callerId ?? scope.actorUserId,
					toolName: "narriflow_generate_clips",
					clientIdempotencyKey: mutation.clientIdempotencyKey,
				},
				input: {
					projectId,
					settings: parsed,
					contentPackId: options.existingContentPackId ?? null,
				},
				authorize: async () => {
					await this.requireActor(scope, "processing.consume");
				},
				beforeAccept: mutation.beforeAccept,
				mutate: async (tx) => {
					const refusal = await this.settleForGeneration(
						tx,
						scope.workspaceId,
						projectId,
					);
					if (refusal) return { refusal };
					await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${projectId}, 0))::text`;
					await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${projectId}::uuid FOR UPDATE`;
					const project = await tx.project.findFirst({
						where: {
							id: projectId,
							workspaceId: scope.workspaceId,
							...accessibleProjectWhere(),
						},
						select: {
							id: true,
							ingestStatus: true,
							transcript: { select: { status: true } },
						},
					});
					if (!project) throw new ProjectNotFoundError();
					if (project.ingestStatus !== "ready")
						throw new ProjectServiceError(
							"project_ingest_not_ready",
							"Project ingest is not ready.",
						);
					if (parsed.forceRegenerate) {
						const active = await tx.workflowRun.findFirst({
							where: {
								projectId,
								stage: { in: ["stt", "moment_detection", "clip_rendering"] },
								status: { in: ["queued", "running", "waiting"] },
							},
							select: { id: true },
						});
						const pendingRender = await tx.clipRender.findFirst({
							where: {
								clip: { projectId },
								exportVariantId: null,
								status: { in: ["pending", "rendering"] },
							},
							select: { id: true },
						});
						if (active || pendingRender) {
							throw new ProjectServiceError(
								"project_has_active_workflow",
								"Generation or rendering is still in progress. Wait for it to finish before requesting a fresh generation.",
							);
						}
					}
					const reusable = !parsed.forceRegenerate
						? await tx.workflowRun.findFirst({
								where: {
									projectId,
									stage: "stt",
									...(project.transcript?.status === "completed"
										? {}
										: { status: { in: ["queued", "running", "waiting"] } }),
								},
								orderBy: { updatedAt: "desc" },
								select: { id: true, updatedAt: true },
							})
						: null;
					const contentPackId = options.existingContentPackId ?? null;
					const admitted =
						reusable ??
						(await getWorkflowRunLifecycle().admitTranscript(
							{
								projectId,
								idempotencyKey,
								contentPackId,
								contentPack: contentPackId
									? undefined
									: parseStoredContentPack(parsed.contentPack),
								languageCode: parsed.languageCode,
								transcriptProvider: STT_PROVIDER,
								transcriptProviderModel: STT_PROVIDER_MODEL,
							},
							tx,
						));
					const acceptedRun = await tx.workflowRun.findUniqueOrThrow({
						where: { id: admitted.id },
						select: {
							contentPack: true,
							project: { select: { languageCode: true } },
						},
					});
					if (
						!acceptedRun.contentPack ||
						acceptedRun.contentPack.draft ||
						mcpOperationFingerprint(
							parseStoredContentPack(acceptedRun.contentPack),
						) !== mcpOperationFingerprint(parsed.contentPack) ||
						acceptedRun.project.languageCode !== parsed.languageCode
					) {
						throw new ProjectServiceError(
							"generation_settings_conflict",
							"Existing generation uses different settings. Request a fresh generation with forceRegenerate after current work completes.",
						);
					}
					const events = await tx.workflowEvent.aggregate({
						where: { projectId },
						_max: { seq: true },
					});
					return {
						resourceType: "workflow_run",
						resourceId: admitted.id,
						value: {
							workflowRunId: admitted.id,
							acceptedAt:
								reusable?.updatedAt.toISOString() ?? new Date().toISOString(),
							initialSeq: events._max.seq ?? 0,
						},
					};
				},
			});
			return accepted.value;
		}

		if (!idempotencyKey)
			throw new ProjectServiceError(
				"idempotency_key_required",
				"An idempotency key is required.",
			);
		const prisma = this.requirePrisma();
		const outcome = await prisma.$transaction(async (tx) => {
			const refusal = await this.settleForGeneration(
				tx,
				scope.workspaceId,
				projectId,
			);
			if (refusal) return { refusal };
			const project = await tx.project.findFirstOrThrow({
				where: { id: projectId },
				select: {
					ingestStatus: true,
					transcript: { select: { status: true } },
				},
			});
			if (project.ingestStatus !== "ready")
				throw new ProjectServiceError(
					"project_ingest_not_ready",
					"Project ingest is not ready.",
				);
			if (!parsed.forceRegenerate) {
				const reusable = await tx.workflowRun.findFirst({
					where: {
						projectId,
						...(project.transcript?.status === "completed"
							? {}
							: { status: { in: ["queued", "running", "waiting"] } }),
					},
					orderBy: { updatedAt: "desc" },
					select: { id: true, updatedAt: true },
				});
				if (reusable)
					return { workflowRunId: reusable.id, acceptedAt: reusable.updatedAt };
			}
			const contentPackId = options.existingContentPackId ?? null;
			const admitted = await getWorkflowRunLifecycle().admitTranscript(
				{
					projectId,
					idempotencyKey,
					contentPackId,
					contentPack: contentPackId
						? undefined
						: parseStoredContentPack(parsed.contentPack),
					languageCode: parsed.languageCode,
					transcriptProvider: STT_PROVIDER,
					transcriptProviderModel: STT_PROVIDER_MODEL,
				},
				tx,
			);
			return { workflowRunId: admitted.id, acceptedAt: new Date() };
		}, PROCESSING_USAGE_TRANSACTION);
		if ("refusal" in outcome) throw outcome.refusal;
		return {
			workflowRunId: outcome.workflowRunId,
			acceptedAt: outcome.acceptedAt.toISOString(),
			initialSeq: await getLastWorkflowSeq(projectId),
		};
	}

	async queueLinkIngest(
		scope: ActorScope,
		input: LinkIngestInput,
		options: {
			generationContext?: {
				contentPack: ContentPack;
				languageCode: string | null;
			};
			mutation?: McpMutationOptions;
		} = {},
	) {
		const parsed = linkIngestSchema.parse(input);
		const prisma = this.requirePrisma();
		const actor = await this.requireActor(scope, "processing.consume");

		// Idempotent replay: the same commit token returns the already-created
		// project instead of importing twice (double-click, retried request).
		if (parsed.commitToken && !options.mutation) {
			const existing = await prisma.project.findUnique({
				where: { commitToken: parsed.commitToken },
				include: { ingestJobs: { orderBy: { createdAt: "desc" }, take: 1 } },
			});
			if (existing) {
				if (existing.workspaceId !== actor.workspaceId) {
					throw new ProjectNotFoundError();
				}
				return {
					project: toProjectSnapshot(existing),
					queuedJobId: existing.ingestJobs[0]?.id ?? null,
				};
			}
		}

		let provider: NonNullable<ReturnType<typeof detectLinkProvider>>;
		let sourceType: "youtube" | "link";
		let brandActorScope: BrandActorScope | null;
		let profileResolved: Awaited<
			ReturnType<typeof brandProfileService.resolveForProject>
		> | null;
		let brandResolved: Awaited<
			ReturnType<typeof brandTemplateService.resolveSnapshotForUser>
		> | null;
		let createdAt: Date;
		let retention: Awaited<
			ReturnType<typeof projectRetentionService.assignmentForWorkspace>
		>;
		let pack: ContentPack;
		const prepare = async () => {
			const detectedProvider = detectLinkProvider(parsed.url);
			if (!detectedProvider) {
				throw new LinkUnsupportedSourceError();
			}
			provider = detectedProvider;
			sourceType = provider === "youtube" ? "youtube" : "link";

			brandActorScope = parsed.brandProfileId ? actor : null;
			profileResolved = brandActorScope
				? await brandProfileService.resolveForProject(brandActorScope, {
						profileId: parsed.brandProfileId!,
						templateId: parsed.brandTemplateId,
					})
				: null;
			brandResolved = profileResolved
				? null
				: await brandTemplateService.resolveSnapshotForUser(
						actor.workspaceOwnerUserId,
						parsed.brandTemplateId ?? null,
						{
							workspaceId: actor.workspaceId,
							actorUserId: actor.actorUserId,
						},
					);
			createdAt = new Date();
			retention = await projectRetentionService.assignmentForWorkspace(
				actor.workspaceId,
				createdAt,
			);

			// Browser intake can wait for setup; MCP commits runnable settings
			// in the same transaction as its Project and Ingest Job.
			pack = options.generationContext
				? contentPackSchema.parse(options.generationContext.contentPack)
				: contentPackSchema.parse({
						outputTypes: ["short_clip"],
						clipCountTarget: 10,
						clipDurationSecTarget: 45,
						toneConstraints: [],
						platformPlaybookVersion: PLATFORM_PLAYBOOK_VERSION,
						mode: parsed.mode ?? "clip",
						processingStartSec: parsed.processingStartSec ?? null,
						processingEndSec: parsed.processingEndSec ?? null,
					});
		};

		const create = async (tx: Prisma.TransactionClient) => {
			// Admission reserves minutes and capacity under the Workspace usage
			// lock before anything else in the acceptance transaction.
			const projectId = randomUUID();
			await getProcessingUsage().reserve(tx, {
				workspaceId: actor.workspaceId,
				projectId,
				actorUserId: actor.actorUserId,
				intakeKind: "link",
			});
			const createdProject = await tx.project.create({
				data: {
					id: projectId,
					workspaceId: actor.workspaceId,
					createdByUserId: actor.actorUserId,
					updatedByUserId: actor.actorUserId,
					title: parsed.title ?? "Link Import",
					sourceMediaUrl: parsed.url,
					sourceType,
					sourceProvider: provider,
					sourceInput: parsed.url,
					ingestStatus: "queued",
					languageCode: options.generationContext
						? options.generationContext.languageCode
						: (parsed.languageCode ?? null),
					commitToken: options.mutation ? null : (parsed.commitToken ?? null),
					brandTemplateId:
						profileResolved?.templateId ?? brandResolved?.templateId ?? null,
					brandSnapshot: profileResolved?.templateSnapshot
						? (profileResolved.templateSnapshot as unknown as Prisma.InputJsonValue)
						: brandResolved
							? (brandResolved.snapshot as unknown as Prisma.InputJsonValue)
							: Prisma.JsonNull,
					brandProfileId: profileResolved?.profileId ?? null,
					brandProfileSnapshot: profileResolved?.profileSnapshot
						? (profileResolved.profileSnapshot as unknown as Prisma.InputJsonValue)
						: Prisma.JsonNull,
					createdAt,
					retentionPolicyKey: retention?.retentionPolicyKey ?? null,
					expiresAt: retention?.expiresAt ?? null,
				},
			});
			if (profileResolved && brandActorScope) {
				await tx.programAnalyticsEvent.create({
					data: {
						workspaceId: actor.workspaceId,
						actorUserId: actor.actorUserId,
						projectId: createdProject.id,
						type: "brand_profile_applied",
						metadata: {
							profileId: profileResolved.profileId,
							...(profileResolved.templateId
								? { templateId: profileResolved.templateId }
								: {}),
							assetKind: "profile",
							planTier: resolvePricingTier(brandActorScope.pricingTier),
							outcome: "succeeded",
						},
					},
				});
			}

			const createdJob = await getIngestJobLifecycle().enqueue(tx, {
				projectId: createdProject.id,
				jobType: "link_import",
				payload: {
					url: parsed.url,
					provider,
					requestedTitle: parsed.title ?? null,
				},
			});

			await tx.contentPack.create({
				data: {
					projectId: createdProject.id,
					...parseStoredContentPack(pack),
					draft: !options.generationContext,
				},
			});

			return { project: createdProject, jobId: createdJob.id };
		};
		if (options.mutation) {
			const mutation = options.mutation;
			const accepted = await getMcpOperationExecutor().execute({
				identity: {
					workspaceId: actor.workspaceId,
					callerId: mutation.callerId ?? actor.actorUserId,
					toolName: "narriflow_submit_video",
					clientIdempotencyKey: mutation.clientIdempotencyKey,
				},
				input: {
					source: parsed,
					generationContext: options.generationContext ?? null,
				},
				authorize: async () => {
					await this.requireActor(scope, "processing.consume");
				},
				beforeAccept: mutation.beforeAccept,
				prepare,
				mutate: async (tx) => {
					const created = await create(tx);
					return {
						resourceType: "ingest_job",
						resourceId: created.jobId,
						value: {
							project: toProjectSnapshot(created.project),
							queuedJobId: created.jobId,
						},
					};
				},
			});
			return accepted.value;
		}
		await prepare();
		try {
			const created = await prisma.$transaction(
				create,
				PROCESSING_USAGE_TRANSACTION,
			);
			return {
				project: toProjectSnapshot(created.project),
				queuedJobId: created.jobId,
			};
		} catch (error) {
			if (isUniqueConstraintError(error) && parsed.commitToken) {
				const winner = await prisma.project.findUnique({
					where: { commitToken: parsed.commitToken },
					include: { ingestJobs: { orderBy: { createdAt: "desc" }, take: 1 } },
				});
				if (winner && winner.workspaceId === actor.workspaceId)
					return {
						project: toProjectSnapshot(winner),
						queuedJobId: winner.ingestJobs[0]?.id ?? null,
					};
			}
			throw error;
		}
	}

	async previewRssFeed(scope: ActorScope, rssUrl: string) {
		await this.requireActor(scope, "processing.consume");
		const parsed = rssPreviewSchema.parse({ rssUrl });
		const feed = await fetchRssFeed(parsed.rssUrl);

		return {
			rssUrl: feed.finalUrl,
			title: feed.title,
			episodes: feed.episodes,
		};
	}

	async importFromRss(
		scope: ActorScope,
		input: RssImportInput,
		generationContext?: {
			contentPack: ContentPack;
			languageCode: string | null;
		},
	) {
		const parsed = rssImportSchema.parse(input);
		// Authorize before performing remote network I/O. importResolvedRssEpisodes
		// repeats this check because it is also called directly by Autopilot.
		await this.requireActor(scope, "processing.consume");
		const feed = await fetchRssFeed(parsed.rssUrl);
		const episodesById = new Map(
			feed.episodes.map((episode) => [episode.id, episode]),
		);
		const episodes = parsed.episodeIds.map((episodeId) => {
			const episode = episodesById.get(episodeId);
			if (!episode) {
				throw new ProjectServiceError(
					"rss_episode_not_found",
					"RSS episode not found.",
				);
			}
			return episode;
		});

		return this.importResolvedRssEpisodes(
			scope,
			{
				rssUrl: feed.finalUrl,
				episodes,
				titlePrefix: parsed.titlePrefix,
				brandTemplateId: parsed.brandTemplateId,
				commitToken: parsed.commitToken,
			},
			{ generationContext },
		);
	}

	/**
	 * Internal authoritative RSS admission path. The caller must supply episodes
	 * returned by fetchRssFeed; public/UI callers go through importFromRss,
	 * which re-fetches and resolves client-submitted IDs server-side.
	 */
	async importResolvedRssEpisodes(
		scope: ActorScope,
		input: {
			rssUrl: string;
			episodes: Array<{
				id: string;
				title: string;
				enclosureUrl: string;
				publishedAt?: string | null;
				durationSeconds?: number | null;
				mimeType?: string | null;
			}>;
			titlePrefix?: string;
			brandTemplateId?: string | null;
			commitToken?: string;
		},
		options: {
			generationContext?: {
				contentPack: ContentPack;
				languageCode: string | null;
			};
			autopilotRuleId?: string;
		} = {},
	) {
		if (input.episodes.length < 1 || input.episodes.length > 10) {
			throw new ProjectServiceError(
				"rss_episode_count_invalid",
				"Select exactly one RSS episode.",
			);
		}
		if (input.commitToken && input.episodes.length !== 1) {
			throw new ProjectServiceError(
				"rss_commit_token_requires_single_episode",
				"The RSS commit token requires one episode.",
			);
		}

		const prisma = this.requirePrisma();
		const actor = await this.requireActor(scope, "processing.consume");

		if (options.autopilotRuleId && input.episodes.length === 1) {
			const existing = await prisma.autopilotEpisode.findUnique({
				where: {
					ruleId_episodeId: {
						ruleId: options.autopilotRuleId,
						episodeId: input.episodes[0]!.id,
					},
				},
			});
			if (existing?.projectId) return { count: 0, projects: [] };
		}
		if (input.commitToken) {
			const existing = await prisma.project.findUnique({
				where: { commitToken: input.commitToken },
				include: { ingestJobs: { orderBy: { createdAt: "desc" }, take: 1 } },
			});
			if (existing) {
				if (existing.workspaceId !== actor.workspaceId) {
					throw new ProjectNotFoundError();
				}
				const queuedJobId = existing.ingestJobs[0]?.id;
				if (!queuedJobId) {
					throw new ProjectServiceError(
						"rss_ingest_job_missing",
						"The RSS ingest job is unavailable.",
					);
				}
				return {
					count: 1,
					projects: [{ project: toProjectSnapshot(existing), queuedJobId }],
				};
			}
		}

		const brandResolved = await brandTemplateService.resolveSnapshotForUser(
			actor.workspaceOwnerUserId,
			input.brandTemplateId ?? null,
			{
				workspaceId: actor.workspaceId,
				actorUserId: actor.actorUserId,
			},
		);

		const createdProjects: Array<{
			project: ProjectSnapshot;
			queuedJobId: string;
		}> = [];
		// Each episode is admitted in its own transaction. Episodes that don't
		// fit the remaining minutes or capacity are reported, not admitted;
		// Autopilot retries them on its next poll.
		const notAdmitted: Array<{
			episodeId: string;
			code: ProcessingUsageError["code"];
		}> = [];
		let firstRefusal: ProcessingUsageError | null = null;

		for (const episode of input.episodes) {
			const createdAt = new Date();
			const retention = await projectRetentionService.assignmentForWorkspace(
				actor.workspaceId,
				createdAt,
			);
			let project: Project;
			let jobId: string;
			try {
				const created = await prisma.$transaction(async (tx) => {
					const projectId = randomUUID();
					await getProcessingUsage().reserve(tx, {
						workspaceId: actor.workspaceId,
						projectId,
						actorUserId: actor.actorUserId,
						intakeKind: "rss",
						declaredSeconds: episode.durationSeconds ?? null,
					});
					if (options.autopilotRuleId) {
						// This unique insert is the admission fence. Project, ingest job,
						// generation context, and dedup row commit or roll back together.
						await tx.autopilotEpisode.create({
							data: {
								ruleId: options.autopilotRuleId,
								episodeId: episode.id,
							},
						});
					}

					const createdProject = await tx.project.create({
						data: {
							id: projectId,
							workspaceId: actor.workspaceId,
							createdByUserId: actor.actorUserId,
							updatedByUserId: actor.actorUserId,
							title: input.titlePrefix
								? `${input.titlePrefix} - ${episode.title}`
								: episode.title,
							sourceMediaUrl: episode.enclosureUrl,
							sourceType: "rss",
							sourceInput: redactUrlForDisplay(input.rssUrl),
							ingestStatus: "queued",
							sourceMimeType: episode.mimeType ?? null,
							sourceDurationSeconds: episode.durationSeconds ?? null,
							languageCode: options.generationContext?.languageCode ?? null,
							commitToken: input.commitToken ?? null,
							brandTemplateId: brandResolved?.templateId ?? null,
							brandSnapshot: brandResolved
								? (brandResolved.snapshot as unknown as Prisma.InputJsonValue)
								: Prisma.JsonNull,
							createdAt,
							retentionPolicyKey: retention?.retentionPolicyKey ?? null,
							expiresAt: retention?.expiresAt ?? null,
						},
					});

					const createdJob = await getIngestJobLifecycle().enqueue(tx, {
						projectId: createdProject.id,
						jobType: "rss_import",
						payload: { rssUrl: input.rssUrl, episode },
					});

					if (options.generationContext) {
						await tx.contentPack.create({
							data: {
								projectId: createdProject.id,
								...parseStoredContentPack(
									options.generationContext.contentPack,
								),
							},
						});
					}

					if (options.autopilotRuleId) {
						await tx.autopilotEpisode.update({
							where: {
								ruleId_episodeId: {
									ruleId: options.autopilotRuleId,
									episodeId: episode.id,
								},
							},
							data: { projectId: createdProject.id },
						});
					}

					return { project: createdProject, jobId: createdJob.id };
				}, PROCESSING_USAGE_TRANSACTION);
				project = created.project;
				jobId = created.jobId;
			} catch (error) {
				if (error instanceof ProcessingUsageError) {
					notAdmitted.push({ episodeId: episode.id, code: error.code });
					firstRefusal ??= error;
					continue;
				}
				if (isUniqueConstraintError(error)) {
					if (options.autopilotRuleId) {
						const winner = await prisma.autopilotEpisode.findUnique({
							where: {
								ruleId_episodeId: {
									ruleId: options.autopilotRuleId,
									episodeId: episode.id,
								},
							},
							include: { project: { include: { ingestJobs: { take: 1 } } } },
						});
						if (winner?.project) continue;
					}
					if (input.commitToken) {
						const winner = await prisma.project.findUnique({
							where: { commitToken: input.commitToken },
							include: {
								ingestJobs: { orderBy: { createdAt: "desc" }, take: 1 },
							},
						});
						if (winner && winner.workspaceId === actor.workspaceId) {
							const queuedJobId = winner.ingestJobs[0]?.id;
							if (!queuedJobId) {
								throw new ProjectServiceError(
									"rss_ingest_job_missing",
									"The RSS ingest job is unavailable.",
								);
							}
							createdProjects.push({
								project: toProjectSnapshot(winner),
								queuedJobId,
							});
							continue;
						}
					}
				}
				throw error;
			}

			createdProjects.push({
				project: toProjectSnapshot(project),
				queuedJobId: jobId,
			});
		}

		if (createdProjects.length === 0 && firstRefusal) throw firstRefusal;
		return {
			count: createdProjects.length,
			projects: createdProjects,
			notAdmitted,
		};
	}

	async getTranscriptForWorker(projectId: string) {
		const prisma = this.requirePrisma();
		return prisma.transcript.findUnique({
			where: { projectId },
		});
	}

	async getLatestContentPack(scope: ActorScope, projectId: string) {
		await this.requireActor(scope, "content.view");
		const prisma = this.requirePrisma();
		return prisma.contentPack.findFirst({
			where: {
				projectId,
				project: {
					workspaceId: scope.workspaceId,
					...accessibleProjectWhere(),
				},
			},
			orderBy: { createdAt: "desc" },
		});
	}

	async getProjectBrandSnapshot(
		scope: ActorScope,
		projectId: string,
	): Promise<unknown | null> {
		await this.requireActor(scope, "content.view");
		const prisma = this.requirePrisma();
		const row = await prisma.project.findFirst({
			where: {
				id: projectId,
				workspaceId: scope.workspaceId,
				...accessibleProjectWhere(),
			},
			select: { brandSnapshot: true },
		});
		return row?.brandSnapshot ?? null;
	}

	async getProjectLanguageCodeForWorker(
		projectId: string,
	): Promise<string | null> {
		const prisma = this.requirePrisma();
		const row = await prisma.project.findUnique({
			where: { id: projectId },
			select: { languageCode: true },
		});
		return row?.languageCode ?? null;
	}

	/**
	 * Step 2 (Configure) commit for the link-first split. Persists the final
	 * ContentPack — upserting the project's single draft row to committed —
	 * then attempts the same idempotent run-claim the ingest worker uses.
	 *
	 * ORDERING INVARIANT: the pack commit lands BEFORE ingestStatus is read;
	 * the ingest worker commits ingestStatus = ready BEFORE reading the pack.
	 * At least one side therefore sees both facts, and the deterministic
	 * idempotency key collapses a double-claim to one run.
	 */
	async finalizeGenerationSetup(
		scope: ActorScope,
		projectId: string,
		contentPack: ContentPack,
		languageCode: string | null,
	): Promise<FinalizeSetupResult> {
		await this.requireActor(scope, "processing.consume");
		const prisma = this.requirePrisma();

		const project = await prisma.project.findFirst({
			where: {
				id: projectId,
				workspaceId: scope.workspaceId,
				...accessibleProjectWhere(),
			},
			select: { id: true, workspaceId: true, ingestStatus: true },
		});
		if (!project) {
			throw new ProjectNotFoundError();
		}

		const existingRun = await prisma.workflowRun.findFirst({
			where: { projectId },
			orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
			select: { id: true },
		});
		if (existingRun) {
			// Re-invoked after a successful start (refresh, double-click, SSE
			// re-fire): idempotent success.
			return {
				started: true,
				ingestStatus: project.ingestStatus,
				workflowRunId: existingRun.id,
			};
		}

		const packData = { ...parseStoredContentPack(contentPack), draft: false };

		// Upsert-in-place: repeated Configure updates the same row, never
		// inserts. A pack already bound to a WorkflowRun is immutable — a
		// concurrent finalize that lost the claim race must not rewrite the
		// settings the running claim was made with.
		const committedPack = await prisma.$transaction(async (tx) => {
			const latest = await tx.contentPack.findFirst({
				where: { projectId },
				orderBy: { createdAt: "desc" },
				select: { id: true },
			});
			if (latest) {
				const guarded = await tx.contentPack.updateMany({
					where: { id: latest.id, workflowRuns: { none: {} } },
					data: packData,
				});
				return guarded.count === 0 ? null : { id: latest.id };
			}
			return tx.contentPack.create({
				data: { projectId, ...packData },
				select: { id: true },
			});
		});

		if (!committedPack) {
			// The latest pack is already bound to a run (concurrent finalize won).
			const boundRun = await prisma.workflowRun.findFirst({
				where: { projectId },
				orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
				select: { id: true },
			});
			return {
				started: true,
				ingestStatus: project.ingestStatus,
				workflowRunId: boundRun?.id,
			};
		}

		await prisma.project.update({
			where: {
				id: projectId,
				workspaceId: scope.workspaceId,
				...accessibleProjectWhere(),
			},
			data: { languageCode, updatedByUserId: scope.actorUserId },
		});

		// Pack committed — NOW read ingest state (the ordering invariant).
		const fresh = await prisma.project.findUnique({
			where: {
				id: projectId,
				workspaceId: scope.workspaceId,
				...accessibleProjectWhere(),
			},
			select: { ingestStatus: true },
		});
		const ingestStatus = fresh?.ingestStatus ?? project.ingestStatus;

		if (ingestStatus !== "ready") {
			return { started: false, ingestStatus };
		}

		const parsedLanguage = sourceLanguageCodeSchema.safeParse(languageCode);
		const result = await this.triggerGeneration(
			scope,
			projectId,
			{
				contentPack,
				forceRegenerate: false,
				languageCode: parsedLanguage.success ? parsedLanguage.data : null,
			},
			autoTriggerIdempotencyKey(projectId, committedPack.id),
			{
				existingContentPackId: committedPack.id,
			},
		);

		return {
			started: true,
			ingestStatus,
			workflowRunId: result.workflowRunId,
		};
	}

	/**
	 * "Save settings and finish later": persist the user's Step-2 choices as
	 * the project's draft pack without starting anything. No-op (returns
	 * false) once a run exists — the settings already fed a claim.
	 */
	async saveGenerationDraft(
		scope: ActorScope,
		projectId: string,
		contentPack: ContentPack,
		languageCode: string | null,
	): Promise<boolean> {
		await this.requireActor(scope, "processing.consume");
		const prisma = this.requirePrisma();
		const project = await prisma.project.findFirst({
			where: {
				id: projectId,
				workspaceId: scope.workspaceId,
				...accessibleProjectWhere(),
			},
			select: { id: true },
		});
		if (!project) throw new ProjectNotFoundError();

		const existingRun = await prisma.workflowRun.findFirst({
			where: { projectId },
			select: { id: true },
		});
		if (existingRun) return false;

		const draftData = { ...parseStoredContentPack(contentPack), draft: true };

		await prisma.$transaction(async (tx) => {
			const latest = await tx.contentPack.findFirst({
				where: { projectId },
				orderBy: { createdAt: "desc" },
				select: { id: true },
			});
			if (latest) {
				await tx.contentPack.updateMany({
					where: { id: latest.id, workflowRuns: { none: {} } },
					data: draftData,
				});
			} else {
				await tx.contentPack.create({ data: { projectId, ...draftData } });
			}
			await tx.project.update({
				where: {
					id: projectId,
					workspaceId: scope.workspaceId,
					...accessibleProjectWhere(),
				},
				data: { languageCode, updatedByUserId: scope.actorUserId },
			});
		});
		return true;
	}

	/** A worker reads only the committed ContentPack bound to its claimed run. */
	async getContentPackForRun(run: {
		projectId: string;
		contentPackId: string | null;
	}) {
		const prisma = this.requirePrisma();
		if (!run.contentPackId) return null;
		return prisma.contentPack.findFirst({
			where: { id: run.contentPackId, projectId: run.projectId, draft: false },
		});
	}

	/** Per-project "email me when clips are ready" preference. */
	async setProjectNotifyPreference(
		scope: ActorScope,
		projectId: string,
		notifyOnComplete: boolean,
	): Promise<void> {
		await this.requireActor(scope, "content.edit");
		const prisma = this.requirePrisma();
		const updated = await prisma.project.updateMany({
			where: {
				id: projectId,
				workspaceId: scope.workspaceId,
				...accessibleProjectWhere(),
			},
			data: { notifyOnComplete, updatedByUserId: scope.actorUserId },
		});
		if (updated.count === 0) {
			throw new ProjectNotFoundError();
		}
	}

	/** The Workspace's processing usage projection for every surface. */
	async getUsageSummary(scope: ActorScope): Promise<ProcessingUsageSummary> {
		await this.requireActor(scope, "content.view");
		return getProcessingUsage().summarize(scope.workspaceId);
	}
}

export const projectService = new ProjectService();

// ---------------------------------------------------------------------------
// Retention / storage-reclamation jobs (FIX 4). Standalone functions — not
// wired into apps/worker/src/index.ts here; the owner of that file adds the
// periodic reap tick and its own SOURCE_RETENTION_DAYS /
// WORKFLOW_EVENT_RETENTION_DAYS env var plumbing, mirroring how
// purgeOldWebhookDeliveryLogs is called today.
// ---------------------------------------------------------------------------

const DEFAULT_SOURCE_RETENTION_DAYS = 90;
const DEFAULT_WORKFLOW_EVENT_RETENTION_DAYS = 90;
// Per-tick cap on how many source objects purgeExpiredProjectSources will
// attempt to delete — each candidate costs a real R2 round trip, so this
// bounds a single reaper tick's worst-case latency; remaining candidates are
// simply picked up on the next tick.
const SOURCE_PURGE_BATCH_SIZE = 200;

/** Pure cutoff-date arithmetic shared by both retention jobs below, factored
 *  out so the date math has direct unit coverage independent of Prisma. */
export function retentionCutoffDate(
	retentionDays: number,
	nowMs = Date.now(),
): Date {
	return new Date(nowMs - retentionDays * 24 * 60 * 60 * 1000);
}

export interface ProjectSourcePurgeCandidate {
	sourceStorageKey: string | null;
	ingestStatus: PrismaIngestStatus;
	ingestCompletedAt: Date | string | null;
	/** Whether any WorkflowRun for this project is still queued/running. */
	hasActiveWorkflowRun: boolean;
	/** Whether at least one ClipRender has already completed with an asset. */
	hasCompletedRender: boolean;
	/** Whether any clip still needs a preview proxy cut from this source.
	 *  Proxies are generated lazily from the source, so purging first strands
	 *  those clips on "Preview generating…" forever. */
	hasClipAwaitingPreview: boolean;
}

/**
 * Pure eligibility gate for reclaiming a project's R2 source object. A
 * project only qualifies once: ingest finished successfully, nothing is
 * still mid-flight against the source, at least one clip already has a
 * completed render (never delete a source before any output exists), and
 * the source has aged past the retention window. Exported and tested in
 * isolation so the "don't delete a source whose renders don't exist yet"
 * invariant has direct coverage, independent of the Prisma query that feeds
 * it in purgeExpiredProjectSources below.
 */
export function isProjectSourcePurgeEligible(
	project: ProjectSourcePurgeCandidate,
	options: { retentionDays: number; nowMs: number },
): boolean {
	if (!project.sourceStorageKey) return false;
	if (project.ingestStatus !== "ready") return false;
	if (project.hasActiveWorkflowRun) return false;
	if (!project.hasCompletedRender) return false;
	// Preview proxies are cut lazily from the source. Purging while a clip is
	// still waiting for one strands it on "Preview generating…" permanently,
	// because there is nothing left to cut from. Observed for real: three
	// projects were purged on a first worker boot before any proxy existed.
	if (project.hasClipAwaitingPreview) return false;
	if (!project.ingestCompletedAt) return false;

	const completedAtMs = new Date(project.ingestCompletedAt).getTime();
	if (Number.isNaN(completedAtMs)) return false;

	return (
		completedAtMs <
		retentionCutoffDate(options.retentionDays, options.nowMs).getTime()
	);
}

/**
 * Reclaims R2 storage for source media no longer needed by any pipeline
 * stage. Idempotent and safe under concurrent runners: deleteObject is
 * itself idempotent (a key that's already gone is treated as success), and
 * the DB write is conditioned on the exact key just deleted so a racing
 * purge or a fresh re-upload can never be clobbered. Nulls sourceStorageKey
 * so the app can render a "source expired" state instead of a broken link.
 *
 * Mirrors purgeOldWebhookDeliveryLogs's shape (retention-days param with a
 * sensible default, returns a plain count) — the eligibility decision itself
 * lives in isProjectSourcePurgeEligible above, this just feeds it real rows
 * in bounded batches and executes the deletes.
 */
export async function purgeExpiredProjectSources(
	retentionDays = DEFAULT_SOURCE_RETENTION_DAYS,
): Promise<number> {
	const prisma = getPrismaClient();
	if (!prisma)
		throw new Error("DATABASE_URL is required for Project maintenance");

	const candidates = await prisma.project.findMany({
		where: {
			sourceStorageKey: { not: null },
			ingestStatus: "ready",
		},
		select: {
			id: true,
			sourceStorageKey: true,
			ingestStatus: true,
			ingestCompletedAt: true,
			workflowRuns: {
				where: { status: { in: ["queued", "running", "waiting"] } },
				select: { id: true },
				take: 1,
			},
			clips: {
				where: {
					renders: {
						some: { status: "completed", storageKey: { not: null } },
					},
				},
				select: { id: true },
				take: 1,
			},
		},
		take: SOURCE_PURGE_BATCH_SIZE,
	});

	// One extra query for the whole batch rather than per candidate: which of
	// these projects still has a clip with no preview proxy cut yet.
	const projectIdsAwaitingPreview = new Set(
		(
			await prisma.clip.findMany({
				where: {
					projectId: { in: candidates.map((project) => project.id) },
					previewStorageKey: null,
				},
				select: { projectId: true },
				distinct: ["projectId"],
			})
		).map((clip) => clip.projectId),
	);

	const nowMs = Date.now();
	let purged = 0;

	for (const project of candidates) {
		const key = project.sourceStorageKey;
		const eligible =
			key !== null &&
			isProjectSourcePurgeEligible(
				{
					sourceStorageKey: key,
					ingestStatus: project.ingestStatus,
					ingestCompletedAt: project.ingestCompletedAt,
					hasActiveWorkflowRun: project.workflowRuns.length > 0,
					hasCompletedRender: project.clips.length > 0,
					hasClipAwaitingPreview: projectIdsAwaitingPreview.has(project.id),
				},
				{ retentionDays, nowMs },
			);

		if (!eligible || !key) continue;

		try {
			await deleteObject(key);
		} catch (error) {
			if (!isMissingObjectError(error)) {
				console.warn(
					JSON.stringify({
						level: "warn",
						message: "source_purge_delete_failed",
						projectId: project.id,
						error: error instanceof Error ? error.message : String(error),
					}),
				);
				continue; // leave sourceStorageKey intact so a later tick retries
			}
			// Already gone from R2 (e.g. a previous run deleted it but crashed
			// before the DB write below) — fall through and reconcile the row.
		}

		// Conditioned on the exact key we just deleted: a concurrent purge run,
		// or a fresh re-upload that already changed sourceStorageKey, is left
		// alone rather than clobbered.
		const updated = await prisma.project.updateMany({
			where: { id: project.id, sourceStorageKey: key },
			data: { sourceStorageKey: null },
		});

		purged += updated.count;
	}

	return purged;
}

/** Deletes WorkflowEvent rows older than the retention window. Returns
 *  count. Same shape as purgeOldWebhookDeliveryLogs in webhook-log.service.ts. */
export async function purgeOldWorkflowEvents(
	olderThanDays = DEFAULT_WORKFLOW_EVENT_RETENTION_DAYS,
): Promise<number> {
	const prisma = getPrismaClient();
	if (!prisma)
		throw new Error("DATABASE_URL is required for Project maintenance");

	const res = await prisma.workflowEvent.deleteMany({
		where: {
			emittedAt: { lt: retentionCutoffDate(olderThanDays) },
			OR: [
				{ notificationRequired: false },
				{ notificationDeliveredAt: { not: null } },
			],
		},
	});
	return res.count;
}

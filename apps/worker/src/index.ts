import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { getPrismaClient } from "@narriflow/db/client";
import { RenderExecutorHealth, reserveWorkerHealthPort, verifySharedRenderEnvironment } from "./render-executor-health";
import { configureWorkerProcessAdmission, sweepAbandonedScratch } from "./worker-process";
import { renderResourceBudgetFor, readDiskFacts, judgeAdmission } from "./render-resource-budget";
import { mediaWorkScheduler } from "./media-work-scheduler";
import { pruneBrollAssetCache } from "./tasks/broll";
import { reconcileRenderObjectsForMaintenance } from "./reconcile-render-objects";
import { getYoutubeProxyUrl, startYoutubeTokenServer, superviseYoutubeTokenServer } from "./youtube-import";
import {
	createIsolatedPollLoop,
	type PollLoop,
	type PollRunContext,
	stallBudgetMs,
	unhealthyLoops,
} from "./poll-loop";
import {
	billingService,
	mediaCleanupWorker,
	assertUploadProviderLifecyclePrerequisite,
	getWorkflowRunLifecycle,
	getSocialPublicationRuntime,
	getCompletionCallbackProcessor,
	getWebhookDeliveryProcessor,
	getStandingGrantMaintenance,
	getPerformanceSync,
	getPerformanceGuidance,
	getIngestJobLifecycle,
	getLibrarySearch,
	IngestJobClaimLost,
	reviewService,
	projectRetentionService,
	purgeExpiredProjectSources,
	purgeOldWebhookDeliveryLogs,
	purgeOldWorkflowEvents,
	pruneExpiredMcpTasks,
	purgeExpiredWorkspaceEvents,
	generatedMediaService,
	generatedImageProviderConfigured,
	workerShutdownDrainMs,
	purgeExpiredGeneratedMediaPrompts,
	reconcileGenerationUsageReservations,
	getProcessingUsage,
	thumbnailFramePreparationService,
	uploadSessionService,
	WorkflowAttemptLost,
	type ClaimedWorkflowAttempt,
	type WorkflowAttemptContext,
	type WorkflowAttemptRef,
} from "@narriflow/services";
import { processDueAutopilotRules } from "./tasks/autopilot";
import { processDueGenerationFinishing } from "./tasks/generation-finishing";
import { processClipDetectionRun } from "./tasks/detect-clips";
import { processPendingClipPreviews } from "./tasks/clip-preview";
import { processPendingAutoLayoutAnalyses } from "./tasks/auto-layout-analysis";
import { processDubbingRun } from "./tasks/dubbing";
import { processIngestJob } from "./tasks/ingest";
import { expireExportBundles, processExportBundleRun } from "./tasks/export-bundle";
import { createClipRenderAttempt } from "./tasks/clip-render-attempt-runtime";
import { parseWorkerRenderConfig } from "./render-config";
import { processDueSocialPosts } from "./tasks/social-publisher";
import { parseWorkspaceBillingPollInterval } from "./workspace-billing-config";
import {
	processSubmittedTranscriptResults,
	processTranscriptRun,
} from "./tasks/transcribe";
import {
	getWorkerAppBaseUrl,
	notifyExpiringProject,
	retryPendingNotifications,
	retryPendingReviewNotifications,
} from "./notifications";
import { executeNextWorkflowAttempt } from "./workflow-attempt-executor";

const port = Number(process.env.PORT || 4001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Worker health PORT must be a fixed port from 1 to 65535");
let startupComplete = false;
const server = createServer((req, res) => { void handleWorkerRequest(req, res); });
// Await listen: EADDRINUSE must reject before any shared-queue claim or sweep.
await reserveWorkerHealthPort(server, port);
const workerShutdown = new AbortController();
let youtubeLinkIntakeAvailable = false;
const youtubeProxyUrl = getYoutubeProxyUrl();
assertUploadProviderLifecyclePrerequisite(process.env);
billingService.validateConfiguration({ surface: "worker" });
getSocialPublicationRuntime();
const pollIntervalMs = Number(process.env.INGEST_POLL_INTERVAL_MS ?? "2500");
// Rendering is CPU-bound and can run for minutes (ffmpeg saturates all cores
// per clip already — measured intra-machine clip parallelism buys nothing: 4
// clips in parallel took 40.49s vs 39.50s sequential — so this does NOT add
// parallel clip encoding). Each loop still processes at most one job per
// tick, so a render is never run concurrently with another render on this
// process.
const renderPollIntervalMs = Number(
	process.env.RENDER_POLL_INTERVAL_MS ?? String(pollIntervalMs),
);
const reapIntervalMs = Number(
	process.env.WORKER_REAP_INTERVAL_MS ?? String(5 * 60 * 1000),
);
const workflowLeaseReapIntervalMs = Number(
	process.env.WORKFLOW_LEASE_REAP_INTERVAL_MS ?? "30000",
);
const workflowEventDispatchIntervalMs = Number(
	process.env.WORKFLOW_EVENT_DISPATCH_INTERVAL_MS ?? "1000",
);
const completionCallbackPollIntervalMs = Number(
	process.env.COMPLETION_CALLBACK_POLL_INTERVAL_MS ?? "5000",
);
// Readings are scheduled hours apart, so a minute only bounds how soon a due
// capture is noticed.
const performanceSyncPollIntervalMs = Number(
	process.env.PERFORMANCE_SYNC_POLL_INTERVAL_MS ?? "60000",
);
// Performance Guidance is recomputed for a Workspace once its last result is a
// day old; this only bounds how soon a stale one is noticed.
const performanceGuidancePollIntervalMs = Number(
	process.env.PERFORMANCE_GUIDANCE_POLL_INTERVAL_MS ?? String(15 * 60 * 1000),
);
const maxConsecutivePollFailures = Number(
	process.env.WORKER_MAX_CONSECUTIVE_POLL_FAILURES ?? "20",
);
const renderConfig = parseWorkerRenderConfig();
const renderResources = renderResourceBudgetFor(renderConfig);
const executorHealth = new RenderExecutorHealth({
  check: verifySharedRenderEnvironment,
  recycle: () => beginGracefulShutdown(1),
  diagnose: (event) => console.warn(JSON.stringify({ level: "error", ...event })),
});
configureWorkerProcessAdmission(executorHealth);
let scratchReady = false;

async function refreshScratchReadiness(): Promise<void> {
  try {
    const disk = await readDiskFacts(tmpdir());
    scratchReady = judgeAdmission(renderConfig, disk, renderResources.snapshot().reservedBytes, 0) === "admit";
  } catch { scratchReady = false; }
}

async function maintainRenderResources(): Promise<void> {
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("Database unavailable for render maintenance");
  const scratch = await sweepAbandonedScratch({
    graceMs: renderConfig.scratchSweepGraceMs,
    isOwnerActive: async (owner) => {
      if (!owner?.workflowRunId && !owner?.attemptId) return false;
      return Boolean(await prisma.workflowRun.findFirst({
        where: { ...(owner.workflowRunId ? { id: owner.workflowRunId } : {}),
          ...(owner.attemptId ? { attemptId: owner.attemptId } : {}),
          status: "running", leaseExpiresAt: { gt: new Date() } }, select: { id: true },
      })) || Boolean(await prisma.renderGroup.findFirst({
        where: { ...(owner.workflowRunId ? { workflowRunId: owner.workflowRunId } : {}),
          ...(owner.attemptId ? { attemptToken: owner.attemptId } : {}),
          status: "running", leaseExpiresAt: { gt: new Date() } }, select: { id: true },
      }));
    },
  });
  const cache = await pruneBrollAssetCache({ maxBytes: renderConfig.brollCacheMaxBytes, ttlMs: renderConfig.brollAssetCacheTtlMs });
  await refreshScratchReadiness();
  console.warn(JSON.stringify({ level: "info", message: "render_resource_maintenance", scratch, cache, resources: renderResources.snapshot() }));
}

async function runBackgroundMedia(name: string, work: () => Promise<number>): Promise<number> {
  if (!executorHealth.snapshot().ready || !scratchReady || renderResources.snapshot().blockedProducers > 0) return 0;
  return mediaWorkScheduler.run("background", name, workerShutdown.signal, async () => {
    if (!executorHealth.snapshot().ready || !scratchReady || renderResources.snapshot().encoding) return 0;
    return work();
  });
}

// Preview proxies are short ffmpeg cuts, but "short" is ~12s each and a batch
// runs them in sequence — roughly a minute of CPU+network per tick.
const previewPollIntervalMs = Number(
	process.env.PREVIEW_POLL_INTERVAL_MS ?? String(pollIntervalMs),
);
const autoLayoutPollIntervalMs = Number(
	process.env.AUTO_LAYOUT_POLL_INTERVAL_MS ?? String(10_000),
);
// Submit-and-release STT: the stt loop only submits; this loop polls
// AssemblyAI for submitted transcripts. Its cadence can stay coarser than the
// claim loops — waiting STT polling additionally gates each run by
// ASSEMBLYAI_POLL_INTERVAL_MS via its next-poll timestamp.
const sttResultPollIntervalMs = Number(
	process.env.STT_RESULT_POLL_INTERVAL_MS ?? "5000",
);
const notificationRetryPollIntervalMs = Number(
	process.env.NOTIFICATION_RETRY_POLL_INTERVAL_MS ?? String(60 * 1000),
);
const mediaCleanupPollIntervalMs = Number(
	process.env.MEDIA_CLEANUP_POLL_INTERVAL_MS ?? "10000",
);
const generatedMediaPollIntervalMs = Number(
	process.env.GENERATED_MEDIA_POLL_INTERVAL_MS ?? "2500",
);
const thumbnailFramePollIntervalMs = Number(
	process.env.THUMBNAIL_FRAME_POLL_INTERVAL_MS ?? "2500",
);
const workspaceBillingPollIntervalMs = parseWorkspaceBillingPollInterval(
	process.env.WORKSPACE_BILLING_POLL_INTERVAL_MS,
);
// Library search indexing: embedding calls, bounded per tick. It only reads
// finished transcripts, so it can neither delay nor block generation.
const libraryIndexPollIntervalMs = Number(
	process.env.LIBRARY_INDEX_POLL_INTERVAL_MS ?? "10000",
);
const libraryIndexBatchSize = Number(
	process.env.LIBRARY_INDEX_BATCH_SIZE ?? "5",
);
const autopilotPollIntervalMs = Number(
	process.env.AUTOPILOT_POLL_INTERVAL_MS ?? "30000",
);
// Finishing: export the best clips and write copy once a generation completes.
// It claims durable rows with a lease, so a restarted or second worker resumes.
const finishingPollIntervalMs = Number(
	process.env.FINISHING_POLL_INTERVAL_MS ?? "15000",
);
const notificationRetryBatchSize = Number(
	process.env.NOTIFICATION_RETRY_BATCH_SIZE ?? "25",
);

let processedCount = 0;
let lastReapAt = 0;

/** Periodically reaps ingest jobs orphaned by a crashed/evicted worker.
 * Workflow attempts have their own single lease-reaper loop. */
async function reapStalledRunsIfDue() {
	const now = Date.now();
	if (now - lastReapAt < reapIntervalMs) return;
	lastReapAt = now;
	try {
		const reapedIngest =
			await getIngestJobLifecycle().reapExpired();
		if (reapedIngest > 0) {
			console.log(
				JSON.stringify({
					level: "info",
					message: "ingest_jobs_reaped",
					count: reapedIngest,
					ts: new Date().toISOString(),
				}),
			);
		}
		const purgedLogs = await purgeOldWebhookDeliveryLogs(
			Number(process.env.WEBHOOK_LOG_RETENTION_DAYS ?? 30),
		);
		if (purgedLogs > 0) {
			console.log(
				JSON.stringify({
					level: "info",
					message: "webhook_logs_purged",
					count: purgedLogs,
					ts: new Date().toISOString(),
				}),
			);
		}
		// Source media is the dominant storage cost: roughly 2.65 GB per
		// source-hour, previously kept forever because nothing ever deleted it.
		// Only terminal projects whose renders already exist are eligible, and
		// sourceStorageKey is nulled so the UI can say "source expired" instead of
		// serving a broken link.
		const purgedSources = await purgeExpiredProjectSources(
			Number(process.env.SOURCE_RETENTION_DAYS ?? 90),
		);
		if (purgedSources > 0) {
			console.log(
				JSON.stringify({
					level: "info",
					message: "project_sources_purged",
					count: purgedSources,
					ts: new Date().toISOString(),
				}),
			);
		}
		const purgedEvents = await purgeOldWorkflowEvents(
			Number(process.env.WORKFLOW_EVENT_RETENTION_DAYS ?? 90),
		);
		if (purgedEvents > 0) {
			console.log(
				JSON.stringify({
					level: "info",
					message: "workflow_events_purged",
					count: purgedEvents,
					ts: new Date().toISOString(),
				}),
			);
		}
		await purgeExpiredGeneratedMediaPrompts();
		// Settles image and dub counts whose request can no longer settle itself.
		await reconcileGenerationUsageReservations();
		// Releases processing reservations stranded by crashes; each release is
		// logged with its reason by the Processing Usage module.
		await getProcessingUsage().reconcileStranded({ limit: 100 });
		const expiredBundles = await expireExportBundles(
			new Date(),
			Number(process.env.EXPORT_BUNDLE_EXPIRY_BATCH_SIZE ?? 100),
		);
		if (expiredBundles > 0) {
			console.log(
				JSON.stringify({
					level: "info",
					message: "export_bundles_expired",
					count: expiredBundles,
					ts: new Date().toISOString(),
				}),
			);
		}
		const expiredReviewRounds = await reviewService.recordExpiredRounds(
			Number(process.env.REVIEW_EXPIRY_BATCH_SIZE ?? 100),
		);
		if (expiredReviewRounds > 0) {
			console.warn(
				JSON.stringify({
					level: "info",
					message: "review_rounds_expired",
					count: expiredReviewRounds,
					ts: new Date().toISOString(),
				}),
			);
		}

		const warningCandidates =
			await projectRetentionService.listProjectsNeedingExpiryWarning(
				new Date(),
				Number(process.env.PROJECT_RETENTION_WARNING_BATCH_SIZE ?? 100),
			);
		for (const project of warningCandidates) {
			await notifyExpiringProject(project.id);
		}

		const retention = await projectRetentionService.purgeDueProjects(
			Number(process.env.PROJECT_RETENTION_PURGE_BATCH_SIZE ?? 10),
		);
		const receiptsDeleted = await projectRetentionService.deleteExpiredReceipts(
			Number(process.env.PROJECT_RETENTION_RECEIPT_CLEANUP_BATCH_SIZE ?? 100),
		);
		if (
			warningCandidates.length > 0 ||
			retention.purged > 0 ||
			retention.failed > 0 ||
			receiptsDeleted > 0
		) {
			console.warn(
				JSON.stringify({
					level: retention.failed > 0 ? "warn" : "info",
					message: "project_retention_maintenance",
					warningsDue: warningCandidates.length,
					...retention,
					receiptsDeleted,
					ts: new Date().toISOString(),
				}),
			);
		}
	} catch (error) {
		console.warn(
			JSON.stringify({
				level: "error",
				message: "reaper_failed",
				ts: new Date().toISOString(),
				error: error instanceof Error ? error.message : "Unknown error",
			}),
		);
	}
}

function diagnoseWorkflowAttemptLost(input: {
	run: WorkflowAttemptRef;
	error: WorkflowAttemptLost;
	startedAtMs: number;
}) {
	console.warn(
		JSON.stringify({
			level: "warn",
			message: "workflow_attempt_lost",
			ts: new Date().toISOString(),
			workflowRunId: input.run.workflowRunId,
			workflowAttemptId: input.run.attemptId,
			attemptId: input.run.attemptId,
			projectId: input.run.projectId,
			stage: input.run.stage,
			phase: "ownership",
			operation: "execute",
			failureCode: input.error.code,
			disposition: "control",
			retryState: "reaper_owned",
			elapsedMs: Date.now() - input.startedAtMs,
		}),
	);
}
const allLoops: Array<{ loop: PollLoop; intervalMs: number }> = [];

/**
 * One loop per stage, each with its own mutex and consecutive-failure circuit
 * breaker. The old single IO loop held one mutex across ingest + stt +
 * moment_detection + dubbing + autopilot + social for every project on the
 * worker, so any long stage (a multi-GB ingest, an in-flight detection call)
 * starved all the others — the same reasoning that split render and preview
 * out originally, applied to the rest. Claims stay atomic
 * (WorkflowRunLifecycle / IngestJob conditional updates), so loops
 * on this process and on other replicas can never double-claim a job.
 */
function createPollLoop(
	name: string,
	intervalMs: number,
	fn: (context: PollRunContext) => Promise<number>,
): PollLoop {
	const loop = createIsolatedPollLoop({
		name,
		run: async (context) => !startupComplete || workerShutdown.signal.aborted ? 0 : fn(context),
		stallAfterMs: stallBudgetMs(intervalMs),
		maximumConsecutiveFailures: maxConsecutivePollFailures,
		onProcessed: (processed) => {
			processedCount += processed;
		},
		onFailure: (error, consecutiveFailures) => {
        executorHealth.failed(error);
			console.warn(
				JSON.stringify({
					level: "error",
					message: "worker_poll_failed",
					ts: new Date().toISOString(),
					loop: name,
					error: error instanceof Error ? error.message : "Unknown error",
					consecutiveFailures,
				}),
			);
		},
		onStall: ({ stallAfterMs, consecutiveStalls }) => {
			console.warn(
				JSON.stringify({
					level: "error",
					message: "worker_poll_stalled",
					ts: new Date().toISOString(),
					loop: name,
					stallAfterMs,
					consecutiveStalls,
				}),
			);
		},
		onFailureLimit: (consecutiveFailures) => {
			console.warn(
				JSON.stringify({
					level: "error",
					message: "worker_poll_failures_exceeded",
					ts: new Date().toISOString(),
					loop: name,
					consecutiveFailures,
				}),
			);
			process.exit(1);
		},
	});
	allLoops.push({ loop, intervalMs });
	return loop;
}

const ingestLoop = createPollLoop("ingest", pollIntervalMs, async ({ holdingLease }) => {
	if (workerShutdown.signal.aborted) return 0;
	const lifecycle = getIngestJobLifecycle();
	const ingestJob = await lifecycle.claim({ youtubeAvailable: youtubeLinkIntakeAvailable });
	if (!ingestJob) return 0;
	try {
		await holdingLease(() =>
			lifecycle.runClaim(ingestJob, ({ signal }) => processIngestJob(ingestJob, { signal }), { signal: workerShutdown.signal }),
		);
	} catch (error) {
		if (!(error instanceof IngestJobClaimLost)) throw error;
	}
	if (workerShutdown.signal.aborted) return 0;
	return 1;
});

// Reaper + retention sweeps on their own loop: riding the ingest loop meant a
// multi-hour link download blocked all reaping for its whole duration. The
// loop ticks every minute; reapStalledRunsIfDue's internal lastReapAt gate
// enforces the actual WORKER_REAP_INTERVAL_MS cadence.
const maintenanceLoop = createPollLoop("maintenance", 60 * 1000, async () => {
	if (workerShutdown.signal.aborted) return 0;
	await reapStalledRunsIfDue();
	await getIngestJobLifecycle().processGenerationHandoffs();
	await pruneExpiredMcpTasks();
	const expiredEvents = await purgeExpiredWorkspaceEvents();
	if (expiredEvents > 0) {
		console.warn(
			JSON.stringify({
				level: "info",
				message: "workspace_events_purged",
				count: expiredEvents,
			}),
		);
	}
	// Standing Grants past their expiry end, and a grant that paused itself tells its granter.
	const grants = getStandingGrantMaintenance(getWorkerAppBaseUrl);
	const expiredGrants = await grants.expireDue();
	if (expiredGrants > 0) {
		console.warn(
			JSON.stringify({
				level: "info",
				message: "standing_grants_expired",
				count: expiredGrants,
			}),
		);
	}
	await grants.notifyPaused();
	return 0;
});

const uploadSessionMaintenanceLoop = createPollLoop(
	"upload_session_maintenance", 30 * 1000,
	async () => {
		const uploads = await uploadSessionService.reconcileDueSessions();
		return uploads.claimed;
	},
);

createPollLoop("workflow_lease", workflowLeaseReapIntervalMs, async () => {
	const reaped = await getWorkflowRunLifecycle().reapExpiredAttempts();
	if (reaped > 0) {
		console.warn(
			JSON.stringify({
				level: "warn",
				message: "workflow_attempts_reaped",
				count: reaped,
			}),
		);
	}
	return reaped;
});

createPollLoop("workflow_events", workflowEventDispatchIntervalMs, async () => {
	return getWorkflowRunLifecycle().dispatchEvents(100);
});

// Completion Callbacks: observe accepted operations until terminal, then
// deliver signed events. Observation backs off per row; this cadence only
// bounds how soon a due row is noticed.
createPollLoop("completion_callbacks", completionCallbackPollIntervalMs, async () => {
	if (workerShutdown.signal.aborted) return 0;
	const callbacks = getCompletionCallbackProcessor();
	return (await callbacks.observe()) + (await callbacks.deliver());
});

// Webhook Subscriptions: send each active subscription its next Workspace Events
// in order, then email the creator of any that were just disabled. It shares the
// callback cadence; a caught-up subscription is looked at again every few seconds.
createPollLoop("webhook_deliveries", completionCallbackPollIntervalMs, async () => {
	if (workerShutdown.signal.aborted) return 0;
	const webhooks = getWebhookDeliveryProcessor(getWorkerAppBaseUrl);
	const delivered = await webhooks.deliver();
	return delivered + (await webhooks.notifyDisabled());
});

const workspaceBillingLoop = createPollLoop("workspace_billing", workspaceBillingPollIntervalMs, async () => {
	if (!billingService.isConfigured()) return 0;
	const result = await billingService.reconcileDueAccounts();
	if (result.claimed > 0) {
		console.warn(
			JSON.stringify({
				level: result.retried > 0 || result.unresolved > 0 ? "warn" : "info",
				message: "workspace_billing_reconciliation_batch",
				...result,
			}),
		);
	}
	return result.claimed;
});

function processNextWorkflowAttempt<
	TStage extends WorkflowAttemptRef["stage"],
>(input: {
	stage: TStage;
	holdingLease: PollRunContext["holdingLease"];
	process: (
		attempt: ClaimedWorkflowAttempt & { stage: TStage },
		context: WorkflowAttemptContext,
	) => Promise<void>;
}) {
	if (workerShutdown.signal.aborted) return Promise.resolve(0 as const);
	return executeNextWorkflowAttempt<TStage>({
		...input,
		signal: workerShutdown.signal,
		lifecycle: getWorkflowRunLifecycle(),
        ...(input.stage === "clip_rendering" ? {
          canStart: () => executorHealth.snapshot().ready && scratchReady,
          onExecutorFailure: executorHealth.failed,
        } : {}),
		onAttemptLost: (attempt, error, startedAtMs) =>
			diagnoseWorkflowAttemptLost({ run: attempt, error, startedAtMs }),
	});
}

// Submit-and-release: this claim only covers the AssemblyAI submission round
// trip (seconds), not the transcription itself — see sttResultsLoop.
const sttLoop = createPollLoop("stt", pollIntervalMs, async ({ holdingLease }) => {
	return processNextWorkflowAttempt({
		holdingLease,
		stage: "stt",
		process: processTranscriptRun,
	});
});

createPollLoop("stt_results", sttResultPollIntervalMs, async () => {
	return processSubmittedTranscriptResults();
});

createPollLoop("moment_detection", pollIntervalMs, async ({ holdingLease }) => {
	return processNextWorkflowAttempt({
		holdingLease,
		stage: "moment_detection",
		process: processClipDetectionRun,
	});
});

createPollLoop("dubbing", pollIntervalMs, async ({ holdingLease }) => {
	return processNextWorkflowAttempt({
		holdingLease,
		stage: "dubbing",
		process: processDubbingRun,
	});
});

const exportBundleLoop = createPollLoop("export_bundle", pollIntervalMs, async ({ holdingLease }) => {
	return processNextWorkflowAttempt({
		holdingLease,
		stage: "export_bundle",
		process: processExportBundleRun,
	});
});

// Deadline-sensitive scheduled posts have a dedicated loop. Remote RSS feeds
// can be slow or unavailable and must never delay a due social publish.
createPollLoop("publish", pollIntervalMs, async () => {
	return processDueSocialPosts(workerShutdown.signal);
});

// Reads view and engagement counts back from the platforms. A rate limit or a
// revoked grant only delays or skips captures; it never touches the Social Post.
// This loop is optional, so its failures are logged instead of tripping the
// circuit breaker that would restart publishing with it.
createPollLoop("performance_sync", performanceSyncPollIntervalMs, async () => {
	try {
		return await getPerformanceSync().run();
	} catch (error) {
		console.warn(
			JSON.stringify({
				level: "error",
				message: "performance_sync_failed",
				ts: new Date().toISOString(),
				error: error instanceof Error ? error.message : "Unknown error",
			}),
		);
		return 0;
	}
});

// Recomputes each Workspace's Performance Guidance about nightly. Optional, so
// a failure is logged instead of tripping the circuit breaker.
createPollLoop("performance_guidance", performanceGuidancePollIntervalMs, async () => {
	try {
		return await getPerformanceGuidance().refreshStale();
	} catch (error) {
		console.warn(
			JSON.stringify({
				level: "error",
				message: "performance_guidance_failed",
				ts: new Date().toISOString(),
				error: error instanceof Error ? error.message : "Unknown error",
			}),
		);
		return 0;
	}
});

createPollLoop("autopilot", autopilotPollIntervalMs, async () => {
	return processDueAutopilotRules();
});

createPollLoop("finishing", finishingPollIntervalMs, async () => {
	return processDueGenerationFinishing();
});

/** CPU-bound stage: clip rendering only. */
const renderLoop = createPollLoop("render", renderPollIntervalMs, async ({ holdingLease }) => {
	if (!executorHealth.snapshot().ready || !scratchReady) return 0;
	const lifecycle = getWorkflowRunLifecycle();
	await lifecycle.rescuePendingClipRenderingRun();
	return processNextWorkflowAttempt({
		holdingLease,
		stage: "clip_rendering",
		process: async (attempt, context) => {
			const run = { ...attempt, id: attempt.workflowRunId };
			const clipRenderAttempt = createClipRenderAttempt({
				run,
				config: renderConfig,
				lifecycle,
			});
			await clipRenderAttempt.execute(attempt, context);
		},
	});
});

/** Preview proxies: bounded ffmpeg cuts on their own loop so they can neither
 *  block ingest/STT nor delay due social posts. */
createPollLoop("preview", previewPollIntervalMs, async () => {
	return runBackgroundMedia("preview", () => processPendingClipPreviews({ batchSize: 1, signal: workerShutdown.signal }));
});

/** Face/shot analysis runs against the small preview proxies and publishes
 * the shared plan consumed by both studio and render. Separate mutex keeps
 * it from blocking proxy generation or workflow claims. */
createPollLoop("auto_layout", autoLayoutPollIntervalMs, async () => {
	return runBackgroundMedia("auto_layout", () => processPendingAutoLayoutAnalyses({ limit: 1, signal: workerShutdown.signal, config: renderConfig }));
});

/** Durable terminal-email retries. The service performs an atomic
 *  pending/expired-lease claim, so this loop is safe across worker replicas. */
const notificationRetryLoop = createPollLoop("notification_retry", notificationRetryPollIntervalMs, async () => {
	const startedAtMs = Date.now();
	const [result, reviewResult] = await Promise.all([
		retryPendingNotifications(notificationRetryBatchSize),
		retryPendingReviewNotifications(notificationRetryBatchSize),
	]);
	const claimed = result.claimed + reviewResult.claimed;
	if (claimed > 0) {
		console.warn(
			JSON.stringify({
				level: "info",
				message: "notification_retries_processed",
				ts: new Date().toISOString(),
				phase: "notification_delivery",
				operation: "retry_pending_notifications",
				disposition: result.failed + reviewResult.failed > 0 ? "partial" : "completed",
				retryState: result.pending + reviewResult.pending > 0 ? "pending" : "drained",
				elapsedMs: Date.now() - startedAtMs,
				terminal: result,
				review: reviewResult,
			}),
		);
	}
	return claimed;
});

const mediaCleanupLoop = createPollLoop("media_cleanup", mediaCleanupPollIntervalMs, async () => {
	const result = await mediaCleanupWorker.processDue({
		signal: workerShutdown.signal,
	});
	return result.claimed;
});

createPollLoop("generated_media", generatedMediaPollIntervalMs, async () => {
	// Without image settings nothing can be admitted or generated; idle rather
	// than failing every tick until the loop gives up.
	if (!generatedImageProviderConfigured(process.env)) return 0;
	const jobs = await generatedMediaService.processDue(1);
	return jobs.length;
});

const thumbnailFrameLoop = createPollLoop("thumbnail_frames", thumbnailFramePollIntervalMs, async () => {
	return runBackgroundMedia("thumbnail_frames", () => thumbnailFramePreparationService.processPending(1));
});

/** Embeds completed transcripts into searchable passages. A provider failure
 * backs that transcript off and ends the tick without failing the loop. */
createPollLoop("library_index", libraryIndexPollIntervalMs, async () => {
	let indexed = 0;
	while (indexed < libraryIndexBatchSize && !workerShutdown.signal.aborted) {
		const count = await getLibrarySearch().indexNext();
		if (count === 0) break;
		indexed += count;
	}
	return indexed;
});

async function handleWorkerRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
	if (req.url === "/health") {
		const loops = allLoops.map(({ loop }) => ({ name: loop.name, status: loop.status() }));
		const stalledLoops = unhealthyLoops(loops);
        const ready = startupComplete && !workerShutdown.signal.aborted && executorHealth.snapshot().ready && scratchReady && stalledLoops.length === 0;
		res.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
		res.end(
			JSON.stringify({
				ok: ready,
				stalledLoops,
				service: "narriflow-worker",
		render: {
					enabled: executorHealth.snapshot().ready,
                    executor: executorHealth.snapshot(), scratchReady,
                    resources: renderResources.snapshot(), scheduling: mediaWorkScheduler.snapshot(),
		},
		youtubeLinkIntake: { available: youtubeLinkIntakeAvailable },
				queue: {
					processedCount,
					loops: Object.fromEntries(loops.map(({ name, status }) => [name, status])),
				},
			}),
		);
		return;
	}

	if (req.url === "/poll-once" && req.method === "POST") {
		if (!startupComplete || workerShutdown.signal.aborted) {
			res.writeHead(503, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "worker_shutting_down" }));
			return;
		}
		await Promise.all(allLoops.map(({ loop }) => loop.tick()));
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true }));
		return;
	}

	res.writeHead(404, { "content-type": "application/json" });
	res.end(JSON.stringify({ error: "not_found" }));
}

let loopIntervals: ReturnType<typeof setInterval>[] = [];
process.once("SIGTERM", () => beginGracefulShutdown());
process.once("SIGINT", () => beginGracefulShutdown());

// YouTube is one link-intake dependency. It must never decide whether billing,
// publishing, or other worker loops can start or remain alive.
// Keep retrying so a temporary helper failure cannot strand queued imports.
await executorHealth.checkIfDue();
await maintainRenderResources();
startupComplete = true;
void superviseYoutubeTokenServer(
  workerShutdown.signal,
  () => startYoutubeTokenServer(
    process.env.YTDLP_POT_SERVER_HOME ?? "/opt/youtube-tokens",
    workerShutdown.signal,
  ),
  (available) => {
    youtubeLinkIntakeAvailable = available;
    if (available) console.warn(JSON.stringify({ level: "info", message: "youtube_network_configured", mode: youtubeProxyUrl ? "proxy" : "direct" }));
  },
);
createPollLoop("render_executor_health", 5_000, async () => {
  await executorHealth.checkIfDue();
  await refreshScratchReadiness();
  return 0;
});
createPollLoop("render_resources", renderConfig.scratchSweepIntervalMs, async () => {
  await maintainRenderResources();
  return 0;
});
let reconciliationCursor: string | undefined;
createPollLoop("render_objects", 60 * 60 * 1000, async () => {
  const prisma = getPrismaClient();
  if (!prisma) return 0;
  const projects = await prisma.project.findMany({
    where: reconciliationCursor ? { id: { gt: reconciliationCursor } } : {},
    orderBy: { id: "asc" }, take: 1, select: { id: true },
  });
  reconciliationCursor = projects[0]?.id;
  if (reconciliationCursor) await reconcileRenderObjectsForMaintenance(reconciliationCursor, workerShutdown.signal);
  return 0;
});

loopIntervals = allLoops.map(({ loop, intervalMs }) =>
	setInterval(() => {
		void loop.tick();
	}, intervalMs),
);

function beginGracefulShutdown(exitCode = 0) {
	if (workerShutdown.signal.aborted) return;
    process.exitCode = exitCode;
	youtubeLinkIntakeAvailable = false;
	workerShutdown.abort();
	for (const interval of loopIntervals) clearInterval(interval);
	server.close();
	// Every process-capable stage receives workerShutdown and Worker Process
	// reaps descendants on abort. Do not let an adapter that ignores cancellation
	// keep a deployment hostage forever.
	// The same drain sets how long released work waits before a peer may claim it.
	const forceExit = setTimeout(() => process.exit(exitCode), workerShutdownDrainMs());
	forceExit.unref();
}

void maintenanceLoop.tick();
void uploadSessionMaintenanceLoop.tick();
void workspaceBillingLoop.tick();
void ingestLoop.tick();
void sttLoop.tick();
void renderLoop.tick();
void exportBundleLoop.tick();
void notificationRetryLoop.tick();
void mediaCleanupLoop.tick();
void thumbnailFrameLoop.tick();

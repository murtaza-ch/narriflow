import { createServer } from "node:http";
import {
  billingService,
  getWorkflowRunLifecycle,
  projectService,
  projectRetentionService,
  purgeExpiredProjectSources,
  purgeOldWebhookDeliveryLogs,
  purgeOldWorkflowEvents,
  socialService,
  WorkflowAttemptLost,
  workflowAttemptRef,
  runProtocolV1Compatibility,
} from "@narriflow/services";
import { processDueAutopilotRules } from "./tasks/autopilot";
import { processClipDetectionRun } from "./tasks/detect-clips";
import { processPendingClipPreviews } from "./tasks/clip-preview";
import { processPendingAutoLayoutAnalyses } from "./tasks/auto-layout-analysis";
import { processDubbingRun } from "./tasks/dubbing";
import { processIngestJob } from "./tasks/ingest";
import { processClipRenderingRun } from "./tasks/render-clips";
import { processDueSocialPosts } from "./tasks/social-publisher";
import {
  processSubmittedTranscriptResults,
  processTranscriptRun,
} from "./tasks/transcribe";
import {
  notifyExpiringProject,
  retryPendingNotifications,
} from "./notifications";

const port = Number(process.env.PORT || 0);
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
const reapStallTimeoutMs = Number(
  process.env.WORKER_REAP_STALL_TIMEOUT_MS ?? String(30 * 60 * 1000),
);
const workflowLeaseReapIntervalMs = Number(
  process.env.WORKFLOW_LEASE_REAP_INTERVAL_MS ?? "30000",
);
const workflowEventDispatchIntervalMs = Number(
  process.env.WORKFLOW_EVENT_DISPATCH_INTERVAL_MS ?? "1000",
);
const maxConsecutivePollFailures = Number(
  process.env.WORKER_MAX_CONSECUTIVE_POLL_FAILURES ?? "20",
);

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
// claim loops — claimSubmittedTranscriptRunsForPolling additionally gates
// each run by ASSEMBLYAI_POLL_INTERVAL_MS via its lease.
const sttResultPollIntervalMs = Number(
  process.env.STT_RESULT_POLL_INTERVAL_MS ?? "5000",
);
const notificationRetryPollIntervalMs = Number(
  process.env.NOTIFICATION_RETRY_POLL_INTERVAL_MS ?? String(60 * 1000),
);
const autopilotPollIntervalMs = Number(
  process.env.AUTOPILOT_POLL_INTERVAL_MS ?? "30000",
);
const notificationRetryBatchSize = Number(
  process.env.NOTIFICATION_RETRY_BATCH_SIZE ?? "25",
);

let processedCount = 0;
let lastReapAt = 0;
let lastSeatReconcileAt = 0;

/** Periodically fails workflow runs orphaned by a crashed/evicted worker.
 *  Called only from the ingest loop (rate-limited internally via lastReapAt),
 *  so it runs on a steady cadence regardless of what the other loops are
 *  doing. */
async function reapStalledRunsIfDue() {
  const now = Date.now();
  if (now - lastReapAt < reapIntervalMs) return;
  lastReapAt = now;
  try {
    if (now - lastSeatReconcileAt >= 60 * 60 * 1000) {
      lastSeatReconcileAt = now;
      const seats = await billingService.reconcileAllWorkspaceSeats(
        Number(process.env.WORKSPACE_SEAT_RECONCILIATION_BATCH_SIZE ?? 100),
      );
      console.warn(JSON.stringify({
        level: seats.failed > 0 ? "warn" : "info",
        message: "workspace_seat_reconciliation_complete",
        ...seats,
      }));
    }
    const reaped = await projectService.reapStuckWorkflowRuns(
      reapStallTimeoutMs,
    );
    const reapedIngest = await projectService.reapStuckIngestJobs(
      reapStallTimeoutMs,
    );
    const reapedPosts = await socialService.reapStuckPublishingPosts(
      reapStallTimeoutMs,
    );
    if (reaped > 0) {
      console.log(
        JSON.stringify({
          level: "info",
          message: "workflow_runs_reaped",
          count: reaped,
          ts: new Date().toISOString(),
        }),
      );
    }
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
    if (reapedPosts > 0) {
      console.log(
        JSON.stringify({
          level: "info",
          message: "social_posts_reaped",
          count: reapedPosts,
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

    const observeMetrics = await projectRetentionService.getObserveMetrics();
    if (observeMetrics) {
      console.warn(
        JSON.stringify({
          level: "info",
          message: "project_retention_observe_metrics",
          ...observeMetrics,
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
    const receiptsDeleted =
      await projectRetentionService.deleteExpiredReceipts(
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
    console.error(
      JSON.stringify({
        level: "error",
        message: "reaper_failed",
        ts: new Date().toISOString(),
        error: error instanceof Error ? error.message : "Unknown error",
      }),
    );
  }
}

interface PollLoop {
  name: string;
  tick: () => Promise<void>;
  status: () => { polling: boolean; lastPollAt: string | null };
}

async function executeClaimedWorkflowRun<
  TRun extends {
    id: string;
    projectId: string;
    stage: string;
    lifecycleVersion: number;
    attemptId: string | null;
    attemptCount: number;
  },
>(run: TRun, process: (run: TRun, signal?: AbortSignal) => Promise<void>) {
  if (run.lifecycleVersion !== 2 || !run.attemptId) {
    await runProtocolV1Compatibility(
      {
        workflowRunId: run.id,
        projectId: run.projectId,
        stage: run.stage as Parameters<typeof runProtocolV1Compatibility>[0]["stage"],
      },
      () => process(run),
    );
    return;
  }
  const attempt = workflowAttemptRef({
    id: run.id,
    projectId: run.projectId,
    stage: run.stage,
    attemptId: run.attemptId,
    attemptCount: run.attemptCount,
  });
  try {
    await getWorkflowRunLifecycle().runAttempt(attempt, ({ signal }) =>
      process(run, signal),
    );
  } catch (error) {
    if (!(error instanceof WorkflowAttemptLost)) throw error;
    console.warn(
      JSON.stringify({
        level: "warn",
        message: "workflow_attempt_lost",
        workflowRunId: run.id,
        attemptId: run.attemptId,
        stage: run.stage,
      }),
    );
  }
}

/**
 * One loop per stage, each with its own mutex and consecutive-failure circuit
 * breaker. The old single IO loop held one mutex across ingest + stt +
 * moment_detection + dubbing + autopilot + social for every project on the
 * worker, so any long stage (a multi-GB ingest, an in-flight detection call)
 * starved all the others — the same reasoning that split render and preview
 * out originally, applied to the rest. Claims stay atomic
 * (claimNextWorkflowRun / claimNextIngestJob conditional updates), so loops
 * on this process and on other replicas can never double-claim a job.
 */
function createPollLoop(
  name: string,
  fn: () => Promise<number>,
): PollLoop {
  let polling = false;
  let lastPollAt: string | null = null;
  let consecutiveFailures = 0;

  return {
    name,
    status: () => ({ polling, lastPollAt }),
    tick: async () => {
      if (polling) {
        return;
      }
      polling = true;
      // Stamped at tick start, not completion — a multi-minute render must
      // not make this loop look stale to anything watching /health.
      lastPollAt = new Date().toISOString();
      try {
        const processed = await fn();
        consecutiveFailures = 0;
        if (processed > 0) {
          processedCount += processed;
        }
      } catch (error) {
        consecutiveFailures += 1;
        console.error(
          JSON.stringify({
            level: "error",
            message: "worker_poll_failed",
            ts: new Date().toISOString(),
            loop: name,
            error: error instanceof Error ? error.message : "Unknown error",
            consecutiveFailures,
          }),
        );
        if (consecutiveFailures >= maxConsecutivePollFailures) {
          console.error(
            JSON.stringify({
              level: "error",
              message: "worker_poll_failures_exceeded",
              ts: new Date().toISOString(),
              loop: name,
              consecutiveFailures,
            }),
          );
          process.exit(1);
        }
      } finally {
        polling = false;
      }
    },
  };
}

const ingestLoop = createPollLoop("ingest", async () => {
  const ingestJob = await projectService.claimNextIngestJob();
  if (!ingestJob) return 0;
  await processIngestJob(ingestJob);
  return 1;
});

// Reaper + retention sweeps on their own loop: riding the ingest loop meant a
// multi-hour link download blocked all reaping for its whole duration. The
// loop ticks every minute; reapStalledRunsIfDue's internal lastReapAt gate
// enforces the actual WORKER_REAP_INTERVAL_MS cadence.
const maintenanceLoop = createPollLoop("maintenance", async () => {
  await reapStalledRunsIfDue();
  return 0;
});

const workflowLeaseLoop = createPollLoop("workflow_lease", async () => {
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

const workflowEventLoop = createPollLoop("workflow_events", async () => {
  return getWorkflowRunLifecycle().dispatchEvents(100);
});

// Submit-and-release: this claim only covers the AssemblyAI submission round
// trip (seconds), not the transcription itself — see sttResultsLoop.
const sttLoop = createPollLoop("stt", async () => {
  const run = await projectService.claimNextWorkflowRun("stt");
  if (!run) return 0;
  await executeClaimedWorkflowRun(run, processTranscriptRun);
  return 1;
});

const sttResultsLoop = createPollLoop("stt_results", async () => {
  return processSubmittedTranscriptResults();
});

const detectionLoop = createPollLoop("moment_detection", async () => {
  const run = await projectService.claimNextWorkflowRun("moment_detection");
  if (!run) return 0;
  await executeClaimedWorkflowRun(run, processClipDetectionRun);
  return 1;
});

const dubbingLoop = createPollLoop("dubbing", async () => {
  const run = await projectService.claimNextWorkflowRun("dubbing");
  if (!run) return 0;
  await executeClaimedWorkflowRun(run, processDubbingRun);
  return 1;
});

// Deadline-sensitive scheduled posts have a dedicated loop. Remote RSS feeds
// can be slow or unavailable and must never delay a due social publish.
const publishLoop = createPollLoop("publish", async () => {
  return processDueSocialPosts();
});

const autopilotLoop = createPollLoop("autopilot", async () => {
  return processDueAutopilotRules();
});

/** CPU-bound stage: clip rendering only. Still safe under multiple worker
 *  processes — claimNextWorkflowRun's conditional update (status=queued ->
 *  running) is the same atomic claim every poller already relies on. */
const renderLoop = createPollLoop("render", async () => {
  const run = await projectService.claimNextWorkflowRun("clip_rendering");
  if (!run) return 0;
  await executeClaimedWorkflowRun(run, processClipRenderingRun);
  return 1;
});

/** Preview proxies: bounded ffmpeg cuts on their own loop so they can neither
 *  block ingest/STT nor delay due social posts. */
const previewLoop = createPollLoop("preview", async () => {
  return processPendingClipPreviews();
});

/** Face/shot analysis runs against the small preview proxies and publishes
 * the shared plan consumed by both studio and render. Separate mutex keeps
 * it from blocking proxy generation or workflow claims. */
const autoLayoutLoop = createPollLoop("auto_layout", async () => {
  return processPendingAutoLayoutAnalyses();
});

/** Durable terminal-email retries. The service performs an atomic
 *  pending/expired-lease claim, so this loop is safe across worker replicas. */
const notificationRetryLoop = createPollLoop("notification_retry", async () => {
  const result = await retryPendingNotifications(notificationRetryBatchSize);
  if (result.claimed > 0) {
    console.log(
      JSON.stringify({
        level: "info",
        message: "notification_retries_processed",
        ts: new Date().toISOString(),
        ...result,
      }),
    );
  }
  return result.claimed;
});

const allLoops: Array<{ loop: PollLoop; intervalMs: number }> = [
  { loop: maintenanceLoop, intervalMs: 60 * 1000 },
  { loop: workflowLeaseLoop, intervalMs: workflowLeaseReapIntervalMs },
  { loop: workflowEventLoop, intervalMs: workflowEventDispatchIntervalMs },
  { loop: ingestLoop, intervalMs: pollIntervalMs },
  { loop: sttLoop, intervalMs: pollIntervalMs },
  { loop: sttResultsLoop, intervalMs: sttResultPollIntervalMs },
  { loop: detectionLoop, intervalMs: pollIntervalMs },
  { loop: dubbingLoop, intervalMs: pollIntervalMs },
  { loop: publishLoop, intervalMs: pollIntervalMs },
  { loop: autopilotLoop, intervalMs: autopilotPollIntervalMs },
  { loop: renderLoop, intervalMs: renderPollIntervalMs },
  { loop: previewLoop, intervalMs: previewPollIntervalMs },
  { loop: autoLayoutLoop, intervalMs: autoLayoutPollIntervalMs },
  { loop: notificationRetryLoop, intervalMs: notificationRetryPollIntervalMs },
];

const server = createServer(async (req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        service: "narriflow-worker",
        queue: {
          processedCount,
          loops: Object.fromEntries(
            allLoops.map(({ loop }) => [loop.name, loop.status()]),
          ),
        },
      }),
    );
    return;
  }

  if (req.url === "/poll-once" && req.method === "POST") {
    await Promise.all(allLoops.map(({ loop }) => loop.tick()));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

server.listen(port, () => {
  const address = server.address();
  const resolvedPort =
    typeof address === "object" && address ? address.port : port;
  console.log(`narriflow worker listening on :${resolvedPort}`);
});

for (const { loop, intervalMs } of allLoops) {
  setInterval(() => {
    void loop.tick();
  }, intervalMs);
}

void maintenanceLoop.tick();
void ingestLoop.tick();
void sttLoop.tick();
void renderLoop.tick();
void notificationRetryLoop.tick();

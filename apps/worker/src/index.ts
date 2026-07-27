import { createServer } from "node:http";
import {
  projectService,
  purgeExpiredProjectSources,
  purgeOldWebhookDeliveryLogs,
  purgeOldWorkflowEvents,
  socialService,
} from "@narriflow/services";
import { processDueAutopilotRules } from "./tasks/autopilot";
import { processClipDetectionRun } from "./tasks/detect-clips";
import { processPendingClipPreviews } from "./tasks/clip-preview";
import { processDubbingRun } from "./tasks/dubbing";
import { processIngestJob } from "./tasks/ingest";
import { processClipRenderingRun } from "./tasks/render-clips";
import { processDueSocialPosts } from "./tasks/social-publisher";
import { processTranscriptRun } from "./tasks/transcribe";

const port = Number(process.env.PORT || 0);
const pollIntervalMs = Number(process.env.INGEST_POLL_INTERVAL_MS ?? "2500");
// Rendering is CPU-bound and can run for minutes (ffmpeg saturates all cores
// per clip already — measured intra-machine clip parallelism buys nothing: 4
// clips in parallel took 40.49s vs 39.50s sequential — so this does NOT add
// parallel clip encoding). Polling it from the same loop/mutex as the
// I/O-bound stages (ingest download/upload, STT submit/poll, moment
// detection, dubbing, social publish) meant one in-progress render blocked
// ALL of those for every project on the worker. It now polls on its own
// interval/mutex so a render never starves I/O work; each loop still
// processes at most one job per tick, so a render is still never run
// concurrently with another render on this process.
const renderPollIntervalMs = Number(
  process.env.RENDER_POLL_INTERVAL_MS ?? String(pollIntervalMs),
);
const reapIntervalMs = Number(
  process.env.WORKER_REAP_INTERVAL_MS ?? String(5 * 60 * 1000),
);
const reapStallTimeoutMs = Number(
  process.env.WORKER_REAP_STALL_TIMEOUT_MS ?? String(30 * 60 * 1000),
);
const maxConsecutivePollFailures = Number(
  process.env.WORKER_MAX_CONSECUTIVE_POLL_FAILURES ?? "20",
);

// Preview proxies are short ffmpeg cuts, but "short" is ~12s each and a batch
// runs them in sequence — roughly a minute of CPU+network per tick. Running
// that on the I/O loop blocked ingest/STT for the duration and, because the
// loop returns early once previews do work, a sustained backlog also starved
// deadline-sensitive social publishing. Own loop, own mutex.
const previewPollIntervalMs = Number(
  process.env.PREVIEW_POLL_INTERVAL_MS ?? String(pollIntervalMs),
);

let ioPolling = false;
let renderPolling = false;
let previewPolling = false;
let processedCount = 0;
let lastPollAt: string | null = null;
let lastRenderPollAt: string | null = null;
let lastPreviewPollAt: string | null = null;
let lastReapAt = 0;
let consecutiveIoPollFailures = 0;
let consecutiveRenderPollFailures = 0;
let consecutivePreviewPollFailures = 0;

/** Periodically fails workflow runs orphaned by a crashed/evicted worker.
 *  Called only from the I/O loop (rate-limited internally via lastReapAt),
 *  so it still runs on the same cadence regardless of what the render loop
 *  is doing. */
async function reapStalledRunsIfDue() {
  const now = Date.now();
  if (now - lastReapAt < reapIntervalMs) return;
  lastReapAt = now;
  try {
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

/** Shared consecutive-failure circuit breaker for both poll loops — each
 *  loop tracks its own count against the same configured threshold, since
 *  they now fail independently of one another. */
function reportPollFailureAndMaybeExit(
  loop: "io" | "render" | "preview",
  message: string,
  consecutiveFailures: number,
  error: unknown,
) {
  console.error(
    JSON.stringify({
      level: "error",
      message,
      ts: new Date().toISOString(),
      loop,
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
        loop,
        consecutiveFailures,
      }),
    );
    process.exit(1);
  }
}

/** I/O-bound stages: ingest, STT, moment detection, dubbing, autopilot,
 *  social publish. Tries each in turn and processes at most one per tick,
 *  same as before — this loop is never blocked by an in-progress render. */
async function pollIoQueue() {
  if (ioPolling) {
    return;
  }

  ioPolling = true;

  try {
    await reapStalledRunsIfDue();

    const ingestJob = await projectService.claimNextIngestJob();
    lastPollAt = new Date().toISOString();
    consecutiveIoPollFailures = 0;

    if (ingestJob) {
      await processIngestJob(ingestJob);
      processedCount += 1;
      return;
    }

    const workflowRun = await projectService.claimNextWorkflowRun("stt");

    if (workflowRun) {
      await processTranscriptRun(workflowRun);
      processedCount += 1;
      return;
    }

    const clipRun = await projectService.claimNextWorkflowRun("moment_detection");

    if (clipRun) {
      await processClipDetectionRun(clipRun);
      processedCount += 1;
      return;
    }

    const dubbingRun = await projectService.claimNextWorkflowRun("dubbing");

    if (dubbingRun) {
      await processDubbingRun(dubbingRun);
      processedCount += 1;
      return;
    }

    const autopilotRulesProcessed = await processDueAutopilotRules();
    if (autopilotRulesProcessed > 0) {
      processedCount += autopilotRulesProcessed;
      return;
    }

    const socialPostsProcessed = await processDueSocialPosts();
    if (socialPostsProcessed > 0) {
      processedCount += socialPostsProcessed;
    }
  } catch (error) {
    consecutiveIoPollFailures += 1;
    reportPollFailureAndMaybeExit(
      "io",
      "ingest_queue_poll_failed",
      consecutiveIoPollFailures,
      error,
    );
  } finally {
    ioPolling = false;
  }
}

/** CPU-bound stage: clip rendering only. Its own mutex/interval so a
 *  long-running render never blocks the I/O loop above. Still safe under
 *  multiple worker processes — claimNextWorkflowRun's conditional update
 *  (status=queued -> running) is the same atomic claim every poller already
 *  relies on, so two processes (or this process's two loops) racing on the
 *  same row still only lets one of them win. */
async function pollRenderQueue() {
  if (renderPolling) {
    return;
  }

  renderPolling = true;

  try {
    const renderRun =
      await projectService.claimNextWorkflowRun("clip_rendering");
    lastRenderPollAt = new Date().toISOString();
    consecutiveRenderPollFailures = 0;

    if (renderRun) {
      await processClipRenderingRun(renderRun);
      processedCount += 1;
    }
  } catch (error) {
    consecutiveRenderPollFailures += 1;
    reportPollFailureAndMaybeExit(
      "render",
      "render_queue_poll_failed",
      consecutiveRenderPollFailures,
      error,
    );
  } finally {
    renderPolling = false;
  }
}

/** Preview proxies: bounded ffmpeg cuts on their own loop so they can neither
 *  block ingest/STT nor delay due social posts. Each tick processes at most
 *  one bounded batch; per-clip failures back off inside the task itself. */
async function pollPreviewQueue() {
  if (previewPolling) {
    return;
  }

  previewPolling = true;

  try {
    const previewsProcessed = await processPendingClipPreviews();
    lastPreviewPollAt = new Date().toISOString();
    consecutivePreviewPollFailures = 0;

    if (previewsProcessed > 0) {
      processedCount += previewsProcessed;
    }
  } catch (error) {
    consecutivePreviewPollFailures += 1;
    reportPollFailureAndMaybeExit(
      "preview",
      "preview_queue_poll_failed",
      consecutivePreviewPollFailures,
      error,
    );
  } finally {
    previewPolling = false;
  }
}

const server = createServer(async (req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        service: "narriflow-worker",
        queue: {
          ioPolling,
          renderPolling,
          previewPolling,
          processedCount,
          lastPollAt,
          lastRenderPollAt,
          lastPreviewPollAt,
        },
      }),
    );
    return;
  }

  if (req.url === "/poll-once" && req.method === "POST") {
    await Promise.all([pollIoQueue(), pollRenderQueue(), pollPreviewQueue()]);
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

setInterval(() => {
  void pollIoQueue();
}, pollIntervalMs);

setInterval(() => {
  void pollPreviewQueue();
}, previewPollIntervalMs);

setInterval(() => {
  void pollRenderQueue();
}, renderPollIntervalMs);

void pollIoQueue();
void pollRenderQueue();

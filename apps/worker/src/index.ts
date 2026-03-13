import { createServer } from "node:http";
import { projectService } from "@narriflow/services";
import { processClipDetectionRun } from "./tasks/detect-clips";
import { processIngestJob } from "./tasks/ingest";
import { processClipRenderingRun } from "./tasks/render-clips";
import { processTranscriptRun } from "./tasks/transcribe";

const port = Number(process.env.PORT || 0);
const pollIntervalMs = Number(process.env.INGEST_POLL_INTERVAL_MS ?? "2500");
let polling = false;
let processedCount = 0;
let lastPollAt: string | null = null;

async function pollIngestQueue() {
  if (polling) {
    return;
  }

  polling = true;

  try {
    const ingestJob = await projectService.claimNextIngestJob();
    lastPollAt = new Date().toISOString();

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

    const renderRun =
      await projectService.claimNextWorkflowRun("clip_rendering");

    if (!renderRun) {
      return;
    }

    await processClipRenderingRun(renderRun);
    processedCount += 1;
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        message: "ingest_queue_poll_failed",
        ts: new Date().toISOString(),
        error: error instanceof Error ? error.message : "Unknown error",
      }),
    );
  } finally {
    polling = false;
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
          polling,
          processedCount,
          lastPollAt,
        },
      }),
    );
    return;
  }

  if (req.url === "/poll-once" && req.method === "POST") {
    await pollIngestQueue();
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
  void pollIngestQueue();
}, pollIntervalMs);

void pollIngestQueue();

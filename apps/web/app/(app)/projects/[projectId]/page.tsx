import { notFound } from "next/navigation";
import { randomUUID } from "node:crypto";
import { Button } from "@narriflow/ui/components/button";
import { requireCurrentAppUser } from "@narriflow/auth";
import { projectService } from "@narriflow/services";
import { ProjectEvents } from "./project-events";
import { queueTranscriptionFormAction } from "../actions";
import { TranscriptPanel } from "./transcript-panel";

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const appUser = await requireCurrentAppUser();
  const { projectId } = await params;
  const [snapshot, transcript] = await Promise.all([
    projectService.getProjectSnapshot(appUser.id, projectId),
    projectService.getTranscriptSnapshot(appUser.id, projectId),
  ]);

  if (!snapshot.project) {
    notFound();
  }

  const isIngestReady = snapshot.project.ingestStatus === "ready";
  const transcriptReady = transcript?.status === "completed";
  const transcriptInFlight =
    transcript?.status === "queued" || transcript?.status === "processing";

  return (
    <section className="space-y-8">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">
          {snapshot.project.title}
        </h1>
        <p className="text-sm text-muted-foreground">
          {snapshot.project.sourceMediaUrl}
        </p>
        <p className="text-sm text-muted-foreground">
          Source: {snapshot.project.sourceType} - Ingest status:{" "}
          {snapshot.project.ingestStatus}
        </p>
        {snapshot.project.ingestErrorCode ? (
          <p className="text-sm text-destructive">
            Last ingest error: {snapshot.project.ingestErrorCode}
          </p>
        ) : null}
      </div>

      <form
        action={queueTranscriptionFormAction}
        className="rounded-xl border border-border p-6"
      >
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="idempotencyKey" value={randomUUID()} />
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium">AI Transcription</p>
            <p className="text-xs text-muted-foreground">
              Queue the `stt` workflow stage and persist a read-only transcript
              with subtitle exports.
            </p>
            {!isIngestReady ? (
              <p className="mt-1 text-xs text-amber-600">
                Transcription is disabled until ingest is ready.
              </p>
            ) : null}
          </div>
          <Button
            disabled={!isIngestReady || transcriptReady || transcriptInFlight}
            type="submit"
          >
            {transcriptReady
              ? "Transcript Ready"
              : transcriptInFlight
                ? "Transcribing..."
                : "Start Transcription"}
          </Button>
        </div>
      </form>

      <TranscriptPanel projectId={projectId} transcript={transcript} />

      <ProjectEvents projectId={projectId} initialSeq={snapshot.lastSeq} />
    </section>
  );
}

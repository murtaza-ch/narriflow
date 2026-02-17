import { notFound } from "next/navigation";
import { randomUUID } from "node:crypto";
import { Button } from "@narriflow/ui/components/button";
import { projectService } from "@narriflow/services";
import { ProjectEvents } from "./project-events";
import { queueGenerationFormAction } from "../actions";

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const snapshot = await projectService.getProjectSnapshot(projectId);

  if (!snapshot.project) {
    notFound();
  }

  return (
    <section className="space-y-8">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">{snapshot.project.title}</h1>
        <p className="text-sm text-muted-foreground">{snapshot.project.sourceMediaUrl}</p>
      </div>

      <form action={queueGenerationFormAction} className="rounded-xl border border-border p-6">
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="idempotencyKey" value={randomUUID()} />
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium">Trigger Workflow</p>
            <p className="text-xs text-muted-foreground">
              POST /api/projects/:id/generate with idempotency key.
            </p>
          </div>
          <Button type="submit">Generate Outputs</Button>
        </div>
      </form>

      <section className="rounded-xl border border-border p-4 text-sm">
        <h2 className="mb-2 font-semibold">Snapshot</h2>
        <p className="text-muted-foreground">lastSeq: {snapshot.lastSeq}</p>
        <p className="text-muted-foreground">
          activeRun: {snapshot.activeRun ? snapshot.activeRun.workflowRunId : "none"}
        </p>
      </section>

      <ProjectEvents projectId={projectId} initialSeq={snapshot.lastSeq} />
    </section>
  );
}

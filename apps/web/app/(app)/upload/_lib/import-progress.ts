import type { ProjectDetail } from "@narriflow/api-client/projects";

type ImportDetail = Pick<ProjectDetail, "snapshot" | "clips" | "transcript">;

/** A source being ready, or the first rendered clip, never completes an import. */
export function deriveImportProgress({ snapshot, clips, transcript }: ImportDetail) {
  const project = snapshot.project;
  const run = snapshot.activeRun;
  const generationRun = run !== null && ["stt", "moment_detection", "clip_rendering"].includes(run.stage);
  const readyCount = clips.filter((clip) => clip.renderVariants.length > 0 && clip.renderVariants.every(
    (variant) => variant.status === "completed" && variant.hasAsset,
  )).length;
  const generating = generationRun
    && ["queued", "running", "waiting"].includes(run.status);
  const failed = project?.ingestStatus === "failed" || transcript.data?.status === "failed"
    || (generationRun && ["failed", "partial"].includes(run.status));
  const empty = run?.stage === "moment_detection" && run.status === "completed" && clips.length === 0;
  const ready = project?.ingestStatus === "ready" && transcript.data?.status === "completed"
    && clips.length > 0 && readyCount === clips.length && !generating && !failed;
  const label = ready ? "Your clips are ready" : failed ? "Clip generation needs attention"
    : empty ? "No clips found"
    : project?.ingestStatus !== "ready" ? "Importing your video"
    : transcript.data?.status !== "completed" || run?.stage === "stt" ? "Transcribing your video"
    : clips.length === 0 ? "Finding the best moments"
    : readyCount === clips.length ? "Finishing your clips" : "Rendering your clips";
  return {
    state: ready ? "ready" as const : failed || empty ? "failed" as const : "processing" as const,
    label,
    readyCount,
    totalCount: clips.length,
    progress: generating ? run.progress : null,
    errorCode: project?.ingestErrorCode ?? run?.errorCode ?? transcript.data?.errorCode ?? null,
  };
}

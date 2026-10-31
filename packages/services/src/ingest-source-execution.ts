import type { IngestJob, Prisma, PrismaClient } from "@prisma/client";
import { ingestFetchSourceCommandSchema, sourceAudioBindingSchema, sourceVideoBindingSchema } from "@narriflow/validators/execution";
import { createExecutorControl, ExecutorControlError, type ExecutorArtifactHead } from "./executor-control";
import { createExecutionTransfer } from "./execution-transfer";
import type { createExecutionStorage } from "./execution-storage";
import type { IngestJobLifecycle, IngestArtifactCommit } from "./ingest-job-lifecycle";
import { createTranscriptionProbe } from "./transcription-probe";
import type { WorkflowRunLifecycle } from "./workflow-run-lifecycle";

function canonical(value: Prisma.JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(",")}}`;
  return JSON.stringify(value);
}
async function digest(value: string) { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, "0")).join(""); }

/** Canonical payload order survives Postgres JSONB serialization. */
export function ingestExecutionInputHash(job: Pick<IngestJob, "id" | "projectId" | "jobType" | "payload" | "sourceRevision" | "generation" | "deploymentEpoch">, toolchainFingerprint: string): Promise<string> {
  if (!/^[a-f0-9]{64}$/.test(toolchainFingerprint)) throw new ExecutorControlError("invalid_reference");
  return digest(canonical({ kind: "ingest_source_v1", id: job.id, projectId: job.projectId, jobType: job.jobType, payload: job.payload,
    sourceRevision: job.sourceRevision, generation: job.generation, deploymentEpoch: job.deploymentEpoch, toolchainFingerprint }));
}

/** Normalize to an identity before any native extractor sees a URL. */
export function ingestYouTubeMediaId(input: unknown): string {
  if (typeof input !== "string" || input.length > 2048 || [...input].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)) throw new ExecutorControlError("invalid_reference");
  let id: string | null = null;
  try {
    const url = new URL(input);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port) throw new Error();
    if (url.hostname === "youtu.be" && /^\/[A-Za-z0-9_-]{11}\/?$/.test(url.pathname)) id = url.pathname.split("/")[1]!;
    else if (["youtube.com", "www.youtube.com", "m.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com"].includes(url.hostname)) {
      if (url.pathname === "/watch" && url.searchParams.getAll("v").length === 1) id = url.searchParams.get("v");
      else if (/^\/(?:shorts|embed|live)\/[A-Za-z0-9_-]{11}\/?$/.test(url.pathname)) id = url.pathname.split("/")[2]!;
    }
  } catch { /* Return only a fixed error, never the source URL. */ }
  if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) throw new ExecutorControlError("invalid_reference");
  return id;
}

export function createIngestSourceExecution(options: {
  database: PrismaClient; domain: IngestJobLifecycle; workflow: WorkflowRunLifecycle;
  storage: ReturnType<typeof createExecutionStorage>; toolchainFingerprint: string;
  artifacts: { head(assignment: Readonly<import("@prisma/client").ExecutionArtifact>): Promise<ExecutorArtifactHead | null> };
  deliverWakes(ids: readonly string[]): Promise<void>;
}) {
  if (!/^[a-f0-9]{64}$/.test(options.toolchainFingerprint)) throw new ExecutorControlError("invalid_reference");
  const probe = createTranscriptionProbe({ database: options.database, workflow: options.workflow });
  const control = createExecutorControl({ database: options.database, subjectKind: "ingest_job", domain: options.domain,
    artifacts: { head: options.artifacts.head, prepare: async (assignment, artifact, reported): Promise<IngestArtifactCommit> => {
      if (reported.role === "probe") return { ...artifact, role: "probe" };
      const attempt = await options.database.executionAttempt.findUniqueOrThrow({ where: { attemptToken: assignment.attemptToken }, include: { dispatch: true } });
      const job = await options.database.ingestJob.findUniqueOrThrow({ where: { id: attempt.dispatch.subjectId } });
      if (attempt.dispatch.subjectKind !== "ingest_job" || attempt.inputHash !== await ingestExecutionInputHash(job, options.toolchainFingerprint) ||
        !job.payload || typeof job.payload !== "object" || Array.isArray(job.payload) || job.payload.provider !== "youtube") throw new ExecutorControlError("artifact_invalid");
      const mediaId = ingestYouTubeMediaId(job.payload.url);
      const expected = (binding: { projectId: string; sourceRevision: number; mediaIdentity: { provider: string; mediaId: string }; toolchainFingerprint: string; probeVersion: string }) =>
        binding.projectId === job.projectId && binding.sourceRevision === job.sourceRevision && binding.mediaIdentity.provider === "youtube" && binding.mediaIdentity.mediaId === mediaId &&
        binding.toolchainFingerprint === options.toolchainFingerprint && binding.probeVersion === "normalized-probe-v1";
      if (reported.role === "source_audio") {
        const binding = sourceAudioBindingSchema.parse(reported.sourceAudio);
        if (!expected(binding) || binding.sourceAudioId !== assignment.attemptToken) throw new ExecutorControlError("artifact_invalid");
        return { ...artifact, role: "source_audio", binding };
      }
      if (reported.role === "source_video") {
        const binding = sourceVideoBindingSchema.parse(reported.sourceVideo);
        if (!expected(binding)) throw new ExecutorControlError("artifact_invalid");
        return { ...artifact, role: "source_video", binding };
      }
      throw new ExecutorControlError("artifact_invalid");
    } }, deliverWakes: options.deliverWakes,
  });
  const transfer = createExecutionTransfer({ database: options.database, authority: control, storage: options.storage,
    resolvePackage: async authority => {
      const { reference, attemptToken } = authority.fence;
      if (reference.kind !== "modal_execution" || reference.subject.kind !== "ingest_job" || authority.functionName !== "fetch_source") throw new ExecutorControlError("invalid_reference");
      const job = await options.database.ingestJob.findUniqueOrThrow({ where: { id: reference.subject.id }, include: { project: { select: { sourceRevision: true } } } });
      if (job.deploymentEpoch !== reference.deploymentEpoch || job.generation !== reference.generation || job.sourceRevision !== job.project.sourceRevision ||
        reference.inputHash !== await ingestExecutionInputHash(job, options.toolchainFingerprint)) throw new ExecutorControlError("authority_lost");
      const payload = job.payload;
      if (job.jobType !== "link_import" || !payload || Array.isArray(payload) || typeof payload !== "object" || payload.provider !== "youtube") throw new ExecutorControlError("invalid_reference");
      const mediaId = ingestYouTubeMediaId(payload.url);
      const audio = await options.database.sourceAudio.findUnique({ where: { projectId_sourceRevision: { projectId: job.projectId, sourceRevision: job.sourceRevision } } });
      const existingSourceAudio = audio ? sourceAudioBindingSchema.parse({ sourceAudioId: audio.id, projectId: audio.projectId, sourceRevision: audio.sourceRevision,
        mediaIdentity: { provider: audio.mediaProvider, mediaId: audio.mediaId }, audioTrack: audio.audioTrack,
        object: { key: audio.storageKey, etag: audio.etag, byteLength: Number(audio.byteLength), sha256: audio.checksumSha256 }, durationSeconds: audio.durationSeconds,
        wholeSource: true, audioStartTimeSec: audio.audioStartTimeSec, probeVersion: audio.probeVersion, toolchainFingerprint: audio.toolchainFingerprint }) : null;
      if (existingSourceAudio && (existingSourceAudio.mediaIdentity.provider !== "youtube" || existingSourceAudio.mediaIdentity.mediaId !== mediaId ||
        existingSourceAudio.toolchainFingerprint !== options.toolchainFingerprint || existingSourceAudio.probeVersion !== "normalized-probe-v1")) throw new ExecutorControlError("authority_lost");
      const optionalProbe = await probe.descriptorForIngest(authority.fence);
      const command = ingestFetchSourceCommandSchema.parse({ kind: "youtube_source", projectId: job.projectId, sourceRevision: job.sourceRevision,
        mediaId, sourceAudioId: existingSourceAudio?.sourceAudioId ?? attemptToken, toolchainFingerprint: options.toolchainFingerprint,
        probeVersion: "normalized-probe-v1", existingSourceAudio, languageProbe: optionalProbe?.input ?? null });
      const output = async (role: "source_audio" | "source_video", contentType: string, maxBytes: number) => ({ role, contentType, maxBytes,
        bindingHash: await digest(JSON.stringify(["ingest_assigned_v1", reference.inputHash, role])) });
      return { input: { kind: "inline", command },
        sources: optionalProbe && existingSourceAudio ? [{ name: "source_audio", storageKey: existingSourceAudio.object.key, etag: existingSourceAudio.object.etag,
          byteLength: existingSourceAudio.object.byteLength, sha256: existingSourceAudio.object.sha256 }] : [],
        outputs: [await output("source_video", "video/mp4", 10 * 1024 ** 3), ...(!existingSourceAudio ? [await output("source_audio", "audio/mp4", 2 * 1024 ** 3)] : []), ...(optionalProbe ? [optionalProbe.output] : [])] };
    },
  });
  return { control, transfer };
}

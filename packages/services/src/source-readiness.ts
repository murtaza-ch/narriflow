import { sourceExceedsLimit } from "@narriflow/validators";
import { sourceAudioBindingSchema, sourceVideoBindingSchema, type SourceAudioBinding, type SourceVideoBinding } from "@narriflow/validators/execution";

/** Whole-source identity is strict. Usage debits one fact, so duration only has to agree within tolerance. */
export function sourceAudioMatchesVideo(audioInput: SourceAudioBinding, videoInput: SourceVideoBinding, maxSourceSeconds: number): boolean {
  const audio = sourceAudioBindingSchema.parse(audioInput), video = sourceVideoBindingSchema.parse(videoInput);
  if (!Number.isFinite(maxSourceSeconds) || maxSourceSeconds <= 0) throw new Error("source_plan_limit_invalid");
  if (audio.projectId !== video.projectId || audio.sourceRevision !== video.sourceRevision ||
    audio.mediaIdentity.provider !== video.mediaIdentity.provider || audio.mediaIdentity.mediaId !== video.mediaIdentity.mediaId ||
    !video.audioTrack || JSON.stringify(audio.audioTrack) !== JSON.stringify(video.audioTrack) ||
    audio.probeVersion !== video.probeVersion || audio.toolchainFingerprint !== video.toolchainFingerprint ||
    sourceExceedsLimit(audio.durationSeconds, maxSourceSeconds) || sourceExceedsLimit(video.probe.durationSec, maxSourceSeconds)) return false;
  const rate = video.probe.video?.frameRate;
  const tolerance = Math.max(1, rate ? 2 * rate.denominator / rate.numerator : 1);
  if (Math.abs(audio.durationSeconds - video.probe.durationSec) > tolerance || video.audioStartTimeSec === null ||
    Math.abs(audio.audioStartTimeSec - video.audioStartTimeSec) > tolerance) return false;
  const audioFacts = video.probe.facts.audios[0];
  if (!audioFacts || audioFacts.codec !== video.audioTrack.codec || audioFacts.sampleRate !== video.audioTrack.sampleRate ||
    audioFacts.channels !== video.audioTrack.channels || video.audioStartTimeSec !== (audioFacts.startTimeSec ?? 0)) return false;
  const videoFacts = video.probe.facts.videos[0];
  if (video.probe.video && (!videoFacts || video.videoStartTimeSec !== (videoFacts.startTimeSec ?? 0))) return false;
  return true;
}

/** Measured binding digest includes all normalized probe facts. */
export async function sourceVideoBindingHash(input: SourceVideoBinding): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(sourceVideoBindingSchema.parse(input)));
  return await sha256Hex(bytes);
}

import type { Prisma, SourceAudio } from "@prisma/client";
import { planLimits, resolvePricingTier } from "@narriflow/validators";
import type { ProcessingUsage } from "./processing-usage";
import { sha256Hex } from "./execution-hash";

type VideoValidationInput = {
  ref: { projectId: string; sourceRevision: number; attemptToken: string };
  artifact: { artifactId: string; binding: SourceVideoBinding };
  sourceAudio: SourceAudio | null;
};

/** Called only under the lifecycle's Workspace usage then Project locks. */
export function createSourceVideoValidator(usage: Pick<ProcessingUsage, "release">) {
  return async (tx: Prisma.TransactionClient, input: VideoValidationInput): Promise<
    { kind: "accepted" | "waiting_for_audio" } | { kind: "rejected"; failureCode: "source_audio_video_mismatch" }
  > => {
    const video = sourceVideoBindingSchema.parse(input.artifact.binding);
    if (video.projectId !== input.ref.projectId || video.sourceRevision !== input.ref.sourceRevision) throw new Error("source_revision_superseded");
    if (!input.sourceAudio) {
      if (Boolean(video.probe.audio) !== Boolean(video.probe.facts.audios.length) || Boolean(video.probe.video) !== Boolean(video.probe.facts.videos.length)) {
        return { kind: "rejected", failureCode: "source_audio_video_mismatch" };
      }
      const assigned = await tx.executionArtifact.findUniqueOrThrow({ where: { id: input.artifact.artifactId }, select: { attemptToken: true, owner: true } });
      if (assigned.attemptToken !== input.ref.attemptToken) throw new Error("source_revision_superseded");
      const required = video.probe.audio !== null && await tx.executionArtifact.findFirst({ where: {
        attemptToken: input.ref.attemptToken, owner: assigned.owner, role: "source_audio",
      }, select: { id: true } });
      // The frozen speech plan decides whether audio is required. Supplied,
      // declined and no-audio plans retain their whole-source video path.
      return { kind: required ? "waiting_for_audio" : "accepted" };
    }
    const row = input.sourceAudio;
    const audio = sourceAudioBindingSchema.parse({ sourceAudioId: row.id, projectId: row.projectId, sourceRevision: row.sourceRevision,
      mediaIdentity: { provider: row.mediaProvider, mediaId: row.mediaId }, audioTrack: row.audioTrack,
      object: { key: row.storageKey, etag: row.etag, byteLength: Number(row.byteLength), sha256: row.checksumSha256 },
      durationSeconds: row.durationSeconds, wholeSource: true, audioStartTimeSec: row.audioStartTimeSec,
      probeVersion: row.probeVersion, toolchainFingerprint: row.toolchainFingerprint });
    const project = await tx.project.findUniqueOrThrow({ where: { id: input.ref.projectId }, select: { sourceRevision: true, workspace: { select: { pricingTier: true } } } });
    if (project.sourceRevision !== input.ref.sourceRevision) throw new Error("source_revision_superseded");
    const maxSeconds = planLimits(resolvePricingTier(project.workspace.pricingTier)).maxSourceSeconds;
    if (sourceAudioMatchesVideo(audio, video, maxSeconds)) return { kind: "accepted" };
    const reservation = await tx.processingUsageReservation.findUnique({ where: { projectId: input.ref.projectId }, select: { state: true } });
    await usage.release(tx, { projectId: input.ref.projectId, reason: "source_audio_video_mismatch" });
    if (reservation?.state === "settled") await tx.sourceRefundNeed.upsert({
      where: { projectId_sourceRevision: { projectId: input.ref.projectId, sourceRevision: input.ref.sourceRevision } },
      create: { projectId: input.ref.projectId, sourceRevision: input.ref.sourceRevision, sourceAudioId: row.id,
        sourceAudioBindingHash: row.bindingHash, videoBindingHash: await sourceVideoBindingHash(video) }, update: {},
    });
    return { kind: "rejected", failureCode: "source_audio_video_mismatch" };
  };
}

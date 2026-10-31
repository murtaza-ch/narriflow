import { creditDebitSeconds } from "@narriflow/validators";
import { sourceAudioBindingSchema, sourceVideoBindingSchema, type SourceAudioBinding, type SourceVideoBinding } from "@narriflow/validators/execution";

/** Whole-source identity is strict. Probe tolerance cannot change admission or charging. */
export function sourceAudioMatchesVideo(audioInput: SourceAudioBinding, videoInput: SourceVideoBinding, maxSourceSeconds: number): boolean {
  const audio = sourceAudioBindingSchema.parse(audioInput), video = sourceVideoBindingSchema.parse(videoInput);
  if (!Number.isFinite(maxSourceSeconds) || maxSourceSeconds <= 0) throw new Error("source_plan_limit_invalid");
  if (audio.projectId !== video.projectId || audio.sourceRevision !== video.sourceRevision ||
    audio.mediaIdentity.provider !== video.mediaIdentity.provider || audio.mediaIdentity.mediaId !== video.mediaIdentity.mediaId ||
    !video.audioTrack || JSON.stringify(audio.audioTrack) !== JSON.stringify(video.audioTrack) ||
    audio.probeVersion !== video.probeVersion || audio.toolchainFingerprint !== video.toolchainFingerprint ||
    audio.durationSeconds > maxSourceSeconds || video.probe.durationSec > maxSourceSeconds ||
    creditDebitSeconds(audio.durationSeconds) !== creditDebitSeconds(video.probe.durationSec)) return false;
  const rate = video.probe.video?.frameRate;
  const tolerance = Math.max(1, rate ? 2 * rate.denominator / rate.numerator : 1);
  if (Math.abs(audio.durationSeconds - video.probe.durationSec) > tolerance || video.audioStartTimeSec === null ||
    Math.abs(audio.audioStartTimeSec - video.audioStartTimeSec) > tolerance) return false;
  if (video.probe.video && (video.videoStartTimeSec === null || Math.abs(video.audioStartTimeSec - video.videoStartTimeSec) > tolerance)) return false;
  return true;
}

/** Measured binding digest includes all normalized probe facts. */
export async function sourceVideoBindingHash(input: SourceVideoBinding): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(sourceVideoBindingSchema.parse(input)));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
}

import type { Prisma, SourceAudio } from "@prisma/client";
import { planLimits, resolvePricingTier } from "@narriflow/validators";
import type { ProcessingUsage } from "./processing-usage";

type VideoValidationInput = {
  ref: { projectId: string; sourceRevision: number };
  artifact: { binding: SourceVideoBinding };
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
      // Uploaded, RSS and direct-media originals can supply their own whole-source
      // probe. A separately downloaded YouTube video needs the bound audio first.
      return { kind: video.mediaIdentity.provider === "youtube" ? "waiting_for_audio" : "accepted" };
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

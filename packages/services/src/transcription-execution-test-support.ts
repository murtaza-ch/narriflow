import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { appendExecutionDispatch } from "./execution-dispatch";
import { createTranscriptionAdmission } from "./transcription-admission";
import { WorkflowFailure, WorkflowRunLifecycle } from "./workflow-run-lifecycle";

/** Controlled committed source bytes, followed by the real provider admission
 * and finalizer. No provider HTTP is sent and no old polling claim is rebuilt. */
export async function ensureTranscriptionTestSource(database: PrismaClient, projectId: string) {
  const project = await database.project.findUniqueOrThrow({ where: { id: projectId } });
  const durationSeconds = project.sourceDurationSeconds ?? 60;
  const epoch = (await database.executionEpoch.findUniqueOrThrow({ where: { id: 1 } })).epoch;
  await database.project.update({ where: { id: project.id }, data: { ingestStatus: "ready", sourceDurationSeconds: durationSeconds,
    sourceProbe: { durationSec: durationSeconds, video: null, audio: { sampleRate: 48000, channels: 2 } } } });
  let audio = await database.sourceAudio.findUnique({ where: { projectId_sourceRevision: { projectId: project.id, sourceRevision: project.sourceRevision } } });
  if (!audio) {
    const source = await database.ingestJob.create({ data: { projectId: project.id, deploymentEpoch: epoch, jobType: "upload_finalize", payload: {}, status: "completed" } });
    const sourceToken = randomUUID(), sourceOwner = randomUUID(), storageKey = `execution/${epoch}/${sourceToken}/${sourceOwner}/source.m4a`;
    const sourceDispatch = await database.$transaction(tx => appendExecutionDispatch(tx, { kind: "modal_execution", subject: { kind: "ingest_job", id: source.id },
      generation: 1, deploymentEpoch: epoch, inputHash: "a".repeat(64), dueAt: source.createdAt }));
    await database.executionAttempt.create({ data: { attemptToken: sourceToken, dispatchId: sourceDispatch.reference.dispatchId, deploymentEpoch: epoch,
      generation: 1, inputHash: sourceDispatch.reference.inputHash, functionName: "fetch_source", owner: sourceOwner, status: "completed",
      leaseExpiresAt: new Date(Date.now() + 120_000), operationDeadlineAt: new Date(Date.now() + 45 * 60_000), processStartedAt: new Date(), finishedAt: new Date() } });
    await database.executionArtifact.create({ data: { attemptToken: sourceToken, owner: sourceOwner, role: "source_audio", storageKey,
      bindingHash: "b".repeat(64), contentType: "audio/mp4", maxBytes: 4096n, byteLength: 1024n, etag: '"audio"', checksumSha256: "c".repeat(64), grantExpiresAt: new Date(Date.now() + 60_000), committedAt: new Date() } });
    audio = await database.sourceAudio.create({ data: { projectId: project.id, sourceRevision: project.sourceRevision, mediaProvider: "upload", mediaId: project.id,
      audioTrack: { id: "0", codec: "aac", sampleRate: 48000, channels: 2 }, bindingHash: "d".repeat(64), storageKey, etag: '"audio"', byteLength: 1024n,
      checksumSha256: "c".repeat(64), durationSeconds, audioStartTimeSec: 0, probeVersion: "normalized-probe-1", toolchainFingerprint: "e".repeat(64) } });
  }
  return { audio, project, durationSeconds };
}

export async function beginTranscriptionTestExecution(database: PrismaClient, runId: string, workflow = new WorkflowRunLifecycle({ prisma: database })) {
  const run = await database.workflowRun.findUniqueOrThrow({ where: { id: runId } });
  const { audio, project, durationSeconds } = await ensureTranscriptionTestSource(database, run.projectId);
  await database.transcript.upsert({ where: { projectId: project.id }, update: { sourceAudioId: audio.id },
    create: { projectId: project.id, sourceRevision: project.sourceRevision, sourceAudioId: audio.id } });
  const reference = (await database.$transaction(tx => workflow.dispatchRunWithinTransaction(tx, run.id))).reference;
  const admitted = await createTranscriptionAdmission({ database, workflow, maxUnits: 12 }).admit(reference, { owner: randomUUID() });
  if (admitted.kind !== "begun" && admitted.kind !== "completed") throw Error(`Expected fixture transcription admission, got ${admitted.kind}`);
  const attempt = admitted.kind === "begun" ? admitted.intent.reference : null;
  return { workflow, reference,
    fail: (failure: WorkflowFailure) => { if (!attempt) throw Error("No provider work for supplied captions"); return workflow.failProviderAttempt(attempt, failure); },
    complete: () => attempt ? workflow.completeProviderTranscript(attempt, { provider: "elevenlabs", providerModel: "scribe_v2", providerJobId: `fixture-${run.id}`, providerRequestId: `fixture-${run.id}`,
      languageCode: "en", languageConfidence: 1, text: "Frozen fixture transcript", speakerCount: 1, durationSeconds, rawStorageKey: null,
      utterances: Array.from({ length: Math.ceil(durationSeconds) }, (_, index) => ({ index, speaker: 0, speakerLabel: "Speaker 1", startSec: index, endSec: Math.min(index + 1, durationSeconds),
        text: `Story ${index}.`, confidence: null, words: [{ word: `Story${index}.`, startSec: index, endSec: Math.min(index + 1, durationSeconds), confidence: null }] })) }) : Promise.resolve(admitted),
  };
}

/** Test-only external media boundaries. Ownership, process charging, sealed
 * preparation and publication all use the current production Core/services. */
import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { ExecutionCommand, ExecutionDispatchReference } from "@narriflow/validators/execution";
import type { ClipPreparationResult } from "@narriflow/validators/clip-preparation";
import { appendExecutionDispatch, readExecutionDispatch } from "./execution-dispatch";
import { createExecutorControl } from "./executor-control";
import { IngestJobLifecycle } from "./ingest-job-lifecycle";
import { ingestExecutionInputHash } from "./ingest-source-execution";
import { ProcessingUsage } from "./processing-usage";
import { WorkflowRunLifecycle } from "./workflow-run-lifecycle";
import { ClipPreparationService, type ClipPreparationArtifactCommit } from "./clip-preparation";
import { decodeClipPreparationInput } from "./clip-preparation-input";
import { clipPreparationEngineHash, clipPreparationPreviewWindow } from "./clip-preparation-policy";
import { RenderGroupExecutionService, createRenderGroupExecution } from "./render-group-execution";
import { createRenderInputSnapshot } from "./render-input-snapshot";
import { createExecutionStorage } from "./execution-storage";
import { renderArtifactBindingHash, encodeRenderVariantFailure } from "./render-artifact";
import type { ClaimedRenderGroupAttempt } from "./render-group-contract";

const fingerprint = "e".repeat(64);
const bytes = new Uint8Array(1024).fill(1);
const sha256 = createHash("sha256").update(bytes).digest("hex");
export function fixtureExecutionRequest() {
  return { requestHash: randomUUID().replaceAll("-", "").repeat(2), metadata: { version: 1 as const, keyId: "render-fixture", audience: "executor-control" as const,
    method: "POST" as const, canonicalTarget: "/api/execution/command", bodySha256: "0".repeat(64), timestamp: Math.floor(Date.now() / 1000), deliveryId: randomUUID(), signature: "0".repeat(64) } };
}
const storageByClient = new WeakMap<PrismaClient, Map<string, Uint8Array>>();
function objectStorage(db: PrismaClient) {
  let objects = storageByClient.get(db);
  if (!objects) { objects = new Map(); storageByClient.set(db, objects); }
  return {
    async write(key: string, value: Uint8Array) {
      const prior = objects!.get(key);
      if (prior && !Buffer.from(prior).equals(value)) throw Error("Changed immutable fixture object");
      objects!.set(key, value.slice());
      return { etag: '"fixture-input"', byteLength: value.byteLength, sha256: createHash("sha256").update(value).digest("hex") };
    },
    async read(reference: { storageKey: string; etag: string; byteLength: number; sha256: string }) {
      const value = objects!.get(reference.storageKey);
      if (!value || reference.etag !== '"fixture-input"' || value.byteLength !== reference.byteLength || createHash("sha256").update(value).digest("hex") !== reference.sha256) throw Error("Changed immutable fixture object");
      return value.slice();
    },
  };
}
async function confirmed(db: PrismaClient, ids: readonly string[]) {
  if (await db.executionDispatch.count({ where: { id: { in: [...ids] } } }) !== ids.length) throw Error("Fixture wake was not committed");
}

/** A controlled ffprobe/HEAD boundary supplies fixed source facts. The
 * existing source lifecycle, not fixture SQL, creates every execution charge. */
const sourcePreparations = new WeakMap<PrismaClient, Map<string, Promise<void>>>();
export async function prepareFixtureSource(db: PrismaClient, projectId: string) {
  let pending = sourcePreparations.get(db);
  if (!pending) { pending = new Map(); sourcePreparations.set(db, pending); }
  let operation = pending.get(projectId);
  if (!operation) { operation = prepareSource(db, projectId).finally(() => pending!.delete(projectId)); pending.set(projectId, operation); }
  await operation;
}
async function prepareSource(db: PrismaClient, projectId: string) {
  const project = await db.project.findUniqueOrThrow({ where: { id: projectId } });
  if (project.sourceStorageKey && await db.executionArtifact.findFirst({ where: { storageKey: project.sourceStorageKey, role: "source_video", committedAt: { not: null } } })) return;
  const end = await db.clip.aggregate({ where: { projectId }, _max: { endSec: true } });
  const duration = project.sourceDurationSeconds ?? Math.max(20, end._max.endSec ?? 20);
  const probe = { durationSec: duration, video: null, audio: { sampleRate: 48000, channels: 2 }, facts: {
    format: { name: "matroska", startTimeSec: 0, durationSec: duration, sizeBytes: bytes.byteLength, bitRate: null }, attachedPictureCount: 0, videos: [],
    audios: [{ index: 0, codec: "opus", profile: null, timeBase: null, startPts: null, startTimeSec: 0, durationTs: null, durationSec: duration, endTimeSec: duration,
      frameCount: null, bitRate: null, sampleRate: 48000, channels: 2, channelLayout: "stereo", sampleFormat: "fltp", initialPadding: null, trailingPadding: null }],
  } };
  const epoch = (await db.executionEpoch.findUniqueOrThrow({ where: { id: 1 } })).epoch;
  const job = await db.ingestJob.create({ data: { projectId, deploymentEpoch: epoch, jobType: "upload_finalize", payload: { acquisition: { audioPolicy: "none" }, uploadSessionId: randomUUID(), storageKey: `projects/${projectId}/source/original.webm`,
    verifiedEtag: '"fixture-source"', verifiedSizeBytes: bytes.byteLength, verifiedContentType: "video/webm" } } });
  const workflow = new WorkflowRunLifecycle({ prisma: db });
  const domain = new IngestJobLifecycle({ prisma: db, workflow, usage: new ProcessingUsage({ prisma: db, log: () => {} }),
    executionInputHash: input => ingestExecutionInputHash(input, fingerprint), validateVideo: async () => ({ kind: "accepted" }), requireRetryActor: async () => { throw Error("No retry admission in source fixture"); } });
  const reference = (await db.$transaction(async tx => appendExecutionDispatch(tx, { kind: "modal_execution", subject: { kind: "ingest_job", id: job.id }, generation: job.generation,
    deploymentEpoch: epoch, inputHash: await ingestExecutionInputHash(job, fingerprint), dueAt: job.createdAt }))).reference;
  const token = randomUUID(), owner = randomUUID();
  await db.executionAttempt.create({ data: { attemptToken: token, dispatchId: reference.dispatchId, deploymentEpoch: epoch, generation: job.generation, inputHash: reference.inputHash,
    functionName: "pin_source", operationDeadlineAt: new Date(Date.now() + 45 * 60000) } });
  const control = createExecutorControl({ database: db, domain, subjectKind: "ingest_job", deliverWakes: ids => confirmed(db, ids), artifacts: {
    head: async () => ({ etag: '"fixture-source"', contentType: "video/webm", byteLength: BigInt(bytes.byteLength), sha256 }),
    prepare: async (_assignment, artifact, reported) => {
      if (reported.role !== "source_video" || !reported.sourceVideo) throw Error("Unexpected fixture source role");
      return { ...artifact, role: "source_video", binding: reported.sourceVideo };
    },
  } });
  const fence = { reference, attemptToken: token, owner };
  const send = (command: ExecutionCommand) => control.execute({ command, verifiedRequest: fixtureExecutionRequest() });
  await send({ action: "acquire", ...fence, leaseSeconds: 120 });
  await send({ action: "process-start", fence });
  const artifact = await db.executionArtifact.create({ data: { attemptToken: token, owner, role: "source_video", storageKey: `execution/${epoch}/${token}/${owner}/${randomUUID()}.webm`,
    bindingHash: reference.inputHash, contentType: "video/webm", maxBytes: BigInt(bytes.byteLength), grantExpiresAt: new Date(Date.now() + 60000) } });
  const result = await send({ action: "commit-artifact", fence, artifact: { artifactId: artifact.id, role: "source_video", bindingHash: artifact.bindingHash, contentType: artifact.contentType,
    byteLength: bytes.byteLength, etag: '"fixture-source"', sha256, sourceVideo: { projectId, sourceRevision: project.sourceRevision,
      mediaIdentity: { provider: "upload", mediaId: job.id }, audioTrack: null, probe, wholeSource: true, audioStartTimeSec: 0, videoStartTimeSec: null,
      probeVersion: "normalized-probe-1", toolchainFingerprint: fingerprint } } });
  if (result.disposition !== "committed") throw Error("Fixture source did not commit");
}

async function preparationForGroup(db: PrismaClient, reference: ExecutionDispatchReference) {
  const storage = objectStorage(db);
  const service = new ClipPreparationService(db, { toolchainFingerprint: fingerprint, engineHash: await clipPreparationEngineHash(fingerprint), storage, register: ids => confirmed(db, ids) });
  const admission = await service.admitForGroup(reference);
  if (admission.kind === "failed") throw Error("Fixture preparation failed");
  if (admission.kind === "ready") return { service, storage };
  const driver = await db.executionDispatch.findFirstOrThrow({ where: { subjectKind: "clip_preparation", subjectId: admission.preparationId, kind: "operation_driver", deadlineKind: null } });
  const prepared = await service.prepareExecution((await readExecutionDispatch(db, driver.id))!.reference);
  if (prepared.kind !== "waiting") throw Error("Fixture preparation was not admitted");
  const heads = new Map<string, { etag: string; contentType: string; byteLength: bigint; sha256: string }>();
  let manifest: ClipPreparationResult;
  const control = createExecutorControl({ database: db, subjectKind: "clip_preparation", domain: service, deliverWakes: ids => confirmed(db, ids), artifacts: {
    head: async assignment => heads.get(assignment.id) ?? null,
    prepare: async (_assignment, artifact): Promise<ClipPreparationArtifactCommit> => {
      if (artifact.role === "layout_evidence") return { ...artifact, role: "layout_evidence", result: manifest };
      if (artifact.role === "clip_preview" || artifact.role === "preview_peaks") return { ...artifact, role: artifact.role };
      throw Error("Unexpected preparation role");
    },
  } });
  const fence = { reference: prepared.deadline.reference, attemptToken: prepared.deadline.attemptToken, owner: randomUUID() };
  const send = (command: ExecutionCommand) => control.execute({ command, verifiedRequest: fixtureExecutionRequest() });
  await send({ action: "acquire", ...fence, leaseSeconds: 120 }); await send({ action: "process-start", fence });
  const assignments = [];
  const prefix = `execution/${reference.deploymentEpoch}/${fence.attemptToken}/${fence.owner}/${randomUUID()}`;
  for (const role of ["clip_preview", "preview_peaks", "layout_evidence"] as const) {
    const contentType = role === "clip_preview" ? "video/mp4" : "application/json";
    const artifact = await db.executionArtifact.create({ data: { attemptToken: fence.attemptToken, owner: fence.owner, role, bindingHash: admission.bindingHash,
      storageKey: `${prefix}${role === "clip_preview" ? ".mp4" : role === "preview_peaks" ? ".peaks.json" : ".layout.json"}`, contentType, maxBytes: 10000n, grantExpiresAt: new Date(Date.now() + 60000) } });
    assignments.push(artifact); heads.set(artifact.id, { etag: `"${artifact.id}"`, contentType, byteLength: BigInt(bytes.byteLength), sha256 });
  }
  const row = await db.clipPreparation.findUniqueOrThrow({ where: { id: admission.preparationId } });
  const object = { storageKey: row.inputStorageKey, etag: row.inputEtag, byteLength: Number(row.inputByteLength), sha256: row.inputChecksumSha256 };
  const input = await decodeClipPreparationInput(await storage.read(object), object), window = clipPreparationPreviewWindow(input);
  manifest = { version: 1, preparationId: row.id, bindingHash: admission.bindingHash, preview: { artifactId: assignments[0]!.id, startSec: window.startSec, durationSec: window.durationSec },
    peaks: { state: "ready", artifactId: assignments[1]!.id }, layout: { automatic: { state: "failed", reason: "analysis_unavailable" }, screen: null, split: null } };
  for (const artifact of assignments) {
    const result = await send({ action: "commit-artifact", fence, artifact: { artifactId: artifact.id, role: artifact.role as "clip_preview" | "preview_peaks" | "layout_evidence",
      bindingHash: artifact.bindingHash, contentType: artifact.contentType, byteLength: bytes.byteLength, etag: heads.get(artifact.id)!.etag, sha256 } });
    if (result.disposition !== "committed") throw Error("Fixture preparation artifact did not commit");
  }
  return { service, storage };
}

export async function acquireFixtureRenderGroup(db: PrismaClient, reference: ExecutionDispatchReference, options: { start?: boolean } = {}) {
  const group = await db.renderGroup.findUniqueOrThrow({ where: { id: reference.subject.id }, include: { workflowRun: true } });
  await prepareFixtureSource(db, group.workflowRun.projectId);
  const preparation = await preparationForGroup(db, reference);
  const service = new RenderGroupExecutionService(db, { toolchainFingerprint: fingerprint, preparation: preparation.service, inputStorage: preparation.storage,
    snapshot: createRenderInputSnapshot(db, { object: async () => null, pexelsConfigured: false, searchStock: async () => { throw Error("No stock search in fixture"); } }), register: ids => confirmed(db, ids) });
  const prepared = await service.prepareExecution(reference);
  if (prepared.kind !== "waiting") throw Error(`Fixture render not admitted: ${prepared.kind}`);
  const heads = new Map<string, { etag: string; contentType: string; byteLength: bigint; sha256: string }>();
  const outcomes = new Map<string, unknown>();
  let loseWakeAck = false;
  const completionReceipts = new Map<string, ReturnType<typeof fixtureExecutionRequest>>();
  const execution = createRenderGroupExecution({ database: db, service, storage: createExecutionStorage({ accountId: "a".repeat(32), bucket: "render-fixture", accessKeyId: "fixture", secretAccessKey: "fixture" }),
    artifacts: { head: async assignment => heads.get(assignment.id) ?? null, readJson: async artifact => outcomes.get(artifact.storageKey) }, deliverWakes: async ids => { if (loseWakeAck) { loseWakeAck = false; throw Error("fixture_render_wake_ack_lost"); } await confirmed(db, ids); } });
  const fence = { reference: prepared.deadline.reference, attemptToken: prepared.deadline.attemptToken, owner: randomUUID() };
  const send = (command: ExecutionCommand, verifiedRequest = fixtureExecutionRequest()) => execution.control.execute({ command, verifiedRequest });
  if ((await send({ action: "acquire", ...fence, leaseSeconds: 120 })).disposition !== "acquired") throw Error("Fixture render not acquired");
  const packageResult = await execution.transfer.execute({ command: { action: "work-package", fence }, verifiedRequest: fixtureExecutionRequest() });
  if (packageResult.disposition !== "work_package") throw Error("Fixture work package unavailable");
  const outputs = packageResult.outputs;
  if (options.start !== false && (await send({ action: "process-start", fence })).disposition !== "started") throw Error("Fixture render not started");
  const input = await service.loadInput(await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: fence.attemptToken } }));
  const current = await db.renderGroup.findUniqueOrThrow({ where: { id: group.id } });
  const attempt: ClaimedRenderGroupAttempt = { workflowRunId: group.workflowRunId, workSetGeneration: group.workSetGeneration, groupId: group.id,
    token: fence.attemptToken, owner: fence.owner, projectId: group.workflowRun.projectId, clipId: group.clipId, exportIdentity: group.exportIdentity,
    chargedAttemptCount: current.chargedAttemptCount, leaseExpiresAt: current.leaseExpiresAt!, memberIds: input.variants.map(variant => variant.renderId) };
  async function output(renderId: string, role: "render_variant" | "render_outcome") {
    const hash = await renderArtifactBindingHash({ inputHash: fence.reference.inputHash, renderId, role });
    const assigned = outputs.find(item => item.role === role && item.bindingHash === hash);
    if (!assigned) throw Error("Render output not assigned");
    return db.executionArtifact.findUniqueOrThrow({ where: { id: assigned.artifactId } });
  }
  return { attempt, fence, control: execution.control, transfer: execution.transfer, send,
    loseNextWakeAcknowledgement() { loseWakeAck = true; },
    async expire() {
      const lease = new Date(0);
      await db.$transaction(async tx => {
        await tx.renderGroup.update({ where: { id: group.id }, data: { leaseExpiresAt: lease } });
        await tx.executionAttempt.update({ where: { attemptToken: fence.attemptToken }, data: { leaseExpiresAt: lease } });
      });
      return execution.control.expireDeadline({ deadline: { reference: fence.reference, attemptToken: fence.attemptToken, kind: "lease", observedDeadlineAt: lease.toISOString() }, deliveryId: randomUUID() });
    },
    async complete(renderId: string, details: { sizeBytes: number; durationSec: number; captionDiagnostics?: { omittedCodePoints: string[]; skippedEmoji: string[] } | null }) {
      const artifact = await output(renderId, "render_variant");
      heads.set(artifact.id, { etag: `"${artifact.id}"`, contentType: artifact.contentType, byteLength: BigInt(details.sizeBytes), sha256 });
      const command: ExecutionCommand = { action: "commit-artifact", fence, artifact: { artifactId: artifact.id, role: "render_variant", bindingHash: artifact.bindingHash,
        contentType: artifact.contentType, byteLength: details.sizeBytes, etag: heads.get(artifact.id)!.etag, sha256, renderVariant: { renderId, durationSec: details.durationSec, usedStockIds: [], ...(details.captionDiagnostics ? { captionDiagnostics: details.captionDiagnostics } : {}) } } };
      const key = JSON.stringify(command);
      let receipt = completionReceipts.get(key);
      if (!receipt) { receipt = fixtureExecutionRequest(); receipt.requestHash = createHash("sha256").update(key).digest("hex"); completionReceipts.set(key, receipt); }
      const reply = await send(command, receipt);
      if (reply.disposition !== "committed") throw Error("Fixture render did not commit");
      return true;
    },
    async fail(renderId: string, errorCode: string, disposition: "retryable" | "permanent") {
      const artifact = await output(renderId, "render_outcome"), encoded = await encodeRenderVariantFailure({ version: 1, kind: "failed", renderId, bindingHash: artifact.bindingHash, errorCode, disposition });
      outcomes.set(artifact.storageKey, encoded.failure);
      heads.set(artifact.id, { etag: `"${artifact.id}"`, contentType: artifact.contentType, byteLength: BigInt(encoded.byteLength), sha256: encoded.sha256 });
      const reply = await send({ action: "commit-artifact", fence, artifact: { artifactId: artifact.id, role: "render_outcome", bindingHash: artifact.bindingHash,
        contentType: artifact.contentType, byteLength: encoded.byteLength, etag: heads.get(artifact.id)!.etag, sha256: encoded.sha256 } });
      if (reply.disposition !== "committed") throw Error("Fixture failure did not commit");
      return true;
    },
  };
}

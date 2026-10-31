import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { ingestNativeSourceCommandSchema, type SourceVideoBinding } from "@narriflow/validators/execution";
import type { IngestJobLifecycle } from "./ingest-job-lifecycle";
import type { WorkflowRunLifecycle } from "./workflow-run-lifecycle";
import { createIngestSourceExecution, prepareIngestSourceExecution } from "./ingest-source-execution";
import { createExecutionStorage } from "./execution-storage";

/** Real source admission, work-package assignment and executor control. Only
 * external storage HEAD and scheduler delivery are controlled in this fixture. */
export async function startIngestTestExecution(database: PrismaClient, domain: IngestJobLifecycle, workflow: WorkflowRunLifecycle, jobId: string) {
  const toolchainFingerprint = "f".repeat(64);
  const reference = await database.$transaction(tx => domain.queueExecutionWithinTransaction(tx, jobId));
  if (!reference) throw Error("Missing source admission");
  const prepared = await prepareIngestSourceExecution({ database, domain, reference, toolchainFingerprint, executionKind: "modal_execution" });
  if (prepared.kind !== "waiting") throw Error("Missing source preparation");
  const { reference: nativeReference, attemptToken } = prepared.deadline;
  const fence = { reference: nativeReference, attemptToken, owner: randomUUID() };
  let byteLength = 42;
  const runtime = createIngestSourceExecution({ database, domain, workflow, toolchainFingerprint,
    storage: createExecutionStorage({ accountId: "a".repeat(32), bucket: "ingest-test", accessKeyId: "fixture", secretAccessKey: "fixture" }),
    sourceReads: { openDriveCredential: async () => "fixture-drive-token" },
    artifacts: { head: async assignment => ({ etag: '"fixture"', byteLength: BigInt(byteLength), contentType: assignment.contentType, sha256: "c".repeat(64) }) },
    deliverWakes: async () => {},
  });
  const verified = () => ({ requestHash: randomUUID().replaceAll("-", "").repeat(2), metadata: {
    version: 1 as const, keyId: "fixture", audience: "executor-control" as const, method: "POST" as const,
    canonicalTarget: "/api/execution/command", bodySha256: "0".repeat(64), timestamp: Math.floor(Date.now() / 1000), deliveryId: randomUUID(), signature: "0".repeat(64),
  } });
  const execute = (command: unknown) => runtime.control.execute({ command, verifiedRequest: verified() });
  const acquired = await execute({ action: "acquire", ...fence, leaseSeconds: 120 });
  if (acquired.disposition !== "acquired") throw Error(`Source acquisition ${acquired.disposition}`);
  const work = await runtime.transfer.execute({ command: { action: "work-package", fence }, verifiedRequest: verified() });
  if (work.disposition !== "work_package" || work.input.kind !== "inline") throw Error("Missing source package");
  const command = ingestNativeSourceCommandSchema.parse(work.input.command);
  if (!("mediaIdentity" in command)) throw Error("Source package refused");
  const mediaIdentity = command.mediaIdentity;
  const sourceVideo = work.outputs.find(output => output.role === "source_video");
  if (!sourceVideo) throw Error("Missing source destination");
  const assignment = await database.executionArtifact.findUniqueOrThrow({ where: { id: sourceVideo.artifactId } });
  await execute({ action: "process-start", fence });
  return { ...runtime, fence, assignment,
    command: (action: string, fields: Record<string, unknown> = {}) => execute({ action, fence, ...fields }),
    async complete(durationSec = 12.5, bytes = 42) {
      byteLength = bytes;
      const binding: SourceVideoBinding = { projectId: (await database.ingestJob.findUniqueOrThrow({ where: { id: jobId } })).projectId,
        sourceRevision: 1, mediaIdentity, audioTrack: null, wholeSource: true, audioStartTimeSec: null, videoStartTimeSec: null,
        probeVersion: "normalized-probe-v1", toolchainFingerprint,
        probe: { durationSec, video: null, audio: null, facts: { format: { name: "fixture", durationSec, startTimeSec: 0, sizeBytes: bytes, bitRate: null }, attachedPictureCount: 0, videos: [], audios: [] } } };
      return execute({ action: "commit-artifact", fence, artifact: { artifactId: assignment.id, role: "source_video", bindingHash: assignment.bindingHash,
        contentType: assignment.contentType, byteLength: bytes, etag: '"fixture"', sha256: "c".repeat(64), sourceVideo: binding } });
    },
    async expire() {
      const lease = new Date(Date.now() - 1_000);
      await database.$transaction(async tx => {
        await tx.ingestJob.update({ where: { id: jobId }, data: { claimExpiresAt: lease } });
        await tx.executionAttempt.update({ where: { attemptToken }, data: { leaseExpiresAt: lease } });
      });
      return runtime.control.expireDeadline({ deadline: { reference: nativeReference, attemptToken, kind: "lease", observedDeadlineAt: lease.toISOString() }, deliveryId: randomUUID() });
    },
  };
}

import type { PrismaClient } from "@prisma/client";
import { MAX_RSS_RESULT_BYTES, rssFeedSnapshotSchema } from "@narriflow/validators/outbound-probe";
import { createExecutorControl, ExecutorControlError, type ExecutorArtifactHead } from "./executor-control";
import type { ExecutorArtifactCommit } from "./executor-domain-control";
import { createExecutionTransfer } from "./execution-transfer";
import type { createExecutionStorage } from "./execution-storage";
import type { OutboundProbeService } from "./outbound-probe";

export function createOutboundProbeExecution(options: {
  database: PrismaClient; domain: OutboundProbeService; storage: ReturnType<typeof createExecutionStorage>;
  artifacts: { head: (assignment: Readonly<import("@prisma/client").ExecutionArtifact>) => Promise<ExecutorArtifactHead | null>;
    readJson: (artifact: ExecutorArtifactCommit, maxBytes: number) => Promise<unknown> };
  deliverWakes(ids: readonly string[]): Promise<void>;
}) {
  const control = createExecutorControl({ database: options.database, subjectKind: "outbound_probe", domain: options.domain,
    artifacts: { head: options.artifacts.head, prepare: async (_assignment, artifact) => {
      if (artifact.role !== "outbound_receipt") throw new ExecutorControlError("artifact_invalid");
      rssFeedSnapshotSchema.parse(await options.artifacts.readJson(artifact, MAX_RSS_RESULT_BYTES));
      return artifact;
    } }, deliverWakes: options.deliverWakes });
  const transfer = createExecutionTransfer({ database: options.database, authority: control, storage: options.storage,
    resolvePackage: async authority => {
      const reference = authority.fence.reference;
      if (reference.subject.kind !== "outbound_probe" || reference.kind !== "modal_execution" || authority.functionName !== "outbound_delivery") throw new ExecutorControlError("invalid_reference");
      const work = await options.domain.workInput(reference.subject.id);
      if (work.inputHash !== reference.inputHash) throw new ExecutorControlError("authority_lost");
      return { input: { kind: "inline", command: work.command }, sources: [], outputs: work.outputs };
    } });
  return { control, transfer };
}

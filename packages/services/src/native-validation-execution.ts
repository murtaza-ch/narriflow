import type { PrismaClient } from "@prisma/client";
import type { ExecutorArtifactCommit } from "./executor-domain-control";
import { createExecutorControl, ExecutorControlError, type ExecutorArtifactHead } from "./executor-control";
import { createExecutionTransfer } from "./execution-transfer";
import type { createExecutionStorage } from "./execution-storage";
import type { NativeValidationService } from "./native-validation";
import { nativeValidationWorkInput, prepareNativeValidationArtifact } from "./native-validation-work";

/** One production composition for the same native font/visual domain ports
 * used by the HTTP control boundary and Workflow watchdog. */
export function createNativeValidationExecution(options: {
  database: PrismaClient;
  domain: NativeValidationService;
  storage: ReturnType<typeof createExecutionStorage>;
  artifacts: {
    head: (assignment: Readonly<import("@prisma/client").ExecutionArtifact>) => Promise<ExecutorArtifactHead | null>;
    readJson: (artifact: ExecutorArtifactCommit, maxBytes: number) => Promise<unknown>;
  };
  deliverWakes: (ids: readonly string[]) => Promise<void>;
}) {
  const control = createExecutorControl({ database: options.database, subjectKind: "native_validation", domain: options.domain,
    artifacts: { head: options.artifacts.head, prepare: (_assignment, artifact) =>
      prepareNativeValidationArtifact(artifact, (_key, maxBytes) => options.artifacts.readJson(artifact, maxBytes)) },
    deliverWakes: options.deliverWakes,
  });
  const transfer = createExecutionTransfer({ database: options.database, authority: control, storage: options.storage,
    resolvePackage: async authority => {
      const reference = authority.fence.reference;
      if (reference.subject.kind !== "native_validation" || reference.kind !== "modal_execution" || authority.functionName !== "asset_validation") throw new ExecutorControlError("invalid_reference");
      const work = await nativeValidationWorkInput(options.database, reference.subject.id);
      if (work.inputHash !== reference.inputHash) throw new ExecutorControlError("authority_lost");
      return { input: { kind: "inline", command: work.command },
        sources: [{ ...work.source, name: "asset_source", byteLength: Number(work.source.byteLength) }],
        outputs: work.outputs.map(output => ({ ...output, maxBytes: Number(output.maxBytes) })) };
    },
  });
  return { control, transfer };
}

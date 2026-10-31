import type { PrismaClient } from "@prisma/client";
import type { ExecutorArtifactCommit } from "./executor-domain-control";
import { createExecutorControl, ExecutorControlError, type ExecutorArtifactHead } from "./executor-control";
import { createExecutionTransfer } from "./execution-transfer";
import type { createExecutionStorage } from "./execution-storage";
import type { NativeValidationService } from "./native-validation";
import type { ThumbnailFrameExecution } from "./thumbnail-frame-execution";
import { nativeValidationWorkInput, prepareNativeValidationArtifact } from "./native-validation-work";

type Domain = { subjectKind?: "native_validation"; domain: NativeValidationService }
  | { subjectKind: "thumbnail_frame"; domain: ThumbnailFrameExecution };

/** One production composition for the native font/visual/thumbnail domain ports
 * used by the HTTP control boundary and Workflow watchdog. */
export function createNativeValidationExecution(options: Domain & {
  database: PrismaClient;
  storage: ReturnType<typeof createExecutionStorage>;
  artifacts: {
    head: (assignment: Readonly<import("@prisma/client").ExecutionArtifact>) => Promise<ExecutorArtifactHead | null>;
    readJson: (artifact: ExecutorArtifactCommit, maxBytes: number) => Promise<unknown>;
  };
  deliverWakes: (ids: readonly string[]) => Promise<void>;
}) {
  const subjectKind = options.subjectKind ?? "native_validation";
  const control = createExecutorControl({ database: options.database, subjectKind, domain: options.domain,
    artifacts: { head: options.artifacts.head, prepare: (_assignment, artifact) =>
      prepareNativeValidationArtifact(artifact, (_key, maxBytes) => options.artifacts.readJson(artifact, maxBytes)) },
    deliverWakes: options.deliverWakes,
  });
  const transfer = createExecutionTransfer({ database: options.database, authority: control, storage: options.storage,
    resolvePackage: async authority => {
      const reference = authority.fence.reference;
      if (reference.subject.kind !== subjectKind || reference.kind !== "modal_execution" || authority.functionName !== "asset_validation") throw new ExecutorControlError("invalid_reference");
      const work = options.subjectKind === "thumbnail_frame" ? await options.domain.workInput(reference.subject.id) : await nativeValidationWorkInput(options.database, reference.subject.id);
      if (work.inputHash !== reference.inputHash) throw new ExecutorControlError("authority_lost");
      return { input: { kind: "inline", command: work.command },
        sources: [{ ...work.source, name: "asset_source", byteLength: Number(work.source.byteLength) }],
        outputs: work.outputs.map(output => ({ ...output, maxBytes: Number(output.maxBytes) })) };
    },
  });
  return { control, transfer };
}

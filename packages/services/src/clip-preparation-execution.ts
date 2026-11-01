import type { ExecutionArtifact, PrismaClient } from "@prisma/client";
import { clipPreparationResultSchema } from "@narriflow/validators/clip-preparation";
import { createExecutorControl, ExecutorControlError, type ExecutorArtifactHead } from "./executor-control";
import { createExecutionTransfer } from "./execution-transfer";
import type { ExecutorArtifactCommit } from "./executor-domain-control";
import type { createExecutionStorage } from "./execution-storage";
import type { ClipPreparationArtifactCommit, ClipPreparationService } from "./clip-preparation";

/** The only manifest read is the already assigned, HEAD-verified JSON object.
 * Parsing completes outside transaction locks; domain publication rechecks all
 * immutable source/window/owner bindings in the same transaction. */
export function createClipPreparationExecution(options: {
  database: PrismaClient;
  domain: ClipPreparationService;
  storage: ReturnType<typeof createExecutionStorage>;
  artifacts: {
    head(assignment: Readonly<ExecutionArtifact>): Promise<ExecutorArtifactHead | null>;
    readJson(artifact: ExecutorArtifactCommit, maxBytes: number): Promise<unknown>;
  };
  deliverWakes(ids: readonly string[]): Promise<void>;
}) {
  const control = createExecutorControl({ database: options.database, subjectKind: "clip_preparation", domain: options.domain,
    artifacts: { head: options.artifacts.head, prepare: async (_assignment, artifact): Promise<ClipPreparationArtifactCommit> => {
      if (artifact.role === "clip_preview" || artifact.role === "preview_peaks") return { ...artifact, role: artifact.role };
      if (artifact.role !== "layout_evidence" || artifact.byteLength > 1024n ** 2n) throw new ExecutorControlError("artifact_invalid");
      const result = clipPreparationResultSchema.safeParse(await options.artifacts.readJson(artifact, 1024 ** 2));
      if (!result.success) throw new ExecutorControlError("artifact_invalid");
      return { ...artifact, role: "layout_evidence", result: result.data };
    } }, deliverWakes: options.deliverWakes,
  });
  const transfer = createExecutionTransfer({ database: options.database, authority: control, storage: options.storage,
    resolvePackageWithinAuthority: async (tx, authority, ref) => {
      if (authority.fence.reference.subject.kind !== "clip_preparation" || authority.fence.reference.kind !== "modal_execution" || authority.functionName !== "prepare_clip" || !authority.input) throw new ExecutorControlError("invalid_reference");
      const work = await options.domain.workInputWithinAuthority(tx, authority, ref);
      if (work.inputHash !== authority.fence.reference.inputHash) throw new ExecutorControlError("authority_lost");
      return { input: { kind: "object" }, sources: [{ ...work.source, name: "original" }], outputs: work.outputs };
    },
  });
  return { control, transfer };
}

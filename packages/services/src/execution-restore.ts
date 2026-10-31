import type { PrismaClient } from "@prisma/client";
import { appendExecutionDispatch } from "./execution-dispatch";
import { readExecutionAdmission } from "./execution-admission";

export class ExecutionRestoreError extends Error {
  constructor(readonly code: "restore_epoch_changed" | "restore_reference_invalid" | "restore_phase_unavailable") { super(code); }
}
export const EXECUTION_RESTORE_PHASES = ["attempts", "ingest", "workflows", "render_groups", "selection", "preparation", "native_validation", "thumbnail", "generated_media", "outbound", "publication", "uploads", "billing", "devices", "redispatch"] as const;

/** Operator authority only. The fence commits in its own transaction before
 * any domain reset or redispatch. Recovery never reopens admission. */
export class ExecutionRestoreService {
  constructor(private readonly options: { database: PrismaClient; register(ids: readonly string[]): Promise<void> }) {}
  async begin(input: { expectedEpoch: number }) {
    if (!Number.isSafeInteger(input.expectedEpoch) || input.expectedEpoch < 1 || input.expectedEpoch >= 2_147_483_647) throw new ExecutionRestoreError("restore_epoch_changed");
    const restored = await this.options.database.$transaction(async tx => {
      const [changed] = await tx.$queryRaw<Array<{ epoch: number; changedAt: Date }>>`UPDATE "ExecutionEpoch"
        SET epoch = epoch + 1, "admissionOpen" = false, "changedAt" = clock_timestamp() AT TIME ZONE 'UTC'
        WHERE id = 1 AND epoch = ${input.expectedEpoch} RETURNING epoch, "changedAt"`;
      if (changed) return changed;
      const current = await tx.executionEpoch.findUnique({ where: { id: 1 } });
      // The same expected epoch identifies the same interrupted restore. It
      // cannot close an already reopened deployment or advance it twice.
      if (!current || current.epoch !== input.expectedEpoch + 1 || current.admissionOpen) throw new ExecutionRestoreError("restore_epoch_changed");
      return current;
    });
    const reference = await this.options.database.$transaction(async tx => {
      const current = await readExecutionAdmission(tx);
      if (current.epoch !== restored.epoch || current.admissionOpen) throw new ExecutionRestoreError("restore_epoch_changed");
      const subjectId = `rs1.${input.expectedEpoch}.${restored.changedAt.getTime()}.${EXECUTION_RESTORE_PHASES[0]}`;
      const inputHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["restore-page-v1", restored.epoch, subjectId])))), byte => byte.toString(16).padStart(2, "0")).join("");
      return (await appendExecutionDispatch(tx, { deploymentEpoch: restored.epoch, generation: 1, kind: "maintenance", subject: { kind: "maintenance", id: subjectId }, inputHash, dueAt: restored.changedAt })).reference;
    });
    await this.options.register([reference.dispatchId]);
    return { previousEpoch: input.expectedEpoch, deploymentEpoch: restored.epoch, reference };
  }
}

import type { PrismaClient } from "@prisma/client";
import { appendExecutionDispatch, executionDispatchIdentity, readExecutionDispatch } from "./execution-dispatch";

export class ExecutionRestoreError extends Error {
  constructor(readonly code: "restore_epoch_changed" | "restore_reference_invalid" | "restore_phase_unavailable") { super(code); }
}
export const EXECUTION_RESTORE_PHASES = ["attempts", "ingest", "workflows", "render_groups", "selection", "preparation", "native_validation", "thumbnail", "generated_media", "outbound", "publication", "uploads", "billing", "devices", "redispatch"] as const;

/** Operator authority only. The fence commits in its own transaction before
 * any domain reset or redispatch. Recovery never reopens admission. */
export class ExecutionRestoreService {
  constructor(private readonly options: { database: PrismaClient; register(ids: readonly string[]): Promise<void> }) {}
  async begin(input: { expectedEpoch: number; fenceAboveEpoch: number }) {
    if (![input.expectedEpoch, input.fenceAboveEpoch].every(value => Number.isSafeInteger(value) && value >= 1 && value < 2_147_483_647)) throw new ExecutionRestoreError("restore_epoch_changed");
    const deploymentEpoch = Math.max(input.expectedEpoch, input.fenceAboveEpoch) + 1;
    const reference = await this.options.database.$transaction(async tx => {
      const [changed] = await tx.$queryRaw<Array<{ epoch: number; changedAt: Date }>>`UPDATE "ExecutionEpoch"
        SET epoch = ${deploymentEpoch}, "admissionOpen" = false, "changedAt" = clock_timestamp() AT TIME ZONE 'UTC'
        WHERE id = 1 AND epoch = ${input.expectedEpoch} RETURNING epoch, "changedAt"`;
      const current = changed ?? await tx.executionEpoch.findUnique({ where: { id: 1 } });
      if (!current || current.epoch !== deploymentEpoch || ("admissionOpen" in current && current.admissionOpen)) throw new ExecutionRestoreError("restore_epoch_changed");
      const subjectId = `rs1.${input.expectedEpoch}.${input.fenceAboveEpoch}.${deploymentEpoch}.${current.changedAt.getTime()}.${EXECUTION_RESTORE_PHASES[0]}`;
      const identity = { deploymentEpoch, generation: 1, kind: "maintenance" as const, subject: { kind: "maintenance" as const, id: subjectId } };
      const inputHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["restore-page-v1", deploymentEpoch, subjectId])))), byte => byte.toString(16).padStart(2, "0")).join("");
      if (!changed) {
        // The persisted begin obligation is the source-pair receipt. A
        // different pair yielding the same max epoch cannot resume it.
        const existing = await tx.executionDispatch.findUnique({ where: { deliveryKey: (await executionDispatchIdentity(identity)).deliveryKey } });
        const recorded = existing ? await readExecutionDispatch(tx, existing.id) : null;
        if (!recorded || recorded.reference.inputHash !== inputHash) throw new ExecutionRestoreError("restore_epoch_changed");
        return recorded.reference;
      }
      // The fence and its initial obligation commit atomically, with no
      // domain-row reset locks and no SQL transaction spanning HTTP.
      return (await appendExecutionDispatch(tx, { ...identity, inputHash, dueAt: current.changedAt })).reference;
    });
    await this.options.register([reference.dispatchId]);
    return { previousEpoch: input.expectedEpoch, deploymentEpoch, reference };
  }
}

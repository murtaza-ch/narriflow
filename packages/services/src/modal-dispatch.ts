import type { PrismaClient } from "@prisma/client";
import { executionDispatchReferenceSchema, executionMediaFunctionSchema, type ExecutionDispatchReference } from "@narriflow/validators/execution";
import { ExecutionDispatchError, type ExecutionDispatchConfirmation } from "./execution-dispatch";
import type { createModalBridgeClient } from "./modal-bridge";

/** Resolve the already admitted tuple; a transport retry never invents a new
 * token or chooses arbitrarily between ambiguous admissions. */
export function createModalDispatch(database: PrismaClient, bridge: ReturnType<typeof createModalBridgeClient>) {
  return {
    async spawn(value: ExecutionDispatchReference): Promise<ExecutionDispatchConfirmation> {
      const reference = executionDispatchReferenceSchema.parse(value);
      if (reference.kind !== "modal_execution") throw new ExecutionDispatchError("invalid_dispatch");
      const admitted = await database.executionAttempt.findMany({ where: { dispatchId: reference.dispatchId,
        deploymentEpoch: reference.deploymentEpoch, generation: reference.generation, inputHash: reference.inputHash,
        dispatch: { kind: reference.kind, subjectKind: reference.subject.kind, subjectId: reference.subject.id } },
        select: { attemptToken: true, functionName: true }, take: 2 });
      if (admitted.length !== 1) throw new ExecutionDispatchError("invalid_dispatch");
      const attempt = admitted[0]!;
      const functionName = executionMediaFunctionSchema.safeParse(attempt.functionName);
      if (!functionName.success) throw new ExecutionDispatchError("invalid_dispatch");
      const result = await bridge.command({ action: "spawn", reference, attemptToken: attempt.attemptToken, function: functionName.data }, reference.dispatchId);
      if (result.disposition !== "spawned") throw new ExecutionDispatchError("invalid_confirmation");
      return { status: "confirmed_created", destinationId: result.callId };
    },
  };
}

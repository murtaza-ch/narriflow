import type { Prisma } from "@prisma/client";
import { ExpectedDomainFailureError } from "./expected-domain-failure";

export interface ExecutionAdmission { epoch: number; admissionOpen: boolean }
export class ExecutionAdmissionError extends ExpectedDomainFailureError<"execution_admission_closed"> {
  constructor() { super({ code: "execution_admission_closed", kind: "unavailable", message: "Processing admission is temporarily closed" }); }
}

/** First lock in a new-work transaction. Closing/updating the singleton waits
 * for admitted transactions to commit. A receipt replay may return while closed. */
export async function readExecutionAdmission(tx: Pick<Prisma.TransactionClient, "$queryRaw">): Promise<ExecutionAdmission> {
  const [row] = await tx.$queryRaw<ExecutionAdmission[]>`SELECT "epoch", "admissionOpen" FROM "ExecutionEpoch" WHERE "id" = 1 FOR SHARE`;
  if (!row) throw new ExecutionAdmissionError();
  return row;
}
export function assertExecutionAdmissionOpen(state: ExecutionAdmission): void {
  if (!state.admissionOpen) throw new ExecutionAdmissionError();
}
export async function requireExecutionAdmissionOpen(tx: Pick<Prisma.TransactionClient, "$queryRaw">): Promise<ExecutionAdmission> {
  const state = await readExecutionAdmission(tx);
  assertExecutionAdmissionOpen(state);
  return state;
}

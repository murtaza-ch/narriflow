import type { Prisma } from "@prisma/client";
import type { ExecutionArtifactRole, ExecutionCommand, ExecutionDispatchReference, ExecutionDisposition } from "@narriflow/validators/execution";

export type ExecutorDomainTransaction = Prisma.TransactionClient;

export type ExecutorDomainLock<TRef> =
  | { kind: "current"; ref: TRef }
  | { kind: "terminal"; disposition: ExecutionDisposition };

/** Constructed from locked authority and validated server-owned work inputs. */
export interface ExecutorMutationContext {
  reference: ExecutionDispatchReference;
  attemptToken: string;
  owner: string;
  now: Date;
  leaseExpiresAt: Date;
  operationDeadlineAt: Date;
  functionName: string;
  /** Expected provenance resolved from frozen server input, never callback claims. */
  fingerprints?: {
    source: string;
    analysis: string | null;
    toolchain: string;
  };
}

/** Storage HEAD and assigned-namespace validation happen before the transaction. */
export interface ExecutorArtifactCommit {
  artifactId: string;
  role: ExecutionArtifactRole;
  storageKey: string;
  contentType: string;
  byteLength: bigint;
  sha256: string;
  etag: string;
  bindingHash: string;
}

export type ExecutorFailureInput = Pick<Extract<ExecutionCommand, { action: "fail" }>, "failureCode" | "retryable">;
export type ExecutorReleaseInput = Pick<Extract<ExecutionCommand, { action: "release" }>, "reason">;
export type ExecutorProgressInput = Pick<Extract<ExecutionCommand, { action: "progress" }>, "phase" | "progress">;
// biome-ignore lint/suspicious/noConfusingVoidType: Commands without wakes intentionally preserve their Promise<void> interface.
export type ExecutorMutationResult = void | { dispatchIds: readonly string[] };

export interface ExecutorExpiryObservation {
  kind: "lease" | "operation";
  observedDeadlineAt: Date;
}
export type ExecutorExpiryResult =
  | { kind: "terminal" | "superseded" | "expired"; dispatchIds?: readonly string[] }
  | { kind: "sleep"; dueAt: Date };


/** Trusted TypeScript service ports. None is exposed as a generic remote command. */
export interface ExecutorDomainControl<TRef = unknown, TArtifact extends ExecutorArtifactCommit = ExecutorArtifactCommit> {
  /** Epoch is already locked. Take owner-defined domain locks before the attempt lock. */
  lockExecution(tx: ExecutorDomainTransaction, reference: ExecutionDispatchReference, attemptToken: string): Promise<ExecutorDomainLock<TRef>>;
  acquireExecution(tx: ExecutorDomainTransaction, ref: TRef, context: ExecutorMutationContext): Promise<ExecutorMutationResult>;
  renewExecution(tx: ExecutorDomainTransaction, ref: TRef, context: ExecutorMutationContext): Promise<ExecutorMutationResult>;
  startExecution(tx: ExecutorDomainTransaction, ref: TRef, context: ExecutorMutationContext): Promise<ExecutorMutationResult>;
  commitArtifactExecution(tx: ExecutorDomainTransaction, ref: TRef, context: ExecutorMutationContext, artifact: TArtifact): Promise<ExecutorMutationResult>;
  failExecution(tx: ExecutorDomainTransaction, ref: TRef, context: ExecutorMutationContext, failure: ExecutorFailureInput): Promise<ExecutorMutationResult>;
  releaseExecution(tx: ExecutorDomainTransaction, ref: TRef, context: ExecutorMutationContext, release: ExecutorReleaseInput): Promise<ExecutorMutationResult>;
  progressExecution(tx: ExecutorDomainTransaction, ref: TRef, context: ExecutorMutationContext, progress: ExecutorProgressInput): Promise<ExecutorMutationResult>;
}

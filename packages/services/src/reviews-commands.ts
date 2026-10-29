import { createHash } from "node:crypto";
import { getPrismaClient } from "@narriflow/db/client";
import type { Prisma } from "@prisma/client";
import { ExpectedDomainFailureError } from "./expected-domain-failure";
import { operationFingerprint, OperationIdempotencyConflictError, type IntegrationMutation } from "./operation-receipt";
import type { getOperationReceiptExecutor } from "./operation-receipt-runtime";
import type { ReviewService, ReviewSessionClaims } from "./review.service";
import { REVIEWS_RECEIPT_COMMANDS } from "./reviews-receipt-commands";

export type GuestReviewMutation = Pick<IntegrationMutation, "clientIdempotencyKey" | "beforeAccept">;

/** Guest receipts belong to their immutable domain audit event, never an App User. */
export async function executeGuestReviewCommand<Context extends { claims: ReviewSessionClaims }, Result extends Prisma.InputJsonObject>(input: {
  mutation: GuestReviewMutation | undefined;
  command: "review.comment.create" | "review.decision.create"; input: unknown;
  authorize(tx: Prisma.TransactionClient): Promise<Context>;
  mutate(tx: Prisma.TransactionClient, context: Context, receipt: (value: Result) => Prisma.InputJsonObject): Promise<Result>;
}): Promise<{ value: Result; replayed: boolean }> {
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("Database client unavailable");
  // Authorization precedes even caller-key refusal for direct service callers.
  return prisma.$transaction(async (tx) => {
    let context = await input.authorize(tx);
    const key = input.mutation?.clientIdempotencyKey;
    if (!key || key.length > 128) throw new ExpectedDomainFailureError({ code: "idempotency_key_required", kind: "invalid", message: "A bounded client idempotency key is required." });
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    const { roundId, guestId, subject } = context.claims;
    const binding = { command: input.command, keyDigest: digest(key), guestId, grantHash: digest(subject) };
    const lock = JSON.stringify([roundId, guestId, binding.grantHash, input.command, binding.keyDigest]);
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))::text`;
    // Access exchange, revocation and guest writes serialize on this row. No
    // grant can rotate between the locked authorization check and acceptance.
    await tx.$queryRaw`SELECT "id" FROM "ReviewRound" WHERE "id" = ${roundId}::uuid FOR UPDATE`;
    context = await input.authorize(tx);
    const fingerprint = operationFingerprint(input.input);
    const existing = await tx.reviewAuditEvent.findFirst({ where: { reviewRoundId: roundId, guestId,
      AND: Object.entries(binding).map(([name, value]) => ({ metadata: { path: ["receipt", name], equals: value } })),
    }, select: { metadata: true } });
    if (existing) {
      const receipt = (existing.metadata as Prisma.JsonObject).receipt as Prisma.JsonObject;
      if (receipt.fingerprint !== fingerprint) throw new OperationIdempotencyConflictError();
      return { value: receipt.result as Result, replayed: true };
    }
    await input.mutation?.beforeAccept?.();
    const receipt = (result: Result): Prisma.InputJsonObject => ({ ...binding, fingerprint, result });
    const value = await input.mutate(tx, context, receipt);
    return { value, replayed: false };
  });
}

type JsonSnapshot<T> = T extends Date ? string : T extends readonly (infer Item)[] ? JsonSnapshot<Item>[] : T extends object ? { [Key in keyof T]: JsonSnapshot<T[Key]> } : T;

type ReviewScope = Parameters<ReviewService["createRound"]>[0];
export interface ReviewsCommandDependencies {
  receipts: ReturnType<typeof getOperationReceiptExecutor>;
  service: ReviewService;
  authorize(scope: ReviewScope, command: (typeof REVIEWS_RECEIPT_COMMANDS)[number]): Promise<void>;
  retry(tx: Prisma.TransactionClient, scope: ReviewScope, roundId: string, ledgerId: string): Promise<{ retrying: boolean }>;
  /** Encrypt the credential-bearing create result before storing its immutable snapshot. */
  protect(value: unknown): string;
  reveal(value: string): unknown;
}

export function createReviewsCommands(deps: ReviewsCommandDependencies) {
  async function execute<T>(scope: ReviewScope, mutation: IntegrationMutation, command: (typeof REVIEWS_RECEIPT_COMMANDS)[number], input: unknown,
    mutate: (tx: Prisma.TransactionClient) => Promise<T>) {
    const accepted = await deps.receipts.execute({ identity: { workspaceId: scope.workspaceId, actorUserId: scope.actorUserId, command, clientIdempotencyKey: mutation.clientIdempotencyKey }, input,
      authorize: () => deps.authorize(scope, command), beforeAccept: mutation.beforeAccept,
      mutate: async (tx) => {
        const value = await mutate(tx);
        return { resourceType: "review", resourceId: scope.projectId, value: { protectedResult: deps.protect(value) } };
      },
    });
    return { value: deps.reveal(accepted.value.protectedResult) as JsonSnapshot<T>, replayed: accepted.replayed };
  }
  return {
    createRound: (scope: ReviewScope, input: unknown, mutation: IntegrationMutation) => execute(scope, mutation, "create_review_round", { projectId: scope.projectId, input }, (tx) => deps.service.createRound(scope, input, { tx })),
    invite: (scope: ReviewScope, roundId: string, input: unknown, mutation: IntegrationMutation) => execute(scope, mutation, "invite_reviewers", { projectId: scope.projectId, roundId, input }, (tx) => deps.service.inviteReviewers(scope, roundId, input, tx)),
    comment: (scope: ReviewScope, roundId: string, input: unknown, mutation: IntegrationMutation) => execute(scope, mutation, "create_internal_review_comment", { projectId: scope.projectId, roundId, input }, (tx) => deps.service.addInternalComment(scope, roundId, input, tx)),
    resolve: (scope: ReviewScope, roundId: string, commentId: string, resolved: boolean, mutation: IntegrationMutation) => execute(scope, mutation, resolved ? "resolve_review_comment" : "reopen_review_comment", { projectId: scope.projectId, roundId, commentId }, (tx) => deps.service.resolveComment(scope, roundId, commentId, resolved, tx)),
    revoke: (scope: ReviewScope, roundId: string, mutation: IntegrationMutation) => execute(scope, mutation, "revoke_review_round", { projectId: scope.projectId, roundId }, (tx) => deps.service.revokeRound(scope, roundId, tx)),
    retry: (scope: ReviewScope, roundId: string, ledgerId: string, mutation: IntegrationMutation) => execute(scope, mutation, "retry_review_notification", { projectId: scope.projectId, roundId, ledgerId }, (tx) => deps.retry(tx, scope, roundId, ledgerId)),
  };
}
export type ReviewsCommands = ReturnType<typeof createReviewsCommands>;

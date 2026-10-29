import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
  createCallbackSigningSecrets,
  createCompletionCallbackProcessor,
  prepareCallbackRegistration,
  registerUploadCallback,
  type CallbackRegistration,
} from "./completion-callback";
import { operationStatusService } from "./operation-status-runtime";
import type { IntegrationMutation } from "./operation-receipt";

function requiredPrisma() {
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("Database client unavailable");
  return prisma;
}

/** Event IDs derive from the acceptance (receipt or Upload Session), so every
 * replay of an acceptance reports the same event ID without another read. */

export async function ensureUploadCallback(input: { workspaceId: string; sessionId: string; registration: CallbackRegistration }) {
  const prisma = requiredPrisma();
  try {
    await prisma.$transaction((tx) => registerUploadCallback(tx, input));
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
    await prisma.$transaction((tx) => registerUploadCallback(tx, input));
  }
}

export function prepareUploadCallback(mutation: Pick<IntegrationMutation, "callback"> | undefined) {
  return mutation?.callback ? prepareCallbackRegistration(mutation.callback.url) : undefined;
}

/** Signing secrets: one current secret per Workspace. Rotation keeps the
 * previous one signing for the overlap window and retires any older one. */

let processor: ReturnType<typeof createCompletionCallbackProcessor> | null = null;

/** The worker's production processor, reading Operation Status through the
 * trusted service read. */
export function getCompletionCallbackProcessor() {
  processor ??= createCompletionCallbackProcessor({
    prisma: requiredPrisma(),
    readTrusted: (scope, operation) => operationStatusService.readTrusted(scope, operation),
    leaseOwner: `callbacks:${randomUUID()}`,
  });
  return processor;
}

/** Production signing-secret operations on the shared database. Rotation happens only inside the receipt-backed developer command (`issue`), never on its own. */
export const callbackSigningSecrets = {
  status: (workspaceId: string) => createCallbackSigningSecrets({ prisma: requiredPrisma() }).status(workspaceId),
  issue: (tx: Prisma.TransactionClient, workspaceId: string) => createCallbackSigningSecrets({ prisma: requiredPrisma() }).issue(tx, workspaceId),
};

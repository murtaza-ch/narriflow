import { Prisma } from "@prisma/client";
import {
  createCallbackSigningSecrets,
  prepareCallbackRegistration,
  registerUploadCallback,
  type CallbackRegistration,
} from "./completion-callback";
import type { IntegrationMutation } from "./operation-receipt";
import { requirePrisma } from "./require-prisma";


/** Event IDs derive from the acceptance (receipt or Upload Session), so every
 * replay of an acceptance reports the same event ID without another read. */

export async function ensureUploadCallback(input: { workspaceId: string; sessionId: string; registration: CallbackRegistration }) {
  const prisma = requirePrisma();
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


/** Production signing-secret operations on the shared database. Rotation happens only inside the receipt-backed developer command (`issue`), never on its own. */
export const callbackSigningSecrets = {
  status: (workspaceId: string) => createCallbackSigningSecrets({ prisma: requirePrisma() }).status(workspaceId),
  issue: (tx: Prisma.TransactionClient, workspaceId: string) => createCallbackSigningSecrets({ prisma: requirePrisma() }).issue(tx, workspaceId),
};

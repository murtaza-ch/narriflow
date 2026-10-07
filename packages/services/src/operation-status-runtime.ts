import { getPrismaClient } from "@narriflow/db/client";
import type { ActorScope } from "./actor-scope";
import { createOperationStatusReader, type OperationKind } from "./operation-status";
import { workspaceService } from "./workspace.service";

function reader() {
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("Operation storage is unavailable");
  return createOperationStatusReader(prisma);
}

export const operationStatusService = {
  /** Operation Status for a Workspace member who can view content. */
  async read(actor: ActorScope, operation: { kind: OperationKind; id: string }) {
    await workspaceService.requireActor(actor.actorUserId, actor.workspaceId, "content.view");
    return reader().read(actor, operation);
  },
  /** Operation Status for trusted service loops, such as completion callbacks. */
  readTrusted(scope: { workspaceId: string }, operation: { kind: OperationKind; id: string }) {
    return reader().readTrusted(scope, operation);
  },
};

import type { Prisma } from "@prisma/client";
import type { ActorScope } from "./actor-scope";
import type { ClipSnapshot } from "@narriflow/validators";
import {
  ClipCreationReplayed,
  type ClipCreationAcceptance,
  type ClipService,
} from "./clip.service";
import {
  createOperationReceiptExecutor,
  operationFingerprint,
  OperationIdempotencyConflictError,
  type IntegrationMutation,
  type OperationReceiptIdentity,
  type OperationReceiptPersistence,
} from "./operation-receipt";
import { CLIPS_RECEIPT_COMMANDS } from "./clips-receipt-commands";

/** Dependencies of the clips receipt-backed commands. */
export interface ClipsCommandDependencies {
  persistence: OperationReceiptPersistence<Prisma.TransactionClient>;
  clips: Pick<ClipService, "duplicateClip" | "createClipFromRange" | "createClipFromSelection">;
  requireEditor(actorUserId: string, workspaceId: string): Promise<unknown>;
}

/** A created clip, and whether this call replayed an earlier acceptance. */
export interface ClipCreationOutcome {
  clip: ClipSnapshot;
  replayed: boolean;
}

type ClipCreation = (acceptance: ClipCreationAcceptance) => Promise<ClipSnapshot>;

/**
 * Receipt-backed retryable commands of the clips domain. Only names registered
 * in `CLIPS_RECEIPT_COMMANDS` may be recorded.
 *
 * Duplicating a clip and making one from a range or a transcript selection create rows (and, for a
 * duplicate, copy media). The receipt is written in the same transaction as the
 * new clip's rows, so a lost response or a retry returns the clip that was
 * accepted instead of creating a second one. A replay is answered before the
 * limiter's `beforeAccept` and before any media is copied.
 */
export function createClipsCommands(dependencies: ClipsCommandDependencies) {
  const { persistence, clips, requireEditor } = dependencies;
  const executor = createOperationReceiptExecutor(persistence);

  async function createClip(
    actor: ActorScope,
    command: "duplicate_clip" | "create_clip_from_range" | "create_clip_from_selection",
    input: unknown,
    mutation: IntegrationMutation,
    create: ClipCreation,
  ): Promise<ClipCreationOutcome> {
    const identity: OperationReceiptIdentity = {
      workspaceId: actor.workspaceId,
      actorUserId: actor.actorUserId,
      command,
      clientIdempotencyKey: mutation.clientIdempotencyKey,
    };
    const authorize = async () => {
      await requireEditor(actor.actorUserId, actor.workspaceId);
    };

    const replayOf = async (): Promise<ClipCreationOutcome | null> => {
      const existing = await persistence.read(identity);
      if (!existing) return null;
      if (existing.fingerprint !== operationFingerprint(input)) {
        throw new OperationIdempotencyConflictError();
      }
      return { clip: existing.result as ClipSnapshot, replayed: true };
    };

    // Replay first, after current authorization, so a retry never repeats work
    // and a changed input under the same key conflicts.
    await authorize();
    const replay = await replayOf();
    if (replay) return replay;
    // New work: refuse before copying media. The executor repeats the check once
    // it holds the receipt lock. A refusal here may race a request that has just
    // committed this same key, so look for its receipt again before returning it.
    try {
      await mutation.beforeAccept?.();
    } catch (refusal) {
      const concurrent = await replayOf();
      if (concurrent) return concurrent;
      throw refusal;
    }

    try {
      const clip = await create({
        async accept(write) {
          const accepted = await executor.execute<ClipSnapshot>({
            identity,
            input,
            authorize,
            beforeAccept: mutation.beforeAccept,
            mutate: async (tx) => {
              const created = await write(tx);
              return { resourceType: "clip", resourceId: created.id, value: created };
            },
          });
          // Another request accepted this command while we were preparing.
          if (accepted.replayed) throw new ClipCreationReplayed(accepted.value);
          return accepted.value;
        },
      });
      return { clip, replayed: false };
    } catch (error) {
      if (error instanceof ClipCreationReplayed) {
        return { clip: error.snapshot, replayed: true };
      }
      throw error;
    }
  }

  return {
    receiptCommands: CLIPS_RECEIPT_COMMANDS,

    duplicateClip(actor: ActorScope, projectId: string, clipId: string, mutation: IntegrationMutation) {
      return createClip(actor, "duplicate_clip", { projectId, clipId }, mutation, (acceptance) =>
        clips.duplicateClip(actor, projectId, clipId, acceptance),
      );
    },

    createClipFromSelection(
      actor: ActorScope,
      projectId: string,
      sourceClipId: string,
      range: { startSec: number; endSec: number },
      mutation: IntegrationMutation,
    ) {
      return createClip(
        actor,
        "create_clip_from_selection",
        { projectId, sourceClipId, startSec: range.startSec, endSec: range.endSec },
        mutation,
        (acceptance) => clips.createClipFromSelection(actor, projectId, sourceClipId, range, acceptance),
      );
    },

    createClipFromRange(
      actor: ActorScope,
      projectId: string,
      range: { startSec: number; endSec: number },
      mutation: IntegrationMutation,
    ) {
      return createClip(
        actor,
        "create_clip_from_range",
        { projectId, startSec: range.startSec, endSec: range.endSec },
        mutation,
        (acceptance) => clips.createClipFromRange(actor, projectId, range, acceptance),
      );
    },
  };
}

export type ClipsCommands = ReturnType<typeof createClipsCommands>;

import { tryDerivePeaksStorageKey } from "./clip-preview-storage";

import type { Prisma } from "@prisma/client";
import { admitMediaCleanupObligations } from "./media-cleanup-admission";
import { type MediaCleanupOrigin, type MediaCleanupClass, type MediaCleanupObligationInput, type MediaCleanupAdmissionStore } from "./media-cleanup-contract";
export { admitMediaCleanupObligations } from "./media-cleanup-admission";
export * from "./media-cleanup-contract";

function positiveInteger(value: number, name: string, max: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new RangeError(`${name} must be an integer between 1 and ${max}`);
}

export interface DurableMediaCopyHeartbeatScheduler {
  start(callback: () => Promise<void>, intervalMs: number): () => void;
}

/** Active user-requested copies renew their finite adoption hold. No timer
 * exists before the copy starts or after it settles. */
const defaultHeartbeatScheduler: DurableMediaCopyHeartbeatScheduler = {
  start(callback, intervalMs) {
    const timer = setInterval(() => void callback(), intervalMs);
    return () => clearInterval(timer);
  },
};

export interface RetiredClipMedia {
  clipId: string;
  previewStorageKey: string | null;
  renderStorageKeys: Array<string | null>;
  dubStorageKeys: Array<string | null>;
}

/**
 * Converts the complete storage inventory of retired Clips into durable work.
 * Keeping this mapping beside admission prevents replacement producers from
 * silently covering renders while leaking previews, peaks, or dubs.
 */
export function planRetiredClipMediaCleanup(
  origin: MediaCleanupOrigin,
  projectId: string,
  clips: readonly RetiredClipMedia[],
): MediaCleanupObligationInput[] {
  return clips.flatMap((clip) => {
    const obligations: MediaCleanupObligationInput[] = [];
    for (const objectKey of clip.renderStorageKeys) {
      if (!objectKey) continue;
      obligations.push({
        origin,
        cleanupClass: "mutable_render",
        projectId,
        clipId: clip.clipId,
        objectKey,
      });
    }
    for (const objectKey of clip.dubStorageKeys) {
      if (!objectKey) continue;
      obligations.push({
        origin,
        cleanupClass: "dub_media",
        projectId,
        clipId: clip.clipId,
        objectKey,
      });
    }
    if (clip.previewStorageKey) {
      obligations.push({
        origin,
        cleanupClass: "preview_proxy",
        projectId,
        clipId: clip.clipId,
        objectKey: clip.previewStorageKey,
      });
    }
    const previewPeaksKey = tryDerivePeaksStorageKey(clip.previewStorageKey);
    if (previewPeaksKey) {
      obligations.push({
        origin,
        cleanupClass: "preview_peaks",
        projectId,
        clipId: clip.clipId,
        objectKey: previewPeaksKey,
      });
    }
    return obligations;
  });
}

export interface RetiredClipMediaCleanupStore {
  clip: {
    findMany(input: {
      where: { projectId: string };
      select: {
        id: true;
        previewStorageKey: true;
        renders: { select: { storageKey: true } };
        dubs: {
          select: { audioStorageKey: true; renderStorageKey: true };
        };
      };
    }): Promise<
      Array<{
        id: string;
        previewStorageKey: string | null;
        renders: Array<{ storageKey: string | null }>;
        dubs: Array<{
          audioStorageKey: string | null;
          renderStorageKey: string | null;
        }>;
      }>
    >;
  };
  mediaCleanupObligation: MediaCleanupAdmissionStore;
}

/** Inventories and admits every media object owned by Clips being replaced. */
export async function admitRetiredClipMediaCleanup(
  store: RetiredClipMediaCleanupStore | Prisma.TransactionClient,
  origin: MediaCleanupOrigin,
  projectId: string,
): Promise<number> {
  const clipStore: RetiredClipMediaCleanupStore["clip"] = store.clip;
  const clips = await clipStore.findMany({
    where: { projectId },
    select: {
      id: true,
      previewStorageKey: true,
      renders: { select: { storageKey: true } },
      dubs: { select: { audioStorageKey: true, renderStorageKey: true } },
    },
  });
  return admitMediaCleanupObligations(
    "$queryRaw" in store ? store : store.mediaCleanupObligation,
    planRetiredClipMediaCleanup(
      origin,
      projectId,
      clips.map((clip) => ({
        clipId: clip.id,
        previewStorageKey: clip.previewStorageKey,
        renderStorageKeys: clip.renders.map((render) => render.storageKey),
        dubStorageKeys: clip.dubs.flatMap((dub) => [
          dub.audioStorageKey,
          dub.renderStorageKey,
        ]),
      })),
    ),
  );
}

export interface DurableMediaCopyPlan<T> extends MediaCleanupObligationInput {
  sourceKey: string;
  value: T;
}

export class DurableMediaCopyClaimLost extends Error {
  constructor() {
    super("durable media copy claim lost");
    this.name = "DurableMediaCopyClaimLost";
  }
}

const DURABLE_MEDIA_COPY_ADOPTED = "duplicate_media_adopted";

export interface DurableMediaCopyAdoptionStore {
  updateMany(input: {
    where: {
      claimId: string;
      claimExpiresAt: { gt: Date };
      completedAt: null;
      OR: Array<{
        origin: MediaCleanupOrigin;
        cleanupClass: MediaCleanupClass;
        objectKey: string;
      }>;
    };
    data: {
      completedAt: Date;
      claimId: null;
      claimExpiresAt: null;
      failureCode: typeof DURABLE_MEDIA_COPY_ADOPTED;
    };
  }): Promise<{ count: number }>;
  count(input: {
    where: {
      completedAt: { not: null };
      failureCode: typeof DURABLE_MEDIA_COPY_ADOPTED;
      OR: Array<{
        origin: MediaCleanupOrigin;
        cleanupClass: MediaCleanupClass;
        objectKey: string;
      }>;
    };
  }): Promise<number>;
}

/**
 * Must run inside the same transaction that persists the copied references.
 * Completed obligations remain as durable idempotency receipts. A zero-row
 * settlement is accepted only when every stable destination identity already
 * has such a receipt; a partial settlement means ownership was lost.
 */
export async function adoptDurableMediaCopies<T>(
  store: DurableMediaCopyAdoptionStore,
  copied: readonly DurableMediaCopyPlan<T>[],
  claimId: string,
  now: Date,
): Promise<void> {
  if (copied.length === 0) return;
  const identities = copied.map((plan) => ({
    origin: plan.origin,
    cleanupClass: plan.cleanupClass,
    objectKey: plan.objectKey,
  }));
  const settled = await store.updateMany({
    where: {
      claimId,
      claimExpiresAt: { gt: now },
      completedAt: null,
      OR: identities,
    },
    data: {
      completedAt: now,
      claimId: null,
      claimExpiresAt: null,
      failureCode: DURABLE_MEDIA_COPY_ADOPTED,
    },
  });
  if (settled.count === copied.length) return;
  const adopted = await store.count({
    where: {
      completedAt: { not: null },
      failureCode: DURABLE_MEDIA_COPY_ADOPTED,
      OR: identities,
    },
  });
  if (adopted !== copied.length) {
    throw new DurableMediaCopyClaimLost();
  }
}

/**
 * Runs remote copies behind provisional cleanup obligations. The producer's
 * adoption callback must commit references and complete the copied obligations
 * with adoption receipts atomically. If adoption fails, every planned destination remains durable and
 * is released for Media Cleanup; ambiguous copy failures are treated the same
 * way because the provider may have written bytes before returning an error.
 */
export async function runDurableMediaCopies<T, TResult>(input: {
  store: MediaCleanupAdmissionStore;
  plans: readonly DurableMediaCopyPlan<T>[];
  claimId: string;
  claimExpiresAt: Date;
  leaseMs: number;
  heartbeatMs: number;
  renew(input: {
    plans: readonly DurableMediaCopyPlan<T>[];
    claimId: string;
    now: Date;
    claimExpiresAt: Date;
  }): Promise<boolean>;
  copy(plan: DurableMediaCopyPlan<T>): Promise<void>;
  adopt(
    copied: readonly DurableMediaCopyPlan<T>[],
    claimId: string,
    fencedAt: Date,
  ): Promise<TResult>;
  release(objectKeys: readonly string[], claimId: string): Promise<number>;
  onCopyFailure?(plan: DurableMediaCopyPlan<T>, error: unknown): void;
  onReleaseFailure?(error: unknown): void;
  onAdoptionOutcome?(
    outcome: "succeeded" | "failed",
    context: { copiedObjectCount: number; plannedObjectCount: number },
  ): void;
  onCompensationOutcome?(
    outcome: "released" | "release_failed",
    context: { releasedObjectCount: number },
  ): void;
  heartbeatScheduler?: DurableMediaCopyHeartbeatScheduler;
  now?: () => Date;
}): Promise<TResult> {
  positiveInteger(input.leaseMs, "leaseMs", 15 * 60 * 1000);
  positiveInteger(input.heartbeatMs, "heartbeatMs", 5 * 60 * 1000);
  if (input.heartbeatMs * 2 >= input.leaseMs) {
    throw new RangeError("heartbeatMs must be less than half the leaseMs");
  }
  const now = input.now ?? (() => new Date());
  const heartbeatScheduler =
    input.heartbeatScheduler ?? defaultHeartbeatScheduler;
  let claimLost = false;
  let heartbeatInFlight: Promise<void> | null = null;
  const renew = async () => {
    const renewalNow = now();
    const renewed = await input.renew({
      plans: input.plans,
      claimId: input.claimId,
      now: renewalNow,
      claimExpiresAt: new Date(renewalNow.getTime() + input.leaseMs),
    });
    if (!renewed) throw new DurableMediaCopyClaimLost();
  };
  const admitted = await admitMediaCleanupObligations(
    input.store,
    input.plans.map(({ sourceKey: _sourceKey, value: _value, ...plan }) => plan),
    {
      heldClaim: {
        claimId: input.claimId,
        claimExpiresAt: input.claimExpiresAt,
      },
    },
  );
  if (admitted !== input.plans.length) {
    try {
      await renew();
    } catch {
      throw new Error("media_copy_compensation_admission_conflict");
    }
  }

  const stopHeartbeat =
    input.plans.length === 0
      ? () => undefined
      : heartbeatScheduler.start(async () => {
          if (heartbeatInFlight || claimLost) return;
          const renewal = renew().catch(() => {
            claimLost = true;
          });
          heartbeatInFlight = renewal;
          await renewal;
          if (heartbeatInFlight === renewal) heartbeatInFlight = null;
        }, input.heartbeatMs);

  let copied: DurableMediaCopyPlan<T>[];
  try {
    const results = await Promise.all(
      input.plans.map(async (plan) => {
        try {
          await input.copy(plan);
          return plan;
        } catch (error) {
          try {
            input.onCopyFailure?.(plan, error);
          } catch {
            // Diagnostics cannot change compensation ownership.
          }
          return null;
        }
      }),
    );
    copied = results.filter(
      (plan): plan is DurableMediaCopyPlan<T> => plan !== null,
    );
  } finally {
    stopHeartbeat();
  }
  await heartbeatInFlight;
  if (claimLost) throw new DurableMediaCopyClaimLost();
  if (input.plans.length > 0) await renew();
  const release = async (objectKeys: readonly string[]) => {
    if (objectKeys.length === 0) return;
    try {
      const releasedCount = await input.release(objectKeys, input.claimId);
      if (releasedCount !== objectKeys.length) {
        throw new DurableMediaCopyClaimLost();
      }
      try {
        input.onCompensationOutcome?.("released", {
          releasedObjectCount: releasedCount,
        });
      } catch {
        // Diagnostics cannot change compensation ownership.
      }
    } catch (error) {
      // The held obligations recover after claim expiry even when eager release
      // is unavailable, so release failure must not corrupt the action result.
      try {
        input.onReleaseFailure?.(error);
      } catch {
        // Diagnostics cannot change compensation ownership.
      }
      try {
        input.onCompensationOutcome?.("release_failed", {
          releasedObjectCount: 0,
        });
      } catch {
        // Diagnostics cannot change compensation ownership.
      }
    }
  };

  let result: TResult;
  try {
    result = await input.adopt(copied, input.claimId, now());
  } catch (error) {
    try {
      input.onAdoptionOutcome?.("failed", {
        copiedObjectCount: copied.length,
        plannedObjectCount: input.plans.length,
      });
    } catch {
      // Diagnostics cannot change compensation ownership.
    }
    await release(input.plans.map((plan) => plan.objectKey));
    throw error;
  }
  try {
    input.onAdoptionOutcome?.("succeeded", {
      copiedObjectCount: copied.length,
      plannedObjectCount: input.plans.length,
    });
  } catch {
    // Diagnostics cannot change compensation ownership.
  }

  const copiedKeys = new Set(copied.map((plan) => plan.objectKey));
  await release(
    input.plans
      .filter((plan) => !copiedKeys.has(plan.objectKey))
      .map((plan) => plan.objectKey),
  );
  return result;
}

export { executionInputRetainUntil } from "./execution-input-retention";

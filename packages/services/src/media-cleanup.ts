import { randomUUID } from "node:crypto";
import { getPrismaClient } from "@narriflow/db/client";
import type { MediaCleanupObligation } from "@prisma/client";
import { tryDerivePeaksStorageKey } from "./clip-preview-storage";
import { classifyR2StorageError, deleteObject } from "./r2-storage";

export type MediaCleanupOrigin =
  | "clip_editor_document_persistence"
  | "detected_clip_replacement"
  | "clip_duplicate_compensation";

export type MediaCleanupClass =
  | "mutable_render"
  | "preview_proxy"
  | "preview_peaks"
  | "dub_media";

export interface MediaCleanupObligationInput {
  origin: MediaCleanupOrigin;
  cleanupClass: MediaCleanupClass;
  projectId?: string | null;
  clipId?: string | null;
  objectKey: string;
}

export interface MediaCleanupAdmissionStore {
  createMany(input: {
    data: Array<{
      origin: MediaCleanupOrigin;
      cleanupClass: MediaCleanupClass;
      projectId: string | null;
      clipId: string | null;
      objectKey: string;
      claimId?: string;
      claimExpiresAt?: Date;
    }>;
    skipDuplicates: true;
  }): Promise<{ count: number }>;
}

export interface MediaCleanupAdmissionOptions {
  heldClaim?: {
    claimId: string;
    claimExpiresAt: Date;
  };
}

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
  store: RetiredClipMediaCleanupStore,
  origin: MediaCleanupOrigin,
  projectId: string,
): Promise<number> {
  const clips = await store.clip.findMany({
    where: { projectId },
    select: {
      id: true,
      previewStorageKey: true,
      renders: { select: { storageKey: true } },
      dubs: { select: { audioStorageKey: true, renderStorageKey: true } },
    },
  });
  return admitMediaCleanupObligations(
    store.mediaCleanupObligation,
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

export async function admitMediaCleanupObligations(
  store: MediaCleanupAdmissionStore,
  obligations: readonly MediaCleanupObligationInput[],
  options: MediaCleanupAdmissionOptions = {},
): Promise<number> {
  const unique = [
    ...new Map(
      obligations.map((obligation) => [
        `${obligation.origin}\u0000${obligation.cleanupClass}\u0000${obligation.objectKey}`,
        obligation,
      ]),
    ).values(),
  ];
  if (unique.length === 0) return 0;
  const result = await store.createMany({
    data: unique.map((obligation) => ({
      origin: obligation.origin,
      cleanupClass: obligation.cleanupClass,
      projectId: obligation.projectId ?? null,
      clipId: obligation.clipId ?? null,
      objectKey: obligation.objectKey,
      ...(options.heldClaim ?? {}),
    })),
    skipDuplicates: true,
  });
  return result.count;
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
      failureCode: null;
    };
  }): Promise<{ count: number }>;
  count(input: {
    where: {
      completedAt: { not: null };
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
      failureCode: null,
    },
  });
  if (settled.count === copied.length) return;
  const adopted = await store.count({
    where: { completedAt: { not: null }, OR: identities },
  });
  if (adopted !== copied.length) {
    throw new DurableMediaCopyClaimLost();
  }
}

/**
 * Runs remote copies behind provisional cleanup obligations. The producer's
 * adoption callback must commit references and remove the copied obligations
 * atomically. If adoption fails, every planned destination remains durable and
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
  release(objectKeys: readonly string[], claimId: string): Promise<void>;
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
  heartbeatScheduler?: MediaCleanupHeartbeatScheduler;
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
      await input.release(objectKeys, input.claimId);
      try {
        input.onCompensationOutcome?.("released", {
          releasedObjectCount: objectKeys.length,
        });
      } catch {
        // Diagnostics cannot change compensation ownership.
      }
    } catch (error) {
      // The held obligations recover after claim expiry even when eager release
      // is unavailable, so release failure must not corrupt the action result.
      try {
        input.onReleaseFailure?.(error);
        input.onCompensationOutcome?.("release_failed", {
          releasedObjectCount: objectKeys.length,
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

export type MediaCleanupStorageOutcome =
  | "not_found"
  | "temporary"
  | "persistent"
  | "configuration"
  | "cancelled";

export interface ClaimedMediaCleanup {
  id: string;
  origin: MediaCleanupOrigin;
  projectId: string | null;
  clipId: string | null;
  cleanupClass: MediaCleanupClass;
  objectKey: string;
  attemptCount: number;
  claimId: string;
  claimExpiresAt: Date;
}

export interface MediaCleanupStore {
  claimDue(input: {
    now: Date;
    limit: number;
    leaseMs: number;
    createId: () => string;
  }): Promise<ClaimedMediaCleanup[]>;
  renew(input: {
    id: string;
    claimId: string;
    now: Date;
    claimExpiresAt: Date;
  }): Promise<boolean>;
  complete(input: { id: string; claimId: string; now: Date }): Promise<boolean>;
  reschedule(input: {
    id: string;
    claimId: string;
    now: Date;
    nextAttemptAt: Date;
    failureCode: string;
  }): Promise<boolean>;
  release(input: {
    id: string;
    claimId: string;
    now: Date;
    failureCode: string;
  }): Promise<boolean>;
}

export interface MediaCleanupConfig {
  batchSize: number;
  leaseMs: number;
  heartbeatMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
}

export function defaultMediaCleanupConfig(): MediaCleanupConfig {
  return {
    batchSize: 25,
    leaseMs: 60_000,
    heartbeatMs: 20_000,
    baseDelayMs: 5_000,
    maxDelayMs: 6 * 60 * 60 * 1000,
    jitterRatio: 0.2,
  };
}

function positiveInteger(value: number, name: string, max: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new RangeError(`${name} must be an integer between 1 and ${max}`);
  }
}

export function validateMediaCleanupConfig(
  config: MediaCleanupConfig,
): MediaCleanupConfig {
  positiveInteger(config.batchSize, "batchSize", 100);
  positiveInteger(config.leaseMs, "leaseMs", 15 * 60 * 1000);
  positiveInteger(config.heartbeatMs, "heartbeatMs", 5 * 60 * 1000);
  if (config.heartbeatMs * 2 >= config.leaseMs) {
    throw new RangeError("heartbeatMs must be less than half the leaseMs");
  }
  positiveInteger(config.baseDelayMs, "baseDelayMs", 24 * 60 * 60 * 1000);
  positiveInteger(config.maxDelayMs, "maxDelayMs", 7 * 24 * 60 * 60 * 1000);
  if (config.maxDelayMs < config.baseDelayMs) {
    throw new RangeError("maxDelayMs must be greater than or equal to baseDelayMs");
  }
  if (!Number.isFinite(config.jitterRatio) || config.jitterRatio < 0 || config.jitterRatio > 1) {
    throw new RangeError("jitterRatio must be between 0 and 1");
  }
  return { ...config };
}

export function mediaCleanupConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): MediaCleanupConfig {
  const defaults = defaultMediaCleanupConfig();
  const number = (name: string, fallback: number) => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    return Number(raw);
  };
  return validateMediaCleanupConfig({
    batchSize: number("MEDIA_CLEANUP_BATCH_SIZE", defaults.batchSize),
    leaseMs: number("MEDIA_CLEANUP_LEASE_MS", defaults.leaseMs),
    heartbeatMs: number("MEDIA_CLEANUP_HEARTBEAT_MS", defaults.heartbeatMs),
    baseDelayMs: number("MEDIA_CLEANUP_BASE_DELAY_MS", defaults.baseDelayMs),
    maxDelayMs: number("MEDIA_CLEANUP_MAX_DELAY_MS", defaults.maxDelayMs),
    jitterRatio: number("MEDIA_CLEANUP_JITTER_RATIO", defaults.jitterRatio),
  });
}

export class MediaCleanupClaimLost extends Error {
  constructor() {
    super("media cleanup claim lost");
    this.name = "MediaCleanupClaimLost";
  }
}

export interface MediaCleanupDiagnostics {
  record(event: {
    origin: MediaCleanupOrigin;
    projectId: string | null;
    clipId: string | null;
    cleanupClass: MediaCleanupClass;
    attempt: number;
    phase: "delete" | "settle";
    outcome: "completed" | "retry_scheduled" | "claim_lost" | "cancelled";
    failureCode: string | null;
    elapsedMs: number;
  }): void;
}

function safeRecord(
  diagnostics: MediaCleanupDiagnostics | undefined,
  event: Parameters<MediaCleanupDiagnostics["record"]>[0],
): void {
  try {
    diagnostics?.record(event);
  } catch {
    // Diagnostics cannot change cleanup settlement.
  }
}

function retryDelayMs(
  attemptCount: number,
  config: MediaCleanupConfig,
  random: () => number,
): number {
  const exponent = Math.min(30, Math.max(0, attemptCount - 1));
  const uncapped = config.baseDelayMs * 2 ** exponent;
  const capped = Math.min(config.maxDelayMs, uncapped);
  const jitter = 1 + (Math.min(1, Math.max(0, random())) * 2 - 1) * config.jitterRatio;
  return Math.min(config.maxDelayMs, Math.max(1, Math.round(capped * jitter)));
}

export interface MediaCleanupHeartbeatScheduler {
  start(callback: () => Promise<void>, intervalMs: number): () => void;
}

const defaultHeartbeatScheduler: MediaCleanupHeartbeatScheduler = {
  start(callback, intervalMs) {
    const timer = setInterval(() => void callback(), intervalMs);
    return () => clearInterval(timer);
  },
};

export function createMediaCleanupWorker(input: {
  store: MediaCleanupStore;
  storage: { deleteExact(key: string, options?: { signal?: AbortSignal }): Promise<void> };
  config: MediaCleanupConfig;
  classifyStorageError?: (error: unknown) => MediaCleanupStorageOutcome;
  diagnostics?: MediaCleanupDiagnostics;
  heartbeatScheduler?: MediaCleanupHeartbeatScheduler;
  now?: () => Date;
  createId?: () => string;
  random?: () => number;
}) {
  const config = validateMediaCleanupConfig(input.config);
  const now = input.now ?? (() => new Date());
  const createId = input.createId ?? randomUUID;
  const random = input.random ?? Math.random;
  const classify = input.classifyStorageError ?? classifyMediaCleanupStorageError;
  const heartbeatScheduler = input.heartbeatScheduler ?? defaultHeartbeatScheduler;

  return {
    async processDue(options: { signal?: AbortSignal } = {}) {
      if (options.signal?.aborted) {
        return { claimed: 0, completed: 0, retried: 0 };
      }
      const claims = await input.store.claimDue({
        now: now(),
        limit: config.batchSize,
        leaseMs: config.leaseMs,
        createId,
      });
      let completed = 0;
      let retried = 0;

      for (let index = 0; index < claims.length; index += 1) {
        const claim = claims[index]!;
        if (options.signal?.aborted) {
          for (const pending of claims.slice(index)) {
            await input.store.release({
              id: pending.id,
              claimId: pending.claimId,
              now: now(),
              failureCode: "cleanup_cancelled",
            });
          }
          break;
        }
        const startedAt = now().getTime();
        const record = (
          event: Pick<
            Parameters<MediaCleanupDiagnostics["record"]>[0],
            "phase" | "outcome" | "failureCode"
          >,
        ) =>
          safeRecord(input.diagnostics, {
            origin: claim.origin,
            projectId: claim.projectId,
            clipId: claim.clipId,
            cleanupClass: claim.cleanupClass,
            attempt: claim.attemptCount,
            elapsedMs: now().getTime() - startedAt,
            ...event,
          });
        const operationController = new AbortController();
        const abortForShutdown = () => operationController.abort(options.signal?.reason);
        options.signal?.addEventListener("abort", abortForShutdown, { once: true });
        let claimLost = false;
        let heartbeatInFlight: Promise<void> | null = null;
        const stopScheduledHeartbeat = heartbeatScheduler.start(async () => {
          if (heartbeatInFlight || claimLost) return;
          const renewal = (async () => {
            try {
              const heartbeatNow = now();
              const renewed = await input.store.renew({
                id: claim.id,
                claimId: claim.claimId,
                now: heartbeatNow,
                claimExpiresAt: new Date(heartbeatNow.getTime() + config.leaseMs),
              });
              if (!renewed) throw new MediaCleanupClaimLost();
            } catch {
              claimLost = true;
              operationController.abort(new MediaCleanupClaimLost());
            }
          })();
          heartbeatInFlight = renewal;
          await renewal;
          if (heartbeatInFlight === renewal) heartbeatInFlight = null;
        }, config.heartbeatMs);
        let heartbeatStopped = false;
        const stopHeartbeat = () => {
          if (heartbeatStopped) return;
          heartbeatStopped = true;
          stopScheduledHeartbeat();
        };
        try {
          await input.storage.deleteExact(claim.objectKey, {
            signal: operationController.signal,
          });
          stopHeartbeat();
          await heartbeatInFlight;
          if (claimLost) throw new MediaCleanupClaimLost();
          const settled = await input.store.complete({
            id: claim.id,
            claimId: claim.claimId,
            now: now(),
          });
          if (!settled) throw new MediaCleanupClaimLost();
          completed += 1;
          record({
            phase: "settle",
            outcome: "completed",
            failureCode: null,
          });
        } catch (error) {
          if (claimLost || error instanceof MediaCleanupClaimLost) {
            record({
              phase: "settle",
              outcome: "claim_lost",
              failureCode: "cleanup_claim_lost",
            });
            continue;
          }
          const outcome = classify(error);
          if (outcome === "not_found") {
            const settled = await input.store.complete({
              id: claim.id,
              claimId: claim.claimId,
              now: now(),
            });
            if (settled) completed += 1;
            record({
              phase: "settle",
              outcome: settled ? "completed" : "claim_lost",
              failureCode: "storage_not_found",
            });
            continue;
          }
          const failureCode = `storage_${outcome}`;
          const settlementNow = now();
          const nextAttemptAt =
            outcome === "cancelled"
              ? settlementNow
              : new Date(
                  settlementNow.getTime() +
                    retryDelayMs(claim.attemptCount, config, random),
                );
          const settled = await input.store.reschedule({
            id: claim.id,
            claimId: claim.claimId,
            now: settlementNow,
            nextAttemptAt,
            failureCode,
          });
          if (settled) retried += 1;
          record({
            phase: "delete",
            outcome: settled
              ? outcome === "cancelled"
                ? "cancelled"
                : "retry_scheduled"
              : "claim_lost",
            failureCode,
          });
        } finally {
          stopHeartbeat();
          options.signal?.removeEventListener("abort", abortForShutdown);
        }
      }
      return { claimed: claims.length, completed, retried };
    },
  };
}

export function classifyMediaCleanupStorageError(
  error: unknown,
): MediaCleanupStorageOutcome {
  if (error instanceof Error && /Missing required environment variable/.test(error.message)) {
    return "configuration";
  }
  const code = classifyR2StorageError(error);
  if (code === "storage_object_missing") return "not_found";
  if (code === "storage_operation_cancelled") return "cancelled";
  if (code === "storage_access_denied") return "persistent";
  return "temporary";
}

type InMemoryCleanup = Omit<
  MediaCleanupObligation,
  "origin" | "cleanupClass" | "createdAt" | "updatedAt"
> & {
  origin: MediaCleanupOrigin;
  cleanupClass: MediaCleanupClass;
  createdAt?: Date;
  updatedAt?: Date;
};

function copy<T>(value: T): T {
  return structuredClone(value);
}

export function createInMemoryMediaCleanupStore(
  seeds: InMemoryCleanup[],
): MediaCleanupStore & { inspect(id: string): InMemoryCleanup | null } {
  const records = new Map(seeds.map((seed) => [seed.id, copy(seed)]));

  function currentClaim(input: { id: string; claimId: string; now: Date }) {
    const row = records.get(input.id);
    if (
      !row ||
      row.completedAt ||
      row.claimId !== input.claimId ||
      !row.claimExpiresAt ||
      row.claimExpiresAt.getTime() <= input.now.getTime()
    ) {
      throw new MediaCleanupClaimLost();
    }
    return row;
  }

  return {
    async claimDue(input) {
      const eligible = [...records.values()]
        .filter(
          (row) =>
            !row.completedAt &&
            row.nextAttemptAt.getTime() <= input.now.getTime() &&
            (!row.claimId ||
              !row.claimExpiresAt ||
              row.claimExpiresAt.getTime() <= input.now.getTime()),
        )
        .sort((left, right) => left.nextAttemptAt.getTime() - right.nextAttemptAt.getTime())
        .slice(0, input.limit);
      return eligible.map((row) => {
        row.claimId = input.createId();
        row.claimExpiresAt = new Date(input.now.getTime() + input.leaseMs);
        row.attemptCount += 1;
        return {
          id: row.id,
          origin: row.origin,
          projectId: row.projectId,
          clipId: row.clipId,
          cleanupClass: row.cleanupClass,
          objectKey: row.objectKey,
          attemptCount: row.attemptCount,
          claimId: row.claimId,
          claimExpiresAt: row.claimExpiresAt,
        };
      });
    },
    async renew(input) {
      const row = currentClaim(input);
      row.claimExpiresAt = input.claimExpiresAt;
      return true;
    },
    async complete(input) {
      const row = currentClaim(input);
      row.completedAt = input.now;
      row.claimId = null;
      row.claimExpiresAt = null;
      row.failureCode = null;
      return true;
    },
    async reschedule(input) {
      const row = currentClaim(input);
      row.nextAttemptAt = input.nextAttemptAt;
      row.failureCode = input.failureCode;
      row.claimId = null;
      row.claimExpiresAt = null;
      return true;
    },
    async release(input) {
      const row = currentClaim(input);
      row.nextAttemptAt = input.now;
      row.failureCode = input.failureCode;
      row.claimId = null;
      row.claimExpiresAt = null;
      return true;
    },
    inspect(id) {
      const row = records.get(id);
      return row ? copy(row) : null;
    },
  };
}

function requirePrisma() {
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("Database client unavailable");
  return prisma;
}

function cleanupClass(value: string): MediaCleanupClass {
  if (
    value === "mutable_render" ||
    value === "preview_proxy" ||
    value === "preview_peaks" ||
    value === "dub_media"
  ) {
    return value;
  }
  throw new Error("Unknown media cleanup class");
}

function cleanupOrigin(value: string): MediaCleanupOrigin {
  if (
    value === "clip_editor_document_persistence" ||
    value === "detected_clip_replacement" ||
    value === "clip_duplicate_compensation"
  ) {
    return value;
  }
  throw new Error("Unknown media cleanup origin");
}

function ownedClaimWhere(input: { id: string; claimId: string; now: Date }) {
  return {
    id: input.id,
    claimId: input.claimId,
    claimExpiresAt: { gt: input.now },
    completedAt: null,
  };
}

export const prismaMediaCleanupStore: MediaCleanupStore = {
  async claimDue(input) {
    const prisma = requirePrisma();
    return prisma.$transaction(async (tx) => {
      const due = await tx.mediaCleanupObligation.findMany({
        where: {
          completedAt: null,
          nextAttemptAt: { lte: input.now },
          OR: [
            { claimId: null },
            { claimExpiresAt: null },
            { claimExpiresAt: { lte: input.now } },
          ],
        },
        orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        take: input.limit,
      });
      const claimed: ClaimedMediaCleanup[] = [];
      for (const candidate of due) {
        const claimId = input.createId();
        const claimExpiresAt = new Date(input.now.getTime() + input.leaseMs);
        const won = await tx.mediaCleanupObligation.updateMany({
          where: {
            id: candidate.id,
            completedAt: null,
            nextAttemptAt: { lte: input.now },
            OR: [
              { claimId: null },
              { claimExpiresAt: null },
              { claimExpiresAt: { lte: input.now } },
            ],
          },
          data: {
            claimId,
            claimExpiresAt,
            attemptCount: { increment: 1 },
          },
        });
        if (won.count === 1) {
          claimed.push({
            id: candidate.id,
            origin: cleanupOrigin(candidate.origin),
            projectId: candidate.projectId,
            clipId: candidate.clipId,
            cleanupClass: cleanupClass(candidate.cleanupClass),
            objectKey: candidate.objectKey,
            attemptCount: candidate.attemptCount + 1,
            claimId,
            claimExpiresAt,
          });
        }
      }
      return claimed;
    });
  },
  async renew(input) {
    const result = await requirePrisma().mediaCleanupObligation.updateMany({
      where: ownedClaimWhere(input),
      data: { claimExpiresAt: input.claimExpiresAt },
    });
    return result.count === 1;
  },
  async complete(input) {
    const result = await requirePrisma().mediaCleanupObligation.updateMany({
      where: ownedClaimWhere(input),
      data: {
        completedAt: input.now,
        claimId: null,
        claimExpiresAt: null,
        failureCode: null,
      },
    });
    return result.count === 1;
  },
  async reschedule(input) {
    const result = await requirePrisma().mediaCleanupObligation.updateMany({
      where: ownedClaimWhere(input),
      data: {
        nextAttemptAt: input.nextAttemptAt,
        failureCode: input.failureCode,
        claimId: null,
        claimExpiresAt: null,
      },
    });
    return result.count === 1;
  },
  async release(input) {
    const result = await requirePrisma().mediaCleanupObligation.updateMany({
      where: ownedClaimWhere(input),
      data: {
        nextAttemptAt: input.now,
        failureCode: input.failureCode,
        claimId: null,
        claimExpiresAt: null,
      },
    });
    return result.count === 1;
  },
};

const diagnostics: MediaCleanupDiagnostics = {
  record(event) {
    console.warn(
      JSON.stringify({
        level: event.outcome === "completed" ? "info" : "warn",
        message: "media_cleanup",
        ...event,
      }),
    );
  },
};

export const mediaCleanupWorker = createMediaCleanupWorker({
  store: prismaMediaCleanupStore,
  storage: {
    async deleteExact(key, options) {
      await deleteObject(key, options);
    },
  },
  config: mediaCleanupConfigFromEnv(),
  diagnostics,
});

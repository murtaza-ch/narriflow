import { randomUUID } from "node:crypto";
import { getPrismaClient } from "@narriflow/db/client";
import type { EditorMediaCleanupObligation } from "@prisma/client";
import { classifyR2StorageError, deleteObject } from "./r2-storage";
import type { EditorMediaCleanupClass } from "./clip-editor-document-persistence";

export type EditorMediaCleanupStorageOutcome =
  | "not_found"
  | "temporary"
  | "persistent"
  | "configuration"
  | "cancelled";

export interface ClaimedEditorMediaCleanup {
  id: string;
  projectId: string;
  clipId: string;
  cleanupClass: EditorMediaCleanupClass;
  objectKey: string;
  attemptCount: number;
  claimId: string;
  claimExpiresAt: Date;
}

export interface EditorMediaCleanupStore {
  claimDue(input: {
    now: Date;
    limit: number;
    leaseMs: number;
    createId: () => string;
  }): Promise<ClaimedEditorMediaCleanup[]>;
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

export interface EditorMediaCleanupConfig {
  batchSize: number;
  leaseMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
}

export function defaultEditorMediaCleanupConfig(): EditorMediaCleanupConfig {
  return {
    batchSize: 25,
    leaseMs: 60_000,
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

export function validateEditorMediaCleanupConfig(
  config: EditorMediaCleanupConfig,
): EditorMediaCleanupConfig {
  positiveInteger(config.batchSize, "batchSize", 100);
  positiveInteger(config.leaseMs, "leaseMs", 15 * 60 * 1000);
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

export function editorMediaCleanupConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): EditorMediaCleanupConfig {
  const defaults = defaultEditorMediaCleanupConfig();
  const number = (name: string, fallback: number) => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    return Number(raw);
  };
  return validateEditorMediaCleanupConfig({
    batchSize: number("EDITOR_MEDIA_CLEANUP_BATCH_SIZE", defaults.batchSize),
    leaseMs: number("EDITOR_MEDIA_CLEANUP_LEASE_MS", defaults.leaseMs),
    baseDelayMs: number("EDITOR_MEDIA_CLEANUP_BASE_DELAY_MS", defaults.baseDelayMs),
    maxDelayMs: number("EDITOR_MEDIA_CLEANUP_MAX_DELAY_MS", defaults.maxDelayMs),
    jitterRatio: number("EDITOR_MEDIA_CLEANUP_JITTER_RATIO", defaults.jitterRatio),
  });
}

export class EditorMediaCleanupClaimLost extends Error {
  constructor() {
    super("editor media cleanup claim lost");
    this.name = "EditorMediaCleanupClaimLost";
  }
}

export interface EditorMediaCleanupDiagnostics {
  record(event: {
    projectId: string;
    clipId: string;
    cleanupClass: EditorMediaCleanupClass;
    attempt: number;
    phase: "delete" | "settle";
    outcome: "completed" | "retry_scheduled" | "claim_lost" | "cancelled";
    failureCode: string | null;
    elapsedMs: number;
  }): void;
}

function safeRecord(
  diagnostics: EditorMediaCleanupDiagnostics | undefined,
  event: Parameters<EditorMediaCleanupDiagnostics["record"]>[0],
): void {
  try {
    diagnostics?.record(event);
  } catch {
    // Diagnostics cannot change cleanup settlement.
  }
}

function retryDelayMs(
  attemptCount: number,
  config: EditorMediaCleanupConfig,
  random: () => number,
): number {
  const exponent = Math.min(30, Math.max(0, attemptCount - 1));
  const uncapped = config.baseDelayMs * 2 ** exponent;
  const capped = Math.min(config.maxDelayMs, uncapped);
  const jitter = 1 + (Math.min(1, Math.max(0, random())) * 2 - 1) * config.jitterRatio;
  return Math.min(config.maxDelayMs, Math.max(1, Math.round(capped * jitter)));
}

export function createEditorMediaCleanupWorker(input: {
  store: EditorMediaCleanupStore;
  storage: { deleteExact(key: string, options?: { signal?: AbortSignal }): Promise<void> };
  config: EditorMediaCleanupConfig;
  classifyStorageError?: (error: unknown) => EditorMediaCleanupStorageOutcome;
  diagnostics?: EditorMediaCleanupDiagnostics;
  now?: () => Date;
  createId?: () => string;
  random?: () => number;
}) {
  const config = validateEditorMediaCleanupConfig(input.config);
  const now = input.now ?? (() => new Date());
  const createId = input.createId ?? randomUUID;
  const random = input.random ?? Math.random;
  const classify = input.classifyStorageError ?? classifyEditorCleanupStorageError;

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
        try {
          await input.storage.deleteExact(claim.objectKey, { signal: options.signal });
          const settled = await input.store.complete({
            id: claim.id,
            claimId: claim.claimId,
            now: now(),
          });
          if (!settled) throw new EditorMediaCleanupClaimLost();
          completed += 1;
          safeRecord(input.diagnostics, {
            projectId: claim.projectId,
            clipId: claim.clipId,
            cleanupClass: claim.cleanupClass,
            attempt: claim.attemptCount,
            phase: "settle",
            outcome: "completed",
            failureCode: null,
            elapsedMs: now().getTime() - startedAt,
          });
        } catch (error) {
          if (error instanceof EditorMediaCleanupClaimLost) {
            safeRecord(input.diagnostics, {
              projectId: claim.projectId,
              clipId: claim.clipId,
              cleanupClass: claim.cleanupClass,
              attempt: claim.attemptCount,
              phase: "settle",
              outcome: "claim_lost",
              failureCode: "cleanup_claim_lost",
              elapsedMs: now().getTime() - startedAt,
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
            safeRecord(input.diagnostics, {
              projectId: claim.projectId,
              clipId: claim.clipId,
              cleanupClass: claim.cleanupClass,
              attempt: claim.attemptCount,
              phase: "settle",
              outcome: settled ? "completed" : "claim_lost",
              failureCode: "storage_not_found",
              elapsedMs: now().getTime() - startedAt,
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
          safeRecord(input.diagnostics, {
            projectId: claim.projectId,
            clipId: claim.clipId,
            cleanupClass: claim.cleanupClass,
            attempt: claim.attemptCount,
            phase: "delete",
            outcome: settled
              ? outcome === "cancelled"
                ? "cancelled"
                : "retry_scheduled"
              : "claim_lost",
            failureCode,
            elapsedMs: now().getTime() - startedAt,
          });
        }
      }
      return { claimed: claims.length, completed, retried };
    },
  };
}

export function classifyEditorCleanupStorageError(
  error: unknown,
): EditorMediaCleanupStorageOutcome {
  if (error instanceof Error && /Missing required environment variable/.test(error.message)) {
    return "configuration";
  }
  const code = classifyR2StorageError(error);
  if (code === "storage_object_missing") return "not_found";
  if (code === "storage_operation_cancelled") return "cancelled";
  if (code === "storage_access_denied") return "persistent";
  return "temporary";
}

type InMemoryCleanup = Omit<EditorMediaCleanupObligation, "cleanupClass" | "createdAt" | "updatedAt"> & {
  cleanupClass: EditorMediaCleanupClass;
  createdAt?: Date;
  updatedAt?: Date;
};

function copy<T>(value: T): T {
  return structuredClone(value);
}

export function createInMemoryEditorMediaCleanupStore(
  seeds: InMemoryCleanup[],
): EditorMediaCleanupStore & { inspect(id: string): InMemoryCleanup | null } {
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
      throw new EditorMediaCleanupClaimLost();
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

function cleanupClass(value: string): EditorMediaCleanupClass {
  if (value === "mutable_render" || value === "preview_proxy" || value === "preview_peaks") {
    return value;
  }
  throw new Error("Unknown editor media cleanup class");
}

export const prismaEditorMediaCleanupStore: EditorMediaCleanupStore = {
  async claimDue(input) {
    const prisma = requirePrisma();
    return prisma.$transaction(async (tx) => {
      const due = await tx.editorMediaCleanupObligation.findMany({
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
      const claimed: ClaimedEditorMediaCleanup[] = [];
      for (const candidate of due) {
        const claimId = input.createId();
        const claimExpiresAt = new Date(input.now.getTime() + input.leaseMs);
        const won = await tx.editorMediaCleanupObligation.updateMany({
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
    const result = await requirePrisma().editorMediaCleanupObligation.updateMany({
      where: {
        id: input.id,
        claimId: input.claimId,
        claimExpiresAt: { gt: input.now },
        completedAt: null,
      },
      data: { claimExpiresAt: input.claimExpiresAt },
    });
    return result.count === 1;
  },
  async complete(input) {
    const result = await requirePrisma().editorMediaCleanupObligation.updateMany({
      where: {
        id: input.id,
        claimId: input.claimId,
        claimExpiresAt: { gt: input.now },
        completedAt: null,
      },
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
    const result = await requirePrisma().editorMediaCleanupObligation.updateMany({
      where: {
        id: input.id,
        claimId: input.claimId,
        claimExpiresAt: { gt: input.now },
        completedAt: null,
      },
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
    const result = await requirePrisma().editorMediaCleanupObligation.updateMany({
      where: {
        id: input.id,
        claimId: input.claimId,
        claimExpiresAt: { gt: input.now },
        completedAt: null,
      },
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

const diagnostics: EditorMediaCleanupDiagnostics = {
  record(event) {
    console.warn(
      JSON.stringify({
        level: event.outcome === "completed" ? "info" : "warn",
        message: "editor_media_cleanup",
        ...event,
      }),
    );
  },
};

export const editorMediaCleanupWorker = createEditorMediaCleanupWorker({
  store: prismaEditorMediaCleanupStore,
  storage: {
    async deleteExact(key, options) {
      await deleteObject(key, options);
    },
  },
  config: editorMediaCleanupConfigFromEnv(),
  diagnostics,
});

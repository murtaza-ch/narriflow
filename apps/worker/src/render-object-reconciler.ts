import {
  clipService,
  deleteObject,
  listObjectPageByPrefix,
} from "@narriflow/services";
import { parseWorkerRenderConfig } from "./render-config";
import { isAttemptUniqueProjectRenderObjectKey } from "./render-object-key";

const ORPHAN_SAFETY_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_STORAGE_OPERATION_TIMEOUT_MS = 2 * 60 * 1000;

interface ReconciliationObject {
  key: string;
  lastModified?: Date | null;
}

interface RenderObjectReconcilerDependencies {
  storage: {
    listPage(
      prefix: string,
      continuationToken?: string,
      options?: { signal?: AbortSignal },
    ): Promise<{
      objects: ReconciliationObject[];
      nextContinuationToken: string | null;
    }>;
    delete(key: string, options?: { signal?: AbortSignal }): Promise<unknown>;
  };
  persistence: {
    listReferencedKeys(projectId: string): Promise<ReadonlySet<string>>;
  };
  now?: () => Date;
  storageOperationTimeoutMs?: number;
  diagnose?: (input: Record<string, unknown>) => void;
}

export interface RenderObjectReconciliationResult {
  examined: number;
  referenced: number;
  ageProtected: number;
  orphaned: number;
  deleted: number;
  failed: number;
  objectIds: string[];
}

export class RenderObjectReconciler {
  readonly #dependencies: RenderObjectReconcilerDependencies;

  constructor(dependencies: RenderObjectReconcilerDependencies) {
    this.#dependencies = dependencies;
  }

  #storageSignal(signal?: AbortSignal): AbortSignal {
    const timeoutSignal = AbortSignal.timeout(
      this.#dependencies.storageOperationTimeoutMs ??
        DEFAULT_STORAGE_OPERATION_TIMEOUT_MS,
    );
    return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  }

  async execute(input: {
    projectId: string;
    delete?: boolean;
    signal?: AbortSignal;
  }): Promise<RenderObjectReconciliationResult> {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.projectId)) {
      throw new Error("A valid project UUID is required");
    }
    const signal = input.signal;
    signal?.throwIfAborted();
    const referencedKeys = await this.#dependencies.persistence.listReferencedKeys(
      input.projectId,
    );
    const candidates: ReconciliationObject[] = [];
    for (const prefix of [
      `projects/${input.projectId}/renders/`,
      `projects/${input.projectId}/exports/`,
    ]) {
      let continuationToken: string | undefined;
      do {
        signal?.throwIfAborted();
        const operationSignal = this.#storageSignal(signal);
        const page = await this.#dependencies.storage.listPage(
          prefix,
          continuationToken,
          { signal: operationSignal },
        );
        operationSignal.throwIfAborted();
        candidates.push(
          ...page.objects.filter((object) =>
            isAttemptUniqueProjectRenderObjectKey(object.key, input.projectId),
          ),
        );
        continuationToken = page.nextContinuationToken ?? undefined;
      } while (continuationToken);
    }

    const result: RenderObjectReconciliationResult = {
      examined: candidates.length,
      referenced: 0,
      ageProtected: 0,
      orphaned: 0,
      deleted: 0,
      failed: 0,
      objectIds: [],
    };
    const deletionCutoff =
      (this.#dependencies.now ?? (() => new Date()))().getTime() -
      ORPHAN_SAFETY_AGE_MS;
    const oldOrphans: ReconciliationObject[] = [];
    for (const object of candidates) {
      if (referencedKeys.has(object.key)) {
        result.referenced += 1;
      } else if (
        !object.lastModified ||
        object.lastModified.getTime() > deletionCutoff
      ) {
        result.ageProtected += 1;
      } else {
        result.orphaned += 1;
        result.objectIds.push(object.key);
        oldOrphans.push(object);
      }
    }

    if (input.delete) {
      const refreshedReferences =
        await this.#dependencies.persistence.listReferencedKeys(input.projectId);
      for (const object of oldOrphans) {
        signal?.throwIfAborted();
        if (refreshedReferences.has(object.key)) {
          result.referenced += 1;
          result.orphaned -= 1;
          result.objectIds = result.objectIds.filter((key) => key !== object.key);
          continue;
        }
        const operationSignal = this.#storageSignal(signal);
        try {
          await this.#dependencies.storage.delete(object.key, {
            signal: operationSignal,
          });
          operationSignal.throwIfAborted();
          result.deleted += 1;
        } catch (error) {
          signal?.throwIfAborted();
          if (operationSignal.aborted) throw operationSignal.reason;
          result.failed += 1;
          this.#dependencies.diagnose?.({
            level: "warn",
            message: "render_orphan_delete_failed",
            projectId: input.projectId,
            objectId: object.key,
            errorCode:
              error instanceof Error ? error.name : "storage_delete_failed",
          });
        }
      }
    }
    this.#dependencies.diagnose?.({
      level: result.failed > 0 ? "warn" : "info",
      message: "render_orphan_reconciliation_complete",
      projectId: input.projectId,
      destructive: Boolean(input.delete),
      ...result,
    });
    return result;
  }
}

export function createProductionRenderObjectReconciler(): RenderObjectReconciler {
  const config = parseWorkerRenderConfig();
  return new RenderObjectReconciler({
    storage: {
      listPage: async (prefix, continuationToken, options) =>
        listObjectPageByPrefix(prefix, 1000, continuationToken, options),
      delete: deleteObject,
    },
    persistence: {
      listReferencedKeys: (projectId) =>
        clipService.getProjectRenderStorageReferences(projectId),
    },
    storageOperationTimeoutMs: config.storageOperationTimeoutMs,
    diagnose: (diagnostic) => console.warn(JSON.stringify(diagnostic)),
  });
}

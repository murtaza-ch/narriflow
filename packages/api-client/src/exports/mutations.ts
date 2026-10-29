import type { QueryClient } from "@tanstack/query-core";
import type {
  CreateClipExportInput,
  CreateExportBundleInput,
  ExportBundleDownloadGrant,
  ExportDownloadGrant,
} from "@narriflow/validators/api/exports";
import { IDEMPOTENCY_KEY_HEADER, invalidateScoped, type WorkspaceScope } from "../core";
import { invalidateProject } from "../projects";
import { invalidateWorkspaceUsage } from "../workspace/queries";
import type { ExportsClient } from "./index";
import { EXPORT_RESOURCES } from "./queries";

const withKey = (idempotencyKey: string) => ({ headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey } });

/**
 * Export commands. Retryable acceptance takes the intent's Idempotency-Key
 * (`runtime.createIntent()`); a lost response replays the accepted work. The
 * grant reads return short-lived URLs: call them from the click that uses
 * them and navigate at once, never store the result.
 */
export const exportCommands = {
  /** A Download Grant for a Workspace export's file (the first finished variant unless `variantId`). Navigate to `downloadUrl` without credentials. */
  workspaceDownloadGrant(
    client: ExportsClient,
    exportId: string,
    variantId?: string,
    signal?: AbortSignal,
  ): Promise<ExportDownloadGrant> {
    return client.workspace.exports[":exportId"].download
      .$get({ param: { exportId }, query: variantId ? { variant: variantId } : {} }, signal ? { init: { signal } } : undefined)
      .then((response) => response.json());
  },

  /** A Download Grant for a finished export bundle (valid for about a minute). */
  bundleDownloadGrant(
    client: ExportsClient,
    projectId: string,
    bundleId: string,
    signal?: AbortSignal,
  ): Promise<ExportBundleDownloadGrant> {
    return client.projects[":id"]["export-bundles"][":bundleId"].download
      .$get({ param: { id: projectId, bundleId } }, signal ? { init: { signal } } : undefined)
      .then((response) => response.json());
  },

  /** A Download Grant for the clip's original source under the file name its timelines refer to. */
  timelineSourceGrant(client: ExportsClient, projectId: string, clipId: string, signal?: AbortSignal) {
    return client.projects[":id"].clips[":clipId"]["timeline-source"]
      .$get({ param: { id: projectId, clipId } }, signal ? { init: { signal } } : undefined)
      .then((response) => response.json());
  },

  /** Requeues the failed variants of a Workspace export (the Exports list). */
  retryWorkspaceExport(client: ExportsClient, exportId: string) {
    return client.workspace.exports[":exportId"].retry
      .$post({ param: { exportId } })
      .then((response) => response.json());
  },

  /** Requeues the failed variants of one export (the delivery page). */
  retry(client: ExportsClient, projectId: string, clipId: string, exportId: string) {
    return client.projects[":id"].clips[":clipId"].exports[":exportId"].retry
      .$post({ param: { id: projectId, clipId, exportId } })
      .then((response) => response.json());
  },

  /** Starts an export. Pass the intent's key; a replay returns the accepted export. */
  create(
    client: ExportsClient,
    projectId: string,
    clipId: string,
    input: CreateClipExportInput,
    idempotencyKey: string,
  ) {
    return client.projects[":id"].clips[":clipId"].exports
      .$post({ param: { id: projectId, clipId }, json: input }, withKey(idempotencyKey))
      .then((response) => response.json());
  },

  /** A private share link for an export; `expiresInDays` is 1, 7, 30 or null (never). */
  createShareLink(
    client: ExportsClient,
    projectId: string,
    clipId: string,
    exportId: string,
    expiresInDays: 1 | 7 | 30 | null = 7,
  ) {
    return client.projects[":id"].clips[":clipId"].exports[":exportId"]["share-links"]
      .$post({ param: { id: projectId, clipId, exportId }, json: { expiresInDays } })
      .then((response) => response.json());
  },

  revokeShareLinks(client: ExportsClient, projectId: string, clipId: string, exportId: string) {
    return client.projects[":id"].clips[":clipId"].exports[":exportId"]["share-links"]
      .$delete({ param: { id: projectId, clipId, exportId } })
      .then((response) => response.json());
  },

  previewBundle(client: ExportsClient, projectId: string, input: CreateExportBundleInput) {
    return client.projects[":id"]["export-bundles"].preview
      .$post({ param: { id: projectId }, json: input })
      .then((response) => response.json());
  },

  createBundle(client: ExportsClient, projectId: string, input: CreateExportBundleInput, idempotencyKey: string) {
    return client.projects[":id"]["export-bundles"]
      .$post({ param: { id: projectId }, json: input }, withKey(idempotencyKey))
      .then((response) => response.json());
  },

  retryBundle(client: ExportsClient, projectId: string, bundleId: string, idempotencyKey: string) {
    return client.projects[":id"]["export-bundles"][":bundleId"].retry
      .$post({ param: { id: projectId, bundleId } }, withKey(idempotencyKey))
      .then((response) => response.json());
  },

  retryBundleOperation(client: ExportsClient, projectId: string, operationId: string, idempotencyKey: string) {
    return client.projects[":id"]["campaign-operations"][":operationId"]["retry-export-bundle"]
      .$post({ param: { id: projectId, operationId } }, withKey(idempotencyKey))
      .then((response) => response.json());
  },
};

/** Mutations never retry on their own; spread into `useMutation` options. */
export const exportMutationOptions = { retry: false } as const;

/** The Exports page lists changed (a retry was accepted): lists and card progress. */
export function invalidateWorkspaceExports(queryClient: QueryClient, scope: WorkspaceScope) {
  return invalidateScoped(queryClient, scope, "exports", EXPORT_RESOURCES.workspaceList);
}

/**
 * An export, share link or bundle changed on a Project: the export reads,
 * the Workspace Exports list, the Project's screen and, because starting or
 * retrying renders spends credits, Workspace usage. Call on confirmed
 * acceptance only.
 */
export async function invalidateAfterExportChange(queryClient: QueryClient, scope: WorkspaceScope, projectId: string) {
  await Promise.all([
    invalidateScoped(queryClient, scope, "exports"),
    invalidateProject(queryClient, scope, projectId),
    invalidateWorkspaceUsage(queryClient, scope),
  ]);
}

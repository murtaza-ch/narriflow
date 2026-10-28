import { queryOptions } from "@tanstack/react-query";
import { type ApiTransport, scopedKey, STALE_TIME, type WorkspaceScope } from "../core";
import { createIngestClient } from "./client";

export const ingestKeys = {
  configuration: (scope: WorkspaceScope) => scopedKey(scope, "ingest", "configuration"),
  snapshot: (scope: WorkspaceScope, projectId: string) => scopedKey(scope, "ingest", "snapshot", projectId),
  resume: (scope: WorkspaceScope, projectId: string) => scopedKey(scope, "ingest", "resume", projectId),
  linkMetadata: (scope: WorkspaceScope, url: string) => scopedKey(scope, "ingest", "link-metadata", { url }),
};

interface Input {
  transport: ApiTransport;
  scope: WorkspaceScope;
}

/**
 * Everything the upload screen offers in one read: Styles, Brand Profiles with the
 * Workspace default, Recipes and the credit allowance. Each constituent comes from
 * its owning service, in parallel on the server.
 */
export function ingestConfigurationQueryOptions({ transport, scope }: Input) {
  return queryOptions({
    queryKey: ingestKeys.configuration(scope),
    queryFn: async ({ signal }) => {
      const client = createIngestClient(transport.scoped(scope));
      const response = await client.ingest.configuration.$get(undefined, { init: { signal } });
      return response.json();
    },
    staleTime: STALE_TIME.config,
  });
}

/**
 * The Configure step's resume decision: `resume` carries the draft, `open_project`
 * means Configure already finished, `restart` means start a fresh import. A concealed
 * Project answers `project_not_found`, which is also a restart.
 */
export function linkResumeQueryOptions({ transport, scope, projectId }: Input & { projectId: string }) {
  return queryOptions({
    queryKey: ingestKeys.resume(scope, projectId),
    queryFn: async ({ signal }) => {
      const client = createIngestClient(transport.scoped(scope));
      const response = await client.ingest[":projectId"].resume.$get({ param: { projectId } }, { init: { signal } });
      return response.json();
    },
    staleTime: STALE_TIME.live,
  });
}

/** The intake snapshot while ingest runs; the progress stream invalidates it, polling covers its absence. */
export function ingestSnapshotQueryOptions({ transport, scope, projectId }: Input & { projectId: string }) {
  return queryOptions({
    queryKey: ingestKeys.snapshot(scope, projectId),
    queryFn: async ({ signal }) => {
      const client = createIngestClient(transport.scoped(scope));
      const response = await client.ingest[":projectId"].$get({ param: { projectId } }, { init: { signal } });
      return response.json();
    },
    staleTime: STALE_TIME.live,
  });
}

/** The title YouTube publishes for a pasted link, or null. A failed lookup is simply no title. */
export function linkMetadataQueryOptions({ transport, scope, url }: Input & { url: string }) {
  return queryOptions({
    queryKey: ingestKeys.linkMetadata(scope, url),
    queryFn: async ({ signal }) => {
      const client = createIngestClient(transport.scoped(scope));
      const response = await client.ingest.link.metadata.$get({ query: { url } }, { init: { signal } });
      return response.json();
    },
    staleTime: STALE_TIME.config,
  });
}

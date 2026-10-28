import type {
  DriveCommitRequest,
  GenerationSetupInput,
  LinkCommitRequest,
  RssImportRequest,
} from "@narriflow/validators/api/ingest";
import type {
  DiscardUploadSessionInput,
  FinalizeUploadSessionInput,
  GrantUploadPartsInput,
  OpenUploadSessionInput,
  ReadUploadSessionInput,
  RssPreviewInput,
} from "@narriflow/validators";
import type { ApiTransport, WorkspaceScope } from "../core";
import { createIngestClient } from "./client";

/**
 * The upload screen's commands, bound to one identity and Workspace. A non-2xx answer
 * throws `ApiError`; branch on its `code` (a usage refusal keeps its recovery facts
 * under `details`).
 *
 * No command takes an `Idempotency-Key`: intake keeps its native identities. Link,
 * Drive and RSS commits are keyed by the `commitToken` in the input, minted once per
 * import before the first attempt and reused by every retry; Upload Sessions are keyed
 * by `clientIdempotencyKey`. A changed import gets a new token.
 */
export function createIngestActions(transport: ApiTransport, scope: WorkspaceScope) {
  const client = createIngestClient(transport.scoped(scope));
  const uploads = client["upload-sessions"];

  return {
    commitLink: async (input: LinkCommitRequest, signal?: AbortSignal) =>
      (await client.ingest.link.$post({ json: input }, { init: { signal } })).json(),
    /** The Drive access token travels only in this request body; it is never a query parameter or part of a result. */
    commitDrive: async (input: DriveCommitRequest, signal?: AbortSignal) =>
      (await client.ingest.drive.$post({ json: input }, { init: { signal } })).json(),
    previewRss: async (input: RssPreviewInput, signal?: AbortSignal) =>
      (await client.ingest.rss.preview.$post({ json: input }, { init: { signal } })).json(),
    importRss: async (input: RssImportRequest, signal?: AbortSignal) =>
      (await client.ingest.rss.import.$post({ json: input }, { init: { signal } })).json(),
    retryIngest: async (projectId: string, signal?: AbortSignal) =>
      (await client.ingest[":projectId"].retry.$post({ param: { projectId } }, { init: { signal } })).json(),
    /** "Save settings and finish later": replaces the draft; a no-op once a run exists. */
    saveDraft: async (projectId: string, input: GenerationSetupInput, signal?: AbortSignal) =>
      (await client.projects[":id"].generation.draft.$put({ param: { id: projectId }, json: input }, { init: { signal } })).json(),
    /** Commits the final settings and claims the run once; safe to repeat. */
    finalize: async (projectId: string, input: GenerationSetupInput, signal?: AbortSignal) =>
      (await client.projects[":id"].generation.finalize.$post({ param: { id: projectId }, json: input }, { init: { signal } })).json(),
    uploadSessions: {
      open: async (input: OpenUploadSessionInput, signal?: AbortSignal) => (await uploads.open.$post({ json: input }, { init: { signal } })).json(),
      finalize: async (input: FinalizeUploadSessionInput, signal?: AbortSignal) => (await uploads.finalize.$post({ json: input }, { init: { signal } })).json(),
      grants: async (input: GrantUploadPartsInput, signal?: AbortSignal) => (await uploads.grants.$post({ json: input }, { init: { signal } })).json(),
      status: async (input: ReadUploadSessionInput, signal?: AbortSignal) => (await uploads.status.$post({ json: input }, { init: { signal } })).json(),
      discard: async (input: DiscardUploadSessionInput, signal?: AbortSignal) => (await uploads.discard.$post({ json: input }, { init: { signal } })).json(),
    },
  };
}

export type IngestActions = ReturnType<typeof createIngestActions>;

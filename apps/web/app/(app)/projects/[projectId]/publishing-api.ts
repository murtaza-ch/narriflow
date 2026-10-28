import {
	type ApiTransport,
	createBrandClient,
	createClipsClient,
	createExportsClient,
	createPublishingClient,
	type WorkspaceScope,
} from "@narriflow/api-client";
import { exportCommands } from "@narriflow/api-client/exports";
import { publishingCommands, publishingReads } from "@narriflow/api-client/publishing";
import type { BulkSocialScheduleRequest, GenerateAssistedCopyRequest, PublishingPreviewRequest } from "@narriflow/validators";

type Json<Fn extends (args: any, ...rest: any[]) => unknown> = Parameters<Fn>[0] extends { json: infer Body } ? Body : never;

/**
 * Everything the Project's publishing screens ask of the API, bound to one
 * identity + Workspace. Retryable acceptance takes the caller's idempotency key
 * (one per user intent, from `runtime.createIntent`); the bulk schedule and
 * assisted copy carry their own identity in the body.
 */
export function createProjectPublishingApi(transport: ApiTransport, scope: WorkspaceScope) {
	const bound = transport.scoped(scope);
	const publishing = createPublishingClient(bound);
	const exportsClient = createExportsClient(bound);
	const clips = createClipsClient(bound);
	const brand = createBrandClient(bound);
	const commands = publishingCommands(publishing);
	const reads = publishingReads(publishing);

	return {
		/** Live posts first (`tracked` is at most one batch of ids), for the bounded refresh. */
		activePosts: async (projectId: string, tracked: string[]) =>
			(await publishing.projects[":id"]["social-posts"].$get({ param: { id: projectId }, query: { active: "1", tracked: tracked.join(",") } })).json(),
		olderPosts: async (projectId: string, cursor: string) =>
			(await publishing.projects[":id"]["social-posts"].$get({ param: { id: projectId }, query: { cursor } })).json(),
		cancelPost: commands.cancelPost,
		refreshInbox: async (projectId: string, postId: string) =>
			(await publishing.projects[":id"]["social-posts"][":postId"]["refresh-inbox"].$post({ param: { id: projectId, postId } })).json(),
		recheck: commands.recheck,
		confirm: commands.confirm,
		publishAgain: commands.publishAgain,

		publishingOptions: async (projectId: string, accountId: string) =>
			(await publishing.projects[":id"]["social-accounts"][":accountId"]["publishing-options"].$get({ param: { id: projectId, accountId } })).json(),
		previewSchedule: async (projectId: string, input: PublishingPreviewRequest) =>
			(await publishing.projects[":id"]["campaign-operations"].schedule.preview.$post({ param: { id: projectId }, json: input as Json<typeof publishing.projects[":id"]["campaign-operations"]["schedule"]["preview"]["$post"]> })).json(),
		schedule: async (projectId: string, input: BulkSocialScheduleRequest) =>
			(await publishing.projects[":id"]["campaign-operations"].schedule.$post({ param: { id: projectId }, json: input as Json<typeof publishing.projects[":id"]["campaign-operations"]["schedule"]["$post"]> })).json(),
		assistedCopy: async (projectId: string, input: GenerateAssistedCopyRequest) =>
			(await publishing.projects[":id"]["assisted-copy"].generations.$post({ param: { id: projectId }, json: input as Json<typeof publishing.projects[":id"]["assisted-copy"]["generations"]["$post"]> })).json(),
		propose: commands.propose,

		currentExports: async (projectId: string) =>
			(await exportsClient.projects[":id"].exports.current.$get({ param: { id: projectId } })).json(),
		createExport: (
			projectId: string,
			clipId: string,
			input: { expectedRevision: number; aspectRatios: Array<"9:16">; resolution: "720p" | "1080p" },
			idempotencyKey: string,
		) => exportCommands.create(exportsClient, projectId, clipId, input, idempotencyKey),
		retryExport: (projectId: string, clipId: string, exportId: string) => exportCommands.retry(exportsClient, projectId, clipId, exportId),

		visualAssets: async () => (await brand["visual-assets"].$get()).json(),
		presignCoverUpload: async (input: { contentType: string; sizeBytes: number }) =>
			(await brand["visual-assets"]["presign-upload"].$post({ json: input as Json<typeof brand["visual-assets"]["presign-upload"]["$post"]> })).json(),
		createCoverAsset: async (input: Json<typeof brand["visual-assets"]["$post"]>) =>
			(await brand["visual-assets"].$post({ json: input })).json(),
		requestThumbnailFrame: async (projectId: string, input: Json<typeof clips.projects[":id"]["thumbnail-frames"]["$post"]>) =>
			(await clips.projects[":id"]["thumbnail-frames"].$post({ param: { id: projectId }, json: input })).json(),
		thumbnailFrame: async (projectId: string, operationId: string) =>
			(await clips.projects[":id"]["thumbnail-frames"][":operationId"].$get({ param: { id: projectId, operationId } })).json(),
		reads,
	};
}

export type ProjectPublishingApi = ReturnType<typeof createProjectPublishingApi>;

import {
	linkedInInstructionBlobSchema,
	type PublicationEphemeral,
} from "@narriflow/validators/publication-execution";
import {
	openPublicationPayload,
	sealPublicationPayload,
} from "@narriflow/services/publication-checkpoint-blob";
import type { PublicationProviderOperation } from "@narriflow/services/social-publication-platform";
const object = (value: unknown): value is Record<string,unknown> =>
	Boolean(value && typeof value === "object" && !Array.isArray(value));
/** One immutable encrypted upload plan, then bounded part deltas. Provider
 * adapters retain their full-state interface and never receive a master key. */
export async function createPublicationCheckpointCodec(options: {
	context: PublicationEphemeral;
	totalBytes: number;
	operation: PublicationProviderOperation | null;
	priorInstructions?: Uint8Array;
	upload(bytes: Uint8Array): Promise<string>;
}) {
	let artifactId: string | null = null,
		immutable: string | null = null,
		partIds: string[] = [];
	let initial = options.operation;
	if (initial?.kind === "linkedin_video_upload") {
		const ref = initial.state.uploadInstructionsRef;
		if (
			!object(ref) ||
			typeof ref.artifactId !== "string" ||
			!options.context.priorCheckpointKey ||
			ref.artifactId !== options.context.priorCheckpointKey.artifactId ||
			!options.priorInstructions
		)
			throw Error("publication_checkpoint_invalid");
		const access = options.context.priorCheckpointKey,
			blob = linkedInInstructionBlobSchema.parse(
				await openPublicationPayload(
					options.priorInstructions,
					access.key,
					access.scope,
					"linkedin_instructions",
				),
			);
		if (
			blob.totalBytes !== options.totalBytes ||
			blob.owner !== initial.state.owner ||
			blob.videoUrn !== initial.state.videoUrn ||
			blob.uploadToken !== initial.state.uploadToken ||
			!Array.isArray(initial.state.uploadedPartIds) ||
			initial.state.uploadedPartIds.some(
				(id) => typeof id !== "string" || !id.length || id.length > 8192,
			) ||
			initial.state.uploadedPartIds.length > blob.uploadInstructions.length
		)
			throw Error("publication_checkpoint_invalid");
		artifactId = ref.artifactId;
		immutable = JSON.stringify(blob);
		partIds = [...initial.state.uploadedPartIds] as string[];
		initial = {
			...initial,
			state: {
				owner: blob.owner,
				videoUrn: blob.videoUrn,
				uploadToken: blob.uploadToken,
				uploadInstructions: blob.uploadInstructions,
				uploadedPartIds: [...partIds],
			},
		};
	}
	return {
		initial,
		async encode(
			operation: PublicationProviderOperation,
		): Promise<PublicationProviderOperation> {
			if (operation.kind !== "linkedin_video_upload") return operation;
			const state = operation.state,
				blob = linkedInInstructionBlobSchema.parse({
					version: 1,
					kind: "linkedin_upload_instructions",
					owner: state.owner,
					videoUrn: state.videoUrn,
					uploadToken: state.uploadToken,
					totalBytes: options.totalBytes,
					uploadInstructions: state.uploadInstructions,
				});
			if (immutable && immutable !== JSON.stringify(blob))
				throw Error("publication_checkpoint_changed");
			if (!artifactId) {
				const access = options.context.checkpointKey;
				const bytes = await sealPublicationPayload(
					blob,
					access.key,
					access.scope,
					"linkedin_instructions",
				);
				artifactId = await options.upload(bytes);
				immutable = JSON.stringify(blob);
			}
			const next = state.uploadedPartIds;
			if (
				!Array.isArray(next) ||
				next.length < partIds.length ||
				next.length > partIds.length + 2 ||
				next.some(
					(id, index) =>
						typeof id !== "string" ||
						!id.length ||
						id.length > 8192 ||
						(index < partIds.length && id !== partIds[index]),
				)
			)
				throw Error("publication_checkpoint_changed");
			const append = next.slice(partIds.length);
			partIds = [...next] as string[];
			return {
				...operation,
				state: {
					owner: blob.owner,
					videoUrn: blob.videoUrn,
					uploadToken: blob.uploadToken,
					uploadInstructionsRef: { artifactId },
					uploadedPartIdsAppend: append,
					uploadedPartCount: partIds.length,
				},
			};
		},
	};
}

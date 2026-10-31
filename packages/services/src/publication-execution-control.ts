import { createHash } from "node:crypto";
import type { ExecutionArtifact, PrismaClient } from "@prisma/client";
import { linkedInInstructionBlobSchema } from "@narriflow/validators/publication-execution";
import {
	createExecutorControl,
	ExecutorControlError,
	type ExecutorArtifactHead,
} from "./executor-control";
import { createExecutionTransfer } from "./execution-transfer";
import type { createExecutionStorage } from "./execution-storage";
import type { ExecutorArtifactCommit } from "./executor-domain-control";
import type { PublicationExecution } from "./publication-execution";
import {
	publicationEphemeralContext,
	publicationProviderPullReads,
} from "./publication-execution-runtime";
import {
	derivePublicationPurposeKey,
	publicationCheckpointBindingHash,
	openPublicationPayload,
} from "./publication-checkpoint-blob";
import { parseSocialPublicationConfig } from "./social-publication-config";

/** HTTP and Workflow share this exact control factory. Blob inspection and
 * OAuth refresh occur outside SQL; generic transfer reauthorizes afterwards. */
export function createPublicationExecutionControl(options: {
	database: PrismaClient;
	domain: PublicationExecution;
	storage: ReturnType<typeof createExecutionStorage>;
	environment: Record<string, string | undefined>;
	artifacts: {
		head(
			row: Readonly<ExecutionArtifact>,
		): Promise<ExecutorArtifactHead | null>;
		readBytes(
			artifact: ExecutorArtifactCommit,
			maxBytes: number,
		): Promise<Uint8Array>;
	};
	deliverWakes(ids: readonly string[]): Promise<void>;
}) {
	const invalid = () => new ExecutorControlError("artifact_invalid");
	const control = createExecutorControl({
		database: options.database,
		subjectKind: "social_publication",
		domain: options.domain,
		deliverWakes: options.deliverWakes,
		artifacts: {
			head: options.artifacts.head,
			prepare: async (assignment, artifact) => {
				if (
					artifact.role !== "publication_checkpoint" ||
					artifact.contentType !== "application/octet-stream" ||
					artifact.byteLength < 1n ||
					artifact.byteLength > 16n * 1024n ** 2n
				)
					throw invalid();
				const execution =
						await options.database.executionAttempt.findUniqueOrThrow({
							where: { attemptToken: assignment.attemptToken },
							include: { dispatch: true },
						}),
					claim = await options.database.publicationClaim.findUniqueOrThrow({
						where: { id: assignment.attemptToken },
					});
				const scope = {
					deploymentEpoch: execution.deploymentEpoch,
					socialPostId: execution.dispatch.subjectId,
					attemptId: claim.attemptId,
					claimId: claim.id,
					bindingHash: execution.inputHash,
				};
				if (
					execution.functionName !== "publication" ||
					execution.dispatch.subjectKind !== "social_publication" ||
					publicationCheckpointBindingHash(scope) !== artifact.bindingHash
				)
					throw invalid();
				const bytes = await options.artifacts.readBytes(
					artifact,
					16 * 1024 ** 2,
				);
				if (
					BigInt(bytes.length) !== artifact.byteLength ||
					createHash("sha256").update(bytes).digest("hex") !== artifact.sha256
				)
					throw invalid();
				const key = await derivePublicationPurposeKey(
					parseSocialPublicationConfig(options.environment).checkpointKey,
					scope,
					"linkedin_instructions",
				);
				return {
					...artifact,
					instructions: linkedInInstructionBlobSchema.parse(
						await openPublicationPayload(
							bytes,
							key,
							scope,
							"linkedin_instructions",
						),
					),
				};
			},
		},
	});
	const transfer = createExecutionTransfer({
		database: options.database,
		authority: control,
		storage: options.storage,
		resolvePackage: async (authority) => {
			const r = authority.fence.reference;
			if (
				r.kind !== "modal_execution" ||
				r.subject.kind !== "social_publication" ||
				authority.functionName !== "publication"
			)
				throw new ExecutorControlError("invalid_reference");
			const snapshot = await options.domain.workSnapshot(
					r,
					authority.fence.attemptToken,
				),
				scope = {
					deploymentEpoch: r.deploymentEpoch,
					socialPostId: r.subject.id,
					attemptId: snapshot.attempt.id,
					claimId: snapshot.claim.id,
					bindingHash: r.inputHash,
				};
			const publication = await publicationEphemeralContext(
				options.database,
				snapshot,
				options.environment,
				await publicationProviderPullReads(
					options.database,
					snapshot,
					options.storage,
					authority,
				),
			);
			return {
				input: { kind: "object" },
				sources: snapshot.sources,
				outputs:
					snapshot.post.platform === "linkedin" &&
					snapshot.claim.executionMode === "publish"
						? [
								{
									role: "publication_checkpoint",
									contentType: "application/octet-stream",
									maxBytes: 16 * 1024 ** 2,
									bindingHash: publicationCheckpointBindingHash(scope),
								},
							]
						: [],
				publication,
			};
		},
	});
	return { control, transfer };
}

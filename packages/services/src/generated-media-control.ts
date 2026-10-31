import type { PrismaClient } from "@prisma/client";
import { generatedImageEvidenceSchema } from "@narriflow/validators/generated-image-execution";
import {
	createExecutorControl,
	ExecutorControlError,
	type ExecutorArtifactHead,
} from "./executor-control";
import type { ExecutorArtifactCommit } from "./executor-domain-control";
import { createExecutionTransfer } from "./execution-transfer";
import type { createExecutionStorage } from "./execution-storage";
import type { GeneratedMediaExecution } from "./generated-media-execution";

export function createGeneratedMediaExecution(options: {
	database: PrismaClient;
	domain: GeneratedMediaExecution;
	storage: ReturnType<typeof createExecutionStorage>;
	artifacts: {
		head(
			row: Readonly<import("@prisma/client").ExecutionArtifact>,
		): Promise<ExecutorArtifactHead | null>;
		readJson(
			artifact: ExecutorArtifactCommit,
			maxBytes: number,
		): Promise<unknown>;
	};
	deliverWakes(ids: readonly string[]): Promise<void>;
}) {
	const control = createExecutorControl({
		database: options.database,
		subjectKind: "generated_media",
		domain: options.domain,
		deliverWakes: options.deliverWakes,
		artifacts: {
			head: options.artifacts.head,
			prepare: async (_row, artifact) => {
				if (artifact.role === "probe") {
					if (
						artifact.contentType !== "application/json" ||
						artifact.byteLength > 65536n
					)
						throw new ExecutorControlError("artifact_invalid");
					return {
						...artifact,
						evidence: generatedImageEvidenceSchema.parse(
							await options.artifacts.readJson(artifact, 65536),
						),
					};
				}
				if (
					artifact.role !== "validated_asset" ||
					artifact.contentType !== "image/png" ||
					artifact.byteLength > 100000000n
				)
					throw new ExecutorControlError("artifact_invalid");
				return artifact;
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
				r.subject.kind !== "generated_media" ||
				authority.functionName !== "generated_image"
			)
				throw new ExecutorControlError("invalid_reference");
			const work = await options.domain.workInput(r.subject.id);
			if (work.inputHash !== r.inputHash)
				throw new ExecutorControlError("authority_lost");
			return {
				input: work.input,
				sources: work.sources,
				outputs: work.outputs,
			};
		},
	});
	return { control, transfer };
}

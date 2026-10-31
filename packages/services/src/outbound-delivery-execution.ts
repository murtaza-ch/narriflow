import type { PrismaClient } from "@prisma/client";
import { notificationReceiptSchema } from "@narriflow/validators/outbound-delivery";
import {
	createExecutorControl,
	ExecutorControlError,
	type ExecutorArtifactHead,
} from "./executor-control";
import type { ExecutorArtifactCommit } from "./executor-domain-control";
import { createExecutionTransfer } from "./execution-transfer";
import type { createExecutionStorage } from "./execution-storage";
import type { OutboundDeliveryService } from "./outbound-delivery";

/** Native sees one frozen body source and an ephemeral signature, never keys. */
export function createOutboundDeliveryExecution(options: {
	database: PrismaClient;
	domain: OutboundDeliveryService;
	storage: ReturnType<typeof createExecutionStorage>;
	artifacts: {
		head(
			assignment: Readonly<import("@prisma/client").ExecutionArtifact>,
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
		subjectKind: "outbound_delivery",
		domain: options.domain,
		deliverWakes: options.deliverWakes,
		artifacts: {
			head: options.artifacts.head,
			prepare: async (_assignment, artifact) => {
				if (
					artifact.role !== "outbound_receipt" ||
					artifact.contentType !== "application/json" ||
					artifact.byteLength > 65536n
				)
					throw new ExecutorControlError("artifact_invalid");
				return {
					...artifact,
					receipt: notificationReceiptSchema.parse(
						await options.artifacts.readJson(artifact, 65536),
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
			const reference = authority.fence.reference;
			if (
				reference.kind !== "modal_execution" ||
				reference.subject.kind !== "outbound_delivery" ||
				authority.functionName !== "outbound_delivery"
			)
				throw new ExecutorControlError("invalid_reference");
			const work = await options.domain.workInput(reference.subject.id);
			if (work.inputHash !== reference.inputHash)
				throw new ExecutorControlError("authority_lost");
			return {
				input: { kind: "inline", command: work.command },
				sources: work.sources,
				outputs: work.outputs,
			};
		},
	});
	return { control, transfer };
}

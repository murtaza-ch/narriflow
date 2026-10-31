import { createHash } from "node:crypto";
import { getPrismaClient } from "@narriflow/db/client";
import type { CreateGeneratedImageInput } from "@narriflow/validators";
import type { BrandActorScope } from "./brand-ownership";
import { GeneratedMediaExecution } from "./generated-media-execution";
import {
	GeneratedMediaProviderError,
	type GeneratedMediaReconciliation,
} from "./generated-media";
import { generatedImageProviderConfigured } from "./generation-usage";
import { generatedMediaPromptProtectionFromEnv } from "./generated-media-prompt-protection";
import { summarizeGenerationUsage } from "./generated-media-usage-ledger";
import { headObject, putObjectBytes, presignDownloadUrl } from "./r2-storage";
import {
	readServiceEnvironment,
	type ServiceEnvironment,
} from "./runtime-environment";
import { deliverExecutionDispatches } from "./execution-dispatch-runtime";
import { visualAssetService } from "./visual-asset.service";
import { GeneratedMediaJobError } from "./generated-media";

const bounded = (
	raw: string | undefined,
	fallback: number,
	min: number,
	max: number,
) => {
	const value = Number(raw);
	return Number.isSafeInteger(value) && value >= min && value <= max
		? value
		: fallback;
};
/** Dependencies are constructed for the invocation; no key, client or binding
 * crosses a request or durable Workflow step. Image bytes never enter here. */
export function getGeneratedMediaExecution(
	environment: ServiceEnvironment = readServiceEnvironment(),
) {
	const database = getPrismaClient();
	if (!database) throw new GeneratedMediaJobError("generated_media_claim_lost");
	const protection = () => generatedMediaPromptProtectionFromEnv(environment);
	return new GeneratedMediaExecution(database, {
		model: environment.OPENAI_IMAGE_MODEL?.trim() || "unconfigured",
		quality:
			environment.OPENAI_IMAGE_QUALITY === "high"
				? "high"
				: environment.OPENAI_IMAGE_QUALITY === "low"
					? "low"
					: "medium",
		maxOutputBytes: bounded(
			environment.GENERATED_IMAGE_MAX_OUTPUT_BYTES,
			20 * 1024 * 1024,
			1000000,
			100000000,
		),
		maxAttempts: bounded(environment.GENERATED_IMAGE_MAX_ATTEMPTS, 4, 1, 10),
		maxPromptCharacters: bounded(
			environment.GENERATED_IMAGE_MAX_PROMPT_CHARACTERS,
			4000,
			64,
			20000,
		),
		promptProtection: {
			protect: (value) => protection().protect(value),
			reveal: (value) => protection().reveal(value),
			fingerprint: (value) => protection().fingerprint(value),
		},
		register: deliverExecutionDispatches,
		inputStorage: {
			put: async (plan, bytes) => {
				if (
					bytes.byteLength !== plan.byteLength ||
					plan.byteLength > 16 * 1024 * 1024 ||
					createHash("sha256").update(bytes).digest("hex") !== plan.sha256
				)
					throw new GeneratedMediaJobError(
						"generated_media_provider_result_unavailable",
					);
				await putObjectBytes({
					key: plan.storageKey,
					bytes,
					contentType: "application/json",
					ifNoneMatch: "*",
					metadata: { "generated-input-sha256": plan.sha256 },
				});
			},
			head: async (plan) => {
				try {
					const value = await headObject(plan.storageKey);
					if (
						!value.etag ||
						value.contentType !== "application/json" ||
						value.sizeBytes !== plan.byteLength ||
						value.metadata["generated-input-sha256"] !== plan.sha256
					)
						throw new GeneratedMediaJobError(
							"generated_media_provider_result_unavailable",
						);
					return {
						etag: value.etag,
						byteLength: value.sizeBytes,
						sha256: plan.sha256,
					};
				} catch (error) {
					if (
						(error as { $metadata?: { httpStatusCode?: number } }).$metadata
							?.httpStatusCode === 404
					)
						return null;
					throw error;
				}
			},
		},
		headArtifact: async (row) => {
			try {
				const value = await headObject(row.storageKey);
				if (
					!value.etag ||
					value.sizeBytes === null ||
					value.metadata["execution-artifact-id"] !== row.id ||
					value.metadata["execution-binding-hash"] !== row.bindingHash
				)
					throw new GeneratedMediaJobError(
						"generated_media_provider_result_unavailable",
					);
				return {
					etag: value.etag,
					byteLength: BigInt(value.sizeBytes),
					contentType: value.contentType ?? "",
				};
			} catch (error) {
				if (
					(error as { $metadata?: { httpStatusCode?: number } }).$metadata
						?.httpStatusCode === 404
				)
					return null;
				throw error;
			}
		},
		assetUrl: (key) => presignDownloadUrl({ key }).catch(() => null),
	});
}

export class GeneratedMediaService {
	constructor(
		private readonly factory = getGeneratedMediaExecution,
		private readonly configured = () => generatedImageProviderConfigured(),
	) {}
	create(scope: BrandActorScope, input: CreateGeneratedImageInput) {
		if (!this.configured())
			throw new GeneratedMediaProviderError(
				"generated_media_provider_not_configured",
			);
		return this.factory().create(scope, input);
	}
	get(scope: BrandActorScope, id: string, projectId?: string) {
		return this.factory().get(scope, id, projectId);
	}
	list(scope: BrandActorScope, projectId: string, clipId?: string) {
		return this.factory().list(scope, projectId, clipId);
	}
	cancel(scope: BrandActorScope, id: string, projectId?: string) {
		return this.factory()
			.get(scope, id, projectId)
			.then(() => this.factory().cancel(scope, id));
	}
	async usageSummary(scope: BrandActorScope) {
		return (await summarizeGenerationUsage(scope.workspaceId)).images;
	}
	inspectForOperator(workspaceId: string, id: string) {
		return this.factory().inspect(workspaceId, id);
	}
	reconcileForOperator(
		workspaceId: string,
		id: string,
		decision: GeneratedMediaReconciliation,
	) {
		return this.factory().reconcile(workspaceId, id, decision);
	}
	async deleteResult(scope: BrandActorScope, id: string, projectId?: string) {
		const job = await this.get(scope, id, projectId);
		if (!job.resultAsset)
			throw new GeneratedMediaJobError("generated_media_result_not_found");
		await visualAssetService.softDeleteGenerated(scope, job.resultAsset.id, {});
	}
}
export const generatedMediaService = new GeneratedMediaService();

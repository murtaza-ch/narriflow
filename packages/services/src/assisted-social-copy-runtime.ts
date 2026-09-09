import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import { brandProfileSnapshotSchema } from "@narriflow/validators";
import {
	AssistedSocialCopyError,
	createAssistedSocialCopy,
	type AssistedCopyGeneration,
	type AssistedCopyStore,
	type AssistedCopyVariant,
	type GenerateAssistedCopyInput,
} from "./assisted-social-copy";
import {
	createOpenAiAssistedCopyModerator,
	createOpenAiAssistedCopyProvider,
} from "./openai-assisted-copy-provider";
import { hasFeature } from "./plan-features";
import { accessibleProjectWhere } from "./project-access";
import { workspaceService } from "./workspace.service";

const generationInclude = {
	variants: { orderBy: { platform: "asc" as const } },
} satisfies Prisma.AssistedCopyGenerationInclude;

type GenerationRow = Prisma.AssistedCopyGenerationGetPayload<{
	include: typeof generationInclude;
}>;

function requirePrisma() {
	const prisma = getPrismaClient();
	if (!prisma) throw new Error("Database client unavailable");
	return prisma;
}

function stringArray(value: Prisma.JsonValue): string[] {
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === "string")
		: [];
}

function toVariant(
	row: GenerationRow["variants"][number],
	generation: Pick<GenerationRow, "workspaceId" | "projectId" | "clipId">,
): AssistedCopyVariant {
	if (row.moderationOutcome !== "approved") {
		throw new AssistedSocialCopyError("assisted_copy_variant_invalid");
	}
	return {
		id: row.id,
		generationId: row.generationId,
		workspaceId: generation.workspaceId,
		projectId: generation.projectId,
		clipId: generation.clipId,
		platform: row.platform,
		caption: row.caption,
		hashtags: stringArray(row.hashtags),
		title: row.title,
		model: row.model,
		promptVersion: row.promptVersion,
		moderationOutcome: "approved",
		originalFingerprint: row.originalFingerprint,
	};
}

function toGeneration(row: GenerationRow): AssistedCopyGeneration {
	return {
		id: row.id,
		actorUserId: row.createdByUserId,
		workspaceId: row.workspaceId,
		projectId: row.projectId,
		clipId: row.clipId,
		idempotencyKey: row.idempotencyKey,
		requestFingerprint: row.requestFingerprint,
		status: row.status,
		provider: row.provider,
		model: row.model,
		promptVersion: row.promptVersion,
		skippedGuidance: stringArray(row.skippedGuidance),
		inputTokens: row.inputTokens,
		outputTokens: row.outputTokens,
		errorCode: row.errorCode,
		variants: row.variants.map((variant) => toVariant(variant, row)),
		createdAt: row.createdAt,
		completedAt: row.completedAt,
	};
}

async function readGeneration(workspaceId: string, idempotencyKey: string) {
	return requirePrisma().assistedCopyGeneration.findUnique({
		where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey } },
		include: generationInclude,
	});
}

export const prismaAssistedCopyStore: AssistedCopyStore = {
	async open(input) {
		const existing = await readGeneration(
			input.workspaceId,
			input.idempotencyKey,
		);
		if (existing) return { record: toGeneration(existing), replayed: true };
		const candidate = input.create();
		try {
			const created = await requirePrisma().assistedCopyGeneration.create({
				data: {
					id: candidate.id,
					workspaceId: candidate.workspaceId,
					projectId: candidate.projectId,
					clipId: candidate.clipId,
					createdByUserId: candidate.actorUserId,
					idempotencyKey: candidate.idempotencyKey,
					requestFingerprint: candidate.requestFingerprint,
					status: candidate.status,
					provider: candidate.provider,
					model: candidate.model,
					promptVersion: candidate.promptVersion,
					skippedGuidance: candidate.skippedGuidance,
					inputTokens: candidate.inputTokens,
					outputTokens: candidate.outputTokens,
					errorCode: candidate.errorCode,
					completedAt: candidate.completedAt,
				},
				include: generationInclude,
			});
			return { record: toGeneration(created), replayed: false };
		} catch (error) {
			if (
				!(error instanceof Prisma.PrismaClientKnownRequestError) ||
				error.code !== "P2002"
			) {
				throw error;
			}
			const raced = await readGeneration(
				input.workspaceId,
				input.idempotencyKey,
			);
			if (!raced) throw error;
			return { record: toGeneration(raced), replayed: true };
		}
	},

	async settle(generationId, patch) {
		return requirePrisma().$transaction(async (tx) => {
			const current = await tx.assistedCopyGeneration.findUniqueOrThrow({
				where: { id: generationId },
				include: generationInclude,
			});
			await tx.assistedCopyVariant.deleteMany({ where: { generationId } });
			const updated = await tx.assistedCopyGeneration.update({
				where: { id: generationId },
				data: {
					status: patch.status,
					model: patch.model,
					skippedGuidance: patch.skippedGuidance,
					inputTokens: patch.inputTokens,
					outputTokens: patch.outputTokens,
					errorCode: patch.errorCode,
					completedAt: patch.completedAt,
					variants: {
						create: patch.variants.map((variant) => ({
							id: variant.id,
							platform: variant.platform,
							caption: variant.caption,
							hashtags: variant.hashtags,
							title: variant.title,
							model: variant.model,
							promptVersion: variant.promptVersion,
							moderationOutcome: variant.moderationOutcome,
							originalFingerprint: variant.originalFingerprint,
						})),
					},
				},
				include: generationInclude,
			});
			await tx.projectAnalyticsEvent.create({
				data: {
					projectId: current.projectId,
					clipId: current.clipId,
					type:
						patch.status === "completed"
							? "assisted_copy_generated"
							: "assisted_copy_failed",
					metadata: {
						generationId,
						provider: current.provider,
						model: patch.model,
						promptVersion: current.promptVersion,
						inputTokens: patch.inputTokens,
						outputTokens: patch.outputTokens,
						skippedGuidance: patch.skippedGuidance,
						outcome: patch.status,
						errorCode: patch.errorCode,
					},
				},
			});
			return toGeneration(updated);
		});
	},

	async getVariant(workspaceId, variantId) {
		const row = await requirePrisma().assistedCopyVariant.findFirst({
			where: { id: variantId, generation: { workspaceId } },
			include: {
				generation: {
					select: { workspaceId: true, projectId: true, clipId: true },
				},
			},
		});
		return row ? toVariant(row, row.generation) : null;
	},
};

function timeoutMs(environment: NodeJS.ProcessEnv) {
	const parsed = Number(environment.ASSISTED_COPY_TIMEOUT_MS);
	return Number.isSafeInteger(parsed) && parsed >= 1_000 && parsed <= 120_000
		? parsed
		: 30_000;
}

function productionModule(environment: NodeJS.ProcessEnv = process.env) {
	const apiKey = environment.OPENAI_API_KEY ?? "";
	const model =
		environment.OPENAI_ASSISTED_COPY_MODEL ??
		environment.OPENAI_CONTENT_MODEL ??
		environment.OPENAI_CLIP_MODEL ??
		"gpt-5.4-mini";
	return createAssistedSocialCopy({
		store: prismaAssistedCopyStore,
		provider: createOpenAiAssistedCopyProvider({ apiKey, model }),
		moderate: createOpenAiAssistedCopyModerator({ apiKey }),
		authorize: async ({ actorUserId, workspaceId, permission }) => {
			const actor = await workspaceService.requireActor(
				actorUserId,
				workspaceId,
				permission,
			);
			if (!hasFeature(actor.pricingTier, "publishing.assistedCopy")) {
				throw new AssistedSocialCopyError(
					"assisted_copy_entitlement_required",
					"Assisted copy requires a Creator, Pro, or Business plan",
				);
			}
		},
		async loadContext({ workspaceId, projectId, clipId }) {
			const project = await requirePrisma().project.findFirst({
				where: { id: projectId, workspaceId, ...accessibleProjectWhere() },
				select: {
					brandProfileSnapshot: true,
					clips: {
						where: { id: clipId },
						take: 1,
						select: {
							title: true,
							hookText: true,
							payoffText: true,
							transcriptSlice: true,
						},
					},
				},
			});
			const clip = project?.clips[0];
			if (!project || !clip) {
				throw new AssistedSocialCopyError("assisted_copy_clip_not_found");
			}
			const snapshot = brandProfileSnapshotSchema.safeParse(
				project.brandProfileSnapshot,
			);
			return {
				clipTitle: clip.title?.trim() || clip.hookText,
				transcript: JSON.stringify(clip.transcriptSlice).slice(0, 24000),
				hook: clip.hookText?.trim() || null,
				payoff: clip.payoffText?.trim() || null,
				voiceGuidance: snapshot.success ? snapshot.data.voice : null,
			};
		},
		createId: randomUUID,
		now: () => new Date(),
		timeoutMs: timeoutMs(environment),
	});
}

export class AssistedSocialCopyService {
	generate(input: GenerateAssistedCopyInput) {
		return productionModule().generate(input);
	}

	requireProvenance(
		input: Parameters<
			ReturnType<typeof createAssistedSocialCopy>["requireProvenance"]
		>[0],
	) {
		return productionModule().requireProvenance(input);
	}
}

export const assistedSocialCopyService = new AssistedSocialCopyService();

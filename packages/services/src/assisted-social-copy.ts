import { createHash } from "node:crypto";
import {
	brandVoiceGuidanceSchema,
	SOCIAL_PROVIDER_CAPABILITIES,
	type BrandVoiceGuidance,
	type SocialPlatform,
} from "@narriflow/validators";
import {
	ExpectedDomainFailureError,
	type ExpectedDomainFailureCatalog,
} from "./expected-domain-failure";

export const ASSISTED_COPY_PROMPT_VERSION = "assisted-social-copy-v2";

export type AssistedCopyVariant = {
	id: string;
	generationId: string;
	workspaceId: string;
	projectId: string;
	clipId: string;
	platform: SocialPlatform;
	caption: string;
	hashtags: string[];
	title: string | null;
	model: string;
	promptVersion: string;
	moderationOutcome: "approved";
	originalFingerprint: string;
};

export type AssistedCopyGeneration = {
	id: string;
	actorUserId: string;
	workspaceId: string;
	projectId: string;
	clipId: string;
	idempotencyKey: string;
	requestFingerprint: string;
	status: "generating" | "completed" | "failed";
	provider: string;
	model: string;
	promptVersion: string;
	skippedGuidance: string[];
	inputTokens: number | null;
	outputTokens: number | null;
	errorCode: string | null;
	variants: AssistedCopyVariant[];
	createdAt: Date;
	completedAt: Date | null;
};

export type AssistedCopyPublicVariant = Omit<
	AssistedCopyVariant,
	"workspaceId" | "projectId" | "clipId" | "originalFingerprint"
> & {};

export type AssistedCopyPublicGeneration = Omit<
	AssistedCopyGeneration,
	"requestFingerprint" | "variants"
> & {
	variants: AssistedCopyPublicVariant[];
	replayed: boolean;
};

export type GenerateAssistedCopyInput = {
	actorUserId: string;
	workspaceId: string;
	projectId: string;
	clipId: string;
	idempotencyKey: string;
	platforms: readonly SocialPlatform[];
	campaignNote?: string;
	revisionInstruction?: string;
	lockedPhrases?: readonly string[];
	lockedHashtags?: readonly string[];
};

export type AssistedCopyContext = {
	clipTitle: string;
	hook: string | null;
	payoff: string | null;
	voiceGuidance: unknown;
	transcript?: string;
};

export type AssistedCopyProviderInput = {
	requestId: string;
	platforms: SocialPlatform[];
	campaignNote: string;
	revisionInstruction: string | null;
	lockedPhrases: string[];
	lockedHashtags: string[];
	clip: {
		title: string;
		hook: string | null;
		payoff: string | null;
		transcript?: string;
	};
	voiceGuidance: BrandVoiceGuidance | null;
	promptVersion: string;
	signal: AbortSignal;
};

export interface AssistedCopyProvider {
	name: string;
	modelAlias: string;
	generate(input: AssistedCopyProviderInput): Promise<{
		model: string;
		inputTokens: number;
		outputTokens: number;
		variants: Array<{
			platform: SocialPlatform;
			caption: string;
			hashtags: string[];
			title: string | null;
		}>;
	}>;
}

export interface AssistedCopyStore {
	open(input: {
		workspaceId: string;
		idempotencyKey: string;
		requestFingerprint: string;
		create(): AssistedCopyGeneration;
	}): Promise<{ record: AssistedCopyGeneration; replayed: boolean }>;
	settle(
		generationId: string,
		patch: Pick<
			AssistedCopyGeneration,
			| "status"
			| "model"
			| "skippedGuidance"
			| "inputTokens"
			| "outputTokens"
			| "errorCode"
			| "variants"
			| "completedAt"
		>,
	): Promise<AssistedCopyGeneration>;
	getVariant(
		workspaceId: string,
		variantId: string,
	): Promise<AssistedCopyVariant | null>;
}

const ASSISTED_SOCIAL_COPY_FAILURES = {
	assisted_copy_clip_not_found: "missing",
	assisted_copy_generation_in_progress: "conflict",
	assisted_copy_generation_not_found: "missing",
	assisted_copy_generation_failed: "unavailable",
	assisted_copy_entitlement_required: "forbidden",
	assisted_copy_idempotency_conflict: "conflict",
	assisted_copy_input_invalid: "invalid",
	assisted_copy_locked_content_missing: "invalid",
	assisted_copy_moderation_rejected: "unprocessable",
	assisted_copy_moderation_rate_limited: "rate_limited",
	assisted_copy_moderation_unavailable: "unavailable",
	assisted_copy_provider_not_configured: "unavailable",
	assisted_copy_provider_failed: "unavailable",
	assisted_copy_provider_output_invalid: "unavailable",
	assisted_copy_provider_rate_limited: "rate_limited",
	assisted_copy_provider_rejected: "unprocessable",
	assisted_copy_provider_timeout: "unavailable",
	assisted_copy_provider_unavailable: "unavailable",
	assisted_copy_variant_invalid: "invalid",
	assisted_copy_variant_not_found: "missing",
} as const satisfies ExpectedDomainFailureCatalog<string>;

export type AssistedSocialCopyErrorCode =
	keyof typeof ASSISTED_SOCIAL_COPY_FAILURES;

function isAssistedSocialCopyErrorCode(
	code: string,
): code is AssistedSocialCopyErrorCode {
	return code in ASSISTED_SOCIAL_COPY_FAILURES;
}

export class AssistedSocialCopyError extends ExpectedDomainFailureError<AssistedSocialCopyErrorCode> {
	constructor(code: AssistedSocialCopyErrorCode, message: string = code) {
		super({ code, kind: ASSISTED_SOCIAL_COPY_FAILURES[code], message });
		this.name = "AssistedSocialCopyError";
	}
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function sha256(value: unknown) {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function assistedCopyContentFingerprint(input: {
	caption: string;
	hashtags: readonly string[];
	title: string | null;
}) {
	return sha256({
		caption: input.caption.trim(),
		hashtags: input.hashtags.map((value) => value.trim()),
		title: input.title?.trim() || null,
	});
}

export function composeAssistedCopyCaption(input: {
	caption: string;
	hashtags: readonly string[];
}) {
	const body = input.caption.trim();
	const hashtags = input.hashtags
		.map((value) => value.trim())
		.filter(Boolean)
		.join(" ");
	return hashtags ? `${body}\n\n${hashtags}` : body;
}

function publicVariant(
	variant: AssistedCopyVariant,
): AssistedCopyPublicVariant {
	return {
		id: variant.id,
		generationId: variant.generationId,
		platform: variant.platform,
		caption: variant.caption,
		hashtags: [...variant.hashtags],
		title: variant.title,
		model: variant.model,
		promptVersion: variant.promptVersion,
		moderationOutcome: variant.moderationOutcome,
	};
}

function publicGeneration(
	generation: AssistedCopyGeneration,
	replayed: boolean,
): AssistedCopyPublicGeneration {
	const {
		requestFingerprint: _requestFingerprint,
		variants,
		...publicRecord
	} = generation;
	return {
		...publicRecord,
		skippedGuidance: [...generation.skippedGuidance],
		variants: variants.map(publicVariant),
		replayed,
	};
}

function normalizeStringList(
	values: readonly string[] | undefined,
	label: string,
) {
	const normalized = (values ?? [])
		.map((value) => value.trim())
		.filter(Boolean);
	if (
		normalized.length > 50 ||
		normalized.some((value) => value.length > 120)
	) {
		throw new AssistedSocialCopyError(
			"assisted_copy_input_invalid",
			`${label} are invalid`,
		);
	}
	return [...new Set(normalized)];
}

function validateInput(input: GenerateAssistedCopyInput) {
	if ((input.campaignNote?.trim().length ?? 0) > 2_000) {
		throw new AssistedSocialCopyError(
			"assisted_copy_input_invalid",
			"Campaign note is required",
		);
	}
	if (input.platforms.length === 0 || input.platforms.length > 6) {
		throw new AssistedSocialCopyError(
			"assisted_copy_input_invalid",
			"Choose at least one platform",
		);
	}
	if (new Set(input.platforms).size !== input.platforms.length) {
		throw new AssistedSocialCopyError(
			"assisted_copy_input_invalid",
			"Platforms must be unique",
		);
	}
	if ((input.revisionInstruction?.trim().length ?? 0) > 1_000) {
		throw new AssistedSocialCopyError(
			"assisted_copy_input_invalid",
			"Revision instruction is too long",
		);
	}
}

function validateProviderVariants(
	platforms: readonly SocialPlatform[],
	variants: Awaited<ReturnType<AssistedCopyProvider["generate"]>>["variants"],
) {
	if (variants.length !== platforms.length) {
		throw new AssistedSocialCopyError("assisted_copy_provider_output_invalid");
	}
	const byPlatform = new Map(
		variants.map((variant) => [variant.platform, variant]),
	);
	if (
		byPlatform.size !== variants.length ||
		platforms.some((platform) => !byPlatform.has(platform))
	) {
		throw new AssistedSocialCopyError("assisted_copy_provider_output_invalid");
	}
	return platforms.map((platform) => {
		const variant = byPlatform.get(platform)!;
		const caption = variant.caption.trim();
		const hashtags = [
			...new Set(variant.hashtags.map((value) => value.trim()).filter(Boolean)),
		];
		const title = variant.title?.trim() || null;
		const capability = SOCIAL_PROVIDER_CAPABILITIES[platform];
		if (
			!caption ||
			composeAssistedCopyCaption({ caption, hashtags }).length >
				capability.textLimit
		) {
			throw new AssistedSocialCopyError(
				"assisted_copy_provider_output_invalid",
			);
		}
		if (
			hashtags.length > 30 ||
			hashtags.some((value) => !/^#[^\s#]{1,99}$/u.test(value))
		) {
			throw new AssistedSocialCopyError(
				"assisted_copy_provider_output_invalid",
			);
		}
		if (
			(!capability.titleField && title !== null) ||
			(title?.length ?? 0) > 100
		) {
			throw new AssistedSocialCopyError(
				"assisted_copy_provider_output_invalid",
			);
		}
		return { platform, caption, hashtags, title };
	});
}

export function createAssistedSocialCopy(dependencies: {
	store: AssistedCopyStore;
	provider: AssistedCopyProvider;
	authorize(input: {
		actorUserId: string;
		workspaceId: string;
		permission: "publishing.manage";
	}): Promise<void>;
	loadContext(input: {
		workspaceId: string;
		projectId: string;
		clipId: string;
	}): Promise<AssistedCopyContext>;
	moderate(input: {
		platform: SocialPlatform;
		caption: string;
		hashtags: string[];
		title: string | null;
		signal: AbortSignal;
	}): Promise<{ outcome: "approved" | "rejected"; code?: string }>;
	createId(): string;
	now(): Date;
	timeoutMs: number;
}) {
	async function fail(
		generation: AssistedCopyGeneration,
		code: AssistedSocialCopyErrorCode,
	): Promise<never> {
		await dependencies.store.settle(generation.id, {
			status: "failed",
			model: generation.model,
			skippedGuidance: generation.skippedGuidance,
			inputTokens: generation.inputTokens,
			outputTokens: generation.outputTokens,
			errorCode: code,
			variants: [],
			completedAt: dependencies.now(),
		});
		throw new AssistedSocialCopyError(code);
	}

	return {
		async generate(
			input: GenerateAssistedCopyInput,
		): Promise<AssistedCopyPublicGeneration> {
			validateInput(input);
			const lockedPhrases = normalizeStringList(
				input.lockedPhrases,
				"Locked phrases",
			);
			const lockedHashtags = normalizeStringList(
				input.lockedHashtags,
				"Locked hashtags",
			);
			await dependencies.authorize({
				actorUserId: input.actorUserId,
				workspaceId: input.workspaceId,
				permission: "publishing.manage",
			});
			// Resolve the active Project/Clip boundary before persisting relational
			// identifiers supplied by the client.
			const context = await dependencies.loadContext({
				workspaceId: input.workspaceId,
				projectId: input.projectId,
				clipId: input.clipId,
			});
			const requestFingerprint = sha256({
				contract: ASSISTED_COPY_PROMPT_VERSION,
				projectId: input.projectId,
				clipId: input.clipId,
				platforms: input.platforms,
				campaignNote: input.campaignNote?.trim() ?? "",
				revisionInstruction: input.revisionInstruction?.trim() || null,
				lockedPhrases,
				lockedHashtags,
			});
			const now = dependencies.now();
			const opened = await dependencies.store.open({
				workspaceId: input.workspaceId,
				idempotencyKey: input.idempotencyKey,
				requestFingerprint,
				create: () => ({
					id: dependencies.createId(),
					actorUserId: input.actorUserId,
					workspaceId: input.workspaceId,
					projectId: input.projectId,
					clipId: input.clipId,
					idempotencyKey: input.idempotencyKey,
					requestFingerprint,
					status: "generating",
					provider: dependencies.provider.name,
					model: dependencies.provider.modelAlias,
					promptVersion: ASSISTED_COPY_PROMPT_VERSION,
					skippedGuidance: [],
					inputTokens: null,
					outputTokens: null,
					errorCode: null,
					variants: [],
					createdAt: now,
					completedAt: null,
				}),
			});
			if (opened.replayed) {
				if (opened.record.requestFingerprint !== requestFingerprint) {
					throw new AssistedSocialCopyError(
						"assisted_copy_idempotency_conflict",
					);
				}
				if (opened.record.status === "completed")
					return publicGeneration(opened.record, true);
				if (opened.record.status === "failed") {
					const storedCode =
						opened.record.errorCode ?? "assisted_copy_generation_failed";
					throw new AssistedSocialCopyError(
						isAssistedSocialCopyErrorCode(storedCode)
							? storedCode
							: "assisted_copy_generation_failed",
					);
				}
				throw new AssistedSocialCopyError(
					"assisted_copy_generation_in_progress",
				);
			}

			const controller = new AbortController();
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				const voice = brandVoiceGuidanceSchema.safeParse(context.voiceGuidance);
				const skippedGuidance = voice.success ? [] : ["brand_voice"];
				const timeout = new Promise<never>((_, reject) => {
					timer = setTimeout(() => {
						controller.abort();
						reject(
							new AssistedSocialCopyError("assisted_copy_provider_timeout"),
						);
					}, dependencies.timeoutMs);
				});
				const response = await Promise.race([
					dependencies.provider.generate({
						requestId: opened.record.id,
						platforms: [...input.platforms],
						campaignNote: input.campaignNote?.trim() ?? "",
						revisionInstruction: input.revisionInstruction?.trim() || null,
						lockedPhrases,
						lockedHashtags,
						clip: {
							title: context.clipTitle,
							transcript: context.transcript,
							hook: context.hook,
							payoff: context.payoff,
						},
						voiceGuidance: voice.success ? voice.data : null,
						promptVersion: ASSISTED_COPY_PROMPT_VERSION,
						signal: controller.signal,
					}),
					timeout,
				]);
				const providerVariants = validateProviderVariants(
					input.platforms,
					response.variants,
				);
				for (const variant of providerVariants) {
					const searchable =
						`${variant.title ?? ""}\n${variant.caption}`.toLocaleLowerCase();
					if (
						lockedPhrases.some(
							(phrase) => !searchable.includes(phrase.toLocaleLowerCase()),
						) ||
						lockedHashtags.some(
							(hashtag) =>
								!variant.hashtags.some(
									(value) =>
										value.toLocaleLowerCase() === hashtag.toLocaleLowerCase(),
								),
						)
					) {
						throw new AssistedSocialCopyError(
							"assisted_copy_locked_content_missing",
						);
					}
					const moderation = await dependencies.moderate({
						...variant,
						signal: controller.signal,
					});
					if (moderation.outcome !== "approved") {
						throw new AssistedSocialCopyError(
							"assisted_copy_moderation_rejected",
						);
					}
				}
				const variants: AssistedCopyVariant[] = providerVariants.map(
					(variant) => {
						const originalFingerprint = assistedCopyContentFingerprint(variant);
						return {
							...variant,
							id: dependencies.createId(),
							generationId: opened.record.id,
							workspaceId: opened.record.workspaceId,
							projectId: opened.record.projectId,
							clipId: opened.record.clipId,
							model: response.model,
							promptVersion: ASSISTED_COPY_PROMPT_VERSION,
							moderationOutcome: "approved",
							originalFingerprint,
						};
					},
				);
				const settled = await dependencies.store.settle(opened.record.id, {
					status: "completed",
					model: response.model,
					skippedGuidance,
					inputTokens: response.inputTokens,
					outputTokens: response.outputTokens,
					errorCode: null,
					variants,
					completedAt: dependencies.now(),
				});
				return publicGeneration(settled, false);
			} catch (error) {
				if (error instanceof AssistedSocialCopyError) {
					return fail(opened.record, error.code);
				}
				return fail(opened.record, "assisted_copy_provider_failed");
			} finally {
				if (timer) clearTimeout(timer);
				controller.abort();
			}
		},

		async requireProvenance(input: {
			workspaceId: string;
			projectId: string;
			clipId: string;
			platform: SocialPlatform;
			variantId: string;
		}) {
			const variant = await dependencies.store.getVariant(
				input.workspaceId,
				input.variantId,
			);
			if (
				!variant ||
				variant.projectId !== input.projectId ||
				variant.clipId !== input.clipId ||
				variant.platform !== input.platform
			) {
				throw new AssistedSocialCopyError("assisted_copy_variant_not_found");
			}
			return publicVariant(variant);
		},
	};
}

function cloneVariant(variant: AssistedCopyVariant): AssistedCopyVariant {
	return {
		...variant,
		hashtags: [...variant.hashtags],
	};
}

function cloneGeneration(
	generation: AssistedCopyGeneration,
): AssistedCopyGeneration {
	return {
		...generation,
		skippedGuidance: [...generation.skippedGuidance],
		variants: generation.variants.map(cloneVariant),
		createdAt: new Date(generation.createdAt),
		completedAt: generation.completedAt
			? new Date(generation.completedAt)
			: null,
	};
}

export function createInMemoryAssistedCopyStore(): AssistedCopyStore {
	const generations = new Map<string, AssistedCopyGeneration>();

	return {
		async open(input) {
			const key = `${input.workspaceId}:${input.idempotencyKey}`;
			const existing = generations.get(key);
			if (existing)
				return { record: cloneGeneration(existing), replayed: true };
			const created = input.create();
			generations.set(key, cloneGeneration(created));
			return { record: cloneGeneration(created), replayed: false };
		},
		async settle(generationId, patch) {
			const entry = [...generations.entries()].find(
				([, row]) => row.id === generationId,
			);
			if (!entry)
				throw new AssistedSocialCopyError("assisted_copy_generation_not_found");
			const [key, current] = entry;
			const settled = { ...current, ...patch };
			generations.set(key, cloneGeneration(settled));
			return cloneGeneration(settled);
		},
		async getVariant(workspaceId, variantId) {
			const generation = [...generations.values()].find(
				(row) =>
					row.workspaceId === workspaceId &&
					row.variants.some((variant) => variant.id === variantId),
			);
			const variant = generation?.variants.find(
				(candidate) => candidate.id === variantId,
			);
			return variant ? cloneVariant(variant) : null;
		},
	};
}

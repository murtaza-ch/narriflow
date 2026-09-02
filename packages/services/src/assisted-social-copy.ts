import { createHash } from "node:crypto";
import {
  brandVoiceGuidanceSchema,
  SOCIAL_PROVIDER_CAPABILITIES,
  type BrandVoiceGuidance,
  type SocialPlatform,
} from "@narriflow/validators";

export const ASSISTED_COPY_PROMPT_VERSION = "assisted-social-copy-v1";

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
  confirmationFingerprint: string | null;
  confirmedAt: Date | null;
  confirmedByUserId: string | null;
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
  | "workspaceId"
  | "projectId"
  | "clipId"
  | "confirmationFingerprint"
  | "originalFingerprint"
  | "confirmedAt"
  | "confirmedByUserId"
> & {
  confirmed: boolean;
  edited: boolean;
};

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
  campaignNote: string;
  revisionInstruction?: string;
  lockedPhrases?: readonly string[];
  lockedHashtags?: readonly string[];
};

export type AssistedCopyContext = {
  clipTitle: string;
  hook: string | null;
  payoff: string | null;
  voiceGuidance: unknown;
};

export type AssistedCopyProviderInput = {
  requestId: string;
  platforms: SocialPlatform[];
  campaignNote: string;
  revisionInstruction: string | null;
  lockedPhrases: string[];
  lockedHashtags: string[];
  clip: { title: string; hook: string | null; payoff: string | null };
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
  getVariant(workspaceId: string, variantId: string): Promise<AssistedCopyVariant | null>;
  confirmVariant(input: {
    workspaceId: string;
    variantId: string;
    actorUserId: string;
    caption: string;
    hashtags: string[];
    title: string | null;
    confirmationFingerprint: string;
    now: Date;
  }): Promise<AssistedCopyVariant>;
}

export class AssistedSocialCopyError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
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

export function assistedCopyConfirmationFingerprint(input: {
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
  const hashtags = input.hashtags.map((value) => value.trim()).filter(Boolean).join(" ");
  return hashtags ? `${body}\n\n${hashtags}` : body;
}

function publicVariant(variant: AssistedCopyVariant): AssistedCopyPublicVariant {
  const currentFingerprint = assistedCopyConfirmationFingerprint(variant);
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
    confirmed: variant.confirmationFingerprint === currentFingerprint,
    edited: variant.originalFingerprint !== currentFingerprint,
  };
}

function publicGeneration(
  generation: AssistedCopyGeneration,
  replayed: boolean,
): AssistedCopyPublicGeneration {
  const { requestFingerprint: _requestFingerprint, variants, ...publicRecord } = generation;
  return {
    ...publicRecord,
    skippedGuidance: [...generation.skippedGuidance],
    variants: variants.map(publicVariant),
    replayed,
  };
}

function normalizeStringList(values: readonly string[] | undefined, label: string) {
  const normalized = (values ?? []).map((value) => value.trim()).filter(Boolean);
  if (normalized.length > 50 || normalized.some((value) => value.length > 120)) {
    throw new AssistedSocialCopyError("assisted_copy_input_invalid", `${label} are invalid`);
  }
  return [...new Set(normalized)];
}

function validateInput(input: GenerateAssistedCopyInput) {
  if (!input.campaignNote.trim() || input.campaignNote.trim().length > 2_000) {
    throw new AssistedSocialCopyError("assisted_copy_input_invalid", "Campaign note is required");
  }
  if (input.platforms.length === 0 || input.platforms.length > 6) {
    throw new AssistedSocialCopyError("assisted_copy_input_invalid", "Choose at least one platform");
  }
  if (new Set(input.platforms).size !== input.platforms.length) {
    throw new AssistedSocialCopyError("assisted_copy_input_invalid", "Platforms must be unique");
  }
  if ((input.revisionInstruction?.trim().length ?? 0) > 1_000) {
    throw new AssistedSocialCopyError("assisted_copy_input_invalid", "Revision instruction is too long");
  }
}

function validateProviderVariants(
  platforms: readonly SocialPlatform[],
  variants: Awaited<ReturnType<AssistedCopyProvider["generate"]>>["variants"],
) {
  if (variants.length !== platforms.length) {
    throw new AssistedSocialCopyError("assisted_copy_provider_output_invalid");
  }
  const byPlatform = new Map(variants.map((variant) => [variant.platform, variant]));
  if (byPlatform.size !== variants.length || platforms.some((platform) => !byPlatform.has(platform))) {
    throw new AssistedSocialCopyError("assisted_copy_provider_output_invalid");
  }
  return platforms.map((platform) => {
    const variant = byPlatform.get(platform)!;
    const caption = variant.caption.trim();
    const hashtags = [...new Set(variant.hashtags.map((value) => value.trim()).filter(Boolean))];
    const title = variant.title?.trim() || null;
    const capability = SOCIAL_PROVIDER_CAPABILITIES[platform];
    if (!caption || composeAssistedCopyCaption({ caption, hashtags }).length > capability.textLimit) {
      throw new AssistedSocialCopyError("assisted_copy_provider_output_invalid");
    }
    if (hashtags.length > 30 || hashtags.some((value) => !/^#[^\s#]{1,99}$/u.test(value))) {
      throw new AssistedSocialCopyError("assisted_copy_provider_output_invalid");
    }
    if ((!capability.titleField && title !== null) || (title?.length ?? 0) > 100) {
      throw new AssistedSocialCopyError("assisted_copy_provider_output_invalid");
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
  async function fail(generation: AssistedCopyGeneration, code: string): Promise<never> {
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
    async generate(input: GenerateAssistedCopyInput): Promise<AssistedCopyPublicGeneration> {
      validateInput(input);
      const lockedPhrases = normalizeStringList(input.lockedPhrases, "Locked phrases");
      const lockedHashtags = normalizeStringList(input.lockedHashtags, "Locked hashtags");
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
        campaignNote: input.campaignNote.trim(),
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
          throw new AssistedSocialCopyError("assisted_copy_idempotency_conflict");
        }
        if (opened.record.status === "completed") return publicGeneration(opened.record, true);
        if (opened.record.status === "failed") {
          throw new AssistedSocialCopyError(opened.record.errorCode ?? "assisted_copy_generation_failed");
        }
        throw new AssistedSocialCopyError("assisted_copy_generation_in_progress");
      }

      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const voice = brandVoiceGuidanceSchema.safeParse(context.voiceGuidance);
        const skippedGuidance = voice.success ? [] : ["brand_voice"];
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new AssistedSocialCopyError("assisted_copy_provider_timeout"));
          }, dependencies.timeoutMs);
        });
        const response = await Promise.race([
          dependencies.provider.generate({
            requestId: opened.record.id,
            platforms: [...input.platforms],
            campaignNote: input.campaignNote.trim(),
            revisionInstruction: input.revisionInstruction?.trim() || null,
            lockedPhrases,
            lockedHashtags,
            clip: {
              title: context.clipTitle,
              hook: context.hook,
              payoff: context.payoff,
            },
            voiceGuidance: voice.success ? voice.data : null,
            promptVersion: ASSISTED_COPY_PROMPT_VERSION,
            signal: controller.signal,
          }),
          timeout,
        ]);
        const providerVariants = validateProviderVariants(input.platforms, response.variants);
        for (const variant of providerVariants) {
          const searchable = `${variant.title ?? ""}\n${variant.caption}`.toLocaleLowerCase();
          if (
            lockedPhrases.some((phrase) => !searchable.includes(phrase.toLocaleLowerCase())) ||
            lockedHashtags.some(
              (hashtag) =>
                !variant.hashtags.some(
                  (value) => value.toLocaleLowerCase() === hashtag.toLocaleLowerCase(),
                ),
            )
          ) {
            throw new AssistedSocialCopyError("assisted_copy_locked_content_missing");
          }
          const moderation = await dependencies.moderate({
            ...variant,
            signal: controller.signal,
          });
          if (moderation.outcome !== "approved") {
            throw new AssistedSocialCopyError("assisted_copy_moderation_rejected");
          }
        }
        const variants: AssistedCopyVariant[] = providerVariants.map((variant) => {
          const originalFingerprint = assistedCopyConfirmationFingerprint(variant);
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
            confirmationFingerprint: null,
            confirmedAt: null,
            confirmedByUserId: null,
            originalFingerprint,
          };
        });
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

    async confirm(input: {
      actorUserId: string;
      workspaceId: string;
      projectId: string;
      variantId: string;
      caption: string;
      hashtags: string[];
      title: string | null;
    }) {
      await dependencies.authorize({
        actorUserId: input.actorUserId,
        workspaceId: input.workspaceId,
        permission: "publishing.manage",
      });
      const caption = input.caption.trim();
      const hashtags = normalizeStringList(input.hashtags, "Hashtags");
      const title = input.title?.trim() || null;
      const current = await dependencies.store.getVariant(input.workspaceId, input.variantId);
      if (!current || current.projectId !== input.projectId) {
        throw new AssistedSocialCopyError("assisted_copy_variant_not_found");
      }
      const capability = SOCIAL_PROVIDER_CAPABILITIES[current.platform];
      if (
        !caption ||
        composeAssistedCopyCaption({ caption, hashtags }).length > capability.textLimit ||
        (!capability.titleField && title !== null)
      ) {
        throw new AssistedSocialCopyError("assisted_copy_confirmation_invalid");
      }
      const confirmationFingerprint = assistedCopyConfirmationFingerprint({ caption, hashtags, title });
      const confirmed = await dependencies.store.confirmVariant({
        workspaceId: input.workspaceId,
        variantId: input.variantId,
        actorUserId: input.actorUserId,
        caption,
        hashtags,
        title,
        confirmationFingerprint,
        now: dependencies.now(),
      });
      return publicVariant(confirmed);
    },

    async requireConfirmation(input: {
      workspaceId: string;
      projectId: string;
      clipId: string;
      platform: SocialPlatform;
      variantId: string;
      caption: string;
      hashtags: string[];
      title: string | null;
    }) {
      const variant = await dependencies.store.getVariant(input.workspaceId, input.variantId);
      if (!variant || variant.generationId === "") {
        throw new AssistedSocialCopyError("assisted_copy_variant_not_found");
      }
      const fingerprint = assistedCopyConfirmationFingerprint(input);
      if (
        variant.workspaceId !== input.workspaceId ||
        variant.projectId !== input.projectId ||
        variant.clipId !== input.clipId ||
        variant.platform !== input.platform ||
        variant.confirmationFingerprint !== fingerprint
      ) {
        throw new AssistedSocialCopyError("assisted_copy_confirmation_stale");
      }
      return publicVariant(variant);
    },

    async requirePublicationConfirmation(input: {
      workspaceId: string;
      projectId: string;
      clipId: string;
      platform: SocialPlatform;
      variantId: string;
      publishedCaption: string;
      title: string | null;
    }) {
      const variant = await dependencies.store.getVariant(input.workspaceId, input.variantId);
      if (!variant) throw new AssistedSocialCopyError("assisted_copy_variant_not_found");
      const currentFingerprint = assistedCopyConfirmationFingerprint(variant);
      if (
        variant.workspaceId !== input.workspaceId ||
        variant.projectId !== input.projectId ||
        variant.clipId !== input.clipId ||
        variant.platform !== input.platform ||
        variant.confirmationFingerprint !== currentFingerprint ||
        composeAssistedCopyCaption(variant) !== input.publishedCaption.trim() ||
        variant.title !== (input.title?.trim() || null)
      ) {
        throw new AssistedSocialCopyError("assisted_copy_confirmation_stale");
      }
      return publicVariant(variant);
    },
  };
}

function cloneVariant(variant: AssistedCopyVariant): AssistedCopyVariant {
  return {
    ...variant,
    hashtags: [...variant.hashtags],
    confirmedAt: variant.confirmedAt ? new Date(variant.confirmedAt) : null,
  };
}

function cloneGeneration(generation: AssistedCopyGeneration): AssistedCopyGeneration {
  return {
    ...generation,
    skippedGuidance: [...generation.skippedGuidance],
    variants: generation.variants.map(cloneVariant),
    createdAt: new Date(generation.createdAt),
    completedAt: generation.completedAt ? new Date(generation.completedAt) : null,
  };
}

export function createInMemoryAssistedCopyStore(): AssistedCopyStore {
  const generations = new Map<string, AssistedCopyGeneration>();

  return {
    async open(input) {
      const key = `${input.workspaceId}:${input.idempotencyKey}`;
      const existing = generations.get(key);
      if (existing) return { record: cloneGeneration(existing), replayed: true };
      const created = input.create();
      generations.set(key, cloneGeneration(created));
      return { record: cloneGeneration(created), replayed: false };
    },
    async settle(generationId, patch) {
      const entry = [...generations.entries()].find(([, row]) => row.id === generationId);
      if (!entry) throw new AssistedSocialCopyError("assisted_copy_generation_not_found");
      const [key, current] = entry;
      const settled = { ...current, ...patch };
      generations.set(key, cloneGeneration(settled));
      return cloneGeneration(settled);
    },
    async getVariant(workspaceId, variantId) {
      const generation = [...generations.values()].find(
        (row) => row.workspaceId === workspaceId && row.variants.some((variant) => variant.id === variantId),
      );
      const variant = generation?.variants.find((candidate) => candidate.id === variantId);
      return variant ? cloneVariant(variant) : null;
    },
    async confirmVariant(input) {
      const entry = [...generations.entries()].find(
        ([, row]) => row.workspaceId === input.workspaceId && row.variants.some((variant) => variant.id === input.variantId),
      );
      if (!entry) throw new AssistedSocialCopyError("assisted_copy_variant_not_found");
      const [key, generation] = entry;
      const variants = generation.variants.map((variant) =>
        variant.id === input.variantId
          ? {
              ...variant,
              caption: input.caption,
              hashtags: [...input.hashtags],
              title: input.title,
              confirmationFingerprint: input.confirmationFingerprint,
              confirmedAt: input.now,
              confirmedByUserId: input.actorUserId,
            }
          : variant,
      );
      generations.set(key, cloneGeneration({ ...generation, variants }));
      return cloneVariant(variants.find((variant) => variant.id === input.variantId)!);
    },
  };
}
